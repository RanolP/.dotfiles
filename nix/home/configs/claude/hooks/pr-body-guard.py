#!/usr/bin/env python3
"""PreToolUse guard: keep a PR body from silently losing lines or shipping broken mermaid.

Two failures from real sessions produced this hook:

- A rewrite of an open PR's body dropped table columns the user had added by
  hand -- "테이블은 내가 열을 추가한 걸 니가 날렸잖아!!!!". The body had been
  rebuilt from the branch instead of from the remote body, so every human edit
  vanished with one `gh pr edit`.
- A ```mermaid fence carrying `<br/>` inside a backtick markdown-string label
  reached GitHub and rendered as "Unable to render rich display -- Lexical
  error on line 2".

So this guard does exactly two things:

1. `gh pr edit` with a body: every non-boilerplate line of the REMOTE body must
   survive into the new body. Dropped lines are printed in the deny reason, so
   the next attempt is written on top of the remote text rather than beside it.
   A line survives when it is rewritten as well as when it is untouched, as long
   as only bookkeeping words moved -- commit hashes, counts, branch names, paths
   -- because a force-push rewrites those on every push and refreshing them is
   standing policy. A word of prose changing or vanishing is still a drop.
2. `gh pr create|edit` with a body: every ```mermaid fence passes a structural
   lint (known diagram type, no `<br>` inside a markdown-string label, balanced
   quotes and brackets). When `mmdc` happens to be on PATH the real parser runs
   too; it is optional and never installed on demand.

Escape hatch: prefix the command with `PR_BODY_GUARD_ALLOW_DROP=1` when the drop
is deliberate. The deny exists to make the dropped lines visible first, not to
freeze a body forever.

Fail open on anything unexpected -- this guard must never make `gh` unusable.
"""
import difflib
import json
import os
import re
import shlex
import subprocess
import sys

# gh options that consume the next token as their value.
OPTS_WITH_VALUE = {
    "--body", "-b", "--body-file", "-F", "--title", "-t", "--repo", "-R",
    "--base", "-B", "--head", "-H", "--milestone", "-m", "--template", "-T",
    "--assignee", "-a", "--label", "-l", "--project", "-p", "--reviewer", "-r",
    "--add-assignee", "--remove-assignee", "--add-label", "--remove-label",
    "--add-project", "--remove-project", "--add-reviewer", "--remove-reviewer",
}

DIAGRAM_KEYWORDS = (
    "flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram",
    "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "quadrantChart",
    "requirementDiagram", "gitGraph", "mindmap", "timeline", "zenuml",
    "sankey-beta", "xychart-beta", "block-beta", "packet-beta", "kanban",
    "architecture-beta", "radar-beta", "treemap-beta", "C4Context",
    "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
)

TEMPLATE_NAMES = ("pull_request_template.md", "pull_request_template.txt")
TEMPLATE_DIRS = (".github", ".", "docs", ".github/PULL_REQUEST_TEMPLATE")

MERMAID_FENCE = re.compile(r"^[ \t]*```+[ \t]*mermaid[ \t]*$", re.I)
FENCE_END = re.compile(r"^[ \t]*```+[ \t]*$")
# A markdown-string label: ["`...`"] / ("`...`") / {"`...`"} -- mermaid parses
# the inner text as markdown, where a literal <br/> is a lexical error (use a
# real newline). The body may itself contain backticks, so match to the closing
# bracket rather than to the first inner backtick.
MD_STRING_LABEL = re.compile(r'[\[({]"`(.*?)`"[\])}]', re.S)
# A commit SHA: 7-40 hex chars with at least one a-f, so a plain number like
# 1000000 is never masked.
SHA_TOKEN = re.compile(r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")
# Hangul, kana and han -- a changed token carrying these is prose, not bookkeeping.
CJK = re.compile(r"[\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff]")
# Punctuation around a word: "guard," and "guard" are the same word, while
# "safe." and "unsafe." must stay different words.
EDGE_PUNCT = re.compile(r"^[^\w<]+|[^\w>]+$")
# At most half of a line's words may change before it stops reading as the same
# line. Measured 2026-08-18 over 16 real body lines: every bookkeeping refresh
# changes 1 word of 2 or more, every genuine rewrite changes more.
MAX_EDITED_SHARE = 0.5


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def gh_invocation(tokens):
    """Return the argv slice after `gh pr <verb>`, plus the verb, else (None, None)."""
    i = 0
    while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("-"):
        i += 1  # leading VAR=value env assignments
    if i + 2 >= len(tokens):
        return None, None
    if tokens[i].rsplit("/", 1)[-1] != "gh" or tokens[i + 1] != "pr":
        return None, None
    return tokens[i + 2], tokens[i + 3:]


def extract_body(args, cwd):
    """Return (body_text, source) from --body/--body-file, or (None, reason)."""
    i = 0
    while i < len(args):
        a = args[i]
        key, inline = (a.split("=", 1) + [None])[:2] if a.startswith("--") and "=" in a else (a, None)
        if key in ("--body", "-b"):
            val = inline if inline is not None else (args[i + 1] if i + 1 < len(args) else None)
            return (val, "--body") if val is not None else (None, "no value")
        if key in ("--body-file", "-F"):
            path = inline if inline is not None else (args[i + 1] if i + 1 < len(args) else None)
            if path in (None, "-"):
                return None, "stdin"
            try:
                with open(os.path.join(cwd, path) if not os.path.isabs(path) else path) as fh:
                    return fh.read(), path
            except OSError:
                return None, "unreadable"
        i += 2 if (a in OPTS_WITH_VALUE) else 1
    return None, "absent"


def pr_selector(args):
    """First positional after the verb -- gh pr edit [<number|url|branch>]."""
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("-"):
            i += 2 if a in OPTS_WITH_VALUE else 1
            continue
        return a
    return None


def mermaid_blocks(body):
    blocks, cur, inside = [], [], False
    for line in body.splitlines():
        if not inside and MERMAID_FENCE.match(line):
            inside, cur = True, []
            continue
        if inside and FENCE_END.match(line):
            blocks.append("\n".join(cur))
            inside = False
            continue
        if inside:
            cur.append(line)
    return blocks


def lint_mermaid(block):
    """Return a list of human-readable problems in one mermaid block."""
    problems = []
    lines = [l for l in block.splitlines() if l.strip()]
    if not lines:
        return ["empty mermaid block"]
    head = lines[0].strip()
    if not any(head.startswith(k) for k in DIAGRAM_KEYWORDS):
        problems.append('first line "%s" names no known diagram type' % head[:40])
    for label in MD_STRING_LABEL.findall(block):
        if re.search(r"<br\s*/?>", label, re.I):
            problems.append(
                'markdown-string label "`%s`" contains <br/> -- inside backticks '
                "mermaid wants a real newline, and <br/> is a lexical error" % label[:50]
            )
    for n, line in enumerate(lines, 1):
        if line.count('"') % 2:
            problems.append("line %d has an odd number of double quotes" % n)
        for opener, closer in (("[", "]"), ("(", ")"), ("{", "}")):
            if line.count(opener) != line.count(closer):
                problems.append("line %d has unbalanced %s%s" % (n, opener, closer))
    return problems


def mmdc_parse(block):
    """Real parse when mmdc is already on PATH. Returns an error string or ""."""
    from shutil import which
    if not which("mmdc"):
        return ""
    try:
        p = subprocess.run(
            ["mmdc", "-i", "-", "-o", os.devnull, "-e", "svg"],
            input=block, capture_output=True, text=True, timeout=45,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return (p.stderr or "").strip()[:400] if p.returncode else ""


def template_lines(cwd):
    """Every line of the repo's PR template -- those are boilerplate, not content."""
    out = set()
    for d in TEMPLATE_DIRS:
        base = os.path.join(cwd, d)
        if not os.path.isdir(base):
            continue
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if name.lower() in TEMPLATE_NAMES or name.lower().startswith("pull_request_template"):
                try:
                    with open(os.path.join(base, name)) as fh:
                        out.update(l.strip() for l in fh)
                except OSError:
                    pass
    out.discard("")
    return out


def remote_body(selector, args, cwd):
    cmd = ["gh", "pr", "view"]
    if selector:
        cmd.append(selector)
    for i, a in enumerate(args):  # carry an explicit --repo through
        if a in ("--repo", "-R") and i + 1 < len(args):
            cmd += ["--repo", args[i + 1]]
    cmd += ["--json", "body", "-q", ".body"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20, cwd=cwd)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


def canon(line):
    """The line with commit SHAs masked.

    A force-push rewrites every hash in the body, and the standing instruction is
    to refresh those hashes on every push without asking. Compared literally, each
    refreshed line reads as a lost line, so the guard denied an edit whose only
    change was the hash. Masking makes a hash-only rewrite compare equal, while any
    other character difference still denies.
    """
    return SHA_TOKEN.sub("<sha>", line)


def words(line):
    return [w for w in (EDGE_PUNCT.sub("", t) for t in canon(line).split()) if w]


def bookkeeping(word):
    """True when the word is a fact that a push rewrites, not something a human wrote.

    Hashes, counts, versions, branch names, paths and URLs all change on their own
    as the branch moves; a Korean or English word does not.
    """
    if CJK.search(word):
        return bool(re.search(r"\d", word))  # "12개" moves with the diff, "없음이" does not
    return bool(re.search(r"[\d/:@#.]", word))


def edited(old, new):
    """True when `new` is `old` with only bookkeeping words rewritten.

    Character similarity cannot decide this. Measured 2026-08-18 on 14 real body
    lines: a hash-and-count refresh scores 0.824 while the meaning flip
    `되돌릴 수 없습니다` -> `되돌릴 수 있습니다` scores 0.955, so every threshold
    that passes the refresh also passes the flip. What separates them is WHICH
    words moved, so this compares word by word:

    - a word deleted with nothing in its place: not an edit, the line lost text
    - a word added: fine, the line grew
    - a word replaced: an edit only when both sides are bookkeeping words
    - and at most MAX_EDITED_SHARE of the line's words may be replaced
    """
    a, b = words(old), words(new)
    if not a or not b:
        return False
    ops = difflib.SequenceMatcher(None, a, b).get_opcodes()
    if not any(tag == "equal" for tag, *_ in ops):
        return False
    changed = 0
    for tag, i1, i2, j1, j2 in ops:
        if tag in ("equal", "insert"):
            continue
        if tag == "delete":
            return False
        if not all(bookkeeping(w) for w in a[i1:i2] + b[j1:j2]):
            return False
        changed += i2 - i1
    return changed <= MAX_EDITED_SHARE * len(a)


def table_cells(line):
    """Cells of a markdown table row, or None when the line is not one."""
    if not line.startswith("|") or line.count("|") < 2:
        return None
    return [c for c in (c.strip() for c in line.strip("|").split("|")) if c]


def dropped_lines(remote, new, boilerplate):
    """Remote lines with no survivor in the new body.

    Three ways a remote line survives, tried in that order so an exact twin is
    never spent on a line that merely resembles it:

    1. identical after masking commit SHAs (see canon)
    2. a table row whose CELLS all appear in some new row -- a row's identity is
       its cells, so adding a column or realigning the pipes keeps the row, while
       a cell gone is the incident this guard exists for. Character similarity
       cannot stand in here: measured 2026-08-14, dropping one column from a wide
       row scores 0.929 while the genuine edit `장애 없음` -> `장애 있음` scores
       0.800, so the two ranges overlap.
    3. the same line with only bookkeeping words rewritten (see edited)

    Each new line covers at most one remote line, so five near-identical bullets
    cannot all be waved through by one survivor.

    Only lines that failed step 1 reach the pairwise loop, so an ordinary refresh
    costs nothing. Measured 2026-08-18, a 300-line body rewritten end to end -- the
    worst input there is -- takes 0.98s, next to the `gh pr view` call this guard
    already makes.
    """
    unmatched = [canon(l.strip()) for l in new.splitlines() if l.strip()]
    pending = []
    for raw in remote.splitlines():
        line = raw.strip()
        if len(line) < 4 or line in boilerplate:
            continue
        if canon(line) in unmatched:
            unmatched.remove(canon(line))
            continue
        pending.append(line)

    out = []
    for line in pending:
        cells = table_cells(canon(line))
        hit = None
        for cand in unmatched:
            cand_cells = table_cells(cand)
            if cells and cand_cells and set(cells) <= set(cand_cells):
                hit = cand
                break
            if edited(line, cand):
                hit = cand
                break
        if hit is None:
            out.append(line)
        else:
            unmatched.remove(hit)
    return out


def nearest(line, new_lines):
    """Closest surviving line, so a deny says whether this looks edited or lost.

    Runs on the deny path only, over the <=15 lines actually shown. Pairwise
    similarity across whole bodies costs 2.7s at 300x300 lines and would tax every
    `gh pr edit`; this stays off the hot path on purpose.
    """
    hit = difflib.get_close_matches(line, new_lines, n=1, cutoff=0.6)
    return hit[0] if hit else None


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name") not in (None, "Bash"):
        sys.exit(0)
    cmd = data.get("tool_input", {}).get("command", "")
    if "gh" not in cmd or " pr " not in cmd:
        sys.exit(0)
    cwd = data.get("cwd") or os.getcwd()

    try:
        tokens = shlex.split(cmd)
    except ValueError:
        sys.exit(0)  # unparseable quoting: no opinion

    verb, args = gh_invocation(tokens)
    if verb not in ("create", "edit"):
        sys.exit(0)

    body, source = extract_body(args, cwd)
    if body is None:
        sys.exit(0)  # no body in this call: nothing of ours to check

    for i, block in enumerate(mermaid_blocks(body), 1):
        problems = lint_mermaid(block)
        err = mmdc_parse(block) if not problems else ""
        if problems or err:
            detail = "; ".join(problems) or err
            decide("deny", (
                "Mermaid block %d in the PR body will not render on GitHub: %s\n"
                "Fix the fence in %s and re-run. A broken fence shows the reader "
                '"Unable to render rich display", not the diagram.' % (i, detail, source)
            ))

    if verb != "edit" or os.environ.get("PR_BODY_GUARD_ALLOW_DROP") == "1" \
            or "PR_BODY_GUARD_ALLOW_DROP=1" in cmd:
        sys.exit(0)

    remote = remote_body(pr_selector(args), args, cwd)
    if not remote:
        sys.exit(0)  # no open PR, no gh auth, offline: no opinion

    dropped = dropped_lines(remote, body, template_lines(cwd))
    if dropped:
        new_lines = [l.strip() for l in body.splitlines() if l.strip()]
        rows = []
        for l in dropped[:15]:
            rows.append("  - " + l[:120])
            near = nearest(l, new_lines)
            if near:
                rows.append("    ~ closest surviving line: " + near[:120])
        shown = "\n".join(rows)
        more = "\n  ... and %d more" % (len(dropped) - 15) if len(dropped) > 15 else ""
        decide("deny", (
            "This `gh pr edit` drops %d line(s) that exist in the remote PR body:\n%s%s\n\n"
            "Read the remote body first (`gh pr view --json body -q .body`), edit THAT "
            "text, and write the result back. Hand-added rows and columns live only on "
            "the remote.\nA `~` line means a near-identical line survived, so that one "
            "reads as an edit rather than a loss.\nIf the drop is deliberate, re-run with "
            "PR_BODY_GUARD_ALLOW_DROP=1 in front of the command."
            % (len(dropped), shown, more)
        ))
    sys.exit(0)


def self_check():
    ok = lint_mermaid('flowchart LR\n  A["plain"] --> B["also plain"]')
    assert ok == [], ok
    bad = lint_mermaid('flowchart LR\n  A["`.prev`로 스냅샷<br/>compose`"] --> B')
    assert any("<br/>" in p for p in bad), bad
    assert any("no known diagram type" in p for p in lint_mermaid("flowhcart LR\n A --> B"))
    assert any("unbalanced" in p for p in lint_mermaid("flowchart LR\n A[oops --> B"))

    body = "## 개요\n\n```mermaid\nflowchart LR\n A --> B\n```\ntail\n"
    assert mermaid_blocks(body) == ["flowchart LR\n A --> B"], mermaid_blocks(body)

    remote = "## 개요\n| 열A | 열B | 내가추가한열 |\n- [ ] 변경 후 확인이 필요한 기능을 명시해주세요\n"
    new = "## 개요\n| 열A | 열B |\n"
    boiler = {"- [ ] 변경 후 확인이 필요한 기능을 명시해주세요"}
    assert dropped_lines(remote, new, boiler) == ["| 열A | 열B | 내가추가한열 |"]
    assert dropped_lines(remote, remote, boiler) == []

    # A column vanishing from a WIDE row is the incident, and char similarity
    # scores it 0.929 -- higher than a genuine edit -- so only cell sets catch it.
    wide = "| file | change | why | risk | owner | notes | mine |"
    assert dropped_lines(wide, "| file | change | why | risk | owner | notes |", set()) == [wide]

    # Adding a column must NOT read as a drop: the old cells all survive.
    assert dropped_lines("| 열A | 열B |", "| 열A | 열B | 새열 |", set()) == []
    # Realigning the pipes rewrites the string but loses no cell.
    assert dropped_lines("| 열A | 열B |", "|  열A  |  열B  |", set()) == []
    # Editing a cell still denies -- a cell's text is gone.
    assert dropped_lines("| 파일 | 변경 내용 |", "| 파일 | 변경 사항 |", set()) \
        == ["| 파일 | 변경 내용 |"]
    # Prose keeps exact matching: no similarity threshold may soften it.
    assert dropped_lines("장애 없음이 확인되었습니다", "장애 있음이 확인되었습니다", set()) \
        == ["장애 없음이 확인되었습니다"]

    # A force-push hash refresh is an update, not a loss -- both prose and cells.
    assert dropped_lines("- 1a2b3c4 fix: guard", "- 9f8e7d6 fix: guard", set()) == []
    assert dropped_lines(
        "| 1a2b3c4 | pr-body-guard | 해시 허용 |",
        "| 9f8e7d6 | pr-body-guard | 해시 허용 |", set()) == []
    assert dropped_lines(
        "compare/1a2b3c4...5d6e7f8", "compare/9f8e7d6...0c1b2a3", set()) == []
    # The message beside the hash still has to survive.
    assert dropped_lines("- 1a2b3c4 fix: guard", "- 9f8e7d6 fix: 다른 것", set()) \
        == ["- 1a2b3c4 fix: guard"]
    # Counts move with the branch, so a refreshed count is an edit, not a loss.
    assert dropped_lines("- 1a2b3c4 (3 files, +40/-2) 가드", "- 9f8e7d6 (4 files, +52/-2) 가드", set()) == []
    assert dropped_lines("총 12개 파일, 340줄 추가", "총 13개 파일, 352줄 추가", set()) == []
    assert dropped_lines("base: claude/guard-hash", "base: claude/guard-sha", set()) == []
    # Text may grow: appending to a line loses nothing.
    assert dropped_lines("- 1a2b3c4 fix: guard", "- 9f8e7d6 fix: guard, 리뷰 반영", set()) == []
    # A meaning flip scores 0.955 in character similarity yet must still deny.
    flip = "주의: 마이그레이션은 되돌릴 수 없습니다"
    assert dropped_lines(flip, "주의: 마이그레이션은 되돌릴 수 있습니다", set()) == [flip]
    assert dropped_lines("rollback is safe.", "rollback is unsafe.", set()) == ["rollback is safe."]
    # A clause dropped off the end is a deletion, whatever the similarity.
    pair = "QA 담당: 김OO, 배포 창구: 박OO"
    assert dropped_lines(pair, "QA 담당: 김OO", set()) == [pair]
    # One survivor covers one remote line, so a real drop cannot hide behind a twin.
    two = "- 1a2b3c4 배포\n- 1a2b3c4 배포"
    assert dropped_lines(two, "- 9f8e7d6 배포", set()) == ["- 1a2b3c4 배포"]
    # bookkeeping() word classes.
    assert bookkeeping("1a2b3c4") and bookkeeping("12개") and bookkeeping("claude/x-y")
    assert not bookkeeping("없음이") and not bookkeeping("unsafe") and not bookkeeping("guard")
    assert words("- 9f8e7d6 fix: guard,") == ["<sha>", "fix", "guard"]

    assert table_cells("| a | b |") == ["a", "b"]
    assert table_cells("plain prose | with a pipe") is None
    assert nearest("| 열A | 열B | 내가추가한열 |", ["| 열A | 열B |"]) == "| 열A | 열B |"
    assert nearest("완전히 다른 문장", ["| 열A | 열B |"]) is None

    assert gh_invocation(shlex.split("gh pr edit 12 --body-file b.md"))[0] == "edit"
    assert gh_invocation(shlex.split("git push origin main"))[0] is None
    assert extract_body(shlex.split("--title t --body hello"), ".") == ("hello", "--body")
    assert extract_body(shlex.split("--body-file -"), ".")[0] is None
    assert pr_selector(shlex.split("--title t 4321 --body x")) == "4321"
    print("pr-body-guard self-check: ok")


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        self_check()
    else:
        try:
            main()
        except Exception:
            sys.exit(0)  # fail open
