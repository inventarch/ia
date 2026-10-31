/**
 * The npm package of default kits (contract C7, dec-122) on the CLI's side: the lock entry `ia host <host> --commit`
 * records from `npm view` of the pinned version, and the verification `ia restore` and `ia validate` run against the
 * package where the host put it.
 *
 * `npm view <name>@<version> --json` reads the published manifest: its `version`, `dist.integrity` and the `ia.kits` its
 * `package.json` claims. `IA_NPM` names a Node script to run instead of `npm`; it exists for tests and is not a
 * user-facing setting. `npm` itself is found on qualified PATH entries and run from the home directory (program.ts).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  canonicalDistributionJson,
  decodeDistributionLock,
  lockEngineMarker,
  DISTRIBUTION_ENGINE_VERSION,
} from '@inventarch/db/distribution';
import type { DistributionLock, PackageEntry } from '@inventarch/db/distribution';
import { DEFAULT_KITS_PACKAGE, workspaceKitsPackages } from '@inventarch/runtime/method';
import type { KitsPackageReport } from '@inventarch/runtime/method';
import { Refusal } from './consumer.js';
import type { Capabilities } from './render.js';
import { document, entry, words } from './render.js';
import { findProgram, programEnv, programHome, windowsShell, windowsShellArgs } from './program.js';

type Env = Readonly<Record<string, string | undefined>>;
export { DEFAULT_KITS_PACKAGE };
/** `npm view` gets a minute: it is one registry read. */
const VIEW_TIMEOUT = 60_000;
/** The variables that steer a test's fake npm. Only the ones this invocation was given reach it. */
const FAKE_VARIABLE = /^(IA_NPM_|FAKE_NPM_)/;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** Runs `npm view <spec> --json` and returns its stdout, or the failure output for a refusal. */
export type NpmView = (spec: string) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
};
export function npmView(env: Env): NpmView {
  const fake = env['IA_NPM'];
  const options = {
    cwd: programHome(),
    env: programEnv(env),
    timeout: VIEW_TIMEOUT,
    windowsHide: true,
    encoding: 'utf8' as const,
  };
  const done = (result: SpawnSyncReturns<string>) => ({
    status: result.status,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim(),
  });
  return (spec) => {
    const args = ['view', spec, '--json'];
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
    if (program !== null) return done(spawnSync(program, args, options));
    const script = findProgram('npm', env, 'script');
    if (script === null) return { status: null, stdout: '', output: 'npm was not found on a qualified PATH entry' };
    // The spec and flags are a package name and a version, which cmd.exe passes unchanged.
    return done(
      spawnSync(windowsShell(env), windowsShellArgs(script, args), { ...options, windowsVerbatimArguments: true }),
    );
  };
}

/** The refusal for a package `npm view` could not describe, naming the flag that pins a version. */
const unavailable = (spec: string, detail: string, again: string): Refusal =>
  new Refusal(
    'IA-CLI-KITS-PACKAGE-UNAVAILABLE',
    `npm view ${spec} did not describe the default kits package: ${detail}`,
    3,
    null,
    `Once ${spec} is published and npm can reach its registry, run "${again} --kits-package-version <version>" to pin a published version.`,
  );

/**
 * The lock entry for `name` at `version` (the dist-tag `latest` when none is given), from `npm view`: the exact
 * version, npm's `dist.integrity`, and each kit `ia.kits` names.
 */
export function viewKitsPackage(
  view: NpmView,
  options: { readonly name?: string; readonly version?: string; readonly again: string },
): PackageEntry {
  const name = options.name ?? DEFAULT_KITS_PACKAGE;
  if (options.version !== undefined && !EXACT.test(options.version))
    throw new Refusal(
      'IA-CLI-USAGE',
      `--kits-package-version takes an exact version: ${options.version}`,
      2,
      null,
      `Run "${options.again} --kits-package-version <x.y.z>".`,
    );
  const spec = `${name}@${options.version ?? 'latest'}`;
  const result = view(spec);
  if (result.status !== 0) throw unavailable(spec, result.output || `exit ${String(result.status)}`, options.again);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    // A range can answer with several versions; an exact spec or a dist-tag answers with one object.
    const row = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (row === null || typeof row !== 'object') throw new Error('not an object');
    manifest = row as Record<string, unknown>;
  } catch {
    throw unavailable(spec, 'its output is not one JSON manifest', options.again);
  }
  const dist = manifest['dist'] as { integrity?: unknown } | undefined;
  const ia = manifest['ia'] as { format?: unknown; kits?: unknown } | undefined;
  if (manifest['name'] !== name || typeof manifest['version'] !== 'string')
    throw unavailable(spec, 'it names another package or no version', options.again);
  if (ia?.format !== 1 || !Array.isArray(ia.kits))
    throw unavailable(spec, 'its package.json has no format 1 ia.kits list', options.again);
  const kits = (ia.kits as Record<string, unknown>[])
    .map((kit) => ({ id: kit?.['id'], version: kit?.['version'], archive: kit?.['archive'] }))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  try {
    // The lock decoder judges every field: the name, the exact version, the integrity and each kit row.
    const [entry] = decodeDistributionLock({
      formatVersion: 1,
      engine: lockEngineMarker(DISTRIBUTION_ENGINE_VERSION, true),
      requests: [],
      packages: [],
      entries: [{ kind: 'package', name, version: manifest['version'], integrity: dist?.integrity, kits }],
    }).entries!;
    return entry!;
  } catch (error) {
    throw unavailable(spec, error instanceof Error ? error.message : String(error), options.again);
  }
}

/** `lock` with `entry` in place of any entry of its name: the engine marker an entry needs, every other byte kept. */
export function lockWithPackage(lock: DistributionLock | undefined, entry: PackageEntry): DistributionLock {
  const base = lock ?? { formatVersion: 1 as const, engine: DISTRIBUTION_ENGINE_VERSION, requests: [], packages: [] };
  const entries = [...(base.entries ?? []).filter((row) => row.name !== entry.name), entry].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  const engine = base.entries === undefined ? lockEngineMarker(DISTRIBUTION_ENGINE_VERSION, true) : base.engine;
  return decodeDistributionLock({ ...base, engine, entries });
}
/** Whether two locks are the same bytes. */
export const sameLock = (a: DistributionLock | undefined, b: DistributionLock): boolean =>
  a !== undefined && canonicalDistributionJson(a) === canonicalDistributionJson(b);

/**
 * The lock's packages of kits, each found and verified against its entry (runtime `workspaceKitsPackages`): `IA_KITS_PACKAGE`
 * names a folder, else `node_modules/<name>` above the workspace.
 */
export const kitsPackages = (root: string, env: Env): readonly KitsPackageReport[] =>
  workspaceKitsPackages(root, { env: env as NodeJS.ProcessEnv });
/** The refusal for a drifted package: its message names the field. */
export function driftRefusal(report: KitsPackageReport, next: string): Refusal {
  return new Refusal(
    'IA-DIST-KITS-PACKAGE-DRIFT',
    report.error!.message,
    3,
    { path: '.ia/distributions.lock.json' },
    `Install ${report.entry.name}@${report.entry.version} exactly where the host reads it, then run "${next}" again.`,
  );
}

/** A package row of a `--json` envelope: what the lock records and whether it was found and verified. */
export const packageRows = (reports: readonly KitsPackageReport[]) =>
  reports.map((report) => ({
    name: report.entry.name,
    version: report.entry.version,
    kits: report.entry.kits.map((kit) => kit.id),
    state: report.status,
    ...(report.field === undefined ? {} : { field: report.field }),
    ...(report.error === undefined ? {} : { message: report.error.message }),
  }));
/** The human lines for the lock's packages of kits, empty when it records none, so a plain lock's output is unchanged. */
export function packageLines(reports: readonly KitsPackageReport[], caps: Capabilities): string {
  if (reports.length === 0) return '';
  return document(
    reports.map((report) =>
      entry(
        [
          words(
            report.status === 'installed'
              ? `Kits package ${report.entry.name}@${report.entry.version} is installed at ${report.dir} and matches the lock (${report.entry.kits.map((kit) => kit.id).join(', ')}; integrity ${report.integrity}).`
              : report.status === 'not-installed'
                ? `D${report.error!.message.slice(1)}.`
                : report.error!.message,
          ),
        ],
        { depth: 0, symbol: report.status === 'installed' ? 'info' : report.status === 'drift' ? 'error' : 'warning' },
        caps,
      ),
    ),
    { leadingBlank: true },
  );
}
