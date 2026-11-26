#!/usr/bin/env python3
"""Stop guard: a session whose output style says Korean gets a Korean reply.

The `concise-adhd-korean` output style opens with "응답 언어는 항상 한국어다.
대화, 도구 결과, 서브에이전트 보고가 영어여도 그렇다." It still loses to a long
run of English tool output. This hook reads the reply that is ending the turn
and blocks the stop once when its prose -- code fences, inline code, block
quotes, URLs and paths removed -- is mostly English.

Which language is required, first match wins:
  1. the newest "# Output Style: <name>" in the transcript, which the harness
     records in the session-start system-reminder (a style whose name or text
     says Korean means Korean);
  2. `outputStyle` in ~/.claude/settings.json;
  3. $CLAUDE_REPLY_LANGUAGE, default "ko" -- this user's sessions are Korean.

Only the language is checked. Flagging undefined acronyms (output style rule 9)
needs to know which terms the user already uses, which one transcript does not
show, so it would fire on GPU, PR or API in most replies.

`stop_hook_active` means this hook already blocked once, so it cannot loop.
Fail-open: any error exits 0 silently.

Self-check: `python3 korean-reply-guard.py --selftest`.
"""
import json
import os
import re
import sys

TRANSCRIPT_TAIL = 2 * 1024 * 1024

# Below this many Latin letters a reply is too short to judge ("OK", a path).
MIN_LATIN = 60
# Hangul share of letters, one syllable weighted as two Latin letters.
MIN_HANGUL_SHARE = 0.3

FENCE = re.compile(r"```.*?(```|$)", re.DOTALL)
INLINE = re.compile(r"`[^`\n]*`")
QUOTE = re.compile(r"^\s*>.*$", re.MULTILINE)
URL = re.compile(r"https?://\S+")
PATH = re.compile(r"(~|\.{0,2})/[\w.@~/-]+|\b[\w-]+\.(py|ts|tsx|js|json|md|nix|toml|sh|rs|go)\b")
STYLE = re.compile(r"# Output Style: ([\w.-]+)")
HANGUL = re.compile("[%s-%s]" % (chr(0xAC00), chr(0xD7A3)))
LATIN = re.compile(r"[A-Za-z]")


def prose(text):
    for pat in (FENCE, INLINE, QUOTE, URL, PATH):
        text = pat.sub(" ", text)
    return text


def hangul_share(text):
    """(share, latin count) of the reply's prose."""
    body = prose(text or "")
    latin = len(LATIN.findall(body))
    hangul = len(HANGUL.findall(body))
    total = 2 * hangul + latin
    return (2 * hangul / total if total else 1.0), latin


def mostly_english(text):
    share, latin = hangul_share(text)
    return latin >= MIN_LATIN and share < MIN_HANGUL_SHARE


def style_in_transcript(path):
    """Name of the newest output style injected into the transcript, or None."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - TRANSCRIPT_TAIL))
            tail = fh.read().decode("utf-8", "replace")
    except (OSError, TypeError, ValueError):
        return None
    found = STYLE.findall(tail)
    if not found:
        return None
    name = found[-1]
    window = tail[tail.rfind("# Output Style: " + name):][:2000]
    return name + (" korean" if "한국어" in window else "")


def style_in_settings(path=None):
    try:
        with open(path or os.path.expanduser("~/.claude/settings.json")) as fh:
            value = json.load(fh).get("outputStyle")
        return value if isinstance(value, str) else None
    except (OSError, ValueError, AttributeError):
        return None


def korean_required(transcript_path, settings_path=None):
    style = style_in_transcript(transcript_path) or style_in_settings(settings_path)
    if style:
        return "korean" in style.lower()
    return os.environ.get("CLAUDE_REPLY_LANGUAGE", "ko").lower().startswith("ko")


REASON = (
    "The output style for this session requires Korean (응답 언어는 항상 "
    "한국어다), and this reply's prose is mostly English. Rewrite the reply in "
    "Korean, keeping code, commands, paths and quotes as they are."
)


def decide(data, settings_path=None):
    if data.get("stop_hook_active"):
        return None
    if not mostly_english(data.get("last_assistant_message") or ""):
        return None
    if not korean_required(data.get("transcript_path"), settings_path):
        return None
    return {"decision": "block", "reason": REASON}


def main():
    try:
        data = json.load(sys.stdin)
        if isinstance(data, dict):
            out = decide(data)
            if out:
                print(json.dumps(out))
    except Exception:
        pass  # fail-open


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        __import__("test_korean_reply_guard").main()
    else:
        main()
    sys.exit(0)
