# Notice

This skill is original prose by RanolP (MIT). Its methods, measured thresholds and palette values are adapted, not copied verbatim, from the sources below. Libraries the templates load from a CDN at runtime are referenced, not vendored, and are listed for credit.

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
