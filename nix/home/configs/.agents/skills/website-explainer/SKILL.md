---
description: Research a subject, then explain it as a Korean slide-per-concept website rendered through the Artifact tool. Invoke when the user wants something explained visually — a PR, a bug, an architecture, a decision, a concept.
when_to_use: When the user says "website-explainer", "웹사이트로 설명해줘", "랜딩 페이지 만들어줘", or asks for a visual Korean explainer page for any subject.
---

# Website Explainer

Explain ONE real subject as a Korean website, rendered via the Artifact tool as a self-contained HTML file.

**No external resources.** Artifacts run under a strict CSP — no CDN scripts, no external stylesheets, no web fonts. Inline everything, including SVG and JS.

## Step 1 — Ground the page in the real subject, before writing any HTML

The page states facts about a specific thing. Gather those facts first, from the source itself.

| The subject is | Read this first |
|---|---|
| A GitHub PR / issue | `gh pr view <n> --json title,body,files,commits` plus `gh pr diff <n>` — the real diff, the real files, the real review comments |
| Several PRs to order | `gh pr list --json number,title,headRefName,baseRefName,files` — build the dependency edges from actual base branches and overlapping files |
| A bug or an investigation | The failing code, the stack trace, the fix diff |
| An architecture or a design | The modules, the config, the ADR — read them, do not paraphrase the request |
| This session's own work | The diffs and decisions already in context — those are the facts |

Every slide carries at least one concrete identifier: a PR number, a file path, a function name, a measured number, a branch name. A slide that would read the same for any project is not grounded yet — go back and read the source.

When the user names a subject you cannot reach (no repo access, no such PR), say so in one line and ask for the source. Do not fill the gap with a generic page — a generic page is the single failure this skill has produced most often, and the user's words for it were "fucking not generic one".

## Step 2 — Size the page to the subject

Plan the slide count from the material, not from a default. Slides are cheap; crowding is not.

- **Skim** (a status, a single decision): 5–8 slides.
- **Brief** (a PR, a bug, a comparison): 10–15 slides.
- **Deep** (an architecture, a full pipeline, "explain every core idea"): 20+ slides. Give each idea its own slide rather than compressing three into one.

When the user says 자세히 / detail / "explain all X slide-by-slide" / "20+ slides allowed", they are correcting the page for being too shallow. Answer with more slides, each still holding one idea — never with denser slides.

## Step 3 — Choose the visual form per slide

Pick the form from what the slide has to say. Most slides in a technical explainer are diagrams, not sentences.

| The slide says | Form |
|---|---|
| A dependency, a flow, an order | Inline SVG node-and-arrow graph — nodes as `<rect>`+`<text>`, edges as `<path>` with a `marker-end` arrowhead; lay out left-to-right or top-down by rank |
| A sequence over time | Inline SVG timeline — one axis, labeled ticks, events as dots with captions |
| Before vs after | Two columns side by side, or one `.bg-dark` slide holding the after |
| A measured number | `.hero-number` — one number, huge, accent color |
| A distribution or a series | Load the `dataviz` skill first, then draw it as inline SVG — it carries the palette, axis, and chart-form rules |
| A code change | A `<pre>` block with added/removed lines tinted, trimmed to the lines that matter |
| Motion, interaction, or a stepped walkthrough | Inline `<script>` — a step button, a slider, a `requestAnimationFrame` loop |

**Draw what the axis claims.** A chart labeled 중앙값 / 평균 / P95 must plot those three against each other, with the axis named. A graph of a value changing over `t` must animate or step `t`, not show one frozen frame. Getting the chart's own semantics wrong is the second most frequent failure here.

Inline JS is allowed and encouraged for stepped or animated explanations. Keep it in one `<script>` tag at the end of `<body>`, with no external imports.

## Step 4 — Design

**One slide = one concept.** Each `<section>` is a self-contained block — one idea, one emphasis, isolated from its neighbors by background or spacing. Sections size to their content.

**One emphasis per slide.** Pick ONE element — a number, a word, a diagram — and make it impossible to miss. Everything else recedes.

**Minimal prose, generous diagrams.** Body copy on a slide: ≤ 2 sentences. If it can be a diagram, a number, or a code block, make it that instead. Depth comes from more slides, not longer paragraphs.

**Korean.** Short, declarative sentences. Write titles that state the idea ("토폴로지 정렬로 리뷰 순서가 정해진다"), not ones that label it ("개요"). Keep identifiers, file paths, and API names in their original form. Avoid the AI-Korean register: 이를 통해, 다양한, 최적화, 효율적인, 향상, 편리한, 스마트한, 강력한, 혁신적인.

**Visual identity.** The template below is a structural skeleton — the section rhythm, the type scale, the spacing system. Its palette and typeface are a default, not a lock: choose a palette and a type treatment that fit this subject, and keep the choice consistent across every slide. When the `frontend-design` skill is also loaded, its identity guidance wins on palette, typography, and layout; this file still governs the slide-per-concept structure, the Korean copy rules, and the Artifact output.

## Starter template

Self-contained, no external dependencies. Fill in the placeholders, swap the palette for one that fits, and add slides by copying the `<section>` patterns.

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
    /* Diagram + code */
    .figure { width: 100%; max-width: 760px; overflow-x: auto; }
    .figure svg { max-width: 100%; height: auto; }
    .node { fill: #fff; stroke: var(--gray-200); }
    .node-on { fill: var(--accent); }
    .edge { stroke: var(--gray-400); stroke-width: 1.5; fill: none; }
    pre { text-align: left; width: 100%; max-width: 760px; overflow-x: auto; padding: 1.25rem 1.5rem; border-radius: .75rem; background: var(--gray-900); color: #e5e5e5; font-size: .9rem; line-height: 1.6; }
    .add { color: #4ade80; } .del { color: #f87171; }
    /* Controls for stepped slides */
    .controls { display: flex; gap: .75rem; margin-top: 1.5rem; }
    .step-btn { padding: .5rem 1.25rem; border: 1px solid var(--gray-200); border-radius: 9999px; background: #fff; font: inherit; font-size: .95rem; cursor: pointer; }
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

  <!-- Slide 3: Node-and-arrow diagram -->
  <section class="bg-white">
    <h2 class="h2">CONCEPT_TITLE</h2>
    <div class="figure">
      <svg viewBox="0 0 640 160" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--gray-400)"/>
          </marker>
        </defs>
        <rect class="node" x="20"  y="55" width="150" height="50" rx="10"/>
        <text x="95"  y="85" text-anchor="middle" font-size="15">NODE_A</text>
        <path class="edge" d="M175,80 H240" marker-end="url(#arrow)"/>
        <rect class="node" x="245" y="55" width="150" height="50" rx="10"/>
        <text x="320" y="85" text-anchor="middle" font-size="15">NODE_B</text>
        <path class="edge" d="M400,80 H465" marker-end="url(#arrow)"/>
        <rect class="node node-on" x="470" y="55" width="150" height="50" rx="10"/>
        <text x="545" y="85" text-anchor="middle" font-size="15" fill="#fff">NODE_C</text>
      </svg>
    </div>
    <p class="caption">WHAT_THE_DIAGRAM_SHOWS</p>
  </section>

  <!-- Slide 4: Code change -->
  <section class="bg-muted">
    <h2 class="h2">WHAT_CHANGED</h2>
    <pre><code><span class="del">- OLD_LINE</span>
<span class="add">+ NEW_LINE</span></code></pre>
    <p class="caption">FILE_PATH:LINE — WHY</p>
  </section>

  <!-- Slide 5: Dark contrast section -->
  <section class="bg-dark">
    <p class="eyebrow">BEFORE_LABEL</p>
    <h2 class="h2">THE_KEY_POINT</h2>
    <p class="lead">BRIEF_EXPLANATION</p>
  </section>

  <!-- Last slide: closing -->
  <section class="bg-accent-fill">
    <h2 class="h2">CLOSING_STATEMENT</h2>
    <p class="lead">OPTIONAL_SUBTEXT</p>
  </section>

</body>
</html>
```

## Anti-patterns

- Two things emphasized on one slide.
- Any `<link>`, `<script src>`, or `@import url(...)` — the CSP blocks every external resource, so the page renders broken.
- Slide titles that label instead of declare ("개요", "소개").
- Cookie banners, dark-mode toggles, nav bars, footers.
- A chart or diagram whose axes and labels do not match what it actually plots.

## Artifact output

Call the Artifact tool with:
- `file_path`: a short kebab-case `.html` name in the scratchpad directory.
- `favicon`: one emoji matching the subject.

**Re-invocation updates the same page.** When this skill runs again in a session that already published one — the user says 다시 / 업데이트 / more detail, or runs `/website-explainer` a second time on the same subject — edit that same file and call Artifact with the same `file_path`, so it redeploys to the same URL. Keep the `favicon` and the `<title>` stable across redeploys. Only a genuinely different subject gets a new file path. To update a page published in an earlier session, find it with `action: "list"` and pass its `url`.

Do not narrate the design choices. Render and present.
