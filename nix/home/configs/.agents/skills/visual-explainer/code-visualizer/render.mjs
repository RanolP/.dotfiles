// Pre-renders diffs, code files and ANSI terminal logs into one static HTML page fragment:
// no <script>, no external request. Run through ./render.sh, which installs the pinned packages.
// usage: render.sh <spec.json> <out.html>
//   spec: {"title": "...", "blocks": [
//     {"kind": "diff", "old": "a.ts", "new": "b.ts", "name": "src/a.ts", "caption": "..."},
//     {"kind": "file", "path": "b.ts", "name": "src/a.ts"},
//     {"kind": "term", "path": "test.log", "caption": "pnpm test"}]}
//   Paths are relative to the spec file. "name" sets the header and the language (by extension).
import fs from 'node:fs';
import path from 'node:path';
import { bundledThemes } from 'shiki';
import { registerCustomTheme } from '@pierre/diffs';
import { preloadDiffHTML, preloadFile } from '@pierre/diffs/ssr';

// Nord, https://www.nordtheme.com (MIT). Dark is Shiki's bundled `nord` with only the comment colour
// raised from #616E88 to #A6AFC0 (mixed 58% toward nord4, hue kept) so comments pass 4.5:1 on changed lines.
// Light swaps Polar Night and Snow Storm and darkens each accent in OKLCH lightness (hue kept)
// until it passes WCAG AA 4.5:1 on the lightest diff line background; NOTICE.md lists the values.
const LIGHT = {
  '#2E3440': '#ECEFF4', '#3B4252': '#E5E9F0', '#434C5E': '#D8DEE9', // backgrounds
  '#D8DEE9': '#2E3440', '#E5E9F0': '#3B4252', '#ECEFF4': '#2E3440', // text and punctuation
  '#616E88': '#55627B', // comments
  '#8FBCBB': '#3D6868', '#88C0D0': '#316877', '#81A1C1': '#466482', '#5E81AC': '#41638C', // Frost
  '#BF616A': '#9E444E', '#D08770': '#934F3A', '#EBCB8B': '#7A5D1C', '#A3BE8C': '#50683A', '#B48EAD': '#795673', // Aurora
};
// Nord's terminal mapping (terminal.ansi* in the nord theme), slots 0-15. Light keeps a slot that
// already passes on Snow Storm and darkens the rest the same way as the syntax accents.
const ANSI_DARK = ['#3B4252', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#88C0D0', '#E5E9F0',
  '#4C566A', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#8FBCBB', '#ECEFF4'];
const ANSI_LIGHT = ['#3B4252', '#9E444E', '#50683A', '#7A5D1C', '#466482', '#795673', '#316877', '#5E6167',
  '#4C566A', '#9E444E', '#50683A', '#7A5D1C', '#466482', '#795673', '#3D6868', '#5F6166'];
const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

const nord = (await bundledThemes.nord()).default;
const mapHex = (v) => typeof v === 'string'
  ? v.replace(/#[0-9a-fA-F]{6}/g, (h) => LIGHT[h.toUpperCase()] ?? h) : v;
const nordLight = JSON.parse(JSON.stringify(nord, (k, v) => mapHex(v)));
Object.assign(nordLight, { name: 'nord-light', displayName: 'Nord Light', type: 'light' });
ANSI_NAMES.forEach((n, i) => {
  nordLight.colors[`terminal.ansi${n}`] = ANSI_LIGHT[i];
  nordLight.colors[`terminal.ansiBright${n}`] = ANSI_LIGHT[i + 8];
});
registerCustomTheme('nord-light', async () => nordLight);
const nordDark = JSON.parse(JSON.stringify(nord, (k, v) => typeof v === 'string' ? v.replace(/#616E88/gi, '#A6AFC0') : v));
Object.assign(nordDark, { name: 'nord-comments', displayName: 'Nord (brighter comments)' });
registerCustomTheme('nord-comments', async () => nordDark);
const theme = { dark: 'nord-comments', light: 'nord-light' };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The wrapper the package's own SSR component emits (dist/ssr/FileDiffReact.js): a declarative shadow root.
const host = (html) => `<diffs-container><template shadowrootmode="open">${html}</template></diffs-container>`;

async function diffBlock(b, dir) {
  const read = (p) => ({ name: b.name ?? path.basename(b.new), contents: fs.readFileSync(path.resolve(dir, p), 'utf8') });
  const [oldFile, newFile] = [read(b.old), read(b.new)];
  const render = (diffStyle) => preloadDiffHTML({ oldFile, newFile, options: { theme, diffStyle, overflow: 'scroll' } });
  // Both layouts ship; CSS shows split above 700 px and unified below, so no script picks one.
  return `<div class="cv-split">${host(await render('split'))}</div><div class="cv-unified">${host(await render('unified'))}</div>`;
}

async function fileBlock(b, dir) {
  const file = { name: b.name ?? path.basename(b.path), contents: fs.readFileSync(path.resolve(dir, b.path), 'utf8') };
  const { prerenderedHTML } = await preloadFile({ file, options: { theme, overflow: 'scroll' } });
  return host(prerenderedHTML);
}

// ANSI SGR to HTML. The 16 colours become classes themed by --t-* tokens; 256-colour and
// truecolour values outside the 16 are written inline and do not follow the theme.
function cube(n) {
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  const v = [0, 95, 135, 175, 215, 255], i = n - 16;
  return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
}
function ansiToHtml(raw) {
  const text = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlink markers)
    .replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.slice(l.lastIndexOf('\r') + 1)).join('\n') // a carriage return overwrites its line
    .replace(/\x1b\[[0-9;?]*[A-La-ln-z]/g, ''); // cursor and erase sequences; SGR (m) stays
  let s = {}, out = '', open = false;
  const color = (codes, i) => { // 38/48 ; 5;n | 2;r;g;b -> [value, consumed]
    if (codes[i + 1] === 5) { const n = codes[i + 2]; return [n < 16 ? n : cube(n), 2]; }
    if (codes[i + 1] === 2) return [`rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`, 4];
    return [null, 0];
  };
  const span = () => {
    let { fg, bg } = s; const cls = [], css = [];
    if (s.inverse) [fg, bg] = [bg ?? 'bg', fg ?? 'fg'];
    else if (bg != null && fg == null) fg = 'bg'; // a badge with only a background reads in the page's own background colour
    for (const [v, p] of [[fg, 'f'], [bg, 'b']]) {
      if (v == null) continue;
      if (typeof v === 'number' || v === 'fg' || v === 'bg') cls.push(`t-${p}${v}`);
      else css.push(`${p === 'f' ? 'color' : 'background'}:${v}`);
    }
    if (s.bold) cls.push('t-bold');
    if (s.dim && fg == null) cls.push('t-dim');
    if (s.italic) cls.push('t-it');
    if (s.underline || s.strike) cls.push(s.underline && s.strike ? 't-us' : s.underline ? 't-u' : 't-s');
    if (!cls.length && !css.length) return '';
    return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}>`;
  };
  for (const part of text.split(/(\x1b\[[0-9;:]*m)/)) {
    if (!part.startsWith('\x1b[')) { out += esc(part); continue; }
    const codes = part.slice(2, -1).split(/[;:]/).map((c) => (c === '' ? 0 : +c));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) s = {};
      else if (c === 1) s.bold = 1; else if (c === 2) s.dim = 1; else if (c === 3) s.italic = 1;
      else if (c === 4) s.underline = 1; else if (c === 7) s.inverse = 1; else if (c === 9) s.strike = 1;
      else if (c === 22) s.bold = s.dim = 0; else if (c === 23) s.italic = 0; else if (c === 24) s.underline = 0;
      else if (c === 27) s.inverse = 0; else if (c === 29) s.strike = 0;
      else if (c >= 30 && c <= 37) s.fg = c - 30; else if (c >= 90 && c <= 97) s.fg = c - 82;
      else if (c >= 40 && c <= 47) s.bg = c - 40; else if (c >= 100 && c <= 107) s.bg = c - 92;
      else if (c === 39) s.fg = null; else if (c === 49) s.bg = null;
      else if (c === 38 || c === 48) { const [v, n] = color(codes, i); s[c === 38 ? 'fg' : 'bg'] = v; i += n; }
    }
    if (open) out += '</span>';
    const tag = span(); out += tag; open = tag !== '';
  }
  return out + (open ? '</span>' : '');
}
function termBlock(b, dir) {
  return `<pre class="cv-term" tabindex="0">${ansiToHtml(fs.readFileSync(path.resolve(dir, b.path), 'utf8')).replace(/\n+$/, '')}</pre>`;
}

const tokens = (ansi, v) => [...ansi.map((c, i) => `--t-${i}:${c}`),
  `--cv-bg:${v.bg}`, `--cv-ink:${v.ink}`, `--cv-muted:${v.muted}`, `--cv-line:${v.line}`, `--t-dim:${v.dim}`].join(';');
const LIGHT_VARS = tokens(ANSI_LIGHT, { bg: '#ECEFF4', ink: '#2E3440', muted: '#4C566A', line: '#C2CAD7', dim: '#55627B' });
const DARK_VARS = tokens(ANSI_DARK, { bg: '#2E3440', ink: '#D8DEE9', muted: '#A0A9BA', line: '#4C566A', dim: '#A0A9BA' });
const ansiClasses = Array.from({ length: 16 }, (_, i) => `.t-f${i}{color:var(--t-${i})}.t-b${i}{background:var(--t-${i})}`).join('');

const STYLE = `<style>
:root{${LIGHT_VARS};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_VARS};color-scheme:dark}}
:root[data-theme="dark"]{${DARK_VARS};color-scheme:dark}
body{background:var(--cv-bg);color:var(--cv-ink)}
.cv-page{padding:16px;max-width:1200px;margin:0 auto;box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.cv-page h1{font-size:1.4rem;margin:0 0 16px}
.cv-block{margin:0 0 24px}
.cv-cap{margin:0 0 8px;color:var(--cv-muted);font-size:.875rem}
.cv-block diffs-container{display:block;max-width:100%;overflow-x:clip;border:1px solid var(--cv-line);border-radius:6px}
.cv-block diffs-container{--diffs-bg-addition-override:color-mix(in lab,var(--diffs-bg) 90%,var(--diffs-addition-base));--diffs-bg-deletion-override:color-mix(in lab,var(--diffs-bg) 90%,var(--diffs-deletion-base));--diffs-bg-addition-emphasis-override:rgb(from var(--diffs-addition-base) r g b/.1);--diffs-bg-deletion-emphasis-override:rgb(from var(--diffs-deletion-base) r g b/.1);--diffs-fg-number-override:color-mix(in lab,var(--diffs-fg) 80%,var(--diffs-bg));--diffs-bg-separator-override:color-mix(in lab,var(--diffs-bg) 95%,var(--diffs-mixer))}
.cv-unified{display:none}
@media (max-width:700px){.cv-split{display:none}.cv-unified{display:block}}
:root[data-theme="dark"] diffs-container{color-scheme:dark}
:root[data-theme="light"] diffs-container{color-scheme:light}
.cv-term{margin:0;padding:12px 16px;overflow-x:auto;background:var(--cv-bg);color:var(--cv-ink);border:1px solid var(--cv-line);border-radius:6px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}
.cv-term:focus-visible{outline:2px solid var(--t-4);outline-offset:2px}
${ansiClasses}.t-ffg{color:var(--cv-ink)}.t-fbg{color:var(--cv-bg)}.t-bfg{background:var(--cv-ink)}.t-bbg{background:var(--cv-bg)}
.t-bold{font-weight:700}.t-dim{color:var(--t-dim)}.t-it{font-style:italic}.t-u{text-decoration:underline}.t-s{text-decoration:line-through}.t-us{text-decoration:underline line-through}
</style>`;

const [specPath, out] = process.argv.slice(2);
if (!out) { console.error('usage: render.sh <spec.json> <out.html>'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const dir = path.dirname(path.resolve(specPath));
const kinds = { diff: diffBlock, file: fileBlock, term: termBlock };
let body = spec.title ? `<h1>${esc(spec.title)}</h1>` : '';
for (const b of spec.blocks) {
  if (!kinds[b.kind]) throw new Error(`unknown block kind "${b.kind}" (diff, file, term)`);
  body += `<section class="cv-block">${b.caption ? `<p class="cv-cap">${esc(b.caption)}</p>` : ''}${await kinds[b.kind](b, dir)}</section>`;
}
const page = `<title>${esc(spec.title ?? 'Code')}</title>\n${STYLE}\n<main class="cv-page">${body}</main>\n`;
if (/<script/i.test(page)) throw new Error('rendered page contains a <script> tag');
fs.writeFileSync(out, page);
console.log(`${out} ${Buffer.byteLength(page)} bytes`);
