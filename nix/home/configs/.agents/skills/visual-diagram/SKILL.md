---
name: visual-diagram
description: Draw a state machine, flow, architecture or sequence diagram as hand-placed SVG on a planned grid, held to measured layout rules, and checked by rendering it to PNG and looking until no label overlaps a line or overflows its box. Use for any diagram in an Artifact HTML page, a Claude Docs SVG widget, or an explanation.
when_to_use: When a diagram, flowchart, state diagram, sequence diagram, architecture or data-flow picture is about to be drawn, or the user asks for one ("그림으로", "다이어그램", "도식화").
---

# Visual diagram

Every diagram is SVG you place by hand on a grid you wrote down first. That is the user's standing choice over Mermaid and other auto-layout renderers: hand placement is the only way to control where each label lands. This skill adds the placement method and the measured rules on top of two built-in skills. Load them for their parts:

- `artifact-diagramming`: what earns a picture, drawing the mechanism, labelled arrows, inline-SVG mechanics (`viewBox`, markers, `role="img"`).
- `dataviz`: anything with an axis or a quantity (charts, palette validation).

The method comes from visual-explainer and the numbers from the Sui documentation diagram standards; credits and licenses are in `NOTICE.md`.

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

Start from `references/template.html`: tokens for light and dark, markers, node, edge, label, callout, and a scroll container. Its class names (`g.node`, `path.edge`, `.edge-label`, `.key`, `rect.boundary`) are what `scripts/audit.js` measures.

- **Shapes say what a thing is.** Rect for a service or state, cylinder for a datastore, diamond for a decision with exactly 2 labelled exits, dashed rect for external, optional or failed, double border for a terminal state, a filled dot for the initial state. Encode state in shape or dash as well as colour.
- **Connectors are orthogonal** paths written with `M`, `H`, `V` only. A forward connector turns at most once: drop from the source's bottom to the target's centre line, turn, enter the nearer side. A return connector (target above or behind the source) carries `data-flow="backward"` and turns at most 3 times. Each pair gets its own connector from its own point on the source edge.
- **Every connector carries a verb** (`start`, `retry`, `polls 30s`), centred on its longest straight segment: label centre 18 above a horizontal run, or near edge 10 beside a vertical run. Its box stays 8 or more from every stroke; two labels that meet stack 16 apart.
- **One accent** (`.key`) marks the path or node the claim is about; everything else is neutral. Line weights: 1.5 structure, 2.5 accent.
- **Numbered callouts**, 3-6 per figure: a circle and a leader ending exactly on the point it names, with one line per number under the figure.
- **Before / after**: draw both states in the same coordinates (two panels at one scale, or one drawing with `.only-before` / `.only-after` groups); added parts in the accent, removed parts dashed.
- Edges first in source order, nodes after, so a node covers a connector's end.

The full threshold table, with the source of each value and where the two sources differ, is `references/rules.md`.

## 4. Render and look (the gate)

Source-reading misses the defects that matter: diagram skills reviewed for this one (fireworks-tech-graph, cloudy-tech-diagrams, hand-drawn-diagrams) all shipped samples with labels across lines and text past box edges, visible only in the rendered image. So the diagram is done when its render is clean, and the render is looked at every round.

Run headless in a session of your own (no window comes to the front):

```
export AGENT_BROWSER_SESSION=vd-$RANDOM
agent-browser batch --bail "set viewport 1200 800" "open file:///abs/diagram.html" "set media light" "screenshot /abs/out/light-1200.png"
agent-browser eval --stdin < <this skill>/scripts/audit.js
```

Repeat with `set media dark` and with `set viewport 400 800`, then `agent-browser close`. For a bare `.svg` file open it directly; `qlmanage -t -s 1400 -o <dir> <file>` is the fallback renderer when the browser is unavailable (light only, no audit).

Each round:

1. Read every PNG (light 1200, dark 1200, light 400) with the Read tool, and the audit's `fail` list.
2. Fix each finding at its coordinate in the grid comment, then re-render. The audit names the rule (R1-R9), the element, and the measured value.
3. Stop when the audit prints `"fail": []` in every variant and the PNGs show no overlap, clipping, unreadable text or stray line. Report the number of rounds.

At 400 px the figure scrolls inside `.vd-scroll` and the page body stays put; set the SVG's `min-width` to viewBox width x 11/13 so labels render at 11 px or more. A drawing that only works scrolled at 400 px may earn a stacked layout instead; look at the 400 px PNG to decide.

## Where the diagram goes

- **Artifact page**: the template is already a page fragment (`<title>`, `<style>`, `<figure>`); the Artifact skeleton supplies `<html>` and `<body>`. Load `artifact-design` first as usual.
- **Claude Docs widget**: the widget format refuses `<style>` and takes colour from `var(--cds-*)` tokens and a literal `data-claude-text-id` on every label; read `guide(items=["topic.diagram"])` and follow it. Keep this skill's grid, routing, spacing and label clearance, and run the gate with `read(... payload={"kind":"screenshot"})` on the widget (light theme only).
- **Explanation in chat or a file**: write a standalone `.svg` with its own `<style>` (tokens on `svg.vd`, dark values under `prefers-color-scheme`), render it with the gate, and hand over the SVG plus the light PNG.
