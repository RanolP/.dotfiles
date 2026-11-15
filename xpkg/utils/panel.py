#!/usr/bin/env python3
"""Fullscreen progress panel for `rebuild` on Windows.

    uv run --with textual python xpkg/utils/panel.py <events-file> -- <command...>

Starts <command> as a child with stdout and stderr in <events-file>.log and
XPKG_EVENTS=<events-file> in its environment, tails the JSON lines the child
appends there (xpkg/utils/events.nu), and draws a group -> unit tree, the
failures, the reboot notices and a timeline. Once the child exits the panel
stays until `q`, then prints a plain summary and exits with the child's code.
Ctrl+C kills the child's process tree and exits 130.
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
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Static

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
SPINNER = "|/-\\"
GREEN, YELLOW, RED, CYAN, DIM = "#5fd75f", "#d7d75f", "#ff5f87", "#5fd7d7", "#808080"
STATUS_COLOR = {"done": GREEN, "running": YELLOW, "failed": RED, "waiting": DIM}
LABEL_WIDTH = 26


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


def render_tree(state: State, frame: int, now: float) -> Text:
    out = Text()
    for g in state.groups.values():
        out.append_text(marker(g.status, frame))
        out.append(g.name, style=f"bold {CYAN}")
        out.append(f"  {secs(g, now)}\n", style=DIM)
        units = list(g.units.values())
        for i, u in enumerate(units):
            out.append("  └─ " if i == len(units) - 1 else "  ├─ ", style=DIM)
            out.append_text(marker(u.status, frame))
            out.append(f"{u.name:<{LABEL_WIDTH}}", style=STATUS_COLOR[u.status] if u.status != "done" else "")
            out.append(f" {secs(u, now)}\n", style=DIM)
    if not state.groups:
        out.append("waiting for the first event…", style=DIM)
    return out


def render_failures(state: State) -> Text:
    out = Text()
    for group, u in state.failed():
        code = "no exit code" if u.exit_code is None else f"exit {u.exit_code}"
        out.append(f"× {u.name}", style=f"bold {RED}")
        out.append(f"  {group}  {code}\n", style=DIM)
        tail = [clean(line) for line in u.output.splitlines() if clean(line).strip()][-4:]
        for line in tail:
            out.append(f"    {line}\n", style=DIM)
    if not out.plain:
        out.append("none", style=DIM)
    return out


def render_notices(state: State) -> Text:
    if not state.notices:
        return Text("none", style=DIM)
    return Text("\n".join(state.notices), style=YELLOW)


def render_timeline(state: State, width: int, now: float) -> Text:
    units = sorted(
        ((g, u) for g, u in state.all_units() if u.start is not None),
        key=lambda gu: gu[1].start,
    )
    if not units:
        return Text("nothing has started yet", style=DIM)
    t0 = min(u.start for _, u in units)
    t1 = max((u.end or now) for _, u in units)
    span = max(t1 - t0, 1.0)
    bar_width = max(width - LABEL_WIDTH - 2, 10)
    out = Text()
    for _, u in units:
        a = int((u.start - t0) / span * bar_width)
        b = max(a + 1, round(((u.end or now) - t0) / span * bar_width))
        out.append(f"{u.name[:LABEL_WIDTH - 1]:<{LABEL_WIDTH}}", style=DIM)
        out.append(" " * a)
        out.append("█" * (b - a), style=STATUS_COLOR[u.status])
        out.append("\n")
    end_label = f"{span:.0f}s"
    axis = "0s".ljust(bar_width - len(end_label)) + end_label
    out.append(" " * LABEL_WIDTH + axis, style=DIM)
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
    Screen {{ background: #121212; color: #d0d0d0; }}
    #header {{ dock: top; height: 1; background: #1c1c1c; padding: 0 1; }}
    #footer {{ dock: bottom; height: 2; background: #1c1c1c; padding: 0 1; }}
    #body {{ padding: 0 1; }}
    #top {{ height: auto; }}
    .box {{ border: round {DIM}; border-title-color: {CYAN}; height: auto; padding: 0 1; }}
    #tree {{ width: 1fr; }}
    #side {{ width: 1fr; height: auto; }}
    """
    BINDINGS = [
        Binding("q", "close", "close", show=False),
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
        with VerticalScroll(id="body"):
            with Horizontal(id="top"):
                yield Static(id="tree", classes="box")
                with Vertical(id="side"):
                    yield Static(id="failures", classes="box")
                    yield Static(id="notices", classes="box")
            yield Static(id="timeline", classes="box")
        yield Static(id="footer")

    def on_mount(self) -> None:
        for wid, title in [("tree", "Units"), ("failures", "Failures"), ("notices", "Notices"), ("timeline", "Timeline")]:
            self.query_one(f"#{wid}").border_title = title
        self.events.parent.mkdir(parents=True, exist_ok=True)
        self.events.touch()
        env = dict(os.environ, XPKG_EVENTS=str(self.events))
        self.log_file = open(self.log_path, "wb")
        self.proc = subprocess.Popen(
            self.command, stdin=subprocess.DEVNULL, stdout=self.log_file, stderr=subprocess.STDOUT, env=env
        )
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
        self.query_one("#tree", Static).update(render_tree(self.state, self.frame, now))
        self.query_one("#failures", Static).update(render_failures(self.state))
        self.query_one("#notices", Static).update(render_notices(self.state))
        self.query_one("#timeline", Static).update(render_timeline(self.state, width - 6, now))
        footer = render_summary(self.state)
        if self.child_code is None:
            hint = Text(f"\nrunning; log {self.log_path}  ctrl+c aborts", style=DIM)
        else:
            style = GREEN if self.child_code == 0 else RED
            hint = Text.assemble("\n", (f"finished, exit {self.child_code}", style), ("  q to close", "bold"))
        self.query_one("#footer", Static).update(Text.assemble(footer, hint))

    def action_close(self) -> None:
        if self.child_code is not None:
            self.exit(self.child_code)
        else:
            self.notify("still running; ctrl+c aborts", timeout=2)

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
    s = app.state
    lines = [s.summary_line()]
    for group, u in s.failed():
        code = "no exit code" if u.exit_code is None else f"exit {u.exit_code}"
        lines.append(f"  × {group}/{u.name}  {code}")
        tail = [clean(line) for line in u.output.splitlines() if clean(line).strip()][-4:]
        lines += [f"      {line}" for line in tail]
    if s.notices:
        lines.append("notices:")
        lines += [f"  {n}" for n in s.notices]
    lines.append(f"log: {app.log_path}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) < 3 or "--" not in argv:
        print(__doc__, file=sys.stderr)
        return 2
    sep = argv.index("--")
    events, command = Path(argv[1]).resolve(), argv[sep + 1 :]
    app = Panel(events, command)
    code = app.run()
    sys.stdout.reconfigure(errors="replace")
    print(plain_summary(app))
    return code if isinstance(code, int) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
