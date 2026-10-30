---
name: visual-explainer
description: Draw any explanatory visual (today a state machine, flow, architecture or sequence diagram as hand-placed SVG) and hold it to one render gate - render to PNG headless, look at it, fix every overlap, overflow and contrast fault, repeat - in light and dark themes and at 400 px. Use for any visual in an Artifact HTML page, a Claude Docs SVG widget, or an explanation.
when_to_use: When a diagram, flowchart, state diagram, sequence diagram, architecture or data-flow picture, or another explanatory visual is about to be drawn, or the user asks for one ("그림으로", "다이어그램", "도식화").
---

# Visual explainer

Every visual is markup you place by hand and then look at as rendered pixels. That is the user's standing choice over Mermaid and other auto-layout renderers: hand placement is the only way to control where each label lands. Each kind of visual has its own method in a subfolder; all of them pass the gate below.

## Route by kind

- **Node and edge diagrams** (state machine, flow, architecture, data flow, sequence): read `diagram-visualizer/README.md` and draw from `diagram-visualizer/template.html`.
- **Anything with an axis or a quantity** (charts): load the built-in `dataviz` skill, then run the gate below.

Credits and licenses for the adapted methods and numbers are in `NOTICE.md`.

## The gate: render, look, fix, repeat

Source-reading misses the defects that matter: the diagram skills reviewed for this one (fireworks-tech-graph, cloudy-tech-diagrams, hand-drawn-diagrams) all shipped samples with labels across lines and text past box edges, visible only in the rendered image. So a visual is done when its render is clean, and the render is looked at every round.

Render headless in a session of your own, so no window comes to the front:

```
export AGENT_BROWSER_SESSION=vx-$RANDOM
agent-browser batch --bail "set viewport 1200 800" "open file:///abs/visual.html" "set media light" "screenshot /abs/out/light-1200.png"
```

Repeat with `set media dark` and with `set viewport 400 800`, then `agent-browser close`. Open a bare `.svg` file directly; `qlmanage -t -s 1400 -o <dir> <file>` is the fallback renderer when the browser is unavailable (light only).

Each round:

1. Read every PNG (light 1200, dark 1200, light 400) with the Read tool, plus the kind's audit output when its folder ships one.
2. Fix each overlap, clipped or overflowing text, low-contrast mark and stray line at its source coordinate, then re-render.
3. Stop when every variant renders clean and every audit passes. Report the number of rounds.

At 400 px the page body stays put and a wide visual scrolls inside its own container with its text still 11 px or larger; look at the 400 px PNG to decide whether a stacked layout reads better.

## Where the visual goes

- **Artifact page**: write a page fragment (`<title>`, `<style>`, content); the Artifact skeleton supplies `<html>` and `<body>`. Load `artifact-design` first as usual.
- **Claude Docs widget**: the widget format refuses `<style>` and takes colour from `var(--cds-*)` tokens and a literal `data-claude-text-id` on every label; read `guide(items=["topic.diagram"])` and follow it. Run the gate with `read(... payload={"kind":"screenshot"})` on the widget (light theme only).
- **Explanation in chat or a file**: write a standalone `.svg` with its own `<style>` (dark values under `prefers-color-scheme`), run the gate, and hand over the SVG plus the light PNG.
