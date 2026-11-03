# Code visualizer

Diffs, code files and terminal output, rendered ahead of time into a static HTML page fragment. The published page carries no `<script>` and loads nothing from a CDN: every token colour, both diff layouts and both themes are already in the markup. The render gate, theme and width checks are in `../SKILL.md`.

Diffs and files come from `@pierre/diffs` (its server-side `preloadDiffHTML` and `preloadFile`) highlighted by Shiki; terminal output goes through the ANSI-to-HTML converter in `render.mjs`. The palette is Nord. Credits and licenses are in `../NOTICE.md`.

## When to use

- **Diff**: showing what a change does, line by line, with the before and after side by side. Show the hunk that carries the point, not a whole pull request; split a large change into one block per file.
- **Code file**: one file, or the relevant part of it, highlighted with line numbers so a caption can say "line 14".
- **Terminal output**: a command's coloured log (test run, `git status`, build errors) as the reader would have seen it.

A picture of how parts relate is a diagram (diagram-visualizer), not a code block.

## 1. Render

Write a spec next to the inputs, then run the one command:

```
sh ~/.claude/skills/visual-explainer/code-visualizer/render.sh spec.json out.html
```

```json
{"title": "Token refresh: shared in-flight request",
 "blocks": [
  {"kind": "diff", "old": "old.ts", "new": "new.ts", "name": "src/auth/refresh.ts", "caption": "What changed"},
  {"kind": "file", "path": "new.ts", "name": "src/auth/refresh.ts", "caption": "The file after the change"},
  {"kind": "term", "path": "test.log", "caption": "pnpm vitest run"}]}
```

- Paths are relative to the spec. `name` is the header the reader sees and picks the language by its extension.
- Get the two sides of a diff with `git show <rev>:<path> > old.ts`; capture a coloured log with the tool's force-colour switch (`FORCE_COLOR=1`, `git -c color.ui=always`, `--color=always`) and `> test.log 2>&1`.
- The first run installs the versions pinned in `package-lock.json` into `~/.cache/visual-explainer/code-visualizer` (`npm ci`); later runs reuse it until the lockfile changes. Nothing is installed globally or into this repository.
- `out.html` is a page fragment (`<title>`, `<style>`, content) ready to publish as an Artifact. To put a block inside a larger page, keep the fragment's one `<style>` and paste its `<section class="cv-block">`.

## 2. What the page contains

- Each diff and file is a `<diffs-container>` holding a declarative shadow root (`<template shadowrootmode="open">`), the same wrapper the package's own server component emits. The browser attaches it while parsing; no script runs.
- A diff ships twice: split and unified. CSS shows split above 700 px and unified at 700 px and below, so a phone gets one column without a script choosing.
- Long lines scroll inside their own code column; the container clips (`overflow-x: clip`), so the page body never scrolls sideways.
- The renderer refuses to write a page containing `<script>`.

## 3. Palette

- **Dark** (`nord-comments`) is Shiki's bundled `nord` theme on Polar Night (`#2E3440`) with one change: comments use `#A6AFC0` instead of `#616E88` so they pass 4.5:1 on changed lines. See `../NOTICE.md`.
- **Light** (`nord-light`, built in `render.mjs`) swaps Polar Night and Snow Storm for backgrounds and text and darkens each Frost and Aurora accent in OKLCH lightness, hue kept, until it passes WCAG AA 4.5:1 on the darkest code background, the word highlight on a deleted line. The adjusted values are listed in `../NOTICE.md`.
- Diff line tints are softened from the package defaults (10 % mix of the add or delete colour, 10 % word highlight) so tokens keep their contrast on changed lines; line numbers use 80 % of the text colour.
- Theme follows `prefers-color-scheme` and is overridden by `data-theme="light"` or `"dark"` on `<html>`, in both directions.

## 4. Terminal output

- The 16 ANSI colours map to Nord's terminal palette (`terminal.ansi*` in the nord theme) through `--t-0` to `--t-15`, so they switch with the theme. Light uses the same AA adjustment as the syntax accents; a slot that already passes keeps its value.
- Supported: bold, dim, italic, underline, strikethrough, inverse, 30-37 / 90-97 and 40-47 / 100-107, and `38;5;n` / `48;5;n` below 16. A background with no foreground reads in the page background colour, as a badge does.
- Values from the 256-colour cube and truecolour are written inline and do not follow the theme; check them in both themes.
- Carriage-return overwrites keep the final text of the line; cursor movement and OSC sequences (window titles, hyperlink markers) are dropped.
- The block scrolls sideways on its own and takes keyboard focus (`tabindex="0"`) so it can be scrolled without a pointer.

## 5. Gate

Run the gate from `../SKILL.md` at 1200 and 400 px with `data-theme` set to light and dark on `<html>`. Each round also confirm:

- zero `<script>` elements, counting inside every shadow root, and zero requests besides the page itself;
- `document.documentElement.scrollWidth` equals the viewport width;
- every visible text run, walked through the shadow roots with its background composited from its ancestors, has contrast 4.5:1 or more in light. Dark keeps Nord's red, blue and purple, which fall below 4.5:1 there; dark comments pass.
