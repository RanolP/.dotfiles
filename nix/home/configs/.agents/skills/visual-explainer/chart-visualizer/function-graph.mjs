// Pre-renders function graphs with function-plot into one static HTML page fragment:
// no <script>, no external request. Run through ./function-graph.sh, which installs the pinned packages.
// usage: function-graph.sh <spec.json> <out.html>
//   spec: {"title": "...", "graphs": [{
//     "title": "...", "sub": "...", "caption": "...", "label": "the claim, read by screen readers",
//     "plot": {<function-plot options without target, width, height>}}]}
//   Each plot.data[i] may carry "legend": "y = sin x"; series i takes colour slot i + 1 (six slots).
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { hsl } from 'd3-color';

// function-plot draws with d3 into a live DOM; jsdom supplies one, so no browser runs at build time.
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MouseEvent',
  'getComputedStyle', 'requestAnimationFrame']) globalThis[k] ??= k === 'window' ? dom.window : dom.window[k];
const functionPlot = (await import('function-plot')).default.default;

// Each slot is drawn in a sentinel colour, then rewritten to a CSS variable so the page theme
// recolours it. Scatter and text derive a fill with d3's brighter(1.5); that maps to the soft token.
const SLOTS = 6;
// Mid-lightness hues 60 degrees apart, so no slot collides with another slot's brightened fill.
const sentinel = (i) => hsl(i * 60, 0.5, 0.3).formatHex();
const COLOR_VARS = new Map();
for (let i = 0; i < SLOTS; i++) {
  COLOR_VARS.set(sentinel(i), `var(--fg-s${i + 1})`);
  COLOR_VARS.set(hsl(sentinel(i)).brighter(1.5).formatHex(), `var(--fg-s${i + 1}-soft)`);
}
if (COLOR_VARS.size !== 2 * SLOTS) throw new Error('sentinel colours collide');
// Series take colours from this list by datum index, and so do helpers such as a derivative's tangent.
functionPlot.globals.COLORS = Array.from({ length: SLOTS }, (_, i) => hsl(sentinel(i)));
// Library colours the stylesheet below re-themes by class (axes, origin, vector marker, annotation
// line), and the hover tip's grey, whose group is removed.
const RESTYLED = new Set(['black', 'grey', '#777', '#eee']);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderSvg(plot, width, height, id) {
  const target = document.createElement('div');
  document.body.append(target);
  const opts = structuredClone(plot);
  opts.data = (opts.data ?? []).map((d, i) => {
    if (i >= SLOTS) throw new Error(`more than ${SLOTS} series; split into small multiples`);
    const { legend, ...rest } = d;
    // The default interval sampler clamps an out-of-range curve to a flat line along the plot edge;
    // the built-in sampler with a polyline leaves the clip path to cut it.
    const smooth = d.fn && !d.graphType && !d.sampler ? { graphType: 'polyline', sampler: 'builtIn' } : {};
    return { ...smooth, ...rest };
  });
  const chart = functionPlot({ ...opts, target, width, height, disableZoom: true });
  const svg = target.querySelector('svg');
  // Interaction layers do nothing without a script: the hover tip, the zoom surface, the hover legend.
  svg.querySelectorAll('.tip, .zoom-and-drag, .top-right-legend').forEach((n) => n.remove());
  for (const el of svg.querySelectorAll('[stroke], [fill]')) {
    for (const attr of ['stroke', 'fill']) {
      const v = el.getAttribute(attr);
      if (v == null || v === 'none' || v === 'currentColor') continue;
      if (RESTYLED.has(v)) { el.removeAttribute(attr); continue; }
      const token = COLOR_VARS.get(v.toLowerCase());
      // A colour that matches no slot would ignore the theme; refuse it rather than bake it in.
      if (!token) throw new Error(`unthemed ${attr}="${v}" on <${el.tagName} class="${el.getAttribute('class') ?? ''}">`);
      el.removeAttribute(attr);
      el.setAttribute('style', `${el.getAttribute('style') ?? ''}${attr}:${token};`);
    }
  }
  svg.querySelectorAll('.tick line, .domain, .origin').forEach((n) => n.removeAttribute('opacity'));
  // The lowest y tick label sits on the x axis, over the first x tick label; drop it.
  const plotHeight = +svg.querySelector('.clip').getAttribute('height');
  for (const t of svg.querySelectorAll('.y.axis .tick')) {
    if (Math.abs(+/,([\d.]+)\)/.exec(t.getAttribute('transform'))[1] - plotHeight) < 1) t.querySelector('text')?.remove();
  }
  svg.removeAttribute('font-size');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', `max-width:${width}px`);
  // function-plot ids are random; a fixed id keeps the output reproducible and unique per page.
  const html = svg.outerHTML.replaceAll(chart.id, id);
  target.remove();
  return html;
}

// Nord, https://www.nordtheme.com (MIT). Dark: Nord values, with muted text at #A0A9BA as in
// code-visualizer. Light: Snow Storm surface and the code-visualizer accents darkened to 4.5:1.
const LIGHT = { bg: '#E5E9F0', surface: '#ECEFF4', ink: '#2E3440', muted: '#4C566A', grid: '#D8DEE9', axis: '#7B88A1',
  s: ['#316877', '#9E444E', '#50683A', '#795673', '#934F3A', '#7A5D1C'] };
const DARK = { bg: '#242933', surface: '#2E3440', ink: '#D8DEE9', muted: '#A0A9BA', grid: '#3B4252', axis: '#616E88',
  s: ['#88C0D0', '#BF616A', '#A3BE8C', '#B48EAD', '#D08770', '#EBCB8B'] };
const vars = (p) => [`--fg-bg:${p.bg}`, `--fg-surface:${p.surface}`, `--fg-ink:${p.ink}`, `--fg-muted:${p.muted}`,
  `--fg-grid:${p.grid}`, `--fg-axis:${p.axis}`,
  ...p.s.flatMap((c, i) => [`--fg-s${i + 1}:${c}`, `--fg-s${i + 1}-soft:color-mix(in srgb,${c} 35%,${p.surface})`])].join(';');

const STYLE = `<style>
:root{${vars(LIGHT)};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(DARK)};color-scheme:dark}}
:root[data-theme="dark"]{${vars(DARK)};color-scheme:dark}
body{background:var(--fg-bg);color:var(--fg-ink)}
.fg-page{padding:16px;max-width:960px;margin:0 auto;box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.fg-page h1{font-size:1.4rem;margin:0 0 16px}
.fg{margin:0 0 24px;background:var(--fg-surface);border-radius:8px;padding:16px}
.fg h2{font-size:16px;font-weight:600;margin:0 0 4px}
.fg-sub,.fg figcaption{color:var(--fg-muted);font-size:13px;margin:0 0 8px}
.fg figcaption{margin:8px 0 0}
.fg-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 8px;padding:0;list-style:none;font-size:13px;color:var(--fg-muted)}
.fg-legend li::before{content:"";display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle;background:var(--sw)}
.fg-plot svg{display:block;width:100%;height:auto;margin:0 auto;overflow:visible;color:var(--fg-muted)}
.fg-plot text{fill:currentColor;font:13px system-ui,-apple-system,"Segoe UI",sans-serif}
.fg-plot .axis-label{fill:var(--fg-ink);font-weight:600}
.fg-plot .tick line{stroke:var(--fg-grid)}
.fg-plot .domain,.fg-plot .origin{stroke:var(--fg-axis)}
.fg-plot text{paint-order:stroke;stroke:var(--fg-surface);stroke-width:3px;stroke-linejoin:round}
.fg-plot marker path{fill:var(--fg-muted)}
.fg-plot .annotations path{stroke:var(--fg-axis);stroke-dasharray:4 4}
.fg-plot .graph path{stroke-width:2px;stroke-linecap:round;stroke-linejoin:round}
.fg-narrow{display:none}
@media (max-width:700px){.fg-wide{display:none}.fg-narrow{display:block}}
</style>`;

const [specPath, out] = process.argv.slice(2);
if (!out) { console.error('usage: function-graph.sh <spec.json> <out.html>'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let body = spec.title ? `<h1>${esc(spec.title)}</h1>` : '';
spec.graphs.forEach((g, n) => {
  if (!g.label) throw new Error(`graph ${n}: "label" (the claim, read by screen readers) is required`);
  const legend = (g.plot.data ?? []).map((d, i) => d.legend
    ? `<li style="--sw:var(--fg-s${i + 1})">${esc(d.legend)}</li>` : '').join('');
  // Two renders, shown by width with no script: 640 x 400 above 700 px, 340 x 300 at 700 px and below,
  // so tick labels stay near 13 px instead of shrinking with a scaled-down wide render.
  body += `<figure class="fg">${g.title ? `<h2>${esc(g.title)}</h2>` : ''}${g.sub ? `<p class="fg-sub">${esc(g.sub)}</p>` : ''}`
    + (legend ? `<ul class="fg-legend">${legend}</ul>` : '')
    + `<div class="fg-plot" role="img" aria-label="${esc(g.label)}">`
    + `<div class="fg-wide">${renderSvg(g.plot, 640, 400, `fg${n}w`)}</div>`
    + `<div class="fg-narrow">${renderSvg(g.plot, 340, 300, `fg${n}n`)}</div></div>`
    + (g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : '') + '</figure>';
});
const page = `<title>${esc(spec.title ?? 'Function graph')}</title>\n${STYLE}\n<main class="fg-page">${body}</main>\n`;
if (/<script/i.test(page)) throw new Error('rendered page contains a <script> tag');
fs.writeFileSync(out, page);
console.log(`${out} ${Buffer.byteLength(page)} bytes`);
