#!/usr/bin/env python3
"""Stop hook: run the draft scan the ADHD-shaped-output rule used to ask for.

The `DO (scan the draft before sending)` item in AGENTS.md was a list of
literal string substitutions -- pure machine work handed to a model as prose,
and prose aimed at a model is a request, not a guard. Over one month of
transcripts, 15 user corrections mapped to that one item. This hook does the
search instead, so the rule keeps only the sentence a machine cannot check.

What it reads: the LAST assistant message in the transcript, text blocks only.
Tool calls, tool results and thinking blocks are not what the user reads, so a
`should` inside a shell command must never block a turn. Subagent (sidechain)
entries are skipped for the same reason -- their text is not user-facing.

What it skips inside that message: fenced code, inline code, and blockquotes.
Commands and verbatim user quotes are the two big false-positive sources, and
rewriting a quote to satisfy a style check would corrupt the quote.

Blocking is deliberate but capped at ONCE per turn: `stop_hook_active` is true
on the re-entry after a block, and that short-circuits everything. The failure
this cap prevents is the one the user named "아오 저 미친 stop hook" three
times -- a Stop hook that discards the turn repeatedly, so the answer the user
was reading is replaced by the hook's demand. For the same reason the reason
string says ONLY "fix these words and send the same answer again". It gives no
instruction about content: the answer was already right, the wording was not.

Only the top 3 hits are reported. The full list is noise, and a long block
reason costs the same context every turn it fires.

Fail-open everywhere: an unreadable transcript, a malformed payload, or a bug
here means silence, never a wedged session.

Self-check: `python3 draft-scan-guard.py --selftest`.
"""
import json
import re
import sys

MAX_HITS = 3
MAX_SENTENCE_WORDS = 25

# (label, compiled pattern, what to write instead)
CHECKS = [
    ("hedge", re.compile(r"\b(should|would|may|might|could)\b", re.I),
     "use can/will/must or state the fact plainly"),
    ("contraction", re.compile(r"(\w['’](ll|re|s|t|ve|d)|n['’]t)\b", re.I),
     "expand to full words"),
    ("passive-perfect", re.compile(r"\b(has|have) been\b", re.I),
     "use simple past or simple present"),
    ("comma-ing", re.compile(r",\s+(making|allowing|enabling|ensuring)\b", re.I),
     "start a new sentence with a real subject"),
    ("semicolon", re.compile(r";"),
     "split into two sentences"),
    ("latin-abbrev", re.compile(r"\b(e\.g\.|i\.e\.|etc\.)", re.I),
     'write "for example", "that is", or the named items'),
]

FENCE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE = re.compile(r"`[^`]*`")
QUOTE_LINE = re.compile(r"^\s*>")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def strip_uncheckable(text):
    """Drop fenced code, inline code and blockquotes -- false-positive sources."""
    out = []
    in_fence = False
    for line in text.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence or QUOTE_LINE.match(line):
            continue
        out.append(INLINE_CODE.sub(" ", line))
    return "\n".join(out)


def quote(text, start, end, pad=24):
    """The hit with a little surrounding text, so the fix site is findable."""
    snippet = text[max(0, start - pad):min(len(text), end + pad)]
    return " ".join(snippet.split())


def long_sentences(text):
    for sentence in SENTENCE_SPLIT.split(text):
        words = sentence.split()
        if len(words) > MAX_SENTENCE_WORDS:
            yield len(words), " ".join(words[:12]) + " ..."


def scan(text):
    """Every style hit in `text`, as (label, fix, quoted context) tuples."""
    body = strip_uncheckable(text)
    hits = []
    for label, pattern, fix in CHECKS:
        for m in pattern.finditer(body):
            hits.append((label, fix, quote(body, m.start(), m.end())))
    for count, opening in long_sentences(body):
        hits.append(("long-sentence", f"split it -- {count} words, cap is {MAX_SENTENCE_WORDS}",
                     opening))
    return hits


def last_assistant_text(transcript_path):
    """Text blocks of the last main-thread assistant message, joined."""
    try:
        with open(transcript_path) as fh:
            lines = fh.readlines()
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            continue
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


def reason_for(hits):
    lines = ["Draft scan caught these -- fix the wording and send the same answer again. "
             "Change no content, no structure, nothing else:"]
    for label, fix, ctx in hits[:MAX_HITS]:
        lines.append(f"- {label}: \"{ctx}\" -> {fix}")
    return "\n".join(lines)


def handle(data):
    """Process one Stop event; returns the JSON payload to emit, or None."""
    if data.get("stop_hook_active"):
        return None  # one block per turn -- never loop on the user
    text = last_assistant_text(data.get("transcript_path", ""))
    if not text.strip():
        return None
    hits = scan(text)
    if not hits:
        return None
    return {"decision": "block", "reason": reason_for(hits)}


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    try:
        payload = handle(data)
    except Exception:
        sys.exit(0)  # fail-open
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


def selftest():
    import os
    import tempfile

    # Every check fires on its own trigger.
    assert any(h[0] == "hedge" for h in scan("This should work."))
    assert any(h[0] == "hedge" for h in scan("It might break."))
    assert any(h[0] == "contraction" for h in scan("I'll do it."))
    assert any(h[0] == "contraction" for h in scan("They aren't ready."))
    assert any(h[0] == "contraction" for h in scan("It's done."))
    assert any(h[0] == "passive-perfect" for h in scan("The file has been moved."))
    assert any(h[0] == "comma-ing" for h in scan("I split it, making the flow clear."))
    assert any(h[0] == "semicolon" for h in scan("One thing; another thing."))
    assert any(h[0] == "latin-abbrev" for h in scan("Some tools, e.g. ripgrep."))
    assert scan("The build passes. Run it yourself.") == []

    # A sentence over the cap is caught; one under it is not.
    assert any(h[0] == "long-sentence" for h in scan(" ".join(["word"] * 30) + "."))
    assert not any(h[0] == "long-sentence" for h in scan(" ".join(["word"] * 20) + "."))

    # Code and quotes are exempt -- a command or a verbatim user quote must
    # never be rewritten to satisfy a style check.
    assert scan("Run `git push; git log` now.") == []
    assert scan("```\nit should fail; e.g. here\n```\nDone.") == []
    assert scan("> the user wrote: it should have been done\n\nDone.") == []
    # ...but the same words outside a fence still count.
    assert scan("Closing fence then it should fail.") != []

    # Only the top 3 hits reach the reason string.
    many = scan("It should; it would; it might; it could; it may.")
    assert len(many) > MAX_HITS
    assert reason_for(many).count("\n- ") == MAX_HITS

    # The reason talks about wording only -- never about what to answer.
    r = reason_for(scan("This should work."))
    assert "same answer again" in r
    for banned in ("rewrite the answer", "explain", "add "):
        assert banned not in r

    tmp = tempfile.mkdtemp(prefix="draft-scan-selftest-")
    path = os.path.join(tmp, "t.jsonl")

    def write(entries):
        with open(path, "w") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")

    def msg(text, **kw):
        return {"type": "assistant",
                "message": {"content": [{"type": "text", "text": text}]}, **kw}

    # A clean draft passes; a hedged one blocks with a quoted hit.
    write([msg("The build passes. Run it yourself.")])
    assert handle({"transcript_path": path}) is None
    write([msg("This should work.")])
    out = handle({"transcript_path": path})
    assert out["decision"] == "block" and "should" in out["reason"]

    # The block fires once per turn: the re-entry carries stop_hook_active.
    assert handle({"transcript_path": path, "stop_hook_active": True}) is None

    # Tool-use blocks and thinking are not what the user reads.
    write([{"type": "assistant", "message": {"content": [
        {"type": "thinking", "thinking": "this should be fine"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls; pwd"}},
        {"type": "text", "text": "Listed the files."}]}}])
    assert handle({"transcript_path": path}) is None

    # A subagent's text is not user-facing, so it is skipped entirely.
    write([msg("Clean line here."), msg("This should break.", isSidechain=True)])
    assert handle({"transcript_path": path}) is None

    # Missing or malformed transcripts stay silent.
    assert handle({"transcript_path": os.path.join(tmp, "nope.jsonl")}) is None
    assert handle({}) is None
    with open(path, "w") as fh:
        fh.write("not json\n")
    assert handle({"transcript_path": path}) is None

    os.remove(path)
    os.rmdir(tmp)
    print("draft-scan-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
