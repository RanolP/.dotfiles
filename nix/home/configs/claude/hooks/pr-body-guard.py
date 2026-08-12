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
2. `gh pr create|edit` with a body: every ```mermaid fence passes a structural
   lint (known diagram type, no `<br>` inside a markdown-string label, balanced
   quotes and brackets). When `mmdc` happens to be on PATH the real parser runs
   too; it is optional and never installed on demand.

Escape hatch: prefix the command with `PR_BODY_GUARD_ALLOW_DROP=1` when the drop
is deliberate. The deny exists to make the dropped lines visible first, not to
freeze a body forever.

Fail open on anything unexpected -- this guard must never make `gh` unusable.
"""
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


def dropped_lines(remote, new, boilerplate):
    kept = {l.strip() for l in new.splitlines()}
    out = []
    for raw in remote.splitlines():
        line = raw.strip()
        if len(line) < 4 or line in boilerplate or line in kept:
            continue
        out.append(line)
    return out


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
        shown = "\n".join("  - " + l[:120] for l in dropped[:15])
        more = "\n  ... and %d more" % (len(dropped) - 15) if len(dropped) > 15 else ""
        decide("deny", (
            "This `gh pr edit` drops %d line(s) that exist in the remote PR body:\n%s%s\n\n"
            "Read the remote body first (`gh pr view --json body -q .body`), edit THAT "
            "text, and write the result back. Hand-added rows and columns live only on "
            "the remote.\nIf the drop is deliberate, re-run with "
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
