#!/usr/bin/env python3
"""Dependabot-style weekly bumper for mise tool pins in nix/home/default.nix.

All mise tools are pinned to exact versions, so `mise upgrade` is a no-op. This
script instead asks each tool's upstream registry for newer versions and rewrites
the pin in place -- but only to a release that has been out for at least
COOLDOWN_DAYS (a "dependency cooldown"). Brand-new releases are skipped until they
age past the window, so a fast-follow ".0" regression never lands automatically.
Major bumps ARE allowed once a release is old enough. It does NOT commit, push, or
rebuild -- it leaves the working tree dirty and posts a macOS notification so the
user reviews `git diff` and rebuilds themselves.

Run from launchd daily; a 7-day timestamp guard gates real work to weekly (so a
missed/coalesced run still does the right thing). Std-lib only (urllib for the
registry JSON). Never raises to launchd: the top-level handler logs and exits 0.

Publish dates come from each backend's canonical registry:
  aqua:<owner>/<repo>  -> GitHub releases API (published_at)
  npm:<pkg>            -> registry.npmjs.org (time map)
  pipx:<pkg>           -> pypi.org JSON (upload_time)
  core:node            -> nodejs.org/dist/index.json
Any other backend (core:python, asdf:*, cargo:*, ...) has no date source, so its
pin is left untouched and the skip is logged -- fail-safe: never install a release
whose age we cannot verify.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# A release must be at least this old before it is eligible to be pinned.
COOLDOWN_DAYS = 7
RELEASE_MIN_AGE = COOLDOWN_DAYS * 24 * 60 * 60

# Real work runs at most weekly, even though launchd fires daily.
WEEKLY_SECONDS = 7 * 24 * 60 * 60

HTTP_TIMEOUT = 30
USER_AGENT = "mise-pin-bumper/2 (+dotfiles)"

# Under launchd this script runs from the nix store, not the repo tree, so we
# can't derive the repo from __file__. The dotfiles path is machine-fixed (see
# rebuildCmd in darwin/default.nix); allow a DOTFILES_DIR override for other hosts.
REPO_DIR = Path(os.environ.get("DOTFILES_DIR", Path.home() / ".dotfiles"))
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
    return (time.time() - last) < WEEKLY_SECONDS


def tree_dirty():
    # Non-zero exit => the config file has uncommitted changes.
    return subprocess.run(
        ["git", "-C", str(REPO_DIR), "diff", "--quiet", "--", CONFIG_REL]
    ).returncode != 0


# --- version parsing -------------------------------------------------------

def parse_version(s):
    """A comparable tuple for a plain dotted numeric version, or None.

    Strips a leading `v`. Any non-numeric component (e.g. a `-alpha` pre-release
    or an npm platform suffix like `0.142.5-win32-x64`) makes the whole version
    ineligible -- we only ever pin clean stable releases.
    """
    s = s.strip()
    if s.startswith("v"):
        s = s[1:]
    parts = s.split(".")
    out = []
    for p in parts:
        if not p.isdigit():
            return None
        out.append(int(p))
    return tuple(out) if out else None


def parse_dt(s):
    """Parse an ISO-8601 (or bare YYYY-MM-DD) timestamp to an aware UTC datetime."""
    s = s.strip()
    if len(s) == 10 and s[4] == "-":  # date only (nodejs dist index)
        s += "T00:00:00+00:00"
    s = s.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def pick_target(current, date_map, now):
    """Newest version > current whose release age >= COOLDOWN, or None.

    date_map maps version-string -> aware datetime. Versions that don't parse as
    clean stable releases are ignored. Walking newest-first lets a too-new head
    release be skipped in favour of an older-but-eligible one.
    """
    cur = parse_version(current)
    if cur is None:
        return None
    best = None  # (version_tuple, version_str)
    for vstr, dt in date_map.items():
        vt = parse_version(vstr)
        if vt is None or vt <= cur:
            continue
        if (now - dt).total_seconds() < RELEASE_MIN_AGE:
            continue
        if best is None or vt > best[0]:
            best = (vt, vstr)
    if best is None:
        return None
    # Registries (nodejs dist, some GitHub tags) prefix a `v`; mise pins don't.
    return best[1][1:] if best[1].startswith("v") else best[1]


# --- registry date sources -------------------------------------------------

def _get_json(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return json.load(r)
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"  http error {url}: {e}")
        return None


def github_dates(repo):
    """{version: datetime} for stable GitHub releases of owner/repo (newest 100)."""
    headers = {}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = _get_json(
        f"https://api.github.com/repos/{repo}/releases?per_page=100", headers
    )
    if not isinstance(data, list):
        return {}
    out = {}
    for rel in data:
        if rel.get("prerelease") or rel.get("draft"):
            continue
        tag, when = rel.get("tag_name"), rel.get("published_at")
        if tag and when:
            out[tag] = parse_dt(when)
    return out


def npm_dates(pkg):
    data = _get_json(f"https://registry.npmjs.org/{pkg}")
    if not isinstance(data, dict):
        return {}
    times = data.get("time", {})
    return {
        v: parse_dt(t)
        for v, t in times.items()
        if v not in ("created", "modified")
    }


def pypi_dates(pkg):
    data = _get_json(f"https://pypi.org/pypi/{pkg}/json")
    if not isinstance(data, dict):
        return {}
    out = {}
    for v, files in data.get("releases", {}).items():
        if files and files[0].get("upload_time_iso_8601"):
            out[v] = parse_dt(files[0]["upload_time_iso_8601"])
    return out


def node_lts_dates(index):
    """{version: datetime} for LTS node releases only.

    nodejs dist marks each release `lts: false` (Current line) or `lts: "<codename>"`
    (an LTS line). We stay on LTS -- a cooldown is about stability, and jumping onto
    the Current line would forfeit that even when the release is old enough.
    """
    return {
        r["version"]: parse_dt(r["date"])
        for r in index
        if r.get("date") and r.get("lts")
    }


def node_dates():
    data = _get_json("https://nodejs.org/dist/index.json")
    if not isinstance(data, list):
        return {}
    return node_lts_dates(data)


def mise_registry_ref(tool):
    """First backend mise resolves for `tool`, as (kind, ref); (None, None) on error."""
    try:
        r = subprocess.run(
            ["mise", "registry", tool],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log(f"  {tool}: mise registry error: {e}")
        return None, None
    if r.returncode != 0 or not r.stdout.strip():
        return None, None
    # `mise registry <tool>` prints just the backends, space-separated, with no
    # tool-name column; the first one is what mise installs from.
    first = r.stdout.split()[0]
    kind, _, ref = first.partition(":")
    return kind, ref


def date_source(tool):
    """{version: datetime} for `tool`, or None if the backend has no date source."""
    if tool.startswith("npm:"):
        return npm_dates(tool[len("npm:"):])
    if tool.startswith("pipx:"):
        return pypi_dates(tool[len("pipx:"):])
    kind, ref = mise_registry_ref(tool)
    if kind == "aqua":
        return github_dates(ref)
    if kind == "core" and ref == "node":
        return node_dates()
    log(f"  {tool}: no date source for backend {kind or '?'}:{ref or '?'}, skipping")
    return None


def cooldown_target(tool, current, now):
    dates = date_source(tool)
    if not dates:
        return None
    return pick_target(current, dates, now)


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


def main(force=False):
    if not force and cooldown_active():
        log("cooldown active (<7 days), skipping")
        return
    if not force and tree_dirty():
        log(f"{CONFIG_REL} has uncommitted changes -- pending review, skipping")
        stamp()
        return

    now = datetime.now(timezone.utc)
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
        target = cooldown_target(tool, current, now)
        if not target or target == current:
            continue
        bumps.append((tool, current, target))
        lines[i] = f"{m.group(1)}{m.group(2)}{tool}{m.group(2)}{m.group(4)}{target}{m.group(6)}"

    if not bumps:
        log("no bumps available (all newer releases within cooldown)")
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

    # Version parsing: strip v, reject pre-releases and platform suffixes.
    assert parse_version("v24.18.0") == (24, 18, 0)
    assert parse_version("0.142.5") == (0, 142, 5)
    assert parse_version("0.1.0-alpha.174") is None
    assert parse_version("0.142.5-win32-x64") is None
    assert parse_version("2.1.187") < parse_version("2.1.190")

    # Cooldown selection: too-new head is skipped for the newest eligible one,
    # nothing older than current is picked, and pre-releases are ignored.
    now = parse_dt("2026-07-01T12:00:00Z")
    day = 24 * 60 * 60
    dmap = {
        "2.1.187": now.fromtimestamp(now.timestamp() - 8 * day, timezone.utc),   # eligible
        "2.1.190": now.fromtimestamp(now.timestamp() - 6 * day, timezone.utc),   # too new
        "2.1.197": now.fromtimestamp(now.timestamp() - 1 * day, timezone.utc),   # too new
        "2.1.180": now.fromtimestamp(now.timestamp() - 20 * day, timezone.utc),  # older than current
        "2.2.0-alpha.1": now.fromtimestamp(now.timestamp() - 30 * day, timezone.utc),  # pre-release
    }
    assert pick_target("2.1.185", dmap, now) == "2.1.187", "should pick newest eligible"
    assert pick_target("2.1.187", dmap, now) is None, "no eligible version above current"
    all_old = {"1.0.0": now.fromtimestamp(now.timestamp() - 30 * day, timezone.utc),
               "1.1.0": now.fromtimestamp(now.timestamp() - 10 * day, timezone.utc)}
    assert pick_target("1.0.0", all_old, now) == "1.1.0"
    # A `v`-prefixed key (nodejs dist) is returned without the prefix.
    vmap = {"v26.4.0": now.fromtimestamp(now.timestamp() - 10 * day, timezone.utc)}
    assert pick_target("24.17.0", vmap, now) == "26.4.0"

    # node stays on LTS: Current-line (lts: false) releases are dropped, so a
    # newer non-LTS major never wins over the latest LTS patch.
    node_index = [
        {"version": "v26.4.0", "date": "2026-06-24", "lts": False},
        {"version": "v24.18.0", "date": "2026-06-23", "lts": "Krypton"},
        {"version": "v24.17.0", "date": "2026-06-10", "lts": "Krypton"},
    ]
    lts = node_lts_dates(node_index)
    assert "v26.4.0" not in lts, "Current-line release leaked past the LTS gate"
    assert pick_target("24.17.0", lts, now) == "24.18.0", "should track latest LTS patch"

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
        main(force="--now" in sys.argv)
    except Exception as e:  # never raise to launchd
        try:
            log(f"unexpected error: {e!r}")
        except Exception:
            pass
    sys.exit(0)
