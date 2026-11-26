#!/usr/bin/env python3
"""Assert check for korean-reply-guard.py.

Regression it catches: an English reply ("No. X's display rules require the X
logo...") ending a turn of a concise-adhd-korean session unblocked -- the
2026-11 turns the user answered with "한국어로 말해 제발" -- or a Korean reply
dense with code, paths and identifiers getting blocked.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "korean-reply-guard.py")
spec = importlib.util.spec_from_file_location("guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

ENGLISH = ("No. X's display rules require the X logo, so removing it isn't allowed. "
           "Strictly, this is a matter of the developer agreement, not copyright law.")
KOREAN = ("`src/styles.css`에서 닉네임 줄 간격을 줄였다. A13 카드에서 gap이 4px로 보인다.\n"
          "```css\n.name { gap: 4px; letter-spacing: -0.01em; font-feature-settings: 'tnum'; }\n```\n"
          "react-tweet 3.3.1의 VerifiedBadge를 그대로 복사했다. GPU, API, PR 같은 약어는 그대로 둔다.")


def transcript(style_text):
    fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    fh.write(json.dumps({"type": "user", "message": {"content": style_text}}) + "\n")
    fh.close()
    return fh.name


def run(final, style_text, **extra):
    path = transcript(style_text)
    try:
        payload = {"transcript_path": path, "last_assistant_message": final}
        payload.update(extra)
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload).encode(),
                           capture_output=True, timeout=10)
    finally:
        os.unlink(path)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout) if p.stdout.strip() else None


KO_STYLE = "<system-reminder>\n# Output Style: concise-adhd-korean\n응답 언어는 항상 한국어다."
EN_STYLE = "<system-reminder>\n# Output Style: concise\nAnswer briefly."


def main():
    blocked = run(ENGLISH, KO_STYLE)
    assert blocked and blocked["decision"] == "block", blocked
    assert run(KOREAN, KO_STYLE) is None
    assert run(ENGLISH, EN_STYLE) is None
    assert run(ENGLISH, KO_STYLE, stop_hook_active=True) is None
    assert run("Done: `ok`", KO_STYLE) is None  # too short to judge
    # An English quote or code block inside a Korean reply is not prose.
    assert run("사용자가 쓴 문장:\n> " + ENGLISH + "\n\n이건 그대로 둔다.", KO_STYLE) is None
    assert run("```\n" + ENGLISH * 3 + "\n```\n로그다.", KO_STYLE) is None

    # No style in the transcript: settings.json, then the env default decides.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({"outputStyle": "concise"}, fh)
    try:
        assert guard.decide({"last_assistant_message": ENGLISH, "transcript_path": "/nonexistent"},
                            settings_path=fh.name) is None
    finally:
        os.unlink(fh.name)
    assert guard.decide({"last_assistant_message": ENGLISH, "transcript_path": "/nonexistent"},
                        settings_path="/nonexistent")

    for bad in (b"", b"not json", b"[1]", b'{"last_assistant_message": 5}'):
        p = subprocess.run([sys.executable, HOOK], input=bad, capture_output=True, timeout=10)
        assert p.returncode == 0 and not p.stdout.strip(), (bad, p.stdout, p.stderr)
    print("test_korean_reply_guard: ok")


if __name__ == "__main__":
    main()
