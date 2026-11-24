#!/usr/bin/env python3
"""Assert check for repeat-correction-nudge.py.

Regression it catches: a pattern edit that stops the nudge firing on the
user's real repeated corrections (the Artifact-delivery and banner-layer
recurrences of 2026-11-17/23), or that starts firing on neutral prompts and
on side-agent notes the user did not write.
"""
import importlib.util
import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repeat-correction-nudge.py")
spec = importlib.util.spec_from_file_location("nudge", HOOK)
nudge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nudge)


def run(payload):
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    p = subprocess.run([sys.executable, HOOK], input=raw, capture_output=True, timeout=5)
    assert p.returncode == 0, p.stderr
    return p.stdout.decode()


def main():
    for text in (
        "청취는 내가 파일 던지지 말고 아티팩트로 하라고 수조번을 말하는데 왜 안지킬까",
        "너 이 실수 계속 반복하고 있다 시정해라",
        "왜 여전히 이상한 기억을 갖고 있나 모르겠네 gui로 뜬다고",
        "제발 GPU batch로 돌릴 수 있게 코드를 고치세요;;;",
        "아니 띠를 180도 arc로 고정하라고;;;",
        "you keep making the same mistake",
    ):
        assert nudge.fires(text), text
    for text in (
        "다시 물어봐봐",
        "stdlib은 어차피 unstable이라 계속 바뀔 것",
        "데브서버 다시켜봐",
        "ㅇㅋ 10시 기상해서 알림과의 전쟁하라고",
        "Here is a note offered by a side agent: 새 페이지를 또 만들 수 있어요, 제발",
        "<task-notification>자꾸</task-notification>",
        "is it still running?",
    ):
        assert not nudge.fires(text), text

    assert "rule-write" in run({"prompt": "자꾸 같은 실수 하네", "source": "user"})
    assert run({"prompt": "자꾸 같은 실수 하네", "source": "poll_event"}) == ""
    assert run({"prompt": "그래 진행해"}) == ""
    for bad in (b"", b"not json", b"[1]", json.dumps({"prompt": 42}).encode()):
        assert run(bad) == ""
    print("test_repeat_correction_nudge: ok")


if __name__ == "__main__":
    main()
