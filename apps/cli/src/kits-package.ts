/**
 * An npm package of IA kits (contract C7b, ia-kb `dec-133`): `ia install --package <name>[@<version>]` records it as
 * one `package` entry in `.ia/distributions.lock.json` and installs the kit archives it carries as ordinary releases;
 * `ia restore` refetches them by digest. npm is transport only: no kit is ever read from the npm package folder.
 *
 * The package carries, for each kit `package.json` `ia.kits` lists (`{id, version, archive, manifest}`), the IA archive
 * `archives/<archive>.ia.tgz`. Reading one:
 * - `npm view <name>@<version> --json` gives the exact version, `dist.integrity` and `ia.kits`;
 * - the tarball is read from npm's content-addressed cache, `<npm cache>/_cacache/content-v2/sha512/<h[0:2]>/<h[2:4]>/<h[4:]>`,
 *   where `h` is the hex of the integrity's SHA-512 and `<npm cache>` is `npm_config_cache`, else `npm config get cache`,
 *   else npm's default (`%LocalAppData%\npm-cache` on Windows, `~/.npm` elsewhere); its bytes must hash to the integrity;
 * - when it is not cached and the run is not `--offline`, `npm cache add <name>@<version>` fetches it into that cache;
 * - each archive is verified against its archive and manifest digests and written to the workspace archive cache.
 *
 * `IA_NPM` names a Node script to run instead of `npm`; it exists for tests and is not a user-facing setting. `npm`
 * itself is found on qualified PATH entries and run from the home directory (program.ts).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  canonicalDistributionJson,
  decodeDistributionLock,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  lockEngineMarker,
} from '@inventarch/db/distribution';
import type { DistributionLock, PackageEntry, PackageKit } from '@inventarch/db/distribution';
import { inspectArchiveMetadata } from '@inventarch/distribution/archive';
import { cacheArchive, cachePath } from '@inventarch/distribution/install';
import { Refusal } from './consumer.js';
import { findProgram, programEnv, programHome, windowsShell, windowsShellArgs } from './program.js';

type Env = Readonly<Record<string, string | undefined>>;
/** `npm view`, `npm config get` and `npm cache add` each get two minutes. */
const NPM_TIMEOUT = 120_000;
/** The variables that steer a test's fake npm. Only the ones this invocation was given reach it. */
const FAKE_VARIABLE = /^(IA_NPM_|FAKE_NPM_)/;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([0-9A-Za-z.+-]+))?$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;

/** One npm command: its exit, stdout, and both streams for a refusal. */
export type Npm = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
};
export function npmRunner(env: Env): Npm {
  const fake = env['IA_NPM'];
  const options = {
    cwd: programHome(),
    env: programEnv(env),
    timeout: NPM_TIMEOUT,
    windowsHide: true,
    encoding: 'utf8' as const,
  };
  const done = (result: SpawnSyncReturns<string>) => ({
    status: result.status,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim(),
  });
  return (args) => {
    if (fake !== undefined)
      return done(
        spawnSync(process.execPath, [fake, ...args], {
          ...options,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !FAKE_VARIABLE.test(name))),
            ...Object.fromEntries(Object.entries(env).filter(([name]) => FAKE_VARIABLE.test(name))),
          },
        }),
      );
    const program = findProgram('npm', env, 'program');
    if (program !== null) return done(spawnSync(program, [...args], options));
    const script = findProgram('npm', env, 'script');
    if (script === null) return { status: null, stdout: '', output: 'npm was not found on a qualified PATH entry' };
    // Each argument is a subcommand, a flag, or a package name and version, which cmd.exe passes unchanged.
    return done(
      spawnSync(windowsShell(env), windowsShellArgs(script, args), { ...options, windowsVerbatimArguments: true }),
    );
  };
}

/** A refusal for a package npm could not provide, naming the command that tries again. */
const unavailable = (spec: string, detail: string, again: string): Refusal =>
  new Refusal(
    'IA-CLI-KITS-PACKAGE-UNAVAILABLE',
    `The kits package ${spec} is unavailable: ${detail}`,
    3,
    null,
    `Once ${spec} is published and npm can reach its registry, run "${again}" again.`,
  );

/** `<name>[@<version>]`, the version `latest` when none is given. */
export function packageSpec(input: string, again: string): { readonly name: string; readonly version: string } {
  const match = SPEC.exec(input);
  if (match === null || Buffer.byteLength(match[1]!) > 214)
    throw new Refusal(
      'IA-CLI-USAGE',
      `--package takes <name>[@<version>]: ${input}`,
      2,
      null,
      `Run "${again.replace(input, '<name>@<version>')}".`,
    );
  return { name: match[1]!, version: match[2] ?? 'latest' };
}

/** What `npm view` reports for one version: the exact version, its integrity and the kits `ia.kits` lists. */
export interface ViewedPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly kits: readonly {
    readonly id: string;
    readonly version: string;
    readonly archive: string;
    readonly manifest: string;
  }[];
}
export function viewPackage(npm: Npm, name: string, version: string, again: string): ViewedPackage {
  const spec = `${name}@${version}`;
  const result = npm(['view', spec, '--json']);
  if (result.status !== 0) throw unavailable(spec, result.output || `npm view exited ${String(result.status)}`, again);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    // A range can answer with several versions; an exact version or a dist-tag answers with one object.
    const row = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (row === null || typeof row !== 'object') throw new Error('not an object');
    manifest = row as Record<string, unknown>;
  } catch {
    throw unavailable(spec, 'npm view printed no JSON manifest', again);
  }
  const integrity = (manifest['dist'] as { integrity?: unknown } | undefined)?.integrity;
  const ia = manifest['ia'] as { format?: unknown; kits?: unknown } | undefined;
  if (manifest['name'] !== name || typeof manifest['version'] !== 'string' || !EXACT.test(manifest['version']))
    throw unavailable(spec, 'npm view named another package or no exact version', again);
  if (typeof integrity !== 'string' || !INTEGRITY.test(integrity))
    throw unavailable(spec, 'npm view gave no sha512 dist.integrity', again);
  if (ia?.format !== 1 || !Array.isArray(ia.kits) || ia.kits.length === 0)
    throw unavailable(spec, 'its package.json has no format 1 ia.kits list', again);
  const kits = (ia.kits as unknown[]).map((value) => {
    const row = (value ?? {}) as Record<string, unknown>;
    if (!['id', 'version', 'archive', 'manifest'].every((field) => typeof row[field] === 'string'))
      throw unavailable(spec, 'an ia.kits row lacks its id, version, archive or manifest', again);
    return {
      id: row['id'] as string,
      version: row['version'] as string,
      archive: row['archive'] as string,
      manifest: row['manifest'] as string,
    };
  });
  return { name, version: manifest['version'], integrity, kits };
}

/** npm's cache folder: `npm_config_cache`, else `npm config get cache`, else npm's default. */
export function npmCache(npm: Npm, env: Env): string {
  const configured = env['npm_config_cache'] ?? env['NPM_CONFIG_CACHE'];
  if (configured !== undefined && isAbsolute(configured)) return configured;
  const asked = npm(['config', 'get', 'cache']);
  const answer = asked.status === 0 ? asked.stdout.trim().split(/\r?\n/).at(-1) : undefined;
  if (answer !== undefined && isAbsolute(answer)) return answer;
  if (process.platform === 'win32' && env['LOCALAPPDATA']) return join(env['LOCALAPPDATA'], 'npm-cache');
  return join(env['HOME'] ?? homedir(), '.npm');
}
/** Where npm's content-addressed cache keeps the tarball whose integrity is `integrity`. */
export function cachedTarballPath(cache: string, integrity: string): string {
  const match = INTEGRITY.exec(integrity);
  if (match === null)
    throw new Refusal(
      'IA-DIST-INPUT-INVALID',
      `Not an npm sha512 integrity: ${integrity}`,
      3,
      null,
      'Restore the exact lock from source control, then run "ia restore".',
    );
  const hex = Buffer.from(match[1]!, 'base64').toString('hex');
  return join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}
export const integrityOf = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/**
 * The tarball of `name@version` with `integrity`, from npm's cache, after `npm cache add` puts it there unless the run
 * is offline. Its bytes must hash to the integrity.
 */
export function packageTarball(
  npm: Npm,
  env: Env,
  pkg: { readonly name: string; readonly version: string; readonly integrity: string },
  options: { readonly offline: boolean; readonly again: string },
): Buffer {
  const spec = `${pkg.name}@${pkg.version}`;
  const path = cachedTarballPath(npmCache(npm, env), pkg.integrity);
  if (!existsSync(path)) {
    if (options.offline)
      throw new Refusal(
        'IA-DIST-RESTORE-REQUIRED',
        `The kits package ${spec} is not in npm's cache at ${path}, and this run is offline`,
        3,
        null,
        `Run "${options.again.replace(/ --offline\b/, '')}" with npm's registry reachable.`,
      );
    const added = npm(['cache', 'add', spec]);
    if (added.status !== 0 || !existsSync(path))
      throw unavailable(spec, added.output || `npm cache add did not cache ${pkg.integrity}`, options.again);
  }
  const bytes = readFileSync(path);
  if (bytes.length > DISTRIBUTION_LIMITS.compressed || integrityOf(bytes) !== pkg.integrity)
    throw new Refusal(
      'IA-DIST-INTEGRITY-MISMATCH',
      `npm's cached tarball of ${spec} at ${path} does not hash to ${pkg.integrity}`,
      3,
      null,
      `Repair npm's cache with npm cache verify, then run "${options.again}" again.`,
    );
  return bytes;
}

/** The regular files of an npm tarball, by path under its one top folder (npm writes `package/`). */
export function tarballFiles(input: Uint8Array): ReadonlyMap<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(input, { maxOutputLength: DISTRIBUTION_LIMITS.expanded });
  } catch {
    throw new Refusal(
      'IA-DIST-ARCHIVE-INVALID',
      'The kits package tarball is not gzip within its limit',
      3,
      null,
      'Publish a fresh package build, then run "ia install --package <name>@<version>".',
    );
  }
  const files = new Map<string, Buffer>();
  const field = (at: number, length: number): string =>
    tar
      .subarray(at, at + length)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '');
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(at + 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
      throw new Refusal(
        'IA-DIST-ARCHIVE-INVALID',
        'The kits package tarball has a damaged entry',
        3,
        null,
        'Publish a fresh package build, then run "ia install --package <name>@<version>".',
      );
    const type = field(at + 156, 1);
    const prefix = field(at + 345, 155),
      path = (prefix ? `${prefix}/` : '') + field(at, 100);
    if (type === '0' || type === '') {
      const relative = path.split('/').slice(1).join('/');
      if (relative && !relative.split('/').some((part) => part === '..' || part === ''))
        files.set(relative, Buffer.from(tar.subarray(at + 512, at + 512 + size)));
      if (files.size > DISTRIBUTION_LIMITS.files)
        throw new Refusal(
          'IA-DIST-LIMIT-EXCEEDED',
          'The kits package tarball has too many files',
          3,
          null,
          'Publish a fresh package build, then run "ia install --package <name>@<version>".',
        );
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * The lock entry for a package and the archives that install it: each `ia.kits` row's `archives/<archive>.ia.tgz`,
 * verified against its archive and manifest digests and its id and version, with the dependency ids its manifest names.
 */
export function packageEntry(
  viewed: ViewedPackage,
  tarball: Uint8Array,
  again: string,
): { readonly entry: PackageEntry; readonly archives: ReadonlyMap<string, Buffer> } {
  const spec = `${viewed.name}@${viewed.version}`;
  const files = tarballFiles(tarball);
  const archives = new Map<string, Buffer>();
  const kits = viewed.kits.map((row): PackageKit => {
    const bytes = files.get(`archives/${row.archive}.ia.tgz`);
    if (bytes === undefined)
      throw unavailable(spec, `it carries no archives/${row.archive}.ia.tgz for ${row.id}@${row.version}`, again);
    let pending: ReturnType<typeof inspectArchiveMetadata>['pending'];
    try {
      ({ pending } = inspectArchiveMetadata(bytes, row.archive));
    } catch (error) {
      throw unavailable(spec, `archives/${row.archive}.ia.tgz: ${(error as Error).message}`, again);
    }
    if (
      pending.manifestDigest !== row.manifest ||
      pending.manifest.id !== row.id ||
      pending.manifest.version !== row.version
    )
      throw unavailable(
        spec,
        `archives/${row.archive}.ia.tgz is not ${row.id}@${row.version} with manifest ${row.manifest}`,
        again,
      );
    archives.set(row.archive, bytes);
    return {
      id: row.id,
      version: row.version,
      archive: row.archive,
      manifest: row.manifest,
      dependencies: pending.manifest.dependencies.map((dependency) => dependency.id).sort(),
    };
  });
  kits.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    entry: { kind: 'package', name: viewed.name, version: viewed.version, integrity: viewed.integrity, kits },
    archives,
  };
}

/** `lock` with `entry` in place of any entry of its name: the engine an entry needs, every other byte kept. */
export function lockWithPackage(lock: DistributionLock | undefined, entry: PackageEntry): DistributionLock {
  const base = lock ?? { formatVersion: 1 as const, engine: DISTRIBUTION_ENGINE_VERSION, requests: [], packages: [] };
  const entries = [...(base.entries ?? []).filter((row) => row.name !== entry.name), entry].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  const engine = base.entries === undefined ? lockEngineMarker(DISTRIBUTION_ENGINE_VERSION, true) : base.engine;
  return decodeDistributionLock({ ...base, engine, entries });
}
export const sameLock = (a: DistributionLock | undefined, b: DistributionLock): boolean =>
  a !== undefined && canonicalDistributionJson(a) === canonicalDistributionJson(b);

/**
 * Puts every archive a lock's package entries name into the workspace archive cache: from npm's cache by the entry's
 * integrity, after `npm cache add` unless offline. An archive the workspace cache already holds is not fetched again.
 */
export function acquirePackageArchives(
  root: string,
  lock: DistributionLock,
  options: { readonly npm: Npm; readonly env: Env; readonly offline: boolean; readonly again: string },
): void {
  for (const entry of lock.entries ?? []) {
    const missing = entry.kits.filter((kit) => !existsSync(join(root, cachePath(kit.archive))));
    if (missing.length === 0) continue;
    const files = tarballFiles(packageTarball(options.npm, options.env, entry, options));
    for (const kit of missing) {
      const bytes = files.get(`archives/${kit.archive}.ia.tgz`);
      if (bytes === undefined)
        throw new Refusal(
          'IA-DIST-RESTORE-REQUIRED',
          `${entry.name}@${entry.version} carries no archives/${kit.archive}.ia.tgz for ${kit.id}@${kit.version}`,
          3,
          { path: '.ia/distributions.lock.json' },
          `Restore the exact lock from source control, then run "${options.again}" again.`,
        );
      cacheArchive(root, bytes, kit.archive);
    }
  }
}
