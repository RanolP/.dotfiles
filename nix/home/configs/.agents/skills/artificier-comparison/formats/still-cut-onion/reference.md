# still-cut-onion

One row per screen or state: as-is | to-be | onion skin of the two. Each onion cell has its own opacity slider for the to-be layer (only when the row has both captures) and its own red/cyan colour-separation toggle, so one row can sit in colour separation while its neighbours stay blended. In separation, red is the as-is luminance and cyan (green + blue) is the to-be luminance: grey means identical, red or cyan fringes mark what moved. A page opened from a `file://` path keeps the onion blended and shows the "http(s)로 열었을 때만" notice under the toggle, since the browser blocks reading the pixels there.

## stills.json

```json
{
  "title": "Settings Screen Refresh",
  "subtitle": "main@abc1234 vs feat/settings@def5678, iPhone 15 simulator",
  "notes": ["Spacing moved to the 8 pt grid."],
  "rows": [
    { "name": "Settings, logged in", "notes": "Section headers now use title/s.", "asis": "shots/settings-asis.png", "tobe": "shots/settings-tobe.png" },
    { "name": "Delete-account sheet", "asis": null, "tobe": "shots/delete-tobe.png" }
  ]
}
```

- `title` is a name of two to four words; it becomes the page title.
- `subtitle` and top-level `notes` are optional. A row's `notes` is optional and is a string or a list of strings.
- `asis` / `tobe` are PNG or JPEG paths relative to `stills.json`; `null` marks the side where the screen does not exist (a new screen, a removed one). A one-sided row keeps its colour toggle and has no slider.
- Every row is drawn in one frame ratio: the first image's width over the tallest image scaled to that width, so full-page captures of different heights line up top-aligned.

## Build

```bash
node <skill-dir>/formats/still-cut-onion/scripts/build-still-cut.mjs --input stills.json --out index.html
```

It prints one `<src>\t<absolute path>` line per image: the Artifact `files` map. Every image path must resolve inside the `--out` directory; the build stops with the offending path otherwise.

## The shared library

`scripts/lib/onion.mjs` owns the onion cell and everything generic around it: `esc`, `numberText`, `readImageSize` (PNG/JPEG header), `imageCollector` (relative `src` paths plus the `files` map), `shotImage`, `onionCell`, and `onionAssets()` returning the CSS and JS in `scripts/lib/assets/`. The onion state (opacity, colour mode) is scoped to each `.onion-cell` figure.

`design-review` builds its gallery on this library: `design-review/scripts/lib/render.mjs` imports `../../../artificier-comparison/formats/still-cut-onion/scripts/lib/onion.mjs` and inlines `onionAssets()` ahead of its own gallery CSS and JS. That relative path resolves after deployment because `localSkill` in `nix/home/default.nix` links every local skill out of one store copy of the skills tree, so the two skills stay siblings. The argument parsing and exit codes of every script in both skills (`parseCliArgs`, `run`: 2 on a usage error, 1 on a failure) live in `artificier-comparison/scripts/lib/cli.mjs`. A change to the onion cell, its controls or the shared tokens is made here once and reaches both pages; check both with `--selftest` (`build-still-cut.mjs` and `design-review/scripts/build-gallery.mjs`).
