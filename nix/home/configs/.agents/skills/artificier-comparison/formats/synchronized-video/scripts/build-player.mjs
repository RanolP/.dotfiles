#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseCliArgs, run, UsageError } from '../../../scripts/lib/cli.mjs';

const usage = `Usage:
  node scripts/build-player.mjs --takes <path/takes.json> --out <path/index.html>
  node scripts/build-player.mjs --selftest
  node scripts/build-player.mjs --help

Fills the fixed player.html template with takes.json (schema in formats/synchronized-video/reference.md)
and writes --out. Clip paths are relative to takes.json and must sit under the --out directory.
Prints one "<src>\\t<absolute path>" line per clip (the Artifact files map), then a WARN line per take without fps.`;

const template = new URL('../player.html', import.meta.url);

function fail(where, message) {
  throw new Error(`takes.json ${where}: ${message}`);
}
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const isText = value => typeof value === 'string' && value.trim() !== '';

function validate(data) {
  const words = String(data?.title ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) fail('title', `"${data?.title ?? ''}" has ${words.length} words; give 2 to 4 words for the Artifact page title`);
  const { min, max, lead } = data.axis ?? {};
  if (![min, max, lead].every(isNumber) || min >= max || lead < 0) fail('axis', 'needs numbers {min, max, lead} with min < max and lead >= 0 (min/max in ms, lead in seconds)');
  if (-min > lead * 1000) fail('axis.min', `${min} ms reaches before the clip starts; with lead ${lead} s the earliest playable time is ${-lead * 1000} ms`);
  if (!Array.isArray(data.kinds) || !data.kinds.length) fail('kinds', 'must be a non-empty array of {id, label, color, dark?}');
  const kinds = new Set();
  data.kinds.forEach((k, i) => {
    if (!isText(k?.id) || !isText(k.label) || !isText(k.color)) fail(`kinds[${i}]`, 'needs id, label and color');
    kinds.add(k.id);
  });
  if (!Array.isArray(data.conditions) || !data.conditions.length) fail('conditions', 'must be a non-empty array of {id, title, desc?, delays?}');
  const conditions = new Set();
  data.conditions.forEach((c, i) => {
    if (!isText(c?.id) || !isText(c.title)) fail(`conditions[${i}]`, 'needs id and title');
    (c.delays ?? []).forEach((d, j) => { if (!isText(d?.target) || !isNumber(d.ms)) fail(`conditions[${i}].delays[${j}]`, 'needs {target, ms}'); });
    conditions.add(c.id);
  });
  if (!Array.isArray(data.takes) || !data.takes.length) fail('takes', 'must be a non-empty array');
  const ids = new Set();
  data.takes.forEach((tk, i) => {
    const where = `takes[${i}]${tk?.id ? ` (${tk.id})` : ''}`;
    if (!isText(tk?.id) || ids.has(tk.id)) fail(where, 'needs a unique id');
    ids.add(tk.id);
    if (!conditions.has(tk.condition)) fail(where, `condition "${tk.condition}" is not in conditions`);
    if (!isText(tk.build) || !isText(tk.src)) fail(where, 'needs build and src');
    if (tk.fps !== undefined && !(isNumber(tk.fps) && tk.fps > 0)) fail(where, 'fps must be a positive number');
    if (tk.aspect !== undefined && !/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(tk.aspect)) fail(where, 'aspect must look like "540/1200"');
    if (!Array.isArray(tk.events)) fail(where, 'events must be an array');
    tk.events.forEach((e, j) => {
      if (!isNumber(e?.t) || !kinds.has(e.kind) || !isText(e.text)) fail(`${where}.events[${j}]`, `needs t (ms), a kind from kinds, and text`);
      if (e.t < min || e.t > max) fail(`${where}.events[${j}]`, `t ${e.t} is outside axis ${min}..${max}`);
      if (e.end !== undefined && e.end !== null && !(isNumber(e.end) && e.end > e.t && e.end <= max)) fail(`${where}.events[${j}]`, `end ${e.end} must be after t ${e.t} and within the axis`);
    });
  });
  if (data.notes !== undefined && !(Array.isArray(data.notes) && data.notes.every(n => typeof n === 'string'))) fail('notes', 'must be an array of strings');
  return data;
}

function clipSource(raw, baseDir, outputDir) {
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) throw new Error(`clip path must be relative: ${raw}`);
  const source = path.resolve(baseDir, raw);
  const relative = path.relative(outputDir, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Clip "${raw}" at ${source} is outside output directory ${outputDir}; put the clips beside index.html.`);
  }
  return { src: relative.split(path.sep).join('/'), source };
}

export async function buildPlayer(takesPath, outputPath) {
  const data = validate(JSON.parse(await readFile(takesPath, 'utf8')));
  const baseDir = path.dirname(path.resolve(takesPath));
  const outputDir = path.dirname(path.resolve(outputPath));
  const files = [];
  for (const tk of data.takes) {
    const clip = clipSource(tk.src, baseDir, outputDir);
    await access(clip.source).catch(() => { throw new Error(`take ${tk.id}: clip ${clip.source} does not exist`); });
    tk.src = clip.src;
    if (!files.some(file => file.src === clip.src)) files.push(clip);
  }
  // `<` is escaped so no string in the data can close the <script> it sits in.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  const title = data.title.trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const html = (await readFile(template, 'utf8')).replace('__TITLE__', () => title).replace('__TAKES_JSON__', () => json);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  const warnings = data.takes.filter(tk => !tk.fps).map(tk => `WARN ${tk.id} has no fps, so the page shows no reading error for it`);
  return { html, files, warnings };
}

async function selftest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sync-video-selftest-'));
  try {
    const example = JSON.parse(await readFile(new URL('../example/takes.json', import.meta.url), 'utf8'));
    await writeFile(path.join(root, 'asis-normal.mp4'), '');
    await writeFile(path.join(root, 'tobe-normal.mp4'), '');
    await writeFile(path.join(root, 'takes.json'), JSON.stringify(example));
    const built = await buildPlayer(path.join(root, 'takes.json'), path.join(root, 'index.html'));
    // Catches a clip shared by two takes being listed twice in the Artifact files map.
    assert.deepEqual(built.files.map(file => file.src), ['asis-normal.mp4', 'tobe-normal.mp4']);
    // Catches a template placeholder left unfilled.
    assert.doesNotMatch(built.html, /__TAKES_JSON__|__TITLE__/);
    // Catches event text closing the data <script> early.
    const hostile = { ...example, notes: ['</script><script>alert(1)</script>'] };
    await writeFile(path.join(root, 'hostile.json'), JSON.stringify(hostile));
    const safe = await buildPlayer(path.join(root, 'hostile.json'), path.join(root, 'hostile.html'));
    assert.equal(safe.html.split('</script>').length, built.html.split('</script>').length);
    // Catches an event placed off the axis, which would draw outside its lane.
    const off = structuredClone(example);
    off.takes[0].events[0].t = 99999;
    await writeFile(path.join(root, 'off.json'), JSON.stringify(off));
    await assert.rejects(buildPlayer(path.join(root, 'off.json'), path.join(root, 'off.html')), /outside axis/);
    console.log('selftest ok: files map + filled template + script-safe data + axis bounds');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseCliArgs({ takes: { type: 'string' }, out: { type: 'string' }, selftest: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } });
  if (values.help) return void process.stdout.write(`${usage}\n`);
  if (values.selftest) return selftest();
  if (!values.takes || !values.out) throw new UsageError('--takes and --out are required');
  const { files, warnings } = await buildPlayer(values.takes, values.out);
  for (const file of files) console.log(`${file.src}\t${file.source}`);
  for (const line of warnings) console.log(line);
}

run('build-player', usage, main);
