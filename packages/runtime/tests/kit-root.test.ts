import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { selectKitBase } from '../src/method/kit-base.js';
import type { BasePin } from '../src/method/kit-base.js';
import { kitReadRoot } from '../src/method/kit-root.js';
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
      const lock = readJson(join(root, ...LOCK));
      const row = (lock['packages'] as Record<string, unknown>[]).find((r) => r['id'] === ID)!;
      Object.assign(row, {
        archive: base.archive,
        location: `sha256:${base.archive}`,
        manifest: base.manifest,
        version: base.version,
      });
      write(join(root, ...LOCK), lock);
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
