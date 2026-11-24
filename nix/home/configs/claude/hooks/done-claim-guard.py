#!/usr/bin/env python3
"""Stop guard: a "done" reply needs a run after the last edit.

AGENTS.md already says "never say done without a runtime check", and the rule
was loaded every time it failed: 6 corrections in 12 days of transcripts
(2026-11-13..24) were a reply claiming a fix the user then found broken by
running it ("제발 스스로 보고 판단좀 해보지 않을래? 수정했다고 주장만 하지 말고").
Prose cannot catch that; the transcript can. This hook reads the turn that is
ending and blocks the stop once when all three hold:

  - the final message claims completion (done, fixed, 완료, 고쳤다, 통과 ...)
    and carries no "unverified" statement,
  - the turn edited a source file (Edit/Write/MultiEdit/NotebookEdit, an
    edit()/write() call inside a REPL script, or sed -i / a redirect in Bash),
  - no command that runs something came after that last edit -- a Bash or
    REPL `$` command whose program is not a read/file/git utility, or a
    delegated Agent/SendMessage/MCP call that may have run the check.

A pure Q&A turn (no edit) and a doc-only turn (.md/.txt, scratch and /tmp
paths) always pass. `stop_hook_active` means this hook already blocked once,
so the second stop passes and the hook cannot loop.

Stop's `last_assistant_message` carries the final text (the transcript does
not hold it yet at Stop time); tool calls come from `transcript_path`.
Fail-open: any error exits 0 silently.

Self-check: `python3 done-claim-guard.py --selftest`.
"""
import json
import os
import re
import sys

TRANSCRIPT_TAIL = 4 * 1024 * 1024

CLAIM = re.compile(
    r"\b(done|fixed|completed?|implemented|resolved|works now|now works|"
    r"(tests?|checks?) pass(es|ed)?|passes|passing)\b"
    r"|완료|고쳤|고쳐졌|수정했|수정됐|수정되었|해결했|해결됐|해결되었|구현했|"
    r"반영했|통과(한|했|됐|되었|함)|작동한다|동작한다|작동합니다|동작합니다|끝냈|끝났|마쳤",
    re.IGNORECASE,
)
UNVERIFIED = re.compile(
    r"unverified|not (yet )?verified|untested|not (been )?tested|did(n't| not) run|"
    r"have(n't| not) (run|seen|checked|looked)|not run|미검증|검증(하지| 안| 못|되지)|확인(하지| 안| 못)|"
    r"실행(하지| 안| 못)|돌려보지|돌리지 않|테스트(하지| 안| 못)|보지 않았|듣지 않았|들어보지",
    re.IGNORECASE,
)

FENCE = re.compile(r"```.*?(```|$)", re.DOTALL)
INLINE = re.compile(r"`[^`\n]*`")
QUOTE = re.compile(r"^\s*>.*$", re.MULTILINE)

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# Calls that can run the check out of this transcript's sight.
# A published Artifact is the deliverable rendered where the user reads it.
DELEGATE_TOOLS = {"Agent", "Task", "SendMessage", "Skill", "Artifact"}

# Programs that read, move or record files without exercising the change.
NON_RUN = {
    "ls", "cat", "bat", "head", "tail", "less", "grep", "rg", "fd", "find",
    "sed", "awk", "wc", "echo", "printf", "jq", "yq", "stat", "readlink",
    "realpath", "which", "type", "command", "cd", "pwd", "mkdir", "cp", "mv",
    "rm", "rmdir", "touch", "chmod", "ln", "git", "gh", "tree", "eza", "file",
    "du", "df", "diff", "delta", "sort", "uniq", "cut", "tr", "xargs", "sleep",
    "date", "true", "false", "test", "[", "env", "export", "source", ".",
    "tee", "basename", "dirname", "base64", "sha256sum", "shasum", "md5sum",
    "pbcopy", "open", "xdg-open", "wsl-open", "nl", "column", "fold", "fmt",
    "unset", "set", "exit", "trash", "rsync", "tar", "unzip", "zip", "jj",
}
WRAPPERS = {"sudo", "time", "timeout", "nice", "nohup", "env", "exec", "command"}

# A type check or lint is a hypothesis about the change, not a run of it
# (AGENTS.md "Verification"); in 2026-11-18's banner session `npx tsc --noEmit`
# passed while the screen still showed the defect.
STATIC_ONLY = re.compile(
    r"\btsc\b|--noEmit|\bcargo\s+(check|clippy|fmt)\b|\bmypy\b|\bpyright\b|"
    r"\bruff\b|\beslint\b|\boxlint\b|\bbiome\s+(check|lint|format)\b|"
    r"\bgo\s+vet\b|\bprettier\b|py_compile|\bnode\s+--check\b|\b(ba)?sh\s+-n\b|"
    r"\bshellcheck\b|--dry-run\b|--help\b|--version\b"
)

DOC_PATH = re.compile(
    r"(\.(md|mdx|txt|rst|adoc|log|jsonl)$)|(^|/)(tmp|scratchpad)(/|$)|"
    r"^\$\{(sp|SP|scratch\w*|tmp\w*)\}|memory/|(^|/)\.[\w-]*ignore[\w-]*$",
)

SHELL_SPLIT = re.compile(r"&&|\|\||[;|\n]|\$\(|`")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
IN_PLACE = re.compile(r"\b(sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i)|\bapply_patch\b|\bgit\s+apply\b")
REDIRECT = re.compile(r"(^|[^0-9&>=<-])>{1,2}\s*(?!&)([\w~.$/{}-]+)")
PATHISH = re.compile(r"[\w~.${}/-]*\.[A-Za-z]\w*\b")
REPL_SHELL = re.compile(r"\$`((?:\\.|[^`\\])*)`|\$\(\s*(['\"`])(.*?)\2", re.DOTALL)
REPL_EDIT = re.compile(
    r"(?<![\w.$])(edit|write)\s*\(\s*(?:(['\"`])(.*?)\2|[A-Za-z_$][\w$.]*\s*,)"
    r"|tools\.(Edit|Write|MultiEdit)\s*\(\s*\{[^}]*?file_path\s*:\s*(['\"`])(.*?)\5",
    re.DOTALL,
)


def prose(text):
    text = FENCE.sub(" ", text)
    text = INLINE.sub(" ", text)
    return QUOTE.sub(" ", text)


def claims_done(text):
    body = prose(text or "")
    return bool(CLAIM.search(body)) and not UNVERIFIED.search(body)


def is_code_path(path):
    """An unresolved path counts as not code, so an unknown never blocks."""
    path = (path or "").strip()
    return bool(path) and not DOC_PATH.search(path)


def command_runs(cmd):
    """True when some segment of a shell command runs a program."""
    for seg in SHELL_SPLIT.split(cmd or ""):
        words = seg.strip().split()
        while words and (ASSIGN.match(words[0]) or words[0] in WRAPPERS
                         or words[0].startswith("-") or words[0] in ("{", "(", "!")):
            words = words[1:]
        if not words:
            continue
        head = words[0].strip("\"'()").rsplit("/", 1)[-1]
        if (head and head not in NON_RUN and not head.startswith("$")
                and not STATIC_ONLY.search(seg)):
            return True
    return False


HEREDOC_BODY = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?(\n\s*\1\s*(\n|$)|$)", re.DOTALL)
QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")


def bash_edits(cmd):
    """True when a shell command writes a code file: a redirect, sed -i or a
    patch. Quotes and heredoc bodies are blanked first, because `=>` and
    `a > b` inside them are program text, not a redirect."""
    bare = HEREDOC_BODY.sub(lambda m: m.group(0).split("\n", 1)[0] + "\n", cmd or "")
    unquoted = QUOTED.sub("''", bare)
    for m in REDIRECT.finditer(unquoted):
        if not m.group(2).startswith("/dev/") and is_code_path(m.group(2)):
            return True
    hit = IN_PLACE.search(unquoted)
    if not hit:
        return False
    targets = [p for p in PATHISH.findall(bare[hit.end():]) if "/" in p or p.count(".") == 1]
    return not targets or any(is_code_path(p) for p in targets)


BINDING = re.compile(r"(?:\b(?:const|let|var)\s+|globalThis\.)([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)")


def repl_bindings(codes):
    """Variable -> right-hand side across REPL scripts; the REPL keeps state,
    so a path bound in an earlier script names the file an edit(VAR) writes."""
    out = {}
    for code in codes:
        for m in BINDING.finditer(code or ""):
            out[m.group(1)] = m.group(2)
    return out


def repl_events(code, bindings=None):
    """Edit and run events of one REPL script, in source order."""
    bindings = dict(bindings or {}, **repl_bindings([code]))
    events = []
    for m in REPL_EDIT.finditer(code or ""):
        path = m.group(3) if m.group(3) is not None else (m.group(6) or "")
        var = re.match(r"(?:edit|write)\s*\(\s*([A-Za-z_$][\w$]*)\s*,", m.group(0))
        if var:
            path = bindings.get(var.group(1), "").strip().strip("`'\"")
        if is_code_path(path):
            events.append((m.start(), "edit"))
    for m in REPL_SHELL.finditer(code or ""):
        cmd = m.group(1) if m.group(1) is not None else m.group(3)
        if bash_edits(cmd):
            events.append((m.start(), "edit"))
        if command_runs(cmd):
            events.append((m.start() + 1, "run"))
    if re.search(r"tools\.Bash\s*\(", code or ""):
        events.append((len(code), "run"))
    return [kind for _, kind in sorted(events)]


def tool_events(name, ti, bindings=None):
    ti = ti if isinstance(ti, dict) else {}
    if name in EDIT_TOOLS:
        path = ti.get("file_path") or ti.get("notebook_path") or ""
        return ["edit"] if is_code_path(path) else []
    if name == "Bash":
        cmd = ti.get("command") or ""
        out = ["edit"] if bash_edits(cmd) else []
        return out + (["run"] if command_runs(cmd) else [])
    if name == "REPL":
        return repl_events(ti.get("code") or "", bindings)
    if name in DELEGATE_TOOLS or name.startswith("mcp__"):
        return ["run"]
    return []


def is_turn_start(entry):
    """A prompt that opens a turn: user text, not a tool result or an injection."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        if not content or not isinstance(content[0], dict) or content[0].get("type") != "text":
            return False
        content = content[0].get("text") or ""
    if not isinstance(content, str):
        return False
    return not content.lstrip().startswith(
        ("<clm-stable-attachment", "<clm-queued-message", "<system-reminder"))


def turn_entries(path):
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - TRANSCRIPT_TAIL))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    entries = []
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if is_turn_start(entry):
            return list(reversed(entries)), repl_codes(lines[: lines.index(line)])
        entries.append(entry)
    return list(reversed(entries)), []


def repl_codes(lines):
    """REPL script sources in transcript lines, oldest first."""
    codes = []
    for line in lines:
        if '"REPL"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("type") == "assistant":
            for block in (entry.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("name") == "REPL":
                    codes.append((block.get("input") or {}).get("code") or "")
    return codes


def unchecked_edit(entries, prior_codes=()):
    """True when the turn's last code edit has no run after it."""
    bindings = repl_bindings(prior_codes)
    events = []
    for entry in entries:
        if entry.get("type") != "assistant":
            continue
        for block in (entry.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                name = block.get("name") or ""
                events.extend(tool_events(name, block.get("input"), bindings))
                if name == "REPL":
                    bindings.update(repl_bindings([(block.get("input") or {}).get("code") or ""]))
    if "edit" not in events:
        return False
    last_edit = len(events) - 1 - events[::-1].index("edit")
    return "run" not in events[last_edit + 1:]


REASON = (
    "Your reply claims the work is done, but nothing ran after the last code "
    "edit in this turn. Run the check that exercises the change (the test, the "
    "build, the app or the listen/look step) and report what it showed, or say "
    "in the reply which claim stayed unverified and name the missing check."
)


def decide(data):
    if data.get("stop_hook_active"):
        return None
    if not claims_done(data.get("last_assistant_message") or ""):
        return None
    path = data.get("transcript_path")
    if not path or not unchecked_edit(*turn_entries(os.path.expanduser(path))):
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
        __import__("test_done_claim_guard").main()
    else:
        main()
    sys.exit(0)
