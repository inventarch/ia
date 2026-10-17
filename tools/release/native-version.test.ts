import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeArchiveModule from './native-archives.js';
import { declarationVersion, nativeArchives, type NativeArchive } from './native-archives.js';
import {
  assertNativeBaseline,
  assertNativeImmutability,
  nativeBaseline,
  nativeRelease,
  planNativeVersions,
  NATIVE_CURRENT,
  NATIVE_NOTES,
  type NativeBaseline,
  type NativeNotes,
} from './native-version.js';
import {
  NATIVE_COMPOSITION_FIXTURE,
  NATIVE_LANGUAGE_POLICY,
  NATIVE_SYSTEM_POLICY,
  cohortNativeVersions,
  nativeVersionOnly,
  prepareNativeSelection,
  readNativeReleaseTarget,
} from './native-selectors.mjs';
import { chmodSync } from 'node:fs';
import { collectChanges, releaseChanges } from '../distribution/release-changes.mjs';
import { versionRelease } from '../distribution/release-version.mjs';

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
/** Selector fixture versions: each system and the language may take its own version. */
const selectorVersions = (language: string, agent = '3.0.0', session = '3.0.0') => ({
  'inventarch/agent-system': agent,
  'inventarch/session-system': session,
  'inventarch/language': language,
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const short = (plan: { versions: Record<string, string> }) =>
  Object.fromEntries(Object.entries(plan.versions).map(([id, version]) => [id.slice('inventarch/'.length), version]));
/** A published npm tag whose native archives carry their own versions (default 3.0.0). */
const publishedAt = (tag: string, versions: Record<string, string> = {}): NativeBaseline => ({
  source: { tag: 'v' + tag, commit: 'f'.repeat(40) },
  archives: archives.map((row) => ({ ...row, version: versions[row.id.slice('inventarch/'.length)] ?? row.version })),
});
const impact = (base: NativeBaseline, changes: Record<string, 'major' | 'minor' | 'patch'>): NativeNotes => ({
  format: 'ia.native-release-notes.v1',
  baseline: base.source,
  changes: Object.entries(changes).map(([id, bump]) => ({ id: 'inventarch/' + id, bump, summary: 'Reviewed change.' })),
});
const changeCore = (base: NativeBaseline) =>
  base.archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
const changeUnrelated = (base: NativeBaseline) =>
  base.archives.map((row) => (row.id === 'inventarch/unrelated' ? { ...row, archive: 'c'.repeat(64) } : row));
const compareVersions = (a: string, b: string) => {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number)) as [number[], number[]];
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
};

describe('coordinated native release selection', () => {
  it.each([
    ['3.0.0', '3.0.1'],
    ['3.0.0', '3.1.0'],
    ['3.1.0', '3.2.0'],
    ['3.14.0', '3.15.0'],
  ])('keeps every unchanged 3.0.0 archive when npm %s advances only to %s', (tag, target) => {
    const base = publishedAt(tag),
      plan = planNativeVersions(base, base.archives, target);
    expect(plan.versions).toEqual(Object.fromEntries(archives.map((row) => [row.id, '3.0.0'])));
    expect(plan).toMatchObject({ direct: [], changed: [] });
  });
  it('bumps a changed archive and its dependency-only consumer from their own versions, keeping an unrelated control', () => {
    const base = publishedAt('3.2.0', { core: '3.1.0', consumer: '3.0.1', language: '3.2.0' }),
      changed = changeCore(base);
    const plan = planNativeVersions(
      base,
      changed,
      '3.3.0',
      impact(base, { core: 'minor', consumer: 'patch', language: 'patch' }),
    );
    expect(plan.direct).toEqual(['inventarch/core']);
    expect(plan.changed).toEqual(['inventarch/consumer', 'inventarch/core', 'inventarch/language']);
    expect(short(plan)).toEqual({ consumer: '3.0.2', core: '3.2.0', language: '3.2.1', unrelated: '3.0.0' });
    // The consumer's own bytes are unchanged; its exact dependency moves, so it needs its own note. The control needs none.
    expect(() =>
      planNativeVersions(base, changed, '3.3.0', impact(base, { core: 'minor', language: 'patch' })),
    ).toThrow('inventarch/consumer: changed archive requires its own bump note');
    expect(() => planNativeVersions(base, changed, '3.3.0')).toThrow('latest published tag');
    expect(() =>
      planNativeVersions(base, changed, '3.3.0', {
        ...impact(base, { core: 'minor', consumer: 'patch', language: 'patch' }),
        baseline: { ...base.source, commit: 'e'.repeat(40) },
      }),
    ).toThrow('latest published tag');
  });
  it('compares the npm release bump with each note, however far the changed archive lags', () => {
    for (const lag of ['3.0.0', '3.2.0']) {
      const base = publishedAt('3.2.0', { unrelated: lag, core: '3.2.0', consumer: '3.2.0', language: '3.2.0' }),
        notes = impact(base, { unrelated: 'minor', language: 'patch' });
      expect(() => planNativeVersions(base, changeUnrelated(base), '3.2.1', notes)).toThrow(
        'inventarch/unrelated: npm 3.2.0 -> 3.2.1 (patch) does not satisfy native minor impact',
      );
      expect(short(planNativeVersions(base, changeUnrelated(base), '3.3.0', notes))).toEqual({
        consumer: '3.2.0',
        core: '3.2.0',
        language: '3.2.1',
        unrelated: lag === '3.0.0' ? '3.1.0' : '3.3.0',
      });
    }
  });
  it('accepts exactly the notes an npm release bump covers and keeps every selected native at or below npm', () => {
    const impacts = ['patch', 'minor', 'major'] as const;
    for (const lag of ['3.0.0', '3.1.4', '3.2.0'])
      for (const [release, target] of [
        ['patch', '3.2.1'],
        ['minor', '3.3.0'],
      ] as const)
        for (const note of impacts) {
          const base = publishedAt('3.2.0', { unrelated: lag, core: '3.2.0', consumer: '3.2.0', language: '3.2.0' }),
            notes = impact(base, { unrelated: note, language: 'patch' });
          if (impacts.indexOf(note) > impacts.indexOf(release)) {
            expect(() => planNativeVersions(base, changeUnrelated(base), target, notes)).toThrow(
              `(${release}) does not satisfy native ${note} impact`,
            );
            continue;
          }
          for (const version of Object.values(planNativeVersions(base, changeUnrelated(base), target, notes).versions))
            expect(compareVersions(version, target)).toBeLessThanOrEqual(0);
        }
    // A native ahead of its published npm tag is refused rather than carried past the npm target.
    const ahead = publishedAt('3.2.0', { core: '3.2.1' });
    expect(() =>
      planNativeVersions(
        ahead,
        changeCore(ahead),
        '3.2.1',
        impact(ahead, { core: 'patch', consumer: 'patch', language: 'patch' }),
      ),
    ).toThrow('cannot pass the npm target');
  });
  it('requires an npm major for a native major change, even from a lagging archive', () => {
    const base = publishedAt('3.5.0'),
      notes = impact(base, { core: 'major', consumer: 'patch', language: 'patch' });
    expect(() => planNativeVersions(base, changeCore(base), '3.6.0', notes)).toThrow(
      'inventarch/core: npm 3.5.0 -> 3.6.0 (minor) does not satisfy native major impact',
    );
    expect(Object.values(planNativeVersions(base, changeCore(base), '4.0.0', notes).versions)).toEqual(
      Array(4).fill('4.0.0'),
    );
  });
  it('aligns mixed major-3 archives, including one still at 3.0.0, to npm 4.0.0', () => {
    const base = publishedAt('3.5.0', { core: '3.2.0', consumer: '3.0.1', language: '3.4.0' }),
      four = { consumer: '4.0.0', core: '4.0.0', language: '4.0.0', unrelated: '4.0.0' };
    expect(base.archives.find((row) => row.id === 'inventarch/unrelated')!.version).toBe('3.0.0');
    expect(short(planNativeVersions(base, base.archives, '4.0.0'))).toEqual(four);
    const changed = changeCore(base);
    expect(() => planNativeVersions(base, changed, '4.0.0')).toThrow('latest published tag');
    const notes = impact(base, { core: 'major', consumer: 'patch', language: 'minor' });
    expect(short(planNativeVersions(base, changed, '4.0.0', notes))).toEqual(four);
    expect(() => planNativeVersions(base, base.archives, '4.1.0')).toThrow('must start at 4.0.0');
  });
  it('after the 4.0.0 reset keeps unchanged archives for npm 4.1.0 while a changed archive follows its own cadence', () => {
    const base = publishedAt('4.0.0', { consumer: '4.0.0', core: '4.0.0', language: '4.0.0', unrelated: '4.0.0' });
    expect(Object.values(planNativeVersions(base, base.archives, '4.1.0').versions)).toEqual(Array(4).fill('4.0.0'));
    const notes = impact(base, { core: 'patch', consumer: 'patch', language: 'minor' });
    expect(short(planNativeVersions(base, changeCore(base), '4.1.0', notes))).toEqual({
      consumer: '4.0.1',
      core: '4.0.1',
      language: '4.1.0',
      unrelated: '4.0.0',
    });
  });
  it('aligns the immutable npm2/native1.2 inventory at the npm3 boundary and keeps it at its published 2.0.0 target', () => {
    const initial = {
      source: { tag: 'v2.0.0', commit: '53885910dc2b22809fddb46c31091660930ade48' },
      archives: archives.map((row) => ({ ...row, version: '1.2.0' })),
    };
    expect(Object.values(planNativeVersions(initial, initial.archives, '3.0.0').versions)).toEqual(
      Array(4).fill('3.0.0'),
    );
    expect(Object.values(planNativeVersions(initial, initial.archives, '2.0.0').versions)).toEqual(
      Array(4).fill('1.2.0'),
    );
  });
  it.each([
    ['patch', '3.0.0', '3.0.1'],
    ['minor', '3.0.1', '3.1.0'],
    ['major', '3.1.0', '4.0.0'],
  ] as const)('enforces %s native impact as a minimum npm release bump', (impact, rejected, accepted) => {
    const changed = archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
    const changes = notes(['core', 'consumer', 'language'], impact);
    expect(() => planNativeVersions(baseline, changed, rejected, changes)).toThrow('does not satisfy native');
    expect(planNativeVersions(baseline, changed, accepted, changes).versions['inventarch/core']).toBe(accepted);
  });
  it('closes dependency cycles and keeps disconnected identities', () => {
    const cycle = [pin('a', ['b']), pin('b', ['a']), pin('c')],
      base = { ...baseline, archives: cycle };
    const plan = planNativeVersions(
      base,
      [{ ...cycle[0]!, archive: 'd'.repeat(64) }, ...cycle.slice(1)],
      '3.0.1',
      notes(['a', 'b']),
    );
    expect(plan.changed).toEqual(['inventarch/a', 'inventarch/b']);
    expect(Object.values(plan.versions)).toEqual(['3.0.1', '3.0.1', '3.0.0']);
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
  it.each(['3.0.1', '4.0.0'])(
    'moves only the exact composition fixture language range to selected language %s',
    (target) => {
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
      const after = prepareNativeSelection(root, target, selectorVersions(target)).get(path);
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
        expect(() => prepareNativeSelection(root, target, selectorVersions(target))).toThrow('fixture');
      }
    },
  );

  it('prepares every paired declaration and policy at its own version, preserving syntax and CRLF without writing', () => {
    const root = selectorFixture(),
      writes = prepareNativeSelection(root, '3.1.0', selectorVersions('3.0.1', '3.0.1'));
    expect(writes.size).toBe(6);
    for (const [path, text] of writes) {
      const before = readFileSync(resolve(root, path), 'utf8');
      expect(nativeVersionOnly(root, path, before, text)).toBe(true);
      if (path.endsWith('.ia')) {
        expect(text).toBe(
          path.includes('agent-system') ? before.replace('version "3.0.0"', 'version "3.0.1"') : before,
        );
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
      ['3.1.0', '3.0.1'],
      ['3.1.0', '3.0.0'],
    ]);
    expect(JSON.parse(writes.get(NATIVE_LANGUAGE_POLICY)!).language).toBe('3.0.1');
    // @ts-expect-error The versions argument is required; the runtime refuses its absence too.
    expect(() => prepareNativeSelection(root, '3.1.0')).toThrow('inventory');
    expect(() =>
      prepareNativeSelection(root, '3.1.0', { ...selectorVersions('3.0.1'), 'inventarch/extra': '3.0.0' }),
    ).toThrow('inventory');
    expect(() => prepareNativeSelection(root, '3.1.0', selectorVersions('3.0'))).toThrow('Stable native versions');
    expect(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8')).toContain('"3.0.0"');
  });
  it('allows only complete absence, and refuses missing policies or declarations before any write', () => {
    const empty = temporary();
    expect(prepareNativeSelection(empty, '3.0.0', {}).size).toBe(0);
    write(empty, '.ia/src/systems/sample/system.ia', '#! ia 1.0\n@system sample\n  version "3.0.0"\n');
    expect(() => prepareNativeSelection(empty, '3.0.0', {})).toThrow('Incomplete native selector surface');
    const root = selectorFixture();
    rmSync(resolve(root, NATIVE_LANGUAGE_POLICY));
    expect(() => prepareNativeSelection(root, '3.0.1', selectorVersions('3.0.1'))).toThrow('Incomplete');
    write(root, NATIVE_LANGUAGE_POLICY, { format: 'ia.public-native-versions.v1', language: '3.0.0' });
    rmSync(resolve(root, 'examples/public-language/contracts/session-system.ia'));
    expect(() => prepareNativeSelection(root, '3.0.1', selectorVersions('3.0.1', '3.0.1', '3.0.1'))).toThrow('ENOENT');
    expect(readFileSync(resolve(root, '.ia/src/systems/agent-system/system.ia'), 'utf8')).toContain('"3.0.0"');
  });
  it('binds the exact version field to its system block, preserving unrelated record versions', () => {
    const root = selectorFixture(),
      path = '.ia/src/systems/agent-system/system.ia';
    const invalid = '#! ia 1.0\n@system agent-system\n  describes "No version"\n@record other\n  version "3.0.0"\n';
    write(root, path, invalid);
    expect(() => prepareNativeSelection(root, '3.0.1', selectorVersions('3.0.0', '3.0.1'))).toThrow(
      'exactly one version',
    );
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
    expect(() => cohortNativeVersions(root, '2.0.0', '1.0.0')).toThrow('regressed');
  });
  it('keeps selected native versions within an npm major and aligns them at a new x.0.0 major', () => {
    const root = selectorFixture();
    for (const [path, text] of prepareNativeSelection(root, '3.2.0', selectorVersions('3.1.0', '3.0.2')))
      write(root, path, text);
    for (const [target, published] of [
      ['3.2.1', '3.2.0'],
      ['3.3.0', '3.2.0'],
      ['3.2.0', '3.1.0'],
    ])
      expect(cohortNativeVersions(root, target!, published!)).toEqual(selectorVersions('3.1.0', '3.0.2'));
    expect(cohortNativeVersions(root, '4.0.0', '3.2.0')).toEqual(selectorVersions('4.0.0', '4.0.0', '4.0.0'));
    expect(() => cohortNativeVersions(root, '4.1.0', '3.2.0')).toThrow('must start at 4.0.0');
    expect(cohortNativeVersions(temporary(), '4.1.0', '3.2.0')).toEqual({});
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
  it('reads a mixed-version tagged ledger and refuses tagged versions outside the tag major or above the tag', () => {
    const root = temporary(),
      git = init(root);
    commit(root, 'Earlier published source');
    const mixed = publishedAt('3.2.0', { core: '3.1.0', consumer: '3.0.1', language: '3.2.0' }).archives;
    write(root, NATIVE_CURRENT, { format: 'ia.native-release.v1', archives: mixed });
    const published = commit(root, 'Published mixed native versions');
    git('tag', 'v3.2.0');
    expect(nativeBaseline(root)).toEqual({ source: { tag: 'v3.2.0', commit: published }, archives: mixed });
    for (const [tag, version] of [
      ['v3.2.1', '3.3.0'],
      ['v3.2.2', '2.9.0'],
    ]) {
      write(root, NATIVE_CURRENT, {
        format: 'ia.native-release.v1',
        archives: mixed.map((row) => (row.id === 'inventarch/core' ? { ...row, version } : row)),
      });
      commit(root, 'Published ' + tag);
      git('tag', tag!);
      expect(() => nativeBaseline(root)).toThrow('within the npm tag major');
    }
  });
  it('retains the unchanged published ledger but refuses stale baseline and notes on an npm-only future target', () => {
    const { root, retained, published } = realNativeReleaseFixture();
    expect(nativeRelease(root, 'check').changed).toEqual([]);
    write(root, NATIVE_CURRENT, { ...retained, notesSha256: 'a'.repeat(64) });
    expect(() => nativeRelease(root, 'check')).toThrow('Published native ledger');
    write(root, NATIVE_CURRENT, retained);
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual(retained);
    write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
    for (const [path, text] of prepareNativeSelection(root, '3.0.1', cohortNativeVersions(root, '3.0.1', '3.0.0')))
      write(root, path, text);
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
    expect(Object.values(result.versions)).toEqual(Array(12).fill('3.0.0'));
    expect(result.archives).toEqual(retained.archives);
  }, 120_000);
});

/** A revised work-system declaration pair changes work-system and the language directly. */
const WORK_CONSUMERS = [
  'agent-composition-system',
  'authoring-system',
  'hook-authoring-system',
  'learning-system',
  'template-system',
];
const WORK_CONTROLS = ['agent-system', 'compliance-system', 'governance-system', 'session-system', 'workspace-system'];
function reviseWorkSystem(root: string) {
  for (const path of ['.ia/src/systems/work-system/system.ia', 'examples/public-language/contracts/work-system.ia'])
    write(
      root,
      path,
      readFileSync(resolve(root, path), 'utf8').replace(
        'describes "Public work-system vocabulary contracts"',
        'describes "Public work-system vocabulary contracts, revised"',
      ),
    );
}
const workSystemNotes = (tag: string, commit: string, work: 'patch' | 'minor' = 'minor'): NativeNotes => ({
  format: 'ia.native-release-notes.v1',
  baseline: { tag, commit },
  changes: [
    { id: 'inventarch/work-system', bump: work, summary: 'The system description is revised.' },
    { id: 'inventarch/language', bump: 'patch', summary: 'Embeds the revised work-system declaration.' },
    ...WORK_CONSUMERS.map((id) => ({ id: 'inventarch/' + id, bump: 'patch' as const, summary: 'Dependency moves.' })),
  ],
});
/** The full twelve-identity selection for a work-system change: controls, dependency consumers and work-system. */
const workSystemVersions = (control: string, consumer: string, work: string) => ({
  ...Object.fromEntries(WORK_CONTROLS.map((id) => ['inventarch/' + id, control])),
  ...Object.fromEntries([...WORK_CONSUMERS, 'language'].map((id) => ['inventarch/' + id, consumer])),
  'inventarch/work-system': work,
});

/**
 * Real packing inputs published at a literal npm tag, independent of the checkout's future release target. Native
 * archives default to 3.0.0; `versions` gives a system (or `language`) its own published version.
 */
function realNativeReleaseFixture(
  options: { notesSha256?: string | null; tag?: string; versions?: Record<string, string> } = {},
) {
  const { notesSha256 = null, tag = '3.0.0', versions = {} } = options;
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
    const version = versions[owner.native.system] ?? '3.0.0',
      manifest = owner.owner + '/package.json';
    write(root, manifest, { ...JSON.parse(readFileSync(resolve(root, manifest), 'utf8')), version: tag });
    owner.npmVersion = tag;
    owner.native.version = version;
    for (const path of [
      owner.owner + '/system.ia',
      'examples/public-language/contracts/' + owner.native.system + '.ia',
    ])
      write(
        root,
        path,
        readFileSync(resolve(root, path), 'utf8').replace(/^  version "[^"\r\n]+"/m, `  version "${version}"`),
      );
  }
  const language = versions['language'] ?? '3.0.0';
  write(root, NATIVE_SYSTEM_POLICY, selected);
  write(root, NATIVE_LANGUAGE_POLICY, { format: 'ia.public-native-versions.v1', language });
  const composition = JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'));
  composition.dependencies.find((row: { id: string }) => row.id === 'inventarch/language').range = '^' + language;
  write(root, NATIVE_COMPOSITION_FIXTURE, composition);
  write(root, 'releases/current.json', releasePolicy(tag, '2.9.0', prior));
  const retained = {
    format: 'ia.native-release.v1',
    baseline: { tag: 'v2.9.0', commit: prior },
    notesSha256,
    archives: nativeArchives(root),
  };
  write(root, NATIVE_CURRENT, retained);
  const published = commit(root, 'Publish fixture ' + tag);
  git('tag', 'v' + tag);
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

/** Each owner's declaration pair, `native.version`, the language policy and the fixture range follow `versions`. */
function expectNativeWriterSelection(
  root: string,
  before: Map<string, Buffer | null>,
  npm: string,
  versions: Readonly<Record<string, string>>,
) {
  // All eleven owners have paired declarations; both policy files and the composition fixture are selectors.
  expect(before.size).toBe(26);
  const selected = JSON.parse(before.get(NATIVE_SYSTEM_POLICY)!.toString('utf8'));
  expect(selected.owners).toHaveLength(11);
  for (const owner of selected.owners) {
    const from = owner.native.version,
      to = versions[owner.native.id]!;
    for (const path of [
      owner.owner + '/system.ia',
      'examples/public-language/contracts/' + owner.native.system + '.ia',
    ])
      expect(readFileSync(resolve(root, path), 'utf8')).toBe(
        before.get(path)!.toString('utf8').replace(`  version "${from}"`, `  version "${to}"`),
      );
    owner.npmVersion = npm;
    owner.native.version = to;
  }
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8'))).toEqual(selected);
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_LANGUAGE_POLICY), 'utf8'))).toEqual({
    format: 'ia.public-native-versions.v1',
    language: versions['inventarch/language'],
  });
  const composition = JSON.parse(before.get(NATIVE_COMPOSITION_FIXTURE)!.toString('utf8'));
  composition.dependencies.find((row: { id: string }) => row.id === 'inventarch/language').range =
    '^' + versions['inventarch/language'];
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'))).toEqual(composition);
}
const everyArchive = (rows: NativeArchive[], version: string) =>
  Object.fromEntries(rows.map((row) => [row.id, version]));

describe('native release writer', () => {
  it.each([
    ['3.0.0', '3.0.1'],
    ['3.0.0', '3.1.0'],
    ['3.1.0', '3.2.0'],
    ['3.14.0', '3.15.0'],
  ])(
    'keeps unchanged 3.0.0 archives, their published bytes and selectors when npm %s advances only to %s',
    (tag, target) => {
      const { root, retained, published } = realNativeReleaseFixture({ tag });
      write(root, 'releases/current.json', releasePolicy(target, tag, published));
      const before = nativeWriterSnapshot(root),
        result = nativeRelease(root, 'write');
      expect(result).toMatchObject({ target, direct: [], changed: [] });
      expect(result.archives).toEqual(retained.archives);
      expectNativeWriterSelection(root, before, target, everyArchive(retained.archives, '3.0.0'));
      expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual({
        format: 'ia.native-release.v1',
        baseline: { tag: 'v' + tag, commit: published },
        notesSha256: null,
        archives: retained.archives,
      });
      expect(nativeRelease(root, 'check').archives).toEqual(retained.archives);
    },
    120_000,
  );

  it('bumps a directly changed archive and its dependency-only consumers independently, keeping truly unchanged archives', () => {
    const { root, retained, published } = realNativeReleaseFixture({ tag: '3.1.0' });
    reviseWorkSystem(root);
    write(root, 'releases/current.json', releasePolicy('3.2.0', '3.1.0', published));
    expect(() => nativeRelease(root, 'plan')).toThrow('latest published tag');
    const notes = workSystemNotes('v3.1.0', published);
    write(root, NATIVE_NOTES, {
      ...notes,
      changes: notes.changes.filter((row) => !row.id.endsWith('/learning-system')),
    });
    expect(() => nativeRelease(root, 'plan')).toThrow(
      'inventarch/learning-system: changed archive requires its own bump',
    );
    write(root, NATIVE_NOTES, notes);
    const result = nativeRelease(root, 'write');
    expect(result.direct).toEqual(['inventarch/language', 'inventarch/work-system']);
    expect(result.changed).toEqual(
      [...WORK_CONSUMERS, 'language', 'work-system'].map((id) => 'inventarch/' + id).sort(),
    );
    expect(result.versions).toEqual(workSystemVersions('3.0.0', '3.0.1', '3.1.0'));
    for (const row of result.archives) {
      const prior = retained.archives.find((entry) => entry.id === row.id)!;
      if (WORK_CONTROLS.includes(row.id.slice('inventarch/'.length))) expect(row).toEqual(prior);
      else expect(row.archive).not.toBe(prior.archive);
    }
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
    // A tampered or stale ledger refuses after a per-archive write, as it does after an aligned one.
    const written = JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'));
    for (const wrong of [
      {
        ...written,
        archives: written.archives.map((row: NativeArchive) =>
          row.id === 'inventarch/work-system' ? { ...row, version: '3.0.0' } : row,
        ),
      },
      {
        ...written,
        archives: written.archives.map((row: NativeArchive) =>
          row.id === 'inventarch/authoring-system' ? { ...row, archive: 'f'.repeat(64) } : row,
        ),
      },
      { ...written, baseline: { tag: 'v3.0.0', commit: published } },
    ]) {
      write(root, NATIVE_CURRENT, wrong);
      expect(() => nativeRelease(root, 'check')).toThrow('ledger is stale');
    }
    write(root, NATIVE_CURRENT, written);
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
    write(root, NATIVE_NOTES, { ...notes, baseline: { tag: 'v3.0.0', commit: published } });
    expect(() => nativeRelease(root, 'check')).toThrow('latest published tag');
  }, 120_000);

  it('refuses a native selection while npm stays at its published version', () => {
    const { root, published } = realNativeReleaseFixture({ tag: '3.2.0' });
    reviseWorkSystem(root);
    write(root, NATIVE_NOTES, workSystemNotes('v3.2.0', published));
    const before = nativeWriterSnapshot(root);
    expect(() => nativeRelease(root, 'write')).toThrow(/npm 3\.2\.0 -> 3\.2\.0 \(none\) does not satisfy native/);
    expect(nativeWriterSnapshot(root)).toEqual(before);
    expect(() => nativeRelease(root, 'check')).toThrow(/\(none\) does not satisfy native/);
  }, 120_000);

  it('restores every selector after a failed per-archive write within a major', () => {
    const { root, git, published } = realNativeReleaseFixture({ tag: '3.1.0' });
    reviseWorkSystem(root);
    write(root, NATIVE_NOTES, workSystemNotes('v3.1.0', published));
    write(root, 'releases/current.json', releasePolicy('3.2.0', '3.1.0', published));
    const before = nativeWriterSnapshot(root),
      status = git('status', '--porcelain'),
      realArchives = nativeArchiveModule.nativeArchives,
      failure = new Error('Fixture: post-write archive packing failed');
    let reachedPostWrite = false;
    const archiveSpy = vi.spyOn(nativeArchiveModule, 'nativeArchives').mockImplementation((candidate, overrides) => {
      if (candidate === root && overrides === undefined) {
        reachedPostWrite = true;
        // Only the changed archives' declarations moved; the controls' selectors kept their bytes.
        expectNativeWriterSelection(root, before, '3.2.0', workSystemVersions('3.0.0', '3.0.1', '3.1.0'));
        throw failure;
      }
      return realArchives(candidate, overrides);
    });
    try {
      expect(() => nativeRelease(root, 'write')).toThrow(failure);
      expect(reachedPostWrite).toBe(true);
      expect(nativeWriterSnapshot(root)).toEqual(before);
      expect(git('status', '--porcelain')).toBe(status);
    } finally {
      archiveSpy.mockRestore();
    }
  }, 120_000);

  it('aligns a mixed published major-3 ledger to 4.0.0, then keeps the unchanged 4.0.0 archives for npm 4.1.0', () => {
    const { root, git, retained, published } = realNativeReleaseFixture({
      tag: '3.2.0',
      versions: { 'agent-system': '3.1.0', 'workspace-system': '3.0.2', language: '3.2.0' },
    });
    expect(nativeBaseline(root)).toEqual({ source: { tag: 'v3.2.0', commit: published }, archives: retained.archives });
    expect([...new Set(retained.archives.map((row) => row.version))].sort()).toEqual([
      '3.0.0',
      '3.0.2',
      '3.1.0',
      '3.2.0',
    ]);
    expect(nativeRelease(root, 'check').changed).toEqual([]);
    write(root, 'releases/current.json', releasePolicy('4.0.0', '3.2.0', published));
    const before = nativeWriterSnapshot(root),
      aligned = nativeRelease(root, 'write'),
      four = everyArchive(retained.archives, '4.0.0');
    expect(aligned).toMatchObject({ alignment: '4.0.0', direct: [], changed: [], versions: four });
    expectNativeWriterSelection(root, before, '4.0.0', four);
    expect(nativeRelease(root, 'check').archives).toEqual(aligned.archives);
    const tagged = commit(root, 'Publish 4.0.0');
    git('tag', 'v4.0.0');
    expect(nativeRelease(root, 'check')).toMatchObject({ alignment: null, changed: [], versions: four });
    write(root, 'releases/current.json', releasePolicy('4.1.0', '4.0.0', tagged));
    const next = nativeRelease(root, 'write');
    expect(next).toMatchObject({ alignment: null, changed: [], versions: four });
    expect(next.archives).toEqual(aligned.archives);
    // A changed archive follows its own cadence after the reset, while unchanged archives keep 4.0.0 and their bytes.
    reviseWorkSystem(root);
    write(root, NATIVE_NOTES, workSystemNotes('v4.0.0', tagged, 'patch'));
    const changed = nativeRelease(root, 'write');
    expect(changed).toMatchObject({ alignment: null, versions: workSystemVersions('4.0.0', '4.0.1', '4.0.1') });
    for (const row of changed.archives)
      if (WORK_CONTROLS.includes(row.id.slice('inventarch/'.length)))
        expect(row).toEqual(aligned.archives.find((entry) => entry.id === row.id));
    expect(nativeRelease(root, 'check').versions).toEqual(changed.versions);
  }, 120_000);

  it('preserves the complete historical ledger when writing an unchanged published target', () => {
    const historicalNotes = 'd'.repeat(64),
      { root, prior, retained } = realNativeReleaseFixture({ notesSha256: historicalNotes }),
      before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    expect(result.target).toBe('3.0.0');
    expect(result.changed).toEqual([]);
    expect(nativeWriterSnapshot(root)).toEqual(before);
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual(retained);
    expect(retained.baseline).toEqual({ tag: 'v2.9.0', commit: prior });
    expect(retained.notesSha256).toBe(historicalNotes);
  }, 120_000);

  it('restores every byte when a read-only selector refuses a write partway through', () => {
    const { root, git, published } = realNativeReleaseFixture();
    write(root, 'releases/current.json', releasePolicy('4.0.0', '3.0.0', published));
    const before = nativeWriterSnapshot(root),
      status = git('status', '--porcelain'),
      paths = [...before.keys()];
    // The writer moves the owners' declaration pairs first; the 13th of 26 paths fails after twelve writes.
    expect(paths[12]).toBe('.ia/src/systems/learning-system/system.ia');
    const locked = resolve(root, paths[12]!);
    chmodSync(locked, 0o444);
    try {
      expect(() => nativeRelease(root, 'write')).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(nativeWriterSnapshot(root)).toEqual(before);
    expect(git('status', '--porcelain')).toBe(status);
  }, 120_000);

  it('collects a per-archive native selection after versioning, so strict and native checks pass with no refresh', async () => {
    const { root, published } = realNativeReleaseFixture({ tag: '3.1.0' });
    const projects = () =>
      JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8')).owners.map((owner: { owner: string }) => ({
        directory: owner.owner,
        manifest: JSON.parse(readFileSync(resolve(root, owner.owner + '/package.json'), 'utf8')),
      }));
    reviseWorkSystem(root);
    write(root, 'releases/pending/work-system-description.json', {
      format: 'ia.npm-change-note.v1',
      bump: 'minor',
      title: 'Revise the work-system description',
      summary: 'The work-system declaration describes its contracts more precisely.',
      packages: ['@inventarch/work-system'],
      paths: ['.ia/src/systems/work-system/'],
    });
    write(root, NATIVE_NOTES, workSystemNotes('v3.1.0', published));
    commit(root, 'Revise work-system');
    mkdirSync(resolve(root, 'releases/changesets'), { recursive: true });
    expect(await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false })).toMatchObject({
      action: 'version',
      version: '3.2.0',
    });
    commit(root, 'Prepare 3.2.0');
    const selection = nativeRelease(root, 'write');
    expect(selection.versions).toEqual(workSystemVersions('3.0.0', '3.0.1', '3.1.0'));
    commit(root, 'Select native versions');
    const collected = collectChanges(root, projects()).entry,
      consumers = WORK_CONSUMERS.map((id) => `.ia/src/systems/${id}/system.ia`);
    expect(collected.changes.find(({ id }) => id === 'cohort-alignment')!.paths).toEqual(
      expect.arrayContaining(consumers),
    );
    for (const path of consumers)
      expect(collected.coverage.find((row) => row.path === path)).toMatchObject({
        cohortOnly: true,
        change: 'cohort-alignment',
      });
    commit(root, 'Collect release coverage');
    expect(() => releaseChanges(root, projects())).not.toThrow();
    expect(nativeRelease(root, 'check').versions).toEqual(selection.versions);
  }, 120_000);

  it.each([true, false])(
    'restores exact selector bytes after a post-write packing failure (existing ledger=%s)',
    (hasLedger) => {
      const { root, git, retained, published } = realNativeReleaseFixture();
      write(root, 'releases/current.json', releasePolicy('4.0.0', '3.0.0', published));
      if (!hasLedger) rmSync(resolve(root, NATIVE_CURRENT));
      const before = nativeWriterSnapshot(root),
        status = git('status', '--porcelain'),
        realArchives = nativeArchiveModule.nativeArchives,
        failure = new Error('Fixture: post-write archive packing failed');
      let reachedPostWrite = false;
      const archiveSpy = vi.spyOn(nativeArchiveModule, 'nativeArchives').mockImplementation((candidate, overrides) => {
        if (candidate === root && overrides === undefined) {
          reachedPostWrite = true;
          expectNativeWriterSelection(root, before, '4.0.0', everyArchive(retained.archives, '4.0.0'));
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
