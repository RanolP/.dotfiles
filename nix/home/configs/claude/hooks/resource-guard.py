#!/usr/bin/env python3
"""Every Bash call an agent makes runs niced, and while the Mac is short on memory or CPU the agent is told so
and checks and stops its own jobs. The call itself always runs: the user wants the agent to judge, not a hard deny.
Incident: 2026-11-23 dyld xref panic. Pairs with resource-watchdog.py.
Niceness is set on the agent process itself, so the shell it forks next inherits it. Prefixing the command
with `renice -n 15 -p $$` instead was measured to fail: Claude Code checks the rewritten command, and the `$$`
makes it refuse every call ("A variable in this command can't be checked before it runs"), even a plain `ls`."""
import json, os, subprocess, sys
from pathlib import Path

AGENTS = {"claude", "codex", "agy"}
STATE = Path.home() / ".cache/claude-resource-watchdog/stopped.json"

def out(decision: dict):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **decision}}, ensure_ascii=False))
    sys.exit(0)

try:
    event = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
tool_input = event.get("tool_input") if isinstance(event, dict) else None
cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)

notes = []
try:
    frozen = json.loads(STATE.read_text()) if STATE.exists() else []
except (OSError, ValueError):
    frozen = []
for e in frozen if isinstance(frozen, list) else []:
    p = e.get("pid") if isinstance(e, dict) else None
    st = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(p)], capture_output=True, text=True).stdout.strip() if isinstance(p, int) else ""
    if st.startswith("T"):
        notes.append(f"resource-watchdog stopped pid {p} ({e.get('rss_mb')} MB, {str(e.get('command'))[:120]}) for memory pressure. "
                     f"If you started it, kill it (`kill -9 {p}`) and rerun it smaller; resume (`kill -CONT {p}`) only once pressure is back to normal.")
try:  # macOS only; elsewhere (Linux, WSL) treat pressure as normal and still check load
    level = int(subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True).stdout.strip() or 1)
except (OSError, ValueError):
    level = 1
if level != 1:
    notes.append(f"memory pressure level {level} (1 is normal).")
load1, cores = os.getloadavg()[0], os.cpu_count() or 1
if load1 > cores:
    notes.append(f"load {load1:.1f} > {cores} cores.")
if notes:
    notes.append("Check the processes you started (`ps -o pid,rss,stat,command -U $USER`), stop the heavy ones that are yours, "
                 "and hold off on new heavy jobs until this clears; tell the user what you stopped.")
pid = os.getppid()
for _ in range(6):
    row = subprocess.run(["/bin/ps", "-o", "ppid=,command=", "-p", str(pid)], capture_output=True, text=True).stdout.split(None, 1)
    if len(row) < 2:
        break
    if os.path.basename(row[1].split()[0]) in AGENTS:
        try:
            os.setpriority(os.PRIO_PROCESS, pid, max(15, os.getpriority(os.PRIO_PROCESS, pid)))
        except OSError:
            pass
        break
    pid = int(row[0])
if notes:
    out({"additionalContext": "\n".join(notes)})
sys.exit(0)
