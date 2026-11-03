#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp>=1.9,<2"]
# ///
"""Talk to the Figma MCP server with the OAuth token Claude Code already stored.

Read-only on the credential: the token is read from the macOS keychain and never
refreshed or written back (a refresh would rotate the refresh token and log
Claude Code out). On expiry, re-authenticate in Claude Code with /mcp.

`index` reads a file through one fixed read-only `use_figma` script per page (split
into slices when a return is too big), saves each page under DATA/<fileKey>/raw/, and
derives a compact frame index.json; every other command answers from that index with
bounded output, so an agent never pulls a raw MCP response into its context.
notes.jsonl holds interpretations agents write; each note keeps the frame hash it was
written against and shows as stale once the frame's content hash changes.

Modules in figma_cli/: auth (keychain, transport, pacing, errors), plugin_script (the
use_figma script and its read-only guard), fetch (MCP reads), derive (derived layers),
query (index store, notes and commands).
"""

import argparse
import asyncio

from figma_cli.auth import describe, die, read_token, run, tools, whoami
from figma_cli.fetch import design_action, index_action, write_index
from figma_cli.query import cmd_find, cmd_flow, cmd_ls, cmd_note, cmd_notes, cmd_show, file_key, load_index, resolve_ref


def main() -> None:
    p = argparse.ArgumentParser(prog="figma-cli")
    p.add_argument("--config-dir", help="Claude config dir (default $CLAUDE_CONFIG_DIR, else ~/.claude)")
    p.add_argument("--file", help="Figma URL or fileKey of the index to read (default: the only indexed file)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami", help="print the authenticated Figma account")
    sub.add_parser("tools", help="list the server's tool names")
    s = sub.add_parser("index", help="read the file with read-only use_figma scripts and rewrite its index.json")
    s.add_argument("target", help="Figma URL or fileKey")
    s.add_argument("--offline", action="store_true", help="rebuild index.json from the pages saved in raw/, no MCP calls")
    s.add_argument("--refresh", action="store_true", help="re-fetch pages already saved in raw/ (default: skip them)")

    def bounded(sp):
        sp.add_argument("--limit", type=int, default=40, help="max lines (default 40)")
        return sp

    s = bounded(sub.add_parser("ls", help="one line per indexed frame"))
    s.add_argument("--page", help="page id or name substring")
    s.add_argument("--section", help="section id or name/title substring (includes nested sections)")
    s = bounded(sub.add_parser("find", help="frames matching every given filter (case-insensitive substring)"))
    for flag, what in [("name", "layer name"), ("title", "프레임 타이틀 text"), ("text", "title, state labels or text inside the frame"),
                       ("note", "canvas note or agent note"), ("page", "page id or name"), ("section", "section id or name/title")]:
        s.add_argument(f"--{flag}", help=what)
    s = sub.add_parser("show", help="index entry, group mates, flow, neighbors and notes for one frame")
    s.add_argument("ref", help="nodeId or hash prefix")
    s.add_argument("--design", action="store_true", help="also call get_design_context for this node")
    s.add_argument("--max-bytes", type=int, default=6000, help="cap for --design output (default 6000)")
    s = bounded(sub.add_parser("flow", help="edges around a frame, or within a section"))
    s.add_argument("ref", help="nodeId, hash prefix or section id")
    s.add_argument("--mermaid", action="store_true", help="print a mermaid flowchart instead")
    s = sub.add_parser("note", help="append an interpretation for a frame to notes.jsonl")
    s.add_argument("ref", help="nodeId or hash prefix")
    s.add_argument("text")
    s = bounded(sub.add_parser("notes", help="agent notes for a frame, marking stale ones"))
    s.add_argument("ref", help="nodeId or hash prefix")
    args = p.parse_args()

    local = {"ls": cmd_ls, "find": cmd_find, "flow": cmd_flow, "note": cmd_note, "notes": cmd_notes}
    if args.cmd in local:
        print(local[args.cmd](load_index(args.file), args))
        return
    if args.cmd == "show":
        idx = load_index(args.file)
        print(cmd_show(idx, args))
        if not args.design:
            return
        _, f = resolve_ref(idx, args.ref)
        action = design_action(idx["fileKey"], f["id"], args.max_bytes)
        print("--- get_design_context")
    elif args.cmd == "index":
        key = file_key(args.target)
        if args.offline:
            write_index(key, None)
            return
        action = index_action(key, args.refresh)
    else:
        action = {"whoami": whoami, "tools": tools}[args.cmd]
    try:
        out = asyncio.run(run(read_token(args.config_dir), action))
    except BaseException as e:  # noqa: BLE001 — TaskGroup wraps errors in exception groups
        if isinstance(e, (SystemExit, KeyboardInterrupt)):
            raise
        die(describe(e))
    if args.cmd == "index":
        write_index(key, out)
        return
    print(" ".join(out.split()) if args.cmd == "whoami" else out)


if __name__ == "__main__":
    main()
