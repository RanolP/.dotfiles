---
name: ui-automation
description: Drive browser, simulator, device and app UI with `agent-browser` and `agent-device`, sending each scenario as ONE batch call so timing-bound UX survives the agent's own round-trip latency. Covers the batch syntax of both CLIs, where waits and evidence capture belong, how far one batch can reach, and the version-matched docs to read first. Use when automating any web page, simulator, physical device, TV or desktop app UI. The `agent-tooling-guard` PreToolUse hook injects this skill in full at the first `agent-browser` or `agent-device` command.
---

# UI automation

`agent-browser` drives a browser over CDP, including the Chrome the user already has open (`agent-browser connect <port|url>`). `agent-device` drives iOS, Android, macOS, TV and web app UI. Both ship docs version-matched to the installed binary, so read them before the first call of a session rather than guessing flags:

| Tool | Read first | Then |
|---|---|---|
| `agent-browser` | `agent-browser skills get core --full` | `agent-browser skills list` for electron, slack, dogfood, derive-client |
| `agent-device` | `agent-device help commands` | `help workflow` for the full reference, `help scripting` for batch, `.ad` scripts and replay |

## One scenario, one call

Your own round trip is the slow part of every UI interaction. Each Bash call carries a whole model turn — reasoning, dispatch, reading the result — so two consecutive commands land seconds apart. The CLI itself runs them back-to-back in tens of milliseconds. Measured on 2026-08-21 against one live `agent-browser` session, three reads (`get url`, `get title`, `eval 1+1`) took 168 ms as three separate invocations and 47 ms inside one `batch`, and the separate form additionally spent three model turns.

Everything the UI shows only for a moment falls into that gap: a toast that auto-dismisses, a skeleton before its content, a focus ring, an animation mid-flight, a debounced search, a spinner between two screens, a snackbar's undo button. Decide the whole scenario up front, then send it as ONE batch, so the CLI walks it at machine speed and the window is still open when the assertion runs.

### agent-browser

Each argument is one command string, split on whitespace:

```bash
agent-browser batch --bail \
  "click @e7" \
  "wait .toast" \
  "screenshot ./toast.png" \
  "get text .toast"
```

When any argument contains a space, feed the JSON form on stdin — an array of string arrays:

```bash
echo '[["fill","#search","hello world"],["wait","300"],["get","text",".results"]]' \
  | agent-browser batch --bail
```

`--bail` stops at the first failure. Without it every step runs, which is what you want for a sweep of independent reads and wrong for a chain where step 3 is meaningless if step 2 missed.

### agent-device

Steps are `{"command": ..., "input": {...}}`, with every argument inside `input` under the same field names the single command uses:

```bash
agent-device batch --on-error stop --steps '[
  {"command":"press","input":{"target":"id=\"add-to-cart\""}},
  {"command":"wait","input":{"kind":"duration","durationMs":150}},
  {"command":"screenshot","input":{"path":"./cart-toast.png"}},
  {"command":"snapshot","input":{"interactive":true}}
]'
```

`--steps-file <path>` reads the same JSON from a file, which is the readable form once a scenario passes a handful of steps. `--max-steps <n>` caps it and `--out <path>` writes the result. Step positionals and flags still parse but are deprecated, so write new steps as `command` + `input`.

## Put the waits inside the batch

A wait spent between two Bash calls is wasted — the model turn already took longer than the wait. A wait spent inside the batch is the thing that makes the next step land in the right frame.

| Need | `agent-browser` | `agent-device` |
|---|---|---|
| A specific element or text appeared | `wait <selector>` | `wait text <text>` / `wait <selector>` / `wait @ref` |
| A fixed window (animation, debounce) | `wait <ms>` | `wait <ms>`, or `{"kind":"duration","durationMs":<n>}` in a batch step |
| The UI stopped moving | — | `wait stable [quietMs] [timeoutMs]` (defaults 500/10000) |
| This mutation settled | — | `--settle` on the mutating command |

For `agent-device`, prefer `--settle` on the action and continue from its settled diff; reach for `wait stable` after an `open`, a relaunch or a navigation, and for a result that arrives over the network use `wait text "<expected>"` rather than a polling loop.

## Capture the evidence in the same batch

A transient state is gone by your next turn, so the batch that triggers it also captures it. Put the `screenshot`, the `get text`, the `get box`, the `diff snapshot` in the same call as the action that caused the thing you are proving.

For a window too long or too jittery for one assertion, record it instead and read the artifact afterwards: `agent-browser record start <path>` / `record stop`, or `agent-device record start` / `record stop`. `agent-browser trace start|stop` and `vitals` cover timing you need as numbers rather than frames.

## How far one batch reaches

A batch reaches exactly as far as the scenario you can decide without looking. The moment a target comes out of a snapshot you have not read yet, the batch ends there:

1. Batch up to the decision point, ending with the `snapshot -i` (or `find`, or `get`) whose output you need.
2. Read it, pick the ref or selector.
3. Batch the whole rest of the scenario from there.

Two or three batches for a long journey is the shape to aim for. A stable, known path needs no split at all: `agent-device` refs stay valid until the app state changes, and a known label or id survives a mutation, so a scenario written against ids and labels batches end to end.

A batch is for the journey you are walking now. For one you will run again, record it to a file and replay that file -- the `record-replay` skill carries the arm-and-publish shape, the secret-safe `--record-as` fill, the `agent-browser` JSON scenario, and the divergence-resume loop.

## Ordering facts

`agent-device` runs stateful commands (`open`, `press`, `fill`, `type`, `scroll`, `back`, `alert`, `replay`, `batch`, `close`) serially within one session, so a batch is already the serialized form. Concurrency belongs to read-only commands, or to separate sessions and devices — `agent-browser --session <name>` and `agent-device --session <name>` isolate them.

Read a verdict from the structured output, not the message text: `agent-device --json` puts the wait verdict in `error.details.reason` (`wait_target_absent`, `wait_capture_stalled`, `wait_deadline_exceeded`, `wait_stable_timeout`), and `agent-device --level digest` shrinks a response you only need the outcome of.
