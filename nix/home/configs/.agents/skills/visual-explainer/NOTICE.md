# Notice

This skill is original prose by RanolP (MIT). Its methods, measured thresholds and palette values are adapted, not copied verbatim, from the sources below. Libraries the templates load from a CDN at runtime are referenced, not vendored, and are listed for credit; the one exception is the two timeline stylesheets, copied verbatim into `timeline-visualizer/template.html` as noted below.

## visual-explainer

- Source: https://github.com/nicobailon/visual-explainer, `SKILL.md`, `references/diagrams.md`, `references/style-guide.md`, version 0.14.0.
- Adapted: grid-first ASCII planning, hand-placed SVG, orthogonal connectors, one accent, numbered callouts, before/after on the same coordinates, 40-unit spacing.
- License: MIT.

```
MIT License

Copyright (c) 2025 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sui documentation, Technical Diagram Standards

- Source: https://docs.sui.io/references/contribute/diagram-standards (published from the MystenLabs/sui repository), read 2026-10-30.
- Adapted: node height 56, node width formula and 16 padding, 40 white space, 15-node split, at most one turn per forward connector and three per backward connector, 8 label clearance, 16 label stacking offset, 3:1 / 4.5:1 contrast, 400 and 1200 width checks, the four audits its package runs (re-implemented in `diagram-visualizer/audit.js`).
- Changes: brand palette, typeface and casing rules dropped; label offset changed from 6 to a centre 18 above the line so the 8 clearance holds; thresholds re-expressed as an in-browser audit.
- License: Apache License 2.0, Copyright Mysten Labs, Inc. Full text in this repository at `LICENSES/Apache-2.0.txt` and at https://www.apache.org/licenses/LICENSE-2.0.

## FT Visual Vocabulary (chart-visualizer)

- Source: https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary, read 2026-11-03.
- Adapted: the nine relationship families (deviation, correlation, ranking, distribution, change over time, magnitude, part-to-whole, spatial, flow) and the chart types under each, restated in `chart-visualizer/README.md`.
- License: MIT.

```
The MIT License (MIT)

Copyright (c) 2016 FT Interactive News

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## IBM Carbon data visualization palettes (chart-visualizer)

- Source: https://carbondesignsystem.com/data-visualization/color-palettes/ and the `--cds-charts-*` tokens in `@carbon/charts` 1.27.25 (`styles.css`), read 2026-11-03.
- Adapted: colour values of the purple, teal, blue, magenta, yellow and cyan steps for the categorical slots, the purple ramp for sequential scales, the red/cyan diverging poles, and the gray text, grid and surface values.
- Changes: slots re-stepped and re-ordered so the built-in `dataviz` palette validator passes in light and dark; red and green kept out of the categorical set for status use; diverging midpoint changed from white to a neutral gray.
- License: Apache License 2.0, Copyright IBM Corp. Full text in this repository at `LICENSES/Apache-2.0.txt` and at https://www.apache.org/licenses/LICENSE-2.0.

## Apache ECharts (referenced, not vendored)

- `chart-visualizer/template.html` loads `https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js` at runtime; no ECharts code is in this repository.
- License: Apache License 2.0, Copyright The Apache Software Foundation.

## claude-chart-dashboard (dashboard-visualizer)

- Source: https://github.com/raghuramsirigiri/claude-chart-dashboard, `plugins/chart-dashboard/skills/chart-dashboard/references/layout-dashboard.md`, commit e389b8ab6c9d5a0155787afacb1922c49b470e4b (2026-10-29).
- Adapted: the 12-column panel grid, a natural cell per chart shape (round, plotted, listed, wide) chosen before composing rows, rows that add up to 12, an earned lead panel, and top-to-bottom reading order; restated in `dashboard-visualizer/README.md`.
- License: MIT, Copyright (c) 2026 Raghuram Sirigiri. MIT text in this repository at `LICENSES/MIT.txt`.

## dashboard-design-skill (dashboard-visualizer)

- Source: https://github.com/abdiraimov-otabek/dashboard-design-skill, `skills/dashboard-design/SKILL.md` and `references/{layout,components}.md`, commit b813324aea08dc19a82d2bd9ea73824dfdd0e844 (2026-10-28).
- Adapted: one question per screen, KPI card anatomy (label, value, delta with a worded baseline), deltas coloured by meaning with lower-is-better metrics flipped, the previous period as a gray dashed line, the header filter group, and the KPI strip two across on phones; restated in `dashboard-visualizer/README.md`.
- License: MIT, Copyright (c) 2026 Otabek Abdiraimov. MIT text in this repository at `LICENSES/MIT.txt`.

## vis-timeline (timeline-visualizer; script referenced, stylesheet vendored)

- Script: `https://cdnjs.cloudflare.com/ajax/libs/vis-timeline/8.5.6/vis-timeline-graph2d.min.js`, loaded at runtime.
- Vendored: `styles/vis-timeline-graph2d.min.css` from the npm package `vis-timeline@8.5.6`, copied verbatim with its comments removed into the first `<style>` block of `timeline-visualizer/template.html`; the template's own rules after it override the colours.
- License: dual Apache License 2.0 or MIT, at the user's choice (package.json `"(Apache-2.0 OR MIT)"`); this repository uses it under MIT. Copyright (c) 2011-2017 Almende B.V, (c) 2017-2019 visjs contributors. Texts in this repository at `LICENSES/Apache-2.0.txt` and `LICENSES/MIT.txt`.

## frappe-gantt (timeline-visualizer; script referenced, stylesheet vendored)

- Script: `https://cdnjs.cloudflare.com/ajax/libs/frappe-gantt/1.2.2/frappe-gantt.umd.min.js`, loaded at runtime.
- Vendored: `dist/frappe-gantt.css` from the npm package `frappe-gantt@1.2.2`, copied verbatim with its comments removed into the second `<style>` block of `timeline-visualizer/template.html`; the template maps its `--g-*` variables onto the shared tokens.
- License: MIT (package.json `"license": "MIT"`, author Faris Ansari; source https://github.com/frappe/gantt). The npm package ships no license file. MIT text in this repository at `LICENSES/MIT.txt`.

## frontend-slides (slide-visualizer)

- Source: https://github.com/zarazhangrui/frontend-slides, `SKILL.md`, `html-template.md`, `viewport-base.css`, commit 9906a34d640d2111f724544cbc50f7f130569ae1 (2026-06-23).
- Adapted: the fixed 1920 x 1080 stage scaled as a whole with one transform and no reflow inside it, slide switching by `visibility` / `opacity` classes, one idea per slide with at most three bullets for a presented deck, splitting into more slides instead of shrinking type, keyboard and touch navigation, and reduced-motion support; restated in `slide-visualizer/README.md` and re-implemented in `slide-visualizer/template.html`.
- Changes: the deck sits in the page rather than filling the window, the type floor is derived from the 400 px width, print rules and inline editing dropped, colours and type taken from the shared tokens.
- License: MIT, Copyright (c) 2025 Zara Zhang. MIT text in this repository at `LICENSES/MIT.txt`.

## Nord (code-visualizer)

- Source: https://www.nordtheme.com, the palette (Polar Night `nord0`-`nord3`, Snow Storm `nord4`-`nord6`, Frost `nord7`-`nord10`, Aurora `nord11`-`nord15`), and the terminal mapping and syntax colours as shipped in Shiki 4.6.0's bundled `nord` theme (from nordtheme/visual-studio-code).
- Used: dark terminal colours unchanged; dark theme unchanged except the comment colour below.
- Change, dark theme (`nord-comments` in `code-visualizer/render.mjs`): comment `#616E88` -> `#A6AFC0` (`#616E88` mixed 58% toward `nord4` `#D8DEE9`, hue kept). Reason: Nord's comment measures 2.43:1 on `#2E3440` and drops below that on changed-line backgrounds; `#A6AFC0` measures 5.66:1 on `#2E3440` and 4.53:1 on `#3C4348`, the changed-line background (measured in the rendered page). Every other dark value, including red, blue, purple and ANSI bright black, stays Nord-original.
- Changes, light theme only (`nord-light` in `code-visualizer/render.mjs`): Polar Night and Snow Storm swapped (`#2E3440` -> `#ECEFF4`, `#3B4252` -> `#E5E9F0`, `#434C5E` -> `#D8DEE9` as backgrounds; `#D8DEE9` and `#ECEFF4` -> `#2E3440`, `#E5E9F0` -> `#3B4252` as text). Each accent darkened in OKLCH lightness with hue kept until it reaches 4.5:1 on `#E4DDE2`, the darkest light code background (word highlight on a deleted line); measured 4.58:1 or more on every rendered background:
  - comment `#616E88` -> `#55627B`
  - `nord7` `#8FBCBB` -> `#3D6868`, `nord8` `#88C0D0` -> `#316877`, `nord9` `#81A1C1` -> `#466482`, `nord10` `#5E81AC` -> `#41638C`
  - `nord11` `#BF616A` -> `#9E444E`, `nord12` `#D08770` -> `#934F3A`, `nord13` `#EBCB8B` -> `#7A5D1C`, `nord14` `#A3BE8C` -> `#50683A`, `nord15` `#B48EAD` -> `#795673`
  - ANSI white `#E5E9F0` -> `#5E6167`, bright white `#ECEFF4` -> `#5F6166`; black `#3B4252` and bright black `#4C566A` already pass and are kept.
- License: MIT, Copyright (c) 2016-present Sven Greb. MIT text in this repository at `LICENSES/MIT.txt`.

## @pierre/diffs and Shiki (code-visualizer; installed at render time, output embeds their markup)

- `@pierre/diffs` 1.6.2 (npm) renders diffs and files on the server (`preloadDiffHTML`, `preloadFile` from `@pierre/diffs/ssr`). License: Apache License 2.0; the package's `LICENSE.md` is the bare license text and names no copyright holder. Full text in this repository at `LICENSES/Apache-2.0.txt`.
- `shiki` 4.6.0 (npm) highlights the code and supplies the `nord` theme. License: MIT, Copyright (c) 2021 Pine Wu, (c) 2023 Anthony Fu. MIT text in this repository at `LICENSES/MIT.txt`.
- Both are pinned in `code-visualizer/package-lock.json` and installed by `npm ci` into `~/.cache/visual-explainer/code-visualizer`; no code from either is in this repository. A page `render.sh` writes contains `@pierre/diffs`' stylesheet and markup inside each declarative shadow root.
- The ANSI-to-HTML converter in `render.mjs` is original code.

## function-plot, jsdom and d3-color (chart-visualizer function graphs; installed at render time, output embeds their SVG)

- `function-plot` 1.26.0 (npm, https://github.com/mauriciopoppe/function-plot) draws the graphs; a page `chart-visualizer/function-graph.sh` writes contains the SVG it produced, recoloured through CSS variables. License: MIT, Copyright (c) 2015 Mauricio Poppe. MIT text in this repository at `LICENSES/MIT.txt`.
- `jsdom` 30.1.3 (npm) supplies the DOM function-plot draws into, so no browser runs at build time. License: MIT, Copyright (c) 2010 Elijah Insua. MIT text in this repository at `LICENSES/MIT.txt`.
- `d3-color` 3.1.0 (npm) derives the brightened scatter and text fills that the renderer maps back to tokens. License: ISC, Copyright 2010-2022 Mike Bostock; https://github.com/d3/d3-color/blob/v3.1.0/LICENSE.
- All three are pinned in `chart-visualizer/package-lock.json` and installed by `npm ci` into `~/.cache/visual-explainer/chart-visualizer`; no code from any of them is in this repository.
- Palette: the Nord values and light-theme adjustments listed under "Nord (code-visualizer)" above, in slot order `nord8`, `nord11`, `nord14`, `nord15`, `nord12`, `nord13`; dark muted text `#A0A9BA` as in code-visualizer.
