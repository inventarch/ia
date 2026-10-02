/**
 * Child process for tests/init.test.ts: runs `ia init --apply`'s sequence and exits hard at one checkpoint.
 *
 * `process.exit` inside an `applyInstallation` checkpoint ends the process without unwinding the stack, so the
 * installer's `finally` never releases its lock and every file it wrote stays exactly as a killed process leaves it.
 * Arguments: <checkpoint name> <target root> <@ia/cli package root>. Exit 86 means the kill happened.
 */
import { applyInit, collectInit, gitIn } from '../src/init.js';

const [at, root, packageRoot] = process.argv.slice(2);
if (at === undefined || root === undefined || packageRoot === undefined)
  throw new Error('Usage: init-kill.ts <checkpoint> <root> <package root>');
await applyInit(collectInit({ root, host: 'none', packageRoot, git: gitIn(root, {}) }), {
  packageRoot,
  checkpoint: (name) => {
    if (name === at) process.exit(86);
  },
});
process.exit(0);
