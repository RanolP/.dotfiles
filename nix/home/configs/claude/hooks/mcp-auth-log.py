#!/usr/bin/env python3
"""SessionStart: snapshot every MCP OAuth token's health, before anything connects.

The incident: `atlassian` drops its login on restart while `figma`, declared in the
same mcp.json, survives. Post-hoc inspection cannot separate the two candidate
causes, because both leave the same end state -- a freshly re-authenticated token:

  (a) the access token expired between sessions and no refresh was possible, or
  (b) the token was still valid and the refresh/connect path itself failed.

Only a snapshot taken BEFORE the session connects tells them apart, so this hook
records one per session start and pairs it with Claude Code's own
`mcp-needs-auth-cache.json`. A line reading `expired=false needs_auth=true` is
case (b) and nothing else; `expired=true` is case (a). Measured 2026-08-14 on this
machine: the Atlassian access token carries an 8-hour TTL while Figma's carries
three months, which is why only Atlassian is ever seen to drop.

Tokens live in the macOS keychain, NOT in `~/.claude/.credentials.json` -- that
file is a stale leftover from before the keychain migration and is not read. The
keychain item is named per config dir so each `~/.claude-*` profile keeps its own.

This hook logs metadata only -- server name, url, expiry, and whether a refresh
token exists. It never reads, prints, or stores token material, so the log file is
safe to open, paste, and hand to someone else.

Self-check: `python3 mcp-auth-log.py --selftest`.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

# Keep the log bounded: one line per session start adds up over months.
MAX_LOG_LINES = 500

# stdout on SessionStart becomes model-visible context that every later request
# re-reads, so speak only when a token is actually unhealthy.
QUIET_WHEN_HEALTHY = True


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def keychain_service(cfg_dir):
    """Claude Code suffixes the item with the config dir's hash, except for the default."""
    if os.path.realpath(cfg_dir) == os.path.realpath(os.path.expanduser("~/.claude")):
        return "Claude Code-credentials"
    digest = hashlib.sha256(cfg_dir.encode()).hexdigest()[:8]
    return f"Claude Code-credentials-{digest}"


def read_credentials(service):
    out = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-w"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if out.returncode != 0:
        return {}
    return json.loads(out.stdout)


def needs_auth_names(cfg_dir):
    """Claude Code's own 'this server asked me to log in again' cache."""
    path = os.path.join(cfg_dir, "mcp-needs-auth-cache.json")
    try:
        with open(path) as fh:
            return set(json.load(fh))
    except (OSError, ValueError):
        return set()


def summarize(creds, flagged, now_ms):
    """Metadata only -- accessToken/refreshToken values never leave this function."""
    rows = []
    for key, entry in sorted(creds.get("mcpOAuth", {}).items()):
        expires = entry.get("expiresAt")
        name = entry.get("serverName") or key.split("|")[0]
        rows.append(
            {
                "key": key,
                "server": name,
                "url": entry.get("serverUrl"),
                "expiresAt": expires,
                # No expiry recorded means the server issued a bare token that
                # cannot be refreshed -- it dies silently and looks like a logout.
                "expired": bool(expires) and expires <= now_ms,
                "hasRefresh": bool(entry.get("refreshToken")),
                "needsAuth": name in flagged,
            }
        )
    return rows


def verdict(row):
    """The one line that separates 'expired' from 'refresh path is broken'."""
    if not row["hasRefresh"]:
        return "no refresh token -- it cannot survive expiry"
    if row["expired"]:
        return "expired between sessions"
    if row["needsAuth"]:
        return "still valid yet flagged for re-auth -- the refresh failed"
    return "healthy"


def unhealthy(rows):
    return [r for r in rows if verdict(r) != "healthy"]


def append_log(path, record):
    lines = []
    try:
        with open(path) as fh:
            lines = fh.read().splitlines()
    except OSError:
        pass
    lines.append(json.dumps(record, separators=(",", ":")))
    with open(path, "w") as fh:
        fh.write("\n".join(lines[-MAX_LOG_LINES:]) + "\n")


def main():
    try:
        sys.stdin.read()  # drain the hook payload; nothing here depends on it
    except OSError:
        pass

    cfg = config_dir()
    now_ms = int(time.time() * 1000)
    try:
        rows = summarize(read_credentials(keychain_service(cfg)), needs_auth_names(cfg), now_ms)
        append_log(os.path.join(cfg, "mcp-auth.log"), {"at": now_ms, "servers": rows})
    except Exception:
        # A hook that blocks session start is worse than a missing log line.
        sys.exit(0)

    bad = unhealthy(rows)
    if bad or not QUIET_WHEN_HEALTHY:
        detail = "; ".join(f"{r['server']}: {verdict(r)}" for r in bad or rows)
        print(f"MCP auth at session start -- {detail} (log: {cfg}/mcp-auth.log)")
    sys.exit(0)


def selftest():
    now = 1_000_000
    flagged = {"atlassian"}
    creds = {
        "mcpOAuth": {
            "atlassian|aaaa": {
                "serverName": "atlassian",
                "serverUrl": "https://mcp.atlassian.com/v1/mcp",
                "accessToken": "SECRET",
                "refreshToken": "SECRET",
                "expiresAt": now + 1,
            },
            "atlassian|bbbb": {
                "serverName": "atlassian",
                "serverUrl": "https://mcp.atlassian.com/v1/sse",
                "accessToken": "SECRET",
            },
            "figma|cccc": {
                "serverName": "figma",
                "serverUrl": "https://mcp.figma.com/mcp",
                "accessToken": "SECRET",
                "refreshToken": "SECRET",
                "expiresAt": now - 1,
            },
        }
    }
    rows = summarize(creds, flagged, now)
    blob = json.dumps(rows)
    assert "SECRET" not in blob, "summarize leaked token material"

    by_key = {r["key"]: r for r in rows}
    assert verdict(by_key["atlassian|aaaa"]).startswith("still valid"), "missed refresh failure"
    assert verdict(by_key["atlassian|bbbb"]).startswith("no refresh"), "missed unrefreshable token"
    assert verdict(by_key["figma|cccc"]) == "expired between sessions", "missed expiry"
    assert by_key["figma|cccc"]["needsAuth"] is False, "needsAuth matched the wrong server"
    assert len(unhealthy(rows)) == 3, "unhealthy dropped a row"

    healthy = summarize(
        {"mcpOAuth": {"figma|c": {"serverName": "figma", "refreshToken": "S", "expiresAt": now + 1}}},
        set(),
        now,
    )
    assert unhealthy(healthy) == [], "healthy token reported as a problem"

    default = os.path.expanduser("~/.claude")
    assert keychain_service(default) == "Claude Code-credentials", "default item renamed"
    assert keychain_service(default + "-work") != keychain_service(default), "profiles share an item"
    print("mcp-auth-log selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
