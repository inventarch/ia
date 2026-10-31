import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  INSTALLED_KITS_DIRECTORY,
  briefing,
  installedKit,
  installedPackageKits,
  listKits,
  lockedPackageKits,
  methodRefusal,
  openSession,
  resolveMethod,
  workspaceKits,
} from '../src/method/index.js';

/**
 * Kits a workspace lock installs from an npm package of kits (contract C7b, ia-kb `dec-133`): the engine expands them
 * into `.ia/distributions/store/<archive>/` as ordinary releases, and the runtime reads them from there, materialized
 * once under the IA home; a kit the store lacks needs `ia restore`, and is never answered by another copy.
 */
let dir: string, root: string, bundled: string, home: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-installed-kits-')));
  root = join(dir, 'repo');
  bundled = join(dir, 'bundled');
  home = join(dir, 'home');
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const BASE = { id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64), manifest: 'c'.repeat(64) };
/** A bundled kit folder `inventarch/<name>-kit`. */
function folderKit(at: string, name: string, version: string): void {
  write(join(at, '.ia', 'release.json'), { id: `inventarch/${name}-kit`, version });
  write(join(at, 'releases.json'), {
    kit: `inventarch/${name}-kit`,
    releases: [{ version, archive: 'a'.repeat(64), records: [] }],
  });
}
/** An installed store payload of `inventarch/ia-kb-kit`, and the lock row that pins it. */
function storeKit(): { id: string; version: string; archive: string; manifest: string; dependencies: string[] } {
  const record = '#! ia 1.0\n\n@workspace kb\n';
  const manifest = JSON.stringify({
    id: 'inventarch/ia-kb-kit',
    version: '0.9.0',
    dependencies: [{ id: BASE.id, range: '^3.2.0' }],
    files: [{ path: '.ia/src/workspace.ia', bytes: record.length, sha256: sha256(record), role: 'source' }],
  });
  const archive = 'd'.repeat(64);
  write(join(root, '.ia', 'distributions', 'store', archive, 'distribution.json'), manifest);
  write(join(root, '.ia', 'distributions', 'store', archive, '.ia', 'src', 'workspace.ia'), record);
  return { id: 'inventarch/ia-kb-kit', version: '0.9.0', archive, manifest: sha256(manifest), dependencies: [BASE.id] };
}
const lock = (kits: unknown[]): void =>
  write(join(root, '.ia', 'distributions.lock.json'), {
    formatVersion: 1,
    engine: '^0.1.2',
    requests: [{ id: BASE.id, range: '^3.2.0' }],
    packages: [{ ...BASE, location: `sha256:${BASE.archive}`, dependencies: [] }],
    entries: [
      {
        kind: 'package',
        name: '@inventarch/public-kits',
        version: '1.0.0',
        integrity: `sha512-${'E'.repeat(86)}==`,
        kits,
      },
    ],
  });
const env = (): NodeJS.ProcessEnv => ({ IA_HOME: home });

it('reads kits as before when the lock records no package entry', () => {
  folderKit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  write(join(root, '.ia', 'distributions.lock.json'), {
    formatVersion: 1,
    engine: '0.1.1',
    requests: [],
    packages: [],
  });
  expect(lockedPackageKits(root)).toEqual([]);
  expect(workspaceKits({ bundled, home: null }, root, env())).toEqual({
    kits: listKits({ bundled, home: null }),
    missing: [],
  });
});

it('reads an installed kit from the store, materialized with its release and dependency lock, and never another copy', () => {
  folderKit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  folderKit(join(bundled, 'ia-authoring'), 'ia-authoring', '0.4.0');
  const row = storeKit();
  lock([row]);
  const listed = workspaceKits({ bundled, home: null }, root, env());
  expect(listed.missing).toEqual([]);
  expect(listed.kits.map((kit) => [kit.id, kit.latest?.version, kit.origin])).toEqual([
    ['inventarch/ia-authoring-kit', '0.4.0', 'bundled'],
    ['inventarch/ia-kb-kit', '0.9.0', 'installed'],
  ]);
  const materialized = join(realpathSync(home), INSTALLED_KITS_DIRECTORY, row.archive);
  expect(listed.kits[1]!.dir).toBe(materialized);
  expect(listed.kits[1]!.latest).toMatchObject({ archive: row.archive, manifest: row.manifest });
  // Its own lock pins the dependency exactly as the workspace lock does.
  expect(JSON.parse(readFileSync(join(materialized, '.ia', 'distributions.lock.json'), 'utf8'))).toMatchObject({
    requests: [{ id: BASE.id, range: '^3.2.0' }],
    packages: [{ id: BASE.id, archive: BASE.archive, manifest: BASE.manifest }],
  });
  expect(installedKit(root, 'inventarch/ia-kb-kit')).toMatchObject({ archive: row.archive });
  // A store payload that is not the manifest the lock pins refuses.
  write(join(root, '.ia', 'distributions', 'store', row.archive, 'distribution.json'), '{}');
  expect(() => installedPackageKits(root, env())).toThrow(/not the manifest the lock pins/);
});

it('says to run ia restore when the store lacks a kit the lock installs, and refuses a binding to it', () => {
  folderKit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  const row = storeKit();
  rmSync(join(root, '.ia', 'distributions'), { recursive: true });
  lock([row]);
  const listed = workspaceKits({ bundled, home: null }, root, env());
  expect(listed.kits).toEqual([]);
  expect(listed.missing.map((kit) => [kit.id, kit.package])).toEqual([
    ['inventarch/ia-kb-kit', '@inventarch/public-kits@1.0.0'],
  ]);
  const session = openSession(home, { root, workspace: null, kits: listed.kits, missing: listed.missing });
  expect(session.restore).toMatchObject({ kits: ['inventarch/ia-kb-kit@0.9.0'] });
  expect(session.restore!.message).toContain('run ia restore');
  expect(session.briefing).toContain('Kits not restored:');
  expect(briefing({ root, workspace: null, kits: [], lanes: ['work'] })).not.toContain('Kits not restored');
  write(join(root, '.ia', 'bindings.json'), {
    format: 1,
    bindings: {
      'knowledge.find': { kit: 'inventarch/ia-kb-kit', capability: 'kb-retrieve' },
      'knowledge.check': { kit: 'inventarch/ia-method-kit', capability: 'check' },
    },
  });
  const refused = (activity: string): unknown => {
    try {
      resolveMethod(
        { entry: 'knowledge', activity, root },
        {
          kits: { bundled, home: null },
          restore: () => {
            throw new Error('no read root is restored for a refused binding');
          },
          env: env(),
          store: join(dir, 'store'),
        },
      );
    } catch (error) {
      return methodRefusal(error).error;
    }
    return 'resolved';
  };
  expect(refused('find')).toMatchObject({
    code: 'IA-CORE-KIT-RESTORE-REQUIRED',
    message: expect.stringContaining('run ia restore'),
  });
  // dec-117: a kit nothing installs, bundles or carries is still refused.
  expect(refused('check')).toMatchObject({ code: 'IA-CORE-KIT-UNKNOWN' });
});
