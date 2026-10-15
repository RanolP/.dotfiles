---
name: design-review
description: Review an implementation against a Figma URL by locking the right value (the answer) of every property from the design's outline and tokens, capturing the base branch (as-is) and the working tree (to-be) on every platform, and publishing a gallery of Figma | as-is | to-be | onion skin with one numbered box per mismatch, each fixed in batches and committed per box once the user resolves it.
when_to_use: The user hands over a Figma URL and asks to review, compare, or QA the implementation against it -- "디자인 리뷰", "design QA", "does this match Figma", "check the screen against the design".
---

The design is read as structure before it is read as pictures. The outline and the tokens decide what each value should be (the answer). Whether the implementation matches is decided from photos: each state × platform capture placed beside its Figma frame image. Source reading and measurement locate and explain a mismatch; a photo beside the frame is what closes one. Every mismatch becomes a box with an id (`DR-001`, `DR-002`, ...) that lives in one `review.json`, appears on one published gallery, and ends as one commit.

`<skill-dir>` below is the folder holding this SKILL.md; every script and reference is addressed relative to it.

- `references/capture.md` -- reaching and capturing a state: batch syntax, record-then-replay, devices, headed login, DRM in the user's Chrome.
- `references/review-json.md` -- the `review.json` contract, its skeleton, and which script subcommand changes which field. Every script takes `--help`.

## Requirements

Node.js ≥ 20 (built-ins only; agent-browser already requires Node), git, `agent-browser`, `agent-device` (apps only), a Figma MCP server exposing `get_metadata`, `get_design_context`, `get_variable_defs` and `get_screenshot`, and a host that can publish the gallery (a claude.ai Artifact; otherwise open `index.html` locally). That is the complete external list.

## The seven steps

1. **Outline the design** (`get_metadata` only).
2. **Lock answers** (`get_design_context` + `get_variable_defs`).
3. **Prepare** the base branch, the platforms, and each state's preconditions.
4. **Capture as-is** and turn every mismatch into a fix box.
5. **Fix in batches**, capturing to-be once per batch.
6. **Publish** the gallery, again after every batch and every resolve.
7. **Resolve** box by box into commits.

Phases 1-2 work from the outline and the tokens alone. The column-1 Figma screenshots (`get_screenshot`) and every screen capture start in phase 4, once the answers are locked.

## 1. Outline

Read the node the URL names with `get_metadata` (a call with only the fileKey may list nothing but a Thumbnail page), and claim a design is absent only after reading that node. Judge the hierarchy structurally, refining the inference as you read:

- The outermost frame (or section) under the page is a **concern**.
- The frames directly inside a concern are its **states**, a sequence ordered by position: left to right, then top to bottom.
- Text and sticky nodes inside or beside a concern but outside its states are its **notes**.

Ask the user back only where the structure leaves you unsure (a frame that might be a state or a component sheet, a note that might belong to either neighbour).

## 2. Answers

First set a tolerance per property kind, applied to values measured from a screenshot or a computed style: size and spacing ±1 logical unit, colour exact by token or hex, font-family exact, copy text exact. A token-name-to-token-name comparison read from source is exact and needs no tolerance.

Score what Figma can express and what the code owns:

- **Scored:** every static property of an element the code always renders, copy text included (wording is a property). Where design and code disagree, the design is the answer.
- **Left unscored:** elements whose presence operations or content config decides (a banner the ops team toggles, whether a server-driven list appears), and motion Figma cannot express (marquee, auto-scroll, animation). Before editing code around such a behaviour, read the commit that introduced it (`git log -S '<symbol>'` or `git log -L <start>,<end>:<file>`) so the fix keeps it.
- **A screen with no web design:** search the desktop/web canvas fully first; only then is the app design the answer for web. Every time a web state is judged against an app frame, tell the user which web state was judged by which app frame, so they can forward it to the designer.
- **Each platform against Figma:** judge every platform against the design; a cross-platform comparison speaks only to code consistency. A web screen shown inside an app webview is captured in the app as well.

For each state, build the layout tree with `get_design_context` and read the bound tokens with `get_variable_defs`. For every relevant node, lock the **answer** for every property -- font-size, font-family, font-weight, line-height, padding, margin/gap, color, background, border, radius, size, and any other the node sets. Record both the token name and its value, and treat the token name as the answer whenever one exists (`spacing/16 (16)`).

A value is **suspicious** when:

- it is a raw value with no token;
- the same element carries different values across states;
- the node's value disagrees with its token's value.

Resolve a suspicious value, or a node that carries no rule, from the notes around it, the adjacent annotation nodes, and the Figma comments; mark it unconfirmed only after reading those. When they leave it open, ask the user, listing every open value in one question.

## 3. Prepare

- **Base branch (as-is).** Infer it from `origin/HEAD`, `main`, `release/*` and similar remote branches: pick the one whose merge-base with the current branch is nearest (fewest commits in `git rev-list --count $(git merge-base <candidate> HEAD)..HEAD`), then ask the user to confirm it. To-be is the current working tree. Write the `review.json` skeleton now (`references/review-json.md`, Writing it).
- **Platform**, detected per repository. `react-native` or `expo` in `package.json`, or both `ios/` and `android/` directories, means an app; anything else is web. An app is captured on BOTH iOS and Android; read the device inventory (`agent-device devices --platform ios|android`, `adb devices -l`) and boot what is missing (`references/capture.md`, Devices). Take the device choice (real device or emulator, which device) from the repo docs or the user's memory. A result from a simulator or emulator is labelled as such in the platform's reason and in the report, and frame-timing and animation verdicts come from a real device only. A state the app cannot reach with live data is reached by mocking API responses (`references/capture.md`, Staging a state). `missing` is the last resort, after the inventory and the mock: mark it with `review-edit.mjs platform --review review.json --state <id> --name <platform> --status missing --reason '<reason>'`. The gallery prints the reason as one line `<platform>: <reason>` under the state, so write it as one short line naming why and the user action that would unblock it (`기기 없음, 이번 판 촬영 제외 -- Android 기기를 연결하면 촬영`).
- **Preconditions.** Reason about what each state needs to be reachable -- "the carousel updated", "an account with an active membership", "a season/series item set up" -- and group states that share a precondition so the user is asked once per group, for exactly those things. Cache the answers in `~/.cache/design-review/<repo-name>/preconditions.json` keyed by state, reuse an entry when it still fits, and say which cached entry was reused. A state that depends on live or time-windowed data (a broadcast, a chat history, an event window) has its cached entry re-checked against the live system before each capture.
- **Environment facts.** Read the app repo's `docs/` for QA servers, login helpers and test accounts; product-specific setup lives there or in the user's memory.

## 4. Capture as-is and compare

Check the window of any content available only for a limited time (a live broadcast, a timed event) and schedule its capture inside that window; when the window has closed, reach the state by mocking its responses, and only when that fails tell the user and mark its platforms `missing` with that reason.

Check out the confirmed base in its own worktree and run it there:

```bash
git worktree add ../<repo-name>-asis <base-branch>
```

Every state gets an as-is photo, taken against that worktree with the same scenario and the same mocked responses as its to-be photo. For a new feature, the as-is photo is the same screen or route on the base branch before the feature existed.

Reach each state as `references/capture.md` describes: the first pass records a scenario into `~/.cache/design-review/<repo-name>/scenarios/`, every later pass (to-be, recaptures) replays it, and each walk runs as one batch. Apps are captured with `agent-device` on both platforms, web with `agent-browser` at the Figma frame width. Every web screenshot runs under a time limit; on a hang, switch to the installed Chrome as `references/capture.md` describes, and start with the browser cached in `~/.cache/design-review/<repo-name>/browser.json` when one is there. Web login happens in a headed browser where the user logs in themselves; DRM playback is captured in the user's own Chrome (both in `references/capture.md`).

Compare every state × platform by opening its photo with Read beside the state's Figma frame image (`get_screenshot`, saved as `shots/<state-id>/figma.png`); that side-by-side look is the verdict. A state Figma has no frame for takes the nearest frame, the closest sibling state of the same concern, as its `figmaShot`, plus one note in the state's `notes` naming that substitute frame and saying Figma has no frame for this state, so the reader knows the Figma column is a stand-in; that state's boxes are judged against the substitute frame together with the notes. Then locate and explain each mismatch from the source -- component styles and theme tokens, token name against token name where both sides have one -- and measure where the code alone does not settle a value: `<skill-dir>/scripts/measure-web.js` on web (bounding box and computed styles per selector, `references/capture.md`), `agent-device snapshot -i --json` rects on apps. A source value equal to the answer explains a match the photo already shows; it closes nothing on its own. Calling a visible difference "intended per Figma" takes the Figma frame image and the photo side by side, never a node property alone. When a box hinges on a few device pixels (vertical centring, a gap, a baseline) or on a component state the screen cannot reach without staging data, and the `component-pixel-review` skill is installed, measure that box with it (as-is and to-be rendered side by side in a playground, offsets read against a guide) and write its offsets into the box's `asis` or note via `review-edit.mjs`. Record each as-is image with `review-edit.mjs platform --review review.json --state <id> --name <platform> --asis <path>`. Each mismatch becomes a fix box, with the as-is bounds as its first `rect`:

```bash
node <skill-dir>/scripts/review-edit.mjs add --review review.json --kind fix --state c1s1 --platform ios \
  --rect 16,120,361,48 --node-id 12:55 --node-name Button/Primary --property padding \
  --asis 12 --answer 'spacing/16 (16)' --files src/components/Button.tsx
```

## 5. Fix in batches

Every fix box lists its files before any edit. For each batch:

1. `node <skill-dir>/scripts/review-edit.mjs batches --review review.json --write` selects the next set of open fix boxes with disjoint file sets and stamps their batch number; a box sharing a file with a fixed but unresolved box waits, so overlapping boxes go one at a time. Give a box its `files` with `review-edit.mjs set --review review.json --id DR-### --files a,b` when `add` left them out.
2. Fix every box in the batch and mark each one with `review-edit.mjs status --review review.json --id DR-### --to fixed`, which stamps `fixedAt`.
3. Capture to-be once for the affected states on every platform by replaying the scenarios against the working tree, measuring the same elements again, and open each new photo beside its Figma frame image. Record each image with `review-edit.mjs platform --review review.json --state <id> --name <platform> --tobe <path>`, and the to-be commit with `review-edit.mjs meta --review review.json --tobe-sha <sha> --tobe-dirty true|false`. A recapture, as-is or to-be, replaces the existing state's photo through that same `platform --asis`/`--tobe` call, and the state list stays the one outlined in step 1; a defect seen mid-review (a render-error screen) becomes a box, or a note on a box, of the existing state.
4. `review-edit.mjs union --review review.json --id DR-### --asis x,y,w,h --tobe x,y,w,h` widens each box's `rect` to the union of the element's as-is and to-be bounds, per platform, in that platform's logical units; pass only the side where the element exists when it exists on one side only.
5. `node <skill-dir>/scripts/diff-regions.mjs --asis <platform>-asis.png --tobe <platform>-tobe.png --width <logical> --exclude-boxes review.json --state <id> --platform <name>` prints the changed regions (JSON `{x, y, w, h}` in logical units) that the recorded boxes do not already cover; add each as `review-edit.mjs add --review review.json --kind unintended --state <id> --platform <name> --rect x,y,w,h`.
6. Republish (step 6).

## 6. Publish

Everything lives in the session scratchpad: `review.json`, and `shots/<state-id>/` holding `figma.png` (from `get_screenshot` of the state node, taken now in the comparison phase), `<platform>-asis.png` and `<platform>-tobe.png`.

```bash
node <skill-dir>/scripts/build-gallery.mjs --review review.json --out index.html   # prints <src>\t<absolute path> per image, plus CONTACT and WARN lines
```

`index.html` goes beside `review.json`, since every image must sit under its directory. Before anything about the result goes out, open every `CONTACT <abs path>` contact sheet (Figma | to-be per state × platform) with Read yourself, including when a capture worker already reported a verdict. An image Read that returns empty means the sheet is unseen: reopen it, and write nothing about its content until it is seen. Resolve every `WARN near-duplicate <concern> <platform> <stateA> <stateB> <side> <fraction>` line before reporting: recapture with a guard that targets the element distinguishing the two states (`references/capture.md`, One state, one call), or state why the two states legitimately look alike. Publish it as a claude.ai Artifact whose `files` map each printed `src` line to its absolute path (the CONTACT and WARN lines are not `files` entries), and republish to the same Artifact after every batch and every resolve; on a host without Artifacts, open `index.html` locally. The gallery shows four columns -- Figma | as-is | to-be | onion skin of as-is and to-be (opacity slider by default, red/cyan colour-separation toggle) -- with the same absolutely positioned boxes over columns 2-4. A platform marked `missing` with no photos and no boxes shows as one line `<platform>: <reason>` under the state in place of its cells. The gallery always shows one final set: each state keeps the name step 1 gave it, and state names, state notes and box `asis`/`note` fields describe what the screen is now. The review's history lives in the Artifact's version history, which republishing to the same Artifact keeps. Boxes are off by default and toggle with a button or the `b` key; when on, only `open` boxes are drawn, and a "해결된 박스도" checkbox draws `fixed`, `resolved` and `accepted` boxes too. The table always lists fixed boxes and lists resolved and accepted ones only while that checkbox is on. Clicking a box id in the table shows that box alone and copies `DR-### resolved`. Each label sits outside its box, placed clear of the other labels.

## 7. Resolve

The user resolves a box by saying `DR-007 resolved` (the phrase the gallery copies).

- **Fix box:** stage only that box's `files`, commit with a subject in the format dominant in the repo's `git log --oneline -30` that names the box id, run `review-edit.mjs status --review review.json --id DR-### --to resolved --commit <sha>`, and republish. The script accepts it once the box's state × platform has a to-be photo taken after `fixedAt` on a platform that is not `missing`; recapture to satisfy it. `--no-photo-reason '<text>'` is for a box no photo can show (a non-visual property), and its reason appears on the gallery. Two boxes whose fixes landed on the same lines share one commit that names both ids.
- **Unintended box:** resolved means accepted -- `review-edit.mjs status --review review.json --id DR-### --to accepted`, with no commit. When the user wants it reverted instead, treat it as a fix box.
- **A fixed box the user is not satisfied with:** fix it again, recapture the affected states, and republish.

## Reporting

Give the gallery link, the base branch and SHA, the to-be branch and SHA (and whether the tree is dirty), each platform's device or viewport (simulator or emulator labelled as such), the count of boxes by status and how many were resolved with a `noPhotoReason`, every platform marked missing with its reason and the user action that would unblock it, each web state judged against an app frame, and the content of any dev overlay seen in a shot. Every verdict in the report comes from contact sheets you opened yourself (step 6).
