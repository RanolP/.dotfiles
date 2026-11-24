#!/usr/bin/env python3
"""UserPromptSubmit nudge: turn a repeated correction into a mechanism.

The rule "a lesson corrected twice becomes a guard, not more prose" already
sits in the always-loaded rules, and still 8 corrections in 12 days of
transcripts (2026-11-13..24) were the same mistake coming back -- the Artifact
delivery the user had asked for "수조번", the banner layers "계속 반복". Every
path that turns a class into a guard (rule-write, apology, dotfiles:evolve)
starts only when the user invokes it, so a repeat inside a session led to
nothing. This hook is the in-session trigger: when the prompt carries a
repetition or exasperation marker, it injects one line asking for the fix and
then the mechanism.

Measured on 971 unique user-typed prompts in ~/.claude/projects (2026-11-25):
it fired on 24; 23 were corrections and 15 of those named an instruction or a
mistake the user had corrected before. The one miss among the named recurrences was
"퍼킹 아티팩트로 달라고", which carries no marker. A correction that is not a
repeat still gets the line, which then costs one sentence of judgement.

Plain UserPromptSubmit stdout is model-visible context. Fail-open: any error
exits 0 silently.

Self-check: `python3 repeat-correction-nudge.py --selftest`.
"""
import json
import re
import sys

# Built from the user's own corrections in the transcripts. Bare "다시" and
# bare "계속" are left out: most of their hits were neutral ("다시 물어봐봐",
# "계속 바뀔 것"). "제발" stays because every one of its 16 hits was a
# correction, half of them of a class already corrected before.
PATTERNS = [
    r"계속\s?(반복|그러|이러|틀|같은|물|말)",
    r"실수를?\s?(계속\s?)?반복",
    r"자꾸",
    r"수[조십백천만억]\s?번",
    r"몇\s?번(을|이나|째|이고|씩)",
    r"여전히|아직도",
    r"왜\s?또|또\s?(이러|그러|틀리|같은|안\s)",
    r"제발",
    r"말했잖|말했는데|말하는데|라고\s?했잖|하라고\s?했|이미\s?(말|얘기)",
    r"다시\s?(설명할게|말하지만|말하는데)",
    r"라고\s?;",
    r"\bagain\b",
    r"\bkeep (doing|making|getting|using|adding|breaking)\b",
    r"\bhow many times\b",
    r"\bi (already )?(told|said)\b",
    r"\bsame (mistake|error|bug)\b",
    r"\bstill (not|broken|wrong|failing|doesn'?t|isn'?t)\b",
]
MARKER = re.compile("|".join(PATTERNS), re.IGNORECASE)

# Injected prompts that quote other text: a side agent's note, a clm ledger.
# A marker inside them is not the user repeating themselves.
QUOTED_PREFIXES = ("<", "Here is a note offered by a side agent", "[clm ledger")

NUDGE = (
    "This prompt reads as a repeated correction. Fix this instance first. "
    "Then name the recurring class in one line and turn it into a mechanism "
    "(a guard, check or test over prose): run skill `correct` when it has "
    "recurred, or `rule-write` for one rule, and offer that as the last line."
)


def fires(prompt):
    if not isinstance(prompt, str):
        return False
    text = prompt.strip()
    if not text or text.startswith(QUOTED_PREFIXES):
        return False
    return MARKER.search(text) is not None


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return
        if data.get("source") not in (None, "user", "sdk"):
            return
        if fires(data.get("prompt")):
            print(NUDGE)
    except Exception:
        pass  # fail-open


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        import importlib
        importlib.import_module("test_repeat_correction_nudge").main()
    else:
        main()
    sys.exit(0)
