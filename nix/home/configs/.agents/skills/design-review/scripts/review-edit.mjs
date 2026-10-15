#!/usr/bin/env node
import { editReview } from './lib/edits.mjs';
import { parseCliArgs, run, UsageError } from './lib/cli.mjs';
import { encodePng } from './lib/png.mjs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const usages = {
  main: `Usage:
  node scripts/review-edit.mjs <union|add|status|batches|set|platform|meta> --review <path/review.json> [options]
  node scripts/review-edit.mjs --help [<subcommand>]
  node scripts/review-edit.mjs --selftest

Subcommands:
  union     --review <path/review.json> --id <DR-###> [--asis <x,y,w,h>] [--tobe <x,y,w,h>]
  add       --review <path/review.json> --kind <fix|unintended> --state <id> --platform <name> --rect <x,y,w,h> [--node-id <id>] [--node-name <name>] [--property <text>] [--asis <text>] [--answer <text>] [--files <a,b>] [--batch <n>] [--note <text>]
  status    --review <path/review.json> --id <DR-###> --to <open|fixed|resolved|accepted> [--commit <sha>] [--no-photo-reason <text>]
  batches   --review <path/review.json> [--write]
  set       --review <path/review.json> --id <DR-###> [--batch <n>] [--files <a,b>] [--note <text>]
  platform  --review <path/review.json> --state <id> --name <platform> [--tobe <path>] [--asis <path>] [--status <captured|missing>] [--reason <text>]
  meta      --review <path/review.json> [--figma-url <url>] [--figma-file-key <key>] [--repo <name>] [--base-branch <name>] [--base-sha <sha>] [--tobe-branch <name>] [--tobe-sha <sha>] [--tobe-dirty <true|false>]`,
  union: `Usage:
  node scripts/review-edit.mjs union --review <path/review.json> --id <DR-###> [--asis <x,y,w,h>] [--tobe <x,y,w,h>]
  node scripts/review-edit.mjs union --help`,
  add: `Usage:
  node scripts/review-edit.mjs add --review <path/review.json> --kind <fix|unintended> --state <id> --platform <name> --rect <x,y,w,h> [--node-id <id>] [--node-name <name>] [--property <text>] [--asis <text>] [--answer <text>] [--files <a,b>] [--batch <n>] [--note <text>]
  node scripts/review-edit.mjs add --help`,
  status: `Usage:
  node scripts/review-edit.mjs status --review <path/review.json> --id <DR-###> --to <open|fixed|resolved|accepted> [--commit <sha>] [--no-photo-reason <text>]
  node scripts/review-edit.mjs status --help

  --to fixed stamps fixedAt; --to open clears it.
  --to resolved on a fix box requires the box's state/platform to have a to-be photo
  whose file is at least as new as fixedAt; --no-photo-reason <text> bypasses that
  check and records the reason on the box.`,
  batches: `Usage:
  node scripts/review-edit.mjs batches --review <path/review.json> [--write]
  node scripts/review-edit.mjs batches --help`,
  set: `Usage:
  node scripts/review-edit.mjs set --review <path/review.json> --id <DR-###> [--batch <n>] [--files <a,b>] [--note <text>]
  node scripts/review-edit.mjs set --help`,
  platform: `Usage:
  node scripts/review-edit.mjs platform --review <path/review.json> --state <id> --name <platform> [--tobe <path>] [--asis <path>] [--status <captured|missing>] [--reason <text>]
  node scripts/review-edit.mjs platform --help`,
  meta: `Usage:
  node scripts/review-edit.mjs meta --review <path/review.json> [--figma-url <url>] [--figma-file-key <key>] [--repo <name>] [--base-branch <name>] [--base-sha <sha>] [--tobe-branch <name>] [--tobe-sha <sha>] [--tobe-dirty <true|false>]
  node scripts/review-edit.mjs meta --help`,
};

const commonOptions = {
  review: { type: 'string' },
  help: { type: 'boolean', default: false },
};
const actionOptions = {
  union: { id: { type: 'string' }, asis: { type: 'string' }, tobe: { type: 'string' } },
  add: {
    kind: { type: 'string' }, state: { type: 'string' }, platform: { type: 'string' }, rect: { type: 'string' },
    'node-id': { type: 'string' }, 'node-name': { type: 'string' }, property: { type: 'string' },
    asis: { type: 'string' }, answer: { type: 'string' }, files: { type: 'string' }, batch: { type: 'string' }, note: { type: 'string' },
  },
  status: { id: { type: 'string' }, to: { type: 'string' }, commit: { type: 'string' }, 'no-photo-reason': { type: 'string' } },
  batches: { write: { type: 'boolean', default: false } },
  set: { id: { type: 'string' }, batch: { type: 'string' }, files: { type: 'string' }, note: { type: 'string' } },
  platform: {
    state: { type: 'string' }, name: { type: 'string' }, tobe: { type: 'string' }, asis: { type: 'string' },
    status: { type: 'string' }, reason: { type: 'string' },
  },
  meta: {
    'figma-url': { type: 'string' }, 'figma-file-key': { type: 'string' }, repo: { type: 'string' },
    'base-branch': { type: 'string' }, 'base-sha': { type: 'string' },
    'tobe-branch': { type: 'string' }, 'tobe-sha': { type: 'string' }, 'tobe-dirty': { type: 'string' },
  },
};

function requireValue(values, key, action) {
  if (!values[key]) throw new UsageError(`--${key} is required`, action);
}

function positiveInteger(value, flag, action) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`--${flag} must be a positive integer; received ${value}`, action);
}

function parseRect(value, flag, action) {
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some(number => !Number.isFinite(number)) || parts[2] <= 0 || parts[3] <= 0) {
    throw new UsageError(`--${flag} "${value}" must be four finite comma-separated numbers x,y,w,h with positive width and height`, action);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function validateInvocation(action, values) {
  requireValue(values, 'review', action);
  if (action === 'union') {
    requireValue(values, 'id', action);
    if (!values.asis && !values.tobe) throw new UsageError('union requires --asis or --tobe', action);
    if (values.asis) values.asisRect = parseRect(values.asis, 'asis', action);
    if (values.tobe) values.tobeRect = parseRect(values.tobe, 'tobe', action);
  } else if (action === 'add') {
    for (const key of ['kind', 'state', 'platform', 'rect']) requireValue(values, key, action);
    if (!['fix', 'unintended'].includes(values.kind)) throw new UsageError(`--kind must be fix or unintended; received ${values.kind}`, action);
    values.rect = parseRect(values.rect, 'rect', action);
    if (values.batch !== undefined) positiveInteger(values.batch, 'batch', action);
  } else if (action === 'status') {
    requireValue(values, 'id', action);
    requireValue(values, 'to', action);
    if (!['open', 'fixed', 'resolved', 'accepted'].includes(values.to)) throw new UsageError(`--to must be open, fixed, resolved, or accepted; received ${values.to}`, action);
    if (values.to === 'resolved' && !values.commit) throw new UsageError('--commit is required with --to resolved', action);
    if (values.to !== 'resolved' && values.commit) throw new UsageError('--commit is only valid with --to resolved', action);
    if (values['no-photo-reason'] !== undefined) {
      if (values.to !== 'resolved') throw new UsageError('--no-photo-reason is only valid with --to resolved', action);
      if (!values['no-photo-reason'].trim()) throw new UsageError('--no-photo-reason must be non-empty text', action);
    }
  } else if (action === 'set') {
    requireValue(values, 'id', action);
    if (values.batch === undefined && values.files === undefined && values.note === undefined) {
      throw new UsageError('set requires at least one of --batch, --files, or --note', action);
    }
    if (values.batch !== undefined) positiveInteger(values.batch, 'batch', action);
  } else if (action === 'platform') {
    requireValue(values, 'state', action);
    requireValue(values, 'name', action);
    if (values.status !== undefined && !['captured', 'missing'].includes(values.status)) {
      throw new UsageError(`--status must be captured or missing; received ${values.status}`, action);
    }
    if (values.status === 'missing' && !values.reason) throw new UsageError('--reason is required with --status missing', action);
  } else if (action === 'meta') {
    const fields = Object.keys(actionOptions.meta);
    if (!fields.some(key => values[key] !== undefined)) throw new UsageError('meta requires at least one review metadata flag', action);
    if (values['tobe-dirty'] !== undefined && !['true', 'false'].includes(values['tobe-dirty'])) {
      throw new UsageError(`--tobe-dirty must be true or false; received ${values['tobe-dirty']}`, action);
    }
  }
}

async function selftest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'design-review-edit-selftest-'));
  try {
    const reviewPath = path.join(root, 'review.json');
    const platform = { name: 'ios', width: 2, asis: null, tobe: null, status: 'captured' };
    const box = { id: 'DR-001', kind: 'fix', state: 's1', platform: 'ios', rect: { x: 0, y: 0, w: 1, h: 1 }, node: { id: '', name: '' },
      property: '', asis: '', answer: '', files: ['a.js'], batch: 1, status: 'open', commit: null, note: '' };
    await writeFile(reviewPath, JSON.stringify({
      figma: { url: 'https://www.figma.com/design/KEY/file', fileKey: 'KEY' }, repo: 'r',
      base: { branch: 'main', sha: 'a' }, tobe: { branch: 'w', sha: 'b', dirty: false },
      concerns: [{ id: 'c1', name: 'c', nodeId: '', notes: [], states: [{ id: 's1', name: 's', nodeId: '', notes: [], frame: { w: 2, h: 2 }, figmaShot: null, platforms: [platform] }] }],
      boxes: [box],
    }));
    const resolve = extra => editReview(reviewPath, 'status', { id: 'DR-001', to: 'resolved', commit: 'abc1234', ...extra });
    const reload = async () => JSON.parse(await readFile(reviewPath, 'utf8')).boxes[0];
    await editReview(reviewPath, 'status', { id: 'DR-001', to: 'fixed' });
    const fixedAt = (await reload()).fixedAt;
    // Catches a fix box closing with zero photos.
    await assert.rejects(resolve(), /DR-001.*s1.*ios.*no to-be photo/);
    const photo = path.join(root, 'tobe.png');
    await writeFile(photo, encodePng(1, 1, 4, new Uint8Array([0, 0, 0, 255])));
    await editReview(reviewPath, 'platform', { state: 's1', name: 'ios', tobe: path.relative(process.cwd(), photo) });
    const stale = new Date(Date.parse(fixedAt) - 60_000);
    await utimes(photo, stale, stale);
    // Catches a box closing on a photo captured before the fix landed.
    await assert.rejects(resolve(), /DR-001.*before the box was marked fixed/);
    // Catches a reason-bypassed resolve leaving no trace on the box.
    await resolve({ 'no-photo-reason': 'simulator down' });
    assert.equal((await reload()).noPhotoReason, 'simulator down');
    await editReview(reviewPath, 'status', { id: 'DR-001', to: 'fixed' });
    const fresh = new Date(Date.now() + 1000);
    await utimes(photo, fresh, fresh);
    // Catches the gate refusing a box whose fresh photo exists, and a stale bypass reason surviving.
    await resolve();
    const resolved = await reload();
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.noPhotoReason, undefined);
    console.log('selftest ok: resolve gate refuses no-photo and stale photo, passes fresh photo and --no-photo-reason');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new UsageError('subcommand is required', 'main');
  if (args.length === 1 && args[0] === '--selftest') return selftest();
  if (args[0] === '--help') {
    if (args.length === 1) {
      process.stdout.write(`${usages.main}\n`);
      return;
    }
    if (args.length === 2 && Object.hasOwn(usages, args[1]) && args[1] !== 'main') {
      process.stdout.write(`${usages[args[1]]}\n`);
      return;
    }
    throw new UsageError(`unknown subcommand for --help: ${args[1]}`, 'main');
  }
  const action = args.shift();
  if (!Object.hasOwn(actionOptions, action)) throw new UsageError(`unknown subcommand: ${action}`, 'main');
  const { values } = parseCliArgs({ ...commonOptions, ...actionOptions[action] }, args, action);
  if (values.help) {
    process.stdout.write(`${usages[action]}\n`);
    return;
  }
  validateInvocation(action, values);
  const result = await editReview(values.review, action, values);
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
}

run('review-edit', action => usages[action] || usages.main, main);
