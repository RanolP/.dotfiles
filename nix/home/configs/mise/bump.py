#!/usr/bin/env python3
"""Dependabot-style weekly bumper for mise tool pins in nix/home/default.nix.

All mise tools are pinned to exact versions, so `mise upgrade` is a no-op. This
script instead asks upstream for the newest version of each pin (within its
current major) and rewrites the pin in place when one is available. It does NOT
commit, push, or rebuild -- it leaves the working tree dirty and posts a macOS
notification so the user reviews `git diff` and rebuilds themselves.

Run from launchd daily; a 7-day timestamp guard gates real work to weekly (so a
missed/coalesced run still does the right thing). Std-lib only. Never raises to
launchd: the top-level handler logs and exits 0.
"""
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Pin within the current major (e.g. node 24.x -> latest 24.y, never 26.x).
# Flip to False to allow major bumps too.
KEEP_MAJOR = True

COOLDOWN_SECONDS = 7 * 24 * 60 * 60

# Repo layout: this file lives at <repo>/nix/home/configs/mise/bump.py.
REPO_DIR = Path(__file__).resolve().parents[4]
CONFIG_REL = "nix/home/default.nix"
CONFIG_PATH = REPO_DIR / CONFIG_REL

STATE_DIR = Path(
    os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")
) / "mise-bump"
LOG_PATH = STATE_DIR / "bump.log"
STAMP_PATH = STATE_DIR / "last-run"

# A pin line: `KEY = "VERSION";`, KEY bare (node) or quoted ("npm:@openai/codex"),
# VERSION starts with a digit so `experimental = true;` etc. never match.
PIN_RE = re.compile(r'^(\s*)("?)([\w@:./\-]+)\2(\s*=\s*")(\d[^"]*)(";\s*)$')


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def stamp():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STAMP_PATH.write_text(str(int(time.time())))


def cooldown_active():
    try:
        last = int(STAMP_PATH.read_text().strip())
    except (FileNotFoundError, ValueError):
        return False
    return (time.time() - last) < COOLDOWN_SECONDS


def tree_dirty():
    # Non-zero exit => the config file has uncommitted changes.
    return subprocess.run(
        ["git", "-C", str(REPO_DIR), "diff", "--quiet", "--", CONFIG_REL]
    ).returncode != 0


def mise_latest(tool):
    """Newest version mise knows for `tool`, or None on error/empty."""
    try:
        r = subprocess.run(
            ["mise", "latest", tool],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log(f"  {tool}: mise error: {e}")
        return None
    if r.returncode != 0:
        log(f"  {tool}: mise exited {r.returncode}")
        return None
    out = r.stdout.strip()
    return out or None


TOOLS_OPEN_RE = re.compile(r'^\s*tools\s*=\s*\{')


def tools_block_lines(lines):
    """Line indices inside `tools = { ... };`, so non-tool quoted-version pins
    elsewhere (fetchFromGitHub rev, home.stateVersion) are never touched.

    The block spans an inner `}` / `// lib.optionalAttrs ... {` seam, so we track
    brace depth and only stop once it returns to 0 after the block opened.
    """
    inside = set()
    depth = 0
    started = False
    for i, line in enumerate(lines):
        if not started:
            if TOOLS_OPEN_RE.match(line):
                started = True
                depth = line.count("{") - line.count("}")
            continue
        depth += line.count("{") - line.count("}")
        if depth >= 1:
            inside.add(i)
        elif line.strip().endswith(";"):  # statement end, not the `//`-merge seam
            break
    return inside


def main():
    if cooldown_active():
        log("cooldown active (<7 days), skipping")
        return
    if tree_dirty():
        log(f"{CONFIG_REL} has uncommitted changes -- pending review, skipping")
        stamp()
        return

    lines = CONFIG_PATH.read_text().splitlines(keepends=True)
    tool_lines = tools_block_lines(lines)
    bumps = []
    for i, line in enumerate(lines):
        if i not in tool_lines:
            continue
        m = PIN_RE.match(line)
        if not m:
            continue
        tool = m.group(3)
        current = m.group(5)
        major = current.split(".")[0]
        query = f"{tool}@{major}" if KEEP_MAJOR else tool
        latest = mise_latest(query)
        if not latest or latest == current:
            continue
        bumps.append((tool, current, latest))
        lines[i] = f"{m.group(1)}{m.group(2)}{tool}{m.group(2)}{m.group(4)}{latest}{m.group(6)}"

    if not bumps:
        log("no bumps available")
        stamp()
        return

    CONFIG_PATH.write_text("".join(lines))
    summary = ", ".join(f"{t} {o} -> {n}" for t, o, n in bumps)
    log(f"applied {len(bumps)} bump(s): {summary}")

    subprocess.run([
        "osascript", "-e",
        f'display notification "{len(bumps)} bump(s): {summary}. Review & rebuild." '
        f'with title "mise pin bumper"',
    ])
    stamp()


def selftest():
    # The fragile bit: PIN_RE must parse both key shapes (and reject non-pins),
    # and a rewrite must change only the version string.
    cases = {
        '  node = "24.17.0";\n': ("node", "24.17.0"),
        '        "npm:@openai/codex" = "0.142.0";\n': ("npm:@openai/codex", "0.142.0"),
        '  docker-cli = "29.6.0";\n': ("docker-cli", "29.6.0"),
    }
    for line, (tool, ver) in cases.items():
        m = PIN_RE.match(line)
        assert m, f"failed to parse: {line!r}"
        assert m.group(3) == tool, f"{m.group(3)!r} != {tool!r}"
        assert m.group(5) == ver, f"{m.group(5)!r} != {ver!r}"
        rewritten = f"{m.group(1)}{m.group(2)}{tool}{m.group(2)}{m.group(4)}9.9.9{m.group(6)}"
        assert rewritten == line.replace(f'"{ver}"', '"9.9.9"'), rewritten
    for non_pin in ['        experimental = true;\n', '        pipx.uvx = true;\n']:
        assert not PIN_RE.match(non_pin), f"wrongly matched: {non_pin!r}"

    # Block scoping against the real config: tool pins in, stray pins out.
    lines = CONFIG_PATH.read_text().splitlines(keepends=True)
    tool_lines = tools_block_lines(lines)
    pins = {PIN_RE.match(lines[i]).group(3) for i in tool_lines if PIN_RE.match(lines[i])}
    assert "node" in pins, "node pin not detected inside tools block"
    assert "colima" in pins, "darwin pin (after the } seam) not detected"
    assert "home.stateVersion" not in pins, "stray pin leaked into tools block"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    try:
        main()
    except Exception as e:  # never raise to launchd
        try:
            log(f"unexpected error: {e!r}")
        except Exception:
            pass
    sys.exit(0)
