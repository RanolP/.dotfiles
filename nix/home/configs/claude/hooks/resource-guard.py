#!/usr/bin/env python3
"""Every Bash call an agent makes runs niced, and while the Mac is short on memory or CPU the agent is told so
and checks and stops its own jobs. The call itself always runs: the user wants the agent to judge, not a hard deny.
Incident: 2026-11-23 dyld xref panic. Pairs with resource-watchdog.py.
A process the watchdog stopped or resumed is reported only to the session that owns it (the watchdog records the
owner's session id), once per event; other sessions get the generic pressure notice alone.
Niceness is set on the agent process itself, so the shell it forks next inherits it. Prefixing the command
with `renice -n 15 -p $$` instead was measured to fail: Claude Code checks the rewritten command, and the `$$`
makes it refuse every call ("A variable in this command can't be checked before it runs"), even a plain `ls`."""
import json, os, re, subprocess, sys
from pathlib import Path

AGENTS = {"claude", "codex", "agy"}
CACHE = Path.home() / ".cache/claude-resource-watchdog"
STATE = CACHE / "stopped.json"

def owner_notices(entries, session_id: str, delivered: set) -> tuple[list[str], list[str]]:
    """Notices for the stop/resume events of processes owned by session_id not yet in delivered, plus their keys."""
    notes, keys = [], []
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict) or not session_id or e.get("session_id") != session_id:
            continue
        p, cmd, eid = e.get("pid"), str(e.get("command"))[:120], e.get("id")
        if not eid:
            continue
        if f"{eid}:stop" not in delivered:
            keys.append(f"{eid}:stop")
            notes.append(f"resource-watchdog stopped (SIGSTOP) pid {p} ({e.get('rss_mb')} MB, {cmd}), started from this session, "
                         f"at {e.get('stopped_at')} because memory pressure was {e.get('pressure_name')} (level {e.get('pressure')}). "
                         f"Resume: {e.get('resume_policy')}. To free the memory sooner, kill it yourself (`kill -9 {p}`) "
                         "and rerun it smaller; tell the user what you did.")
        if e.get("resumed_at") and f"{eid}:resume" not in delivered:
            keys.append(f"{eid}:resume")
            how = {"watchdog": "resource-watchdog resumed (SIGCONT)",
                   "exited": "resource-watchdog found exited",
                   "other": "resource-watchdog found running again (resumed outside the watchdog)"}.get(e.get("resumed_by"), "resource-watchdog closed")
            notes.append(f"{how} pid {p} ({cmd}) at {e.get('resumed_at')}.")
    return notes, keys

def delivered_path(session_id: str) -> Path | None:
    return CACHE / "delivered" / f"{session_id}.json" if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id or "") else None

def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default

def out(decision: dict):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **decision}}, ensure_ascii=False))
    sys.exit(0)

def selftest():
    e = {"id": "7@t", "pid": 7, "command": "ipsw dyld xref", "rss_mb": 900, "pressure": 2, "pressure_name": "warn",
         "stopped_at": "t", "resume_policy": "P", "resumed_at": None, "session_id": "A"}
    assert owner_notices([e], "B", set()) == ([], []), "another session must not see pid 7"
    notes, keys = owner_notices([e], "A", set())
    assert keys == ["7@t:stop"] and "pid 7" in notes[0] and "warn" in notes[0] and "Resume: P" in notes[0]
    assert owner_notices([e], "A", set(keys)) == ([], []), "a stop event is delivered once"
    notes, keys = owner_notices([{**e, "resumed_at": "u", "resumed_by": "watchdog"}], "A", {"7@t:stop"})
    assert keys == ["7@t:resume"] and "resumed (SIGCONT) pid 7" in notes[0] and "at u" in notes[0]
    assert owner_notices([{**e, "session_id": None}], "", set()) == ([], []), "an unowned stop goes to nobody"
    assert delivered_path("../x") is None
    print("ok")

def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        sys.exit(0)
    tool_input = event.get("tool_input") if isinstance(event, dict) else None
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or not cmd.strip():
        sys.exit(0)
    session_id = event.get("session_id") if isinstance(event.get("session_id"), str) else ""

    notes = []
    dpath = delivered_path(session_id)
    if dpath:
        delivered = read_json(dpath, [])
        delivered = set(delivered) if isinstance(delivered, list) else set()
        owned, keys = owner_notices(read_json(STATE, []), session_id, delivered)
        if keys:
            try:  # deliver once: a read-only home just means the notice repeats
                dpath.parent.mkdir(parents=True, exist_ok=True)
                tmp = dpath.with_suffix(".tmp")
                tmp.write_text(json.dumps(sorted(delivered | set(keys))))
                os.replace(tmp, dpath)
            except OSError:
                pass
        notes += owned
    try:  # macOS only; elsewhere (Linux, WSL) treat pressure as normal and still check load
        level = int(subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True).stdout.strip() or 1)
    except (OSError, ValueError):
        level = 1
    if level != 1:
        notes.append(f"memory pressure level {level} (1 is normal).")
    load1, cores = os.getloadavg()[0], os.cpu_count() or 1
    if load1 > cores:
        notes.append(f"load {load1:.1f} > {cores} cores.")
    if level != 1 or load1 > cores:
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

if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main()
