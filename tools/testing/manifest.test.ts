import '../temp/physical-temp.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { readManifest } from './manifest.js';

const root = resolve(import.meta.dirname, '../..'),
  roots: string[] = [];
const valid = () => JSON.parse(readFileSync(resolve(root, 'tools/testing/tasks.json'), 'utf8'));
function fixture(value: unknown) {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-manifest-'));
  roots.push(directory);
  mkdirSync(resolve(directory, 'tools/testing'), { recursive: true });
  writeFileSync(resolve(directory, 'tools/testing/tasks.json'), JSON.stringify(value));
  return directory;
}
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (dirname(path) !== resolve(tmpdir())) throw Error('Unsafe manifest fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

it('declares its identity as the plain format and formatVersion, never schemaVersion', () => {
  const manifest = valid();
  expect(manifest.format).toBe('test-tasks');
  expect(manifest.formatVersion).toBe(1);
  expect(manifest).not.toHaveProperty('schemaVersion');
});
it.each([
  [
    'the old schemaVersion shape',
    (m: Record<string, unknown>) => {
      delete m['format'];
      delete m['formatVersion'];
      m['schemaVersion'] = 1;
    },
  ],
  [
    'another format',
    (m: Record<string, unknown>) => {
      m['format'] = 'ia.test-tasks.v1';
    },
  ],
  [
    'another version',
    (m: Record<string, unknown>) => {
      m['formatVersion'] = 2;
    },
  ],
  [
    'a missing version',
    (m: Record<string, unknown>) => {
      delete m['formatVersion'];
    },
  ],
])('private test-tasks manifest refuses %s', (_name, mutate) => {
  const value = valid();
  mutate(value);
  expect(() => readManifest(fixture(value))).toThrow();
});
it('reads a valid manifest unchanged', () => expect(readManifest(fixture(valid()))).toEqual(valid()));
it.each([
  'null',
  'tasks-object',
  'null-task',
  'platform-string',
  'cache-string',
  'bad-kind',
  'bad-profile',
  'cycle',
  'extra',
])('refuses malformed execution manifest before planning: %s', (kind) => {
  let value = valid();
  if (kind === 'null') value = null;
  else if (kind === 'tasks-object') value.tasks = {};
  else if (kind === 'null-task') value.tasks[0] = null;
  else if (kind === 'platform-string') value.tasks[0].platforms = 'windows';
  else if (kind === 'cache-string') value.tasks[0].cache = 'false';
  else if (kind === 'bad-kind') value.tasks[0].kind = 'shell';
  else if (kind === 'bad-profile') value.tasks[0].profile = 'missing';
  else if (kind === 'cycle') value.tasks[0].dependsOn = [value.tasks[0].id];
  else value.tasks[0].surprise = 'silently ignored';
  expect(() => readManifest(fixture(value))).toThrow();
});

it('loads manifest parsing alone in a source-only fixture with no inventory, compiler or package modules', () => {
  const directory = fixture(valid());
  cpSync(resolve(root, 'tools/testing/manifest.ts'), resolve(directory, 'tools/testing/manifest.ts'));
  const entry = resolve(directory, 'probe.mts');
  writeFileSync(
    entry,
    "import {readManifest} from './tools/testing/manifest.ts'; console.log(String(readManifest(process.cwd()).formatVersion));\n",
  );
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href, entry],
    { cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('1');
});

it.each(['inventory.ts', 'plan.ts', 'report.ts'])(
  'refuses repeated or missing options before evaluation: %s',
  (script) => {
    const args =
      script === 'inventory.ts'
        ? ['--json', '--json']
        : script === 'plan.ts'
          ? ['--platform', 'windows', '--shards']
          : ['--evidence'];
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/testing/' + script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(2);
  },
);
