---
name: component-pixel-review
description: Review a UI component's alignment or spacing fix on a real device by rendering the as-is and to-be versions of the component side by side in a throwaway playground, measuring each row against a red centre guide in device pixels, and handing back a compare.html gallery with as-is left and to-be right.
when_to_use: A Jira card says something is off by a few pixels -- vertical centring, a gap, a baseline -- and the verdict needs numbers and pictures rather than "looks fine". Also whenever a change to a shared component must be shown across every state the component can render, without wiring up the real data source behind it.
---

The evidence is the component itself, rendered twice in one screen: the shipped code in the left column, the edited code in the right, each fed the same case props. One screenshot then holds every state for both versions, and the measurement is a pixel count against a guide the playground drew itself, so the number is independent of anyone's eye.

`jira-qa-batch` is the sibling for whole-flow QA (two builds, two recordings, one video). This skill is for the component-level version: no data source, no navigation, one screen.

## The seven steps

1. **Pin the base.** `git fetch --prune`, then take the component as it ships from the default branch (`git show origin/<default>:<path> > <path>-asis.tsx`, rename the export). A fix already on the branch counts as to-be, so read `git log -3 -- <path>` first: a commit that names the card and says it was never checked on a device is exactly what this review is for.
2. **Derive the cases from the component's own gates.** Every `condition && <...>` branch in the JSX and every prop that changes the rendered text is one row. A rank badge gated on `rank >= 6` yields one badge row, and the real cutoff rank is the value to put in the props; a gate is the product's own list of states.
3. **Mount the playground.** Copy `playground.template.tsx` into the app, fill `CASES` and `Variants`, and return it from the app root in place of the navigator. The template draws a 1px red guide across the centre of each fixed-height container and logs `ROW <label> <theme> y=` from `onLayout`.
4. **Capture per theme.** Wait on the last row's log line, then `screencap`. Flip `THEME` and repeat; Fast Refresh re-renders without a relaunch.
5. **Measure and crop.** `measure-rows.py` locates the guides, crops every row at 4x, and writes the ink-centre offset of each row and each horizontal cluster into one JSON.
6. **Build the gallery.** `build-gallery.py` writes `compare.html` with as-is left, to-be right, the offsets in each heading, a hover overlay, and a theme filter. Put it under the QA folder the team already keeps for the card.
7. **Unmount.** Restore the app root, delete the playground and the `-asis` copy, relaunch the app, and confirm `git status` shows only the fix.

## Capture loop

```bash
adb reverse tcp:8081 tcp:8081
adb shell am force-stop <pkg> && adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1
adb logcat -c
until adb logcat -d ReactNativeJS:V '*:S' | grep -q 'ROW <last label> | tobe dark'; do sleep 2; done
adb exec-out screencap -p > dark.png
```

The `ROW` line is the readiness condition: it is printed only after layout, so the screenshot taken after it holds the finished tree. After flipping `THEME`, clear the log and wait for the same line with the new theme name.

Every row must be on screen at once, because the guides are counted top to bottom in case order and a scrolled screenshot breaks that order. Seven cases x two variants at ~51dp per row fits an 832dp phone; split the case list into two playground runs beyond that.

## Measure

```bash
S=~/.claude/skills/component-pixel-review
for t in dark light; do
  $S/measure-rows.py --shot $t.png --theme $t --cases A,B,C --variants asis,tobe \
    --x0 93 --x1 990 --out crops --json measure.json
done
```

- `--x0/--x1` bound the region inside the container (past the border, short of the trailing icon), in device px. Read them off the first screenshot once.
- `--row-px` is the container height in device px: 36dp x 2.8125 px/dp on a 450dpi phone = 101. The dp scale is `adb shell wm density` / 160.
- Each `runs` entry is `[x0, x1, centre_offset, colored_fraction]`; a fraction above 0.3 is an icon, the rest is text. That is how a badge and its neighbouring text are told apart without naming either.
- An offset of +0.5 on a 1px-tall guide is the rounding floor. A glyph box with a descender (`g`, `p`, `y`) reads a few px low in both columns; the comparison between columns still holds, so note it on the row rather than calling it a shift.

## Gallery

```bash
$S/build-gallery.py --json measure.json --crops crops --out qa/<KEY> \
  --title '<KEY> <what>' --lead '<device>, <branch@sha>, what the numbers mean' \
  --cases 'A=A nickname only;B=B legend badge + nickname' --full dark.png --full light.png
open qa/<KEY>/compare.html
```

Case titles carry the product's own names for the states (the rank's display name, the notice text's trigger), because the reader compares the gallery against the card and Figma, where those names are what appears.

## Reporting

State the branch and SHA the capture ran on, the device, and a table of `as-is → to-be` offsets per case with the guide as zero. Say which platform was measured and name the other one as unverified when only one device was on hand; a layout defect in shared code shows on both, but the number was taken on one.

## Verified against

2026-09-16, a React Native app on `main`, Galaxy S23 (Android 14, 450dpi), one card about a rank badge's vertical centring: the base commit's fix left badge rows at +2.5/+3.5 px, the flex-row rewrite brought every row to 0.0/+0.5, and `measure-rows.py` reproduced both sets of numbers from the same two screenshots.
