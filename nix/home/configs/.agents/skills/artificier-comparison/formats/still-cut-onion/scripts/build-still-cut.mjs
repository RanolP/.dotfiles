#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { esc, imageCollector, numberText, onionAssets, onionCell, shotImage } from './lib/onion.mjs';

const usage = `Usage:
  node scripts/build-still-cut.mjs --input <path/stills.json> --out <path/index.html>
  node scripts/build-still-cut.mjs --selftest
  node scripts/build-still-cut.mjs --help

stills.json: {"title": "<2-4 words>", "subtitle"?: "<str>", "notes"?: ["<str>"],
  "rows": [{"name": "<str>", "notes"?: "<str>" | ["<str>"], "asis": "<png|jpg path>" | null, "tobe": "<png|jpg path>" | null}]}
Image paths are relative to stills.json and must sit under the --out directory.
Prints one "<src>\\t<absolute path>" line per image: the Artifact files map.`;

class UsageError extends Error {}

function list(value, where) {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) throw new Error(`${where} must be a string or an array of strings`);
  return items;
}

function validate(data, file) {
  if (!data || typeof data !== 'object') throw new Error(`${file} must hold a JSON object`);
  const words = String(data.title ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) throw new Error(`${file}: title "${data.title ?? ''}" has ${words.length} words; give 2 to 4 words for the Artifact page title`);
  if (!Array.isArray(data.rows) || !data.rows.length) throw new Error(`${file}: rows must be a non-empty array`);
  data.rows.forEach((row, i) => {
    if (typeof row?.name !== 'string' || !row.name.trim()) throw new Error(`${file}: rows[${i}].name must be a non-empty string`);
    for (const side of ['asis', 'tobe']) if (row[side] === undefined) row[side] = null;
    if (row.asis === null && row.tobe === null) throw new Error(`${file}: rows[${i}] (${row.name}) needs an asis or a tobe image`);
    row.notes = list(row.notes, `${file}: rows[${i}].notes`);
  });
  data.notes = list(data.notes, `${file}: notes`);
  return data;
}

// Both captures are drawn at one width, so the frame is as tall as the taller capture at that width.
function frameRatio(asis, tobe) {
  const shots = [asis, tobe].filter(Boolean);
  const width = shots[0].width;
  const height = Math.max(...shots.map(shot => shot.height * width / shot.width));
  return `${numberText(width)} / ${numberText(height)}`;
}

export async function buildStillCut(inputPath, outputPath) {
  const data = validate(JSON.parse(await readFile(inputPath, 'utf8')), path.basename(inputPath));
  const outputDir = path.dirname(path.resolve(outputPath));
  const { image, files } = imageCollector(path.dirname(path.resolve(inputPath)), outputDir, path.basename(inputPath));
  const rows = [];
  for (const [index, row] of data.rows.entries()) {
    const asis = await image(row.asis);
    const tobe = await image(row.tobe);
    const ratio = frameRatio(asis, tobe);
    const notes = row.notes.length ? `<ul class="row-notes">${row.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : '';
    const frame = (shot, alt) => `<div class="screen comparison-screen" style="aspect-ratio:${ratio}">${shotImage(shot, alt)}</div>`;
    rows.push(`<article class="still-row"><h2>${esc(row.name)}</h2>${notes}<div class="comparison-grid"><figure class="shot"><figcaption>as-is</figcaption>${frame(asis, `${row.name} as-is`)}</figure><figure class="shot"><figcaption>to-be</figcaption>${frame(tobe, `${row.name} to-be`)}</figure>${onionCell({ asis, tobe, ratio, id: `onion-${index + 1}`, label: row.name, asisAlt: `${row.name} as-is`, tobeAlt: `${row.name} to-be` })}</div></article>`);
  }
  const { css, js } = await onionAssets();
  const pageCss = `.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.subtitle { margin: 6px 0 0; color: var(--muted); max-width: 75ch; }
.page-notes, .row-notes { margin: 6px 0 10px; padding-left: 20px; color: var(--muted); overflow-wrap: anywhere; }
.still-row { margin: 0 0 16px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); min-width: 0; }
.still-row h2 { margin: 0 0 6px; font-size: 16px; overflow-wrap: anywhere; }
@media (max-width: 720px) { .comparison-grid > .onion-cell { grid-column: 1 / -1; } }
`;
  const subtitle = data.subtitle ? `<p class="subtitle">${esc(data.subtitle)}</p>` : '';
  const pageNotes = data.notes.length ? `<ul class="page-notes">${data.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : '';
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(data.title.trim())}</title><style>${css}${pageCss}</style></head>
<body><main class="page"><header class="top"><div><h1>${esc(data.title.trim())}</h1>${subtitle}</div><button type="button" class="theme-toggle" aria-label="색상 테마 전환">테마 전환</button></header>${pageNotes}${rows.join('')}</main><script>${js}</script></body></html>`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { html, files };
}

// A PNG whose IHDR carries the size is all readImageSize needs.
function sizeOnlyPng(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

async function selftest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'still-cut-selftest-'));
  try {
    await mkdir(path.join(root, 'shots'));
    await writeFile(path.join(root, 'shots', 'a.png'), sizeOnlyPng(100, 200));
    await writeFile(path.join(root, 'shots', 'b.png'), sizeOnlyPng(50, 120));
    const input = { title: 'Login Button Change', rows: [
      { name: 'both', asis: 'shots/a.png', tobe: 'shots/b.png' },
      { name: 'one side', asis: 'shots/a.png', tobe: null },
    ] };
    await writeFile(path.join(root, 'stills.json'), JSON.stringify(input));
    const built = await buildStillCut(path.join(root, 'stills.json'), path.join(root, 'index.html'));
    // Catches an image printed twice (or not at all) in the Artifact files map.
    assert.deepEqual(built.files.map(file => file.src), ['shots/a.png', 'shots/b.png']);
    // Catches a narrower, taller to-be being cropped: the frame takes the taller capture at the as-is width (240 at width 100).
    assert.match(built.html, /aspect-ratio:100 \/ 240/);
    // Catches a one-sided row losing colour separation or gaining a slider with nothing to blend.
    assert.equal((built.html.match(/<figure class="shot onion-cell"/g) || []).length, 2);
    assert.equal((built.html.match(/<input id="onion-/g) || []).length, 1);
    // Catches an image outside the page directory slipping into a src the Artifact cannot serve.
    await writeFile(path.join(root, 'outside.json'), JSON.stringify({ ...input, rows: [{ name: 'x', asis: '../a.png' }] }));
    await assert.rejects(buildStillCut(path.join(root, 'outside.json'), path.join(root, 'index.html')), /outside output directory/);
    console.log('selftest ok: files map + frame ratio + one-sided onion + outside-path guard');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' }, selftest: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return void process.stdout.write(`${usage}\n`);
  if (values.selftest) return selftest();
  if (!values.input || !values.out) throw new UsageError('--input and --out are required');
  const { files } = await buildStillCut(values.input, values.out);
  for (const file of files) console.log(`${file.src}\t${file.source}`);
}

main().catch(error => {
  console.error(`build-still-cut: ${error.message}`);
  if (error instanceof UsageError) console.error(usage);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
