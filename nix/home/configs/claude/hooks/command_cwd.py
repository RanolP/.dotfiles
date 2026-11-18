"""Shared Bash command context helpers for Claude Code hooks."""
import os
import re
import shlex

LEADING_CD = re.compile(
    r"^\s*cd[ \t]+(?P<target>'[^']*'|\"(?:\\.|[^\"\\])*\"|[^ \t\r\n;&|]+)"
    r"[ \t]*&&[ \t]*"
)


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
