#!/usr/bin/env python3
"""Fullscreen progress panel for `rebuild` on Windows.

    uv run --with textual python xpkg/utils/panel.py <events-file> -- <command...>

Starts <command> as a child with stdout and stderr in a .log beside the
events file (events.jsonl -> events.log) and XPKG_EVENTS=<events-file> in its
environment, tails the JSON lines the child appends there
(xpkg/utils/events.nu), and draws a timeline of every unit that never
scrolls. When the child exits the panel closes on its own, prints only the
failures, reboot notices and a summary line
to the normal screen, and exits with the child's code. Ctrl+C kills the
child's process tree and exits 130.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import Static

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
SPINNER = "|/-\\"
GREEN, YELLOW, RED, CYAN, DIM = "#5fd75f", "#d7d75f", "#ff5f87", "#5fd7d7", "#808080"
STATUS_COLOR = {"done": GREEN, "running": YELLOW, "failed": RED, "waiting": DIM}
LABEL_WIDTH = 26
SECS_WIDTH = 8


def clean(line: str) -> str:
    return ANSI.sub("", line).replace("\r", "").rstrip()


@dataclass
class Unit:
    name: str
    status: str = "waiting"
    start: float | None = None
    end: float | None = None
    exit_code: int | None = None
    output: str = ""


@dataclass
class Group:
    name: str
    status: str = "waiting"
    start: float | None = None
    end: float | None = None
    units: dict[str, Unit] = field(default_factory=dict)


class State:
    """Everything the panel shows, built only from the events."""

    def __init__(self) -> None:
        self.groups: dict[str, Group] = {}
        self.notices: list[str] = []

    def group(self, name: str) -> Group:
        if name not in self.groups:
            self.groups[name] = Group(name, status="running")
        return self.groups[name]

    def unit(self, group: str, name: str) -> Unit:
        units = self.group(group).units
        if name not in units:
            units[name] = Unit(name)
        return units[name]

    def apply(self, ev: dict) -> None:
        kind, t = ev.get("ev"), float(ev.get("t", time.time()))
        if kind == "group_start":
            g = self.group(ev["group"])
            g.status, g.start = "running", t
        elif kind == "group_end":
            g = self.group(ev["group"])
            g.status, g.end = ("done" if ev.get("ok") else "failed"), t
            # A unit still running when its group ended never reported back.
            for u in g.units.values():
                if u.status == "running":
                    u.status, u.end = "failed", t
        elif kind == "unit_wait":
            self.unit(ev["group"], ev["unit"])
        elif kind == "unit_start":
            u = self.unit(ev["group"], ev["unit"])
            u.status, u.start = "running", t
        elif kind == "unit_end":
            u = self.unit(ev["group"], ev["unit"])
            u.exit_code = int(ev.get("exit_code", 1))
            u.status = "done" if u.exit_code == 0 else "failed"
            u.end = t
            if u.start is None:
                u.start = t - float(ev.get("secs", 0))
            u.output = ev.get("output") or ""
            for line in u.output.splitlines():
                line = clean(line).strip()
                if line.startswith(("++", "[!]")) and "reboot" in line.lower() and line not in self.notices:
                    self.notices.append(line)

    def all_units(self) -> list[tuple[str, Unit]]:
        return [(g.name, u) for g in self.groups.values() for u in g.units.values()]

    def counts(self) -> dict[str, int]:
        c = {"done": 0, "running": 0, "waiting": 0, "failed": 0}
        for _, u in self.all_units():
            c[u.status] += 1
        return c

    def summary_line(self) -> str:
        c = self.counts()
        return f"√ {c['done']} done  {c['running']} running  {c['waiting']} waiting  × {c['failed']} failed"

    def failed(self) -> list[tuple[str, Unit]]:
        return [(g, u) for g, u in self.all_units() if u.status == "failed"]


def marker(status: str, frame: int) -> Text:
    sym = {"done": "√", "failed": "×", "waiting": " ", "running": SPINNER[frame % len(SPINNER)]}[status]
    return Text.assemble("[", (sym, f"bold {STATUS_COLOR[status]}"), "] ")


def secs(u: Unit | Group, now: float) -> str:
    if u.start is None:
        return ""
    return f"{(u.end or now) - u.start:.1f}s"


def completion_order(u: Unit) -> tuple[int, float]:
    """Sort key: finished units in the order they finished, then running units
    in the order they started, then waiting units (a stable sort keeps their
    declared order)."""
    if u.end is not None:
        return 0, u.end
    if u.start is not None:
        return 1, u.start
    return 2, 0.0


def bar(start: float, end: float, width: int) -> str:
    """A thin line from `start` to `end` (fractions of the run) at half-cell
    resolution: "━" fills a cell, "╺" and "╸" fill its right or left half.
    Never empty, so a sub-second unit still shows a stub."""
    halves = width * 2
    a = min(int(start * halves), halves - 1)
    b = min(max(a + 1, round(end * halves)), halves)
    out = []
    for c in range(width):
        left, right = a <= 2 * c < b, a <= 2 * c + 1 < b
        out.append("━" if left and right else "╸" if left else "╺" if right else " ")
    return "".join(out)


def render_timeline(state: State, width: int, frame: int, now: float) -> tuple[list[Text], Text | None, int | None]:
    """One row per unit in `completion_order` -- marker, name, bar, seconds;
    a waiting unit has no bar yet -- the axis row, and the index of the first
    unfinished row (None once everything has finished)."""
    units = sorted(state.all_units(), key=lambda gu: completion_order(gu[1]))
    if not units:
        return [Text("waiting for the first event…", style=DIM)], None, None
    started = [u for _, u in units if u.start is not None]
    t0 = min((u.start for u in started), default=now)
    t1 = max(((u.end or now) for u in started), default=now)
    span = max(t1 - t0, 1.0)
    bar_width = max(width - 4 - LABEL_WIDTH - SECS_WIDTH, 10)
    rows: list[Text] = []
    active = None
    for i, (_, u) in enumerate(units):
        if active is None and u.status in ("running", "waiting"):
            active = i
        line = " " * bar_width
        if u.start is not None:
            line = bar((u.start - t0) / span, ((u.end or now) - t0) / span, bar_width)
        rows.append(Text.assemble(
            marker(u.status, frame),
            (f"{u.name[:LABEL_WIDTH - 1]:<{LABEL_WIDTH}}", STATUS_COLOR[u.status] if u.status != "done" else ""),
            (line, STATUS_COLOR[u.status]),
            (f"{secs(u, now):>{SECS_WIDTH}}", DIM),
        ))
    end_label = f"{span:.0f}s"
    axis = Text(" " * (4 + LABEL_WIDTH) + "0s".ljust(bar_width - len(end_label)) + end_label, style=DIM)
    return rows, axis, active


def window(rows: list[Text], height: int, active: int | None = None, header: int | None = None) -> list[Text]:
    """The rows that fit in `height`, so no box ever needs a scrollbar. With
    `active`, finished rows above it slide out the top and the active row
    sits near the top under its pinned group `header`; without it the tail
    shows (everything finished, or a newest-last list)."""
    height = max(height, 1)
    if len(rows) <= height:
        return rows
    if active is None:
        return rows[-height:]
    start = active - 1 if header == active - 1 else active
    start = max(0, min(start, len(rows) - height))
    if header is not None and header < start:
        return [rows[header]] + rows[start : start + height - 1]
    return rows[start : start + height]


def fit(rows: list[Text], width: int) -> Text:
    """Rows joined into one Text, each cut to `width` so nothing wraps."""
    out = Text(no_wrap=True, overflow="ellipsis")
    for i, row in enumerate(rows):
        row = row.copy()
        row.truncate(max(width, 1), overflow="ellipsis")
        if i:
            out.append("\n")
        out.append_text(row)
    return out


def render_summary(state: State) -> Text:
    c = state.counts()
    return Text.assemble(
        ("√ ", f"bold {GREEN}"), f"{c['done']} done  ",
        (f"{c['running']} running", YELLOW), "  ",
        (f"{c['waiting']} waiting", DIM), "  ",
        ("× ", f"bold {RED}"), (f"{c['failed']} failed", RED if c["failed"] else ""),
    )


class Panel(App):
    CSS = f"""
    /* Nothing scrolls: every box gets a fixed share of the screen and
       window() picks the rows that fit it. */
    * {{ overflow: hidden hidden; scrollbar-size: 0 0; }}
    Screen {{ background: #121212; color: #d0d0d0; layout: vertical; }}
    #header {{ height: 1; background: #1c1c1c; padding: 0 1; }}
    #footer {{ height: 2; background: #1c1c1c; padding: 0 1; }}
    #body {{ height: 1fr; padding: 0 1; }}
    .box {{ border: round {DIM}; border-title-color: {CYAN}; padding: 0 1; }}
    #timeline {{ height: 1fr; }}
    """
    BINDINGS = [
        Binding("ctrl+c", "abort", "abort", show=False, priority=True),
    ]

    def __init__(self, events: Path, command: list[str]) -> None:
        super().__init__()
        self.events = events
        self.log_path = events.with_suffix(".log")
        self.command = command
        self.state = State()
        self.proc: subprocess.Popen | None = None
        self.child_code: int | None = None
        self.offset = 0
        self.partial = b""
        self.frame = 0
        self.started = time.time()
        self.finished: float | None = None

    def compose(self) -> ComposeResult:
        yield Static(id="header")
        with Vertical(id="body"):
            yield Static(id="timeline", classes="box")
        yield Static(id="footer")

    def on_mount(self) -> None:
        self.query_one("#timeline").border_title = "Timeline"
        self.events.parent.mkdir(parents=True, exist_ok=True)
        self.events.touch()
        env = dict(os.environ, XPKG_EVENTS=str(self.events))
        # xpkg/install.nu reads an existing log as "the child started", and
        # without one falls back to the plain path, so the log exists only
        # once Popen has succeeded.
        self.log_file = open(self.log_path, "wb")
        try:
            self.proc = subprocess.Popen(
                self.command, stdin=subprocess.DEVNULL, stdout=self.log_file, stderr=subprocess.STDOUT, env=env
            )
        except OSError:
            self.log_file.close()
            self.log_path.unlink(missing_ok=True)
            raise
        self.tick()
        self.set_interval(0.25, self.tick)

    def read_events(self) -> None:
        try:
            with open(self.events, "rb") as f:
                f.seek(self.offset)
                chunk = f.read()
        except FileNotFoundError:
            return
        self.offset += len(chunk)
        *lines, self.partial = (self.partial + chunk).split(b"\n")
        for line in lines:
            if line.strip():
                try:
                    self.state.apply(json.loads(line))
                except (ValueError, KeyError) as e:
                    self.log_file.write(f"panel: bad event {line!r}: {e}\n".encode())

    def tick(self) -> None:
        self.read_events()
        if self.child_code is None and self.proc is not None and self.proc.poll() is not None:
            self.child_code = self.proc.returncode
            self.finished = time.time()
            self.read_events()
            # The panel closes with the run; main() then prints the plain
            # lines to the normal screen.
            self.exit(self.child_code)
            return
        self.frame += 1
        self.redraw()

    def redraw(self) -> None:
        now = time.time()
        width = self.size.width or 100
        elapsed = f"{(self.finished or now) - self.started:.1f}s"
        title = "xpkg rebuild"
        self.query_one("#header", Static).update(
            Text.assemble((title, f"bold {CYAN}"), " " * max(width - 2 - len(title) - len(elapsed), 1), (elapsed, "bold"))
        )
        tl_width, tl_height = self.inner("#timeline")
        bars, axis, active = render_timeline(self.state, tl_width, self.frame, now)
        self.show("#timeline", bars[:1] if axis is None else window(bars, tl_height - 1, active) + [axis])
        hint = Text(f"\nlog {self.log_path}  ctrl+c aborts", style=DIM)
        self.query_one("#footer", Static).update(fit([render_summary(self.state), hint[1:]], width - 2))

    def inner(self, selector: str) -> tuple[int, int]:
        """A box's content (width, height); before the first layout, a guess
        from the screen size."""
        size = self.query_one(selector).content_size
        if size.width and size.height:
            return size.width, size.height
        return max(self.size.width // 2 - 4, 20), max(self.size.height // 3, 3)

    def show(self, selector: str, rows: list[Text]) -> None:
        self.query_one(selector, Static).update(fit(rows, self.inner(selector)[0]))

    def on_resize(self) -> None:
        # Box sizes are known only after the layout pass the resize triggers.
        self.call_after_refresh(self.redraw)

    def action_abort(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            kill_tree(self.proc)
        self.exit(130)

    def on_unmount(self) -> None:
        if hasattr(self, "log_file"):
            self.log_file.close()


def kill_tree(proc: subprocess.Popen) -> None:
    # TerminateProcess stops only nu itself; its winget/msiexec children
    # would keep running, so take the whole tree.
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()
    proc.wait()


def plain_summary(app: Panel) -> str:
    """What stays on the normal screen once the panel closes: failures,
    notices and one summary line; no per-unit progress."""
    s = app.state
    lines = []
    for group, u in s.failed():
        code = "no exit code" if u.exit_code is None else f"exit {u.exit_code}"
        lines.append(f"!! {group}/{u.name} {code}")
        tail = [clean(line) for line in u.output.splitlines() if clean(line).strip()][-4:]
        lines += [f"      {line}" for line in tail]
    lines += s.notices
    c = s.counts()
    total = (app.finished or time.time()) - app.started
    lines.append(f"√ {c['done']} done  × {c['failed']} failed  {total:.1f}s")
    if c["failed"]:
        lines.append(f"log: {app.log_path}")
    return "\n".join(lines)


def selftest() -> None:
    import io
    import tempfile

    # (a) A unit whose process died without a unit_end must not stay
    # "running" forever once its group has ended.
    s = State()
    s.apply({"ev": "group_start", "group": "G", "t": 1.0})
    s.apply({"ev": "unit_start", "group": "G", "unit": "u", "t": 1.0})
    s.apply({"ev": "group_end", "group": "G", "ok": False, "t": 2.0})
    assert s.groups["G"].units["u"].status == "failed", s.groups["G"].units["u"]
    assert s.summary_line().endswith("× 1 failed"), s.summary_line()

    # (b) A line the child is still writing when the panel reads must be kept
    # until its newline arrives, then applied exactly once, not dropped or
    # parsed as two broken halves.
    with tempfile.TemporaryDirectory() as d:
        events = Path(d) / "events.jsonl"
        app = Panel(events, [])
        app.log_file = io.BytesIO()
        applied: list[dict] = []
        apply = app.state.apply
        app.state.apply = lambda ev: (applied.append(ev), apply(ev))
        line = json.dumps({"ev": "unit_end", "group": "G", "unit": "u", "exit_code": 0, "secs": 1, "t": 5.0}) + "\n"
        events.write_text(line[:20])
        app.read_events()
        assert applied == [], applied
        with open(events, "a") as f:
            f.write(line[20:])
        app.read_events()
        app.read_events()
        assert len(applied) == 1 and applied[0]["unit"] == "u", applied
        assert app.log_file.getvalue() == b"", app.log_file.getvalue()
    # (c) A box taller than its content must never scroll: the active row
    # sits under its pinned group header with finished rows cut off above,
    # and with nothing active the tail shows.
    rows = [Text(str(i)) for i in range(20)]
    assert [r.plain for r in window(rows, 5, active=10, header=2)] == ["2", "10", "11", "12", "13"]
    assert [r.plain for r in window(rows, 5, active=10, header=9)] == ["9", "10", "11", "12", "13"]
    assert [r.plain for r in window(rows, 5, active=18, header=2)] == ["2", "15", "16", "17", "18"]
    assert [r.plain for r in window(rows, 5)] == ["15", "16", "17", "18", "19"]

    # (d) Timeline rows follow completion order, not start order: a unit that
    # started first but finished last sits below one that finished earlier,
    # and a still-running unit sits below them, then waiting units; the
    # active row is the first unfinished one.
    s = State()
    for unit, start in [("slow", 1.0), ("fast", 2.0), ("busy", 3.0)]:
        s.apply({"ev": "unit_start", "group": "G", "unit": unit, "t": start})
    s.apply({"ev": "unit_end", "group": "G", "unit": "fast", "exit_code": 0, "t": 4.0})
    s.apply({"ev": "unit_end", "group": "G", "unit": "slow", "exit_code": 0, "t": 5.0})
    s.apply({"ev": "unit_wait", "group": "G", "unit": "queued"})
    bars, _, active = render_timeline(s, 80, 0, 6.0)
    assert [b.plain.split("] ")[1].split()[0] for b in bars] == ["fast", "slow", "busy", "queued"], [b.plain for b in bars]
    assert active == 2, active

    # (e) A unit far shorter than one cell still draws a stub, and a bar
    # spans its own share of the run rather than the whole row.
    assert bar(0.5, 0.5001, 10).strip() in ("╸", "╺"), repr(bar(0.5, 0.5001, 10))
    assert bar(0.0, 0.5, 10) == "━━━━━     ", repr(bar(0.0, 0.5, 10))
    assert bar(0.25, 1.0, 10) == "  ╺━━━━━━━", repr(bar(0.25, 1.0, 10))
    print("selftest ok")


def main(argv: list[str]) -> int:
    if argv[1:] == ["--selftest"]:
        selftest()
        return 0
    if len(argv) < 3 or "--" not in argv:
        print(__doc__, file=sys.stderr)
        return 2
    sep = argv.index("--")
    events, command = Path(argv[1]).resolve(), argv[sep + 1 :]
    app = Panel(events, command)
    try:
        code = app.run()
    finally:
        # A panel crash must not leave rebuild running on unseen.
        if app.proc is not None and app.proc.poll() is None:
            kill_tree(app.proc)
    sys.stdout.reconfigure(errors="replace")
    print(plain_summary(app))
    return code if isinstance(code, int) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
