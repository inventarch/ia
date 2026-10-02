import { appendFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

const selected = tmpdir(),
  environment = process.env.GITHUB_ENV;
if (!isAbsolute(selected) || !environment || !isAbsolute(environment))
  throw new Error('Expected absolute runner temp and environment paths');
const physical = realpathSync.native(selected),
  before = statSync(physical);
if (!before.isDirectory() || /[\r\n\0]/.test(physical)) throw new Error('Expected one physical temporary directory');
const checked = realpathSync.native(selected),
  after = statSync(checked);
if (checked !== physical || before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory())
  throw new Error('Runner temporary directory changed during selection');
// GITHUB_ENV is consumed by following steps. Preserve the runner's existing entries.
appendFileSync(environment, `TEMP=${physical}\nTMP=${physical}\n`, { encoding: 'utf8' });
console.log(`Selected physical runner temporary directory: ${physical}`);
