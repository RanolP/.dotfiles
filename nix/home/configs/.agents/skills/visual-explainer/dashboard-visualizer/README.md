# Dashboard visualizer

A dashboard is one page answering one question at first glance: a header with the filter, a strip of KPI cards, then a grid of chart panels in the order the reader thinks. Every chart inside it is built by `../chart-visualizer/README.md` (form, engine, palette, theming, accessibility) with the numeric rules from the built-in `dataviz` skill; this folder adds the page around the charts. The render gate, theme and width checks are in `../SKILL.md`.

The layout method comes from claude-chart-dashboard and the card, filter and comparison rules from dashboard-design-skill, restated here; credits and licenses are in `../NOTICE.md`.

## When to use

Several measures that answer one question together ("is signup growth healthy, and where does it come from?"). One measure with one claim is a chart (chart-visualizer); a sequence of claims the reader walks through is a slide deck or a scrolling page.

## 1. Name the question first

Write down, before any markup:

1. The page's one question, which becomes the `<h1>`.
2. The 2-5 headline numbers a reader would quote; these become KPI cards. A page whose numbers are all relational (shares, rankings) skips the KPI strip.
3. For each chart panel, the relationship it shows (chart-visualizer section 1) and the chart that follows.
4. The baseline every headline number is compared to: previous period of the same length, target, or normal range. One baseline per number.

## 2. Layout grid and reading order

Start from `template.html`. The page is a column of three bands: header, KPI strip, panel grid.

- **Panels sit on a 12-column grid** (`.w4`, `.w8`; add `.w6` and `.w12` the same way). Give each chart its natural cell before composing rows, from its shape:
  - round charts (donut, pie, radar) want a near-square `w4`;
  - plotted charts (line, column, scatter) want `w4` or `w6`; a wider strip (`w8`, `w12`) is earned by a long x-axis, roughly 24+ points for a line or 12+ categories for columns;
  - listed charts (horizontal bars) take height from the row count, 3-13 bars per panel, width from label length;
  - tables size to their content in a row of their own.
- **Every row adds up to 12.** Fill a short row with a partner panel that belongs beside it; widen a panel only when its shape allows.
- **Reading order runs top to bottom, left to right**: what leads, what it is made of, what drove it, who it happened to, detail. The most important panel goes top-left.
- **A lead panel is earned.** Make one panel larger only when one finding is the reason the page exists; equal measures get equal cells (`w4 · w4 · w4`).
- **Panels in one row hold similar amounts of content.** A card with an empty lower half reads as broken; re-pair it or shorten the row.
- **How many charts per view**: as many as the question needs, typically 2-6 panels. The KPI strip and the main panel fit in the first 900 px of height at 1440 px width; breakdowns and detail may scroll below.

## 3. Tokens

Use chart-visualizer's `--cv-*` tokens unchanged (light on `:root`, dark under both the media guard and `:root[data-theme="dark"]`), so a chart moved between a dashboard and a standalone page keeps its colours. The dashboard adds three:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--cv-up` | `#198038` | `#42be65` | a change in the good direction (5.0:1 / 7.6:1 on the surface) |
| `--cv-down` | `#da1e28` | `#ff8389` | a change in the bad direction (5.0:1 / 7.6:1) |
| `--cv-selected` | `#edf5ff` | `#001d6c` | the active filter's fill |

Copy the `tokens()` / `paint()` pattern from chart-visualizer; the template extends it to a list of charts that all repaint from one `paint()`.

## 4. KPI card anatomy

Each card holds, top to bottom:

1. **Label**: sentence case, muted, 13 px.
2. **Value**: 28-32 px semibold, compact (`11.5K`, `$12.80`, `3.4%`), as precise as the decision needs; the exact figure goes in a tooltip or the table.
3. **Delta**: an arrow (`▲`/`▼`), the signed percentage, and the baseline in words ("vs previous period"). Colour it by meaning: `--cv-up` when the change is good, `--cv-down` when bad, so cost-type metrics where lower is better flip the mapping. The arrow and the words carry the direction for readers who cannot see the colour.
4. **Sparkline** (optional): the metric's recent history in a neutral token, current point in `--cv-s1`.

Cards in a row hold the same parts, so their heights match. A number shown on a card and in a chart agrees in both places.

## 5. Filters and time range

- One filter group in the header, right of the title: a segmented control of time ranges (`30 days`, `90 days`, `12 months`) as `<button aria-pressed>` in a `role="group"` with an `aria-label`.
- A filter change recomputes the data and calls `paint()`, which redraws every KPI and chart together, so the page never shows two ranges at once.
- Series colours stay attached to their entity when a filter changes the series set (dataviz: colour follows the entity).
- The previous period is context: a gray dashed line drawn under the current one, in `--cv-axis`.
- An unfinished current period (today, this week) is drawn dashed or labelled as partial.

## 6. 400 px

- The header wraps: title, then the filter group on its own line.
- KPI cards go two across; a trailing odd card takes the full row (`.kpi:last-child:nth-child(odd)`).
- Every panel takes the full width, in the same reading order as the wide layout.
- Charts follow chart-visualizer section 5 (ResizeObserver, `containLabel`, `hideOverlap`); the template observes every chart box.
- The page body stays within the viewport: `document.documentElement.scrollWidth <= 400`.

## 7. Gate

Run the gate from `../SKILL.md`, waiting on `body[data-charts-ready]` (set once every chart has fired `finished`) before each screenshot. Each round, also click every filter option and see every KPI and chart change together, and set `data-theme="dark"` on `<html>` under light media to see the whole page repaint.
