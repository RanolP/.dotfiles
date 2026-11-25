#!/usr/bin/env python3
"""PreToolUse guard: a package-registry publish needs the user's explicit go.

A publish is an outside-visible mutation that cannot be taken back: a version
number, once on the registry, stays burned even after an unpublish or yank. The
user's rule is that every outside-visible mutation goes through them, so the
publish command is denied here and handed to the user as a `! <command>` line
they run in their own shell.

Denied, at any command position (after operators, NAME=val assignments, the
usual wrappers, `sh -c`/`eval` strings and `$(...)`/backtick bodies):
  npm publish, pnpm publish, yarn publish, yarn npm publish, bun publish,
  cargo publish, twine upload, uv publish, poetry publish, gem push
and the same reached through corepack, npx, bunx, npm/pnpm/yarn exec, pnpm/yarn
dlx, bun x, mise exec/x, uv run, uvx, pipx run and `python -m twine`. A
`--dry-run` (cargo also `-n`) or `--help`/`-h` passes, since it uploads
nothing. A heredoc body is data: a quoted delimiter's body is never read, an
unquoted one is scanned only for `$(...)`/backtick substitutions. Shell
comments are skipped. `gh release create` is out of scope: it is not a registry.

On a parse error, or a command over 64KB, the guard fails closed when a raw-text
regex finds a publish without `--dry-run`, and allows otherwise. A malformed
payload (empty, non-JSON, non-string command) is no opinion.

Self-check: `python3 publish-guard.py --selftest`.
"""
import json
import re
import shlex
import sys

REASON = ("Publishing to a package registry needs the user's explicit go. "
          "Hand the exact command to the user as a "
          "`! <command>` line to run in their own shell, and wait for their result. "
          "A `--dry-run` variant passes this guard.")

SHELLS = {"bash", "sh", "zsh", "dash", "fish"}
PYTHONS = re.compile(r"^python(?:3(?:\.\d+)?)?$")
KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"}
SEPARATOR_CHARS = set("();&|\n")
MAX_DEPTH = 8

WRAPPER_ARG_OPTS = {
    "sudo": {"-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U", "-T"},
    "env": {"-u", "-C", "-S", "--unset", "--chdir", "--split-string"},
    "command": set(),
    "exec": {"-a"},
    "nohup": set(),
    "time": set(),
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
    "nice": {"-n", "--adjustment"},
    "xargs": {"-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args",
              "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--replace"},
    "watch": {"-n", "--interval"},
    "doas": {"-u", "-C"},
    "caffeinate": {"-t", "-w"},
}

# Global options that take the next token as a value, before the subcommand.
PM_ARG_OPTS = {
    "npm": {"--prefix", "-C", "--workspace", "-w", "--userconfig", "--registry", "--tag", "--otp"},
    "pnpm": {"-C", "--dir", "--filter", "-F", "--workspace-dir", "--registry", "--tag", "--otp"},
    "yarn": {"--cwd"},
    "bun": {"--cwd", "-c", "--config"},
    "cargo": {"-C", "--config", "-Z", "--manifest-path", "--registry", "--color"},
    "twine": set(),
    "uv": {"--directory", "--project", "--config-file", "--cache-dir", "--color", "--python", "-p"},
    "poetry": {"-C", "--directory", "-P", "--project"},
    "gem": set(),
}
# The positional words that make a publish, per program.
PUBLISH = {
    "npm": [("publish",)],
    "pnpm": [("publish",)],
    "yarn": [("publish",), ("npm", "publish")],
    "bun": [("publish",), ("pm", "publish")],
    "cargo": [("publish",)],
    "twine": [("upload",)],
    "uv": [("publish",)],
    "poetry": [("publish",)],
    "gem": [("push",)],
}
UV_RUN_ARG_OPTS = {"--with", "--python", "-p", "--directory", "--project", "--package",
                   "--env-file", "--index", "--extra", "--group", "-w", "--from"}

FALLBACK_RE = re.compile(
    r"(?<![\w.-])(?:(?:npm|pnpm|bun|yarn(?:\s+npm)?)\s+publish|cargo\s+publish|twine\s+upload"
    r"|uv\s+publish|poetry\s+publish|gem\s+push)(?![\w-])")
DRY_RE = re.compile(r"(?<![\w-])--dry-run(?![\w-]|=(?:false|0)\b)")
PREFILTER_RE = re.compile(r"publish|upload|push")
MAX_LEX_CHARS = 64 * 1024
# npx/bunx and the exec/dlx subcommands: options that take a value.
RUNNER_ARG_OPTS = {"-p", "--package", "--prefix", "-w", "--workspace", "-C", "--dir",
                   "--filter", "-F", "--cwd"}
RUNNER_SUBCOMMANDS = {"npm": {"exec"}, "pnpm": {"exec", "dlx"}, "yarn": {"exec", "dlx"},
                      "bun": {"x"}}
YARN_FOREACH_ARG_OPTS = {"--from", "--include", "--exclude", "-j", "--jobs", "-W", "--worktree"}
HEREDOC_RE = re.compile(
    r"(?<!<)<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|(\\?)([A-Za-z_][\w.-]*))")
COMMENT_START = set(" \t\n;&|()")


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    name = tok[:eq]
    if not (name[0] == "_" or name[0].isalpha()):
        return False
    return all(c == "_" or c.isalnum() for c in name)


def is_separator(tok):
    return bool(tok) and all(c in SEPARATOR_CHARS for c in tok)


def is_redirect(tok):
    return bool(tok) and all(c in "<>&" for c in tok) and tok[0] in "<>"


def lex(cmd):
    lx = shlex.shlex(cmd, posix=True, punctuation_chars="();&|\n<>")
    lx.whitespace = " \t\r"
    lx.whitespace_split = True
    return list(lx)


def strip_heredocs(cmd):
    """(cmd with every heredoc body removed, bodies of the unquoted ones).

    A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\\EOF`) makes the body literal
    text; an unquoted one still expands `$(...)`, so its body is returned for a
    substitution-only scan. An unterminated body runs to the end, as in bash."""
    if "<<" not in cmd:
        return cmd, []
    lines = cmd.split("\n")
    out, bodies, i = [], [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in HEREDOC_RE.finditer(line):
            tabs = m.group(1) == "-"
            if m.group(2) is not None or m.group(3) is not None:
                delim, quoted = m.group(2) if m.group(2) is not None else m.group(3), True
            else:
                delim, quoted = m.group(5), bool(m.group(4))
            body = []
            while i < len(lines):
                cur = lines[i]
                i += 1
                if (cur.lstrip("\t") if tabs else cur) == delim:
                    break
                body.append(cur)
            if not quoted:
                bodies.append("\n".join(body))
    return "\n".join(out), bodies


def substitutions(cmd, shell_quoting=True):
    """Bodies of `$(...)` and backtick substitutions outside single quotes and
    comments. With shell_quoting off (a heredoc body), quotes and `#` are text."""
    out, i, n = [], 0, len(cmd)
    in_dq = False
    while i < n:
        c = cmd[i]
        if c == "\\":
            i += 2
            continue
        if shell_quoting and c == "#" and not in_dq and (i == 0 or cmd[i - 1] in COMMENT_START):
            j = cmd.find("\n", i)
            i = n if j < 0 else j
            continue
        if not shell_quoting:
            pass
        elif c == "'" and not in_dq:
            j = cmd.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            in_dq = not in_dq
        elif c == "$" and cmd.startswith("$(", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if cmd[j] == "(":
                    depth += 1
                elif cmd[j] == ")":
                    depth -= 1
                j += 1
            out.append(cmd[i + 2:j - 1] if depth == 0 else cmd[i + 2:])
            i = j
            continue
        elif c == "`":
            j = cmd.find("`", i + 1)
            out.append(cmd[i + 1:] if j < 0 else cmd[i + 1:j])
            i = n if j < 0 else j + 1
            continue
        i += 1
    return out


def is_dry_run(program, args):
    for a in args:
        if a == "--":
            break
        if a in ("--dry-run", "--dry-run=true", "--dry-run=1", "--help", "-h"):
            return True
        if program == "cargo" and a == "-n":
            return True
    return False


def positionals(program, args):
    arg_opts = PM_ARG_OPTS[program]
    out, i = [], 0
    while i < len(args) and len(out) < 2:
        a = args[i]
        if a == "--":
            break
        if program == "cargo" and a.startswith("+"):
            i += 1
        elif a.startswith("-") and len(a) > 1:
            i += 2 if a in arg_opts else 1
        else:
            out.append(a)
            i += 1
    return tuple(out)


def publish_hit(program, args):
    """'<program> <sub>' when args make a non-dry-run publish, else None."""
    pos = positionals(program, args)
    for words in PUBLISH[program]:
        if pos[:len(words)] == words:
            return None if is_dry_run(program, args) else " ".join((program,) + words)
    return None


def skip_wrapper_opts(name, words, i):
    arg_opts = WRAPPER_ARG_OPTS[name]
    while i < len(words):
        w = words[i]
        if name in ("sudo", "env") and is_env_assign(w):
            i += 1
        elif w == "--":
            return i + 1
        elif w.startswith("-") and len(w) > 1:
            i += 2 if w in arg_opts else 1
        elif name == "env" and w == "-":
            i += 1
        else:
            break
    if name == "timeout" and i < len(words):
        i += 1
    return i


def skip_opts(words, i, arg_opts):
    while i < len(words):
        w = words[i]
        if w == "--":
            return i + 1
        if w.startswith("-") and len(w) > 1:
            i += 2 if w in arg_opts else 1
        else:
            break
    return i


def check_segment(words, depth):
    i = 0
    while i < len(words):
        w = words[i]
        if is_env_assign(w) or w in KEYWORDS:
            i += 1
            continue
        if is_redirect(w):
            i += 2
            continue
        name = w.rsplit("/", 1)[-1]
        rest = words[i + 1:]
        if name in ("npx", "bunx"):
            j = i + 1
            while j < len(words) and words[j].startswith("-") and len(words[j]) > 1:
                if words[j] in ("-c", "--call") and j + 1 < len(words):
                    return publish_command(words[j + 1], depth + 1)
                j += 2 if words[j] in RUNNER_ARG_OPTS else 1
            i = j
            continue
        if name == "yarn":
            pos = positionals("yarn", rest)
            if pos[:2] == ("workspaces", "foreach"):
                j = rest.index("foreach", rest.index("workspaces")) + 1
                i = i + 1 + skip_opts(rest, j, YARN_FOREACH_ARG_OPTS)
                continue
            if pos[:1] == ("workspace",) and len(pos) == 2:
                i = i + 1 + rest.index(pos[1], rest.index("workspace") + 1) + 1
                continue
        if name in RUNNER_SUBCOMMANDS:
            pos = positionals(name, rest)
            if pos[:1] and pos[0] in RUNNER_SUBCOMMANDS[name]:
                i = i + 1 + skip_opts(rest, rest.index(pos[0]) + 1, RUNNER_ARG_OPTS)
                continue
        if name in PUBLISH:
            if name == "uv" and positionals("uv", rest)[:1] == ("run",):
                j = rest.index("run") + 1
                i = i + 1 + skip_opts(rest, j, UV_RUN_ARG_OPTS)
                continue
            return publish_hit(name, rest)
        if name in WRAPPER_ARG_OPTS:
            i = skip_wrapper_opts(name, words, i + 1)
            continue
        if name == "corepack":
            i += 1
            continue
        if name in ("uvx", "pipx"):
            j = i + 1
            if name == "pipx":
                if j < len(words) and words[j] == "run":
                    j += 1
                else:
                    return None
            i = skip_opts(words, j, UV_RUN_ARG_OPTS | {"--spec"})
            continue
        if name == "mise" and rest[:1] and rest[0] in ("exec", "x"):
            if "--" in rest:
                i = i + 1 + rest.index("--") + 1
                continue
            return None
        if PYTHONS.match(name):
            for k, a in enumerate(rest):
                if a == "-m" and k + 1 < len(rest):
                    mod = rest[k + 1]
                    if mod == "twine":
                        return publish_hit("twine", rest[k + 2:])
                    return None
                if not a.startswith("-"):
                    return None
            return None
        if name in SHELLS:
            for k, a in enumerate(rest):
                if a.startswith("-") and not a.startswith("--") and "c" in a[1:]:
                    if k + 1 < len(rest):
                        return publish_command(rest[k + 1], depth + 1)
                    return None
                if not a.startswith("-"):
                    return None
            return None
        if name == "eval":
            return publish_command(" ".join(rest), depth + 1)
        return None
    return None


def publish_command(cmd, depth=0):
    """Name of a registry publish run anywhere in `cmd`, else None."""
    if depth > MAX_DEPTH or not PREFILTER_RE.search(cmd):
        return None
    cmd, heredoc_bodies = strip_heredocs(cmd)
    for body in heredoc_bodies:
        for sub in substitutions(body, shell_quoting=False):
            hit = publish_command(sub, depth + 1)
            if hit:
                return hit
    try:
        if len(cmd) > MAX_LEX_CHARS:
            raise ValueError("too long to lex")
        toks = lex(cmd)
    except ValueError:
        m = FALLBACK_RE.search(cmd)
        if m and not DRY_RE.search(cmd):
            return " ".join(m.group(0).split())
        return None
    seg = []
    for tok in toks + [";"]:
        if is_separator(tok):
            hit = check_segment(seg, depth)
            if hit:
                return hit
            seg = []
        else:
            seg.append(tok)
    for body in substitutions(cmd):
        hit = publish_command(body, depth + 1)
        if hit:
            return hit
    return None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        sys.exit(0)
    if not isinstance(data, dict):
        sys.exit(0)
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str):
        sys.exit(0)
    hit = publish_command(cmd)
    if hit:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"Blocked: `{hit}`. {REASON}",
        }}))
    sys.exit(0)


def selftest():
    p = publish_command
    # every registry publish this guard exists for
    for cmd, hit in (("npm publish", "npm publish"), ("pnpm publish", "pnpm publish"),
                     ("yarn publish", "yarn publish"), ("yarn npm publish", "yarn npm publish"),
                     ("bun publish", "bun publish"), ("cargo publish", "cargo publish"),
                     ("twine upload dist/*", "twine upload"), ("uv publish", "uv publish"),
                     ("poetry publish --build", "poetry publish"), ("gem push x.gem", "gem push")):
        assert p(cmd) == hit, cmd
    # global options and toolchains before the subcommand
    for cmd in ("pnpm -r publish", "pnpm --filter pkg publish --access public",
                "npm --prefix pkg publish", "cargo +nightly publish", "cargo -Z unstable publish",
                "uv --directory pkg publish", "/usr/local/bin/npm publish"):
        assert p(cmd), cmd
    # reached through runners and wrappers
    for cmd in ("corepack pnpm publish", "mise exec node@22 -- npm publish", "mise x -- cargo publish",
                "uv run twine upload dist/*", "uv run --with twine twine upload dist/*",
                "uvx twine upload dist/*", "pipx run twine upload dist/*",
                "python3 -m twine upload dist/*", "python -m twine upload dist/*",
                "NPM_TOKEN=x npm publish", "sudo npm publish", "env -i npm publish",
                "timeout 60 cargo publish", "nohup npm publish"):
        assert p(cmd), cmd
    # after every operator and inside re-evaluated strings
    for op in ("&&", "||", ";", "|", "&", "\n"):
        assert p(f"npm run build {op} npm publish"), op
    for cmd in ("bash -c 'npm publish'", "sh -lc \"cargo publish\"", "eval npm publish",
                "echo $(npm publish)", "echo `npm publish`", "(cd pkg && npm publish)",
                "if true; then npm publish; fi"):
        assert p(cmd), cmd
    # a dry run uploads nothing
    for cmd in ("npm publish --dry-run", "pnpm publish --dry-run", "yarn npm publish --dry-run",
                "bun publish --dry-run", "cargo publish --dry-run", "cargo publish -n",
                "uv publish --dry-run", "poetry publish --dry-run", "npm publish --dry-run=true",
                "bash -c 'npm publish --dry-run'"):
        assert p(cmd) is None, cmd
    # --dry-run=false is a real publish
    assert p("npm publish --dry-run=false")
    # not a publish
    for cmd in ("npm run publish", "npm install", "pnpm pack", "cargo build", "twine check dist/*",
                "uv pip install twine", "uv run pytest", "poetry build", "gem install rake",
                "git push origin main", "echo npm publish", "rg 'npm publish' docs",
                "gh release create v1", "man npm-publish", "npm view pkg", "docker push img",
                "mise exec node -- npm ci", "python3 -m pytest", "python3 script.py publish",
                "echo '$(npm publish)'", ""):
        assert p(cmd) is None, cmd
    # parse failure: fail closed on a raw-text publish, allow otherwise
    assert p("npm publish 'unterminated") == "npm publish"
    assert p("ls; cargo  publish 'x") == "cargo publish"
    assert p("npm publish --dry-run 'x") is None
    assert p("echo 'unclosed") is None
    # an oversized command is judged by the raw-text regex
    assert p("npm publish " + "x" * 100_000) == "npm publish"
    assert p("echo " + "x" * 100_000) is None
    # runners that wrap a publisher (review 2026-11-26: `npx npm publish` passed)
    for cmd in ("npx npm publish", "npx -y npm publish", "npx --yes pnpm publish",
                "npx -p npm@10 npm publish", "bunx npm publish", "pnpm dlx npm publish",
                "pnpm exec npm publish", "yarn dlx npm publish", "npm exec -- npm publish",
                "bun x npm publish", "npx -c 'npm publish'"):
        assert p(cmd), cmd
    for cmd in ("npx prettier --write .", "pnpm dlx create-vite app", "bunx tsc",
                "npx npm publish --dry-run", "pnpm exec vitest"):
        assert p(cmd) is None, cmd
    # a quoted heredoc body is text, even with an apostrophe in it
    assert p("git commit -F - <<'EOF'\ncargo publish\nEOF") is None
    assert p("cat <<'EOF'\nDon't run npm publish.\nEOF") is None
    assert p('cat <<"EOF"\nnpm publish\nEOF') is None
    assert p("cat <<\\EOF\nnpm publish\nEOF") is None
    assert p("cat <<-'EOF'\n\tnpm publish\n\tEOF") is None
    assert p("cat <<EOF\nnpm publish is the step\nEOF") is None
    # an unquoted heredoc still runs its substitutions; commands after it still count
    assert p("cat <<EOF\nDon't $(npm publish)\nEOF")
    assert p("cat <<'EOF'\ntext\nEOF\nnpm publish")
    assert p("cat <<< 'npm publish'") is None
    # a comment is not run
    assert p("echo ok # $(npm publish)") is None
    assert p("echo ok\n# npm publish") is None
    assert p("echo a#$(npm publish)")
    # yarn's workspace runners (code-reviewer 2026-11-26)
    for cmd in ("yarn workspaces foreach -A npm publish", "yarn workspaces foreach --all -pt npm publish",
                "yarn workspaces foreach --from 'pkg-*' -R npm publish", "yarn workspace pkg npm publish",
                "yarn workspaces foreach -A exec npm publish"):
        assert p(cmd), cmd
    for cmd in ("yarn workspaces foreach -A run build", "yarn workspace pkg add lodash",
                "yarn workspaces list", "yarn workspaces foreach -A npm publish --dry-run"):
        assert p(cmd) is None, cmd
    # a quoted heredoc inside a substitution, or feeding a file, is text
    assert p("git commit -m \"$(cat <<'EOF'\nchore: release\n\nnpm publish\nEOF\n)\"") is None
    assert p("cat > release.sh <<'EOF'\nnpm run build\nnpm publish\nEOF") is None
    assert p("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && npm publish")
    # help uploads nothing
    for cmd in ("npm publish --help", "cargo publish --help", "uv publish -h", "gem push --help"):
        assert p(cmd) is None, cmd
    print("publish-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
