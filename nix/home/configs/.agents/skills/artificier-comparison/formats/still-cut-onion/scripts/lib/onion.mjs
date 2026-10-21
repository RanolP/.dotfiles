// Still-cut onion building blocks: the as-is | to-be | onion-skin cells, the image helpers behind them, and the
// page assets that drive the onion slider and red/cyan colour separation. design-review renders its gallery rows
// with these same functions, so a change here reaches both pages.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegSof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function esc(value) {
  return value === null || value === undefined ? '–' : String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function numberText(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export async function readImageSize(file) {
  const data = await readFile(file);
  if (data.subarray(0, 8).equals(pngSignature)) {
    if (data.length < 24 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`Invalid PNG IHDR: ${file}`);
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), format: 'png' };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error(`Unsupported image format (PNG or JPEG required): ${file}`);
  let offset = 2;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) continue;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (jpegSof.has(marker)) {
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
        format: 'jpeg',
      };
    }
    offset += length;
  }
  throw new Error(`Could not read JPEG dimensions: ${file}`);
}

// Every image must sit under the output directory, because the Artifact `files` map publishes each one at the
// path the page references, relative to the page. `inputName` names the file that holds the paths in errors.
async function relativeImage(rawPath, baseDir, outputDir, inputName) {
  if (rawPath === null) return null;
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new TypeError(`Image path "${rawPath}" must be a non-empty relative path; set a relative image path in ${inputName}`);
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[a-z]:[\\/]/i.test(rawPath)) {
    throw new TypeError(`image path must be relative: ${rawPath}`);
  }
  const source = path.resolve(baseDir, rawPath);
  const relative = path.relative(outputDir, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Image "${rawPath}" at ${source} is outside output directory ${outputDir} (${inputName.replace(/\.json$/, '')} directory ${baseDir}); place the image under ${outputDir} or choose an output directory beside the ${inputName.replace(/\.json$/, '')}.`);
  }
  const src = relative.split(path.sep).join('/');
  const size = await readImageSize(source);
  return { src, source, ...size };
}

// Resolves image paths written relative to the input JSON and collects each distinct one once, in first-use
// order, as the `{ src, source }` pairs a build script prints for the Artifact `files` map.
export function imageCollector(baseDir, outputDir, inputName) {
  const seen = new Set();
  const files = [];
  async function image(raw) {
    if (raw === null) return null;
    const result = await relativeImage(raw, baseDir, outputDir, inputName);
    if (!seen.has(result.src)) {
      seen.add(result.src);
      files.push({ src: result.src, source: result.source });
    }
    return result;
  }
  return { image, files };
}

export function shotImage(image, alt, className = 'screen-image') {
  return image
    ? `<img class="${className}" src="${esc(image.src)}" alt="${esc(alt)}">`
    : '<div class="stage-empty">미캡처</div>';
}

// One onion-skin figure: both captures stacked in `.onion-pair`, a canvas for colour separation, and the row's own
// controls. `overlay` is markup drawn above the images (design-review's box markers). `id` must be unique on the page.
export function onionCell({ asis, tobe, ratio, overlay = '', id, label, caption = '겹쳐 보기', asisAlt = '기준 화면', tobeAlt = '작업 후 화면' }) {
  const screen = `<div class="screen comparison-screen onion-screen" style="aspect-ratio:${ratio}"><div class="onion-pair">${shotImage(asis, asisAlt, 'onion-image onion-asis')}${shotImage(tobe, tobeAlt, 'onion-image onion-tobe')}</div><canvas class="sep-canvas" aria-label="색 분리 비교"></canvas>${overlay}</div>`;
  const rowLabel = esc(label);
  // The opacity slider needs both captures to blend; colour separation still reads one capture against an empty channel.
  const slider = asis && tobe
    ? `<label class="onion-slider" for="${id}"><span aria-hidden="true">겹침</span><input id="${id}" type="range" min="0" max="100" value="50" aria-label="${rowLabel} 작업 후 불투명도"></label><output class="onion-value" for="${id}">50%</output>`
    : '';
  const controls = asis || tobe
    ? `<div class="onion-controls">${slider}<button type="button" class="mode-toggle" aria-pressed="false" aria-label="${rowLabel} 색 분리">색 분리 켜기</button><span class="mode-notice" role="status" aria-live="polite" hidden>색 분리는 http(s)로 열었을 때만 동작한다</span></div>`
    : '';
  return `<figure class="shot onion-cell"><figcaption>${esc(caption)}</figcaption>${screen}${controls}</figure>`;
}

// CSS and script a page inlines ahead of its own: the colour tokens, the screen frames and the onion behaviour.
export async function onionAssets() {
  const [css, js] = await Promise.all([
    readFile(new URL('./assets/onion.css', import.meta.url), 'utf8'),
    readFile(new URL('./assets/onion.js', import.meta.url), 'utf8'),
  ]);
  return { css, js };
}
