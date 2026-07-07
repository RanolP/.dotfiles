---
description: Build an Apple-style slide-per-concept Korean explainer website and render it as an Artifact. Invoke when the user wants to explain something visually — a product, concept, or feature — as a web page.
when_to_use: When the user says "website-explainer", "웹사이트로 설명해줘", "랜딩 페이지 만들어줘", or asks for a visual Korean explainer page for any concept.
---

# Website Explainer

Create an Apple-style Korean explainer website. Render it via the Artifact tool as a self-contained HTML file.

**No external resources.** Artifacts run under a strict CSP — no CDN scripts, no external stylesheets, no web fonts. Everything must be inline.

## Design principles

**One slide = one concept.** Each `<section>` is a self-contained content block — one idea, one emphasis, visually isolated from neighbors by background or spacing. Sections size to their content; they are not forced to full viewport height.

**One emphasis per slide.** Pick ONE element — a number, a word, a short phrase — and make it impossible to miss (oversized, bold, accent color). Everything else recedes visually.

**Minimal text.** Body copy: ≤ 2 sentences. Subtext: ≤ 1 line. If it can be shown as a visual, number, or icon, remove the sentence.

**Apple aesthetic.**
- Font: `-apple-system, BlinkMacSystemFont, 'Noto Sans KR', sans-serif` — system font, no import needed.
- Palette: clean white / deep black / one accent (`--accent: #0071e3` or user-supplied). No decorative gradients.
- Space: generous padding. Elements breathe. Nothing is crowded.

**Korean only.** Write in Korean. Short, declarative sentences. Never use: 이를 통해, 다양한, 최적화, 효율적인, 향상, 편리한, 스마트한, 강력한, 혁신적인.

## Slide structure

- **Slide 1** — Title + one-line hook. What is this about.
- **Middle slides** — One concept each. Most need ≤ 3 elements on screen.
- **Last slide** — One closing statement or call-to-action.

Plan the slide count first (shoot for 5–8). More slides is better than crowded slides.

## Starter template

Start from this template exactly. It is fully self-contained — no external dependencies. Fill in the marked placeholders. Add slides by copying existing `<section>` patterns.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TITLE</title>
  <style>
    :root {
      --accent: #0071e3;
      --gray-50: #f9f9f9;
      --gray-200: #e5e5e5;
      --gray-400: #9ca3af;
      --gray-500: #6b7280;
      --gray-900: #111;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans KR', sans-serif;
      -webkit-font-smoothing: antialiased;
      background: #fff;
      color: var(--gray-900);
      line-height: 1.5;
    }
    section {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 6rem 2rem;
      max-width: 900px;
      margin: 0 auto;
    }
    /* Typography scale */
    .eyebrow { font-size: .875rem; letter-spacing: .15em; text-transform: uppercase; color: var(--gray-400); margin-bottom: 1.5rem; }
    .h1 { font-size: clamp(3rem, 8vw, 5.5rem); font-weight: 700; letter-spacing: -.03em; line-height: 1; margin-bottom: 1.5rem; }
    .h2 { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 700; letter-spacing: -.02em; line-height: 1.1; margin-bottom: 2rem; }
    .hero-number { font-size: clamp(5rem, 18vw, 9rem); font-weight: 700; line-height: 1; color: var(--accent); }
    .lead { font-size: clamp(1.1rem, 2.5vw, 1.375rem); color: var(--gray-500); max-width: 36rem; }
    .caption { font-size: 1rem; color: var(--gray-400); max-width: 30rem; margin-top: 1.5rem; }
    /* Section backgrounds */
    .bg-white  { background: #fff; }
    .bg-muted  { background: var(--gray-50); }
    .bg-dark   { background: var(--gray-900); color: #fff; }
    .bg-dark .lead, .bg-dark .caption { color: var(--gray-400); }
    .bg-accent-fill { background: var(--accent); color: #fff; }
    .bg-accent-fill .lead { color: rgba(255,255,255,.75); }
    /* Dividers between slides */
    section + section { border-top: 1px solid var(--gray-200); }
    .bg-dark + section, section + .bg-dark,
    .bg-accent-fill + section, section + .bg-accent-fill { border-top: none; }
    /* CTA button */
    .btn {
      display: inline-block;
      margin-top: 2.5rem;
      padding: .875rem 2.5rem;
      border-radius: 9999px;
      font-size: 1.1rem;
      font-weight: 600;
      background: #fff;
      color: var(--accent);
      text-decoration: none;
      transition: opacity .15s;
    }
    .btn:hover { opacity: .85; }
    /* Spacing helpers */
    .mt-sm { margin-top: 1rem; }
    .mt-md { margin-top: 1.5rem; }
    .mt-lg { margin-top: 2.5rem; }
    .mb-sm { margin-bottom: 1rem; }
    .mb-md { margin-bottom: 1.5rem; }
  </style>
</head>
<body>

  <!-- Slide 1: Title -->
  <section class="bg-white">
    <p class="eyebrow">CATEGORY</p>
    <h1 class="h1">TITLE</h1>
    <p class="lead">ONE_LINE_HOOK</p>
  </section>

  <!-- Slide 2: Big number — the ONE emphasis -->
  <section class="bg-muted">
    <p class="eyebrow">CONTEXT</p>
    <p class="hero-number">THE_NUMBER</p>
    <p class="lead mt-md">WHAT_IT_MEANS</p>
  </section>

  <!-- Slide 3: Concept with SVG visual -->
  <section class="bg-white">
    <h2 class="h2">CONCEPT_TITLE</h2>
    <!-- Replace this SVG with something relevant to the topic -->
    <svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="80" cy="80" r="64" fill="var(--accent)" opacity=".1"/>
      <circle cx="80" cy="80" r="40" fill="var(--accent)" opacity=".3"/>
      <circle cx="80" cy="80" r="16" fill="var(--accent)"/>
    </svg>
    <p class="caption">DESCRIPTION_MAX_2_SENTENCES</p>
  </section>

  <!-- Slide 4: Dark contrast section -->
  <section class="bg-dark">
    <p class="eyebrow">BEFORE_LABEL</p>
    <h2 class="h2">THE_KEY_POINT</h2>
    <p class="lead">BRIEF_EXPLANATION</p>
  </section>

  <!-- Last slide: CTA -->
  <section class="bg-accent-fill">
    <h2 class="h2">CLOSING_STATEMENT</h2>
    <p class="lead">OPTIONAL_SUBTEXT</p>
    <a href="#" class="btn">CTA_TEXT</a>
  </section>

</body>
</html>
```

## Emphasis patterns — pick one per slide

| What to emphasize | How |
|---|---|
| A number / stat | `.hero-number` — huge, accent color |
| A single word or phrase | `.h1` or `.h2` on a contrasting background |
| A visual / diagram | Inline SVG, `.caption` below |
| A before/after contrast | `.bg-dark` section |
| A closing punch | `.bg-accent-fill` with `.btn` |

Use each pattern at most twice across the whole page.

## Anti-patterns — never do these

- Two things emphasized in one slide.
- ≥ 3 body sentences on any slide.
- Any `<link>`, `<script src>`, or `@import url(...)` — all external resources are blocked.
- Generic Korean AI phrases (이를 통해 / 다양한 / 최적화 / 스마트한).
- Slide titles that label instead of declare ("개요", "소개" → state the actual idea).
- Cookie banners, dark-mode toggles, nav bars, footers — none of these.

## Artifact output

Call the Artifact tool with:
- `file_path`: a short kebab-case `.html` name in the scratchpad directory.
- `favicon`: one emoji matching the topic.

Do not narrate the design choices. Render and present.
