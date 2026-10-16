/**
 * A change one test makes to a file between two of a reader's own calls in another process: `steps` run once, each an
 * `fs` function name and its arguments, just before the process opens `target` (`at: 'open'`) or just after its first
 * read through a descriptor opened on it (`at: 'read'`); `failed` steps run once just after an open of `target` fails.
 */
export interface Race {
  readonly at: 'open' | 'read';
  readonly steps: readonly (readonly unknown[])[];
  readonly failed?: readonly (readonly unknown[])[];
}
/**
 * The preload (`node --import <file>`) that performs a race passed as JSON in IA_TEST_RACE, with `target` added. It
 * patches `fs` and syncs the built-in module's named exports, so a reader's own `openSync` and `readSync` reach it with no
 * timing involved; every other path behaves exactly as usual.
 */
export const RACE_PRELOAD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const plan = JSON.parse(process.env.IA_TEST_RACE), { openSync, readSync, closeSync } = fs, opened = new Set();
const run = (steps) => {
  for (const [step, ...args] of steps.splice(0)) fs[step](...args);
};
fs.openSync = function (path, ...rest) {
  const target = String(path) === plan.target;
  if (target && plan.at === 'open') run(plan.steps);
  let fd;
  try {
    fd = openSync.call(this, path, ...rest);
  } catch (error) {
    if (target) run(plan.failed ?? []);
    throw error;
  }
  if (target) opened.add(fd);
  return fd;
};
fs.readSync = function (fd, ...rest) {
  const read = readSync.call(this, fd, ...rest);
  if (opened.has(fd) && plan.at === 'read') run(plan.steps);
  return read;
};
fs.closeSync = function (fd) {
  opened.delete(fd);
  return closeSync.call(this, fd);
};
syncBuiltinESMExports();
`;
