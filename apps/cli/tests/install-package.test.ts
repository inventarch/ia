import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { HOST_TREE_LIMITS, packTree } from '@inventarch/distribution/ustar';
import { initialized } from './host-fixture.js';
import { run, scratch } from './workspace-fixture.js';

/**
 * `ia install --package` and `ia restore` of an npm package of kits (contract C7b, ia-kb `dec-133`). The package is the
 * local stand-in in `fixtures/kits-package` (provenance in its PROVENANCE.json): its package.json and the real IA archive
 * of the ia-kb kit 0.9.0, packed here into an npm-style tarball. `IA_NPM` runs tests/fake-npm.mjs instead of npm: it
 * answers `npm view` from `FAKE_NPM_VIEW` and `npm cache add` by copying the tarball into `FAKE_NPM_CACHE`'s
 * content-addressed store, where the CLI looks for it by the package's integrity.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/kits-package/', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('./fake-npm.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'package.json.txt'), 'utf8')) as {
  name: string;
  version: string;
  ia: { kits: { id: string; version: string; archive: string; manifest: string }[] };
};
const [kit] = manifest.ia.kits;
const tarball = packTree(
  new Map([
    ['package/package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
    [`package/archives/${kit!.archive}.ia.tgz`, readFileSync(join(FIXTURE, 'archives', `${kit!.archive}.ia.tgz`))],
    [
      `package/archives/${kit!.archive}.distribution.json`,
      readFileSync(join(FIXTURE, 'archives', `${kit!.archive}.distribution.json`)),
    ],
  ]),
  HOST_TREE_LIMITS,
);
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
const cachedPath = (cache: string): string => {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  return join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
};
async function workspace() {
  const { root, env: base } = await initialized();
  const dir = scratch('npm');
  writeFileSync(join(dir, 'package.tgz'), tarball);
  const cache = join(dir, 'cache');
  const log = join(dir, 'calls.jsonl');
  const env = {
    ...base,
    IA_NPM: FAKE_NPM,
    IA_NPM_LOG: log,
    FAKE_NPM_VIEW: JSON.stringify({ ...manifest, dist: { integrity } }),
    FAKE_NPM_TARBALL: join(dir, 'package.tgz'),
    FAKE_NPM_CACHE: cache,
    npm_config_cache: cache,
  };
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { root, env, cache, calls };
}
const lockOf = (root: string) => JSON.parse(readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8'));
const ENTRY = () => ({
  kind: 'package',
  name: manifest.name,
  version: manifest.version,
  integrity,
  kits: [
    {
      id: kit!.id,
      version: kit!.version,
      archive: kit!.archive,
      manifest: kit!.manifest,
      dependencies: ['inventarch/language'],
    },
  ],
});

it('installs an npm package of kits as one lock entry and its kits as ordinary releases in the store', async () => {
  const { root, env, cache, calls } = await workspace();
  const before = lockOf(root);
  const planned = await run(['install', '--package', `${manifest.name}@1.0.0`, '--root', root, '--json'], { env });
  expect(planned.exitCode, planned.stdout).toBe(0);
  const plan = JSON.parse(planned.stdout).plan;
  expect(plan.changes.added).toEqual([kit!.id]);
  // A plan writes no installation state; npm was asked for the version, then the tarball was fetched into its cache.
  expect(lockOf(root)).toEqual(before);
  expect(calls()).toEqual([
    ['view', `${manifest.name}@1.0.0`, '--json'],
    ['cache', 'add', `${manifest.name}@1.0.0`],
  ]);
  expect(existsSync(cachedPath(cache))).toBe(true);
  const applied = await run(
    ['install', '--package', `${manifest.name}@1.0.0`, '--apply', '--yes', '--root', root, '--json'],
    {
      env,
    },
  );
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(lockOf(root)).toEqual({ ...before, engine: '^0.1.2', entries: [ENTRY()] });
  expect(existsSync(resolve(root, `.ia/distributions/store/${kit!.archive}/distribution.json`))).toBe(true);
  // The tarball was in npm's cache, so the apply asked npm only for the version.
  expect(calls().slice(2)).toEqual([['view', `${manifest.name}@1.0.0`, '--json']]);
  const validated = await run(['validate', '--root', root, '--json'], { env });
  expect(validated.exitCode, validated.stdout).toBe(0);
  expect(JSON.parse(validated.stdout).status).toBe('admitted');
  expect(JSON.parse(validated.stdout)).not.toHaveProperty('kitsPackages');
}, 300_000);

it('restores the kits of a committed lock entry by digest from npm cache, and refuses offline without it', async () => {
  const { root, env, cache, calls } = await workspace();
  const installed = await run(['install', '--package', manifest.name, '--apply', '--yes', '--root', root, '--json'], {
    env,
  });
  expect(installed.exitCode, installed.stdout).toBe(0);
  expect(calls()[0]).toEqual(['view', `${manifest.name}@latest`, '--json']);
  // A fresh clone: the committed lock and sources, no installation state.
  const clone = () => rmSync(resolve(root, '.ia/distributions'), { recursive: true, force: true });
  clone();
  const offline = await run(['restore', '--offline', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(offline.exitCode, offline.stdout).toBe(0);
  expect(existsSync(resolve(root, `.ia/distributions/store/${kit!.archive}/distribution.json`))).toBe(true);
  // Without the tarball in npm's cache an offline restore refuses (online, npm cache add fetches it, as install does).
  clone();
  rmSync(cache, { recursive: true, force: true });
  const refused = await run(['restore', '--offline', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-RESTORE-REQUIRED',
    message: expect.stringContaining("is not in npm's cache"),
  });
}, 300_000);

it('refuses a package npm cannot describe, and one whose tarball lacks an archive it lists', async () => {
  const { root, env } = await workspace();
  const missing = await run(['install', '--package', `${manifest.name}@2.0.0`, '--root', root, '--json'], {
    env: { ...env, FAKE_NPM_VIEW: '' },
  });
  expect(missing.exitCode).toBe(3);
  expect(JSON.parse(missing.stdout)).toMatchObject({ code: 'IA-CLI-KITS-PACKAGE-UNAVAILABLE' });
  const wrong = { ...manifest, ia: { format: 1, kits: [{ ...kit, archive: 'e'.repeat(64) }] }, dist: { integrity } };
  const lacking = await run(['install', '--package', manifest.name, '--root', root, '--json'], {
    env: { ...env, FAKE_NPM_VIEW: JSON.stringify(wrong) },
  });
  expect(lacking.exitCode).toBe(3);
  expect(JSON.parse(lacking.stdout)).toMatchObject({
    code: 'IA-CLI-KITS-PACKAGE-UNAVAILABLE',
    message: expect.stringContaining(`carries no archives/${'e'.repeat(64)}.ia.tgz`),
  });
  expect((await run(['install', 'inventarch/x', '--package', manifest.name, '--root', root], { env })).exitCode).toBe(
    2,
  );
}, 300_000);
