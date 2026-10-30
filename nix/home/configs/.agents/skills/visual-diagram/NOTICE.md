# Notice

This skill is original prose by RanolP (MIT). Its method and its measured thresholds are adapted, not copied verbatim, from two sources:

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
- Adapted: node height 56, node width formula and 16 padding, 40 white space, 15-node split, at most one turn per forward connector and three per backward connector, 8 label clearance, 16 label stacking offset, 3:1 / 4.5:1 contrast, 400 and 1200 width checks, the four audits its package runs (re-implemented in `scripts/audit.js`).
- Changes: brand palette, typeface and casing rules dropped; label offset changed from 6 to a centre 18 above the line so the 8 clearance holds; thresholds re-expressed as an in-browser audit.
- License: Apache License 2.0, Copyright Mysten Labs, Inc. Full text in this repository at `LICENSES/Apache-2.0.txt` and at https://www.apache.org/licenses/LICENSE-2.0.
