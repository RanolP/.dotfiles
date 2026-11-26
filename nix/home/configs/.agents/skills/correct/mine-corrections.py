#!/usr/bin/env python3
"""Extract the user's own messages from Claude Code transcripts, for correction mining.

Feeds memory-review step 5 and the correct skill: they cluster what the user had to
correct, so the input must be only text the user typed -- harness wrappers, tool
results, subagent transcripts and resumed-session replays would each inflate a class.

  python3 mine-corrections.py OUT.json [--since YYYY-MM-DD] [--root DIR]
  python3 mine-corrections.py --selftest
"""
import argparse, glob, json, os, re, sys

# Harness- and plugin-injected turns (system-reminder, task-notification, ...) open with a tag.
WRAPPER = re.compile(r'^\s*<[a-z][\w-]*[\s>]')
REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)
# Credentials pasted into a prompt must not reach the output file or a subagent brief.
# Copied from the removed clm mod's hooks/memory.ts SECRETS; a pattern with a group keeps that group (the key name) and redacts the rest.
SECRETS = [
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'\bsk-[A-Za-z0-9_-]{16,}'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}'),
    re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'),
    re.compile(r'\bgithub[_]pat_[A-Za-z0-9_]{20,}'),
    re.compile(r'\bnpm_[A-Za-z0-9]{36}\b'),
    re.compile(r'\bglpat-[A-Za-z0-9_-]{20,}'),
    re.compile(r'(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*', re.I),
    re.compile(r'((?:^|[^A-Za-z0-9])(?:x-api-key|authorization)\s*:\s*(?:(?:Bearer|Basic|Token)\s+)?)[^\s"\',;]{8,}', re.I | re.M),
    # An env-style NAME_ prefix (CLOUDFLARE_API_TOKEN=) defeats \b, since _ is a word char.
    re.compile(r'((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+_)*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|token|secret|password|passwd)\\?["\']?\s*[:=]\s*\\?["\']?)[^\s"\',;]{8,}', re.I | re.M),
    # camelCase names (accessToken, clientSecret); case-sensitive so monkey or keyed stay untouched.
    re.compile(r'((?:^|[^A-Za-z0-9])[a-z][A-Za-z0-9]*(?:Token|Secret|Password|Key)\\?["\']?\s*[:=]\s*\\?["\']?)[^\s"\',;]{8,}', re.M),
]


def redact(text):
    for pattern in SECRETS:
        text = pattern.sub(lambda m: (m.group(1) if pattern.groups else '') + '[REDACTED]', text)
    return text


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
    return redact(t) or None


def preceding_turn(events, i):
    """What the agent said and called just before message i: the thing being corrected."""
    out = []
    for p in reversed(events[max(0, i - 60):i]):
        if p.get('type') == 'user' and not is_tool_result((p.get('message') or {}).get('content')):
            break
        if p.get('type') == 'assistant':
            content = (p.get('message') or {}).get('content') or []
            if isinstance(content, str):
                content = [{'type': 'text', 'text': content}]
            # Redact before cutting: a cut through a token leaves a prefix no pattern recognizes.
            for b in reversed(content):
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text':
                    out.append('A: ' + redact(b.get('text') or '')[:400])
                elif b.get('type') == 'tool_use':
                    out.append('T: ' + redact(b.get('name', '') + ' ' + json.dumps(b.get('input'), ensure_ascii=False))[:200])
    return '\n'.join(reversed(out))[-2000:]


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
    assert user_text({'type': 'user', 'message': {'content': '<task-notification type="x">y'}}) is None
    assert user_text({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'x'}]}}) is None
    assert user_text({'type': 'user', 'isSidechain': True, 'message': {'content': 'hi'}}) is None
    assert user_text({'type': 'user', 'message': {'content': 'fix it <system-reminder>r</system-reminder>'}}) == 'fix it'
    assert 'ghp_' not in user_text({'type': 'user', 'message': {'content': 'use ghp_' + 'a' * 36}})
    # Regression: env-style names and prefixed tokens passed unredacted; fake values built at runtime.
    for raw, want in [('github' + '_pat_11' + 'g' * 40, '[REDACTED]'),
                      ('export CLOUDFLARE_API_TOKEN=' + 'c' * 40, 'export CLOUDFLARE_API_TOKEN=[REDACTED]'),
                      ('x-api-key: ' + 'x' * 30, 'x-api-key: [REDACTED]'),
                      ('token: ' + 't' * 20, 'token: [REDACTED]'),
                      # Regression: AWS-style and camelCase key names passed unredacted.
                      ('AWS_SECRET_ACCESS_KEY=' + 'a' * 40, 'AWS_SECRET_ACCESS_KEY=[REDACTED]'),
                      ('accessToken: ' + 'v' * 30, 'accessToken: [REDACTED]'),
                      ('"refreshToken":"' + 'r' * 30 + '"', '"refreshToken":"[REDACTED]"'),
                      ('clientSecret=' + 's' * 30, 'clientSecret=[REDACTED]'),
                      ('max_tokens: 4096', 'max_tokens: 4096'),
                      ('the tokenizer splits text', 'the tokenizer splits text')]:
        assert redact(raw) == want, (raw, redact(raw))
    # Regression: a value inside JSON-escaped quotes (a tool input after json.dumps) escaped redaction.
    escaped = redact(json.dumps({'command': 'export GH_TOKEN="' + 'g' * 40 + '"'}))
    assert 'g' * 40 not in escaped and 'GH_TOKEN=\\"[REDACTED]' in escaped, escaped
    # Regression: truncating before redacting left a token prefix that no pattern matched.
    long_tool = {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'x' * 150 + ' ghp_' + 'b' * 36}}]}}
    user = {'type': 'user', 'message': {'content': 'no'}}
    assert 'ghp_' not in preceding_turn([long_tool, user], 1)
    # An assistant entry whose content is a plain string.
    assert preceding_turn([{'type': 'assistant', 'message': {'content': 'hello'}}, user], 1) == 'A: hello'
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
