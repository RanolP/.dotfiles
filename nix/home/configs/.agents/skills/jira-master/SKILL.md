---
name: jira-master
description: Read and edit Jira card bodies as raw ADF through the `jira` CLI, never through markdown. Covers the read commands, the ADF staging workflow, and the image rules. Use when reading, searching, or changing any Jira card. The `jira-guard` PreToolUse hook injects this skill in full before any `jira edit` command.
---

# Jira master

The `jira` CLI is `nix/home/programs/jira-cli.nix`, wrapping `nix/home/configs/jira-cli/jira.py`. `jira --help` carries the staging workflow, the selector cheat sheet, and the safety rules. `docs/src/jira-cli.md` in `~/.dotfiles` explains why each one exists.

## Never read or write markdown

The CLI never asks Jira for markdown, and neither do you. A markdown read degrades an attached image to a `blob:https://media.staging.atl-paas.net/...` URL, and the round-trip back silently destroys it. The card then ships with a dead image and nobody notices until a reader opens it.

Author every write as raw ADF taken from `jira show -i KEY --json`.

## Read commands, cheapest first

| Question | Command |
|---|---|
| What is this card? | `jira info -i KEY` — status, assignee, parent, labels; no body fetch |
| Which cards? | `jira search '<JQL>'` — one row per card |
| What does the body say? | `jira show -i KEY --rendered` — plain text, cheapest body read |
| Which node do I target? | `jira show -i KEY` — the selector's XML view |
| What exactly do I edit? | `jira show -i KEY --json` — raw ADF, the only valid source for a write |
| How does this card reach status X? | `jira flow -i KEY` — every reachable status and its route, read-only |

`info` and `search` are read-only and need no body at all. Reach for them before any body read.

## Staging workflow

Edits stage, then flush. Run `jira --help` for the full selector syntax.

1. `jira edit queue ...` stages one edit against a selector.
2. `jira edit status` shows the queue with no network call.
3. `jira edit drop ...` discards a queued edit.
4. `jira edit apply -i KEY` flushes the queue to the card.

Stage every edit for one card, review the queue, then apply once.

## Moving a card's status

`jira flow -i KEY` lists every status the card can reach and writes nothing. `--31--> In Progress` is one transition, `==31==111==> Dev Done` is a chain of two, and `~~???~~> In QA` means the route is unknown, not that the status is unreachable. `jira move -i KEY 'Dev Done'` walks the route, one real transition per hop, and re-reads the card's own transitions before each hop.

Two hops are normal: a Jira card in `To Do` usually cannot jump to `Dev Done`, so `move` goes through `In Progress`. A refused hop leaves the earlier hops applied, because Jira has no transaction over a status change.

Run `flow` and read the chain before you run `move`. A status transition is visible to every watcher of the card, so get the user's word for the target status first.

## Images: reference, never upload

There is no upload path. The Atlassian MCP surface has no attachment tool, and its access token answers HTTP 401 on `api.atlassian.com/ex/jira/<cloudId>/rest/api/3/*`, so no REST fallback exists either.

- `jira media ls -i KEY` prints the media ids already on the card. Reference one of those.
- A `media` node with `type: "external"` plus a `url` stores verbatim.
- When a genuinely new file is needed, ask the user to upload it through the Jira web UI, then reference the id `jira media ls` reports.
