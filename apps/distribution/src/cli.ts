#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, run } from './command.js';
import { DistributionError } from './files.js';
import { NATIVE_HELP, runNative } from './native-command.js';

// The internal compatibility export is inert; only an explicit process entry dispatches a command.
function entry(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  if (resolve(invoked) === self) return true;
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
if (entry()) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(HELP + '\n' + NATIVE_HELP);
    else {
      const argv = process.argv.slice(2),
        result = (await runNative(argv)) ?? run(argv);
      process.stdout.write(JSON.stringify(result.result) + '\n');
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^IA-(?:DIST|DB|RESOURCE|PROJECTION)-[A-Z-]+$/.test(error.code)
        ? error.code
        : 'IA-DIST-INPUT-INVALID';
    process.stderr.write(
      JSON.stringify({
        status: 'refused',
        code: error instanceof DistributionError ? error.code : code,
        message: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
