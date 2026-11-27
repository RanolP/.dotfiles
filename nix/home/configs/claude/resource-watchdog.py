#!/usr/bin/env python3
"""Freeze the biggest agent-spawned process when macOS memory pressure leaves normal, and resume it once pressure
has stayed normal. Incident: 2026-11-23, three parallel `ipsw dyld xref` on a 5.8GB dyld cache panicked the Mac.
Looks only at memory, never at command names: whatever an agent runs is covered.
Each stop is recorded with the Claude Code session that owns the process, so the resources mod tells that session
alone what was stopped, why, and when it resumes."""
import glob, json, os, re, signal, subprocess, time
from pathlib import Path

STATE = Path.home() / ".cache/claude-resource-watchdog/stopped.json"
AGENTS = {"claude", "codex", "agy"}
SHELLS = {"bash", "zsh", "sh", "dash", "fish"}
WARN = 2  # kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
LEVELS = {1: "normal", 2: "warn", 4: "critical"}
# Resume: after pressure has read normal on every tick for RESUME_AFTER_S, SIGCONT the oldest still-stopped pid,
# then wait a fresh full window before the next one, so each resumed process shows its effect on pressure first.
RESUME_AFTER_S = 60
RESUME_POLICY = (f"resource-watchdog resumes it (SIGCONT) once memory pressure has stayed normal for {RESUME_AFTER_S} s, "
                 "oldest-stopped first, one process per window")
ORPHAN_MIN_RSS_KB = 512 * 1024  # a detached job below this is never frozen
KEEP = 50  # state entries kept; older closed ones are dropped
# Claude Code writes <config dir>/sessions/<claude pid>.json with "sessionId" (seen in 2.1.327); the config dir is
# CLAUDE_CONFIG_DIR, which launchd does not pass here, so every ~/.claude* dir is tried.
SESSION_GLOB = str(Path.home() / ".claude*/sessions/{pid}.json")

def pressure() -> int:
    out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True).stdout
    return int(out.strip() or 1)

def processes() -> dict[int, tuple[int, int, str, str]]:
    procs = {}
    for line in subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,rss=,stat=,command="], capture_output=True, text=True).stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            procs[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[3], parts[4])
    return procs

def is_agent(cmd: str) -> bool:
    return os.path.basename(cmd.split()[0]) in AGENTS if cmd.split() else False

def is_shell(cmd: str) -> bool:
    return os.path.basename(cmd.split()[0]).lstrip("-") in SHELLS if cmd.split() else False

def claude_env_pids() -> set[int]:
    """Pids whose environment carries CLAUDECODE=1, which Claude Code sets for its shell tool and every child
    inherits, even after the parent exits and launchd adopts the child (ps -E shows a same-user env)."""
    out = subprocess.run(["/bin/ps", "-axwwE", "-o", "pid=,command="], capture_output=True, text=True).stdout
    return {int(line.split(None, 1)[0]) for line in out.splitlines() if " CLAUDECODE=1" in line}

def agent_id_in_env(ps_line: str) -> str | None:
    """The worker (subagent) id the resources mod exports as CLAUDE_AGENT_ID in that worker's shell; None for main."""
    m = re.search(r" CLAUDE_AGENT_ID=([A-Za-z0-9_-]+)(?:\s|$)", ps_line)
    return m.group(1) if m else None

def agent_id_of(pid: int) -> str | None:
    out = subprocess.run(["/bin/ps", "-wwE", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
    return agent_id_in_env(out)

def agent_children(procs: dict, tagged: set[int] = frozenset()) -> list[tuple[int, int, str, str]]:
    """Stop candidates: jobs an agent started through its shell tool, i.e. a non-shell process with a shell between
    it and the nearest agent root. Agent infrastructure has no shell ancestor and is never a candidate: 2026-11-23
    the watchdog froze this session's hetero-subagents codex bridge repeatedly, dropping the codex worker.
    A job detached with `cmd &` from a shell that then exits has no agent ancestor at all, so it is a candidate
    when its env is tagged (`tagged`): 2026-11-27 an agent's launch.sh backgrounded an IndexTTS-2 MPS run, launchd
    adopted it, the watchdog froze a 1 MB eza instead, and the Mac hung into a hardware watchdog reset."""
    roots = {p for p, (_, _, _, cmd) in procs.items() if is_agent(cmd)}
    def shell_job(pid: int) -> bool:
        seen, shell = set(), False
        start = pid
        while pid in procs and pid not in seen:
            seen.add(pid)
            pid = procs[pid][0]
            if pid in roots:
                return shell
            shell = shell or (pid in procs and is_shell(procs[pid][3]))
        # No agent above it: an orphaned job, if a Claude Code shell started it and it is big enough to matter.
        # The floor keeps out daemons a session spawned in passing (keyboxd, gpg-agent from a signed commit are
        # tagged too, and freezing keyboxd breaks signing for every session).
        return start in tagged and procs[start][1] >= ORPHAN_MIN_RSS_KB
    return [(p, rss, stat, cmd) for p, (_, rss, stat, cmd) in procs.items()
            if p not in roots and not is_shell(cmd) and shell_job(p)]

def session_of(claude_pid: int, pattern: str = SESSION_GLOB) -> dict | None:
    for path in glob.glob(pattern.format(pid=claude_pid)):
        try:
            data = json.loads(Path(path).read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("pid") == claude_pid and isinstance(data.get("sessionId"), str):
            return data
    return None

def owner(pid: int, procs: dict, lookup=session_of) -> dict:
    """The nearest ancestor claude process that has a session file. A codex or agy bridge under a claude session
    is walked through, so the claude session that spawned it owns its children."""
    seen = set()
    while pid in procs and pid not in seen:
        seen.add(pid)
        pid = procs[pid][0]
        cmd = procs.get(pid, (0, 0, "", ""))[3]
        if cmd.split() and os.path.basename(cmd.split()[0]) == "claude":
            s = lookup(pid)
            if s:
                return {"session_id": s["sessionId"], "claude_pid": pid, "cwd": s.get("cwd")}
    return {"session_id": None, "claude_pid": None, "cwd": None}

def lstart(pid: int) -> str:
    return subprocess.run(["/bin/ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()

def load() -> list:
    try:
        data = json.loads(STATE.read_text())
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []

def save(entries: list):
    closed = [e for e in entries if e.get("resumed_at")]
    entries = closed[-KEEP:] + [e for e in entries if not e.get("resumed_at")]
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")  # the resources mod reads this on every Bash call: never let it see half a file
    tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=1))
    os.replace(tmp, STATE)

def now() -> str:
    return time.strftime("%FT%T%z")

def notify(msg: str):
    subprocess.run(["/usr/bin/osascript", "-e", f"display notification {json.dumps(msg)} with title \"claude resource watchdog\""])

def stop_one(level: int, procs: dict) -> dict | None:
    kids = agent_children(procs, claude_env_pids())
    # At warn, freeze one process and then wait: while any agent child is already stopped (ps stat "T"), stop
    # nothing more. Measured 2026-11-23: skipping only the stopped one made each 2 s tick freeze the next-largest
    # child, and 12 MCP servers and codex bridges of other sessions were frozen within 25 s while pressure stayed
    # at warn. The same run showed SIGSTOP alone left pressure at warn for 98 s; only SIGKILL returned it to normal.
    # The watchdog still never kills, on the user's order (2026-11-23): the resources mod tells the owning agent,
    # which may kill it itself; otherwise the watchdog resumes it (RESUME_POLICY).
    if not kids or any(k[2].startswith("T") for k in kids):
        return None
    pid, rss, _, cmd = max(kids, key=lambda k: k[1])
    started = lstart(pid)
    agent_id = agent_id_of(pid)
    try:
        os.kill(pid, signal.SIGSTOP)
    except OSError:  # exited since ps ran
        return None
    at = now()
    entry = {"id": f"{pid}@{at}", "pid": pid, "lstart": started, "command": cmd[:300], "rss_mb": rss // 1024,
             "pressure": level, "pressure_name": LEVELS.get(level, str(level)), "stopped_at": at,
             "resume_policy": RESUME_POLICY, "resumed_at": None, "resumed_by": None, "agent_id": agent_id, **owner(pid, procs)}
    notify(f"SIGSTOP {pid} ({rss // 1024} MB): {cmd[:80]}")
    return entry

def adopt_legacy(e: dict, pid: int):
    """An entry written before owners were recorded (08bfc3e) has only "at": adopt it for resuming when the live
    pid started before that stop, so it is the process that was frozen and not a reused pid."""
    started = lstart(pid)
    try:
        before = time.mktime(time.strptime(started, "%a %b %d %H:%M:%S %Y")) <= time.mktime(time.strptime(e["at"], "%Y-%m-%dT%H:%M:%S%z"))
    except ValueError:
        return
    if before:
        e.update(id=f"{pid}@{e['at']}", lstart=started, stopped_at=e["at"], resume_policy=RESUME_POLICY, resumed_at=None, session_id=None)

def close_settled(entries: list, procs: dict):
    """Close entries whose process is no longer the stopped one we froze: exited, resumed by the agent, or a reused pid."""
    for e in entries:
        if e.get("resumed_at"):
            continue
        p = e.get("pid")
        if not e.get("lstart") and isinstance(p, int) and p in procs and isinstance(e.get("at"), str):
            adopt_legacy(e, p)
        alive = isinstance(p, int) and p in procs and e.get("lstart") and lstart(p) == e.get("lstart")
        if not alive:
            e.update(resumed_at=now(), resumed_by="exited")
        elif not procs[p][2].startswith("T"):
            e.update(resumed_at=now(), resumed_by="other")

def resume_oldest(entries: list) -> dict | None:
    waiting = [e for e in entries if not e.get("resumed_at")]
    if not waiting:
        return None
    e = min(waiting, key=lambda e: e.get("stopped_at") or "")
    try:
        os.kill(e["pid"], signal.SIGCONT)
    except OSError:
        e.update(resumed_at=now(), resumed_by="exited")
        return e
    e.update(resumed_at=now(), resumed_by="watchdog")
    notify(f"SIGCONT {e['pid']}: {str(e.get('command'))[:80]}")
    return e

def main():
    normal_since = None
    while True:
        level = pressure()
        procs = processes()
        entries = load()
        before = json.dumps(entries)
        close_settled(entries, procs)
        if level >= WARN:
            normal_since = None
            entry = stop_one(level, procs)
            if entry:
                entries.append(entry)
        else:
            normal_since = normal_since or time.monotonic()
            if time.monotonic() - normal_since >= RESUME_AFTER_S and resume_oldest(entries):
                normal_since = time.monotonic()  # a fresh full window before the next resume
        if json.dumps(entries) != before:
            save(entries)
        time.sleep(2)

if __name__ == "__main__":
    main()
