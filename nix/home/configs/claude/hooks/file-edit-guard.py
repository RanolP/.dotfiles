#!/usr/bin/env python3
"""PreToolUse guard: deny in-place edits of existing source files made through Bash.

Incident: a three-day transcript audit counted 414 `python3`-script edits at a
2.45s median (31.7 minutes of wall clock) and 33 `sed -i` edits at a 2.60s
median, against 88 `Edit` calls at a 0.11s median. The shell route is ~22x
slower per call and pays for it twice -- once in latency, once in the throwaway
script text that has to be written into the prompt. Both routes produce the same
bytes on disk, so the shell route buys nothing.

So this hook denies the shell route for the ONE case where Edit/Write is a
drop-in replacement: a single already-existing file being rewritten in place. It
recognises `sed -i`, `perl -i`, a python `-c`/heredoc body that both names a path
and calls a write API, `cat >`/`tee`, and plain `>`/`>>` redirection.

Fail-open everywhere else, because a false deny costs more than a missed edit:
  * the target does not exist (creating a file is not an in-place edit)
  * the target lives under a temp/scratch root, /dev/, .git/, node_modules/,
    dist/, build/, .next/ or target/, or is a *.log
  * no resolvable path shows up at all
  * ANY parse problem -- an unterminated quote, an unreadable payload, an
    unexpected exception

Parsing is the single-pass, O(n), quote-aware tokenizer that `git-push-guard.py`
uses (that hook was rewritten after a quote-blind regex ReDoS'd and hung every
single Bash call for minutes). Nothing here backtracks, and every regex applied
to a script body has a bounded quantifier. Budget: under 40ms for a 10KB command.

Self-check: `python3 file-edit-guard.py --selftest`.
"""
import json
import os
import re
import sys

# Roots where a rewrite is throwaway work that Edit/Write has no business doing.
TEMP_PREFIXES = ("/tmp/", "/private/tmp/", "/var/folders/", "/dev/")
TEMP_EXACT = ("/tmp", "/private/tmp", "/dev/null")
SCRATCH_MARKER = "/scratchpad/"

# Path segments whose contents are generated, vendored, or VCS internals.
EXCLUDED_SEGMENTS = frozenset({".git", "node_modules", "dist", "build", ".next", "target"})

# A log is append-only by nature; Edit is the wrong tool for it anywhere.
ALLOWED_SUFFIXES = (".log",)

def reason_for(path):
    return (
        f"Editing {path} through Bash costs ~2.45s median; the Edit tool does the "
        "same replacement in ~0.11s and cannot typo the surrounding lines. Use Edit "
        f"(exact string replacement) or Write (whole-file replacement) on {path}, "
        "or, when the work genuinely has to stay in the shell, "
        f"`fast-apply {path} --old '...' --new '...'` -- it does the same "
        "exactly-one-match replacement locally and refuses loudly on zero or "
        "ambiguous matches. If this needs a real shell sweep (a generated file, a "
        "bulk pass across many files, a build artifact), say so in one line and "
        "re-run -- this guard only fires on a single existing source file."
    )


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


# --------------------------------------------------------------------------- #
# Lexer: one pass, quote-aware, never backtracks.
# --------------------------------------------------------------------------- #

def lex(command):
    """Split a shell command into operator-separated segments.

    Each segment is {"tokens": [...], "redirects": [(op, target)],
    "heredocs": [body, ...], "parse_error": bool}. Quotes are consumed the way
    `shlex.split` consumes them, so a `>` or a path inside a quoted string never
    reads as a redirect. Heredoc bodies are lifted out of the stream whole and
    attached to the segment that opened them.
    """
    segments = []
    tokens, redirects, heredocs = [], [], []
    tok, tok_started, seg_error = [], False, False
    pending_redirect = None
    pending_heredocs = []  # [(delimiter, strip_tabs)]

    def flush_token():
        nonlocal tok, tok_started, pending_redirect
        if tok_started:
            value = "".join(tok)
            if pending_redirect is not None:
                redirects.append((pending_redirect, value))
                pending_redirect = None
            else:
                tokens.append(value)
        tok, tok_started = [], False

    def flush_segment():
        nonlocal tokens, redirects, heredocs, seg_error, pending_redirect
        flush_token()
        pending_redirect = None
        if tokens or redirects or heredocs:
            segments.append({"tokens": tokens, "redirects": redirects,
                             "heredocs": heredocs, "parse_error": seg_error})
        tokens, redirects, heredocs = [], [], []
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
            if i + 1 < n and command[i + 1] == "\n":
                i += 2  # line continuation
                continue
            tok_started = True
            if i + 1 < n:
                tok.append(command[i + 1])
                i += 2
            else:
                tok.append(c)
                i += 1
            continue

        if c == "\n":
            flush_token()
            if pending_heredocs:
                i, bodies, err = read_heredocs(command, i + 1, pending_heredocs)
                heredocs.extend(bodies)
                seg_error = seg_error or err
                pending_heredocs = []
            else:
                i += 1
            flush_segment()
            continue

        if c in " \t\r":
            flush_token()
            i += 1
            continue

        # Heredoc opener, checked before the `<` / operator branches.
        if command[i:i + 2] == "<<" and command[i:i + 3] != "<<<":
            flush_token()
            j = i + 2
            strip_tabs = False
            if j < n and command[j] == "-":
                strip_tabs = True
                j += 1
            while j < n and command[j] in " \t":
                j += 1
            delim, j, err = read_delimiter(command, j)
            seg_error = seg_error or err
            if delim:
                pending_heredocs.append((delim, strip_tabs))
            i = j
            continue

        if command[i:i + 2] == "&>":
            flush_token()
            pending_redirect = ">"
            i += 2
            continue

        if c == ">":
            # A bare fd prefix (`2>`, `1>>`) is not part of the target.
            if tok_started and "".join(tok).isdigit():
                tok, tok_started = [], False
            flush_token()
            if command[i:i + 2] == ">>":
                pending_redirect = ">>"
                i += 2
            else:
                pending_redirect = ">"
                i += 1
            # `>&1` / `>&2` duplicate a descriptor; there is no file target.
            if i < n and command[i] == "&":
                pending_redirect = None
                i += 1
                while i < n and command[i].isdigit():
                    i += 1
            continue

        if c == "<":
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

    flush_token()
    if pending_heredocs:
        seg_error = True  # opener with no body before EOF
    flush_segment()
    return segments


def read_delimiter(command, j):
    """Read a heredoc delimiter starting at j. Returns (delim, next_index, error)."""
    n = len(command)
    if j < n and command[j] in ("'", '"'):
        quote = command[j]
        j += 1
        start = j
        while j < n and command[j] != quote:
            j += 1
        if j >= n:
            return "", j, True
        return command[start:j], j + 1, False
    start = j
    while j < n and command[j] not in " \t\n\r;&|<>":
        j += 1
    delim = command[start:j].replace("\\", "")
    return delim, j, not delim


def read_heredocs(command, pos, pending):
    """Consume the bodies of every heredoc opened on the finished line.

    Returns (index just past the last terminator, [body, ...], error).
    """
    bodies = []
    n = len(command)
    for delim, strip_tabs in pending:
        lines = []
        closed = False
        while pos < n:
            end = command.find("\n", pos)
            if end == -1:
                line, next_pos = command[pos:], n
            else:
                line, next_pos = command[pos:end], end + 1
            candidate = line.lstrip("\t") if strip_tabs else line
            pos = next_pos
            if candidate.rstrip("\r") == delim:
                closed = True
                break
            lines.append(line)
        bodies.append("\n".join(lines))
        if not closed:
            return pos, bodies, True
    return pos, bodies, False


# --------------------------------------------------------------------------- #
# Path classification
# --------------------------------------------------------------------------- #

def resolve(candidate, cwd):
    if not candidate or candidate.startswith("&"):
        return ""
    if any(ch in candidate for ch in "$*?\n"):
        return ""  # unexpanded variable or glob -- cannot know the real target
    p = os.path.expanduser(candidate)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.normpath(p)


def is_guarded_target(candidate, cwd):
    """True only for an existing regular file that Edit/Write should own."""
    p = resolve(candidate, cwd)
    if not p or not os.path.isfile(p):
        return False
    if p in TEMP_EXACT or p.startswith(TEMP_PREFIXES) or SCRATCH_MARKER in p:
        return False
    if os.path.realpath(p).startswith(TEMP_PREFIXES):
        return False
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        tmpdir = os.path.normpath(tmpdir)
        if tmpdir not in ("/", "") and (p == tmpdir or p.startswith(tmpdir + os.sep)):
            return False
    if EXCLUDED_SEGMENTS.intersection(p.split(os.sep)):
        return False
    if p.endswith(ALLOWED_SUFFIXES):
        return False
    return True


# --------------------------------------------------------------------------- #
# Mutation detection per segment
# --------------------------------------------------------------------------- #

def _is_name_char(ch):
    return ch == "_" or ch.isalnum()


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or first.isalpha()):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


def command_name(tokens):
    i = 0
    while i < len(tokens) and is_env_assign(tokens[i]):
        i += 1
    if i >= len(tokens):
        return "", []
    return tokens[i].rsplit("/", 1)[-1], tokens[i + 1:]


SED_INPLACE = ("-i", "--in-place")

# Bounded quantifiers only -- nothing here can backtrack catastrophically.
WRITE_API = re.compile(
    r"open\s*\(\s*[^)\n]{0,400}?['\"][waxWAX][b+t]{0,2}['\"]"
    r"|\.write_text\s*\("
    r"|\.writelines\s*\("
    r"|\.write\s*\("
    r"|shutil\.move\s*\("
    r"|os\.replace\s*\("
    r"|os\.rename\s*\("
)
STDIO_WRITE = re.compile(r"(?:sys\.)?(?:stdout|stderr)\s*\.\s*write\s*\(")
STRING_LITERAL = re.compile(r"['\"]([^'\"\n]{1,400})['\"]")


def python_targets(body, cwd):
    """Paths an inline python body writes to, or [] when it only reads."""
    if not body:
        return []
    if not WRITE_API.search(STDIO_WRITE.sub("PRINTLIKE(", body)):
        return []
    return [c for c in STRING_LITERAL.findall(body) if is_guarded_target(c, cwd)]


def positional_targets(args, cwd):
    return [a for a in args if not a.startswith("-") and is_guarded_target(a, cwd)]


def segment_targets(seg, cwd):
    """Every existing source file this segment rewrites in place."""
    name, args = command_name(seg["tokens"])
    hits = []

    # 1/2. sed -i and perl -i rewrite their positional file arguments.
    if name in ("sed", "gsed"):
        if any(a == f or a.startswith(f) for a in args for f in SED_INPLACE):
            hits += positional_targets(args, cwd)
    elif name == "perl":
        bundles = [a for a in args if a.startswith("-") and not a.startswith("--")]
        if any("i" in b[1:] for b in bundles):
            hits += positional_targets(args, cwd)

    # 3. python -c "..." / python <<'PY' whose body names a path and writes.
    elif name in ("python", "python3", "python2") or name.startswith("python3."):
        bodies = list(seg["heredocs"])
        for idx, a in enumerate(args):
            if a == "-c" and idx + 1 < len(args):
                bodies.append(args[idx + 1])
            elif a.startswith("-c") and len(a) > 2:
                bodies.append(a[2:])
        for body in bodies:
            hits += python_targets(body, cwd)

    # 4. tee FILE / tee -a FILE.
    elif name == "tee":
        hits += positional_targets(args, cwd)

    # 5. Plain redirection, including the `cat > FILE` heredoc form. Applies to
    #    every command, not just the ones named above.
    for _op, target in seg["redirects"]:
        if is_guarded_target(target, cwd):
            hits.append(target)

    return hits


def targets_for(command, cwd):
    try:
        segments = lex(command)
    except Exception:
        return []  # fail-open: a lexer bug must never block a Bash call
    hits = []
    for seg in segments:
        if seg["parse_error"]:
            continue  # unparseable -> no opinion
        try:
            hits += segment_targets(seg, cwd)
        except Exception:
            continue
    seen, ordered = set(), []
    for h in hits:
        if h not in seen:
            seen.add(h)
            ordered.append(h)
    return ordered


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)
    # A payload that is valid JSON but not an object still has to fall through
    # to allow: this hook fronts every Bash call, so a crash here denies them all.
    if not isinstance(data, dict):
        sys.exit(0)
    if data.get("tool_name") not in (None, "Bash"):
        sys.exit(0)
    command = (data.get("tool_input", {}) or {}).get("command", "") or ""
    cwd = data.get("cwd") or os.getcwd()
    hits = targets_for(command, cwd)
    if hits:
        deny(reason_for(hits[0]))
    sys.exit(0)


# --------------------------------------------------------------------------- #

def selftest():
    import tempfile
    import time

    here = os.path.dirname(os.path.abspath(__file__))
    existing = os.path.join(here, "git-push-guard.py")
    assert os.path.isfile(existing), existing
    tmpdir = tempfile.mkdtemp(prefix="file-edit-guard-")
    tmpfile = os.path.join(tmpdir, "x.py")
    with open(tmpfile, "w") as fh:
        fh.write("print(1)\n")

    def denies(cmd, cwd=here):
        return bool(targets_for(cmd, cwd))

    # --- DENY: in-place rewrites of an existing repo file --------------------
    assert denies("sed -i 's/a/b/' git-push-guard.py")
    assert denies("sed -i '' -e 's/a/b/g' git-push-guard.py")            # macOS form
    assert denies("sed -i.bak 's/a/b/' " + existing)
    assert denies("sed --in-place 's/a/b/' git-push-guard.py")
    assert denies("perl -pi -e 's/a/b/' git-push-guard.py")
    assert denies("perl -i.bak -pe 's/a/b/' " + existing)
    assert denies(
        'python3 -c "p=open(\'git-push-guard.py\');'
        "open('git-push-guard.py','w').write(p.read())\"")
    assert denies("python3 -c \"from pathlib import Path; "
                  "Path('git-push-guard.py').write_text('x')\"")
    assert denies("cat > git-push-guard.py <<'EOF'\nhi\nEOF\n")
    assert denies("tee -a git-push-guard.py <<'EOF'\nhi\nEOF\n")
    assert denies("echo hi >> git-push-guard.py")
    assert denies("python3 <<'PY'\nopen('git-push-guard.py','w').write('x')\nPY\n")

    # --- ALLOW: temp/scratch roots and non-existent targets -------------------
    assert not denies("cat > %s <<'EOF'\nprint(2)\nEOF\n" % tmpfile)
    assert not denies("cat > /tmp/claude-501/scratchpad/x.py <<'EOF'\nhi\nEOF\n")
    assert not denies("rg foo > /tmp/out.txt")
    assert not denies("rg foo > %s/out.txt" % tmpdir)
    assert not denies("echo hi > /dev/null")
    assert not denies("sed -i 's/a/b/' does-not-exist-anywhere.py")
    assert not denies("sed -i 's/a/b/' %s" % tmpfile)

    # --- ALLOW: read-only work -------------------------------------------------
    assert not denies("python3 -c \"print(open('git-push-guard.py').read())\"")
    assert not denies("python3 -c \"import sys; "
                      "sys.stdout.write(open('git-push-guard.py').read())\"")
    assert not denies("sed -n '1,5p' git-push-guard.py")
    assert not denies("grep -n foo git-push-guard.py")
    assert not denies("cat git-push-guard.py | head -20")
    assert not denies("git diff HEAD -- git-push-guard.py")

    # --- ALLOW: excluded trees and log sinks ----------------------------------
    assert not denies("echo x >> ../../../../.git/config")
    assert not denies("echo x >> run.log")

    # --- ALLOW: unparseable / quote-hidden / no path --------------------------
    assert not denies("sed -i 's/a/b/ git-push-guard.py")   # unterminated quote
    assert not denies('echo "a > git-push-guard.py"')       # redirect is quoted
    assert not denies("awk '$1 > 2' git-push-guard.py")
    assert not denies("cat <<'EOF'\nunterminated heredoc\n")
    assert not denies("")
    assert not denies("ls -la")
    assert not denies("echo 2>&1")
    assert not denies("cat > $OUTFILE")                      # unexpanded variable
    assert not denies("sed -i 's/a/b/' *.py")                # glob, target unknown

    # --- Performance: 10KB command stays well under 40ms ----------------------
    big = "echo '" + ("x" * 10000) + "' && sed -i 's/a/b/' git-push-guard.py"
    t0 = time.time()
    assert targets_for(big, here)
    elapsed = (time.time() - t0) * 1000
    assert elapsed < 40, "10KB command took %.1fms" % elapsed

    os.remove(tmpfile)
    os.rmdir(tmpdir)
    print("file-edit-guard selftest ok (10KB command parsed in %.1fms)" % elapsed)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
