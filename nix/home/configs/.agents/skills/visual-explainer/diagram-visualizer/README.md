# Diagram visualizer

A node and edge diagram is SVG you place by hand on a grid you wrote down first. This folder adds the placement method and the measured rules; the render gate, theme and width checks are in `../SKILL.md`. Load the built-in `artifact-diagramming` skill for what earns a picture, drawing the mechanism, labelled arrows, and inline-SVG mechanics (`viewBox`, markers, `role="img"`).

The method comes from nicobailon/visual-explainer and the numbers from the Sui documentation diagram standards; credits and licenses are in `../NOTICE.md`.

## 1. Decide the claim

- One figure, one claim. Write the claim as the caption's first sentence and the `aria-label` before drawing anything ("A download reaches completed only through downloading").
- Pick one level of detail per figure (C4: context, container, component, code). A node that needs its internals gets a second figure, cross-referenced in the caption.
- Flow direction: left to right for data flow, top to bottom for execution and time. A sequence diagram puts one column per actor and runs time down.
- Over 15 nodes, split; an overview reads best at 5-8 nodes with detail in a second figure.

## 2. Grid first

1. Sketch the layout in ASCII in your reasoning: columns, rows, which node sits where, which connector leaves which side.
2. Turn it into numbers: node height 56; node width `max(label + 32, 120)` rounded up to 20; column pitch = widest node + gap; row pitch = 56 + gap; gap >= 40.
3. Write the grid as a comment at the top of the SVG (`columns c0=160 c1=440 ...`) and read every coordinate off it. Peer nodes share a centre line.

## 3. Place

Start from `template.html`: tokens for light and dark, markers, node, edge, label, callout, and a scroll container. Its class names (`g.node`, `path.edge`, `.edge-label`, `.key`, `rect.boundary`) are what `audit.js` measures.

- **Shapes say what a thing is.** Rect for a service or state, cylinder for a datastore, diamond for a decision with exactly 2 labelled exits, dashed rect for external, optional or failed, double border for a terminal state, a filled dot for the initial state. Encode state in shape or dash as well as colour.
- **Connectors are orthogonal** paths written with `M`, `H`, `V` only. A forward connector turns at most once: drop from the source's bottom to the target's centre line, turn, enter the nearer side. A return connector (target above or behind the source) carries `data-flow="backward"` and turns at most 3 times. Each pair gets its own connector from its own point on the source edge.
- **Every connector carries a verb** (`start`, `retry`, `polls 30s`), centred on its longest straight segment: label centre 18 above a horizontal run, or near edge 10 beside a vertical run. Its box stays 8 or more from every stroke; two labels that meet stack 16 apart.
- **One accent** (`.key`) marks the path or node the claim is about; everything else is neutral. Line weights: 1.5 structure, 2.5 accent.
- **Numbered callouts**, 3-6 per figure: a circle and a leader ending exactly on the point it names, with one line per number under the figure.
- **Before / after**: draw both states in the same coordinates (two panels at one scale, or one drawing with `.only-before` / `.only-after` groups); added parts in the accent, removed parts dashed.
- Edges first in source order, nodes after, so a node covers a connector's end.

The full threshold table, with the source of each value and where the two sources differ, is `rules.md`.

## 4. Audit inside the gate

Run the gate from `../SKILL.md`, and after each screenshot run the audit on the same open page:

```
agent-browser eval --stdin < <this skill>/diagram-visualizer/audit.js
```

The audit names the rule (R1-R9), the element, and the measured value; fix each finding at its coordinate in the grid comment. A round is clean when the audit prints `"fail": []` in every variant. The fallback `qlmanage` renderer runs no audit.

At 400 px the figure scrolls inside `.vd-scroll`; set the SVG's `min-width` to viewBox width x 11/13 so labels render at 11 px or more.

## Destinations

- **Artifact page**: the template is already a page fragment.
- **Claude Docs widget**: keep this folder's grid, routing, spacing and label clearance inside the widget format.
- **Standalone `.svg`**: put the tokens on `svg.vd`.
