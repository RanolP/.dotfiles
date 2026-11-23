#!/usr/bin/env python3
"""Freeze the biggest agent-spawned process when macOS memory pressure leaves normal.
Incident: 2026-11-23, three parallel `ipsw dyld xref` on a 5.8GB dyld cache panicked the Mac.
Looks only at memory, never at command names: whatever an agent runs is covered."""
import json, os, signal, subprocess, time
from pathlib import Path

STATE = Path.home() / ".cache/claude-resource-watchdog/stopped.json"
AGENTS = {"claude", "codex", "agy"}
WARN = 2  # kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical

def pressure() -> int:
    out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True).stdout
    return int(out.strip() or 1)

def agent_children() -> list[tuple[int, int, str, str]]:
    procs = {}
    for line in subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,rss=,stat=,command="], capture_output=True, text=True).stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            procs[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[3], parts[4])
    roots = {p for p, (_, _, _, cmd) in procs.items() if os.path.basename(cmd.split()[0]) in AGENTS}
    def under_agent(pid: int) -> bool:
        seen = set()
        while pid in procs and pid not in seen:
            seen.add(pid)
            pid = procs[pid][0]
            if pid in roots:
                return True
        return False
    return [(p, rss, stat, cmd) for p, (_, rss, stat, cmd) in procs.items() if p not in roots and under_agent(p)]

def record(entry: dict):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    stopped = json.loads(STATE.read_text()) if STATE.exists() else []
    STATE.write_text(json.dumps(stopped + [entry], ensure_ascii=False, indent=1))

def notify(msg: str):
    subprocess.run(["/usr/bin/osascript", "-e", f"display notification {json.dumps(msg)} with title \"claude resource watchdog\""])

while True:
    level = pressure()
    # At warn, freeze one process and then wait: while any agent child is already stopped (ps stat "T"), stop
    # nothing more. Measured 2026-11-23: skipping only the stopped one made each 2 s tick freeze the next-largest
    # child, and 12 MCP servers and codex bridges of other sessions were frozen within 25 s while pressure stayed
    # at warn. The same run showed SIGSTOP alone left pressure at warn for 98 s; only SIGKILL returned it to normal.
    # The watchdog still never kills, on the user's order (2026-11-23): resource-guard.py tells the agent, which
    # checks the stopped process and kills or resumes it itself.
    kids = agent_children() if level >= WARN else []
    if any(k[2].startswith("T") for k in kids):
        kids = []
    if kids:
        pid, rss, _, cmd = max(kids, key=lambda k: k[1])
        sig = signal.SIGSTOP
        os.kill(pid, sig)
        record({"at": time.strftime("%FT%T%z"), "pid": pid, "rss_mb": rss // 1024, "signal": sig.name, "pressure": level, "command": cmd[:300]})
        notify(f"{sig.name} {pid} ({rss // 1024} MB): {cmd[:80]}")
    time.sleep(2)
