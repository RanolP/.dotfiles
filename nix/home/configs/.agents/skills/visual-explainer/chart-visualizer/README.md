# Chart visualizer

A chart is an Apache ECharts option object whose every colour comes from CSS tokens, rendered and looked at through the gate in `../SKILL.md`. Load the built-in `dataviz` skill first: it owns the numeric rules (bar thickness, line weight, marker size, gaps, contrast, legend and label policy, the palette validator) and this folder layers on it without restating them. This folder adds the chart-type choice, the engine, the palette instance, the theming code and the 400 px behaviour.

Credits and licenses (FT Visual Vocabulary, IBM Carbon) are in `../NOTICE.md`.

## When to use

Any visual with an axis or a quantity: a trend, a comparison, a distribution, a share. A single headline number is a stat tile rather than a chart (dataviz, step 1). A grid of several charts with KPI cards belongs to a dashboard; each chart inside it still follows this file.

## 1. Pick the form by the relationship

Name the relationship the reader should see, then take a chart from that family. The nine families follow the Financial Times Visual Vocabulary (chart-doctor, MIT), restated here:

- **Deviation**: values above or below a reference (zero, target, average). Diverging bar, surplus/deficit line.
- **Correlation**: how two measures move together. Scatter, connected scatter, XY heatmap.
- **Ranking**: order matters more than the value. Sorted bar, dot strip, slope chart for rank change.
- **Distribution**: how values spread. Histogram, box or violin, dot strip, population pyramid.
- **Change over time**: a trend across dates. Line, column for few periods, area for one cumulative series, calendar heatmap for daily rhythm.
- **Magnitude**: size comparison in absolute numbers. Bar or column from a zero baseline, grouped bar, paired bar.
- **Part-to-whole**: shares of one total. Stacked bar or 100 % bar, treemap; a pie or donut only for 2-3 parts.
- **Spatial**: where a value occurs. Choropleth or proportional-symbol map (needs map data embedded in the page).
- **Flow**: movement between states. Sankey, chord, waterfall for a running total.

Then run dataviz's form check (`references/choosing-a-form.md`); where the two disagree, dataviz wins, because its rules are the ones the validator and anti-pattern catalogue enforce.

## 2. Engine setup

Start from `template.html`. Load ECharts 6.1.0 as the pinned UMD build from cdnjs, before the inline script that uses it:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"></script>
```

- Init with `echarts.init(el, null, { renderer: 'svg' })`: SVG stays sharp in screenshots and exposes text to the accessibility tree.
- Set `animation: false`, so the gate's screenshot captures the finished frame. The template marks the container `data-chart-ready` on the `finished` event; wait on that selector before the screenshot.
- Every series lives in one `series` array with `color` set from the tokens in slot order, so slot n always means the same entity (dataviz: colour follows the entity).
- One y-axis per grid. Two measures of different scale get two grids or two charts.

## 3. Palette tokens

The template carries these as CSS custom properties on `:root`, with the dark set under both the `prefers-color-scheme: dark` guard and `:root[data-theme="dark"]`. The series colours are IBM Carbon data-visualisation steps, re-stepped and re-ordered until the dataviz validator passes every check (lightness band, chroma floor, adjacent CVD separation, normal-vision floor, 3:1 against the surface) in each mode:

| Token | Light (surface `#ffffff`) | Dark (surface `#161616`) |
|---|---|---|
| `--cv-s1` | `#8a3ffc` purple 60 | `#a56eff` purple 50 |
| `--cv-s2` | `#009d9a` teal 50 | `#009d9a` teal 50 |
| `--cv-s3` | `#0f62fe` blue 60 | `#4589ff` blue 50 |
| `--cv-s4` | `#ee5396` magenta 50 | `#ee5396` magenta 50 |
| `--cv-s5` | `#b28600` yellow 50 | `#b28600` yellow 50 |
| `--cv-s6` | `#1192e8` cyan 50 | `#1192e8` cyan 50 |
| `--cv-ink` / `--cv-muted` | `#161616` / `#525252` | `#f4f4f4` / `#c6c6c6` |
| `--cv-grid` / `--cv-axis` | `#e0e0e0` / `#8d8d8d` | `#393939` / `#6f6f6f` |

- Six slots cover a categorical chart; a seventh series folds into "Other" or small multiples.
- Sequential (magnitude): one Carbon ramp whose faint end still clears the surface. Purple passes the validator's `--ordinal` check as purple 40-90 in light (`#be95ff #a56eff #8a3ffc #6929c4 #491d8b #31135e`, low to high) and purple 70-20 in dark (`#6929c4 #8a3ffc #a56eff #be95ff #d4bbff #e8daff`, low to high).
- Diverging (polarity): Carbon red 80-10 against cyan 10-80, with the midpoint replaced by a neutral gray (`#e0e0e0` light, `#393939` dark) as dataviz requires.
- Status colours (good, warning, serious, critical) stay outside the categorical slots; take them from dataviz's status rules with an icon and a label.
- A changed palette, surface, or slot order gets re-validated in both modes before use: `node <dataviz skill dir>/scripts/validate_palette.js "<hex,...>" --mode light --surface "#ffffff"`, then `--mode dark --surface "#161616"`.

## 4. Theme ECharts from the tokens

The page and the chart share one source of colour. The template's `tokens()` reads the custom properties with `getComputedStyle(document.documentElement)` and `option(t)` builds the whole option from them: series colours, axis and legend text in `--cv-muted`, values and end labels in `--cv-ink`, gridlines in `--cv-grid`, the marker ring and tooltip background in `--cv-surface`.

`paint()` calls `chart.setOption(option(tokens()), { notMerge: true })`, and runs again on both theme signals:

- `matchMedia('(prefers-color-scheme: dark)')` `change`, for the OS preference;
- a `MutationObserver` on `<html>` filtered to `data-theme`, for the Artifact viewer's explicit choice.

Keep new colours as tokens in all three CSS blocks, then read them in `tokens()`.

## 5. Width and 400 px

- The chart box sets its own height (320 px in the template) and takes the container's width; a `ResizeObserver` on the box calls `chart.resize()`, which covers window resizes, panel collapses and the 400 px viewport alike.
- `grid.containLabel: true` with small fixed margins keeps axis labels inside the box at every width; leave right margin for end labels.
- `axisLabel.hideOverlap: true` thins category labels when they crowd, so the 400 px render shows every other month instead of overlapping ones.
- The legend sits at the top-left on one row; past four series set `legend.type: 'scroll'`.
- At 400 px the page body stays within the viewport (`document.documentElement.scrollWidth <= 400`) and chart text stays at 11 px or larger.

## 6. Accessibility

- The chart container carries `role="img"` and an `aria-label` stating the claim, the same sentence as the caption; `aria: { enabled: true }` adds ECharts' generated series summary.
- A `<details>` "Data table" under the chart holds every plotted value, built from the same arrays as the series, so the numbers survive without colour or hover.
- Two or more series get a legend, and up to four also get direct end labels; dataviz states the full policy.
- The tooltip (`trigger: 'axis'` on line and area, `'item'` on bar and dot) is the default hover layer.

## 7. Gate

Run the gate from `../SKILL.md`, waiting on `[data-chart-ready]` before each screenshot. Each round, also check the render against dataviz's `references/anti-patterns.md`, and confirm the theme toggle repaints: set `data-theme="dark"` on `<html>` under light media and see the dark series colours.

## 8. Function graphs (함수 그래프)

A plotted formula, y = f(x), with labelled axes: a curve's shape, where two functions cross, a parameter's effect. Measured data on an axis stays an ECharts chart (sections 1-7); a formula goes here. The page is pre-rendered by function-plot 1.26.0 into static SVG and carries no `<script>` and no CDN load.

Write a spec, then run the one command:

```
sh ~/.claude/skills/visual-explainer/chart-visualizer/function-graph.sh spec.json out.html
```

```json
{"title": "Two curves near the origin",
 "graphs": [{
   "title": "sin x stays bounded; x²/4 does not",
   "sub": "x from −6 to 6.",
   "label": "sin x oscillates between −1 and 1 while x squared over 4 grows past it on both sides; they meet at x = 0 and cross again near x = 1.9",
   "caption": "The parabola leaves the band [−1, 1] at |x| = 2; the sine never does.",
   "plot": {
     "grid": true,
     "xAxis": {"label": "x", "domain": [-6, 6]},
     "yAxis": {"label": "y", "domain": [-2, 6]},
     "data": [{"fn": "sin(x)", "legend": "y = sin x"}, {"fn": "x^2/4", "legend": "y = x² / 4"}]}}]}
```

- `plot` is function-plot's own options object (`fn`, `points`, `vector`, `fnType: "parametric"` or `"polar"`, `derivative`, `annotations`) without `target`, `width`, `height` or colours; `legend` on a datum adds an HTML legend entry in that series' colour. Up to six series.
- `label` is required: the claim, read by screen readers from the plot's `role="img"`, in fuller words than the caption.
- An `fn` with no `graphType` or `sampler` is drawn as a `polyline` from the `builtIn` sampler, so a curve leaving the domain is cut at the edge instead of clamped into a flat line along it.
- Each graph is rendered twice, 640 x 400 above 700 px and 340 x 300 at 700 px and below, and CSS shows one, so tick labels stay 12-13 px on a phone instead of shrinking with a scaled-down wide render.
- function-plot runs in jsdom; no browser opens at build time. The first run installs the versions pinned in `package-lock.json` into `~/.cache/visual-explainer/chart-visualizer` (`npm ci`); later runs reuse it until the lockfile changes. Nothing is installed globally or into this repository.

Theme: each series is drawn in a sentinel colour and rewritten to `var(--fg-s1)` through `var(--fg-s6)`; axes, gridlines and tick text are restyled by class (`currentColor`, `--fg-grid`, `--fg-axis`), so the SVG follows `prefers-color-scheme` and `data-theme` in both directions. A colour the renderer cannot map to a token stops the render instead of shipping one that ignores the theme. The palette is Nord: dark uses Nord's values, with muted text at `#A0A9BA` as in code-visualizer; light uses Snow Storm surfaces and code-visualizer's darkened accents. Slot order is `nord8`, `nord11`, `nord14`, `nord15`, `nord12`, `nord13`.

Gate: section 7's rounds at 1200 and 400 px in light and dark, plus zero `<script>`, zero requests besides the page itself, `scrollWidth` equal to the viewport width, and tick and axis-label text at 4.5:1 or more on the surface.

- Manim (3Blue1Brown's animation engine): deferred. pycairo 1.29.2 has no macOS arm64 wheel on PyPI, so installing it compiles; its MP4 or GIF output has unselectable text and colours that ignore the theme; `MathTex` needs a multi-GB LaTeX. Revisit when a topic cannot be explained without motion, starting with a prebuilt pycairo route.
- JSXGraph: excluded; function-plot covers static function graphs.
