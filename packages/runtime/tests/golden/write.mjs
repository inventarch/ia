// Regenerates the position golden bodies and the golden packet in this directory from the current code (runtime SPEC
// R15, R19). Run it explicitly, `node packages/runtime/tests/golden/write.mjs`, then review the diff with the change that
// makes it: the golden cases of tests/position.test.ts and tests/packet.test.ts write their output instead of comparing
// it only under IA_POSITION_GOLDEN=write, which nothing else sets.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../../', import.meta.url)),
  vitest = resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const run = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    'vitest.config.mts',
    'tests/position.test.ts',
    'tests/packet.test.ts',
    '-t',
    'matches the golden (bodies|packet)',
  ],
  { cwd: runtime, stdio: 'inherit', env: { ...process.env, IA_POSITION_GOLDEN: 'write' } },
);
process.exit(run.status ?? 1);
