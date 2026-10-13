#!/usr/bin/env node
import { editReview } from './lib/edits.mjs';
import { parseCliArgs, run, UsageError } from './lib/cli.mjs';

const usages = {
  main: `Usage:
  node scripts/review-edit.mjs <union|add|status|batches|set|platform|meta> --review <path/review.json> [options]
  node scripts/review-edit.mjs --help [<subcommand>]

Subcommands:
  union     --review <path/review.json> --id <DR-###> [--asis <x,y,w,h>] [--tobe <x,y,w,h>]
  add       --review <path/review.json> --kind <fix|unintended> --state <id> --platform <name> --rect <x,y,w,h> [--node-id <id>] [--node-name <name>] [--property <text>] [--asis <text>] [--answer <text>] [--files <a,b>] [--batch <n>] [--note <text>]
  status    --review <path/review.json> --id <DR-###> --to <open|fixed|resolved|accepted> [--commit <sha>]
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
  node scripts/review-edit.mjs status --review <path/review.json> --id <DR-###> --to <open|fixed|resolved|accepted> [--commit <sha>]
  node scripts/review-edit.mjs status --help`,
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
  status: { id: { type: 'string' }, to: { type: 'string' }, commit: { type: 'string' } },
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new UsageError('subcommand is required', 'main');
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
