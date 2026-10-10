/** Subprocess fixture: terminate after the filesystem mutation, before its journal cursor advances. */
import { applyMigration, collectMigration } from '../src/init.js';
import { resolve } from 'node:path';
import { writeSync } from 'node:fs';
const root = process.argv[2]!;
const cut = process.argv[3]!;
const packageRoot = resolve(import.meta.dirname, '..');
await applyMigration(collectMigration({ root, packageRoot }), {
  packageRoot,
  checkpoint: (name) => {
    if (name === cut || (cut.startsWith('migrate:mutation:') && name.startsWith(`${cut}:`))) {
      writeSync(1, JSON.stringify({ pid: process.pid, checkpoint: name }) + '\n');
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
throw new Error('Kill checkpoint was not reached');
