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
import { fileSymlinksAvailable } from '../testing/report.js';
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
  NATIVE_NOTES,
  type NativeBaseline,
  type NativeNotes,
} from './native-version.js';
import {
  NATIVE_COMPOSITION_FIXTURE,
  NATIVE_LANGUAGE_POLICY,
  NATIVE_SYSTEM_POLICY,
  nativeMajorAlignment,
  nativeNotesPending,
  nativeVersionOnly,
  prepareNativeSelection,
  readNativeReleaseTarget,
  releaseNativeVersions,
  selectedNativeVersions,
} from './native-selectors.mjs';
import { releaseChanges, releaseStatus } from '../distribution/release-changes.mjs';
import { pullRequestBody, versionRelease } from '../distribution/release-version.mjs';

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
/** The selector fixture's three native identities, all at one version. */
const allNatives = (version: string) => ({
  'inventarch/language': version,
  'inventarch/agent-system': version,
  'inventarch/session-system': version,
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/**
 * The exact code and message of a refusal; a call that does not refuse fails the test. Node appends a value diff to a
 * failed equality assertion's own message, so only its first line, the authored text, is compared.
 */
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message: message.split('\n')[0] };
  }
  throw new Error('Expected a refusal');
};
/** A published npm tag whose native archives carry their own versions (default 3.0.0). */
const publishedAt = (tag: string, versions: Record<string, string> = {}): NativeBaseline => ({
  source: { tag: 'v' + tag, commit: 'f'.repeat(40) },
  archives: archives.map((row) => ({ ...row, version: versions[row.id.slice('inventarch/'.length)] ?? row.version })),
});

describe('content-driven native release selection', () => {
  it.each([
    ['3.1.0', '3.2.0'],
    ['3.14.0', '3.15.0'],
  ])('keeps every unchanged 3.0.0 archive when npm %s advances only to %s', (tag, target) => {
    const base = publishedAt(tag),
      plan = planNativeVersions(base, base.archives, target);
    expect(plan).toEqual({
      versions: Object.fromEntries(archives.map((row) => [row.id, '3.0.0'])),
      direct: [],
      changed: [],
    });
  });
  it.each(['3.0.1', '3.1.0'])('keeps every unchanged archive at its published version for npm target %s', (target) => {
    const plan = planNativeVersions(baseline, archives, target, notes(['core'], 'major'));
    expect(plan.versions).toEqual(Object.fromEntries(archives.map((row) => [row.id, '3.0.0'])));
    expect(plan.changed).toEqual([]);
  });
  it('aligns every archive, changed or not, to the x.0.0 of a major npm target', () => {
    const plan = planNativeVersions(baseline, archives, '4.0.0');
    expect(plan.versions).toEqual(Object.fromEntries(archives.map((row) => [row.id, '4.0.0'])));
    expect(plan.changed).toEqual([]);
  });
  it('aligns a new npm major only at its x.0.0 and refuses a cross-major target past it', () => {
    const mixed = publishedAt('3.5.0', { core: '3.2.0', consumer: '3.0.1', language: '3.4.0' });
    expect(nativeMajorAlignment('4.0.0', '3.5.0')).toBe('4.0.0');
    expect(nativeMajorAlignment('3.6.0', '3.5.0')).toBeNull();
    expect(Object.values(planNativeVersions(mixed, mixed.archives, '4.0.0').versions)).toEqual(Array(4).fill('4.0.0'));
    for (const target of ['4.0.1', '4.1.0', '4.2.3'])
      expect(refusal(() => planNativeVersions(mixed, mixed.archives, target))).toEqual({
        code: 'ERR_ASSERTION',
        message: `A new npm major aligns native archives to 4.0.0; target ${target} skips it`,
      });
    // Skipping a whole major still lands on the target major's x.0.0.
    expect(refusal(() => planNativeVersions(mixed, mixed.archives, '5.1.0'))).toEqual({
      code: 'ERR_ASSERTION',
      message: 'A new npm major aligns native archives to 5.0.0; target 5.1.0 skips it',
    });
    expect(Object.values(planNativeVersions(mixed, mixed.archives, '5.0.0').versions)).toEqual(Array(4).fill('5.0.0'));
  });
  it('aligns the immutable npm2/native1.2 inventory to the upcoming3 target without another note target', () => {
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
  it('requires impact notes for changed content and exact dependency consumers, and moves only those archives', () => {
    const changed = archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
    const plan = planNativeVersions(baseline, changed, '3.1.0', notes(['core', 'consumer', 'language'], 'minor'));
    expect(plan.direct).toEqual(['inventarch/core']);
    expect(plan.changed).toEqual(['inventarch/consumer', 'inventarch/core', 'inventarch/language']);
    expect(plan.versions).toEqual({
      'inventarch/core': '3.1.0',
      'inventarch/consumer': '3.1.0',
      'inventarch/unrelated': '3.0.0',
      'inventarch/language': '3.1.0',
    });
    // Each changed archive moves by its own note from its own published version, below a larger npm target.
    expect(
      planNativeVersions(baseline, changed, '3.2.0', {
        ...notes(['core'], 'minor'),
        changes: [...notes(['core'], 'minor').changes, ...notes(['consumer', 'language']).changes],
      }).versions,
    ).toEqual({
      'inventarch/core': '3.1.0',
      'inventarch/consumer': '3.0.1',
      'inventarch/unrelated': '3.0.0',
      'inventarch/language': '3.0.1',
    });
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
  it('closes dependency cycles and keeps disconnected identities at their published version', () => {
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
  it('lets an archive keep its own version line across npm releases within a major', () => {
    // A published 3.2.0 cohort whose natives moved independently: content decides, never the npm number.
    const independent = {
      source: { tag: 'v3.2.0', commit: 'e'.repeat(40) },
      archives: [
        { ...pin('core'), version: '3.1.2' },
        pin('unrelated'),
        { ...pin('language', ['core']), version: '3.1.2' },
      ],
    };
    const changed = independent.archives.map((row) =>
      row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row,
    );
    expect(
      planNativeVersions(independent, changed, '3.2.1', {
        ...notes(['core', 'language']),
        baseline: independent.source,
      }).versions,
    ).toEqual({ 'inventarch/core': '3.1.3', 'inventarch/unrelated': '3.0.0', 'inventarch/language': '3.1.3' });
    expect(Object.values(planNativeVersions(independent, independent.archives, '4.0.0').versions)).toEqual(
      Array(3).fill('4.0.0'),
    );
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
  it('moves only npm versions when no native selection is given, and the language range with the language', () => {
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
    write(root, path, descriptor);
    const kept = prepareNativeSelection(root, '3.1.0');
    expect(JSON.parse(kept.get(path)!).dependencies[0].range).toBe('^3.0.0');
    expect(JSON.parse(kept.get(NATIVE_LANGUAGE_POLICY)!).language).toBe('3.0.0');
    expect(
      JSON.parse(kept.get(NATIVE_SYSTEM_POLICY)!).owners.map(
        (row: { npmVersion: string; native: { version: string } }) => [row.npmVersion, row.native.version],
      ),
    ).toEqual([
      ['3.1.0', '3.0.0'],
      ['3.1.0', '3.0.0'],
    ]);
    for (const [file, text] of kept)
      if (file.endsWith('.ia')) expect(text).toBe(readFileSync(resolve(root, file), 'utf8'));
    expect(selectedNativeVersions(root)).toEqual({
      'inventarch/language': '3.0.0',
      'inventarch/agent-system': '3.0.0',
      'inventarch/session-system': '3.0.0',
    });
    const mixed = prepareNativeSelection(root, '3.1.0', {
      'inventarch/language': '3.0.1',
      'inventarch/agent-system': '3.0.1',
      'inventarch/session-system': '3.0.0',
    });
    expect(JSON.parse(mixed.get(path)!).dependencies[0].range).toBe('^3.0.1');
    expect(mixed.get('.ia/src/systems/agent-system/system.ia')).toContain('version "3.0.1"');
    expect(mixed.get('.ia/src/systems/session-system/system.ia')).toContain('version "3.0.0"');
    expect(() => prepareNativeSelection(root, '3.1.0', { 'inventarch/language': '3.0.1' })).toThrow('inventory');
    const lower = {
      'inventarch/language': '2.9.0',
      'inventarch/agent-system': '3.0.0',
      'inventarch/session-system': '3.0.0',
    };
    expect(() => prepareNativeSelection(root, '3.1.0', lower)).toThrow('regressed');
    // The native writer lowers an unpublished selection; it enforces the published floor itself.
    const lowered = prepareNativeSelection(root, '3.1.0', lower, { lowerSelected: true });
    expect(JSON.parse(lowered.get(NATIVE_LANGUAGE_POLICY)!).language).toBe('2.9.0');
    expect(JSON.parse(lowered.get(path)!).dependencies[0].range).toBe('^2.9.0');
    expect(() => prepareNativeSelection(root, '2.0.0', lower, { lowerSelected: true })).toThrow(
      'npm version regressed',
    );
  });
  it('selects natives for an npm release: aligned to a new major, otherwise as currently selected', () => {
    const root = selectorFixture();
    expect(releaseNativeVersions(root, '3.0.0', '3.0.1')).toEqual(selectedNativeVersions(root));
    expect(releaseNativeVersions(root, '3.0.0', '3.1.0')).toEqual(selectedNativeVersions(root));
    expect(releaseNativeVersions(root, '3.2.0', '4.0.0')).toEqual({
      'inventarch/language': '4.0.0',
      'inventarch/agent-system': '4.0.0',
      'inventarch/session-system': '4.0.0',
    });
    expect(releaseNativeVersions(temporary(), '3.0.0', '4.0.0')).toBeUndefined();
    // The shared selector the npm versioner uses refuses the same target; a root without a native surface ignores it.
    expect(refusal(() => releaseNativeVersions(root, '3.2.0', '4.1.0'))).toEqual({
      code: 'ERR_ASSERTION',
      message: 'A new npm major aligns native archives to 4.0.0; target 4.1.0 skips it',
    });
    expect(releaseNativeVersions(temporary(), '3.2.0', '4.1.0')).toBeUndefined();
    expect(nativeNotesPending(root, '3.0.0')).toBe(false);
    write(root, 'releases/native/notes.json', {
      format: 'ia.native-release-notes.v1',
      baseline: { tag: 'v3.0.0', commit: 'f'.repeat(40) },
      changes: [{ id: 'inventarch/agent-system', bump: 'patch', summary: 'Reviewed.' }],
    });
    expect(nativeNotesPending(root, '3.0.0')).toBe(true);
    expect(nativeNotesPending(root, '3.0.1')).toBe(false);
    write(root, 'releases/native/notes.json', {
      format: 'ia.native-release-notes.v1',
      baseline: { tag: 'v3.0.0', commit: 'f'.repeat(40) },
      changes: [],
    });
    expect(nativeNotesPending(root, '3.0.0')).toBe(false);
  });
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
    const after = prepareNativeSelection(root, target, allNatives(target)).get(path);
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
      writes = prepareNativeSelection(root, '3.1.0', allNatives('3.1.0'));
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
  it('reads a mixed-version tagged ledger and refuses versions outside the tag major or above the tag', () => {
    const root = temporary(),
      git = init(root);
    commit(root, 'Earlier published source');
    // In bounds on both edges: the tag's own x.0.0 and the tag itself.
    const mixed = publishedAt('3.2.0', { core: '3.1.0', consumer: '3.0.1', language: '3.2.0' }).archives;
    write(root, NATIVE_CURRENT, { format: 'ia.native-release.v1', archives: mixed });
    const published = commit(root, 'Published mixed native versions');
    git('tag', 'v3.2.0');
    expect(nativeBaseline(root)).toEqual({ source: { tag: 'v3.2.0', commit: published }, archives: mixed });
    for (const [tag, version, bound] of [
      ['v3.2.1', '3.2.2', 'at or below 3.2.1'],
      ['v3.2.2', '2.9.9', 'at or below 3.2.2'],
      ['v3.2.3', '4.0.0', 'at or below 3.2.3'],
    ] as const) {
      write(root, NATIVE_CURRENT, {
        format: 'ia.native-release.v1',
        archives: mixed.map((row) => (row.id === 'inventarch/core' ? { ...row, version } : row)),
      });
      commit(root, 'Published ' + tag);
      git('tag', tag);
      expect(refusal(() => nativeBaseline(root))).toEqual({
        code: 'ERR_ASSERTION',
        message: `inventarch/core@${version}: the ${tag} native ledger must stay within major 3 and ${bound}`,
      });
    }
    // The tag itself is the upper edge.
    write(root, NATIVE_CURRENT, {
      format: 'ia.native-release.v1',
      archives: mixed.map((row) => (row.id === 'inventarch/core' ? { ...row, version: '3.2.4' } : row)),
    });
    commit(root, 'Published v3.2.4');
    git('tag', 'v3.2.4');
    expect(nativeBaseline(root).archives.find((row) => row.id === 'inventarch/core')!.version).toBe('3.2.4');
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
    expect(Object.values(result.versions)).toEqual(Array(12).fill('3.0.0'));
  }, 120_000);
  it('reads a published ledger whose native versions moved independently of the npm tag', () => {
    const root = temporary(),
      git = init(root),
      previous = commit(root, 'Earlier published source');
    const independent = archives.map((row) => ({ ...row, version: row.id === 'inventarch/core' ? '3.0.1' : '3.0.0' }));
    write(root, 'releases/current.json', releasePolicy('3.1.0', '3.0.0', previous));
    write(root, NATIVE_CURRENT, { format: 'ia.native-release.v1', archives: independent });
    commit(root, 'Published 3.1.0 with one native patch');
    git('tag', 'v3.1.0');
    expect(nativeBaseline(root)).toMatchObject({ source: { tag: 'v3.1.0' }, archives: independent });
  });
});

/**
 * Real packing inputs published at a literal npm tag (default 3.0.0), independent of the checkout's release target.
 * Every native archive is published at 3.0.0 unless `versions` gives a system (or `language`) its own version.
 */
function realNativeReleaseFixture(
  options: { notesSha256?: string | null; tag?: string; versions?: Record<string, string> } = {},
) {
  const { notesSha256: historicalNotesSha256 = null, tag = '3.0.0', versions = {} } = options;
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
  for (const [path, text] of prepareNativeSelection(root, tag)) write(root, path, text);
  const retained = {
    format: 'ia.native-release.v1',
    baseline: { tag: 'v2.9.0', commit: prior },
    notesSha256: historicalNotesSha256,
    archives: nativeArchives(root),
  };
  write(root, NATIVE_CURRENT, retained);
  const published = commit(root, 'Publish fixture ' + tag);
  git('tag', 'v' + tag);
  return { root, git, prior, retained, published };
}

/** A revised work-system declaration pair changes work-system and the language directly, and these consumers. */
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
/** The twelve-identity selection for a work-system change: controls, dependency consumers with the language, work. */
const workSystemVersions = (control: string, consumer: string, work: string) => ({
  ...Object.fromEntries(WORK_CONTROLS.map((id) => ['inventarch/' + id, control])),
  ...Object.fromEntries([...WORK_CONSUMERS, 'language'].map((id) => ['inventarch/' + id, consumer])),
  'inventarch/work-system': work,
});

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

/** The writer's selection: every npm version at `npm`, and each native at `natives` (one version by default). */
function expectNativeWriterSelection(
  root: string,
  before: Map<string, Buffer | null>,
  npm: string,
  natives: string | ((id: string) => string) | Readonly<Record<string, string>> = npm,
) {
  const native =
    typeof natives === 'string'
      ? () => natives
      : typeof natives === 'function'
        ? natives
        : (id: string) => natives[id]!;
  // All eleven owners have paired declarations; both policy files and the composition fixture also move.
  expect(before.size).toBe(26);
  const selected = JSON.parse(before.get(NATIVE_SYSTEM_POLICY)!.toString('utf8'));
  expect(selected.owners).toHaveLength(11);
  for (const owner of selected.owners) {
    owner.npmVersion = npm;
    owner.native.version = native(owner.native.id);
  }
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_SYSTEM_POLICY), 'utf8'))).toEqual(selected);
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_LANGUAGE_POLICY), 'utf8'))).toEqual({
    format: 'ia.public-native-versions.v1',
    language: native('inventarch/language'),
  });
  for (const owner of selected.owners)
    for (const path of [
      owner.owner + '/system.ia',
      'examples/public-language/contracts/' + owner.native.system + '.ia',
    ])
      expect(readFileSync(resolve(root, path), 'utf8')).toBe(
        before
          .get(path)!
          .toString('utf8')
          .replace(/^  version "[^"\r\n]+"/m, `  version "${owner.native.version}"`),
      );
  const composition = JSON.parse(before.get(NATIVE_COMPOSITION_FIXTURE)!.toString('utf8'));
  composition.dependencies.find((row: { id: string }) => row.id === 'inventarch/language').range =
    '^' + native('inventarch/language');
  expect(JSON.parse(readFileSync(resolve(root, NATIVE_COMPOSITION_FIXTURE), 'utf8'))).toEqual(composition);
}

describe('native release writer', () => {
  it('keeps every unchanged native version and writes a fresh twelve-archive ledger for an npm-only 3.0.1', () => {
    const { root, published } = realNativeReleaseFixture();
    write(root, 'releases/current.json', releasePolicy('3.0.1', '3.0.0', published));
    const before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    expect(result.changed).toEqual([]);
    expect(result.target).toBe('3.0.1');
    expect(Object.values(result.versions)).toEqual(Array(12).fill('3.0.0'));
    expectNativeWriterSelection(root, before, '3.0.1', '3.0.0');
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'))).toEqual({
      format: 'ia.native-release.v1',
      baseline: { tag: 'v3.0.0', commit: published },
      notesSha256: null,
      archives: result.archives,
    });
    expect(result.archives).toHaveLength(12);
    expect(result.archives.map((row) => row.version)).toEqual(Array(12).fill('3.0.0'));
    expect(readFileSync(resolve(root, NATIVE_CURRENT))).not.toEqual(before.get(NATIVE_CURRENT));
    expect(nativeRelease(root, 'check').archives).toEqual(result.archives);
  }, 120_000);

  // Planner cases cover the smaller within-major boundaries; one real pack pins retained bytes.
  it.each([['3.14.0', '3.15.0']])(
    'keeps unchanged 3.0.0 archives and their published bytes when npm %s advances only to %s',
    (tag, target) => {
      const { root, retained, published } = realNativeReleaseFixture({ tag });
      write(root, 'releases/current.json', releasePolicy(target, tag, published));
      const before = nativeWriterSnapshot(root),
        result = nativeRelease(root, 'write');
      expect(result).toMatchObject({ target, direct: [], changed: [] });
      expect(result.archives).toEqual(retained.archives);
      expectNativeWriterSelection(root, before, target, '3.0.0');
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

  it('moves a changed archive and its dependency-only consumers on their own lines and refuses a tampered ledger', () => {
    const { root, retained, published } = realNativeReleaseFixture({ tag: '3.1.0' });
    reviseWorkSystem(root);
    write(root, 'releases/current.json', releasePolicy('3.2.0', '3.1.0', published));
    write(root, NATIVE_NOTES, workSystemNotes('v3.1.0', published));
    const result = nativeRelease(root, 'write');
    expect(result.direct).toEqual(['inventarch/language', 'inventarch/work-system']);
    expect(result.versions).toEqual(workSystemVersions('3.0.0', '3.0.1', '3.1.0'));
    // The controls keep their published bytes; every other archive was repacked at its own new version.
    for (const row of result.archives) {
      const prior = retained.archives.find((entry) => entry.id === row.id)!;
      if (WORK_CONTROLS.includes(row.id.slice('inventarch/'.length))) expect(row).toEqual(prior);
      else expect(row.archive).not.toBe(prior.archive);
    }
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
    const written = JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8'));
    const tamper = (id: string, field: Partial<NativeArchive>) => ({
      ...written,
      archives: written.archives.map((row: NativeArchive) => (row.id === id ? { ...row, ...field } : row)),
    });
    // A changed archive's version, a repacked consumer's archive digest, a control's manifest digest and the ledger
    // baseline; the published-ledger test above covers the notes digest.
    for (const wrong of [
      tamper('inventarch/work-system', { version: '3.0.0' }),
      tamper('inventarch/authoring-system', { archive: 'f'.repeat(64) }),
      tamper('inventarch/agent-system', { manifest: 'e'.repeat(64) }),
      { ...written, baseline: { tag: 'v3.0.0', commit: published } },
    ]) {
      write(root, NATIVE_CURRENT, wrong);
      expect(refusal(() => nativeRelease(root, 'check'))).toEqual({
        code: 'ERR_ASSERTION',
        message: 'Native archive ledger is stale; run pnpm native:version --write',
      });
    }
    write(root, NATIVE_CURRENT, written);
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
  }, 240_000);

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
    // The unchanged post-publication check, over a mixed published ledger.
    expect(nativeRelease(root, 'check').changed).toEqual([]);
    write(root, 'releases/current.json', releasePolicy('4.0.0', '3.2.0', published));
    const before = nativeWriterSnapshot(root),
      aligned = nativeRelease(root, 'write'),
      four = Object.fromEntries(retained.archives.map((row) => [row.id, '4.0.0']));
    expect(aligned).toMatchObject({ direct: [], changed: [], versions: four });
    expectNativeWriterSelection(root, before, '4.0.0', four);
    expect(nativeRelease(root, 'check').archives).toEqual(aligned.archives);
    const tagged = commit(root, 'Publish 4.0.0');
    git('tag', 'v4.0.0');
    write(root, 'releases/current.json', releasePolicy('4.1.0', '4.0.0', tagged));
    const next = nativeRelease(root, 'write');
    expect(next).toMatchObject({ direct: [], changed: [], versions: four });
    expect(next.archives).toEqual(aligned.archives);
    // After the reset a changed archive follows its own cadence; unchanged archives keep 4.0.0 and their bytes.
    reviseWorkSystem(root);
    write(root, NATIVE_NOTES, workSystemNotes('v4.0.0', tagged, 'patch'));
    const changed = nativeRelease(root, 'write');
    expect(changed.versions).toEqual(workSystemVersions('4.0.0', '4.0.1', '4.0.1'));
    for (const row of changed.archives)
      if (WORK_CONTROLS.includes(row.id.slice('inventarch/'.length)))
        expect(row).toEqual(aligned.archives.find((entry) => entry.id === row.id));
    expect(nativeRelease(root, 'check').versions).toEqual(changed.versions);
  }, 360_000);

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
        // Only the changed archives' declarations moved before the failure; the controls kept theirs.
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

  it('restores every changed declaration when a read-only selector refuses a write partway through', () => {
    const { root, git, published } = realNativeReleaseFixture({ tag: '3.1.0' });
    reviseWorkSystem(root);
    write(root, NATIVE_NOTES, workSystemNotes('v3.1.0', published));
    write(root, 'releases/current.json', releasePolicy('3.2.0', '3.1.0', published));
    const before = nativeWriterSnapshot(root),
      status = git('status', '--porcelain');
    // The writer moves every declaration pair and the composition fixture before the system policy.
    const locked = resolve(root, NATIVE_SYSTEM_POLICY);
    chmodSync(locked, 0o444);
    let thrown: unknown;
    try {
      nativeRelease(root, 'write');
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(locked, 0o644);
    }
    // A user who may write a read-only file, such as root, defeats the fixture: say so instead of failing on undefined.
    expect(thrown, 'the read-only system policy must refuse the write; run this test as a non-root user').toBeDefined();
    const { code, syscall, path } = thrown as NodeJS.ErrnoException;
    expect({ code, syscall, path }).toEqual({
      code: process.platform === 'win32' ? 'EPERM' : 'EACCES',
      syscall: 'open',
      path: locked,
    });
    expect(nativeWriterSnapshot(root)).toEqual(before);
    expect(git('status', '--porcelain')).toBe(status);
  }, 120_000);

  it('ends the documented flow green: version, select natives by content, commit, then refresh', async () => {
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
    mkdirSync(resolve(root, 'releases/changesets'), { recursive: true });
    commit(root, 'Revise work-system');
    // 1. The npm versioner moves npm versions only; within a major it leaves native selection to content.
    const versioned = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    expect(versioned).toMatchObject({ action: 'version', version: '3.2.0', nativeRegenerationRequired: true });
    expect(pullRequestBody(root, versioned)).toContain('run `pnpm release:version --write --refresh`');
    expect(selectedNativeVersions(root)).toEqual(workSystemVersions('3.0.0', '3.0.0', '3.0.0'));
    commit(root, 'Prepare 3.2.0');
    // 2. The native writer selects each archive's version from its content and notes.
    const selection = nativeRelease(root, 'write');
    expect(selection.versions).toEqual(workSystemVersions('3.0.0', '3.0.1', '3.1.0'));
    commit(root, 'Select native versions');
    // The changeset predates the selection. The pull-request check refuses its uncovered version-only files before
    // merge, as strict coverage does, until the refresh.
    expect(refusal(() => releaseStatus(root, projects()))).toEqual({
      code: 'ERR_ASSERTION',
      message:
        'Prepared release 3.2.0 does not cover 13 native version file(s): ' +
        '.ia/src/systems/agent-composition-system/system.ia, .ia/src/systems/authoring-system/system.ia, ' +
        '.ia/src/systems/hook-authoring-system/system.ia and 10 more. On the release branch, commit the native ' +
        'changes, then run pnpm release:version --write --refresh and commit its changes, giving each of those new ' +
        'commits the message line "IA-Release-Preparation: v1". On any other branch, wait for v3.2.0 to be tagged, then update from main, retarget native notes to that tag, and regenerate native selections.',
    });
    expect(() => releaseChanges(root, projects())).toThrow(
      expect.objectContaining({
        code: 'ERR_ASSERTION',
        message: expect.stringMatching(/^Changeset coverage is missing or stale for \d+ file\(s\): /),
      }),
    );
    // 3. The documented refresh re-collects coverage, generating alignment for the moved native version fields.
    const refreshed = await versionRelease(root, projects(), {
      write: true,
      registry: null,
      refresh: true,
      sealInputs: false,
    });
    expect(refreshed).toMatchObject({ action: 'refresh', version: '3.2.0' });
    commit(root, 'Refresh 3.2.0');
    expect(releaseStatus(root, projects())).toMatchObject({ state: 'prepared', version: '3.2.0', pendingNotes: [] });
    const { entry } = releaseChanges(root, projects());
    const consumers = WORK_CONSUMERS.map((id) => `.ia/src/systems/${id}/system.ia`);
    expect(entry.changes.find(({ id }) => id === 'cohort-alignment')).toMatchObject({
      paths: expect.arrayContaining(consumers),
      summary:
        'Package version metadata follows the coordinated 3.2.0 release; each native artifact version follows its own archive content.',
    });
    for (const path of consumers)
      expect(entry.coverage.find((row) => row.path === path)).toMatchObject({
        cohortOnly: true,
        change: 'cohort-alignment',
      });
    // Controls keep their published version; nothing else moved them.
    for (const id of WORK_CONTROLS)
      expect(entry.coverage.some((row) => row.path === `.ia/src/systems/${id}/system.ia`)).toBe(false);
    expect(nativeRelease(root, 'check').versions).toEqual(selection.versions);
  }, 240_000);

  it('aligns all twelve archives to an npm-only major 4.0.0', () => {
    const { root, published } = realNativeReleaseFixture();
    write(root, 'releases/current.json', releasePolicy('4.0.0', '3.0.0', published));
    const before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    expect(result.changed).toEqual([]);
    expect(Object.values(result.versions)).toEqual(Array(12).fill('4.0.0'));
    expectNativeWriterSelection(root, before, '4.0.0');
    expect(nativeRelease(root, 'check').archives).toEqual(result.archives);
  }, 120_000);

  it('moves only a changed archive and its consumers by their notes, keeping the rest published', () => {
    const { root, published } = realNativeReleaseFixture();
    write(root, 'releases/current.json', releasePolicy('3.1.0', '3.0.0', published));
    const schema = '.ia/src/systems/learning-system/schemas/observation.schema.ia';
    write(root, schema, readFileSync(resolve(root, schema), 'utf8') + '# A reviewed source edit.\n');
    // learning-system reaches authoring-system, whose consumers are reached in turn, and the language embeds them all.
    const moved = [
      'inventarch/agent-composition-system',
      'inventarch/authoring-system',
      'inventarch/hook-authoring-system',
      'inventarch/language',
      'inventarch/learning-system',
      'inventarch/template-system',
    ];
    const reviewed = (ids: string[], bump: 'patch' | 'minor' = 'patch') =>
      write(root, 'releases/native/notes.json', {
        format: 'ia.native-release-notes.v1',
        baseline: { tag: 'v3.0.0', commit: published },
        changes: ids.map((id) => ({ id, bump, summary: 'Reviewed native change.' })),
      });
    reviewed(moved.slice(1));
    expect(() => nativeRelease(root, 'write')).toThrow('own bump note');
    reviewed(moved);
    const before = nativeWriterSnapshot(root),
      result = nativeRelease(root, 'write');
    // The language archive embeds every public schema, so the schema edit changes its bytes directly too.
    expect(result.direct).toEqual(['inventarch/language', 'inventarch/learning-system']);
    expect(result.changed).toEqual(moved);
    expect(result.versions).toEqual(
      Object.fromEntries(Object.keys(result.versions).map((id) => [id, moved.includes(id) ? '3.0.1' : '3.0.0'])),
    );
    expectNativeWriterSelection(root, before, '3.1.0', (id) => (moved.includes(id) ? '3.0.1' : '3.0.0'));
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
    // Before publication a note's impact can rise and fall again: only the published version is a floor.
    reviewed(moved, 'minor');
    expect(nativeRelease(root, 'write').versions['inventarch/learning-system']).toBe('3.1.0');
    reviewed(moved);
    expect(nativeRelease(root, 'write').versions).toEqual(result.versions);
    expectNativeWriterSelection(root, before, '3.1.0', (id) => (moved.includes(id) ? '3.0.1' : '3.0.0'));
    expect(nativeRelease(root, 'check').versions).toEqual(result.versions);
  }, 360_000);

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
          expectNativeWriterSelection(root, before, '3.0.1', '3.0.0');
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

  it('reads a selected regular file and refuses a missing or directory input as it always has', () => {
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
  });

  // Windows has no FIFOs.
  it.skipIf(process.platform === 'win32')('refuses a FIFO input as not a regular file, as it always has', async () => {
    const root = temporary();
    write(root, '.ia/src/a.ia', 'native source');
    write(root, 'pnpm-workspace.yaml', 'packages: []\n');
    expect((await runBounded('mkfifo', [resolve(root, '.ia/src/fifo.ia')], { timeoutMs: 10_000 })).status).toBe(0);
    expect(() => bundle(root, '.ia/src/fifo.ia', digest(''))).toThrow(
      /^System package input is not a regular file: \.ia\/src\/fifo\.ia$/,
    );
  });

  it('refuses a linked input before reading it', (context) => {
    const root = temporary();
    write(root, '.ia/src/a.ia', 'native source');
    if (!fileSymlinksAvailable()) return context.skip('Windows denied file symlink creation (EPERM)');
    symlinkSync('a.ia', resolve(root, '.ia/src/link.ia'), 'file');
    expect(() => bundle(root, '.ia/src/link.ia', digest('native source'))).toThrow(/^Link\/junction is not allowed: /);
  });

  // chmod 0o000 never denies a read on Windows.
  it.skipIf(process.platform === 'win32')('rethrows the open error for an input it cannot read', () => {
    const root = temporary();
    write(root, '.ia/src/a.ia', 'native source');
    // Root reads a file whatever its mode; the gate has no skip condition for root, so the case returns early instead.
    if (process.getuid?.() === 0) return;
    chmodSync(resolve(root, '.ia/src/a.ia'), 0o000);
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(/^EACCES: permission denied, open /);
  });

  it('refuses an input over 2147483647 bytes before allocating a buffer for it', () => {
    const root = temporary(),
      big = resolve(root, '.ia/src/big.ia');
    write(root, '.ia/src/big.ia', '');
    // A buffer past the bound is never allocated here: the guard refuses first, and without it this spy refuses instead.
    const allocate = Buffer.alloc;
    const allocating = vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      if (args[0] > 0x7fffffff) throw new Error('A buffer past 2147483647 bytes was allocated');
      return Reflect.apply(allocate, Buffer, args) as ReturnType<typeof Buffer.alloc>;
    });
    try {
      const fd = fs.openSync(big, 'r+');
      try {
        // A size-only file: its size is 2147483648 bytes with nothing written. Linux and macOS keep it sparse; NTFS
        // reserves its clusters, so on Windows it takes 2 GiB of disk until the case removes it.
        fs.ftruncateSync(fd, 2147483648);
      } finally {
        fs.closeSync(fd);
      }
      expect(() => bundle(root, '.ia/src/big.ia', digest(''))).toThrow(
        /^System package input exceeds 2147483647 bytes: \.ia\/src\/big\.ia$/,
      );
    } finally {
      allocating.mockRestore();
      rmSync(big, { force: true });
    }
  });
  it('reads at most 2147483647 bytes at a time, so an input reported at that size refuses as changed', () => {
    const root = temporary(),
      target = resolve(root, '.ia/src/a.ia');
    write(root, '.ia/src/a.ia', 'native source');
    const open = fs.openSync,
      fstat = fs.fstatSync,
      read = fs.readSync,
      alloc = Buffer.alloc,
      allocated: number[] = [],
      asked: number[] = [];
    let selected: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args) as number;
      if (String(args[0]) === target) selected = fd;
      return fd;
    });
    // The input's descriptor reports 2147483647 bytes before and after its read.
    vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = Reflect.apply(fstat, fs, args);
      if (args[0] === selected && typeof stat?.size === 'bigint') (stat as { size: bigint }).size = 0x7fffffffn;
      return stat;
    }) as typeof fs.fstatSync);
    // Its buffer, one byte longer, is 2 ** 31 bytes. None is allocated here: a stand-in of that length is handed back
    // and the input's reads are recorded instead of made. The first returns no bytes, so the input refuses as changed.
    vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      if (args[0] <= 0x7fffffff) return Reflect.apply(alloc, Buffer, args) as ReturnType<typeof Buffer.alloc>;
      allocated.push(args[0]);
      const standIn = Reflect.apply(alloc, Buffer, [1]) as ReturnType<typeof Buffer.alloc>;
      return Object.defineProperty(standIn, 'length', { value: args[0] });
    });
    // Parameters<typeof fs.readSync> is the three-argument overload, so the mock takes its arguments untyped: it is called
    // as readSync(fd, buffer, offset, length, position), and only the input's lengths are recorded.
    vi.spyOn(fs, 'readSync').mockImplementation((...args: unknown[]) => {
      if (args[0] !== selected) return Reflect.apply(read, fs, args) as number;
      asked.push(args[3] as number);
      return 0;
    });
    syncBuiltinESMExports();
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(
      /^System package input changed while it was read: \.ia\/src\/a\.ia$/,
    );
    expect(selected).toBeDefined();
    // The read asked for 2147483647 bytes, not 2147483648, which Node refuses.
    expect(allocated).toEqual([2147483648]);
    expect(asked).toEqual([0x7fffffff]);
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
  // The fifth entry, where there is one, says why a case runs only off Windows.
  const changes: [string, 'open' | 'read', (target: string) => (() => void) | void, RegExp, string?][] = [
    [
      'a link put in place at the open as aliased, even once it is gone again',
      'open',
      (target) => {
        rmSync(target);
        symlinkSync('elsewhere.ia', target);
        return () => rmSync(target);
      },
      /^System package input is aliased: \.ia\/src\/a\.ia$/,
      'Windows has no O_NOFOLLOW, so its open follows the link and fails with ENOENT',
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
      'Windows can keep the name of a file that is still open, so the directory may not take its place',
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
  const refused = (
    _: string,
    at: 'open' | 'read',
    change: (target: string) => (() => void) | void,
    refusal: RegExp,
  ) => {
    const root = temporary(),
      target = resolve(root, '.ia/src/a.ia');
    write(root, '.ia/src/a.ia', 'native source');
    write(root, 'pnpm-workspace.yaml', 'packages: []\n');
    const changed = around(target, at, () => change(target));
    expect(() => bundle(root, '.ia/src/a.ia', digest('native source'))).toThrow(refusal);
    expect(changed()).toBe(true);
  };
  it.each(changes.filter(([, , , , posixOnly]) => !posixOnly))('refuses %s', refused);
  it.skipIf(process.platform === 'win32').each(changes.filter(([, , , , posixOnly]) => posixOnly))(
    'refuses %s',
    refused,
  );
});
