# review.json

One file in the session scratchpad holds the whole review; `node <skill-dir>/scripts/build-gallery.mjs` renders it, and `node <skill-dir>/scripts/review-edit.mjs` makes every change to `boxes`.

```json
{
  "figma": {"url": "...", "fileKey": "..."},
  "repo": "<repo-name>",
  "base": {"branch": "main", "sha": "abc1234"},
  "tobe": {"branch": "feat/x", "sha": "def5678", "dirty": true},
  "concerns": [{"id": "c1", "name": "...", "nodeId": "12:34", "notes": [],
    "states": [{"id": "c1s1", "name": "...", "nodeId": "12:40", "notes": [],
      "frame": {"w": 375, "h": 812}, "figmaShot": "shots/c1s1/figma.png",
      "platforms": [{"name": "ios", "width": 393, "asis": "shots/c1s1/ios-asis.png", "tobe": null, "status": "captured"}]}]}],
  "boxes": [{"id": "DR-001", "kind": "fix", "state": "c1s1", "platform": "ios",
    "rect": {"x": 16, "y": 120, "w": 361, "h": 48},
    "node": {"id": "12:55", "name": "Button/Primary"}, "property": "padding",
    "asis": "12", "answer": "spacing/16 (16)", "files": ["src/components/Button.tsx"],
    "batch": 1, "status": "open", "commit": null, "note": ""}]
}
```

- `kind`: `fix` | `unintended`.
- `status` (box): `open` | `fixed` | `resolved` | `accepted`.
- `rect` is in the platform's logical units (pt on iOS, dp on Android, CSS px on web); the platform's `width` is that platform's logical screen width.
- `fixedAt` (box): ISO timestamp stamped by `status --to fixed`, cleared by `status --to open`.
- `noPhotoReason` (box): set by `status --to resolved --no-photo-reason <text>`; shown on the gallery.
- A platform with `"status": "missing"` carries a `"reason"`, which names the user action that would unblock it and labels a simulator or emulator result as such.
- Image paths are relative to `review.json`, under `shots/<state-id>/`: `figma.png`, `<platform>-asis.png`, `<platform>-tobe.png`.

## Writing it

Write the skeleton once, after the outline (step 1) and the base branch (step 3): `figma`, `repo`, `base`, `tobe`, and `concerns` with every state's `frame`, `figmaShot` path, and one platform entry per platform (`width`, `asis: null`, `tobe: null`, `status: "captured"`). From then on every change goes through `node <skill-dir>/scripts/review-edit.mjs <subcommand> --review review.json [flags]`, which validates the whole file, writes it atomically, and prints what it touched; `review-edit.mjs --help [<subcommand>]` (or `<subcommand> --help`) lists the flags. Rects are `x,y,w,h` in the platform's logical units.

| Subcommand | Use it to |
|---|---|
| `add` | append a box (`--kind --state --platform --rect` required); allocates the next `DR-###`, `status: "open"`, `batch: null` unless `--batch` |
| `batches [--write]` | print the next batch: open `fix` boxes in id order whose `files` are disjoint from each other and from every `fixed` (unresolved) box; `--write` stamps them with the next batch number. An open fix box with no `files` is an error |
| `set --id` | change a box's `--batch`, `--files`, or `--note` |
| `union --id` | replace `rect` with the union of `--asis x,y,w,h` and `--tobe x,y,w,h` (one side alone when the element exists on one side only) |
| `status --id --to` | `fixed` (stamps `fixedAt`); `resolved` (fix boxes, requires `--commit <sha>`, and is refused unless the box's state × platform has a `tobe` image file whose mtime is at or after `fixedAt` on a platform that is not `missing`; `--no-photo-reason <text>` bypasses that and stores `noPhotoReason`); `accepted` (unintended boxes); `open` (clears `fixedAt`) |
| `platform --state --name` | set a platform's `--asis`/`--tobe` image path (any path inside `review.json`'s folder, stored relative to it), or `--status missing`, which requires `--reason <text>` |
| `meta` | set `--figma-url`, `--figma-file-key`, `--repo`, `--base-branch`, `--base-sha`, `--tobe-branch`, `--tobe-sha`, `--tobe-dirty true\|false` |

`--asis` is the as-is value on `add`, the as-is rect on `union`, and the as-is image path on `platform`.

## The other scripts

Both take `--help`.

- `node <skill-dir>/scripts/diff-regions.mjs --asis a.png --tobe b.png --width <logical> --exclude-boxes review.json --state <id> --platform <name>` prints a JSON array of `{x, y, w, h}` changed regions in logical units, leaving out regions at least 90% covered by that state and platform's recorded boxes (fix and unintended), so a rerun after the next batch reports only new changes. `--threshold`, `--min-area` and `--merge` tune the detector.
- `node <skill-dir>/scripts/build-gallery.mjs --review review.json --out index.html [--title <str>]` writes the page and prints one line per image, `<src>\t<absolute source path>`: `src` is the key for the Artifact's `files`, the absolute path its source. Every image must sit under the `--out` directory, so put `index.html` beside `review.json`. It also writes `contact-sheet-<n>.png` beside it (Figma | to-be per state × platform, long edge at most 1568 px) and prints `CONTACT <absolute path>` per sheet, and prints `WARN near-duplicate <concern> <platform> <stateA> <stateB> <side> <fraction>` when two states of one concern differ by less than `--dup-threshold` (default 0.01), badging them in the gallery. CONTACT and WARN lines are not Artifact `files` entries. `--selftest` checks box placement and the diff on generated PNGs.
