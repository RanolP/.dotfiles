# Timeline visualizer

A timeline puts dated things on one horizontal time axis: a roadmap of work by team, a release history, a schedule of tasks that wait on each other. This folder covers two libraries, both loaded from cdnjs and themed from chart-visualizer's `--cv-*` tokens. The render gate, theme and width checks are in `../SKILL.md`; credits and licenses are in `../NOTICE.md`.

## When to use

- **Roadmap or dated events** (work grouped by team or track, milestones, a history of releases): vis-timeline. It draws ranges and points in labelled rows and lets the reader pan and zoom.
- **Task schedule with dependencies** (what waits on what, how far along each task is): frappe-gantt. It draws one task per row, a progress fill inside each bar, and an arrow from each task to the tasks that depend on it.
- A quantity that changes over time is a line or column chart (chart-visualizer), even when the x-axis is dates. A timeline places things; it does not measure them.
- A process whose steps have no dates is a flow diagram (diagram-visualizer).

Use both on one page when the reader needs the overview and the critical path together, as `template.html` does.

## 1. Engine setup

Start from `template.html`. It loads, in this order:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis-timeline/8.5.6/vis-timeline-graph2d.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/frappe-gantt/1.2.2/frappe-gantt.umd.min.js"></script>
```

- Each library ships its stylesheet separately, and the Artifact viewer loads external CSS only from Google Fonts, so the template inlines both stylesheets verbatim in their own `<style>` blocks. A version bump changes the script URL and replaces the matching `<style>` block from the same version (`vis-timeline@<v>/styles/vis-timeline-graph2d.min.css`, `frappe-gantt@<v>/dist/frappe-gantt.css` on jsdelivr), then updates `../NOTICE.md`.
- Neither library fetches anything at runtime; the page's only requests are the two scripts. Keep it that way: no remote images or fonts in item content.
- Drop the library and its `<style>` block that a page does not use.
- Data is ISO date strings (`'2026-11-23'`). Write every date in the data; let neither library compute "now" for the data itself.

## 2. vis-timeline (roadmap)

- One **group** per team or track, labelled in the left column; items carry `group` and a `className` of `s1`-`s6` that picks the series token. Colour follows the group, so a team keeps its colour on every page.
- **Ranges** (`start` + `end`) for work, **points** (`type: 'point'`) for milestones. A range draws on the surface with a 4 px left edge in the group colour, so its label stays in ink at full contrast.
- `editable: false` for a published plan; `zoomKey: 'ctrlKey'` so a plain mouse wheel scrolls the page instead of zooming the timeline; `min` / `max` bound panning to the plan's span; `zoomMin` stops the reader zooming past whole days.
- A key above the timeline names each group colour and the today line; the `<details>` table below it lists every item, built from the same `items` array so the two never disagree.

## 3. frappe-gantt (schedule)

- One task per row, in the order work starts. `dependencies` is a comma-separated string of task ids; each one draws an arrow from that task's end to this task's start.
- `progress` is 0-100 and fills the bar from the left in a darker tint.
- `readonly: true` for a published schedule (no drag-to-reschedule), `infinite_padding: false` so the grid ends with the plan, `scroll_to: tasks[0].start` so the view opens on the first task rather than on the empty padding before it.
- `view_mode` picks the column unit: `Day` for plans under 3 weeks, `Week` for 3 weeks to 4 months, `Month` beyond that.

## 4. Date-axis label density

- Each axis label needs room for its text plus a gap: about 60 px per label for `Oct`, about 120 px for `07 Nov - 13`.
- vis-timeline picks its scale from the width it has and drops to a coarser unit on its own; set the initial window (`start` / `end`) so the plan's span fills the box. The template opens a shorter window when the box is under 600 px wide, so each bar keeps room for its label.
- frappe-gantt keeps a fixed `column_width` per view mode (140 px per week); a narrow box scrolls instead of squeezing, which keeps labels whole.
- Show two levels at most: the unit (`Oct`, `07 Nov - 13`) and the period above it (`2026`, `November`).

## 5. Today marker

- Both charts mark today with a 1-2 px line in `--cv-ink`, the highest-contrast token, because it is the reader's anchor and belongs to no series. vis-timeline draws it with `showCurrentTime: true`; frappe-gantt draws it on its own and highlights today's column label.
- Name the line in the key ("Today"). A plan viewed later still marks the real date, so a stale plan shows its line past the end and the reader sees it is stale.
- Range bars sit above the today line (`z-index: 2`), so the line never crosses a label.

## 6. Tokens and theming

Use chart-visualizer's `--cv-*` tokens unchanged (light on `:root`, dark under both the media guard and `:root[data-theme="dark"]`). Theming here is CSS alone, so a theme change repaints both charts with no script:

- vis-timeline: the template overrides the vendored colours on `.vis-timeline`, `.vis-panel`, `.vis-label`, `.vis-time-axis`, `.vis-grid`, `.vis-item` and `.vis-current-time`, all scoped under `.tl-roadmap`.
- frappe-gantt reads `--g-*` variables; the template sets them on `.tl-gantt` from the tokens. Bars are `color-mix()` tints of `--cv-s3` on the surface (22% for the bar, 50% for progress), so ink labels keep at least 7:1 contrast in both themes.

## 7. 400 px

- The page body stays within the viewport: `document.documentElement.scrollWidth <= 400`.
- vis-timeline fits the box: the narrow window from section 4 keeps bars wide enough for their labels, and the reader pans for the rest.
- frappe-gantt scrolls horizontally inside its own `.gantt-container`, which the library already sets to `overflow: auto`; the page around it does not scroll.

## 8. Gate

Run the gate from `../SKILL.md`, waiting on `body[data-timelines-ready]` (set when vis-timeline fires its first `changed`) plus about a second for frappe-gantt's smooth scroll to the first task. Each round, also check that `performance.getEntriesByType('resource')` lists only the two scripts, and set `data-theme="dark"` on `<html>` under light media to see both charts repaint.
