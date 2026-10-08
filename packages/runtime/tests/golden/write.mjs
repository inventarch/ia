// Regenerates the position golden bodies in this directory from the current code (runtime SPEC R15). Run it
// explicitly, `node packages/runtime/tests/golden/write.mjs`, then review the diff with the change that makes it:
// the golden case of tests/position.test.ts writes its bodies instead of comparing them only under
// IA_POSITION_GOLDEN=write, which nothing else sets.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../../', import.meta.url)),
  vitest = resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const run = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', 'vitest.config.mts', 'tests/position.test.ts', '-t', 'matches the golden bodies'],
  { cwd: runtime, stdio: 'inherit', env: { ...process.env, IA_POSITION_GOLDEN: 'write' } },
);
process.exit(run.status ?? 1);
