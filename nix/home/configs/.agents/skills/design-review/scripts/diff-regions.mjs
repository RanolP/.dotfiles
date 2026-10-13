#!/usr/bin/env node
import { findChangedRegions } from './lib/pixeldiff.mjs';
import { loadReview } from './lib/review.mjs';
import { parseCliArgs, run, UsageError } from './lib/cli.mjs';

const usage = `Usage:
  node scripts/diff-regions.mjs --asis <image.png> --tobe <image.png> --width <logical-width> [--threshold <n>] [--min-area <n>] [--merge <n>]
  node scripts/diff-regions.mjs --asis <image.png> --tobe <image.png> --width <logical-width> --exclude-boxes <review.json> --state <id> --platform <name> [--threshold <n>] [--min-area <n>] [--merge <n>]
  node scripts/diff-regions.mjs --help`;

function cliArgs() {
  const raw = process.argv.slice(2);
  const numericOptions = new Set(['--width', '--threshold', '--min-area', '--merge']);
  const negativeNumber = /^-(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const args = [];
  for (let index = 0; index < raw.length; index++) {
    if (numericOptions.has(raw[index]) && negativeNumber.test(raw[index + 1] || '')) {
      args.push(`${raw[index]}=${raw[++index]}`);
    } else {
      args.push(raw[index]);
    }
  }
  return args;
}

async function main() {
  const { values } = parseCliArgs({
      asis: { type: 'string' }, tobe: { type: 'string' }, width: { type: 'string' },
      threshold: { type: 'string', default: '16' }, 'min-area': { type: 'string', default: '16' },
      merge: { type: 'string', default: '8' }, 'exclude-boxes': { type: 'string' },
      state: { type: 'string' }, platform: { type: 'string' }, help: { type: 'boolean', default: false },
  }, cliArgs());
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const key of ['asis', 'tobe', 'width']) if (!values[key]) throw new UsageError(`--${key} is required`);
  const numericFlags = [
    ['width', values.width, value => value > 0, 'a positive finite number'],
    ['threshold', values.threshold, value => value >= 0, 'a finite non-negative number'],
    ['min-area', values['min-area'], value => value >= 0, 'a finite non-negative number'],
    ['merge', values.merge, value => value >= 0, 'a finite non-negative number'],
  ];
  for (const [flag, rawValue, valid, expected] of numericFlags) {
    const value = Number(rawValue);
    if (!rawValue.trim() || !Number.isFinite(value) || !valid(value)) throw new UsageError(`--${flag} must be ${expected}; received ${rawValue}`);
  }
  const exclusionOptions = ['exclude-boxes', 'state', 'platform'];
  const supplied = exclusionOptions.filter(key => values[key] !== undefined);
  if (supplied.length > 0 && supplied.length < exclusionOptions.length) {
    const missing = exclusionOptions.filter(key => values[key] === undefined).map(key => `--${key}`);
    throw new UsageError(`--exclude-boxes, --state, and --platform must be provided together; missing ${missing.join(', ')}`);
  }
  const review = values['exclude-boxes'] ? await loadReview(values['exclude-boxes']) : null;
  if (review && !review.concerns.some(concern => concern.states.some(state =>
    state.id === values.state && state.platforms.some(platform => platform.name === values.platform)))) {
    throw new Error(`No state/platform pair (${values.state}, ${values.platform}) in ${values['exclude-boxes']}; choose a pair listed in that review.json`);
  }
  const regions = await findChangedRegions(values.asis, values.tobe, Number(values.width), {
    threshold: Number(values.threshold), minArea: Number(values['min-area']), merge: Number(values.merge),
    excludeBoxes: review?.boxes, state: values.state, platform: values.platform,
  });
  process.stdout.write(`${JSON.stringify(regions)}\n`);
}

run('diff-regions', usage, main);
