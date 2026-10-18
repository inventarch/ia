import '../temp/physical-temp.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { withScope } from '@tools/testing/resources.js';
import { parseOptions } from './args.mjs';
import { gitText } from './git.mjs';
import { stableVersion, compareVersions } from './semver.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { checkWrite } from './check-write.mjs';
import { containedFile, readRegular } from './paths.mjs';

it.each([
  'kernel/generate.ts',
  'compliance/inventory.ts',
  'native/public-vocabulary.ts',
  'native/check.ts',
  'compliance/check.ts',
  'native/public-language.ts',
  'native/language-base.ts',
])(
  'refuses invalid native/generator options before evaluation: %s',
  (script) => {
    const root = resolve(import.meta.dirname, '../..');
    const child = spawnSync(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', 'tools/' + script, '--check', '--unknown'],
      { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true },
    );
    expect(child.status, child.stdout + child.stderr).toBe(2);
  },
  90000,
);

it('preflights every output before writing and leaves stable bytes and timestamps untouched', async () => {
  await withTemporaryDirectory('idempotent outputs ', async (root) => {
    const outputs = new Map([
      ['nested/a.txt', 'alpha'],
      ['nested/b.txt', 'beta'],
    ]);
    expect(checkWrite(root, outputs)).toEqual({ changed: [...outputs.keys()], written: [] });
    expect(existsSync(join(root, 'nested'))).toBe(false);
    expect(checkWrite(root, outputs, { write: true }).written).toEqual([...outputs.keys()]);
    const before = statSync(join(root, 'nested/a.txt')).mtimeMs;
    expect(checkWrite(root, outputs, { write: true })).toEqual({ changed: [], written: [] });
    expect(statSync(join(root, 'nested/a.txt')).mtimeMs).toBe(before);
    const invalid = new Map([
      ['nested/a.txt', 'changed'],
      ['../escape', 'no'],
    ]);
    expect(() => checkWrite(root, invalid, { write: true })).toThrow('Unsafe');
    expect(readRegular(root, 'nested/a.txt', 5).toString()).toBe('alpha');
    expect(() => readRegular(root, 'nested/a.txt', 4)).toThrow('Unbounded');
    expect(() =>
      checkWrite(
        root,
        new Map([
          ['A.txt', 'a'],
          ['a.txt', 'b'],
        ]),
        { write: true },
      ),
    ).toThrow('Duplicate');
    expect(existsSync(join(root, 'A.txt'))).toBe(false);
  });
});

it('refuses missing outputs beneath aliased parents and nonportable file names', async () => {
  await withTemporaryDirectory('output aliases ', async (root) => {
    mkdirSync(join(root, 'foreign'));
    symlinkSync(join(root, 'foreign'), join(root, 'alias'), 'junction');
    expect(() => checkWrite(root, new Map([['alias/new.txt', 'no']]), { write: true })).toThrow(/alias|link/i);
    expect(existsSync(join(root, 'foreign/new.txt'))).toBe(false);
    for (const path of ['/absolute', '../escape', 'a/../b', 'a//b', 'nul.txt', 'a./b', 'a\\b', 'e\u0301.txt'])
      expect(() => containedFile(root, path, { allowMissing: true }), path).toThrow();
  });
});

it('allows an explicit empty option only when its contract names that option', () => {
  expect(parseOptions(['--sha', ''], { values: ['sha'], allowEmpty: ['sha'] }).value('sha')).toBe('');
  expect(() => parseOptions(['--sha'], { values: ['sha'], allowEmpty: ['sha'] })).toThrow('Missing');
  expect(() => parseOptions(['--out', ''], { values: ['out'], allowEmpty: ['sha'] })).toThrow('Missing');
});

it('keeps generated package-facing declarations synchronized with checked implementations', () => {
  const root = resolve(import.meta.dirname, '../..');
  const checked = spawnSync(process.execPath, [join(root, 'tools/testing/check-declarations.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
}, 90000);

const withTemporaryDirectory = <T>(prefix: string, body: (root: string) => Promise<T>) =>
  withScope(async (scope) => {
    const root = scope.own('temporary directory', mkdtempSync(join(tmpdir(), prefix)), (path) =>
      rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    );
    return body(root);
  });

it('refuses aliased declaration outputs before changing any declared output or foreign file', async () => {
  await withTemporaryDirectory('declaration ownership ', async (scratch) => {
    const repository = resolve(import.meta.dirname, '../..');
    for (const kind of ['junction', 'hardlink']) {
      const root = join(scratch, kind),
        foreign = join(scratch, kind + '-foreign');
      mkdirSync(join(root, 'tools/testing'), { recursive: true });
      mkdirSync(foreign);
      for (const owner of ['entry', 'shared'])
        cpSync(join(repository, 'tools', owner), join(root, 'tools', owner), { recursive: true });
      mkdirSync(join(root, 'tools/native'));
      cpSync(join(repository, 'tools/native/public-manifest.mjs'), join(root, 'tools/native/public-manifest.mjs'));
      cpSync(
        join(repository, 'tools/testing/check-declarations.mjs'),
        join(root, 'tools/testing/check-declarations.mjs'),
      );
      cpSync(join(repository, 'biome.json'), join(root, 'biome.json'));
      symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
      if (kind === 'junction') {
        cpSync(join(root, 'tools/entry'), foreign, { recursive: true });
        rmSync(join(root, 'tools/entry'), { recursive: true });
        symlinkSync(foreign, join(root, 'tools/entry'), 'junction');
      } else {
        rmSync(join(root, 'tools/entry/package-manager.d.mts'));
        writeFileSync(join(foreign, 'package-manager.d.mts'), 'foreign sentinel\n');
        linkSync(join(foreign, 'package-manager.d.mts'), join(root, 'tools/entry/package-manager.d.mts'));
      }
      writeFileSync(join(root, 'tools/entry/is-entry.d.mts'), 'unchanged first output\n');
      const before = readFileSync(join(root, 'tools/entry/package-manager.d.mts'), 'utf8');
      const child = spawnSync(process.execPath, [join(root, 'tools/testing/check-declarations.mjs'), '--write'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(child.status, kind + child.stdout + child.stderr).not.toBe(0);
      expect(child.stderr).toMatch(/alias|link/i);
      expect(readFileSync(join(root, 'tools/entry/is-entry.d.mts'), 'utf8')).toBe('unchanged first output\n');
      expect(readFileSync(join(root, 'tools/entry/package-manager.d.mts'), 'utf8')).toBe(before);
    }
  });
}, 150000);

it('keeps cold inventory and native execution independent of tooling shims', () => {
  const root = resolve(import.meta.dirname, '../..');
  const inventory = readFileSync(join(root, 'tools/testing/inventory.ts'), 'utf8');
  expect(inventory).not.toContain("from '../docs/check.js'");
  expect(inventory).toContain('packages/runtime/src/authoring-execution/inventory.js');
  for (const owner of ['authoring-system', 'template-system']) {
    const handler = readFileSync(join(root, '.ia/src/systems', owner, 'execute.ts'), 'utf8');
    expect(handler).not.toContain('tools/systems/');
    expect(handler).toContain('@inventarch/runtime/authoring-execution');
  }
  for (const old of [
    'tools/systems/shared.ts',
    'tools/systems/types.ts',
    'tools/systems/teaching-links.ts',
    'tools/native/fixture-authoring.ts',
    'tools/systems/refusal-fixtures.ts',
    'tools/testing/canonical-temp.mjs',
    'tools/projections/live-features.mjs',
  ])
    expect(existsSync(join(root, old)), old).toBe(false);
  for (const current of [
    'tools/docs/teaching-links.mjs',
    'tools/compliance/fixture-authoring.ts',
    'tools/compliance/execution-fixtures.ts',
    'tools/temp/canonical-temp.mjs',
    'packages/workspace-runtime/tests/support/live-features.ts',
  ])
    expect(existsSync(join(root, current)), current).toBe(true);
});

it('rejects malformed, duplicate and conflicting options before effects', () => {
  const contract = {
    values: ['task', 'out'],
    booleans: ['json', 'text'],
    required: ['task'],
    exclusive: [['json', 'text']],
  };
  for (const args of [
    [],
    ['--task'],
    ['--task', '--json'],
    ['--task', 'a', '--task', 'b'],
    ['--task', 'a', 'extra'],
    ['--task', 'a', '--typo'],
    ['--task', 'a', '--json', '--text'],
  ])
    expect(() => parseOptions(args, contract)).toThrow();
  const parsed = parseOptions(['--task', 'one two', '--out', 'with spaces', '--json'], contract);
  expect(parsed.value('task')).toBe('one two');
  expect(parsed.value('out')).toBe('with spaces');
  expect(parsed.has('json')).toBe(true);
  expect(parsed.value('absent')).toBeUndefined();
});

it('bounds Git subprocesses while preserving argv and paths with spaces', async () => {
  await withTemporaryDirectory('shared git ', async (root) => {
    gitText(root, ['init', '--quiet']);
    writeFileSync(join(root, 'a file.txt'), 'value');
    gitText(root, ['add', '--', 'a file.txt']);
    expect(gitText(root, ['ls-files'])).toBe('a file.txt');
    expect(() => gitText(root, ['-c', 'alias.wait=!sleep 2', 'wait'], { timeoutMs: 20 })).toThrow();
    expect(() => gitText(root, ['status'], { timeoutMs: 0 })).toThrow('positive');
  });
});

it('compares stable versions numerically without admitting release syntax', () => {
  expect(compareVersions('1.10.0', '1.2.9')).toBe(1);
  expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  for (const value of ['01.0.0', 'v1.0.0', '1.0.0-rc.1', null, 1]) expect(stableVersion(value)).toBe(false);
  expect(() => compareVersions('1.0.0-rc.1', '1.0.0')).toThrow();
});

it('executes a Node package-manager launcher without a shell and refuses command wrappers', async () => {
  await withTemporaryDirectory('manager with spaces ', async (root) => {
    const launcher = join(root, 'manager entry.cjs');
    writeFileSync(launcher, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
    const invocation = packageManagerCommand(launcher, ['two words', '&literal']);
    expect(JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' }))).toEqual([
      'two words',
      '&literal',
    ]);
    const wrapper = join(root, 'manager.cmd');
    writeFileSync(wrapper, '@echo dangerous');
    expect(() => packageManagerCommand(wrapper, [])).toThrow('Unsupported');
  });
});

it('loads the shared and entry closure with neither installation nor built output', async () => {
  await withTemporaryDirectory('no-install leaf ', async (root) => {
    for (const owner of ['shared', 'entry'])
      cpSync(resolve(import.meta.dirname, '..', owner), join(root, owner), {
        recursive: true,
        filter: (path) => !path.endsWith('.ts'),
      });
    const script = `import {parseOptions} from './shared/args.mjs'; import {stableVersion} from './shared/semver.mjs'; import {isEntry} from './entry/is-entry.mjs'; if(!parseOptions(['--help'],{booleans:['help']}).has('help') || !stableVersion('1.0.0') || !isEntry(process.argv[1],import.meta.url)) throw Error('closure');`;
    writeFileSync(join(root, 'probe.mjs'), script);
    expect(spawnSync(process.execPath, [join(root, 'probe.mjs')], { cwd: root, encoding: 'utf8' }).status).toBe(0);
  });
});

it('checks JavaScript implementations rather than a sibling declaration', async () => {
  await withTemporaryDirectory('checked implementation ', async (root) => {
    const source = readFileSync(resolve(import.meta.dirname, 'semver.mjs'), 'utf8');
    const changed = source.replace(/return typeof value[^;]+;/, 'return 42;');
    expect(changed).not.toBe(source);
    writeFileSync(join(root, 'semver.mjs'), changed);
    writeFileSync(
      join(root, 'semver.d.mts'),
      'export function stableVersion(value: unknown): boolean;\nexport function compareVersions(a: string, b: string): number;\n',
    );
    const repository = resolve(import.meta.dirname, '../..');
    const config = JSON.parse(readFileSync(join(repository, 'tsconfig.tools-js.json'), 'utf8'));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        ...config,
        extends: join(repository, 'tsconfig.base.json'),
        include: ['semver.mjs'],
        compilerOptions: { ...config.compilerOptions, typeRoots: [join(repository, 'node_modules/@types')] },
      }),
    );
    const run = spawnSync(
      process.execPath,
      [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')],
      { encoding: 'utf8', timeout: 60000 },
    );
    expect(run.status, run.stdout + run.stderr).not.toBe(0);
    expect(run.stdout).toContain("Type 'number' is not assignable to type 'boolean'");
  });
}, 90000);
