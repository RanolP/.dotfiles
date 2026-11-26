---
name: create-verification-skill
description: Generate a project-local `verify-<app>` skill that launches the app from a clean state, drives it the way a user does (`agent-browser`, `agent-device`, a PTY, HTTP), captures evidence (screenshots, transcripts, logs, rendered output with numeric checks), and cleans up while keeping that evidence -- then run it end to end once, so "done" in that repo rests on a run. Use when a project has no scripted way to prove its UI, CLI, service, audio or rendering behavior; when a change was reported done without a runtime check and the user caught it; when the user says "/create-verification-skill", "make a verify skill for this repo", or "how do I check this works"; when a repo's `verify-<app>` skill no longer matches the app or the user asks to audit it; or when checking whether an existing PR or commit actually fixes a reported bug.
---

# Create a verification skill

"Evidence for done is the artifact running" holds only when the next agent knows how to run it. A project with no recorded way to launch, drive and observe the app gets the shortest check that compiles -- `cargo test`, a type-check -- and the user finds the silent audio or the vanished scene light. This skill writes that recipe into the repo as a skill, so any agent, read cold mid-task, can prove a change the way a user would see it.

## 1. Interview the repo, then the user

Answer these from the codebase -- package scripts, `Makefile`, `justfile`, README, CI config, existing e2e specs -- and ask the user only what you cannot observe:

- **Surface** -- what a user touches: a web UI, a native or mobile app, a CLI or TUI, an HTTP API, rendered media (audio, images, a 3D scene), a library. Pick the primary surface and list the others.
- **Run** -- the repo's own dev command; ports, env vars, seed data, auth, GPU or device needs.
- **Drive** -- existing harnesses first (Playwright or Cypress specs, `.ad` scripts, expect scripts, a debug port). Otherwise: `agent-browser` for web and Electron, `agent-device` for iOS, Android, macOS and TV, a `tmux` session for a CLI or TUI, `curl` for HTTP, the repo's own render entry point for media.
- **Observe** -- what proves a behavior: a screenshot or ARIA snapshot, a terminal transcript with exit code, a response body, a log line, a DB row, a rendered file plus a numeric check on it.
- **Isolate** -- whether two instances can run side by side (ports, data dirs, browser profiles, device sessions). When they cannot, the generated skill says so and drives only an instance it started.

When the checkout does not build or start as-is, fix that or report it exactly before generating; a recipe written against a broken base teaches wrong steps. When an asset the verified path never uses blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, labelled as verification scaffolding, and remove it in cleanup. A launch that compiles natively or boots an emulator is a heavy local job: raise it with its cost and current load per the (load) rule, and reuse a running build, emulator or dev server.

## 2. Write the skill

Write `<repo>/.claude/skills/verify-<app>/SKILL.md`, and mirror it to `<repo>/.agents/skills/verify-<app>/` when the repo already keeps skills there. The frontmatter carries `name: verify-<app>` and a `description` naming the app, its surface, and the moment to use it -- "before reporting any change to <app> done" -- because the description is what makes the skill fire. Each section below holds what the interview found, with no placeholder left:

- **Launch** -- the exact command, and the ready signal that means usable rather than merely listening (a log line after migrations and seeds, a prompt, a route that renders data). It reaches that state from an empty data dir in one command that also seeds the data and test users the journeys need, so every run starts the same way. For a short-lived CLI, launch is the one-time build, and each drive runs in its own fresh `tmux` session.
- **Doctor** -- one read-only check answering "is this instance worth driving?": process up, expected build or commit, port owned by this run, auth valid, device or GPU visible.
- **Drive** -- the harness recipe with this repo's real selectors and commands. Prefer stable handles (ARIA names, `data-testid`, ids, prompt strings, routes) over coordinates. Send each scenario as one batch per `ui-automation`, and keep every journey as a file under `verify-<app>/journeys/` per `record-replay` (an `.ad` script, a batch JSON, a shell script). Automated surfaces launch behind the user's windows: headless `agent-browser` first, and a real Chrome only for DRM or a logged-in profile.
- **Evidence** -- what to capture and where it lands: `verify-<app>/evidence/<run-id>/` or a scratch path the section names. The proof standard:
  - the real user path, never an internal setter or a test-only endpoint;
  - the action and the resulting state, not only the final screen;
  - side effects checked beside what is visible (a file written, a row inserted, a message sent);
  - a dry-run or test mode verified by observing what it skips (network, files, git refs), since some still touch them;
  - mocks only where a production boundary already isolates the external system;
  - CLI proof carries the command, stdout, stderr and exit code;
  - a mutation is proven by a second, read-only view of the stored value (reopen the record from the list; a save toast proves nothing);
  - every artifact records the feature ID and the entry point it used.

  Match the check to the change: a CLI change runs the real command; a UI change walks the changed flow in the running app; a parser or migration replays a saved input; a perf change compares before and after profiles per skill `benchmark-checklist`; a storage change reads the written value back.
- **Cleanup** -- tear down what this run started, by PID, session name or container id, and keep the evidence directory intact.
- **Helpers** -- every script the skill ships is executable and its invocation appears in the body. When agents keep hand-writing the same click-through, ship a small control CLI the skill calls instead, shaped for agents: a few composable commands that each do real work, `--dry-run` on every destructive one, subcommands that reveal features gradually, errors that name the command to run instead, rich `--help`, and `--json` output.

### Output a person cannot see on a screen

Rendered media needs a numeric check beside the artifact, because a file that exists proves nothing about its content:

- **Audio** -- render through the app's own entry point, then assert per segment that RMS clears a silence floor and that no sample is NaN or Inf, e.g. `uv run --with numpy,soundfile python check_wav.py out.wav`; keep the WAV for a human listen, delivered where the user reads results.
- **Images and 3D scenes** -- screenshot fixed camera poses or routes before and after the change, and compare them (pixel diff, or an asserted element or light present); a lighting or layer change gets a pose that shows it.
- **Numeric output** -- assert range, shape and NaN-freedom against a fixture the real system produced.

## 3. Seed the feature map

Create `verify-<app>/features/README.md` plus one file per user-facing feature, the top 3-5 from routes, commands, menus or docs. The README holds the baseline preconditions, the driving conventions, the proof rules, and an index with one line per feature file. The conventions it states: every recipe starts from the baseline state unless its preconditions say otherwise; commands are literal, quoted names and flags unchanged; a mutation restores the seeded data afterwards while keeping its evidence; each run gets its own data dir through a run-id variable (`APP_DATA_DIR=<scratch>/verify-$RUN_ID`) so concurrent runs share no state; doctor reports the build revision. The map names only user paths, stable handles, required state, commands and observable proof; implementation details stay out, since the source is read fresh each run. Each feature file opens with an H1 and one paragraph of user-visible behavior, then exactly these four H2s:

1. `Sub-features` -- short IDs, one line each.
2. `How to get to it (user POV)` -- every entry point a user has.
3. `Driving it with <harness>` -- a `Preconditions:` list, then labelled bullets pairing each user action with its exact command and its observable result, ending with a `Reset:` bullet (how to return to a fresh state for a second attempt) and a `Cross-check:` bullet (the read-only state or value that confirms what the screen shows).
4. `Gotchas` -- traps that waste or invalidate a run (debounce, focus, default output format, state left behind).

When seed data lacks a precondition a journey needs, the journey reports a failure and the reason goes in that feature's `Gotchas`; the journey keeps its full strength. A proof that used one entry point covers that entry point only, and says so.

## 4. Run it once, end to end, before handing it over

Follow the generated skill's own words: launch, doctor, drive ONE mapped feature, capture evidence, clean up, then confirm the evidence still exists at its named location. Hold three invariants through every attempt:

1. Run doctor before the first drive and again after any failed drive; where doctor cannot see the failure (a wedged UI on a healthy process), relaunch to a known state.
2. Evidence captured so far survives every cleanup, checked at its location.
3. Nothing a drive started outlives it -- run the generated cleanup after each failed iteration too.

A generated skill that never ran is a draft. When the run happened in a stand-in for the real target (a local stack for a remote one, a simulator for a device), list each step the stand-in covered that the target will not; those stay unverified.

### Translate the environment before calling it blocked

When the reported environment is out of reach, restate the defect without its platform nouns and ask whether the same behavior can be tested here: a named browser may mean any external browser, a named key the configured shortcut, a named remote host a delayed or disconnected target. Run the translated attempt only when it exercises the same underlying behavior, and label its evidence `translated` in the reply; when the missing environment is itself part of the defect, the result is not a reproduction. Hardware prompts, OS permission dialogs, device-only APIs and account states you cannot reach are real blocks -- name the one you hit.

## 5. Wire it in and keep it honest

- Add one line to the repo's `AGENTS.md` or `CLAUDE.md`: the final gate for a change to <app> runs `verify-<app>`. Leave it and the skill in the working tree and report them; commit only when the user asks.
- When the question is whether an existing PR or commit fixes a reported bug, follow `references/verify-existing-fix.md`: the generated skill drives the baseline and the patched build twice each, and the verdict is `confirmed`, `insufficient`, or `inconclusive`.
- When the user asks to audit the verify skill, or on a schedule (skill `schedule`), run the maintenance pass in `references/maintain.md`: a read-only source reader per feature, one live pass over every feature, and an outcome of `clean`, `changed` or `blocked`.
- When a later drive disagrees with the map, triage it in that change: a wrong description is doc drift, so fix the map; working behavior the harness cannot drive is a harness gap, so fix the harness and re-drive it; broken app behavior is a product regression, so report it and leave the map describing the intended behavior.

## Reply

- The skill path, its surface, and the feature files seeded.
- The end-to-end run: each command, its output or the evidence path, and the cleanup check.
- What stayed unverified, and any step waiting on the user (an approval, a device, credentials).

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/create-verification-skill` with its `references/feature-map-example`, `skills/maintain-verification-skill`, the check-matching and control-CLI guidance of `docs/guide/06-verify-and-ship.md`, and the environment-translation section of `automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md`.*
