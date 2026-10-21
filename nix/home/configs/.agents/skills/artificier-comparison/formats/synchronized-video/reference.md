# synchronized-video

Every clip plays on one shared clock in ms. The page groups takes by condition (one block per condition, its clips side by side), draws each take's events as markers and spans on a lane under the clips over one ms axis, and adds a transport bar (play, ±0.1 s, "0 ms로", speed 0.25-2×, scrubber; Space plays and pauses, ←/→ step 0.1 s), a sortable event table and an observation-notes section. Clicking a marker, a lane or a table row seeks every clip there.

`player.html` is a fixed template; `scripts/build-player.mjs` fills it with `takes.json` and writes the page. Edit the data, never the built page.

## 0 ms

0 ms is the first screen change after the trigger: the first frame that differs from the frame before the tap, click or navigation. The trigger itself is often invisible in a recording, while the first change is a frame anyone can find again, so every take is aligned on it. Events before it get negative times.

## Pad every clip so 0 ms sits at LEAD

`axis.lead` (seconds) is where 0 ms sits inside every clip file; the player seeks to `t/1000 + lead`. Find the first-change time `c` (seconds into the raw recording) frame by frame (below), then:

```bash
# c < LEAD: prepend (LEAD - c) seconds of the first frame
ffmpeg -i raw.mp4 -vf "tpad=start_duration=<LEAD-c>:start_mode=clone:stop_duration=2:stop_mode=clone" \
  -r <fps> -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart take.mp4
# c > LEAD: cut (c - LEAD) seconds off the front (-ss after -i, re-encoded, is frame-accurate)
ffmpeg -i raw.mp4 -ss <c-LEAD> -vf "tpad=stop_duration=2:stop_mode=clone" \
  -r <fps> -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart take.mp4
```

Keep the start and stop padding in one `tpad`; a second chained `tpad` came out about half its `stop_duration` short when tested. The `stop_duration` tail keeps the last frame on screen until `axis.max`; make each clip at least `lead + max/1000` seconds long. `-r <fps>` turns a variable-frame-rate screen recording into constant frames, so frame n sits at exactly n/fps. Pick `lead` ≥ `-axis.min/1000`; the build checks it.

Read the frame rate with ffprobe and record it as the take's `fps`:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,width,height,duration -of default=nw=1 take.mp4
```

## Read events frame by frame

Dump the frames around the event from the padded clip and open them with Read; the file named `n` holds the frame at `n / fps` seconds into the clip, so it sits at `t = n * 1000 / fps - lead * 1000` ms.

```bash
mkdir -p frames/<take-id>
ffmpeg -i take.mp4 -vf "select='between(t,<from>,<to>)'" -fps_mode passthrough -frame_pts 1 frames/<take-id>/%05d.png
```

`-frame_pts 1` names each file by its 0-based frame number in the constant-rate padded clip (at 30 fps, `00015.png` is 0.5 s in). An event time is the first frame that shows it. Its reading error is one frame interval, ±1000/fps ms: ±33 ms at 30 fps, ±17 ms at 60 fps, ±100 ms at 10 fps. Give each take its `fps` so the caption prints that error; the build prints a WARN line for a take without one. A timing difference smaller than the combined error of the two takes is a tie, and the notes say so.

## takes.json

`example/takes.json` is a complete small example with two conditions and four takes. It ships without clips; make placeholder clips to try it:

```bash
ffmpeg -f lavfi -i "testsrc2=size=270x600:rate=30:duration=6" -pix_fmt yuv420p -movflags +faststart asis-normal.mp4
ffmpeg -f lavfi -i "testsrc2=size=270x600:rate=30:duration=6,hue=h=120" -pix_fmt yuv420p -movflags +faststart tobe-normal.mp4
```

Fields:

- `title` (2-4 words), `subtitle`.
- `axis`: `{ "min": <ms>, "max": <ms>, "lead": <s> }`. Ticks are derived from min and max: the smallest step on a fixed ladder (100 ms, 200, 250, 500 ms, 1 s, 2, 5, 10, 15, 30 s, up to 10 min) that keeps the axis at 12 ticks or fewer.
- `kinds`: `[{ "id", "label", "color", "dark"? }]`. The table sorts the event column by this declared order, so list kinds in the order they happen (skeleton, content, image, then problems).
- `conditions`: `[{ "id", "title", "desc"?, "delays"? }]`, in display order; any number.
- `takes`: `[{ "id" (unique), "condition", "build", "label"?, "src", "fps"?, "aspect"?, "events" }]`; any number per condition and any number of builds. `src` is relative to `takes.json`, inside the output directory. `aspect` is `"w/h"` (`"9/19.5"`); without it the clip's own size sets the frame once its metadata loads.
- `events`: `[{ "t": <ms>, "kind", "text", "end"?: <ms> }]`; with `end` it is drawn as a span (a skeleton that stays up, a spinner), without it as a marker. Every `t` and `end` lies inside the axis.
- `notes`: a list of observations; the section hides when it is empty.

## Network-delay conditions

A condition describes the network it ran under in `delays`, one entry per delayed target:

```json
{ "id": "slow", "title": "Slow network", "desc": "Responses delayed by a mock proxy",
  "delays": [ { "target": "GET /api/items/:id", "ms": 1500 }, { "target": "every other API", "ms": 500 } ] }
```

`target` names what was delayed (an endpoint pattern, "images", "every other API") and `ms` the added latency. Apply the same delays to as-is and to-be through a mock or proxy layer, so the condition is the variable and the build is the comparison; a throttled network profile goes in `desc` (`"Chrome Slow 4G preset"`).

## Recording

Record the trigger the same way on every build. Replay one scenario file per interaction with the `record-replay` skill: `agent-device` records apps on iOS and Android (screen recording plus the replayed taps), `agent-browser` records web. Frame-timing verdicts come from a real device; a simulator or emulator take is labelled as such in its `label`.

## Build and preview

```bash
node <skill-dir>/formats/synchronized-video/scripts/build-player.mjs --takes takes.json --out index.html
```

It prints one `<src>\t<absolute path>` line per distinct clip (the Artifact `files` map) and a WARN line per take without `fps`. Seeking needs the server to answer HTTP Range requests: `python3 -m http.server` answers every request with 200 and the whole file, and there every paused seek leaves the clips at 0 while the clock moves. Preview through the published Artifact or a server that returns 206 for a `Range` header.
