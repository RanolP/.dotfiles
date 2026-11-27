#!/usr/bin/env python3
# Records every shell the Bash tool forks from one claude process, so the resources mod can say which worker started a
# detached job. A job keeps its shell's process group after the shell exits (measured 2026-11-27: shell 48496 -> orphan
# sleep ppid 1 pgid 48496), so one {pid, pgid, argv} line per shell, written while the shell still runs, is the whole tag.
# Usage: fork-tracker.py <claude pid> <ledger path>. One instance per claude pid (flock); exits when claude exits.
import ctypes, fcntl, json, os, select, sys, time

NEEDLE = "eval '"  # Claude Code runs a Bash call as: zsh -c "source <snapshot> ... && eval '<command>' < /dev/null && pwd -P ..."
MAX_LEDGER = 4_000_000

libc = ctypes.CDLL('/usr/lib/libc.dylib', use_errno=True)
libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)

def children(ppid):
    need = libproc.proc_listpids(6, ppid, None, 0)  # PROC_PPID_ONLY
    if need <= 0:
        return []
    buf = (ctypes.c_int * (need // 4 + 64))()
    got = libproc.proc_listpids(6, ppid, buf, ctypes.sizeof(buf))
    return [buf[i] for i in range(max(got, 0) // 4) if buf[i] > 0]

def argv_of(pid):
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 8:
        return None
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return None
    raw = buf.raw[:size.value]
    argc = int.from_bytes(raw[:4], 'little')
    rest = raw[4:]
    end = rest.find(b'\0')
    if end < 0:
        return None
    i = end
    while i < len(rest) and rest[i] == 0:
        i += 1
    return [p.decode('utf-8', 'replace') for p in rest[i:].split(b'\0')[:argc]]

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def main():
    claude = int(sys.argv[1])
    ledger = sys.argv[2]
    directory = os.path.dirname(ledger)
    os.makedirs(directory, exist_ok=True)
    lock = open(ledger + '.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # another tracker already serves this claude pid
    for name in os.listdir(directory):  # ledgers of claude processes that are gone
        stem = name.split('.')[0]
        if stem.isdigit() and int(stem) != claude and not alive(int(stem)):
            for suffix in ('.jsonl', '.jsonl.lock'):
                try: os.unlink(os.path.join(directory, stem + suffix))
                except OSError: pass
    out = open(ledger, 'a', buffering=1)
    out.write(json.dumps({'claudePgid': os.getpgid(claude)}) + '\n')  # a worker's job must never be signalled through claude's own group

    def record(pid, argv):
        try: pgid = os.getpgid(pid)
        except OSError: return False
        if os.fstat(out.fileno()).st_size > MAX_LEDGER:
            out.truncate(0)
        out.write(json.dumps({'pid': pid, 'pgid': pgid, 'argv': argv, 't': int(time.time() * 1000)}) + '\n')
        return True

    kq = select.kqueue()
    ev = lambda pid, flags: select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_CLEAR, flags)
    kq.control([ev(claude, select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT)], 0)
    watched = set()
    done = set()

    def inspect(pid):
        if pid in done: return
        argv = argv_of(pid)
        if argv and any(NEEDLE in part for part in argv) and record(pid, argv):
            done.add(pid)

    def scan():
        for pid in children(claude):
            if pid in watched:
                inspect(pid)
                continue
            inspect(pid)  # read at the fork itself: a fast shell may exit before the watch below is placed
            watched.add(pid)
            try: kq.control([ev(pid, select.KQ_NOTE_EXEC | select.KQ_NOTE_EXIT)], 0)
            except OSError: watched.discard(pid); continue
            inspect(pid)  # closes the gap between the first read and the watch (exec in between)

    scan()
    while alive(claude):
        for event in kq.control(None, 64, 2.0):
            if event.ident == claude:
                if event.fflags & select.KQ_NOTE_EXIT: return
                scan()
            elif event.fflags & select.KQ_NOTE_EXEC:
                inspect(event.ident)
            if event.ident != claude and event.fflags & select.KQ_NOTE_EXIT:
                watched.discard(event.ident); done.discard(event.ident)
        if len(watched) > 4000: watched.clear(); done.clear()

main()
