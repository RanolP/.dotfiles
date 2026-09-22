#!/usr/bin/env python3
"""PreToolUse guard: a commit to one of the user's public repos carries no secret and no private-organisation identifier.

A rule in prose is self-policed, so the check sits on the commit.

Scope is deliberately narrow: the guard fires only on a `git commit` whose
repository's `origin` points at `github.com/RanolP/` -- the user's personal
public repos. A work repo's commits are that employer's business and pass
untouched.

The hook fires BEFORE the command runs, so `git add X && git commit` would show
it an empty index. The scan therefore covers what the chain WILL commit: the
staged diff always, plus -- when the same chain stages earlier or the commit
carries `-a`/`--all` -- the unstaged tracked diff and the content of every
untracked file the `git add` arguments name.

Two pattern sources scan the ADDED lines of those diffs (`-U0`, `+` lines):

  1. built-in secret / identifier shapes -- Slack tokens, GitHub PATs, OpenAI
     keys, AWS access keys, PEM private keys, JWTs, Slack archive URLs, Slack
     channel and thread IDs;
  2. a private denylist at `~/.config/leak-guard/denylist` (override with
     `LEAK_GUARD_DENYLIST`): one case-insensitive regex per line, `#` comments
     and blank lines ignored, an invalid regex skipped. The organisation names
     live THERE, outside the repo, because the file that lists what must not
     be published cannot itself be published.

Escape hatch for a deliberate false positive: `LEAK_GUARD_ALLOW=1 git commit ...`.

Parsing reuses `commit-check-guard.py`'s single-pass, O(n), quote-aware
tokenizer. Never a backtracking regex over the whole command: `git-push-guard.py`
once ReDoSed for minutes on a long quoted command and hung every Bash call.

Fail open, always. This runs in front of every Bash call in every session, so a
missing git, an unresolvable repo, a subprocess timeout (10s), unreadable input
or any exception allows the call. A false deny costs more than a missed match.

Self-check: `python3 leak-guard.py --selftest`; sibling: `python3 scripts/leak-guard-test.py`.
"""
import json
import os
import re
import shutil
import subprocess
import sys

WRAPPERS = {"sudo", "command", "env", "nohup", "nice", "time", "doas", "exec"}
GIT_OPTS_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

ALLOW_ENV = "LEAK_GUARD_ALLOW"
DENYLIST_ENV = "LEAK_GUARD_DENYLIST"
DENYLIST_DEFAULT = os.path.join("~", ".config", "leak-guard", "denylist")
GIT_TIMEOUT_S = 10
MAX_HITS = 10
# A staging step in the same chain makes the guard read the working tree, so
# both are capped: a huge untracked tree must not stall the hook.
MAX_UNTRACKED_FILES = 50
MAX_FILE_BYTES = 256 * 1024

ORIGIN_RE = re.compile(r"github\.com[:/]RanolP/", re.IGNORECASE)

BUILTIN_PATTERNS = [
    ("slack token", re.compile(r"xox[abposer]-[A-Za-z0-9-]+")),
    ("github token", re.compile(r"ghp_[A-Za-z0-9]{20,}")),
    ("github fine-grained token", re.compile(r"github_pat" "_")),
    ("openai key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("aws access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("slack archive url", re.compile(r"https?://[a-z0-9-]+\.slack\.com/archives/")),
    ("slack channel id", re.compile(r"\b[CDG]0[A-Z0-9]{8,}\b")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.")),
]

HOW_TO_FIX = (
    "Replace each with a placeholder in angle brackets -- "
    "`<workspace>.slack.com/archives/<channel>/<ts>`, `<CARD-KEY>`, `<org>`, `<app>`, "
    "`'<your-ui-kit>'` -- and re-stage. This repository is public. "
    "For a deliberate false positive, prefix the command with `%s=1`." % ALLOW_ENV
)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def parse_segments(command):
    """Single-pass, O(n) split of a shell command into operator-separated
    segments of whitespace-separated tokens (copied from commit-check-guard.py).

    Quote characters are consumed; `&& || ; & |` split only outside quotes.
    Never backtracks, so it cannot ReDoS. parse_error marks an unterminated
    quote so the caller can fail open on that segment.
    """
    segments = []
    tokens = []
    tok = []
    tok_started = False
    seg_error = False

    def flush_token():
        nonlocal tok, tok_started
        if tok_started:
            tokens.append("".join(tok))
        tok = []
        tok_started = False

    def flush_segment():
        nonlocal tokens, seg_error
        flush_token()
        segments.append({"tokens": tokens, "parse_error": seg_error})
        tokens = []
        seg_error = False

    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "'":
            tok_started = True
            i += 1
            while i < n and command[i] != "'":
                tok.append(command[i])
                i += 1
            if i >= n:
                seg_error = True
            else:
                i += 1
            continue
        if c == '"':
            tok_started = True
            i += 1
            while i < n and command[i] != '"':
                if command[i] == "\\" and i + 1 < n and command[i + 1] in ('"', "\\", "$", "`"):
                    tok.append(command[i + 1])
                    i += 2
                else:
                    tok.append(command[i])
                    i += 1
            if i >= n:
                seg_error = True
            else:
                i += 1
            continue
        if c == "\\":
            tok_started = True
            if i + 1 < n:
                tok.append(command[i + 1])
                i += 2
            else:
                tok.append(c)
                i += 1
            continue
        if c in " \t\n\r":
            flush_token()
            i += 1
            continue
        if command[i:i + 2] in ("&&", "||"):
            flush_segment()
            i += 2
            continue
        if c in (";", "&", "|"):
            flush_segment()
            i += 1
            continue
        tok_started = True
        tok.append(c)
        i += 1

    flush_segment()
    return segments


def _is_name_char(ch):
    return ch == "_" or ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or ("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


def base(tok):
    return tok.rsplit("/", 1)[-1]


def strip_prefix(toks):
    """Drop env assignments and wrappers; returns (assignments, remaining tokens)."""
    assigns = []
    i = 0
    while i < len(toks):
        if is_env_assign(toks[i]):
            assigns.append(toks[i])
            i += 1
            continue
        if base(toks[i]) in WRAPPERS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
            continue
        break
    return assigns, toks[i:]


def commit_spec(toks):
    """None when the segment is not a `git commit`; else
    {"c_path": str|None, "all": bool, "allow": bool}."""
    assigns, toks = strip_prefix(toks)
    if not toks or base(toks[0]) != "git":
        return None
    c_path = None
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in GIT_OPTS_WITH_ARG:
            if t == "-C" and i + 1 < len(toks):
                c_path = toks[i + 1]
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        if t != "commit":
            return None
        break
    else:
        return None
    args = toks[i + 1:]
    all_flag = False
    for a in args:
        if a == "--":
            break
        if a in ("-a", "--all"):
            all_flag = True
        elif a.startswith("-") and not a.startswith("--"):
            # -am, -qa: a bundled short flag. A letter that takes a value
            # (-m<msg>, -F<file>, ...) swallows the rest of the bundle.
            for ch in a[1:]:
                if ch == "a":
                    all_flag = True
                elif ch in "mFcCtS":
                    break
    allow = any(a == ALLOW_ENV + "=1" for a in assigns)
    return {"c_path": c_path, "all": all_flag, "allow": allow}


def git_subcommand(toks):
    """(subcommand, args) for a `git` invocation, or None."""
    _, toks = strip_prefix(toks)
    if not toks or base(toks[0]) != "git":
        return None
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in GIT_OPTS_WITH_ARG:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return toks[i], toks[i + 1:]
    return None


def staging_spec(toks):
    """None when the segment stages nothing; else {"add_all": bool, "paths": [str]}.

    `git add` / `git stage` / `git rm --cached`. `git reset` unstages, so it
    contributes nothing by itself -- the `git add` that follows it is what the
    chain stages with.
    """
    sub = git_subcommand(toks)
    if sub is None:
        return None
    name, args = sub
    if name not in ("add", "stage", "rm"):
        return None
    if name == "rm" and "--cached" not in args:
        return None
    paths = []
    add_all = False
    after_dashdash = False
    for a in args:
        if not after_dashdash:
            if a == "--":
                after_dashdash = True
                continue
            if a.startswith("--"):
                if a in ("--all", "--update", "--no-ignore-removal"):
                    add_all = True
                continue
            if a.startswith("-") and len(a) > 1:
                if any(ch in "Au" for ch in a[1:]):
                    add_all = True
                continue
        if a.rstrip("/") in (".", ""):
            add_all = True
            continue
        paths.append(a)
    return {"add_all": add_all, "paths": paths}


def find_commits(command):
    """Commit specs in chain order; each carries the staging its own chain does
    before it, so the scan can cover what the command WILL commit."""
    specs = []
    staged_here = False
    stage_all = False
    staged_paths = []
    for seg in parse_segments(command):
        if seg["parse_error"]:
            continue
        spec = commit_spec(seg["tokens"])
        if spec is not None:
            spec["staged_here"] = staged_here
            spec["stage_all"] = stage_all
            spec["paths"] = list(staged_paths)
            specs.append(spec)
            continue
        staging = staging_spec(seg["tokens"])
        if staging is not None:
            staged_here = True
            stage_all = stage_all or staging["add_all"]
            staged_paths += staging["paths"]
    return specs


def load_denylist(path):
    """Compiled (name, regex) pairs from the private denylist; [] when absent."""
    patterns = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    patterns.append(("denylist", re.compile(line, re.IGNORECASE)))
                except re.error:
                    continue
    except OSError:
        pass
    return patterns


def denylist_path():
    override = os.environ.get(DENYLIST_ENV)
    return override if override else os.path.expanduser(DENYLIST_DEFAULT)


def added_lines(diff):
    """Yields (file, lineno, text) for every `+` line of a `-U0` unified diff."""
    path = None
    lineno = 0
    prev_minus_header = False
    for line in diff.splitlines():
        if line.startswith("--- "):
            prev_minus_header = True
            continue
        if prev_minus_header and line.startswith("+++ "):
            prev_minus_header = False
            name = line[4:]
            if name.startswith("b/"):
                name = name[2:]
            path = None if name == "/dev/null" else name
            continue
        prev_minus_header = False
        if line.startswith("@@"):
            m = re.match(r"@@ -\S+ \+(\d+)", line)
            lineno = int(m.group(1)) if m else 0
            continue
        if line.startswith("+"):
            yield (path or "?", lineno, line[1:])
            lineno += 1
        elif line.startswith("-") or line.startswith("\\"):
            continue
        else:
            lineno += 1


def scan(diff, patterns):
    """Up to MAX_HITS (file, lineno, matched text, pattern name) tuples."""
    hits = []
    for path, lineno, text in added_lines(diff):
        for name, rx in patterns:
            m = rx.search(text)
            if m:
                hits.append((path, lineno, m.group(0), name))
                if len(hits) >= MAX_HITS:
                    return hits
                break
    return hits


def path_selected(rel, paths):
    """True when `git add <paths>` would stage the repo-relative file `rel`."""
    for p in paths:
        # Only a literal `./` prefix is dropped, never a leading dot: a
        # character-class strip would turn `.env` into `env` and never match.
        while p.startswith("./"):
            p = p[2:]
        p = p.rstrip("/")
        if p in ("", "."):
            return True
        if rel == p or rel.startswith(p + "/"):
            return True
    return False


def untracked_diff(repo, paths, add_all):
    """A pseudo `-U0` diff of the untracked files `git add` would stage, so the
    same scanner sees them. Capped at MAX_UNTRACKED_FILES files and
    MAX_FILE_BYTES per file: over the cap, what fits is scanned and the rest
    allowed."""
    if not add_all and not paths:
        return ""
    out = git(repo, "status", "--porcelain", "-z", "-uall", "--no-renames")
    if not out:
        return ""
    chunks = []
    for entry in out.split("\0"):
        if len(entry) < 4 or entry[:2] != "??":
            continue
        rel = entry[3:]
        if not add_all and not path_selected(rel, paths):
            continue
        try:
            with open(os.path.join(repo, rel), "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read(MAX_FILE_BYTES)
        except OSError:
            continue
        lines = text.splitlines()
        if not lines:
            continue
        chunks.append("--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n%s"
                      % (rel, len(lines), "\n".join("+" + l for l in lines)))
        if len(chunks) >= MAX_UNTRACKED_FILES:
            break
    return "\n".join(chunks)


def git(repo, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    p = subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True,
                       timeout=GIT_TIMEOUT_S, env=env, errors="replace")
    if p.returncode != 0:
        return None
    return p.stdout


def evaluate(data):
    """The deny reason for this hook input, or None to allow."""
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return None
    specs = find_commits(command)
    if not specs:
        return None
    if os.environ.get(ALLOW_ENV) == "1" or any(s["allow"] for s in specs):
        return None
    if shutil.which("git") is None:
        return None
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()

    patterns = BUILTIN_PATTERNS + load_denylist(denylist_path())
    hits = []
    seen = set()
    for spec in specs:
        repo = os.path.join(cwd, os.path.expanduser(spec["c_path"])) if spec["c_path"] else cwd
        repo = os.path.normpath(repo)
        key = (repo, spec["all"], spec["staged_here"], spec["stage_all"], tuple(spec["paths"]))
        if key in seen:
            continue
        seen.add(key)
        if not os.path.isdir(repo):
            continue
        origin = git(repo, "remote", "get-url", "origin")
        if origin is None or not ORIGIN_RE.search(origin):
            continue
        diff = git(repo, "diff", "--cached", "-U0", "--no-color", "--no-ext-diff")
        if diff is None:
            continue
        if spec["all"] or spec["staged_here"]:
            unstaged = git(repo, "diff", "-U0", "--no-color", "--no-ext-diff")
            if unstaged:
                diff += "\n" + unstaged
        if spec["staged_here"]:
            # `-a` never stages an untracked file; an explicit `git add` does.
            untracked = untracked_diff(repo, spec["paths"], spec["stage_all"])
            if untracked:
                diff += "\n" + untracked
        hits += scan(diff, patterns)
        if len(hits) >= MAX_HITS:
            hits = hits[:MAX_HITS]
            break
    if not hits:
        return None
    lines = ["%s:%d: %s (%s)" % h for h in hits]
    return ("This commit would publish a secret or a private identifier to a public "
            "RanolP repo:\n  " + "\n  ".join(lines) + "\n" + HOW_TO_FIX)


def main():
    data = json.load(sys.stdin)
    reason = evaluate(data)
    if reason is not None:
        decide("deny", reason)


# --- self-test --------------------------------------------------------------

# Fixtures are assembled from pieces so this file's own diff never trips the
# guard when it is committed to this (public, RanolP/) repo.
CHANNEL = "C0" "123ABCDEF"
SLACK_URL = "https://acme.slack" ".com/archives/" + CHANNEL + "/p1700000000"


def _selftest():
    import tempfile

    failures = []

    def check(name, ok):
        failures.append(name) if not ok else None
        print("%s  %s" % ("ok  " if ok else "FAIL", name))

    # pure matcher
    built = BUILTIN_PATTERNS
    diff_of = lambda *lines: "--- a/f\n+++ b/f\n@@ -0,0 +1,%d @@\n" % len(lines) + "\n".join("+" + l for l in lines)
    hits = scan(diff_of("see " + SLACK_URL), built)
    check("slack url + channel id hit", [h[3] for h in hits] == ["slack archive url"])
    check("hit names file and line", hits and hits[0][0] == "f" and hits[0][1] == 1)
    check("slack channel id alone", scan(diff_of("channel " + CHANNEL), built)[0][3] == "slack channel id")
    check("github pat", scan(diff_of("ghp_" + "a" * 36), built)[0][3] == "github token")
    check("aws key", scan(diff_of("AKIA" "ABCDEFGHIJKLMNOP"), built)[0][3] == "aws access key")
    check("private key", scan(diff_of("-----BEGIN RSA " "PRIVATE KEY-----"), built)[0][3] == "private key")
    check("jwt", scan(diff_of("eyJ" + "a" * 30 + "." + "b" * 20 + ".c"), built)[0][3] == "jwt")
    check("atlassian public names pass",
          scan(diff_of("@atlaskit/adf-schema", "https://mcp.atlassian.com/v1/sse"), built) == [])
    check("removed lines are not scanned",
          scan("--- a/f\n+++ b/f\n@@ -1 +0,0 @@\n-" + SLACK_URL, built) == [])
    check("hits capped at %d" % MAX_HITS,
          len(scan(diff_of(*["ghp_" + "a" * 36] * 30), built)) == MAX_HITS)

    # denylist
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("# comment\n\nacme[- ]?corp\n(unclosed\nPROJ-\\d+\n")
        dl = fh.name
    try:
        pats = load_denylist(dl)
        check("denylist skips comments, blanks and invalid regex", len(pats) == 2)
        check("denylist is case-insensitive",
              scan(diff_of("ACME Corp"), pats)[0][2] == "ACME Corp")
        check("denylist card key", scan(diff_of("see PROJ-1234"), pats)[0][3] == "denylist")
    finally:
        os.unlink(dl)
    check("missing denylist is empty", load_denylist("/nonexistent/leak-guard/denylist") == [])

    # command parsing
    plain = find_commits("git commit -m x")
    check("plain commit", len(plain) == 1 and plain[0]["c_path"] is None
          and plain[0]["all"] is False and plain[0]["allow"] is False
          and plain[0]["staged_here"] is False)
    check("-C path", find_commits("git -C /r commit -m x")[0]["c_path"] == "/r")
    check("chain + wrapper", find_commits("git add -A && sudo git commit -am x")[0]["all"] is True)

    # staging earlier in the same chain (the compound-command bypass)
    chained = find_commits("git add docs/a.md && git commit -m x")[0]
    check("chain add marks staged_here", chained["staged_here"] is True)
    check("chain add records the path", chained["paths"] == ["docs/a.md"])
    check("chain add -A marks stage_all",
          find_commits("git add -A && git commit -m x")[0]["stage_all"] is True)
    check("chain add . marks stage_all",
          find_commits("git add . ; git commit -m x")[0]["stage_all"] is True)
    check("bare . is add_all, not a literal path",
          staging_spec(["git", "add", "."]) == {"add_all": True, "paths": []})
    check("./ is add_all, not a literal path",
          staging_spec(["git", "add", "./"]) == {"add_all": True, "paths": []})
    check("a dot-prefixed path stays a path",
          staging_spec(["git", "add", ".env"]) == {"add_all": False, "paths": [".env"]})

    # path selection keeps the leading dot
    check("dotfile selected by its own name", path_selected(".env", [".env"]) is True)
    check("dotfile selected via ./ prefix", path_selected(".env", ["./.env"]) is True)
    check("dot directory selects its children",
          path_selected(".aws/credentials", [".aws"]) is True)
    check("dotfile not selected by a sibling", path_selected(".env", ["env"]) is False)
    check("plain path still selected", path_selected("docs/a.md", ["docs"]) is True)
    check("chain reset then add",
          find_commits("git reset -q && git add d && git commit -q -F -")[0]["paths"] == ["d"])
    check("rm --cached counts as staging",
          find_commits("git rm --cached f && git commit -m x")[0]["staged_here"] is True)
    check("rm without --cached is not staging",
          find_commits("git rm f && git commit -m x")[0]["staged_here"] is False)
    check("staging after the commit does not count",
          find_commits("git commit -m x && git add y")[0]["staged_here"] is False)
    check("--all", find_commits("git commit --all -m x")[0]["all"] is True)
    check("allow prefix", find_commits("LEAK_GUARD_ALLOW=1 git commit -m x")[0]["allow"] is True)
    check("not a commit", find_commits("git status; git add x") == [])
    check("commit inside quotes", find_commits("echo 'git commit -m x'") == [])
    check("unterminated quote fails open", find_commits("git commit -m 'x") == [])

    # integration with a real repo
    if shutil.which("git") is None:
        print("skip  git not on PATH: integration cases skipped")
    else:
        _selftest_git(check, tempfile)

    print("%d failure(s)" % len(failures))
    return 1 if failures else 0


def _selftest_git(check, tempfile):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@t")
    env.pop(ALLOW_ENV, None)
    env[DENYLIST_ENV] = "/nonexistent/leak-guard/denylist"
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)

    def sh(repo, *args):
        subprocess.run(["git", "-C", repo] + list(args), check=True, capture_output=True, timeout=30)

    def payload(repo, command):
        return {"tool_name": "Bash", "cwd": repo, "tool_input": {"command": command}}

    def make_repo(root, origin):
        repo = os.path.join(root, "repo")
        os.makedirs(repo)
        sh(repo, "init", "-q")
        sh(repo, "remote", "add", "origin", origin)
        with open(os.path.join(repo, "doc.md"), "w") as fh:
            fh.write("clean\n")
        sh(repo, "add", "doc.md")
        sh(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
        return repo

    def stage(repo, text):
        with open(os.path.join(repo, "doc.md"), "a") as fh:
            fh.write(text + "\n")
        sh(repo, "add", "doc.md")

    try:
        with tempfile.TemporaryDirectory() as root:
            repo = make_repo(root, "git@github.com:RanolP/x.git")
            stage(repo, "thread: " + SLACK_URL)
            reason = evaluate(payload(repo, "git commit -m x"))
            check("staged slack url denied", reason is not None and "doc.md:2:" in reason)
            check("deny reason names the fix", reason is not None and "<workspace>.slack.com" in reason)
            check("LEAK_GUARD_ALLOW=1 allowed",
                  evaluate(payload(repo, "LEAK_GUARD_ALLOW=1 git commit -m x")) is None)
            check("non-commit allowed", evaluate(payload(repo, "git status")) is None)
            check("-C from another cwd denied",
                  evaluate({"tool_name": "Bash", "cwd": root,
                            "tool_input": {"command": "git -C repo commit -m x"}}) is not None)
            sh(repo, "reset", "-q", "--hard")
            stage(repo, "uses @atlaskit/adf-schema and https://mcp.atlassian.com/v1/sse")
            check("atlassian public names allowed", evaluate(payload(repo, "git commit -m x")) is None)

            with open(os.path.join(root, "denylist"), "w") as fh:
                fh.write("acme[- ]?corp\n")
            os.environ[DENYLIST_ENV] = os.path.join(root, "denylist")
            sh(repo, "reset", "-q", "--hard")
            stage(repo, "built at Acme Corp")
            reason = evaluate(payload(repo, "git commit -m x"))
            check("denylist match denied", reason is not None and "(denylist)" in reason)
            os.environ[DENYLIST_ENV] = "/nonexistent/leak-guard/denylist"

            sh(repo, "reset", "-q", "--hard")
            with open(os.path.join(repo, "doc.md"), "a") as fh:
                fh.write("ghp_" + "a" * 36 + "\n")
            check("unstaged secret, plain commit allowed",
                  evaluate(payload(repo, "git commit -m x")) is None)
            check("unstaged secret, commit -a denied",
                  evaluate(payload(repo, "git commit -am x")) is not None)

            # the compound-command bypass: stage and commit in ONE call
            sh(repo, "reset", "-q", "--hard")
            with open(os.path.join(repo, "doc.md"), "a") as fh:
                fh.write("thread: " + SLACK_URL + "\n")
            reason = evaluate(payload(repo, "git add doc.md && git commit -q -m x"))
            check("chained add + commit denied", reason is not None and "doc.md:" in reason)
            check("chained add + commit -am denied",
                  evaluate(payload(repo, "git reset -q && git add doc.md && git commit -qam x"))
                  is not None)
            sh(repo, "reset", "-q", "--hard")

            os.makedirs(os.path.join(repo, "notes"))
            with open(os.path.join(repo, "notes", "new.md"), "w") as fh:
                fh.write("thread: " + SLACK_URL + "\n")
            reason = evaluate(payload(repo, "git add notes && git commit -q -m x"))
            check("untracked file under an added directory denied",
                  reason is not None and "notes/new.md:1:" in reason)
            check("untracked file swept by git add -A denied",
                  evaluate(payload(repo, "git add -A && git commit -q -m x")) is not None)
            check("untracked file outside the added path allowed",
                  evaluate(payload(repo, "git add doc.md && git commit -q -m x")) is None)
            check("untracked file, plain commit allowed",
                  evaluate(payload(repo, "git commit -q -m x")) is None)
            with open(os.path.join(repo, "notes", "new.md"), "w") as fh:
                fh.write("nothing secret here\n")
            check("clean untracked file, chained add allowed",
                  evaluate(payload(repo, "git add notes && git commit -q -m x")) is None)

            # a leaked credential lives in a dot-prefixed file more often than not
            with open(os.path.join(repo, ".env"), "w") as fh:
                fh.write("OPENAI_API_KEY=" + "sk-" + "a" * 32 + "\n")
            reason = evaluate(payload(repo, "git add .env && git commit -q -m x"))
            check("untracked .env named explicitly denied",
                  reason is not None and ".env:1:" in reason)
            check("untracked .env via ./ prefix denied",
                  evaluate(payload(repo, "git add ./.env && git commit -q -m x")) is not None)
            os.makedirs(os.path.join(repo, ".secrets"))
            with open(os.path.join(repo, ".secrets", "token"), "w") as fh:
                fh.write("ghp_" + "b" * 36 + "\n")
            reason = evaluate(payload(repo, "git add .secrets && git commit -q -m x"))
            check("untracked file under a dot directory denied",
                  reason is not None and ".secrets/token:1:" in reason)

        with tempfile.TemporaryDirectory() as root:
            repo = make_repo(root, "git@github.com:other-org/x.git")
            stage(repo, SLACK_URL)
            check("non-RanolP origin allowed", evaluate(payload(repo, "git commit -m x")) is None)

        with tempfile.TemporaryDirectory() as root:
            check("not a git repo allowed",
                  evaluate(payload(root, "git commit -m x")) is None)
    finally:
        os.environ.clear()
        os.environ.update(saved)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(_selftest())
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        pass
    sys.exit(0)
