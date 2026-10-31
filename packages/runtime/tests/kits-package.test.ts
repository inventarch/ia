import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  DEFAULT_KITS_MISSING,
  MethodError,
  briefing,
  listKits,
  methodRefusal,
  openSession,
  resolveMethod,
  sourcesDigest,
  workspaceKits,
  workspaceKitsPackages,
} from '../src/method/index.js';

/**
 * The npm package of kits a workspace lock records as one `package` entry (contract C7): found under the workspace's
 * `node_modules` or `IA_KITS_PACKAGE`, verified against the entry, and the only source of the kits it names.
 */
let dir: string, root: string, bundled: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-kits-package-')));
  root = join(dir, 'repo');
  bundled = join(dir, 'bundled');
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const archive = (version: string): string => version.replaceAll('.', '').padStart(64, 'a');
/** A format 2 kit folder `inventarch/<name>-kit` at `at`. */
function kit(at: string, name: string, version: string): string {
  const id = `inventarch/${name}-kit`;
  write(join(at, '.ia', 'release.json'), { id, version });
  write(join(at, '.ia', 'src', 'workspace.ia'), `@workspace ${name}\n`);
  write(join(at, 'releases.json'), {
    format: 2,
    kit: id,
    latest: version,
    releases: [
      {
        version,
        archive: archive(version),
        manifest: 'm'.repeat(64),
        sources: 's'.repeat(64),
        language: 'inventarch/language ^3.2.0',
        cli: '@inventarch/cli 3.4.1',
        file: `releases/${version}.json`,
      },
    ],
  });
  write(join(at, 'releases', `${version}.json`), {
    format: 2,
    kit: id,
    version,
    archive: archive(version),
    records: [],
  });
  return at;
}
const INTEGRITY = `sha512-${'B'.repeat(86)}==`;
/** The package at `<root>/node_modules/@inventarch/public-kits`, carrying ia-kb 0.9.0, and the lock entry naming it. */
function kitsPackage(location = join(root, 'node_modules', '@inventarch', 'public-kits')): string {
  const kb = kit(join(location, 'kits', 'ia-kb'), 'ia-kb', '0.9.0');
  write(join(location, 'package.json'), {
    name: '@inventarch/public-kits',
    version: '1.0.0',
    license: 'Apache-2.0',
    ia: {
      format: 1,
      kits: [
        {
          id: 'inventarch/ia-kb-kit',
          version: '0.9.0',
          archive: archive('0.9.0'),
          sources: sourcesDigest(kb),
          folder: 'ia-kb',
        },
      ],
    },
  });
  return location;
}
const entry = {
  kind: 'package',
  name: '@inventarch/public-kits',
  version: '1.0.0',
  integrity: INTEGRITY,
  kits: [{ id: 'inventarch/ia-kb-kit', version: '0.9.0', archive: archive('0.9.0') }],
};
const lock = (entries: unknown[] | undefined): void =>
  write(join(root, '.ia', 'distributions.lock.json'), {
    formatVersion: 1,
    engine: entries === undefined ? '0.1.1' : '^0.1.2',
    requests: [],
    packages: [],
    ...(entries === undefined ? {} : { entries }),
  });
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ IA_HOME: join(dir, 'home'), ...extra });

it('reads kits as before when the lock records no package', () => {
  kit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  lock(undefined);
  const listed = workspaceKits({ bundled, home: null }, root, env());
  expect(listed.packages).toEqual([]);
  expect(listed.kits).toEqual(listKits({ bundled, home: null }));
});

it("treats a verified package's kits as installed and reads them only from it", () => {
  kit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  kit(join(bundled, 'ia-authoring'), 'ia-authoring', '0.4.0');
  const location = kitsPackage();
  lock([entry]);
  const listed = workspaceKits({ bundled, home: null }, root, env());
  expect(listed.packages.map((report) => [report.status, report.dir, report.integrity])).toEqual([
    ['installed', location, 'unchecked'],
  ]);
  expect(listed.kits.map((k) => [k.id, k.version, k.origin])).toEqual([
    ['inventarch/ia-authoring-kit', '0.4.0', 'bundled'],
    ['inventarch/ia-kb-kit', '0.9.0', 'package'],
  ]);
  // npm's record of the install, beside it, must hold the entry's integrity.
  const record = join(root, 'node_modules', '.package-lock.json');
  write(record, { packages: { 'node_modules/@inventarch/public-kits': { version: '1.0.0', integrity: INTEGRITY } } });
  expect(workspaceKitsPackages(root, { env: env() })[0]!.integrity).toBe('verified');
  write(record, {
    packages: { 'node_modules/@inventarch/public-kits': { version: '1.0.0', integrity: `sha512-${'C'.repeat(86)}==` } },
  });
  expect(workspaceKitsPackages(root, { env: env() })[0]).toMatchObject({ status: 'drift', field: 'integrity' });
});

it('names the field a drifted package differs in, and never falls back to another copy', () => {
  kit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  const location = kitsPackage();
  const drifts: [unknown, string][] = [
    [{ ...entry, version: '1.0.1' }, 'version'],
    [{ ...entry, kits: [{ ...entry.kits[0], archive: archive('0.9.1') }] }, 'ia.kits[inventarch/ia-kb-kit].archive'],
    [{ ...entry, kits: [{ ...entry.kits[0], version: '0.9.1' }] }, 'ia.kits[inventarch/ia-kb-kit].version'],
    [
      {
        ...entry,
        kits: [...entry.kits, { id: 'inventarch/ia-method-kit', version: '1.0.0', archive: archive('1.0.0') }],
      },
      'ia.kits',
    ],
  ];
  for (const [row, field] of drifts) {
    lock([row]);
    const [report] = workspaceKitsPackages(root, { env: env() });
    expect(report).toMatchObject({ status: 'drift', field, kits: [] });
    expect(report!.error?.code).toBe('IA-CORE-KITS-PACKAGE-DRIFT');
    expect(report!.error?.message).toContain(`differs from .ia/distributions.lock.json in ${field}`);
    expect(workspaceKits({ bundled, home: null }, root, env()).kits.map((k) => k.id)).toEqual([]);
  }
  lock([entry]);
  write(join(location, 'kits', 'ia-kb', '.ia', 'src', 'workspace.ia'), '@workspace changed\n');
  expect(workspaceKitsPackages(root, { env: env() })[0]).toMatchObject({
    status: 'drift',
    field: 'ia.kits[inventarch/ia-kb-kit].sources',
  });
});

it('reports default kits not installed when the lock names a package that is not present', () => {
  kit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  lock([entry]);
  const listed = workspaceKits({ bundled, home: null }, root, env());
  expect(listed.kits).toEqual([]);
  const [report] = listed.packages;
  expect(report).toMatchObject({ status: 'not-installed', dir: null });
  expect(report!.error?.code).toBe('IA-CORE-KITS-PACKAGE-MISSING');
  expect(
    report!.error?.message.startsWith(`${DEFAULT_KITS_MISSING}: the lock names @inventarch/public-kits@1.0.0`),
  ).toBe(true);
  const session = openSession(join(dir, 'home'), {
    root,
    workspace: null,
    kits: listed.kits,
    packages: listed.packages,
  });
  expect(session.packages).toEqual([
    {
      name: '@inventarch/public-kits',
      version: '1.0.0',
      kits: ['inventarch/ia-kb-kit'],
      state: 'not-installed',
      message: report!.error!.message,
    },
  ]);
  expect(session.briefing).toContain('Default kits not installed: the lock records @inventarch/public-kits@1.0.0');
  // A session at a workspace without a package entry briefs as before.
  const plain = { root, workspace: null, kits: [], lanes: ['work'] };
  expect(briefing(plain)).not.toContain('Default kits');
});

it('reads the package IA_KITS_PACKAGE names, and refuses a relative one', () => {
  const elsewhere = kitsPackage(join(dir, 'npx', 'node_modules', '@inventarch', 'public-kits'));
  lock([entry]);
  expect(workspaceKitsPackages(root, { env: env({ IA_KITS_PACKAGE: elsewhere }) })[0]).toMatchObject({
    status: 'installed',
    dir: elsewhere,
  });
  expect(workspaceKitsPackages(root, { explicit: elsewhere })[0]!.status).toBe('installed');
  expect(() => workspaceKitsPackages(root, { env: env({ IA_KITS_PACKAGE: 'kits' }) })).toThrow(MethodError);
  // The folder it names is the one read, even when the workspace has another copy.
  expect(workspaceKitsPackages(root, { explicit: join(dir, 'absent') })[0]!.status).toBe('not-installed');
});

it('refuses a binding to a package kit that is not installed, and still one to a kit nothing provides', () => {
  kit(join(bundled, 'ia-kb'), 'ia-kb', '0.8.0');
  lock([entry]);
  write(join(root, '.ia', 'bindings.json'), {
    format: 1,
    bindings: {
      'knowledge.find': { kit: 'inventarch/ia-kb-kit', capability: 'kb-retrieve' },
      'knowledge.check': { kit: 'inventarch/ia-method-kit', capability: 'check' },
    },
  });
  const context = {
    kits: { bundled, home: null },
    restore: () => {
      throw new Error('no read root is restored for a refused binding');
    },
    env: env(),
    store: join(dir, 'store'),
  };
  const refused = (activity: string): unknown => {
    try {
      resolveMethod({ entry: 'knowledge', activity, root }, context);
    } catch (error) {
      return methodRefusal(error).error;
    }
    return 'resolved';
  };
  expect(refused('find')).toMatchObject({
    code: 'IA-CORE-KITS-PACKAGE-MISSING',
    message: expect.stringContaining(DEFAULT_KITS_MISSING),
  });
  // dec-117: a kit neither vendored, bundled, in the IA home nor named by a package entry is refused.
  expect(refused('check')).toMatchObject({ code: 'IA-CORE-KIT-UNKNOWN' });
});
