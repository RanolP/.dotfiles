#!/usr/bin/env python3
"""Time-budget checkpoints: the harness keeps the clock, the agent reports.

WHY THE HARNESS MEASURES: a model's own time estimate runs 3-10x off, and a
mid-task "percent done" self-report is unreliable (arXiv 2609.08589). So the
wall clock lives here, and the agent's estimate only seeds a budget after it is
scaled by a calibration factor: the p90 of actual/estimate over past units,
clamped to [1, 10]. Every declared unit logs its (estimate, actual) pair, so
the factor tracks how far off estimates really run.

WHY THIS REPORT SHAPE: at each checkpoint the agent reports verified-done items,
open items, and one next action per open item -- never a percentage. That list
relieves the late-task pull toward closing over verifying (arXiv 2609.00823).
Late checkpoints frame running out as "hand off state or ask for more time",
because "hurry up" wording produces premature done and skipped verification.

Units and their clocks:
  main thread  starts at a user UserPromptSubmit; a reply to a turn that ended
               at 5/6 or later continues the same clock with an extension.
  subagent     starts at SubagentStart; hook input carries `agent_id` only
               inside a subagent, which is how the two are told apart.
Checkpoints fire from PostToolUse at 1/3, 1/2, 2/3, 5/6, 6/6 of the budget.
A subagent's report lands in its unit file; the main thread's next PostToolUse
or UserPromptSubmit injects it so main can grant time or narrow scope. The
statusline shows the main unit's latest report.

The same file is the agent's CLI (installed as `time-budget`), because Bash
has no agent id to key on: the hook hands each unit a token to pass back.
  time-budget estimate <token> <minutes>
  time-budget report   <token> [--more <minutes>]   (report text on stdin)
  time-budget grant    <token> <minutes>

State: ~/.local/share/claude-time-budget/ (outside ~/.claude, which Claude Code
protects). Fail-open everywhere: a hook error exits 0 with no output.

Self-check: `python3 time-budget.py --selftest`.
"""
import fcntl
import json
import math
import os
import re
import sys
import time

DATA_DIR = os.environ.get("TIME_BUDGET_DIR") or os.path.expanduser(
    "~/.local/share/claude-time-budget")

# (label, fraction). The user's notation; keep exactly these five.
CHECKPOINTS = [("1/3", 1 / 3), ("1/2", 1 / 2), ("2/3", 2 / 3),
               ("5/6", 5 / 6), ("6/6", 1.0)]
IDX_FIVE_SIXTHS = 3

DEFAULT_MIN = 30.0      # budget before any estimate is declared
FLOOR_MIN = 15.0        # a scaled estimate never budgets below this
MIN_HISTORY = 5         # fewer pairs than this -> factor 1.0
HISTORY_WINDOW = 50
FACTOR_MIN, FACTOR_MAX = 1.0, 10.0
REPORT_MAX_CHARS = 1500
STALE_SESSION_S = 7 * 86400

TOKEN_PART = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

REPORT_SHAPE = (
    "Report as lists, not a percentage: Verified done (each with the check "
    "that proved it); Open; Next action, one per open item.")
STEADY = ("Then keep working at the same depth; verification stays part of "
          "the work.")


# ---------------------------------------------------------------- calibration

def calibration_factor(pairs):
    """p90 of actual/estimate over the recent pairs, clamped; 1.0 without history."""
    ratios = sorted(p["actual_min"] / p["estimate_min"]
                    for p in pairs[-HISTORY_WINDOW:]
                    if p.get("estimate_min", 0) > 0 and p.get("actual_min", -1) >= 0)
    if len(ratios) < MIN_HISTORY:
        return 1.0
    p90 = ratios[max(0, math.ceil(0.9 * len(ratios)) - 1)]
    return min(FACTOR_MAX, max(FACTOR_MIN, p90))


def budget_for(estimate_min, factor):
    if not estimate_min:
        return DEFAULT_MIN
    return max(FLOOR_MIN, estimate_min * factor)


def crossed(elapsed_s, budget_min):
    """How many checkpoints the elapsed time has passed."""
    return sum(1 for _, f in CHECKPOINTS if elapsed_s >= f * budget_min * 60)


def calibration_path():
    return os.path.join(DATA_DIR, "calibration.jsonl")


def load_pairs():
    pairs = []
    try:
        with open(calibration_path()) as fh:
            for line in fh:
                try:
                    p = json.loads(line)
                except ValueError:
                    continue
                if isinstance(p, dict):
                    pairs.append(p)
    except OSError:
        pass
    return pairs


def log_pair(unit, end_ts):
    est = unit.get("estimate_min")
    if not est:
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(calibration_path(), "a") as fh:
        fh.write(json.dumps({
            "kind": unit.get("kind"), "agent_type": unit.get("agent_type"),
            "estimate_min": est, "budget_min": unit.get("budget_min"),
            "actual_min": round((end_ts - unit["start"]) / 60, 2),
            "at": int(end_ts)}) + "\n")


# ---------------------------------------------------------------- unit files

def unit_path(session, unit):
    return os.path.join(DATA_DIR, "units", session, unit + ".json")


def parse_token(token):
    parts = token.split("/")
    if (len(parts) != 2 or not all(TOKEN_PART.match(p) for p in parts)
            or any(p in (".", "..") for p in parts)):
        raise ValueError(f"bad token {token!r}; expected <session>/<unit>")
    return parts


def read_unit(path):
    try:
        with open(path) as fh:
            u = json.load(fh)
        return u if isinstance(u, dict) else None
    except (OSError, ValueError):
        return None


def update_unit(path, fn, create=False):
    """Locked read-modify-write. fn(unit_or_None) -> new unit, None (no write),
    or False (delete). Parallel subagents and main touch these files at once."""
    if not create and not os.path.exists(path):
        return fn(None)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        raw = fh.read()
        try:
            cur = json.loads(raw) if raw.strip() else None
        except ValueError:
            cur = None
        new = fn(cur if isinstance(cur, dict) else None)
        if new is False:
            os.unlink(path)
        elif new is not None:
            fh.seek(0)
            fh.truncate()
            json.dump(new, fh)
        return new


def new_unit(kind, now, agent_type=None):
    return {"kind": kind, "agent_type": agent_type, "start": now,
            "estimate_min": None, "budget_min": DEFAULT_MIN, "fired": 0,
            "report": None, "more_min": None, "report_pending": False,
            "grant_notice": 0, "awaiting": False, "last_stop": None,
            "ended": False}


def mins(seconds):
    return f"{seconds / 60:.0f}"


# ---------------------------------------------------------------- messages

TASK_LIST_START = (
    "A plan of 2+ steps goes into TaskCreate now, so the visible task list "
    "tracks the same units this budget measures.")
TASK_LIST_MIRROR = (
    "Reflect this into the task list first: TaskUpdate each verified-done "
    "item to completed, keep each open item pending or in_progress with its "
    "next action in the description, and TaskCreate any newly discovered "
    "work.")


def start_message(token, budget, kind="sub"):
    base = (f"Time budget: {budget:.0f} min on the harness clock (token {token}). "
            f"Once scope is clear, declare your estimate: `time-budget estimate "
            f"{token} <minutes>`; the harness scales it by past accuracy.")
    if kind == "main":
        base += f" {TASK_LIST_START}"
    return base


def checkpoint_message(kind, idx, token, elapsed_s, budget):
    label = CHECKPOINTS[idx][0]
    head = f"Checkpoint {label} of the time budget ({mins(elapsed_s)}/{budget:.0f} min)."
    report = f"`time-budget report {token}` (report text as heredoc stdin)"
    if kind == "main":
        if idx < IDX_FIVE_SIXTHS:
            return (f"{head} {TASK_LIST_MIRROR} Then pipe a progress report into "
                    f"{report}; its first line shows in the user's statusline, so "
                    f"open with a one-line summary. {REPORT_SHAPE} {STEADY}")
        if idx == IDX_FIVE_SIXTHS:
            return (f"{head} Time to check in with the user. {TASK_LIST_MIRROR} "
                    f"Finish the step in hand, run `time-budget report {token} "
                    f"--more <minutes>`, then end your turn with that report and "
                    f"the extra minutes you ask for. {REPORT_SHAPE} The user "
                    f"grants by replying and the same clock continues. An open "
                    f"item with its next action is a complete report; list "
                    f"unverified items as open.")
        return (f"{head} The budget is spent, which calls for a stop and a report. "
                f"{TASK_LIST_MIRROR} Then end the turn with "
                f"{REPORT_SHAPE[0].lower()}{REPORT_SHAPE[1:]} Add the extra "
                f"minutes you would need; the user continues by replying.")
    if idx < IDX_FIVE_SIXTHS:
        return (f"{head} Pipe a progress report into {report}; the main thread "
                f"reads it. {REPORT_SHAPE} {STEADY}")
    if idx == IDX_FIVE_SIXTHS:
        return (f"{head} If the remaining work needs more time, request it: "
                f"`time-budget report {token} --more <minutes>` with the report "
                f"on stdin. {REPORT_SHAPE} Keep working meanwhile; a grant "
                f"arrives on a later tool call. Asking for time is routine, and "
                f"an open item with its next action is a complete report.")
    return (f"{head} No extension was granted, so hand off here: make your final "
            f"message {REPORT_SHAPE[0].lower()}{REPORT_SHAPE[1:]} Then stop; the "
            f"main thread picks up the open items from that list.")


def report_message(token, unit, now):
    more = f", asks +{unit['more_min']:.0f} min" if unit.get("more_min") else ""
    who = unit.get("agent_type") or "subagent"
    status = "finished" if unit.get("ended") else "running"
    text = (unit.get("report") or "")[:REPORT_MAX_CHARS]
    return (f"Subagent report ({who}, {status}, token {token}, "
            f"{mins(now - unit['start'])}/{unit['budget_min']:.0f} min{more}):\n"
            f"{text}\nGrant time with `time-budget grant {token} <minutes>`, or "
            f"narrow its scope with SendMessage.")


# ---------------------------------------------------------------- hook events

def collect_reports(session, now):
    """Take every pending subagent report in this session, once each."""
    d = os.path.join(DATA_DIR, "units", session)
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    out = []
    for name in names:
        if not name.endswith(".json") or name == "main.json":
            continue
        unit_id = name[:-5]

        def take(u, unit_id=unit_id):
            if u is None:
                return None
            if u.get("report_pending"):
                out.append(report_message(f"{session}/{unit_id}", u, now))
                u["report_pending"] = False
                return False if u.get("ended") else u
            return False if u.get("ended") else None
        update_unit(os.path.join(d, name), take)
    return out


def prune_stale(now):
    root = os.path.join(DATA_DIR, "units")
    try:
        for name in os.listdir(root):
            d = os.path.join(root, name)
            if now - os.path.getmtime(d) > STALE_SESSION_S:
                for f in os.listdir(d):
                    os.unlink(os.path.join(d, f))
                os.rmdir(d)
    except OSError:
        pass


def extension_from_prompt(prompt):
    m = re.search(r"\+(\d{1,4})\s*m", prompt or "")
    return float(m.group(1)) if m else None


def on_user_prompt(data, session, now):
    notes = []
    if data.get("source") in (None, "user", "sdk"):
        path = unit_path(session, "main")
        token = f"{session}/main"

        def begin(u):
            if u and u.get("awaiting"):
                extra = (extension_from_prompt(data.get("prompt"))
                         or u.get("more_min") or u["budget_min"] / 2)
                u["budget_min"] += extra
                u["awaiting"] = False
                u["more_min"] = None
                u["fired"] = crossed(now - u["start"], u["budget_min"])
                notes.append(
                    f"The user's reply continues the timed unit: +{extra:.0f} "
                    f"min, budget now {u['budget_min']:.0f} min "
                    f"({mins(now - u['start'])} elapsed, token {token}).")
                return u
            if u and u.get("last_stop"):
                log_pair(u, u["last_stop"])
            fresh = new_unit("main", now)
            notes.append(start_message(token, fresh["budget_min"], kind="main"))
            return fresh
        update_unit(path, begin, create=True)
        prune_stale(now)
    notes.extend(collect_reports(session, now))
    return notes


def on_subagent_start(data, session, now):
    agent_id = data.get("agent_id")
    if not agent_id or not TOKEN_PART.match(agent_id):
        return []
    u = new_unit("sub", now, data.get("agent_type"))
    update_unit(unit_path(session, agent_id), lambda _: u, create=True)
    return [start_message(f"{session}/{agent_id}", u["budget_min"])]


def on_post_tool(data, session, now):
    agent_id = data.get("agent_id")
    unit_id = agent_id if agent_id else "main"
    if not TOKEN_PART.match(unit_id):
        return []
    token = f"{session}/{unit_id}"
    notes = []

    def tick(u):
        if u is None or u.get("ended"):
            return None
        changed = False
        if u.get("grant_notice"):
            notes.append(f"The main thread granted +{u['grant_notice']:.0f} min; "
                         f"budget is now {u['budget_min']:.0f} min "
                         f"({mins(now - u['start'])} elapsed). Continue.")
            u["grant_notice"] = 0
            changed = True
        n = crossed(now - u["start"], u["budget_min"])
        if n > u.get("fired", 0):
            notes.append(checkpoint_message(u["kind"], n - 1, token,
                                            now - u["start"], u["budget_min"]))
            u["fired"] = n
            changed = True
        return u if changed else None
    update_unit(unit_path(session, unit_id), tick)
    if not agent_id:
        notes.extend(collect_reports(session, now))
    return notes


def on_stop(session, now):
    def mark(u):
        if u is None:
            return None
        u["last_stop"] = now
        u["awaiting"] = u.get("fired", 0) > IDX_FIVE_SIXTHS
        return u
    update_unit(unit_path(session, "main"), mark)
    return []


def on_subagent_stop(data, session, now):
    agent_id = data.get("agent_id")
    if not agent_id or not TOKEN_PART.match(agent_id):
        return []

    def end(u):
        if u is None or u.get("ended"):
            return None
        log_pair(u, now)
        u["ended"] = True
        return u if u.get("report_pending") else False
    update_unit(unit_path(session, agent_id), end)
    return []


def handle(data, now=None):
    """Returns the (event, text) to inject, or None."""
    now = time.time() if now is None else now
    event = data.get("hook_event_name")
    session = data.get("session_id")
    if not isinstance(session, str) or not TOKEN_PART.match(session):
        return None
    if event == "UserPromptSubmit" and not data.get("agent_id"):
        notes = on_user_prompt(data, session, now)
    elif event == "SubagentStart":
        notes = on_subagent_start(data, session, now)
    elif event == "PostToolUse":
        notes = on_post_tool(data, session, now)
    elif event == "Stop" and not data.get("agent_id"):
        notes = on_stop(session, now)
    elif event == "SubagentStop":
        notes = on_subagent_stop(data, session, now)
    else:
        return None
    return (event, "\n\n".join(notes)) if notes else None


def hook_main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(data, dict):
            sys.exit(0)
        out = handle(data)
    except Exception:
        sys.exit(0)
    if out and out[0] in ("UserPromptSubmit", "SubagentStart", "PostToolUse"):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": out[0], "additionalContext": out[1]}}))
    sys.exit(0)


# ---------------------------------------------------------------- CLI

def cli(argv):
    usage = ("usage: time-budget estimate <token> <minutes> | "
             "report <token> [--more <minutes>] (stdin) | grant <token> <minutes>")
    if len(argv) < 2:
        print(usage, file=sys.stderr)
        return 2
    cmd, token, rest = argv[0], argv[1], argv[2:]
    try:
        session, unit_id = parse_token(token)
    except ValueError as e:
        print(f"time-budget: {e}", file=sys.stderr)
        return 2
    path = unit_path(session, unit_id)
    now = time.time()
    if not os.path.exists(path):
        print(f"time-budget: no active unit for token {token} at {path}",
              file=sys.stderr)
        return 1
    try:
        if cmd == "estimate" and len(rest) == 1:
            est = float(rest[0])
            factor = calibration_factor(load_pairs())

            def set_est(u):
                u["estimate_min"] = est
                u["budget_min"] = budget_for(est, factor)
                u["fired"] = crossed(now - u["start"], u["budget_min"])
                return u
            u = update_unit(path, set_est)
            print(f"budget {u['budget_min']:.0f} min (estimate {est:g} x "
                  f"calibration {factor:.2f}, floor {FLOOR_MIN:.0f}); "
                  f"{mins(now - u['start'])} min elapsed")
            return 0
        if cmd == "report":
            more = None
            if rest[:1] == ["--more"] and len(rest) == 2:
                more = float(rest[1])
            elif rest:
                print(usage, file=sys.stderr)
                return 2
            text = sys.stdin.read().strip()
            if not text:
                print("time-budget: empty report; pipe it on stdin", file=sys.stderr)
                return 2

            def set_report(u):
                u["report"] = text
                u["more_min"] = more
                u["report_pending"] = u["kind"] == "sub"
                return u
            update_unit(path, set_report)
            print("report recorded" + (f", +{more:g} min requested" if more else ""))
            return 0
        if cmd == "grant" and len(rest) == 1:
            extra = float(rest[0])

            def grant(u):
                u["budget_min"] += extra
                u["grant_notice"] = u.get("grant_notice", 0) + extra
                u["more_min"] = None
                u["fired"] = crossed(now - u["start"], u["budget_min"])
                return u
            u = update_unit(path, grant)
            print(f"granted +{extra:g} min; budget {u['budget_min']:.0f} min")
            return 0
    except (ValueError, OSError) as e:
        print(f"time-budget: {cmd} failed: {e}", file=sys.stderr)
        return 1
    print(usage, file=sys.stderr)
    return 2


# ---------------------------------------------------------------- self-check

def selftest():
    import tempfile
    global DATA_DIR
    DATA_DIR = tempfile.mkdtemp(prefix="time-budget-selftest-")

    # Regression: a raw estimate is trusted as-is. History that ran 3x over
    # must scale the next budget ~3x; no history keeps 1.0 behind the floor.
    assert calibration_factor([]) == 1.0
    assert budget_for(5, 1.0) == FLOOR_MIN and budget_for(None, 1.0) == DEFAULT_MIN
    hist = [{"estimate_min": 10, "actual_min": 30}] * 9 + [{"estimate_min": 10, "actual_min": 5}]
    assert calibration_factor(hist) == 3.0
    assert calibration_factor([{"estimate_min": 1, "actual_min": 99}] * 9) == FACTOR_MAX
    assert calibration_factor([{"estimate_min": 10, "actual_min": 2}] * 9) == FACTOR_MIN

    # Regression: checkpoints drift from the user's fractions or re-fire.
    assert [c[0] for c in CHECKPOINTS] == ["1/3", "1/2", "2/3", "5/6", "6/6"]
    assert crossed(9 * 60, 30) == 0 and crossed(10 * 60, 30) == 1
    assert crossed(25 * 60, 30) == 4 and crossed(30 * 60, 30) == 5

    s, t0 = "sess1", 1_000_000.0
    ev = lambda **kw: {"session_id": s, **kw}
    out = handle(ev(hook_event_name="UserPromptSubmit", prompt="go"), t0)
    assert out and f"{s}/main" in out[1]
    assert handle(ev(hook_event_name="PostToolUse"), t0 + 60) is None
    out = handle(ev(hook_event_name="PostToolUse"), t0 + 21 * 60)  # jumps past 1/3 and 1/2
    assert "Checkpoint 2/3" in out[1] and "Checkpoint 1/3" not in out[1]
    assert handle(ev(hook_event_name="PostToolUse"), t0 + 22 * 60) is None

    # Regression: late checkpoints read as "finish now" instead of report/extension.
    late = checkpoint_message("sub", IDX_FIVE_SIXTHS, "a/b", 1500, 30)
    assert "--more" in late and "hurry" not in late.lower()

    # Regression: main's 5/6 stop + user reply restarts the clock and loses the grant.
    handle(ev(hook_event_name="PostToolUse"), t0 + 26 * 60)
    handle(ev(hook_event_name="Stop"), t0 + 27 * 60)
    out = handle(ev(hook_event_name="UserPromptSubmit", prompt="ok +20m"), t0 + 28 * 60)
    assert "+20 min" in out[1] and read_unit(unit_path(s, "main"))["start"] == t0

    # Regression: a subagent's report never reaches main, or a grant re-fires 6/6.
    handle(ev(hook_event_name="SubagentStart", agent_id="ag1", agent_type="x"), t0)
    handle(ev(hook_event_name="PostToolUse", agent_id="ag1"), t0 + 31 * 60)
    u = update_unit(unit_path(s, "ag1"), lambda u: {**u, "report": "Open: y", "more_min": 10,
                                                   "report_pending": True})
    out = handle(ev(hook_event_name="PostToolUse"), t0 + 31 * 60)
    assert "asks +10 min" in out[1] and "Open: y" in out[1]
    assert handle(ev(hook_event_name="PostToolUse"), t0 + 31 * 60 + 1) is None  # consumed once
    assert cli(["grant", f"{s}/ag1", "20"]) == 0
    out = handle(ev(hook_event_name="PostToolUse", agent_id="ag1"), time.time())
    assert out and "granted +20" in out[1]

    # Regression: finished units never feed calibration.
    handle(ev(hook_event_name="SubagentStop", agent_id="ag1"), t0 + 40 * 60)
    assert not load_pairs()  # no declared estimate -> no pair
    handle(ev(hook_event_name="SubagentStart", agent_id="ag2"), t0)
    assert cli(["estimate", f"{s}/ag2", "10"]) == 0
    handle(ev(hook_event_name="SubagentStop", agent_id="ag2"), t0 + 30 * 60)
    assert load_pairs()[-1]["actual_min"] == 30.0

    assert cli(["estimate", "../x", "1"]) == 2  # token cannot escape DATA_DIR
    print("time-budget selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))
    else:
        hook_main()
