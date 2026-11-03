"""Keychain token, MCP transport, call pacing and error reporting for the Figma MCP endpoint."""

import asyncio
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared._httpx_utils import create_mcp_http_client

URL = "https://mcp.figma.com/mcp"
# Must match the figma entry in nix/home/configs/claude/mcp.json: Claude Code keys the
# stored token by sha256 of exactly these fields.
SERVER = {"type": "http", "url": URL, "headers": {}}
EXPIRED = "Figma MCP token expired — re-authenticate in Claude Code with /mcp"
DATA = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "figma-cli"


def die(msg: str) -> NoReturn:
    print(msg, file=sys.stderr)
    sys.exit(1)


class Fail(Exception):
    """Raised inside the async session; SystemExit there would escape as a TaskGroup traceback."""


def token_key() -> str:
    """The mcpOAuth key Claude Code writes for SERVER (its `name|sha256(json)[:16]` scheme)."""
    return "figma|" + hashlib.sha256(json.dumps(SERVER, separators=(",", ":")).encode()).hexdigest()[:16]


def read_token(config_dir: str | None) -> str:
    cfg = config_dir or os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    service = "Claude Code-credentials-" + hashlib.sha256(cfg.encode()).hexdigest()[:8]
    r = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-w"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        die(f"keychain entry '{service}' not found for config dir {cfg}: {r.stderr.strip()}")
    entries = json.loads(r.stdout).get("mcpOAuth", {})
    key = token_key()
    if key not in entries:
        found = sorted(k for k in entries if k.startswith("figma|"))
        die(f"no mcpOAuth entry '{key}' for {URL} (figma keys found: {found or 'none'}); "
            "authenticate Figma in Claude Code with /mcp")
    tok = entries[key].get("accessToken")
    if not tok:
        die(f"mcpOAuth entry '{key}' has no accessToken; {EXPIRED}")
    return tok


def write_atomic(path: Path, text: str) -> None:
    """Write via a temp file and rename, so an interrupted write never leaves a truncated file."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


class Pacer:
    """Figma allows a Dev seat 10 MCP tool calls a minute (whoami exempt), so each call
    waits for a free slot in a sliding 60s window. The window lives in DATA/calls.log,
    read and updated under an exclusive flock on every pass, so concurrent runs share it;
    the lock is never held across a sleep."""

    def __init__(self, per: int = 10, window: float = 60.0, log: Path = DATA / "calls.log"):
        self.per, self.window, self.log, self.count = per, window, log, 0

    def _take(self, abort) -> float:
        """Take a slot and return 0, or return the seconds until one frees up."""
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log.with_name(self.log.name + ".lock"), "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                if abort and abort():
                    raise Fail("not sent, rate limit reached")
                now = time.time()
                try:
                    stamps = [t for t in (float(x) for x in self.log.read_text().split()) if now - t < self.window]
                except (FileNotFoundError, ValueError):
                    stamps = []
                if len(stamps) >= self.per:
                    return self.window - (now - min(stamps)) + 0.05
                write_atomic(self.log, "".join(f"{t:.3f}\n" for t in [*stamps, now]))
                self.count += 1
                return 0.0
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    async def wait(self, abort=None) -> None:
        """abort() is checked under the lock before a slot is taken; when true the call
        raises Fail instead, so an unsent call consumes no slot."""
        while (delay := self._take(abort)) > 0:
            print(f"pacing: {self.per} calls in the last {self.window:.0f}s, waiting {delay:.0f}s", file=sys.stderr)
            await asyncio.sleep(delay)


PACE = Pacer()


async def _read_error_body(response: httpx.Response) -> None:
    # mcp's transport calls raise_for_status() on a streamed response before reading it,
    # so without this the error carries no body to print.
    if response.status_code >= 400:
        await response.aread()


def http_client(headers=None, timeout=None, auth=None) -> httpx.AsyncClient:
    client = create_mcp_http_client(headers=headers, timeout=timeout, auth=auth)
    hooks = client.event_hooks
    client.event_hooks = {**hooks, "response": [*hooks.get("response", []), _read_error_body]}
    return client


async def run(token: str, action, url: str = URL):
    async with streamablehttp_client(url, headers={"Authorization": f"Bearer {token}"},
                                     httpx_client_factory=http_client) as (r, w, _):
        async with ClientSession(r, w) as session:
            await session.initialize()
            return await action(session)


async def call_raw(session: ClientSession, name: str, args: dict, abort=None) -> tuple[bool, str]:
    if name != "whoami":
        await PACE.wait(abort)
    res = await session.call_tool(name, args)
    return bool(res.isError), "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text")


def rate_limited(text: str) -> bool:
    return bool(re.search(r"tool call limit|rate limit|too many requests", text, re.I))


async def call(session: ClientSession, name: str, args: dict) -> str:
    err, text = await call_raw(session, name, args)
    if err:
        raise Fail(f"{name} tool error: {text}")
    return text


def parse_json(text: str, what: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise Fail(f"{what} returned non-JSON ({e}):\n{text[:2000]}") from None


def leaves(exc: BaseException):
    subs = getattr(exc, "exceptions", None)
    if subs:
        for s in subs:
            yield from leaves(s)
    else:
        yield exc


def describe(exc: BaseException, url: str = URL) -> str:
    """One line per distinct leaf error; exception groups (TaskGroup) are flattened."""
    out: list[str] = []
    for leaf in leaves(exc):
        if isinstance(leaf, Fail):
            msg = str(leaf)
        elif isinstance(leaf, httpx.HTTPStatusError):
            r = leaf.response
            if r.status_code == 401:
                msg = EXPIRED
            else:
                try:
                    body = r.text[:2000]
                except httpx.ResponseNotRead:
                    body = "<unread>"
                ra = r.headers.get("retry-after")
                msg = f"HTTP {r.status_code}{f' (Retry-After: {ra})' if ra else ''} from {url}: {body}"
        else:
            msg = f"{type(leaf).__name__}: {leaf}"
        if msg not in out:
            out.append(msg)
    return "\n".join(out)


async def whoami(session: ClientSession) -> str:
    return await call(session, "whoami", {})


async def tools(session: ClientSession) -> str:
    return "\n".join(t.name for t in (await session.list_tools()).tools)
