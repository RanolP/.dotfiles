#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { renderGallery } from './lib/render.mjs';
import { loadReview } from './lib/review.mjs';
import { encodePng } from './lib/png.mjs';
import { findChangedRegions } from './lib/pixeldiff.mjs';
import { editReview } from './lib/edits.mjs';
import { parseCliArgs, run, UsageError } from './lib/cli.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const usage = `Usage:
  node scripts/build-gallery.mjs --review <path/review.json> --out <path/index.html> [--title <str>]
  node scripts/build-gallery.mjs --selftest
  node scripts/build-gallery.mjs --help`;

async function buildToFile(reviewPath, outputPath, title) {
  const review = await loadReview(reviewPath);
  const result = await renderGallery(review, reviewPath, outputPath, title);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, result.html, 'utf8');
  return result;
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
    console.log('selftest ok: placement + pixel-diff regions + fixed-file batching');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseCliArgs({
    review: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' }, selftest: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (values.selftest) return selftest();
  if (!values.review || !values.out) throw new UsageError('--review and --out are required');
  const result = await buildToFile(values.review, values.out, values.title);
  for (const file of result.files) console.log(`${file.src}\t${file.source}`);
}

run('build-gallery', usage, main);
