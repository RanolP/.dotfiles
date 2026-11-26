"""Shared Bash command context helpers for Claude Code hooks."""
import os
import re
import shlex

LEADING_CD = re.compile(
    r"^\s*cd[ \t]+(?P<target>'[^']*'|\"(?:\\.|[^\"\\])*\"|[^ \t\r\n;&|]+)"
    r"[ \t]*&&[ \t]*"
)
COMMAND_PART = re.compile(
    r'''[ \t\r\n]+|'[^']*'|"[^"\\]*(?:\\.[^"\\]*)*"|\\.|[^ \t\r\n'"\\]+''',
    re.DOTALL,
)


def split_command(command):
    """Match shlex.split's default POSIX rules without per-character token copies."""
    tokens, parts = [], []
    position = 0
    while position < len(command):
        match = COMMAND_PART.match(command, position)
        if match is None:
            raise ValueError("Incomplete quote or escape")
        part = match.group()
        position = match.end()
        if part[0] in " \t\r\n":
            if parts:
                tokens.append("".join(parts))
                parts = []
        elif part[0] == "'":
            parts.append(part[1:-1])
        elif part[0] == '"':
            parts.append(re.sub(r'\\(["\\])', r'\1', part[1:-1]))
        elif part[0] == "\\":
            parts.append(part[1:])
        else:
            parts.append(part)
    if parts:
        tokens.append("".join(parts))
    return tokens


def fold_leading_cd(command, cwd):
    """Fold one leading `cd <dir> &&` into cwd and return the remaining command."""
    if not isinstance(command, str):
        return cwd, command
    match = LEADING_CD.match(command)
    if not match:
        return cwd, command
    try:
        target = shlex.split(match.group("target"))[0]
    except (IndexError, ValueError):
        return cwd, command
    target = os.path.expanduser(target)
    if not os.path.isabs(target):
        target = os.path.join(cwd or os.getcwd(), target)
    target = os.path.normpath(target)
    if not os.path.isdir(target):
        return cwd, command
    return target, command[match.end():]
