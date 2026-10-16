/**
 * A change one test makes to an entry between two of a reader's own calls in another process. `steps` run once, each an
 * `fs` function name and its arguments: just before the process opens `target` (`at: 'open'`), just after its first read
 * through a descriptor opened on it (`at: 'read'`), or just before it lists `target` as a directory (`at: 'list'`);
 * `failed` steps run once just after an open of `target` fails. `linked` lists the named entries of a directory as links
 * whatever they are, as Windows lists every reparse point.
 */
export interface Race {
  readonly target?: string;
  readonly at?: 'open' | 'read' | 'list';
  readonly steps?: readonly (readonly unknown[])[];
  readonly failed?: readonly (readonly unknown[])[];
  readonly linked?: { readonly directory: string; readonly names: readonly string[] };
}
/**
 * The preload (`node --import <file>`) that performs a race passed as JSON in IA_TEST_RACE. It patches `fs` and syncs the
 * built-in module's named exports, so a reader's own `openSync`, `readSync` and `readdirSync` reach it with no timing
 * involved; every other path behaves exactly as usual.
 */
export const RACE_PRELOAD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const plan = JSON.parse(process.env.IA_TEST_RACE), { openSync, readSync, closeSync, readdirSync } = fs, opened = new Set();
const run = (steps = []) => {
  for (const [step, ...args] of steps.splice(0)) fs[step](...args);
};
const link = (entry) => ({
  name: entry.name,
  parentPath: entry.parentPath,
  path: entry.path,
  isSymbolicLink: () => true,
  isDirectory: () => false,
  isFile: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
});
fs.openSync = function (path, ...rest) {
  const target = String(path) === plan.target;
  if (target && plan.at === 'open') run(plan.steps);
  let fd;
  try {
    fd = openSync.call(this, path, ...rest);
  } catch (error) {
    if (target) run(plan.failed);
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
fs.readdirSync = function (path, ...rest) {
  const directory = String(path);
  if (directory === plan.target && plan.at === 'list') run(plan.steps);
  const entries = readdirSync.call(this, path, ...rest);
  if (plan.linked?.directory !== directory) return entries;
  return entries.map((entry) =>
    typeof entry === 'object' && plan.linked.names.includes(entry.name) ? link(entry) : entry,
  );
};
syncBuiltinESMExports();
`;
