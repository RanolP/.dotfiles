#!/usr/bin/env python3
"""PreToolUse guard: keep a PR body from losing lines, shipping broken mermaid, or reading as 서술식.

Three failures from real sessions produced this hook:

- A rewrite of an open PR's body dropped table columns the user had added by
  hand. The body had been rebuilt from the branch instead of from the remote
  body, so every human edit vanished with one `gh pr edit`.
- A ```mermaid fence carrying `<br/>` inside a backtick markdown-string label
  reached GitHub and rendered as "Unable to render rich display -- Lexical
  error on line 2".
- Bodies kept arriving in 서술식 (full sentences ending in ~한다/~합니다) even
  though guides/pr.md says 개조식 (noun phrases, -함/-됨/-임/-음). The rule was
  prose aimed at a model, and prose gets skipped; a guard is the only form that
  holds.

So this guard does exactly three things:

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
3. `gh pr create|edit` with a body: no Hangul line may end in a sentence-final
   ending (니다/요/다). Fences, headings, table rows, template lines and lines
   quoting a commit SHA are exempt, and a wrapped list item is judged as one.
   The ending check alone was gamed (한다→함 with the clauses intact: "없어 …
   동작하지 않던 상태"), so the guard also counts predicates per arrow-segment
   and denies an item that chains more than one. A 작업 내역 listing one flat
   bullet per commit -- seven siblings at one level -- was rejected three times
   even after 개조식 and the `문제 -> 해결` arrows landed, so the guard also
   requires the nesting: a section of 5+ flat Hangul items with nothing nested
   under any of them is denied.

Escape hatch: prefix the command with `PR_BODY_GUARD_ALLOW_DROP=1` when the drop
is deliberate, or `PR_BODY_GUARD_ALLOW_PROSE=1` when the prose is. The deny
exists to make the problem visible first, not to freeze a body forever.

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

ANY_FENCE = re.compile(r"^[ \t]*```")
HANGUL = re.compile(r"[가-힣]")
LIST_MARKER = re.compile(r"^[ \t]*(?:[-*+]|\d+\.)(?:[ \t]+\[[ xX]\])?(?:[ \t]|$)")
# A Korean sentence-final ending: 합니다/하세요/해요/한다. -함/-됨/-임/-음, a bare
# noun and a closing backtick all miss, which is what 개조식 looks like.
SENTENCE_END = re.compile(r"(?:니다|세요|[어아여해예]요|[가-힣]다)$")
TRAILING_CLOSERS = re.compile(r"""[.。!?)\]"'\s]+$""")
# A sentence closed and another begun inside one item: "…한다. 그리고 …".
SENTENCE_BREAK = re.compile(r"[가-힣]다\.\s")
# 개조식 compresses a story into an arrow chain of noun phrases, one predicate
# per segment. A story told in 서술식 chains clauses instead (없어 … 동작하지 않던),
# so more than one conjugated 어절 in a segment is the tell.
ARROW = re.compile(r"\s*(?:->|→|=>|⇒)\s*")
# Explicit connective/conjugated endings only. A generic 고$/어$ would count
# nouns like 재고 and 언어; 받고/밀림/누락/해결 all miss on purpose.
PREDICATE_END = re.compile(
    r"(?:하고|되고|않고|없고|있고|하며|되며|해서|돼서|하여|되어|않아|없어|있어|하지|되지"
    r"|하게|되게|않던|않는|않게|는데|지만|므로|니까|라서|면서|려고|도록|던|해|돼)$"
)
WORD_EDGE = re.compile(r"^\W+|\W+$")
# A 작업 내역 item opens with the short sha: `3. 795077968 feat: ...`. SHA_TOKEN
# wants an a-f digit and a 9-digit sha like that one has none, so the position
# of the token is what identifies it here.
COMMIT_ITEM = re.compile(r"^(?:[-*+]|\d+\.)[ \t]+[0-9a-f]{7,40}\b")
HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]*(.*)$")
# A section that lists one sibling per commit carries no causal structure. Under
# 5 items a flat list still reads as a list; at 5 the fold is what was missing.
MIN_FLAT_ITEMS = 5


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
        # A CJK word carrying a digit is a count that moves with the diff; a
        # digit-free CJK word is prose the author wrote.
        return bool(re.search(r"\d", word))
    return bool(re.search(r"[\d/:@#.]", word))


def edited(old, new):
    """True when `new` is `old` with only bookkeeping words rewritten.

    Character similarity cannot decide this. Measured 2026-08-18 on 14 real body
    lines: a hash-and-count refresh scores 0.824 while a one-word negation flip
    (a warning turning from "cannot be rolled back" into "can be rolled back")
    scores 0.955, so every threshold that passes the refresh also passes the
    flip. What separates them is WHICH words moved, so this compares word by
    word:

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
       row scores 0.929 while a genuine one-word cell edit (a status cell flipping
       from "no outage" to "outage") scores 0.800, so the two ranges overlap.
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


def predicates(segment):
    """Number of 어절 in one arrow-segment that end in a conjugated verb form."""
    return sum(
        1 for tok in segment.split()
        if PREDICATE_END.search(WORD_EDGE.sub("", tok))
    )


def prose_verdict(text):
    """'문장 종결', '절 K개' when the item reads as 서술식, else None."""
    if SENTENCE_END.search(TRAILING_CLOSERS.sub("", text)) or SENTENCE_BREAK.search(text):
        return "문장 종결"
    worst = max(predicates(seg) for seg in ARROW.split(text))
    return "절 %d개" % worst if worst > 1 else None


def prose_lines(body, boilerplate):
    """(item, verdict) pairs for Hangul items written as 서술식 rather than 개조식.

    A wrapped list item -- an indented line with no list marker under a list
    line -- is joined to its item first, so only the item's real ending is
    judged. A line carrying a commit SHA quotes a commit subject verbatim, and
    the work repos' subjects end in ~한다 by convention, so it is exempt.

    Two criteria: a sentence-final ending (or a sentence break mid-item), and
    more than one predicate inside one arrow-segment -- see prose_verdict.
    """
    items, inside = [], False
    for line in body.splitlines():
        if ANY_FENCE.match(line):
            inside = not inside
            continue
        stripped = line.strip()
        if inside or not stripped or stripped in boilerplate \
                or stripped.startswith("#") or table_cells(stripped) is not None:
            continue
        is_item = bool(LIST_MARKER.match(line))
        continuation = line[:1] in " \t" and not is_item
        if continuation and items and items[-1][0]:
            items[-1][1].append(stripped)
        else:
            items.append((is_item, [stripped]))

    out = []
    for _, parts in items:
        text = " ".join(parts)
        if not HANGUL.search(text) or SHA_TOKEN.search(text) or COMMIT_ITEM.match(text):
            continue
        verdict = prose_verdict(text)
        if verdict:
            out.append((text, verdict))
    return out


def flat_sections(body, boilerplate):
    """(heading, top-level count) for sections whose items are a flat list.

    The rejected body folded its 작업 내역 by commit count -- one full bullet per
    commit, siblings all the way down -- so the reviewer got seven unrelated
    facts instead of a cause with its consequences nested under it. Forward
    reasoning shows up structurally: a root cause at indent 0, the actions it
    forced indented beneath it. A section with MIN_FLAT_ITEMS or more top-level
    Hangul items and nothing nested anywhere has no such structure.

    Continuation lines (indented, no list marker) are not items, so a wrapped
    bullet never passes as nesting.
    """
    sections = [("(본문)", [])]
    inside = False
    for line in body.splitlines():
        if ANY_FENCE.match(line):
            inside = not inside
            continue
        stripped = line.strip()
        if inside or not stripped or stripped in boilerplate:
            continue
        head = HEADING.match(line)
        if head:
            sections.append((head.group(1).strip() or "(본문)", []))
            continue
        if not LIST_MARKER.match(line):
            continue
        tabbed = line.expandtabs(4)
        sections[-1][1].append((len(tabbed) - len(tabbed.lstrip()), stripped))

    out = []
    for heading, items in sections:
        top = [t for depth, t in items if depth == 0 and HANGUL.search(t)]
        nested = [t for depth, t in items if depth > 0]
        if len(top) >= MIN_FLAT_ITEMS and not nested:
            out.append((heading, len(top)))
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

    allow_prose = os.environ.get("PR_BODY_GUARD_ALLOW_PROSE") == "1" \
        or "PR_BODY_GUARD_ALLOW_PROSE=1" in cmd
    if not allow_prose:
        boilerplate = template_lines(cwd)
        prose = prose_lines(body, boilerplate)
        if prose:
            shown = "\n".join("  - %s   (%s)" % (l[:120], why) for l, why in prose[:15])
            decide("deny", (
                "PR body is 서술식, not 개조식 (%d item(s)):\n%s\n"
                "WHY: an arrow chain is read by position. Cut the item at every "
                "connective, let one predicate stand per segment, and put what is "
                "true but not load-bearing in parentheses:\n"
                "  저장소에 vitest 누락 -> pnpm test 실패 -> 도입해 해결 (+ 테스트 환경 표준화)\n"
                "If the prose is deliberate, re-run with PR_BODY_GUARD_ALLOW_PROSE=1 "
                "in front of the command." % (len(prose), shown)
            ))

        flat = flat_sections(body, boilerplate)
        if flat:
            where = ", ".join("(%s: 최상위 %d개, 중첩 0개)" % (h, n) for h, n in flat)
            decide("deny", (
                "PR body is a flat list, not forward reasoning %s:\n"
                "WHY: one of these items caused the rest. Name that root cause, "
                "put it alone at the top level, and indent every action it forced, "
                "so the reviewer reads the cause once and takes its subtree with "
                "it:\n"
                "  - 테스트 러너 없음 -> vitest 구성\n"
                "    - addon-vitest는 Vite 전용 -> webpack 쓰던 nextjs 대신 nextjs-vite로 교체\n"
                "    - 불필요한 playwright가 CI 타임 잡아먹음 -> 로컬 전용으로 격리\n"
                "If the flat list is deliberate, re-run with PR_BODY_GUARD_ALLOW_PROSE=1 "
                "in front of the command." % where
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

    # A 서술식 bullet (~한다) is the incident: it must be flagged.
    assert prose_lines("- pill 컴포넌트를 구현한다", set()) == [("- pill 컴포넌트를 구현한다", "문장 종결")]
    # The 개조식 rewrite of the same bullet passes.
    assert prose_lines("- pill 컴포넌트를 구현함", set()) == []
    # A commit-subject line quotes the work repo's ~한다 subject and is exempt,
    # whether the sha carries a hex letter or is all digits.
    assert prose_lines("3. 795077968 feat: 최근 채팅 pill 컴포넌트를 구현한다", set()) == []
    assert prose_lines("- e1b01069a feat: 채팅 리스트 컴포넌트를 구현한다", set()) == []
    # A wrapped 리뷰 포인트 item is judged by its joined ending, not the wrap point.
    wrapped = ("   - 리뷰 포인트: 창 고정 앵커를 길이가 아닌 머리 행 id로 잡은 이유(포화 시 길이 파생\n"
               "     창은 읽던 행이 밀림, getWindowStart 순수 함수 + 테스트)")
    assert prose_lines(wrapped, set()) == [], prose_lines(wrapped, set())
    # A paragraph sentence (~합니다.) is flagged even without a list marker.
    assert prose_lines("이 PR은 pill 컴포넌트를 추가합니다.", set()) == [("이 PR은 pill 컴포넌트를 추가합니다.", "문장 종결")]
    # Text inside a mermaid fence and a template checklist line are skipped.
    fenced = "```mermaid\nflowchart LR\n A[시작한다] --> B\n```\n- [ ] 변경 후 확인이 필요한 기능을 명시해주세요\n"
    assert prose_lines(fenced, {"- [ ] 변경 후 확인이 필요한 기능을 명시해주세요"}) == []
    # An English-only bullet has no Hangul and is never judged.
    assert prose_lines("- add the pill component", set()) == []
    # A bullet ending in `code` passes even when the code word ends in 다.
    assert prose_lines("- 진입점은 `renderPill다`", set()) == []
    # ~어요 is a sentence ending too.
    assert prose_lines("- 컴포넌트를 추가했어요", set()) == [("- 컴포넌트를 추가했어요", "문장 종결")]

    # The ending check was gamed: 한다→함 with the clauses intact. Each of these
    # chains 2-3 predicates in one segment and must be denied, alone and together.
    gamed = [
        ("- 저장소에 vitest가 없어 pnpm test가 동작하지 않던 상태", 3),
        ("- vitest·storybook 테스트 환경을 도입하고 CI에서 실행되게 함", 2),
        ("- 그동안 아무데서도 실행되지 않던 scripts/*-self-check.mjs 4개를 이 환경으로 이관", 2),
    ]
    for line, n in gamed:
        assert prose_lines(line, set()) == [(line, "절 %d개" % n)], prose_lines(line, set())
    block = "\n".join(l for l, _ in gamed)
    assert [why for _, why in prose_lines(block, set())] == ["절 3개", "절 2개", "절 2개"]
    # The user's rewrite: an arrow chain of noun phrases, one predicate per segment.
    chain = "저장소에 vitest 누락 -> pnpm test 실패 -> 도입해 해결 (+ 테스트 환경 표준화)"
    assert [predicates(s) for s in ARROW.split(chain)] == [0, 0, 1]
    assert prose_lines(chain, set()) == [], prose_lines(chain, set())
    # The two 작업 내역 examples in guides/pr.md stay green (the wrapped one is
    # asserted above): 주입받고 ends in 받고, which is not a listed ending.
    example = ("3. 795077968 feat: 최근 채팅 pill 컴포넌트를 구현한다\n"
               "   - 표현 전용 배지 — 쌓인 개수는 주입받고, 탭 시 꼬리 복귀만 위임\n"
               "4. e1b01069a feat: 채팅 리스트 컴포넌트를 구현한다\n"
               "   - 비반전 Animated.FlatList + 꼬리 500행 상주 창 — 스크롤 핸들러는 UI 스레드\n"
               + wrapped)
    assert prose_lines(example, set()) == [], prose_lines(example, set())
    # Nouns ending in 고/어 are not predicates: the list is explicit, not 고$/어$.
    assert prose_lines("- 재고 언어 제어 정리", set()) == []
    assert predicates("재고 언어 제어 정리") == 0
    # A sentence break mid-item is 서술식 even when the item's own ending is a noun.
    assert prose_lines("- 가드를 추가한다. 이후 정리", set()) == [("- 가드를 추가한다. 이후 정리", "문장 종결")]

    # The incident: 작업 내역 as one flat bullet per commit, 7 siblings, every one
    # valid 개조식 -- rejected three times, so the prose check alone misses it.
    flat7 = "\n".join([
        "## 작업 내역",
        "- 테스트 러너 없음 -> vitest 구성",
        "- addon-vitest는 Vite 전용 -> nextjs-vite로 교체",
        "- jest 계열 의존성 제거",
        "- happy-dom 사용 및 코드 정리",
        "- 테스트 코드 타입 검사 추가",
        "- playwright 로컬 전용으로 격리",
        "- 기존 self-check 스크립트 마이그레이션",
    ])
    assert prose_lines(flat7, set()) == [], prose_lines(flat7, set())
    assert flat_sections(flat7, set()) == [("작업 내역", 7)], flat_sections(flat7, set())
    # The user's corrected form -- one root cause with its actions nested -- passes.
    nested = "\n".join([
        "## 작업 내역",
        "- 테스트 러너 없음 -> vitest 구성",
        "  - addon-vitest는 Vite 전용 -> webpack 쓰던 nextjs 대신 nextjs-vite로 교체",
        "  - jest 계열 의존성 제거 -> happy-dom 사용 및 코드 정리",
        "  - 테스트 코드 타입 검사 추가",
        "  - 불필요한 playwright가 CI 타임 잡아먹음 -> 로컬 전용으로 격리 (unit + storybook 2 프로젝트 구성)",
        "  - 기존 *-self-check.mjs 마이그레이션",
    ])
    assert flat_sections(nested, set()) == [], flat_sections(nested, set())
    # Under the threshold a flat list still reads as a list, so 4 siblings pass.
    four = "## 작업 내역\n- 가드 추가\n- 훅 등록\n- 문서 갱신\n- 자기검사 보강"
    assert flat_sections(four, set()) == [], flat_sections(four, set())
    # Diagram lines inside a fence are not list items and must not be counted.
    fenced_flat = ("## 개요\n```mermaid\nflowchart LR\n A --> B\n```\n"
                   "- 가드 추가\n- 훅 등록\n- 문서 갱신")
    assert flat_sections(fenced_flat, set()) == [], flat_sections(fenced_flat, set())
    fenced_dash = "## 개요\n```mermaid\n- 하나\n- 둘\n- 셋\n- 넷\n- 다섯\n- 여섯\n```"
    assert flat_sections(fenced_dash, set()) == [], flat_sections(fenced_dash, set())
    # The 작업 내역 example in guides/pr.md is numbered + sub-bulleted: still green.
    assert flat_sections(example, set()) == [], flat_sections(example, set())
    # A heading-less body is one section, reported as (본문).
    headless = "\n".join("- 항목 %d" % i for i in range(6))
    assert flat_sections(headless, set()) == [("(본문)", 6)], flat_sections(headless, set())
    # Template checklist lines are boilerplate, not the author's flat list.
    boiler_body = "## 변경 체크리스트\n" + "\n".join(["- [ ] 변경 후 확인이 필요한 기능을 명시해주세요"] * 6)
    assert flat_sections(boiler_body, {"- [ ] 변경 후 확인이 필요한 기능을 명시해주세요"}) == []

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
