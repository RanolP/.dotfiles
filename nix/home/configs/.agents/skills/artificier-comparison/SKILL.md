---
name: artificier-comparison
description: Publish an as-is vs to-be comparison as a claude.ai Artifact in one of two formats -- still-cut-onion (as-is | to-be | onion skin per row, with a per-row opacity slider and a red/cyan colour-separation toggle) or synchronized-video (every clip on one shared ms clock over event lanes, with markers, spans, scrubber, step, speed, a sortable event table and observation notes).
when_to_use: The user wants a before/after, as-is/to-be, or base-vs-branch comparison shown as a page -- screenshots of the same screens on two builds, or screen recordings of the same interaction timed against each other ("비교 페이지", "전후 비교", "타임라인으로 맞춰서 보여줘", "compare these recordings").
---

A comparison is two captures of the same thing under the same conditions, built into one page and published as one Artifact. The format follows the evidence: a still difference (layout, colour, copy) is a still-cut-onion; a timing difference (what appears when, flicker, layout shift, loading order) is a synchronized-video.

`<skill-dir>` below is the folder holding this SKILL.md; every script and reference is addressed relative to it. Every script takes `--help` and `--selftest`.

- `formats/still-cut-onion/reference.md` -- `stills.json`, the build command, and the shared onion library that `design-review` also renders with.
- `formats/synchronized-video/reference.md` -- `takes.json`, what 0 ms means, padding clips with ffmpeg, reading events frame by frame, describing network-delay conditions, and recording.

## Requirements

Node.js ≥ 20 (built-ins only). For synchronized-video: `ffmpeg` and `ffprobe` from PATH (`which ffmpeg ffprobe`), plus whatever records the clips (`record-replay` skill, `agent-device`, `agent-browser`). A host that can publish an Artifact; otherwise open the built `index.html` locally.

## The flow

1. **Pick the format** from the difference being shown: still-cut-onion for how screens look, synchronized-video for when things happen. A review that needs both publishes two Artifacts.
2. **Capture as-is and to-be under the same conditions**: the same device or viewport, the same account and data, the same mocked responses or network delay, and the same scenario replayed on both builds. Record the scenario on the first pass and replay it for the second (`record-replay` skill), so the only variable is the build.
3. **Write the input JSON** beside the captures, in the session scratchpad: `stills.json` or `takes.json`, each capture path relative to it.
4. **Build** with the format's script; the output `index.html` goes in the same directory as the input JSON, because every capture must sit under the output directory.
5. **Open the result yourself** before reporting on it: Read each still you describe, and for video, the frames you read the event times from.
6. **Publish** `index.html` as a claude.ai Artifact whose `files` map is exactly the `src\t<absolute path>` lines the build printed (WARN lines are not `files` entries). After any recapture or data edit, rebuild and republish to the same Artifact URL, so the version history keeps the earlier comparison.

## Reporting

Give the Artifact link, what as-is and to-be each are (branch and SHA, or app version), the device or viewport (simulator or emulator labelled as such), the conditions compared, and for video each take's fps with its reading error.
