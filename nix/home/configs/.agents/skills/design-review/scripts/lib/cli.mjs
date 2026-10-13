import { parseArgs as parseNodeArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message, action = 'main') {
    super(message);
    this.action = action;
  }
}

export function parseCliArgs(options, args = process.argv.slice(2), action = 'main') {
  try {
    return parseNodeArgs({ args, options, allowPositionals: false });
  } catch (error) {
    throw new UsageError(error.message, action);
  }
}

export async function run(name, usage, main) {
  try {
    await main();
  } catch (error) {
    console.error(`${name}: ${error.message}`);
    if (error instanceof UsageError) {
      console.error(typeof usage === 'function' ? usage(error.action) : usage);
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  }
}
