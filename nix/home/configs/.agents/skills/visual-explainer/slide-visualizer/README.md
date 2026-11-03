# Slide visualizer

A slide deck is a sequence of claims the reader steps through one at a time, each on a fixed 16:9 slide. The deck is a single HTML page fragment with no library of its own; a chart on a slide loads Apache ECharts exactly as chart-visualizer does. The render gate, theme and width checks are in `../SKILL.md`.

The stage model, the one-idea-per-slide density rule and the split-instead-of-shrink rule come from frontend-slides, restated here; credits and licenses are in `../NOTICE.md`.

## When to use

A deck beats a scrolling page when the order of the claims is the argument and the reader should meet them one at a time: a review presented in a meeting, a proposal walked through live, a story with a setup and a turn. The slide boundary forces one claim per view and gives the presenter a pace.

A scrolling page is better when the reader will search, skim, compare or come back for reference, when the content is dense, or when most readers are on a phone, since a phone shows a 16:9 slide at about a fifth of its authored size. One measure with one claim is a chart (chart-visualizer); several measures answering one question at once is a dashboard (dashboard-visualizer).

## 1. Slide anatomy: one claim per slide

- **Headline is the claim**, written as a full sentence with the takeaway in it ("App signups passed web in Q4 2025"), never a topic label ("Signups"). Reading only the headlines in order tells the whole story.
- **One piece of evidence** under it: a chart, a diagram, a number, or at most three short bullets. A slide that needs more is two slides.
- **Optional foot line** for the source or the next step, in `--cv-muted`.
- **Title slide**: kicker (what and when), the deck's main claim as the `<h1>`, byline. **Closing slide**: the decision or next step as the headline, up to three bullets, who to ask.
- When content outgrows a slide, split it into a continuation slide; shrinking type below the floor in section 3 is not an option.

## 2. Stage and scaling

Start from `template.html`.

- Every slide is authored on one 1920 x 1080 stage (`.sv-stage`) in stage pixels, and a `ResizeObserver` scales the whole stage with one `transform: scale(deckWidth / 1920)`. Nothing on a slide reflows at any width; there are no breakpoints inside the stage.
- The deck box (`.sv-deck`) keeps `aspect-ratio: 16 / 9` and takes the full width, capped so the deck plus its controls fit the viewport height (`calc((100dvh - 120px) * 16 / 9)`).
- Slides switch by toggling `.is-active`, which flips `visibility` and `opacity`. Hidden slides keep their layout, so a chart on a slide that is not showing still has its size, and they leave the accessibility tree.
- Motion is a 0.2 s opacity fade, removed under `prefers-reduced-motion`.

## 3. Type sizes at 400 px

At 400 px viewport width the deck is 368 px wide, a scale of 0.19. So:

- **No text below 60 px on the stage** (11.5 px at 400 px): body, bullets, axis labels, foot lines alike. Headlines 84 px, the title slide's `<h1>` 120 px.
- At 1200 px wide the same 60 px reads as about 36 px, so the floor costs nothing on a laptop; it caps a slide at roughly three bullets or one chart, which is the density section 1 asks for anyway.
- Lines and marks scale too: a 6 px stage line is about 1 px at 400 px. Keep chart lines at 6 px and avoid hairlines on the stage.

## 4. Navigation inside an Artifact

The viewer refuses the fullscreen and print APIs, so the deck lives in the page and every control works inside it:

- **Keys**: Right, Down, Page Down and Space go forward; Left, Up and Page Up go back; Home and End jump to the ends. Keys reach the page only once it has focus, so a pointer press on the deck focuses it (`tabindex="0"`), and the handler ignores keys while focus is in a form field or a modifier key is held.
- **Swipe**: a touch or pen drag of 40 px or more that is mostly horizontal turns the slide. `touch-action: pan-y` on the deck keeps vertical page scrolling native.
- **Buttons**: Prev and Next below the deck, at least 44 x 44 px, disabled at the ends, with a `1 / 3` counter in an `aria-live="polite"` region.
- Semantics: the deck is a `region` with `aria-roledescription="slide deck"` and a label naming the controls; each slide is a `group` with `aria-roledescription="slide"` and an `aria-label` of `n of N`.

## 5. Tokens

Use chart-visualizer's `--cv-*` tokens unchanged (light on `:root`, dark under both the media guard and `:root[data-theme="dark"]`). The slide surface is `--cv-surface` on a `--cv-bg` page, headlines `--cv-ink`, kickers and foot lines `--cv-muted`, and the title slide's accent bar `--cv-s1`. Type is the system UI stack shared with the other visuals.

## 6. Charts and diagrams on a slide

- A chart follows `../chart-visualizer/README.md` (form, palette, theming, accessibility) with the `dataviz` rules, plus three stage adjustments shown in the template: the chart box has a fixed size in stage pixels (1680 x 760 under a one-line headline), every chart font is 60 px, and the tooltip uses `appendTo: 'body'` so it renders outside the scaled stage at page size. ECharts maps pointer positions through the CSS transform on its own.
- Register the `finished` listener before the first `setOption`; with animation off the first render can finish before a later listener is attached.
- The `<details>` data table chart-visualizer adds does not fit on a slide; put the numbers in the chart box's `aria-label` sentence instead.
- A diagram follows `../diagram-visualizer/README.md`, drawn as an inline SVG sized in stage pixels, with its labels at 60 px.

## 7. Gate

Run the gate from `../SKILL.md` on **every slide**, not only the first: render the page, wait on `body[data-deck-ready]` (set when the chart fires `finished`), screenshot, press ArrowRight, and repeat, at 1200 and 400 px in light and dark. Each round, also check that `document.documentElement.scrollWidth <= 400` at 400 px, that a horizontal touch swipe turns the slide both ways, and that setting `data-theme="dark"` on `<html>` under light media repaints the chart.
