import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { declarationVersion, type NativeArchive } from './native-archives.js';
import {
  assertNativeImmutability,
  nativeBaseline,
  planNativeVersions,
  NATIVE_CURRENT,
  type NativeBaseline,
  type NativeNotes,
} from './native-version.js';

const pin = (name: string, dependencies: string[] = []): NativeArchive => ({
  id: 'inventarch/' + name,
  version: '2.1.0',
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
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('independent native release selection', () => {
  it('keeps unchanged native identities even with notes and an independently advanced npm release', () => {
    expect(planNativeVersions(baseline, archives, notes(['core'], 'major')).versions).toEqual(
      Object.fromEntries(archives.map((row) => [row.id, '2.1.0'])),
    );
  });
  it('bumps changed archive, exact dependency consumers and embedded language, preserving unrelated content', () => {
    const changed = archives.map((row) => (row.id === 'inventarch/core' ? { ...row, archive: 'c'.repeat(64) } : row));
    const plan = planNativeVersions(baseline, changed, notes(['core', 'consumer', 'language'], 'minor'));
    expect(plan.direct).toEqual(['inventarch/core']);
    expect(plan.versions).toEqual({
      'inventarch/core': '2.2.0',
      'inventarch/consumer': '2.2.0',
      'inventarch/language': '2.2.0',
      'inventarch/unrelated': '2.1.0',
    });
    expect(() => planNativeVersions(baseline, changed, notes(['core']))).toThrow('own bump note');
    expect(() => planNativeVersions(baseline, changed)).toThrow('latest published tag');
    expect(() =>
      planNativeVersions(baseline, changed, {
        ...notes(['core']),
        baseline: { ...baseline.source, commit: 'e'.repeat(40) },
      }),
    ).toThrow('latest published tag');
  });
  it('closes cycles without forcing disconnected native identities to upgrade', () => {
    const cycle = [pin('a', ['b']), pin('b', ['a']), pin('c')];
    const base = { ...baseline, archives: cycle };
    expect(
      planNativeVersions(base, [{ ...cycle[0]!, archive: 'd'.repeat(64) }, ...cycle.slice(1)], notes(['a', 'b']))
        .changed,
    ).toEqual(['inventarch/a', 'inventarch/b']);
  });
  it('refuses changed published bytes, regressions, unnormalized comparisons and unknown identities', () => {
    expect(() => assertNativeImmutability(baseline, [{ ...archives[0]!, archive: 'c'.repeat(64) }])).toThrow(
      'immutable',
    );
    expect(() => assertNativeImmutability(baseline, [{ ...archives[0]!, version: '1.2.0' }])).toThrow('regressed');
    expect(() =>
      planNativeVersions(
        baseline,
        archives.map((row) => ({ ...row, version: '2.2.0' })),
      ),
    ).toThrow('normalized');
    expect(() => planNativeVersions(baseline, [...archives, pin('added')])).toThrow('membership');
  });
  it('allows only the explicitly recorded one-time 2.1 alignment from exact published 2.0', () => {
    const initial = {
      source: { tag: 'v2.0.0', commit: '53885910dc2b22809fddb46c31091660930ade48' },
      archives: archives.map((row) => ({ ...row, version: '1.2.0' })),
    };
    const alignment = {
      ...notes(['core', 'consumer', 'unrelated', 'language']),
      baseline: initial.source,
      alignment: '2.1.0' as const,
    };
    expect(Object.values(planNativeVersions(initial, initial.archives, alignment).versions)).toEqual([
      '2.1.0',
      '2.1.0',
      '2.1.0',
      '2.1.0',
    ]);
    expect(() => planNativeVersions(baseline, archives, { ...alignment, baseline: baseline.source })).toThrow(
      'one-time',
    );
  });
  it('reads published archive evidence from the tag even when the local ledger changes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ia-native-published-'));
    roots.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    git('init', '--quiet');
    git('config', 'user.name', 'Native Release Test');
    git('config', 'user.email', 'native-test' + '@' + 'example.invalid');
    mkdirSync(dirname(resolve(root, NATIVE_CURRENT)), { recursive: true });
    writeFileSync(resolve(root, NATIVE_CURRENT), JSON.stringify({ format: 'ia.native-release.v1', archives }));
    git('add', '.');
    git('commit', '--quiet', '-m', 'Published fixture');
    git('tag', 'v3.0.0');
    writeFileSync(resolve(root, NATIVE_CURRENT), JSON.stringify({ format: 'ia.native-release.v1', archives: [] }));
    expect(nativeBaseline(root).archives).toEqual(archives);
    expect(JSON.parse(readFileSync(resolve(root, NATIVE_CURRENT), 'utf8')).archives).toEqual([]);
    git('tag', 'v4.0.0');
    expect(nativeBaseline(root).source.tag).toBe('v4.0.0');
  });
  it('rewrites only one exact native declaration version and preserves syntax headers and newline bytes', () => {
    const source = '#! ia 1.0\r\n@system sample\r\n  version "1.2.0"\r\n  describes "Release 1.2.0"\r\n';
    expect(declarationVersion(source, '1.2.0', '2.1.0')).toBe(source.replace('version "1.2.0"', 'version "2.1.0"'));
    expect(() => declarationVersion(source, '2.0.0', '2.1.0')).toThrow('differs');
    expect(() => declarationVersion(source + '  version "1.2.0"\r\n', '1.2.0', '2.1.0')).toThrow('exactly one');
  });
});
