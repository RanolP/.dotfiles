---
name: record-replay
description: Record a scenario to a file on its first run, then replay that file instead of retyping the steps.
when_to_use: Before driving a UI, an app, or any multi-step flow you expect to run more than once -- self-verifying your own change, reproducing a bug, or leaving a regression check behind. Also when a replay diverges and you are about to fix it by hand.
---

A flow you type by hand exists only in one transcript. A flow you record exists as a file the next session, the next person, and CI can run.

## Record on the first pass, not the second

Arm the recording before you walk the flow. Walking it once to explore and then re-walking it to record costs two passes and drifts between them.

The rule of thumb: **the second time you are about to type the same sequence, you already needed a file.**

Commit the scenario next to the code it exercises. A scenario left in a scratchpad directory is gone next session.

## agent-device -- native record and replay

Arm on `open`, publish with `session save-script` (keeps the session) or `close --save-script` (publishes as it closes). `close --save-script` without an armed `open` is rejected.

```bash
agent-device open <app> --relaunch --save-script=<name>.ad
agent-device press 'id="continue"' --settle
agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD
agent-device wait 'role="heading" label="<destination>"'
agent-device session save-script
```

The `wait` before publishing is a **destination guard** and must be a selector wait on a labeled or id-bearing landmark -- a duration wait, `wait stable`, or `wait @ref` does not qualify and the publish is refused.

`--record-as` (fill only) keeps the secret out of the file: the script holds `${PASSWORD}` and takes its value from `-e PASSWORD=...` or `AD_VAR_PASSWORD` at replay.

```bash
agent-device replay <name>.ad -e PASSWORD=hunter2      # --keep-session leaves the session up
agent-device test './e2e/*.ad' --reporter junit:report.xml --retries 1 --fail-fast
```

`test` also takes `--artifacts-dir <path>`, `--record-video`, and sharding (`--shard-split <n>`, `--shard-all <n>`).

### A diverged replay resumes; it is not re-walked

A failing step returns `REPLAY_DIVERGENCE` carrying ranked selector suggestions and a `resume` field. Fix the state with `--no-record` actions, then continue from where it stopped:

```bash
agent-device replay <name>.ad --from <n> --plan-digest <sha256>
agent-device close --save-script          # writes <stem>.healed.ad
```

`--plan-digest` is mandatory with `--from` and fails fast on a mismatch, so a resume can never run against an edited script. `--update`/`-u` is retired and rewrites nothing.

## agent-browser -- no native replay; the scenario is a JSON file

`agent-browser record` captures a `.webm` video, not a runnable script. The runnable form is `batch`, whose steps are JSON arrays it accepts as arguments or on stdin:

```bash
agent-browser batch --bail < scenarios/checkout.json
```

Keep the scenario in that file and edit the file, not the command line. `--bail` stops at the first failure; the default runs every step.

Reuse login state across runs instead of re-authenticating in the scenario:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix task)"
agent-browser --session "$AGENT_BROWSER_SESSION" --restore open <url>
```

Starter scripts for auth, capture, and form flows ship with the CLI: `agent-browser skills path core`, then `templates/*.sh`.

## Selectors that survive a rebuild

A committed scenario outlives the build it was recorded on, so every target in it names what the user sees or what the code named on purpose, in this order: role plus accessible name, then an ARIA relationship or a purpose-named test id (`id=`, `data-testid`), then visible text. Generated class names (CSS modules, StyleX, Tailwind JIT hashes), child indexes such as `nth-child`, and raw coordinates change on the next build; when a recording captured one, replace it with a selector from that list before committing, and add a test id to the code when the element has nothing stable.

## Evidence that a recording proves something

A recording or screenshot backs a repro or a fix only when it shows two things: enough app chrome (URL bar, build label, app header) to prove which app and build is under test, and the discriminating state itself -- the broken frame for a repro, the corrected frame for a fix -- rather than the setup or a loading screen before it. End each capture on that state.

Before claiming a repro or a fix from media, hand only the files plus a one-line description of the broken and the correct state to a read-only worker that has not seen the session, and ask it one question: does this evidence visibly show that state? A "no" or an uncertain answer leaves the claim unconfirmed; capture better evidence and ask again, or report it as not reproduced.

## Everything else

The same shape applies with no special tooling: put the curl calls, the payload, or the input sequence in a file, and run the file. A shell script committed beside the code beats a command you will retype from memory.

`ui-automation` covers how to batch a flow you are walking now; this skill covers turning that flow into a file. `diagnose` Phase 1 treats a replayable scenario as the feedback loop it asks you to build.
