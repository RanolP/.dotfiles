# Capture

How to reach one state and capture it, on web with `agent-browser` and on iOS/Android with `agent-device`. Every path below that starts `~/.cache/design-review/<repo>/` lives outside the user's repo.

## One state, one call

The agent's own round trip between two commands is seconds; a toast, a skeleton, or a mid-animation frame is gone by then. Write the whole walk to a state -- navigation, the readiness wait, the screenshot, the measurement -- as one batch so the CLI runs it at machine speed.

The readiness wait goes inside the batch, right before the screenshot, and names the element that distinguishes THIS state: present here and absent from its sibling states (a pre-air state's reservation bar, not the header both states share), or the content that defines the state (the pinned notice in a live chat). When that wait fails, the state is not reached, so no shot is saved under its name. A fixed duration is the last resort, for a state that has no distinguishing element.

### Staging a state

Stage data by mocking responses: on web, `agent-browser network route <url> --body <json>`; on apps, a proxy or response-replacement tool. A write that other people or sessions can see -- a chat message, server-side data in a shared QA environment -- needs the user's go first, and other sessions' writes can push your staged content out of a live window.

### Dev overlays

A dev-build overlay or badge in a shot (the Next.js dev "Issues" badge, a React Native RedBox or LogBox) is opened and read before any verdict on that shot, and its content goes into the box note or the platform reason; a runtime-only crash can surface nowhere else.

## Record once, replay after

The first walk to a state records a scenario file; as-is recaptures, every to-be capture, and every later review of the same repo replay it.

- Web: `~/.cache/design-review/<repo>/scenarios/<state-id>.web.json`
- App: `~/.cache/design-review/<repo>/scenarios/<state-id>.<ios|android>.ad`

### Web (`agent-browser`)

`agent-browser` has no native script recorder; the scenario is the JSON form of `batch` (an array of string arrays), kept in a file and run from it:

```json
[["set", "viewport", "375", "812"],
 ["open", "http://localhost:3000/plans"],
 ["wait", "--load", "networkidle"],
 ["wait", "--text", "Choose a plan"],
 ["screenshot", "<scratchpad>/shots/c1s1/web-asis.png"]]
```

```bash
perl -e 'alarm 25; exec @ARGV' -- agent-browser --session dr-<repo> batch --bail < ~/.cache/design-review/<repo>/scenarios/c1s1.web.json
```

### Screenshot time limit and the Chrome switch

Run every `agent-browser` call that takes a screenshot under a time limit, with an absolute output path. `perl -e 'alarm 25; exec @ARGV' -- <command>` works everywhere Perl does; macOS ships no `timeout`.

When a screenshot hangs, check first whether the displays are asleep: `system_profiler SPDisplaysDataType | grep -i asleep`. `caffeinate -u -t 2` wakes them, and `caffeinate -d -t <seconds>` keeps them awake for a long capture. Go on to the Chrome switch below only with the displays awake.

Some bundled Chrome for Testing builds never answer the screenshot request on some OS versions: open, eval, click and wait all work, and only the screenshot hangs. When a screenshot hits the limit while `agent-browser --session dr-<repo> eval '1+1'` still answers, switch browsers:

1. `agent-browser close --all`.
2. Relaunch the session on an installed Chrome. The path takes effect only when the browser launches, so pass it on the session's first command: `agent-browser --session dr-<repo> --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" open <url>` (on Linux, the `google-chrome` binary; `AGENT_BROWSER_EXECUTABLE_PATH` is the env form).
3. Use that session for every later capture of this review, and write the path to `~/.cache/design-review/<repo>/browser.json` (`{"executablePath": "..."}`) so later runs start with it.

GPU and sandbox flags (`--disable-gpu`, swiftshader, ANGLE variants, headed mode) leave this hang in place; go straight to the switch.

The viewport width is the Figma frame width. Rewrite the screenshot path (`-asis` → `-tobe`) and the origin (as-is worktree's dev server vs the working tree's) per run rather than keeping two scenario files.

Measure after the screenshot in the same session. `measure-web.js` reads its selectors from `window.__DR_SELECTORS` and throws when that is unset, so prepend that assignment and pipe both through `eval --stdin`, which returns the value of the last expression:

```bash
{ echo 'window.__DR_SELECTORS = ["[data-testid=plan-card]", "h1"];'; cat <skill-dir>/scripts/measure-web.js; } \
  | agent-browser --session dr-<repo> eval --stdin > <scratchpad>/shots/c1s1/web-asis.measure.json
```

The result is one entry per selector, `{selector, elements: [{box: {x, y, w, h}, computed: {...}, text}]}`, with boxes in CSS px relative to the viewport. The computed set covers font, colour, background, padding, margin, gap, border, radius, size and opacity. `agent-browser get box <selector>` reads one box by hand.

### App (`agent-device`)

Arm recording on the first `open`, walk, end on a destination guard, and publish:

```bash
agent-device open <app-id> --platform ios --relaunch --save-script=$HOME/.cache/design-review/<repo>/scenarios/c1s1.ios.ad
agent-device press 'id="plans-tab"' --settle
agent-device wait 'role="heading" label="Choose a plan"'
agent-device session save-script
agent-device screenshot shots/c1s1/ios-asis.png
agent-device snapshot -i --json > shots/c1s1/ios-asis.snapshot.json
```

The `wait` before `save-script` is required: a selector wait on a labelled or id-bearing element that distinguishes this state from its siblings (One state, one call). A duration wait or `wait stable` is refused as a destination guard.

Before judging an app to-be capture, confirm the app runs the working tree's bundle: check which dev server the app is connected to, since another worktree's Metro may be serving it (an Android emulator's debug app talks to `10.0.2.2:8081` directly and ignores `adb reverse`). An as-is bundle read as to-be produces false regressions.

Replay, then capture in the surviving session:

```bash
agent-device replay ~/.cache/design-review/<repo>/scenarios/c1s1.ios.ad --platform ios --keep-session
agent-device screenshot shots/c1s1/ios-tobe.png
agent-device snapshot -i --json > shots/c1s1/ios-tobe.snapshot.json
```

The snapshot's rects are the element bounds for the box union, in pt (iOS) or dp (Android).

A replay that stops with `REPLAY_DIVERGENCE` carries a `resume` field: fix the app state, then `agent-device replay <file> --from <n> --plan-digest <sha256>` continues from that step. When the script itself is wrong (a renamed id), arm repair with `replay <file> --save-script` and finish with `agent-device close --save-script`, which writes `<stem>.healed.ad`; move it over the original once its diff looks right.

A secret typed during recording goes through `--record-as`, so the script holds a placeholder: `agent-device fill 'id="password"' "$AD_VAR_PASSWORD" --record-as PASSWORD`, replayed with `-e PASSWORD=...`.

### Devices

```bash
agent-device devices --platform ios          # also --platform android
agent-device boot --platform android --device "<name from devices>"
```

`adb devices -l` lists connected Android hardware as well. `boot` takes the device through the selection flags, once the user has approved the boot. Which device to use (real or emulator, which model) comes from the repo docs or the user's memory. When the second platform still cannot be booted, record its platform entry as `missing` with the reason and the user action that would unblock it.

## Login on web

Start a visible browser and let the user log in themselves:

```bash
agent-browser --headed open http://localhost:3000/login
```

Ask the user to log in in that window and wait for their confirmation; the credentials stay with them. To reuse a Chrome where they are already logged in, use `--profile <name|path>` (a Chrome profile) or `--auto-connect` (a running Chrome).

## DRM and other features bundled Chromium lacks

Widevine playback and similar features work only in the user's own Chrome. Attach to it:

```bash
agent-browser --auto-connect open <url>
```

`--auto-connect` needs Chrome running with remote debugging. When it reports `No running Chrome instance found`, ask the user to restart Chrome with:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

`--remote-debugging-port` gives any local process control of that browser, so say so and ask them to close it after the review. When the host offers a Chrome extension bridge (Claude in Chrome), that is the alternative: drive the user's Chrome tab through it and save its screenshots to the same `shots/` paths.
