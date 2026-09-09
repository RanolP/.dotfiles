---
description: Run a batch of Jira QA cards by driving one scenario twice -- once against the as-is build and once against the to-be build -- on an Android phone with agent-device or on a web page with agent-browser, and hand back a side-by-side review video.
when_to_use: When a Jira card (or a JQL search full of them) needs manual QA and the verdict depends on seeing the old behaviour and the new behaviour next to each other -- a visual regression, a layout change, a copy change, a timing-sensitive screen. Covers an Android app and any web target.
---

One scenario, two runs, one video. **as-is** is the shipped behaviour and **to-be** is the branch under review; each run is recorded on its own and the two recordings are stacked left and right, so the reviewer reads the difference instead of replaying two clips.

The scenario is the unit of reuse. It is written once, committed in the app repo at `qa/scenarios/<JIRA-KEY>/`, and replayed for both sides, which is what makes the two runs comparable at all -- and what lets the next session and CI run the same file.

## The six steps

1. **Pick the cards.** `jira search '<JQL>'`, then `jira show -i KEY --json` for each. Read and write every card body as raw ADF, which keeps the images attached to it intact.
2. **Write the scenario.** One file per card under `qa/scenarios/<JIRA-KEY>/` in the app repo -- an `.ad` script for Android, a `batch` command list for web. Author it by recording your first exploratory pass rather than by hand; see the `record-replay` skill.
3. **Bring the two variants up.** Android: the two builds below. Web: two sessions pointed at the two URLs.
4. **Capture both sides.** One recording per side, into its own directory.
5. **Compose the review.** `compose-review.sh` stacks the two recordings and writes `review.html`.
6. **Report on the card.** Post the verdict as an ADF comment with `jira`.

## Web target: agent-browser

Two browser sessions run at the same time, so this is where a genuinely simultaneous capture is possible. `--session <name>` is what separates them; every command takes it.

```bash
BASE=https://app.example.com          # as-is
BRANCH=https://pr-128.preview.example.com   # to-be
OUT=~/.cache/jira-qa-batch/<JIRA-KEY>
mkdir -p "$OUT/asis-rec" "$OUT/tobe-rec"

agent-browser --session asis open "$BASE/some/page"
agent-browser --session asis record start "$OUT/asis-rec/asis.webm"
agent-browser --session asis batch --bail "scroll down 600" "click @e3" "screenshot $OUT/01-asis.png"
agent-browser --session asis record stop
```

- **`record start` writes WebM**, not mp4, and takes the file path: `record start <path.webm> [url]`. `compose-review.sh` accepts either container.
- **`record start` opens a fresh browser context** that keeps cookies and localStorage, so a login done before the recording survives into it.
- **`batch [--bail] "cmd" ...`** runs the scenario as one call instead of one round-trip per step, and `--bail` stops at the first failure. A committed scenario file is a list of these command strings, fed on stdin.
- **`diff url <u1> <u2>`** answers "did anything change at all" before you spend a recording on it, and `diff screenshot --baseline` compares one page against a stored baseline image.
- **The version-matched reference is `agent-browser skills get core --full`.** Read it rather than guessing flags from this file.

## Android target: agent-device

The phone has one screen, so the two sides are recorded **sequentially**: capture as-is, switch the bundle source, capture to-be. A timing-sensitive card is therefore weaker evidence here than on web; say so on the card rather than implying the two runs were simultaneous.

**The target names live outside this skill.** `APP_REPO` (the checkout), `PKG` (the application id) and `SERIAL` (the adb serial) are read from the environment or from `~/.claude-personal/jira-qa-batch.env`, which `setup-dual-instance.sh` sources; the script aborts naming the missing one. Export the same three before the `agent-device` commands below.

`setup-dual-instance.sh` does the switching:

```bash
~/.claude/skills/jira-qa-batch/setup-dual-instance.sh
# in the worktree holding the to-be code:
mise exec -- npx expo start --port 8083
```

It fixes the serial, applies the local `build.gradle` patch if it is missing, builds and installs the debug APK, backs up the preferences, points the instance at its bundle source, opens the reverse tunnel and launches the app. `--restore` undoes all of it.

**Which bundle a run actually used is a fact to verify, never to assume.** The device reaches the QA Metro through `adb reverse tcp:8082 tcp:8083`, and the proof it worked is the Metro's own inspector list:

```bash
curl -s http://127.0.0.1:8083/json/list | jq '.[].title'   # names the connected app
```

A rendered home screen proves nothing on its own: with `debug_http_host` unset the app falls back to the bundle inside the APK and looks identical. That fallback is deliberate -- 8081 usually belongs to some other worktree's Metro, so leaving it out of the picture makes a lost preference degrade into a clean as-is run.

**`android/app/build.gradle` stays in the working tree, uncommitted.** `debuggable-variants.patch` drops `debug` out of `debuggableVariants` so the debug APK carries its own bundle: RN 0.81's Gradle plugin skips bundling for every variant named in that list. Each run re-applies the patch from the skill directory, so `git status -- android/app/build.gradle` is expected to stay dirty for as long as the batch runs.

### Recording one side

```bash
export AGENT_DEVICE_SESSION=qa-tobe
export AGENT_DEVICE_STATE_DIR=~/.cache/jira-qa-batch/tobe
export AGENT_DEVICE_CLAIMS_DIR=~/.cache/jira-qa-batch/tobe/claims

agent-device open "$PKG" --serial "$SERIAL"
agent-device record start ~/.cache/jira-qa-batch/<JIRA-KEY>/tobe-rec/tobe.mp4
agent-device replay qa/scenarios/<JIRA-KEY>/flow.ad -e OUT=... -e SIDE=tobe
agent-device record stop
agent-device close --session qa-tobe
```

- **`record start` takes the path of the file to write.** Handing it a directory fails with `Path is a directory: rm returned EISDIR`.
- **`record start` cannot live inside a replayed `.ad` script.** It fails there with `A device execution lock can only be retained by a running request`, which the replay reports as `REPLAY_DIVERGENCE`. Keep the two `record` lines outside the script, around the replay.
- **Two sessions on one serial need both `AGENT_DEVICE_STATE_DIR` and `AGENT_DEVICE_CLAIMS_DIR`.** The state dir separates the daemons, the claims dir separates the ownership records; with only one of the two set the second session is refused with `DEVICE_IN_USE`. A session left behind by an earlier run blocks the device until `agent-device close --session <name>`, and `agent-device device status --platform android --serial <serial>` names the owner.
- **The shell here is zsh, which does not word-split an unquoted variable.** `agent-device $a` sends the whole string as one argument and comes back as `Unknown command`. Write each command out literally.

### Driving a second Android user profile

`agent-device` has no notion of an Android user profile, and its dist is a minified bundle with no source map whose identifiers move on every release, so the profile is injected below it. `adb-user-shim/` is a fake SDK root: `agent-device` prepends `$ANDROID_SDK_ROOT/platform-tools` to `PATH` and spawns the literal name `adb`, so the shim is what it finds. The shim splices `--user <id>` into exactly the sub-commands that accept one (`am start`, `am force-stop`, `am instrument`, `am broadcast`, `pm ...`, `cmd package ...`, `install`) and passes `input`, `screencap`, `screenrecord`, `logcat` and `getprop` through untouched, since those reject the flag.

```bash
export ANDROID_SDK_ROOT=~/.claude/skills/jira-qa-batch/adb-user-shim
export ANDROID_HOME=$ANDROID_SDK_ROOT
export AGENT_DEVICE_REAL_ADB=$(which adb)
AGENT_DEVICE_ANDROID_USER=95 agent-device open "$PKG" --serial "$SERIAL"
```

Verify the shim after changing it with `adb-user-shim/shim-selfcheck.sh`, which runs every rewrite against a stub adb and needs no device.

**The Samsung DUAL_APP profile (user 95) cannot run this app**, which is why the two Android sides are captured sequentially in one profile rather than side by side in two. That profile has no SSAID table of its own, so `Settings.Secure.ANDROID_ID` throws `IllegalStateException: Ssaid settings not accessible`. React Native reads it unconditionally in `DevServerHelper.getInspectorDeviceId` when the dev inspector connects, on an `AsyncTask` thread, so no JS-level guard can catch it and the process dies before the bundle renders. There is no setting that opens a Metro connection without the inspector: `DevSupportManagerBase.startInspector()` is gated on `isDevSupportEnabled` alone. The only fix is patching that one read in `node_modules/react-native/.../DevServerHelper.kt` -- which this repo does compile from source (`android/settings.gradle` substitutes `com.facebook.react:react-android` for the local project) -- and that is a change to ask the user for rather than to make.

**The helper APK is installed per profile, with its permissions granted.** `setup-dual-instance.sh` runs `adb install --user <u> -r -t -g` for every profile in play. Two failures come from skipping it: the install takes about 30 seconds on this phone against `agent-device`'s 30-second budget, so its own probe reports `adb timed out after 30000ms`; and a profile holding the helper without its runtime permissions crashes inside `UiAutomation` (`Cannot call disconnect() while connecting`, visible in `adb logcat -b crash`), which surfaces as `Android automation helper output could not be parsed` on every gesture while `screenshot` keeps working. Re-run the script after an `agent-device` upgrade.

## Composing the review

```bash
~/.claude/skills/jira-qa-batch/compose-review.sh \
  --asis ~/.cache/jira-qa-batch/<JIRA-KEY>/asis-rec \
  --tobe ~/.cache/jira-qa-batch/<JIRA-KEY>/tobe-rec \
  --out  ~/.cache/jira-qa-batch/<JIRA-KEY> \
  --steps qa/scenarios/<JIRA-KEY>/steps.tsv \
  --title "<JIRA-KEY> <summary>"
```

Each side's directory may hold several clips -- `agent-device` splits a recording longer than 180s into chunks -- and both `*.mp4` and `*.webm` are picked up, concatenated in filename order, then stacked under AS-IS / TO-BE headers.

`steps.tsv` is optional, tab separated, one row per step: `start_seconds`, `end_seconds`, `label`, `differs` (`0` or `1`). Rows marked `0` play at 10x so the idle stretches do not pad the video; rows marked `1` play at 1x and hold their last frame for a beat. Without the file the video plays straight through.

`review.html` is written next to `review.mp4` and picks up every `*.png` in the output directory as its screenshot gallery.

`drawtext` needs a font file outright, because this `ffmpeg` carries no fontconfig configuration and otherwise drops every label with `Cannot load default config file`. The default is Arial; override with `QA_REVIEW_FONT=/path/to.ttf`.

## Standing constraints

- **The review stays local.** Build `review.html` as a file and stop there; publish it as an Artifact when the user asks for that in so many words.
- **The `build.gradle` edit stays in the working tree**, and the batch reports it as a pending local edit rather than staging it.
- **Say which capture mode produced the video.** Simultaneous (two browser sessions) and sequential (one phone, two runs) are different strengths of evidence, and a timing-sensitive card deserves the caveat in the comment.
- **Pin the serial.** A second phone gets plugged in often enough that a bare `adb` call is a coin flip: `export ANDROID_SERIAL="$SERIAL"`, and pass `--serial` to `agent-device`.
- **Put the device back.** `setup-dual-instance.sh --restore` stops the instances, restores the preferences and drops the reverse tunnel; the QA Metro is yours to stop.
