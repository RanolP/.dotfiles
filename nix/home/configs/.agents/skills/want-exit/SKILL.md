---
name: want-exit
description: Close out a session before the user types `exit` -- audit every resource this session or the machine left running or unsaved (background tasks, listening ports, git state, worktrees, browser/device/simulator/emulator/container sessions, herdr workspaces, the scratchpad, unrecorded learnings), give each a safe/ask/keep verdict, remove only the safe ones, ask once about the rest, and end with a report plus the line that `exit` is now safe. Use when the user says "want-exit", "/want-exit", "exit 전 정리", "세션 정리", "before exit", or is about to end the session.
---

# want-exit

Ending a session kills whatever it still holds: a background build, a dev server bound to a port, an uncommitted edit, a conclusion that lives only in the transcript. So this runs as audit first, removal second, and every removal is a judgment you can defend from the audit output.

Ownership decides the default. A resource this session started is yours to clean once the audit shows it idle. A resource the machine holds that this session did not start belongs to the user, so it is reported and touched only on their answer.

## 1. Audit -- every probe at once, read-only

Send all probes in ONE message so they run in parallel. For each CLI category, run `which <tool>` first; when it is absent, record the row as `tool absent` and move on. Before a tool's first list call, read its `--help` and use the list/close subcommand it names.

| Category | Probe |
|---|---|
| Session tasks | `TaskList`, plus the background shells and subagents this session launched |
| Listening servers | `lsof -iTCP -sTCP:LISTEN -n -P`, then `lsof -a -p <pid> -d cwd -Fn` and `ps -o pid,ppid,lstart,command -p <pid>` for each dev-server-looking row (node, vite, Metro, python, ruby) |
| Git state | in each repo this session touched: `git status --porcelain`, `git log @{u}..HEAD --oneline` (no upstream is itself a finding), `git stash list`, `git log --oneline origin/HEAD..claude/local-dev` when that branch exists |
| Worktrees | run the `worktree-cleanup` skill's audit steps (1-3) and take its finished/unfinished verdicts as-is |
| Browser / device | `agent-browser`, `agent-device` -- their session list command |
| Simulators / emulators | `xcrun simctl list devices booted`, `adb devices` |
| Containers | `docker ps` (OrbStack answers the same CLI) |
| Workspaces | `herdr` -- its workspace list command |
| Scratchpad | `du -sh <scratchpad>` and `ls <scratchpad>` for the session scratchpad directory named in the system prompt |
| Learnings | review this session for non-obvious conclusions reached from explicit premises; grep `memory/evidence/` for each so a recorded one is skipped |

Print ONE table, one row per resource:

| resource | owner | evidence | verdict |
|---|---|---|---|

- **owner** is `session` or `machine`.
- **evidence** is the probe output that ties the row to its owner and state -- a task ID, a PID with its cwd and start time, a branch with its unpushed count.
- **verdict** is exactly one of `safe`, `ask`, `keep`.

## 2. Verdict rules

- **safe** -- owner is `session` and the evidence proves it: the item is a background task of this session, or a process whose cwd sits in this session's working directory and whose start time falls inside this session. Also safe: a `finished` worktree from `worktree-cleanup`, and the scratchpad once nothing in it is referenced by an unfinished row.
- **ask** -- every `machine` row by default (a port, a container, a booted simulator, an emulator, a workspace the session did not start); a session process whose evidence is ambiguous; a running subagent whose output has not been read yet; every proposed learning.
- **keep** -- uncommitted changes, unpushed commits, stashes, and `unfinished` worktrees. Name what each holds and offer the `ship` skill to publish it. The `claude/local-dev` branch is a local stash stack that stays on this machine: report its commit count and keep it.

When the evidence leaves the owner uncertain, the verdict is `ask`.

## 3. Clean the safe rows

Remove only rows whose verdict is `safe`:

- Background tasks and subagents: `TaskStop` by task ID.
- Session processes: `kill <pid>` (SIGTERM), then re-run the `lsof` probe to confirm the port closed. Escalate to `kill -9` only after the re-probe shows it still bound, and say so in the report.
- Finished worktrees: run `worktree-cleanup` step 4.
- Browser/device/simulator/emulator/workspace sessions the session opened: each tool's own close subcommand from its `--help`.
- Scratchpad: remove its contents.

A wait on Metro (it must finish writing a bundle before it is stopped) goes through the `metro-wait` skill.

## 4. Ask once

Batch every `ask` row into ONE `AskUserQuestion` call, multi-select, one option per row labelled with the resource and its evidence. Proposed learnings go in the same call, each as a one-line conclusion. Act on the answer: clean the selected resources with the step-3 commands, and write each selected learning through the `evidence-store` skill. Leave unselected rows as they are.

When the user names a next subject to continue with instead of exiting, hand it to the `handoff` skill and stop here.

## 5. Report and release

Print the final table with each row's outcome -- `removed`, `kept`, `left by user`, `tool absent` -- and the reason for every row still alive. Close with this single line:

> 이제 `exit`를 입력해도 안전합니다.
