import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { lockOnBase, selectKitBase } from '../src/method/kit-base.js';
import type { BasePin } from '../src/method/kit-base.js';
import { assertReadable, kitReadRoot } from '../src/method/kit-root.js';
import type { KitRestore } from '../src/method/kit-root.js';
import { folderKits } from '../src/method/kits.js';
import type { Kit } from '../src/method/kits.js';

/**
 * A kit's read root under the base-selection rule: the cache key names the effective base, a warm root is checked
 * against it, and the read root's lock is the one place a compatible restore may differ from the kit's own.
 */
const ID = 'inventarch/language';
const pin = (version: string, letter: string): BasePin => ({
  id: ID,
  version,
  archive: letter.repeat(64),
  manifest: letter.toUpperCase().repeat(64),
});
const B300 = pin('3.0.0', 'a');
const B320 = pin('3.2.0', 'b');
const B321 = pin('3.2.1', 'c');
const LOCK = ['.ia', 'distributions.lock.json'] as const;

let dir: string, cache: string, kit: Kit;
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const languageRow = (root: string): Record<string, unknown> =>
  (readJson(join(root, ...LOCK))['packages'] as Record<string, unknown>[]).find((row) => row['id'] === ID)!;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-kit-root-')));
  cache = join(dir, 'cache');
  const at = join(dir, 'kits', 'x');
  write(join(at, 'releases.json'), {
    kit: 'inventarch/x-kit',
    releases: [
      {
        version: '0.1.0',
        archive: '1'.repeat(64),
        manifest: '2'.repeat(64),
        sources: '3'.repeat(64),
        language: `${ID} ^3.2.0`,
        cli: '@inventarch/cli 3.6.0',
        records: [],
      },
    ],
  });
  write(join(at, '.ia', 'release.json'), {
    id: 'inventarch/x-kit',
    version: '0.1.0',
    dependencies: [{ id: ID, range: '^3.2.0' }],
  });
  write(join(at, ...LOCK), {
    formatVersion: 1,
    engine: '0.1.1',
    requests: [{ id: ID, range: '^3.2.0' }],
    packages: [
      {
        id: ID,
        version: B320.version,
        archive: B320.archive,
        manifest: B320.manifest,
        location: `sha256:${B320.archive}`,
        dependencies: [],
      },
    ],
  });
  write(join(at, '.ia', 'src', 'x.ia'), '#! ia 1.0\n');
  kit = folderKits(join(dir, 'kits'))[0]!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A restore over `carried`: the rule chooses the base; applying it rewrites only the read root's language row. */
function restoreWith(carried: readonly BasePin[]): KitRestore & { applied: number } {
  const restore = {
    applied: 0,
    select: (target: Kit) => {
      const descriptor = readJson(join(target.dir, '.ia', 'release.json'));
      const range = (descriptor['dependencies'] as { id: string; range: string }[]).find((d) => d.id === ID)?.range;
      return selectKitBase(readJson(join(target.dir, ...LOCK)), range, carried);
    },
    apply: (root: string, _kit: Kit, base: BasePin) => {
      restore.applied++;
      write(join(root, ...LOCK), lockOnBase(readJson(join(root, ...LOCK)), base));
      write(join(root, '.ia', 'distributions', 'active.json'), { base: base.archive });
    },
  };
  return restore;
}

it('warm and cold roots resolve identically', () => {
  for (const carried of [
    [B300, B320, B321],
    [B300, B321],
  ]) {
    const restore = restoreWith(carried);
    const cold = kitReadRoot(kit, restore, { base: cache });
    const warm = kitReadRoot(kit, restore, { base: cache });
    expect(warm).toEqual(cold);
    expect(restore.applied).toBe(1);
    expect(languageRow(cold.root)['archive']).toBe(cold.base.effective.archive);
  }
  // The kit's own folder is never touched: its lock stays on the base it was packed with.
  expect(languageRow(kit.dir)['archive']).toBe(B320.archive);
});

it('roots under different effective bases do not collide', () => {
  // Two readers sharing one IA home: one carries the locked archive, the other only a newer base.
  const exact = restoreWith([B320, B321]);
  const newer = restoreWith([B300, B321]);
  const one = kitReadRoot(kit, exact, { base: cache });
  const two = kitReadRoot(kit, newer, { base: cache });
  expect(one.base).toMatchObject({ mode: 'exact', effective: { archive: B320.archive } });
  expect(two.base).toMatchObject({ mode: 'compatible', effective: { archive: B321.archive } });
  expect(two.root).not.toBe(one.root);
  // Each reader keeps finding its own root, warm, in either order.
  expect(kitReadRoot(kit, exact, { base: cache })).toEqual(one);
  expect(kitReadRoot(kit, newer, { base: cache })).toEqual(two);
  expect([exact.applied, newer.applied]).toEqual([1, 1]);
  expect([languageRow(one.root)['archive'], languageRow(two.root)['archive']]).toEqual([B320.archive, B321.archive]);
});

it('a read-root lock rewritten to another base is detected as altered', () => {
  const restore = restoreWith([B300, B321]);
  const { root } = kitReadRoot(kit, restore, { base: cache });
  expect(existsSync(join(root, '.ia', 'distributions', 'active.json'))).toBe(true);
  const lock = readJson(join(root, ...LOCK));
  for (const row of lock['packages'] as Record<string, unknown>[])
    if (row['id'] === ID) Object.assign(row, { archive: B300.archive, version: B300.version });
  write(join(root, ...LOCK), lock);
  expect(() => kitReadRoot(kit, restore, { base: cache })).toThrow(
    expect.objectContaining({ code: 'IA-CORE-CLOSURE-INTEGRITY' }),
  );
  // A changed source is still caught too.
  const other = restoreWith([B320]);
  const exact = kitReadRoot(kit, other, { base: cache });
  writeFileSync(join(exact.root, '.ia', 'src', 'x.ia'), '#! ia 1.0\n\n@changed\n');
  expect(() => kitReadRoot(kit, other, { base: cache })).toThrow(
    expect.objectContaining({ code: 'IA-CORE-CLOSURE-INTEGRITY' }),
  );
});

it('any other change to a read-root lock is detected as altered', () => {
  const tamper: ((lock: Record<string, unknown>) => void)[] = [
    (lock) => {
      (lock['requests'] as { range: string }[])[0]!.range = '*';
    },
    (lock) => {
      Object.assign((lock['packages'] as Record<string, unknown>[])[0]!, { manifest: 'f'.repeat(64) });
    },
    (lock) => {
      Object.assign((lock['packages'] as Record<string, unknown>[])[0]!, { location: 'https://example.invalid/x' });
    },
    (lock) => {
      (lock['packages'] as Record<string, unknown>[]).push({ id: 'inventarch/other-kit', version: '1.0.0' });
    },
  ];
  for (const [index, change] of tamper.entries()) {
    const restore = restoreWith([B300, B321]);
    const { root } = kitReadRoot(kit, restore, { base: join(cache, String(index)) });
    expect(kitReadRoot(kit, restore, { base: join(cache, String(index)) }).root).toBe(root);
    const lock = readJson(join(root, ...LOCK));
    change(lock);
    write(join(root, ...LOCK), lock);
    expect(() => kitReadRoot(kit, restore, { base: join(cache, String(index)) }), String(index)).toThrow(
      expect.objectContaining({ code: 'IA-CORE-CLOSURE-INTEGRITY' }),
    );
  }
});

/**
 * A release that names `works` is read by the readers its range admits; one that does not keeps the packed-major rule.
 */
const released = (row: Record<string, unknown>): Kit => ({
  ...kit,
  id: 'inventarch/x-kit',
  latest: { version: '1.0.0', ...row },
});
const refusalOf = (run: () => void): { code: string | undefined; message: string } | null => {
  try {
    run();
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
};
const reader = (version?: string) => ({ version, source: 'in-process' });

it('a works range admits a newer reader the packing version says nothing about', () => {
  const row = { cli: '@inventarch/cli 3.9.1', works: '>=3.9.0 <4' };
  for (const version of ['3.9.0', '3.9.1', '3.10.0', '3.99.4', '3.10.0-next.2', '3.9.1+build.1'])
    expect(refusalOf(() => assertReadable(released(row), reader(version)))).toBeNull();
  expect(refusalOf(() => assertReadable(released(row), reader(undefined)))).toBeNull();
});

it('a works range refuses a reader below it and names the upgrade', () => {
  const refused = refusalOf(() =>
    assertReadable(released({ cli: '@inventarch/cli 3.9.1', works: '>=3.9.0 <4' }), reader('3.8.0')),
  );
  expect(refused).toEqual({
    code: 'IA-CORE-CLI-UNSUPPORTED',
    message:
      'kit inventarch/x-kit 1.0.0 works with IA >=3.9.0 <4; this reader is 3.8.0 (in-process): upgrade the reader to a version in that range',
  });
});

it('a works range refuses a reader above it and names the kit release', () => {
  const refused = refusalOf(() =>
    assertReadable(released({ cli: '@inventarch/cli 3.9.1', works: '>=3.9.0 <4' }), reader('4.0.0')),
  );
  expect(refused?.code).toBe('IA-CORE-CLI-UNSUPPORTED');
  expect(refused?.message).toContain('the kit needs a release whose range admits it');
});

it('a works range decides alone: the packing version is provenance', () => {
  // Packed by a later major than the reader, yet the range admits the reader.
  expect(
    refusalOf(() => assertReadable(released({ cli: '@inventarch/cli 4.0.0', works: '>=3.9.0 <5' }), reader('3.9.1'))),
  ).toBeNull();
});

it('a works value that is not a range is refused, never read as no claim', () => {
  for (const works of ['soon', '', 3, null, '>4 <3']) {
    const refused = refusalOf(() => assertReadable(released({ cli: '@inventarch/cli 3.9.1', works }), reader('3.9.1')));
    expect(refused?.code).toBe('IA-CORE-KIT');
    expect(refused?.message).toContain('is not a SemVer range that admits an IA version');
  }
});

it('a release without works keeps the packed-major rule', () => {
  expect(refusalOf(() => assertReadable(released({ cli: '@inventarch/cli 3.8.0' }), reader('3.9.1')))).toBeNull();
  expect(refusalOf(() => assertReadable(released({ cli: '@inventarch/cli 3.8.0' }), reader('4.0.0')))).toBeNull();
  expect(refusalOf(() => assertReadable(released({ cli: '@inventarch/cli 4.0.0' }), reader('3.9.1')))?.code).toBe(
    'IA-CORE-CLI-UNSUPPORTED',
  );
  expect(refusalOf(() => assertReadable(released({}), reader('3.9.1')))).toBeNull();
});

it('open and gapped works ranges are read as written', () => {
  const admits = (works: string, version: string): boolean =>
    refusalOf(() => assertReadable(released({ works }), reader(version))) === null;
  expect(admits('*', '3.9.1')).toBe(true);
  expect(admits('<4', '3.9.1')).toBe(true);
  expect(admits('<4', '4.0.0-next.1')).toBe(false);
  expect(admits('>=3.9.0 <4 || >=5', '5.1.0')).toBe(true);
  expect(admits('>=3.9.0 <4 || >=5', '4.5.0')).toBe(false);
});

it('a reader version that is not canonical SemVer is unknown, and the kit is not blamed for it', () => {
  for (const version of ['03.9.1', 'dev', '3.9', 'v3.9.1'])
    expect(refusalOf(() => assertReadable(released({ works: '>=3.9.0 <4' }), reader(version)))).toBeNull();
});
