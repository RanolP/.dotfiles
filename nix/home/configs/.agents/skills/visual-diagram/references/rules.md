# Measured rules

Every number here is a threshold `scripts/audit.js` checks on the rendered page; the rule id (R1...) is the prefix of its failure line. Units are viewBox units, which equal CSS px when the SVG renders at 1:1.

| Id | Rule | Value | Source |
|---|---|---|---|
| R1 | Node height, every rectangular node | 56 | Sui, Node sizing |
| R2 | Node width | `max(label + 32, sub-label + 32, 120)`, rounded up to a multiple of 20 | Sui, Node sizing |
| R2 | Horizontal padding between any text and each side of its node | >= 16 | Sui, Node sizing; `audit-node-sizing.py` |
| R3 | Space between nodes, and between a node and its boundary edge | >= 40 | Sui, Layout ("White space"); visual-explainer, Plan on a grid |
| R4 | Nodes per diagram | <= 15, then split by C4 level; aim for 5-8 in an overview | Sui, Layout ("Complexity"); visual-explainer, Plan on a grid (over 12) |
| R5 | Turns on a forward connector | <= 1, axis-aligned only | Sui, Routing; `audit-arrow-routing.py` |
| R5 | Turns on a backward connector (target above or behind its source), tagged `data-flow="backward"` | <= 3; at most 1 backward connector in an architecture diagram | Sui, Routing (Pattern 5) |
| R6 | Clearance between a label's box and every connector stroke | >= 8 | Sui, Arrow label placement; `audit-label-overlap.py` |
| R6 | Two labels that would collide | offset 16 apart vertically, stacked | Sui, Arrow label placement |
| R7 | Contrast, graphic marks (connectors, node outlines) against the ground | >= 3:1 | Sui, Accessibility (WCAG 2.1 AA non-text) |
| R7 | Contrast, a node's primary label at 14 or more, three words or fewer | >= 3:1 | Sui, Accessibility |
| R7 | Contrast, every other text (edge labels, sub-labels, captions, notes) | >= 4.5:1 | Sui, Accessibility |
| R8 | Rendered text size at 400 px and 1200 px viewport widths | >= 11 px; the page body never scrolls sideways | Sui, Accessibility (400 / 1200 test); Claude Docs widget guide (10.5 floor) |
| R9 | Every label inside the viewBox | 0 overflow | Claude Docs widget guide ("what falls outside the viewBox is cut off") |

## Placement values (drawn, not audited)

- Label on the middle of the connector's longest straight segment: centred above a horizontal run, beside a vertical run. Sui puts the label 6 off the line; a 13-unit label's box then sits about 3 from the stroke and fails R6, so this skill places the label centre 18 above a horizontal run (box clears by about 10) and the near edge 10 beside a vertical run. visual-explainer uses 9 above.
- Pattern 2 (source and target in different columns): leave the source's bottom centre, run vertical to the target's vertical centre, turn once, enter the nearer side.
- Convergent (many to one) and divergent (one to many): one independent one-turn connector per pair, each from its own x on the source edge; no shared trunk.
- A diamond decision has exactly 2 exits, each labelled with its condition.
- Diagonal connectors only in a radial context diagram with the system in the centre.
- Line weights: 1-1.5 for structure, 2.5-3 for the one accent path (visual-explainer style guide).
- Callouts: 3-6 numbered circles per figure, each leader ending exactly on the point it names (visual-explainer).

## Where the sources differ

- Gap: Sui states 40 between nodes and boundary edges; visual-explainer states "at least 40 units between boxes". Same number.
- Label offset: Sui 6 off the line, visual-explainer 9 above; both conflict with Sui's own 8 clearance once the font's descent is counted. The audit enforces the 8 clearance.
- Text contrast: Sui allows 3:1 for diagram text treated as a graphic (short primary labels) and asks 4.5:1 for body text inside the diagram. The audit applies 3:1 only to node labels at 14 or more with three words or fewer.
- Node count: Sui splits above 15; visual-explainer draws an overview above about 12.
- Sui's brand rules (Black/Gray 500/Sui Blue 500 palette, Inter, ALL CAPS primary labels, light mode only) are its house style and stay out of this skill; this skill uses the page's own palette and must read in both themes.
