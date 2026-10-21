#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { duplicateKey, renderGallery } from './lib/render.mjs';
import { loadReview } from './lib/review.mjs';
import { decodePng, encodePng } from './lib/png.mjs';
import { changedPixelFraction, findChangedRegions } from './lib/pixeldiff.mjs';
import { composeContactSheets } from './lib/image.mjs';
import { editReview } from './lib/edits.mjs';
import { parseCliArgs, run, UsageError } from '../../artificier-comparison/scripts/lib/cli.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const usage = `Usage:
  node scripts/build-gallery.mjs --review <path/review.json> --out <path/index.html> [--title <str>] [--dup-threshold <fraction>]
  node scripts/build-gallery.mjs --selftest
  node scripts/build-gallery.mjs --help`;

const defaultDupThreshold = 0.01;

async function fractionOrNull(a, b) {
  try {
    return await changedPixelFraction(a, b);
  } catch {
    return null;
  }
}

async function findNearDuplicates(review, reviewDir, threshold) {
  const found = [];
  for (const concern of review.concerns) {
    const names = [...new Set(concern.states.flatMap(state => state.platforms.map(platform => platform.name)))];
    for (const name of names) {
      const entries = concern.states.flatMap(state => state.platforms.filter(platform => platform.name === name).map(platform => ({ state, platform })));
      for (const side of ['tobe', 'asis']) {
        const shot = entries.filter(entry => entry.platform[side]);
        for (let i = 0; i < shot.length; i++) for (let j = i + 1; j < shot.length; j++) {
          const fraction = await fractionOrNull(path.resolve(reviewDir, shot[i].platform[side]), path.resolve(reviewDir, shot[j].platform[side]));
          if (fraction !== null && fraction < threshold) {
            found.push({ concern: concern.id, platform: name, a: shot[i].state.id, b: shot[j].state.id, side, fraction });
          }
        }
      }
    }
  }
  return found;
}

function duplicateBadges(duplicates) {
  const badges = new Map();
  const add = (stateId, platform, other, side) => {
    const key = duplicateKey(stateId, platform);
    badges.set(key, [...(badges.get(key) || []), { other, side }]);
  };
  for (const item of duplicates) {
    add(item.a, item.platform, item.b, item.side);
    add(item.b, item.platform, item.a, item.side);
  }
  return badges;
}

async function decodeOrNull(file) {
  try {
    return await decodePng(file);
  } catch {
    return null;
  }
}

async function contactRows(review, reviewDir) {
  const rows = [];
  for (const concern of review.concerns) for (const state of concern.states) {
    const figma = state.figmaShot ? await decodeOrNull(path.resolve(reviewDir, state.figmaShot)) : null;
    for (const platform of state.platforms) {
      const side = platform.tobe ? 'tobe' : 'asis';
      const shot = platform[side] ? await decodeOrNull(path.resolve(reviewDir, platform[side])) : null;
      rows.push({
        label: `${state.id} ${platform.name} ${side}`,
        cells: [
          { image: figma, missing: state.figmaShot ? 'UNREADABLE' : 'NO FIGMA' },
          { image: shot, missing: platform[side] ? 'UNREADABLE' : 'MISSING' },
        ],
      });
    }
  }
  return rows;
}

async function writeContactSheets(review, reviewDir, outputDir) {
  for (const name of await readdir(outputDir)) {
    if (/^contact-sheet-\d+\.png$/.test(name)) await rm(path.join(outputDir, name));
  }
  const sheets = composeContactSheets(await contactRows(review, reviewDir));
  const written = [];
  for (const [index, sheet] of sheets.entries()) {
    const file = path.join(outputDir, `contact-sheet-${index + 1}.png`);
    await writeFile(file, encodePng(sheet.width, sheet.height, 3, sheet.pixels));
    written.push(file);
  }
  return written;
}

async function buildToFile(reviewPath, outputPath, title, dupThreshold = defaultDupThreshold) {
  const review = await loadReview(reviewPath);
  const reviewDir = path.dirname(path.resolve(reviewPath));
  const outputDir = path.dirname(path.resolve(outputPath));
  const duplicates = await findNearDuplicates(review, reviewDir, dupThreshold);
  const result = await renderGallery(review, reviewPath, outputPath, title, duplicateBadges(duplicates));
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, result.html, 'utf8');
  const sheets = await writeContactSheets(review, reviewDir, outputDir);
  return { ...result, duplicates, sheets };
}

async function selftest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'design-review-selftest-'));
  try {
    const width = 30, height = 60, channels = 4;
    const asis = new Uint8Array(width * height * channels);
    const tobe = new Uint8Array(width * height * channels);
    for (let i = 0; i < asis.length; i += channels) {
      asis.set([40, 40, 40, 255], i);
      tobe.set([40, 40, 40, 255], i);
    }
    for (let y = 9; y < 15; y++) for (let x = 6; x < 12; x++) {
      const i = (y * width + x) * channels;
      tobe.set([240, 240, 240, 255], i);
    }
    await writeFile(path.join(root, 'asis.png'), encodePng(width, height, channels, asis));
    await writeFile(path.join(root, 'tobe.png'), encodePng(width, height, channels, tobe));
    const reviewData = {
      figma: { url: 'https://www.figma.com/design/KEY/file', fileKey: 'KEY' }, repo: 'sample-app',
      base: { branch: 'main', sha: 'abc1234' }, tobe: { branch: 'work', sha: 'def5678', dirty: true },
      concerns: [{ id: 'c1', name: '화면', nodeId: '1:2', notes: [], states: [{
        id: 's1', name: '기본', nodeId: '1:3', notes: [], frame: { w: 10, h: 20 }, figmaShot: 'asis.png',
        platforms: [{ name: 'ios', width: 10, asis: 'asis.png', tobe: 'tobe.png', status: 'captured' }],
      }] }],
      boxes: [{ id: 'DR-007', kind: 'fix', state: 's1', platform: 'ios', rect: { x: 1, y: 2, w: 3, h: 4 },
        node: { id: '1:4', name: 'Button' }, property: 'padding', asis: '12', answer: '16', files: [], batch: 1,
        status: 'resolved', commit: 'abc123456', note: '' }],
    };
    await writeFile(path.join(root, 'review.json'), JSON.stringify(reviewData));
    const built = await buildToFile(path.join(root, 'review.json'), path.join(root, 'index.html'));
    const placement = built.html.match(/style="left:([^;]+);top:([^;]+);width:([^;]+);height:([^;"]+)"/);
    // Catches box outlines drifting when screenshots use device pixels and boxes use logical units.
    assert.deepEqual(placement?.slice(1), ['10%', '10%', '30%', '20%']);
    // Catches device-pixel changes splitting one logical diff block into misplaced regions.
    const regions = await findChangedRegions(path.join(root, 'asis.png'), path.join(root, 'tobe.png'), 10, { threshold: 16, minArea: 1, merge: 0 });
    assert.deepEqual(regions, [{ x: 2, y: 3, w: 2, h: 2 }]);
    const batchReviewPath = path.join(root, 'batch-review.json');
    const fixedAndOpen = { ...reviewData, boxes: [{ ...reviewData.boxes[0], status: 'fixed', commit: null, files: ['src/shared.js'], batch: 1 }, { ...reviewData.boxes[0], id: 'DR-008', status: 'open', commit: null, files: ['src/shared.js'], batch: null }] };
    await writeFile(batchReviewPath, JSON.stringify(fixedAndOpen));
    const batchPlan = JSON.parse(await editReview(batchReviewPath, 'batches', {}));
    // Catches fix or unintended boxes being left out of the exclusion union (each alone covers under 90%).
    const excludedByFixUnion = await findChangedRegions(path.join(root, 'asis.png'), path.join(root, 'tobe.png'), 10, {
      threshold: 16, minArea: 1, merge: 0, state: 's1', platform: 'ios',
      excludeBoxes: [
        { kind: 'fix', state: 's1', platform: 'ios', rect: { x: 2, y: 3, w: 1.2, h: 2 } },
        { kind: 'unintended', state: 's1', platform: 'ios', rect: { x: 3.1, y: 3, w: 0.9, h: 2 } },
      ],
    });
    assert.deepEqual(excludedByFixUnion, []);
    // Catches overlapping box areas being added instead of measuring their union below 90%.
    const retainedBelowUnionThreshold = await findChangedRegions(path.join(root, 'asis.png'), path.join(root, 'tobe.png'), 10, {
      threshold: 16, minArea: 1, merge: 0, state: 's1', platform: 'ios',
      excludeBoxes: [
        { kind: 'fix', state: 's1', platform: 'ios', rect: { x: 2, y: 3, w: 1.2, h: 2 } },
        { kind: 'unintended', state: 's1', platform: 'ios', rect: { x: 2.7, y: 3, w: 0.9, h: 2 } },
      ],
    });
    assert.deepEqual(retainedBelowUnionThreshold, [{ x: 2, y: 3, w: 2, h: 2 }]);
    // Catches a fixed box's file failing to block an open box from the next batch.
    assert.deepEqual(batchPlan.boxes, []);
    // Catches two states captured as the same screen slipping past the near-duplicate detector.
    await writeFile(path.join(root, 'tobe-copy.png'), encodePng(width, height, channels, tobe));
    const twinReview = { ...reviewData, concerns: [{ ...reviewData.concerns[0], states: [
      reviewData.concerns[0].states[0],
      { ...reviewData.concerns[0].states[0], id: 's2', platforms: [{ ...reviewData.concerns[0].states[0].platforms[0], tobe: 'tobe-copy.png' }] },
    ] }], boxes: [] };
    await writeFile(path.join(root, 'twin-review.json'), JSON.stringify(twinReview));
    const twin = await buildToFile(path.join(root, 'twin-review.json'), path.join(root, 'twin.html'));
    assert.deepEqual(twin.duplicates.map(item => [item.a, item.b, item.side]), [['s1', 's2', 'tobe'], ['s1', 's2', 'asis']]);
    assert.match(twin.html, /looks identical to s2/);
    // Catches the detector flagging two clearly different captures as duplicates.
    const distinctReview = { ...twinReview, concerns: [{ ...twinReview.concerns[0], states: twinReview.concerns[0].states.map((state, i) => ({
      ...state, platforms: [{ ...state.platforms[0], asis: null, tobe: i ? 'asis.png' : 'tobe.png' }] })) }] };
    await writeFile(path.join(root, 'distinct-review.json'), JSON.stringify(distinctReview));
    const distinct = await buildToFile(path.join(root, 'distinct-review.json'), path.join(root, 'distinct.html'));
    assert.deepEqual(distinct.duplicates, []);
    // Catches a contact sheet exceeding the 1568 px long edge an image Read accepts.
    const big = new Uint8Array(900 * 2000 * 3).fill(200);
    await writeFile(path.join(root, 'big.png'), encodePng(900, 2000, 3, big));
    const bigStates = Array.from({ length: 5 }, (_, i) => ({ ...reviewData.concerns[0].states[0], id: `b${i}`, figmaShot: 'big.png',
      platforms: [{ ...reviewData.concerns[0].states[0].platforms[0], asis: 'big.png', tobe: i % 2 ? null : 'big.png' }] }));
    await writeFile(path.join(root, 'big-review.json'), JSON.stringify({ ...reviewData, concerns: [{ ...reviewData.concerns[0], states: bigStates }], boxes: [] }));
    const bigBuild = await buildToFile(path.join(root, 'big-review.json'), path.join(root, 'big.html'));
    assert.ok(bigBuild.sheets.length > 1);
    for (const sheet of bigBuild.sheets) {
      const decoded = await decodePng(sheet);
      assert.ok(Math.max(decoded.width, decoded.height) <= 1568, `${sheet} is ${decoded.width}x${decoded.height}`);
    }
    console.log('selftest ok: placement + pixel-diff regions + fixed-file batching + near-duplicates + contact-sheet size');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseCliArgs({
    review: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' }, 'dup-threshold': { type: 'string' },
    selftest: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (values.selftest) return selftest();
  if (!values.review || !values.out) throw new UsageError('--review and --out are required');
  const dupThreshold = values['dup-threshold'] === undefined ? defaultDupThreshold : Number(values['dup-threshold']);
  if (!(dupThreshold >= 0 && dupThreshold <= 1)) throw new UsageError(`--dup-threshold must be a fraction between 0 and 1; received ${values['dup-threshold']}`);
  const result = await buildToFile(values.review, values.out, values.title, dupThreshold);
  for (const file of result.files) console.log(`${file.src}\t${file.source}`);
  for (const item of result.duplicates) console.log(`WARN near-duplicate ${item.concern} ${item.platform} ${item.a} ${item.b} ${item.side} ${item.fraction.toFixed(4)}`);
  for (const sheet of result.sheets) console.log(`CONTACT ${sheet}`);
}

run('build-gallery', usage, main);
