import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBounded } from '../testing/subprocess.js';
import { bundleSystemPackages } from './system-packages.js';
import * as nativeArchiveModule from './native-archives.js';
import { declarationVersion, nativeArchives, type NativeArchive } from './native-archives.js';
import {
  assertNativeBaseline,
  assertNativeImmutability,
  nativeBaseline,
  nativeRelease,
  planNativeVersions,
  NATIVE_CURRENT,
  type NativeBaseline,
  type NativeNotes,
} from './native-version.js';
import {
  NATIVE_COMPOSITION_FIXTURE,
  NATIVE_LANGUAGE_POLICY,
  NATIVE_SYSTEM_POLICY,
  nativeVersionOnly,
  prepareNativeSelection,
  readNativeReleaseTarget,
} from './native-selectors.mjs';

const checkout = resolve(import.meta.dirname, '../..');
const pin = (name: string, dependencies: string[] = []): NativeArchive => ({
  id: 'inventarch/' + name,
  version: '3.0.0',
  archive: 'a'.repeat(64),
  manifest: 'b'.repeat(64),
  dependencies: dependencies.map((id) => 'inventarch/' + id),
});
const archives = [
  pin('core'),
  pin('consumer', ['core']),
  pin('unrelated'),
  pin('language', ['core', 'consumer', 'unrelated']),
];
const baseline: NativeBaseline = { source: { tag: 'v3.0.0', commit: 'f'.repeat(40) }, archives };
const notes = (ids: string[], bump: 'major' | 'minor' | 'patch' = 'patch'): NativeNotes => ({
  format: 'ia.native-release-notes.v1',
  baseline: baseline.source,
  changes: ids.map((id) => ({ id: 'inventarch/' + id, bump, summary: 'Reviewed native change.' })),
});
const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-native-alignment-'));
  roots.push(root);
  return root;
};
const write = (root: string, path: string, value: unknown) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const gitAt =
  (root: string) =>
  (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
function init(root: string) {
  const git = gitAt(root);
  git('-c', 'init.defaultBranch=main', 'init', '--quiet');
  for (const [key, value] of [
    ['user.name', 'Native Release Test'],
    ['user.email', 'native-test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    git('config', key!, value!);
  return git;
}
const commit = (root: string, message: string) => {
  const git = gitAt(root);
  git('add', '-A');
  git('commit', '--quiet', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
};
const releasePolicy = (version: string, prior = '2.0.0', sha = 'f'.repeat(40)) => ({
  format: 'ia.npm-cohort.v1',
  version,
  tag: 'latest',
  baseline: { version: prior, commit: sha },
  cycles: [],
});
function selectorFixture() {
  const root = temporary(),
    systems = ['agent-system', 'session-system'];
  const policy = {
    format: 'ia.system-package-policy.v2',
    packages: systems.map((system) => '.ia/src/systems/' + system),
    owners: systems.map((system) => ({
      owner: '.ia/src/systems/' + system,
      kind: 'compiled',
      npmVersion: '3.0.0',
      native: {
        system,
        id: 'inventarch/' + system,
        version: '3.0.0',
        distribution: 'workspace-system/definition/distribution/package-' + system,
      },
    })),
  };
  write(root, NATIVE_SYSTEM_POLICY, policy);
  write(root, NATIVE_LANGUAGE_POLICY, { format: 'ia.public-native-versions.v1', language: '3.0.0' });
  for (const system of systems)
    for (const path of [
      '.ia/src/systems/' + system + '/system.ia',
      'examples/public-language/contracts/' + system + '.ia',
    ])
      write(
        root,
        path,
        '#! ia 1.0\r\n\r\n@system ' + system + '\r\n  version "3.0.0"\r\n  describes "Unchanged content"\r\n',
      );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coordinated native release selection', () => {
  it.each(['3.0.1', '3.1.0', '4.0.0'])('aligns every unchanged archive to npm target %s', (target) => {
    const plan = planNativeVersions(baseline, archives, target, notes(['core'], 'major'));
    expect(plan.versions).toEqual(Object.fromEntries(archives.map((row) => [row.id, target])));
    expect(plan.changed).toEqual([]);
  });
  it('aligns the immutable npm2/native1.2 inventory to the upcoming3 target without another note target', () => {
    const initial = {
      source: { tag: 'v2.0.0', commit: '53885910dc2b22809fddb46c31091660930ade48' },
      archives: archives.map((row) => ({ ...row, version: '1.2.0' })),
    };
    expect(Object.values(planNativeVersions(initial, initial.archives, '3.0.0').versions)).toEqual(
      Array(4).fill('3.0.0'),
    );
    expect(() => planNativeVersions(initial, initial.archives, '2.0.0')).toThrow('cannot be realigned');
  });
  it('requires impact notes for changed content and exact dependency consumers, while aligning unrelated archives', () => {
    const changed = archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
    const plan = planNativeVersions(baseline, changed, '3.1.0', notes(['core', 'consumer', 'language'], 'minor'));
    expect(plan.direct).toEqual(['inventarch/core']);
    expect(plan.changed).toEqual(['inventarch/consumer', 'inventarch/core', 'inventarch/language']);
    expect(Object.values(plan.versions)).toEqual(Array(4).fill('3.1.0'));
    expect(() => planNativeVersions(baseline, changed, '3.1.0', notes(['core']))).toThrow('own bump note');
    expect(() => planNativeVersions(baseline, changed, '3.1.0')).toThrow('latest published tag');
    expect(() =>
      planNativeVersions(baseline, changed, '3.1.0', {
        ...notes(['core', 'consumer', 'language']),
        baseline: { ...baseline.source, commit: 'e'.repeat(40) },
      }),
    ).toThrow('latest published tag');
  });
  it.each([
    ['patch', '3.0.0', '3.0.1'],
    ['minor', '3.0.1', '3.1.0'],
    ['major', '3.1.0', '4.0.0'],
  ] as const)('enforces %s native impact as a minimum npm target', (impact, rejected, accepted) => {
    const changed = archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
    const changes = notes(['core', 'consumer', 'language'], impact);
    expect(() => planNativeVersions(baseline, changed, rejected, changes)).toThrow('does not satisfy native');
    expect(planNativeVersions(baseline, changed, accepted, changes).versions['inventarch/core']).toBe(accepted);
  });
  it('closes dependency cycles and still advances disconnected identities', () => {
    const cycle = [pin('a', ['b']), pin('b', ['a']), pin('c')],
      base = { ...baseline, archives: cycle };
    const plan = planNativeVersions(
      base,
      [{ ...cycle[0]!, archive: 'd'.repeat(64) }, ...cycle.slice(1)],
      '3.0.1',
      notes(['a', 'b']),
    );
    expect(plan.changed).toEqual(['inventarch/a', 'inventarch/b']);
    expect(Object.values(plan.versions)).toEqual(['3.0.1', '3.0.1', '3.0.1']);
  });
  it('refuses malformed, duplicate and independent-target notes', () => {
    const valid = notes(['core']);
    expect(() =>
      planNativeVersions(baseline, archives, '3.0.1', { ...valid, changes: [...valid.changes, ...valid.changes] }),
    ).toThrow('Duplicate');
    for (const change of [
      { id: 'inventarch/unknown', bump: 'patch', summary: 'Unknown' },
      { id: 'inventarch/core', bump: 'none', summary: 'Invalid' },
      { id: 'inventarch/core', bump: 'patch', summary: '' },
    ])
      expect(() =>
        planNativeVersions(baseline, archives, '3.0.1', { ...valid, changes: [change] } as NativeNotes),
      ).toThrow('Invalid');
    expect(() =>
      planNativeVersions(baseline, archives, '3.0.1', { ...valid, alignment: '2.1.0' } as NativeNotes),
    ).toThrow('independent alignment');
  });
  it('refuses target regressions, malformed targets, membership and unnormalized comparisons', () => {
    for (const version of ['3', '03.0.0', '3.0.1-rc.1'])
      expect(() => planNativeVersions(baseline, archives, version)).toThrow('stable npm target');
    expect(() => planNativeVersions(baseline, archives, '2.9.0')).toThrow('regressed');
    expect(() =>
      planNativeVersions(
        baseline,
        archives.map((row) => ({ ...row, version: '3.1.0' })),
        '3.1.0',
      ),
    ).toThrow('normalized');
    expect(() => planNativeVersions(baseline, [...archives, pin('added')], '3.0.1')).toThrow('membership');
    expect(() => assertNativeImmutability(baseline, [{ ...archives[0]!, archive: 'c'.repeat(64) }])).toThrow(
      'immutable',
    );
    expect(() => assertNativeImmutability(baseline, [{ ...archives[0]!, version: '1.2.0' }])).toThrow('regressed');
  });
});

describe('dependency-free native selectors', () => {
  it.each(['3.0.1', '4.0.0'])('aligns only the exact composition fixture language range for target %s', (target) => {
    const root = selectorFixture(),
      path = 'apps/cli/tests/fixtures/composition-workspace/.ia/release.json';
    const descriptor = {
      formatVersion: 1,
      id: 'local/demo',
      version: '0.1.0',
      engine: '^0.1.1',
      language: ['1.0'],
      dependencies: [{ id: 'inventarch/language', range: '^3.0.0', systems: ['agent-system', 'session-system'] }],
      assets: [],
    };
    const before = JSON.stringify(descriptor, null, 2).replaceAll('\n', '\r\n') + '\r\n';
    write(root, path, before);
    const after = prepareNativeSelection(root, target).get(path);
    expect(after).toBe(before.replace('^3.0.0', '^' + target));
    expect(readFileSync(resolve(root, path), 'utf8')).toBe(before);
    expect(nativeVersionOnly(root, path, before, after!)).toBe(true);
    expect(nativeVersionOnly(root, path + '.extra', before, after!)).toBe(false);
    expect(nativeVersionOnly(root, path, null, after!)).toBe(false);
    expect(nativeVersionOnly(root, path, before, null)).toBe(false);
    for (const changed of [
      { ...descriptor, id: 'local/other' },
      { ...descriptor, version: '0.2.0' },
      { ...descriptor, engine: '^9.0.0' },
      { ...descriptor, language: ['2.0'] },
      { ...descriptor, dependencies: [{ ...descriptor.dependencies[0], systems: ['agent-system'] }] },
      { ...descriptor, dependencies: [...descriptor.dependencies, ...descriptor.dependencies] },
    ])
      expect(nativeVersionOnly(root, path, before, JSON.stringify(changed))).toBe(false);
    for (const invalid of ['*', '3.0.0', '^03.0.0']) {
      write(root, path, { ...descriptor, dependencies: [{ ...descriptor.dependencies[0], range: invalid }] });
      expect(() => prepareNativeSelection(root, target)).toThrow('fixture');
    }
  });

  it('prepares every paired declaration and policy, preserving syntax and CRLF without writing', () => {
    const root = selectorFixture(),
      writes = prepareNativeSelection(root, '3.1.0');
    expect(writes.size).toBe(6);
    for (const [path, text] of writes) {
      const before = readFileSync(resolve(root, path), 'utf8');
      expect(nativeVersionOnly(root, path, before, text)).toBe(true);
      if (path.endsWith('.ia')) {
        expect(text).toBe(before.replace('version "3.0.0"', 'version "3.1.0"'));
        expect(text.startsWith('#! ia 1.0\r\n')).toBe(true);
      }
    }
    const policy = JSON.parse(writes.get(NATIVE_SYSTEM_POLICY)!);
    expect(
      policy.owners.map((row: { npmVersion: string; native: { version: string } }) => [
        row.npmVersion,
        row.native.version,
      ]),
    ).toEqual([
      ['3.1.0', '3.1.0'],
      ['3.1.0', '3.1.0'],
    ]);
    expect(JSON.parse(writes.get(NATIVE_LANGUAGE_POLICY)!).language).toBe('3.1.0');
    expect(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8')).toContain('"3.0.0"');
  });
  it('allows only complete absence, and refuses missing policies or declarations before any write', () => {
    const empty = temporary();
    expect(prepareNativeSelection(empty, '3.0.0').size).toBe(0);
    write(empty, '.ia/src/systems/sample/system.ia', '#! ia 1.0\n@system sample\n  version "3.0.0"\n');
    expect(() => prepareNativeSelection(empty, '3.0.0')).toThrow('Incomplete native selector surface');
    const root = selectorFixture();
    rmSync(resolve(root, NATIVE_LANGUAGE_POLICY));
    expect(() => prepareNativeSelection(root, '3.0.1')).toThrow('Incomplete');
    write(root, NATIVE_LANGUAGE_POLICY, { format: 'ia.public-native-versions.v1', language: '3.0.0' });
    rmSync(resolve(root, 'examples/public-language/contracts/session-system.ia'));
    expect(() => prepareNativeSelection(root, '3.0.1')).toThrow();
    expect(readFileSync(resolve(root, '.ia/src/systems/agent-system/system.ia'), 'utf8')).toContain('"3.0.0"');
  });
  it('binds the exact version field to its system block, preserving unrelated record versions', () => {
    const root = selectorFixture(),
      path = '.ia/src/systems/agent-system/system.ia';
    const invalid = '#! ia 1.0\n@system agent-system\n  describes "No version"\n@record other\n  version "3.0.0"\n';
    write(root, path, invalid);
    expect(() => prepareNativeSelection(root, '3.0.1')).toThrow('exactly one version');
    expect(nativeVersionOnly(root, path, invalid, invalid.replace('3.0.0', '3.0.1'))).toBe(false);
    const valid = '#! ia 1.0\r\n@system agent-system\r\n  version "3.0.0"\r\n@record other\r\n  version "8.0.0"\r\n';
    expect(declarationVersion(valid, '3.0.0', '3.0.1')).toBe(valid.replace('version "3.0.0"', 'version "3.0.1"'));
    expect(nativeVersionOnly(root, path, valid, valid.replace('8.0.0', '8.0.1'))).toBe(false);
  });
  it('does not admit semantic, identity, membership, dependency, syntax, sibling, new or deleted changes as version only', () => {
    const root = selectorFixture(),
      path = '.ia/src/systems/agent-system/system.ia';
    const before = readFileSync(resolve(root, path), 'utf8'),
      after = before.replace('3.0.0', '3.0.1');
    for (const text of [
      after.replace('Unchanged content', 'Different behavior'),
      after.replace('ia 1.0', 'ia 2.0'),
      after.replace('@system agent-system', '@system other-system'),
      after + '  requires\r\n    - another\r\n',
    ])
      expect(nativeVersionOnly(root, path, before, text)).toBe(false);
    expect(nativeVersionOnly(root, path + '.extra', before, after)).toBe(false);
    expect(nativeVersionOnly(root, path, null, after)).toBe(false);
    expect(nativeVersionOnly(root, path, before, null)).toBe(false);
    const policyText = readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8');
    const changed = JSON.parse(policyText);
    changed.owners.pop();
    changed.packages.pop();
    expect(nativeVersionOnly(root, NATIVE_SYSTEM_POLICY, policyText, JSON.stringify(changed))).toBe(false);
    changed.owners[0].native.dependencies = ['inventarch/other'];
    expect(nativeVersionOnly(root, NATIVE_SYSTEM_POLICY, policyText, JSON.stringify(changed))).toBe(false);
    expect(() => prepareNativeSelection(root, '2.0.0')).toThrow('regressed');
  });
  it('validates the sole release target and imports in a child without workspace dependencies', () => {
    const root = temporary();
    write(root, 'releases/current.json', releasePolicy('3.0.0'));
    expect(readNativeReleaseTarget(root).version).toBe('3.0.0');
    for (const version of ['01.0.0', '3.0', '3.0.0-rc.1']) {
      write(root, 'releases/current.json', releasePolicy(version));
      expect(() => readNativeReleaseTarget(root)).toThrow('stable npm target');
    }
    write(root, 'native-selectors.mjs', readFileSync(resolve(checkout, 'tools/release/native-selectors.mjs'), 'utf8'));
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import {prepareNativeSelection} from "./native-selectors.mjs"; process.stdout.write(String(prepareNativeSelection(process.cwd(),"3.0.0").size));',
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    expect(output.trim()).toBe('0');
  });
});

describe('published native evidence and candidate ledger', () => {
  it('reads the reachable tagged ledger, ignores mutable and unreachable evidence, and binds npm baseline', () => {
    const root = temporary(),
      git = init(root),
      previous = commit(root, 'Earlier published source');
    write(root, 'releases/current.json', releasePolicy('3.0.0', '2.9.0', previous));
    write(root, NATIVE_CURRENT, { format: 'ia.native-release.v1', archives });
    const published = commit(root, 'Published fixture');
    git('tag', 'v3.0.0');
    write(root, NATIVE_CURRENT, { format: 'ia.native-release.v1', archives: [] });
    expect(nativeBaseline(root).archives).toEqual(archives);
    expect(assertNativeBaseline(root, nativeBaseline(root), readNativeReleaseTarget(root))).toBe(true);
    write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
    expect(assertNativeBaseline(root, nativeBaseline(root), readNativeReleaseTarget(root))).toBe(false);
    write(root, 'releases/current.json', releasePolicy('3.0.1', '2.9.0', previous));
    expect(() => assertNativeBaseline(root, nativeBaseline(root), readNativeReleaseTarget(root))).toThrow(
      'differs from npm',
    );
    git('restore', '--', '.');
    git('switch', '--quiet', '-c', 'unreachable');
    write(root, NATIVE_CURRENT, {
      format: 'ia.native-release.v1',
      archives: archives.map((row) => ({ ...row, version: '4.0.0' })),
    });
    commit(root, 'Unreachable later release');
    git('tag', 'v4.0.0');
    git('switch', '--quiet', 'main');
    expect(nativeBaseline(root).source.tag).toBe('v3.0.0');
    write(root, 'releases/current.json', releasePolicy('4.0.0', '3.0.0', published));
    expect(() => assertNativeBaseline(root, nativeBaseline(root), readNativeReleaseTarget(root))).toThrow(
      'target tag is not the latest reachable',
    );
    write(root, 'releases/current.json', releasePolicy('3.0.0', '2.8.0', previous));
    expect(() => assertNativeBaseline(root, nativeBaseline(root), readNativeReleaseTarget(root))).toThrow(
      'tagged policy',
    );
  });
  it('retains the unchanged published ledger but refuses stale baseline and notes on an npm-only future target', () => {
    const { root, retained, published } = realNativeReleaseFixture();
    expect(nativeRelease(root, 'check').changed).toEqual([]);
    write(root, NATIVE_CURRENT, { ...retained, notesSha256: 'a'.repeat(64) });
    expect(() => nativeRelease(root, 'check')).toThrow('Published native ledger');
    write(root, NATIVE_CURRENT, retained);
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual(retained);
    write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
    for (const [path, text] of prepareNativeSelection(root, '3.0.1')) write(root, path, text);
    const candidate = { ...retained, baseline: { tag: 'v3.0.0', commit: published }, archives: nativeArchives(root) };
    for (const wrong of [
      { ...candidate, baseline: retained.baseline },
      { ...candidate, notesSha256: 'a'.repeat(64) },
    ]) {
      write(root, NATIVE_CURRENT, wrong);
      expect(() => nativeRelease(root, 'check')).toThrow('ledger is stale');
    }
    write(root, NATIVE_CURRENT, candidate);
    const result = nativeRelease(root, 'check');
    expect(result.changed).toEqual([]);
    expect(Object.values(result.versions)).toEqual(Array(12).fill('3.0.1'));
  }, 120_000);
});

/** Real packing inputs with a literal historical version, independent of the checkout's future release target. */
function realNativeReleaseFixture(historicalNotesSha256: string | null = null) {
  const root = temporary(),
    git = init(root),
    prior = commit(root, 'Earlier published source');
  const files = gitAt(checkout)(
    'ls-files',
    '--',
    '.ia/src',
    '.ia/authoring.resources.json',
    'examples/public-language',
    'LICENSE',
    'NOTICE',
    NATIVE_SYSTEM_POLICY,
    NATIVE_COMPOSITION_FIXTURE,
  )
    .split('\n')
    .filter(Boolean);
  for (const path of files) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(resolve(checkout, path), resolve(root, path));
  }
  const selected = JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8'));
  for (const owner of selected.owners) {
    owner.npmVersion = '3.0.0';
    owner.native.version = '3.0.0';
    for (const path of [
      owner.owner + '/system.ia',
      'examples/public-language/contracts/' + owner.native.system + '.ia',
    ])
      write(
        root,
        path,
        readFileSync(resolve(root, path), 'utf8').replace(/^  version "[^"\r\n]+"/m, '  version "3.0.0"'),
      );
  }
  write(root, NATIVE_SYSTEM_POLICY, selected);
  write(root, NATIVE_LANGUAGE_POLICY, { format: 'ia.public-native-versions.v1', language: '3.0.0' });
  const composition = JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'));
  composition.dependencies.find((row: { id: string }) => row.id === 'inventarch/language').range = '^3.0.0';
  write(root, NATIVE_COMPOSITION_FIXTURE, composition);
  write(root, 'releases/current.json', releasePolicy('3.0.0', '2.9.0', prior));
  for (const [path, text] of prepareNativeSelection(root, '3.0.0')) write(root, path, text);
  const retained = {
    format: 'ia.native-release.v1',
    baseline: { tag: 'v2.9.0', commit: prior },
    notesSha256: historicalNotesSha256,
    archives: nativeArchives(root),
  };
  write(root, NATIVE_CURRENT, retained);
  const published = commit(root, 'Publish aligned3 fixture');
  git('tag', 'v3.0.0');
  return { root, git, prior, retained, published };
}

/** The complete exact selector surface, derived independently of the production writer's write map. */
function nativeWriterSnapshot(root: string) {
  const selected = JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8'));
  const declarations = selected.owners.flatMap((owner: { owner: string; native: { system: string } }) => [
    owner.owner + '/system.ia',
    'examples/public-language/contracts/' + owner.native.system + '.ia',
  ]) as string[];
  const paths = [
    ...declarations,
    NATIVE_SYSTEM_POLICY,
    NATIVE_LANGUAGE_POLICY,
    NATIVE_COMPOSITION_FIXTURE,
    NATIVE_CURRENT,
  ];
  return new Map(
    paths.map((path) => [path, existsSync(resolve(root, path)) ? readFileSync(resolve(root, path)) : null]),
  );
}

function expectNativeWriterSelection(root: string, before: Map<string, Buffer | null>, target: string) {
  // All eleven owners have paired declarations; both policy files and the composition fixture also move.
  expect(before.size).toBe(26);
  const selected = JSON.parse(before.get(NATIVE_SYSTEM_POLICY)!.toString('utf8'));
  expect(selected.owners).toHaveLength(11);
  for (const owner of selected.owners) {
    owner.npmVersion = target;
    owner.native.version = target;
  }
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8'))).toEqual(selected);
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_LANGUAGE_POLICY), 'utf8'))).toEqual({
    format: 'ia.public-native-versions.v1',
    language: target,
  });
  for (const [path, bytes] of before)
    if (path.endsWith('.ia'))
      expect(readFileSync(resolve(root, path), 'utf8')).toBe(
        bytes!.toString('utf8').replace(/^  version "3\.0\.0"/m, `  version "${target}"`),
      );
  const composition = JSON.parse(before.get(NATIVE_COMPOSITION_FIXTURE)!.toString('utf8'));
  composition.dependencies.find((row: { id: string }) => row.id === 'inventarch/language').range = '^' + target;
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'))).toEqual(composition);
}

describe('native release writer', () => {
  it('persists every selector and a fresh twelve-archive ledger for an npm-only 3.0.1 target', () => {
    const { root, published } = realNativeReleaseFixture();
    write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
    const before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    expect(result.changed).toEqual([]);
    expect(result.target).toBe('3.0.1');
    expect(Object.values(result.versions)).toEqual(Array(12).fill('3.0.1'));
    expectNativeWriterSelection(root, before, '3.0.1');
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual({
      format: 'ia.native-release.v1',
      baseline: { tag: 'v3.0.0', commit: published },
      notesSha256: null,
      archives: result.archives,
    });
    expect(result.archives).toHaveLength(12);
    expect(result.archives.map((row) => row.version)).toEqual(Array(12).fill('3.0.1'));
    expect(readFileSync(resolve(root, NATIVE_CURRENT))).not.toEqual(before.get(NATIVE_CURRENT));
    expect(nativeRelease(root, 'check').archives).toEqual(result.archives);
  }, 120_000);

  it('preserves the complete historical ledger when writing an unchanged published target', () => {
    const historicalNotes = 'd'.repeat(64),
      { root, prior, retained } = realNativeReleaseFixture(historicalNotes),
      before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    expect(result.target).toBe('3.0.0');
    expect(result.changed).toEqual([]);
    expect(nativeWriterSnapshot(root)).toEqual(before);
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual(retained);
    expect(retained.baseline).toEqual({ tag: 'v2.9.0', commit: prior });
    expect(retained.notesSha256).toBe(historicalNotes);
  }, 120_000);

  it.each([true, false])(
    'restores exact selector bytes after a post-write packing failure (existing ledger=%s)',
    (hasLedger) => {
      const { root, git, published } = realNativeReleaseFixture();
      write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
      if (!hasLedger) rmSync(resolve(root, NATIVE_CURRENT));
      const before = nativeWriterSnapshot(root),
        status = git('status', '--porcelain'),
        realArchives = nativeArchiveModule.nativeArchives,
        failure = new Error('Fixture: post-write archive packing failed');
      let reachedPostWrite = false;
      const archiveSpy = vi.spyOn(nativeArchiveModule, 'nativeArchives').mockImplementation((candidate, overrides) => {
        if (candidate === root && overrides === undefined) {
          reachedPostWrite = true;
          expectNativeWriterSelection(root, before, '3.0.1');
          throw failure;
        }
        return realArchives(candidate, overrides);
      });
      try {
        expect(() => nativeRelease(root, 'write')).toThrow(failure);
        expect(reachedPostWrite).toBe(true);
        // Both previews succeeded; the third call inspected selectors that had actually been written.
        expect(archiveSpy).toHaveBeenCalledTimes(3);
        expect(archiveSpy.mock.calls[2]).toEqual([root]);
        expect(nativeWriterSnapshot(root)).toEqual(before);
        expect(existsSync(resolve(root, NATIVE_CURRENT))).toBe(hasLedger);
        expect(git('status', '--porcelain')).toBe(status);
      } finally {
        archiveSpy.mockRestore();
      }
    },
    120_000,
  );
});

it('refuses a stale composition dependency even when published native versions and ledger are current', () => {
  const { root } = realNativeReleaseFixture();
  const fixture = JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'));
  fixture.dependencies[0].range = '^2.9.0';
  write(root, NATIVE_COMPOSITION_FIXTURE, fixture);
  expect(() => nativeRelease(root, 'check')).toThrow('Native selectors are stale');
  nativeRelease(root, 'write');
  expect(nativeRelease(root, 'check').changed).toEqual([]);
}, 120_000);

describe('system package input reads', () => {
  // `bundleSystemPackages` reads each receipt-selected native source through its file reader before anything else, so a
  // one-file receipt and an empty policy reach that read and stop at its first refusal.
  const bundle = (root: string, path: string, sha256: string) =>
    bundleSystemPackages(
      root,
      {
        format: 'ia.public-package-inputs.v2',
        source: { repository: 'https://github.com/inventarch/ia', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
        files: [{ path, sha256 }],
      },
      { format: 'ia.system-package-policy.v2', packages: [], owners: [] },
    );
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');

  it('reads a selected regular file and refuses a missing, directory or FIFO input as it always has', async () => {
    const root = temporary();
    write(root, '.ia/src/a.ia', 'native source');
    write(root, 'pnpm-workspace.yaml', 'packages: []\n');
    // The digest matches, so the read moves on to the next input, which this receipt does not pin.
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(
      /^System package input is absent or changed in public receipt: pnpm-workspace\.yaml$/,
    );
    expect(() => bundle(root, '.ia/src/a.ia', digest('other source'))).toThrow(
      /^System package input is absent or changed in public receipt: \.ia\/src\/a\.ia$/,
    );
    expect(() => bundle(root, '.ia/src/missing.ia', digest(''))).toThrow(/^ENOENT: no such file or directory, lstat /);
    mkdirSync(resolve(root, '.ia/src/dir.ia'));
    expect(() => bundle(root, '.ia/src/dir.ia', digest(''))).toThrow(
      /^System package input is not a regular file: \.ia\/src\/dir\.ia$/,
    );
    if (process.platform === 'win32') return; // Windows has no FIFOs.
    expect((await runBounded('mkfifo', [resolve(root, '.ia/src/fifo.ia')], { timeoutMs: 10_000 })).status).toBe(0);
    expect(() => bundle(root, '.ia/src/fifo.ia', digest(''))).toThrow(
      /^System package input is not a regular file: \.ia\/src\/fifo\.ia$/,
    );
  });

  it('refuses a linked input before reading it and rethrows the open error for one it cannot read', () => {
    // File links need a privilege on Windows, which has no such mode either; root reads a file whatever its mode.
    if (process.platform === 'win32') return;
    const root = temporary();
    write(root, '.ia/src/a.ia', 'native source');
    symlinkSync('a.ia', resolve(root, '.ia/src/link.ia'));
    expect(() => bundle(root, '.ia/src/link.ia', digest('native source'))).toThrow(/^Link\/junction is not allowed: /);
    if (process.getuid?.() === 0) return;
    chmodSync(resolve(root, '.ia/src/a.ia'), 0o000);
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(/^EACCES: permission denied, open /);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  /** Runs `change` once: before the first open of the selected input, or before the first read. Whatever it returns runs after that open. */
  function around(target: string, at: 'open' | 'read', change: () => (() => void) | void): () => boolean {
    const open = fs.openSync,
      read = fs.readSync;
    let changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (at !== 'open' || changed || String(args[0]) !== target) return Reflect.apply(open, fs, args) as number;
      changed = true;
      const after = change();
      try {
        return Reflect.apply(open, fs, args) as number;
      } finally {
        after?.();
      }
    });
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (at === 'read' && !changed) {
        changed = true;
        change();
      }
      return Reflect.apply(read, fs, args) as number;
    });
    syncBuiltinESMExports();
    return () => changed;
  }
  const changes: [string, 'open' | 'read', (target: string) => (() => void) | void, RegExp][] = [
    [
      'a link put in place at the open as aliased, even once it is gone again',
      'open',
      (target) => {
        rmSync(target);
        symlinkSync('elsewhere.ia', target);
        return () => rmSync(target);
      },
      /^System package input is aliased: \.ia\/src\/a\.ia$/,
    ],
    [
      'an input gone before the open with the open error',
      'open',
      (target) => rmSync(target),
      /^ENOENT: no such file or directory, open /,
    ],
    [
      'an input gone after the open as changed',
      'read',
      (target) => rmSync(target),
      /^System package input changed while it was read: \.ia\/src\/a\.ia$/,
    ],
    [
      'an input replaced by a directory during the read as not a regular file',
      'read',
      (target) => {
        rmSync(target);
        mkdirSync(target);
      },
      /^System package input is not a regular file: \.ia\/src\/a\.ia$/,
    ],
    [
      'an input rewritten at the same size during the read as changed',
      'read',
      (target) => {
        writeFileSync(target, 'NATIVE SOURCE');
        fs.utimesSync(target, new Date(2000, 0, 1), new Date(2000, 0, 1));
      },
      /^System package input changed while it was read: \.ia\/src\/a\.ia$/,
    ],
  ];
  it.each(changes)('refuses %s', (_, at, change, refusal) => {
    const root = temporary(),
      target = resolve(root, '.ia/src/a.ia');
    write(root, '.ia/src/a.ia', 'native source');
    write(root, 'pnpm-workspace.yaml', 'packages: []\n');
    const changed = around(target, at, () => change(target));
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(refusal);
    expect(changed()).toBe(true);
  });
});
