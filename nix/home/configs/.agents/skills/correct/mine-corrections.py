#!/usr/bin/env python3
"""Extract the user's own messages from Claude Code transcripts, for correction mining.

Feeds memory-review step 5 and the correct skill: they cluster what the user had to
correct, so the input must be only text the user typed -- harness wrappers, tool
results, subagent transcripts and resumed-session replays would each inflate a class.

  python3 mine-corrections.py OUT.json [--since YYYY-MM-DD] [--root DIR]
  python3 mine-corrections.py --selftest
"""
import argparse, glob, json, os, re, sys

# Harness- and plugin-injected turns (system-reminder, clm-stable-attachment, task-notification, ...) open with a tag.
WRAPPER = re.compile(r'^\s*<[a-z][\w-]*[\s>]')
REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)
# Credentials pasted into a prompt must not reach the output file or a subagent brief.
SECRET = re.compile(r'(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?i:bearer)\s+[A-Za-z0-9._-]{20,})')


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def is_tool_result(content):
    return isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content)


def user_text(event):
    """The text the user typed in this event, or None when the event is not a typed message."""
    if event.get('type') != 'user' or event.get('isMeta') or event.get('isSidechain'):
        return None
    content = (event.get('message') or {}).get('content')
    if is_tool_result(content):
        return None
    t = text_of(content).strip()
    if not t or WRAPPER.match(t):
        return None
    if t.startswith('Caveat:') or t.startswith('This session is being continued') or '[Request interrupted' in t[:40]:
        return None
    t = REMINDER.sub('', t).strip()
    return SECRET.sub('[REDACTED]', t) or None


def preceding_turn(events, i):
    """What the agent said and called just before message i: the thing being corrected."""
    out = []
    for p in reversed(events[max(0, i - 60):i]):
        if p.get('type') == 'user' and not is_tool_result((p.get('message') or {}).get('content')):
            break
        if p.get('type') == 'assistant':
            for b in reversed((p.get('message') or {}).get('content') or []):
                if b.get('type') == 'text':
                    out.append('A: ' + b['text'][:400])
                elif b.get('type') == 'tool_use':
                    out.append('T: ' + b.get('name', '') + ' ' + json.dumps(b.get('input'), ensure_ascii=False)[:200])
    return SECRET.sub('[REDACTED]', '\n'.join(reversed(out))[-2000:])


def mine(root, since):
    files = [f for f in glob.glob(os.path.join(root, '*', '*.jsonl'))]
    seen, msgs = set(), []
    for f in files:
        events = []
        with open(f, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
        for i, e in enumerate(events):
            t = user_text(e)
            ts = (e.get('timestamp') or '')[:10]
            if t is None or (since and ts < since):
                continue
            prev = preceding_turn(events, i)
            # A forked or resumed session replays a message together with the turn before it; a real
            # repeat of the same words follows a different turn, and that repeat is the signal to keep.
            key = (t, prev)
            if key in seen:
                continue
            seen.add(key)
            msgs.append({'project': os.path.basename(os.path.dirname(f)), 'session': e.get('sessionId'), 'date': ts,
                         'text': t[:1500], 'prev': prev})
    msgs.sort(key=lambda m: m['date'])
    return {'root': root, 'since': since, 'files': len(files), 'sessions': len({m['session'] for m in msgs}),
            'messages': len(msgs), 'msgs': msgs}


def selftest():
    # Regression: a harness-injected wrapper counted as a user correction, or a pasted token leaking into OUT.json.
    assert user_text({'type': 'user', 'message': {'content': '<system-reminder>x</system-reminder>'}}) is None
    assert user_text({'type': 'user', 'message': {'content': '<clm-stable-attachment type="x">y'}}) is None
    assert user_text({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'x'}]}}) is None
    assert user_text({'type': 'user', 'isSidechain': True, 'message': {'content': 'hi'}}) is None
    assert user_text({'type': 'user', 'message': {'content': 'fix it <system-reminder>r</system-reminder>'}}) == 'fix it'
    assert 'ghp_' not in user_text({'type': 'user', 'message': {'content': 'use ghp_' + 'a' * 36}})
    print('selftest ok')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out', nargs='?')
    ap.add_argument('--since', help='YYYY-MM-DD; keep messages on or after this date')
    ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        selftest()
        sys.exit(0)
    if not a.out:
        ap.error('OUT.json is required')
    r = mine(a.root, a.since)
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(r, fh, ensure_ascii=False)
    print(f"{r['messages']} user messages from {r['sessions']} sessions ({r['files']} transcript files) -> {a.out}")
