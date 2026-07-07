---
description: Build an Apple-style slide-per-concept Korean explainer website and render it as an Artifact. Invoke when the user wants to explain something visually — a product, concept, or feature — as a web page.
when_to_use: When the user says "website-explainer", "웹사이트로 설명해줘", "랜딩 페이지 만들어줘", or asks for a visual Korean explainer page for any concept.
---

# Website Explainer

Create an Apple-style Korean explainer website. Render it via the Artifact tool as a self-contained HTML file.

## Design principles

**One slide = one concept.** Each `<section>` fills 100vh. One idea. Never more.

**One emphasis per slide.** Pick ONE element — a number, a word, a short phrase — and make it impossible to miss (oversized, bold, accent color). Everything else recedes visually.

**Minimal text.** Body copy: ≤ 2 sentences. Subtext: ≤ 1 line. If it can be shown as a visual, number, or icon, remove the sentence.

**Apple aesthetic.**
- Font: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Noto Sans KR', sans-serif`
- Palette: clean white / deep black / one accent (#0071e3 or user-supplied). No decorative gradients.
- Space: generous padding. Elements breathe. Nothing is crowded.

**Korean only.** Write in Korean. Short, declarative sentences. Never use: 이를 통해, 다양한, 최적화, 효율적인, 향상, 편리한, 스마트한, 강력한, 혁신적인.

## Slide structure

- **Slide 1** — Title + one-line hook. What is this about.
- **Middle slides** — One concept each. Most need ≤ 3 elements on screen.
- **Last slide** — One closing statement or call-to-action.

Plan the slide count first (shoot for 5–8). More slides is better than crowded slides.

## Starter template

Start from this template exactly. Fill in the marked placeholders. Add slides by copying the existing `<section>` patterns.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TITLE</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: { accent: '#0071e3' },
        },
      },
    }
  </script>
  <style>
    * { -webkit-font-smoothing: antialiased; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans KR', sans-serif; }
    html { scroll-behavior: smooth; }
    section {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 4rem 2rem;
      text-align: center;
    }
  </style>
</head>
<body class="bg-white text-gray-900">

  <!-- Slide 1: Title -->
  <section class="bg-white">
    <p class="text-base tracking-widest uppercase text-gray-400 mb-6">CATEGORY</p>
    <h1 class="text-7xl md:text-8xl font-bold tracking-tight leading-none mb-6">TITLE</h1>
    <p class="text-2xl text-gray-500 max-w-xl">ONE_LINE_HOOK</p>
  </section>

  <!-- Slide 2: Big number or stat — the ONE emphasis -->
  <section class="bg-gray-50">
    <p class="text-xl text-gray-400 mb-4">CONTEXT</p>
    <p class="text-[9rem] font-bold leading-none text-accent">THE_NUMBER</p>
    <p class="text-xl text-gray-500 mt-6 max-w-lg">WHAT_IT_MEANS</p>
  </section>

  <!-- Slide 3: Concept with visual -->
  <section class="bg-white">
    <h2 class="text-5xl font-bold mb-10">CONCEPT_TITLE</h2>
    <!-- Replace this SVG with something relevant -->
    <svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="100" cy="100" r="80" fill="#0071e3" opacity="0.1"/>
      <circle cx="100" cy="100" r="50" fill="#0071e3" opacity="0.3"/>
      <circle cx="100" cy="100" r="20" fill="#0071e3"/>
    </svg>
    <p class="text-xl text-gray-500 max-w-md mt-10">DESCRIPTION_MAX_2_SENTENCES</p>
  </section>

  <!-- Slide 4: Contrast or comparison — dark background -->
  <section class="bg-gray-900 text-white">
    <p class="text-lg text-gray-400 mb-4">BEFORE_LABEL</p>
    <h2 class="text-6xl font-bold mb-4">THE_KEY_POINT</h2>
    <p class="text-xl text-gray-400 max-w-lg">BRIEF_EXPLANATION</p>
  </section>

  <!-- Last Slide: Closing / CTA -->
  <section class="bg-accent text-white">
    <h2 class="text-6xl font-bold mb-6">CLOSING_STATEMENT</h2>
    <p class="text-xl opacity-75 max-w-lg mb-10">OPTIONAL_SUBTEXT</p>
    <a href="#" class="inline-block bg-white text-accent font-semibold px-10 py-4 rounded-full text-lg hover:opacity-90 transition">CTA_TEXT</a>
  </section>

</body>
</html>
```

## Emphasis patterns — pick one per slide

| What to emphasize | How |
|---|---|
| A number / stat | `text-[9rem]` font, accent color |
| A single word | `text-8xl font-bold`, contrasting bg |
| A short phrase | `text-5xl font-bold`, dark section |
| A visual / diagram | Full-width SVG, minimal caption below |
| A contrast | Split: before (gray) / after (accent) |

Use each pattern at most twice across the whole page.

## Anti-patterns — never do these

- Two things emphasized in one slide.
- ≥ 3 body sentences on any slide.
- Generic Korean AI phrases (이를 통해 / 다양한 / 최적화 / 스마트한).
- Slide titles that label instead of declare ("개요", "소개" → state the actual idea).
- Gradient text on more than one heading.
- Stock art descriptions in SVG comments.
- Cookie banners, dark-mode toggles, nav bars, footers — none of these.

## Artifact output

Call the Artifact tool with:
- `file_path`: a short kebab-case `.html` name in the scratchpad directory.
- `favicon`: one emoji matching the topic.

Do not narrate the design choices. Render and present.
