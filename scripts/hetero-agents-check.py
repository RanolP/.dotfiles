#!/usr/bin/env python3
"""Fail when hetero-subagents/agents/*.md drifts from TYPES in hooks/register.ts.

The mod's test runtime has no file access, so this is the only guard on the
on-disk agent definitions. It runs at nix build time (nix/home/default.nix,
heteroSubagentsMod). The description template below mirrors agentDescription()
in register.ts; change both together.
Usage: hetero-agents-check.py <mod-dir>
"""

import re
import sys
from pathlib import Path

mod = Path(sys.argv[1])
register = (mod / "hooks/register.ts").read_text()
block = re.search(r"export const TYPES = \{\n(.*?)\n\} as const", register, re.S).group(1)
types = {}
for m in re.finditer(
    r"^\s*'([^']+)': \{ backend: '(\w+)', model: '([^']+)', effort: '(\w+)', sandbox: '([\w-]+)', blurb: '((?:[^'\\]|\\.)*)' \},?$",
    block,
    re.M,
):
    types[m[1]] = dict(backend=m[2], model=m[3], effort=m[4], sandbox=m[5], blurb=m[6])
if not types:
    sys.exit("hetero-agents-check: no TYPES entries parsed from hooks/register.ts")


def description(t):
    if t["backend"] == "acp":
        return f"Runs the task on {t['model']} through Google Antigravity (read and search tools only; no edits, shell, or Claude-side tools; {t['blurb']}). SendMessage continues the same ACP session."
    tools = "codex's own read-only shell" if t["sandbox"] == "read-only" else "codex's own shell and edit tools"
    return f"Runs the task on OpenAI {t['model']} at {t['effort']} effort in the {t['sandbox']} sandbox through Codex ({tools}, plus this session's read-only MCP tools and skills relayed; {t['blurb']}). SendMessage continues the same codex thread."


errors = []
want = {name.replace(":", "-") + ".md": (name, t) for name, t in types.items()}
have = {p.name for p in (mod / "agents").glob("*.md")}
for extra in sorted(have - want.keys()):
    errors.append(f"agents/{extra}: no matching TYPES key")
for missing in sorted(want.keys() - have):
    errors.append(f"agents/{missing}: missing for TYPES key {want[missing][0]}")
for file in sorted(have & want.keys()):
    name, t = want[file]
    head = (mod / "agents" / file).read_text().split("\n---\n", 1)[0]
    fields = dict(line.split(": ", 1) for line in head.splitlines() if re.match(r"^(name|description|model): ", line))
    for key, expected in (("name", name), ("model", t["model"]), ("description", description(t))):
        if fields.get(key) != expected:
            errors.append(f"agents/{file}: {key} is {fields.get(key)!r}, expected {expected!r}")
if errors:
    sys.exit("hetero-agents-check: agents/ drifted from TYPES in hooks/register.ts:\n  " + "\n  ".join(errors))
print(f"hetero-agents-check: {len(types)} agent files match TYPES")
