import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
// `byRelease` is the codec's SemVer order, highest first; `compareVersions` below is the release history's, lowest first.
import { compareVersions as byRelease } from '@inventarch/db/distribution';
import { worksFloor } from './kit-root.js';
import { kitBindings, kitChecks, kitDelivery, readDescriptor, readSidecar, SIDECARS, sourcesDigest } from './kits.js';
import { checkFile, compareVersions, readReleases, releaseFile, RELEASES_FORMAT } from './releases.js';
import type { ReleaseIndex, ReleaseRow } from './releases.js';

/**
 * The one checker for a kit folder (ia-kb design/kit-lifecycle dec-006), with the version rule of dec-004.
 *
 * A finding is one of two levels. `integrity`: the folder contradicts itself (its descriptor, release history, sources
 * and sidecars disagree, or its version understates what changed); it always fails. `spec`: the folder lacks something
 * the minimum kit spec asks for; it fails a kit at 1.0.0 or above and is only reported for a kit on 0.x, which stays on
 * 0.x until it passes (dec-004: the first passing release is 1.0.0). A kit on 0.x with no findings is `ready`.
 *
 * A kit's class is read from its licence: `Apache-2.0` is public, `UNLICENSED` is private. A public kit depends only on
 * the language; a private kit depends only on the language and on public kits (kit-layering dec-001), which the caller
 * names by checking them in the same run.
 *
 * Not checked here, and said so by the command: the steward's name (not yet settled), the paired authoring agents, the
 * kit-contract cases, a runner for every contract and check record, and whether the versions a plugin names are
 * published.
 */
export type KitFindingLevel = 'integrity' | 'spec';
export type KitClass = 'public' | 'private';
export interface KitFinding {
  readonly rule: string;
  readonly level: KitFindingLevel;
  readonly message: string;
  /** Whether it fails the kit: every integrity finding, and a spec finding once the kit is at 1.0.0 or above. */
  readonly fails: boolean;
}
export interface KitReport {
  readonly dir: string;
  readonly folder: string;
  readonly id: string | null;
  readonly version: string | null;
  readonly class: KitClass | null;
  readonly offers: readonly string[];
  readonly findings: readonly KitFinding[];
  /** No integrity finding, and no spec finding once the kit is at 1.0.0 or above. */
  readonly ok: boolean;
  /** On 0.x with no finding at all: its next release may be 1.0.0. */
  readonly ready: boolean;
}

export const LANGUAGE_ID = 'inventarch/language';
const KIT_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-kit$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LICENCES = new Map<string, KitClass>([
  ['Apache-2.0', 'public'],
  ['UNLICENSED', 'private'],
]);
/**
 * The sidecars a release's recorded `sources` digest covers: the packer (the `ia` plugin's `kit.mjs`) reads
 * `handlers.json` after the four this package keys its read roots by.
 */
const RECORDED_SIDECARS = [...SIDECARS, 'handlers.json'];
const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts)$/;

const attempt = <T>(run: () => T): { value: T } | { error: string } => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const isDir = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** Validate the on-write declarations described by the kit runtime, without running their commands. */
function checkOnWrite(sidecar: Record<string, unknown>): void {
  const rows = sidecar['onWrite'];
  if (sidecar['format'] !== 1 || !Array.isArray(rows)) throw new Error('expected format 1 and an onWrite list');
  for (const [index, row] of rows.entries()) {
    const where = `onWrite[${index}]`;
    if (typeof row?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.name))
      throw new Error(`${where} needs a name`);
    if (
      !Array.isArray(row.extensions) ||
      !row.extensions.length ||
      !row.extensions.every((ext: unknown) => typeof ext === 'string' && /^\.[a-z0-9]+$/i.test(ext))
    )
      throw new Error(`${where} needs file extensions such as [".md"]`);
    if (row.marker !== undefined && (typeof row.marker !== 'string' || !/^[^/\\]+$/.test(row.marker)))
      throw new Error(`${where}.marker must be a file name`);
    if (row.maxDepth !== undefined && !(Number.isInteger(row.maxDepth) && row.maxDepth >= 0 && row.maxDepth <= 64))
      throw new Error(`${where}.maxDepth must be an integer from 0 to 64`);
    if (!Array.isArray(row.argv) || !row.argv.length || !row.argv.every((arg: unknown) => typeof arg === 'string'))
      throw new Error(`${where} needs a non-empty argv of strings`);
    for (const arg of row.argv as string[])
      for (const [, name] of arg.matchAll(/\$\{([^}]*)\}/g))
        if (!['NODE', 'KIT', 'PLUGIN'].includes(name!))
          throw new Error(`${where}.argv has unknown placeholder ${name}`);
    if (row.timeout !== undefined && !(Number.isInteger(row.timeout) && row.timeout >= 1 && row.timeout <= 25))
      throw new Error(`${where}.timeout must be an integer from 1 to 25`);
  }
}

/** Whether a folder is a kit folder: it holds a `releases.json` or a `.ia/release.json`. */
export const isKitFolder = (dir: string): boolean =>
  existsSync(join(dir, 'releases.json')) || existsSync(join(dir, '.ia', 'release.json'));

/** The kit folders a path names: itself when it is one, else its immediate subfolders that are. */
export function kitFolders(path: string): string[] {
  const dir = resolve(path);
  if (!isDir(dir)) return [];
  if (isKitFolder(dir)) return [dir];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name))
    .filter((child) => isDir(child) && isKitFolder(child));
}

interface Names {
  readonly records: ReadonlySet<string>;
  readonly offers: ReadonlySet<string>;
}
const recordKey = (row: unknown): string | undefined => {
  const value = row as { system?: unknown; word?: unknown; name?: unknown } | null;
  return value && typeof value.word === 'string' && typeof value.name === 'string'
    ? `${String(value.system ?? '')}/${value.word}/${value.name}`
    : undefined;
};
/**
 * One release's record names and offered keys: embedded in a format 1 row, or read from its per-version file, which
 * must be the file of that row (`checkFile`). Undefined when a format 1 row embeds none; an error when a format 2 file is
 * missing, unreadable or another release's.
 */
function releaseNames(dir: string, index: ReleaseIndex, row: ReleaseRow): Names | { error: string } | undefined {
  let records: readonly unknown[] | undefined = Array.isArray(row.records) ? row.records : undefined;
  let offers: unknown = (row as { offers?: unknown }).offers;
  if (index.format === RELEASES_FORMAT) {
    // The file name is built from the version, so only a release version names one.
    if (!SEMVER.test(String(row.version))) return { error: `release ${String(row.version)} is not a release version` };
    const name = releaseFile(row.version);
    const path = join(dir, name);
    try {
      const value = readJson(path);
      records = checkFile(index, row, value).records;
      offers = (value as { offers?: unknown }).offers;
    } catch (error) {
      return {
        error:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `${name} is missing`
            : `${name} is not the file of release ${row.version}: ${(error as Error).message}`,
      };
    }
  }
  if (records === undefined) return undefined;
  const keys = (offers as { keys?: unknown } | undefined)?.keys;
  return {
    records: new Set(records.map(recordKey).filter((key): key is string => key !== undefined)),
    offers: new Set(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []),
  };
}

type Bump = 'patch' | 'minor' | 'major';
const ORDER: readonly Bump[] = ['patch', 'minor', 'major'];
const part = (version: string): number[] => version.split('.').map(Number);
/** The bump from one release to the next, or null when the version did not move forward by one step's worth. */
function bumpOf(from: string, to: string): Bump | null {
  if (!SEMVER.test(from) || !SEMVER.test(to) || compareVersions(from, to) >= 0) return null;
  const [a, b] = [part(from), part(to)];
  return a[0] !== b[0] ? 'major' : a[1] !== b[1] ? 'minor' : 'patch';
}
/**
 * The version rule (dec-004): breaking needs a major, an addition a minor, anything else a patch. On 0.x the same
 * changes sit one step down, as SemVer reads 0.x: breaking needs a minor, and an addition may ride a patch.
 */
function versionRule(
  dir: string,
  index: ReleaseIndex,
  floors: ReadonlyMap<ReleaseRow, string>,
  find: (rule: string, message: string) => void,
): void {
  const rows = index.releases;
  const [previous, latest] = [rows.at(-2), rows.at(-1)];
  const [before, after] = [previous, latest].map((row) => {
    if (!row || !SEMVER.test(row.version)) return undefined;
    const names = releaseNames(dir, index, row);
    if (names && 'error' in names) {
      find('releases', names.error);
      return undefined;
    }
    return names;
  });
  if (!previous || !latest) return;
  const bump = bumpOf(previous.version, latest.version);
  if (bump === null) {
    find('version', `release ${latest.version} does not follow ${previous.version}`);
    return;
  }
  const breaking: string[] = [];
  const added: string[] = [];
  if (before && after) {
    const removed = [...before.records].filter((key) => !after.records.has(key));
    const dropped = [...before.offers].filter((key) => !after.offers.has(key));
    if (removed.length)
      breaking.push(`removes ${removed.length} record${removed.length === 1 ? '' : 's'} (${removed[0]})`);
    if (dropped.length)
      breaking.push(`drops the key ${dropped[0]}${dropped.length > 1 ? ` and ${dropped.length - 1} more` : ''}`);
    const records = [...after.records].filter((key) => !before.records.has(key));
    const keys = [...after.offers].filter((key) => !before.offers.has(key));
    if (records.length) added.push(`adds ${records.length} record${records.length === 1 ? '' : 's'} (${records[0]})`);
    if (keys.length) added.push(`adds the key ${keys[0]}${keys.length > 1 ? ` and ${keys.length - 1} more` : ''}`);
  }
  const was = floors.get(previous);
  const now = floors.get(latest);
  // The codec's comparison orders the highest first.
  if (was !== undefined && now !== undefined && byRelease(now, was) < 0)
    breaking.push(`raises the lowest IA version it works with from ${was} to ${now}`);
  const zero = part(latest.version)[0] === 0;
  const needs: Bump = breaking.length ? (zero ? 'minor' : 'major') : added.length && !zero ? 'minor' : 'patch';
  if (ORDER.indexOf(bump) < ORDER.indexOf(needs))
    find(
      'version',
      `release ${latest.version} is a ${bump} step from ${previous.version} but ${(breaking.length ? breaking : added).join(' and ')}: that needs a ${needs} step`,
    );
}

/** The record words a file's `@word name` headers name. */
const headers = (path: string): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  // Read without checking first: a file that is absent, or a folder in its place, names no records.
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return found;
    throw error;
  }
  for (const match of source.matchAll(/^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/gm))
    found.set(match[1]!, [...(found.get(match[1]!) ?? []), match[2]!]);
  return found;
};

/**
 * One kit folder, checked. `publicIds` are the public kits a private kit may depend on. A folder the checker cannot
 * read at all is reported as one failing finding, never thrown: one broken kit does not hide the others' reports.
 */
export function checkKit(dir: string, publicIds: ReadonlySet<string> = new Set()): KitReport {
  try {
    return inspect(dir, publicIds);
  } catch (error) {
    const message = `the kit folder could not be read: ${(error as Error).message}`;
    return {
      dir,
      folder: basename(dir),
      id: null,
      version: null,
      class: null,
      offers: [],
      findings: [{ rule: 'unreadable', level: 'integrity', message, fails: true }],
      ok: false,
      ready: false,
    };
  }
}
function inspect(dir: string, publicIds: ReadonlySet<string>): KitReport {
  const found: Omit<KitFinding, 'fails'>[] = [];
  const find = (level: KitFindingLevel) => (rule: string, message: string) => {
    found.push({ rule, level, message });
  };
  const [integrity, spec] = [find('integrity'), find('spec')];
  const folder = basename(dir);

  const releases = existsSync(join(dir, 'releases.json')) ? attempt(() => readReleases(dir)) : undefined;
  const rowsRead =
    releases && 'value' in releases
      ? releases.value.releases.every(
          (row) => row !== null && typeof row === 'object' && typeof row.version === 'string',
        )
      : false;
  const index = releases && 'value' in releases && rowsRead ? releases.value : undefined;
  if (releases === undefined) spec('releases', 'no releases.json: the kit has no recorded release');
  else if ('error' in releases) integrity('releases', releases.error);
  else if (!rowsRead) integrity('releases', 'releases.json holds a release row that is not an object with a version');

  const read = existsSync(join(dir, '.ia', 'release.json')) ? attempt(() => readDescriptor(dir)) : undefined;
  const plain =
    read && 'value' in read && read.value !== null && typeof read.value === 'object' && !Array.isArray(read.value);
  const descriptor = read && 'value' in read && plain ? read.value : undefined;
  if (read === undefined) integrity('descriptor', 'no .ia/release.json');
  else if ('error' in read) integrity('descriptor', `.ia/release.json is unreadable: ${read.error}`);
  else if (!plain) integrity('descriptor', '.ia/release.json is not a JSON object');

  const id = text(descriptor?.['id']) ?? index?.kit ?? null;
  const version = text(descriptor?.['version']) ?? null;
  const latest = index?.releases.at(-1);
  const licence = text(descriptor?.['license']);
  const kitClass = LICENCES.get(licence ?? '') ?? null;

  if (descriptor) {
    if (id === null || !KIT_ID.test(id))
      integrity('descriptor', `id ${JSON.stringify(descriptor['id'])} is not <publisher>/<name>-kit`);
    if (version === null || !SEMVER.test(version))
      integrity('descriptor', `version ${JSON.stringify(descriptor['version'])} is not a release version (x.y.z)`);
    if (index && text(descriptor['id']) !== index.kit)
      integrity(
        'descriptor',
        `.ia/release.json names ${String(descriptor['id'])} but releases.json names ${index.kit}`,
      );
    if (kitClass === null)
      spec(
        'licence',
        `licence ${JSON.stringify(descriptor['license'] ?? null)}: a public kit is Apache-2.0, a private kit UNLICENSED`,
      );
    const source = descriptor['source'] as { commit?: unknown } | undefined;
    if (text(source?.commit) === undefined) spec('source', 'the descriptor names no source commit');
  }

  if (index) {
    if (index.format !== RELEASES_FORMAT)
      spec('releases', `releases.json is format ${index.format ?? 1}; the spec asks for format ${RELEASES_FORMAT}`);
    if (!latest) spec('releases', 'releases.json records no release');
    const floors = new Map<ReleaseRow, string>();
    for (const row of index.releases) {
      if (!SEMVER.test(String(row.version)))
        integrity('releases', `release ${String(row.version)} is not a release version (x.y.z)`);
      if (row.works !== undefined) {
        const floor = attempt(() => worksFloor(row.works));
        if ('error' in floor)
          integrity(
            'works',
            `release ${row.version} names works ${JSON.stringify(row.works)}, which is not a SemVer range that admits an IA release`,
          );
        else floors.set(row, floor.value);
      }
    }
    versionRule(dir, index, floors, integrity);
  }
  if (latest && version !== null && SEMVER.test(version) && SEMVER.test(latest.version)) {
    const order = compareVersions(version, latest.version);
    if (order < 0)
      integrity('descriptor', `the descriptor is at ${version}, behind the latest release ${latest.version}`);
    if (
      index?.format === RELEASES_FORMAT &&
      (typeof latest['sources'] !== 'string' || !/^[a-f0-9]{64}$/.test(latest['sources']))
    )
      integrity('sources', `release ${latest.version} has no valid sources digest`);
    else if (order === 0 && typeof latest['sources'] === 'string') {
      const digest = attempt(() => sourcesDigest(dir, RECORDED_SIDECARS));
      if ('error' in digest) integrity('sources', digest.error);
      else if (digest.value !== latest['sources'])
        integrity(
          'sources',
          `the sources changed since release ${latest.version} was recorded: raise the version and record a release`,
        );
    }
  }
  if (latest) {
    if (latest.works === undefined)
      spec('works', `release ${latest.version} does not say which IA versions it works with (works)`);
    if (text(latest.cli) === undefined)
      spec('works', `release ${latest.version} does not record the IA version that packed it (cli)`);
  }

  // Sidecars name only the kit's own records.
  let offers: string[] = [];
  const kit = { dir, id: id ?? folder };
  const sidecars: [string, () => readonly string[]][] = [
    ['checks.json', () => kitChecks(kit).undeclared],
    ['delivery.json', () => kitDelivery(kit).undeclared],
    [
      'bindings.json',
      () => {
        const bindings = kitBindings(kit);
        offers = Object.keys(bindings.recommend).sort();
        return bindings.undeclared;
      },
    ],
  ];
  for (const [name, undeclared] of sidecars) {
    const result = attempt(undeclared);
    if ('error' in result) integrity('sidecars', `${name}: ${result.error}`);
    else if (result.value.length)
      integrity('sidecars', `${name} names what the kit does not declare: ${result.value.join(', ')}`);
  }
  for (const name of ['onwrite.json', 'handlers.json']) {
    const result = attempt(() => {
      const sidecar = readSidecar(kit, name);
      if (name === 'onwrite.json' && sidecar !== undefined) checkOnWrite(sidecar);
    });
    if ('error' in result) integrity('sidecars', `${name}: ${result.error}`);
  }

  // What the minimum spec asks a kit folder to hold.
  if (!isFile(join(dir, 'README.md'))) spec('readme', 'no README.md');
  const tests = join(dir, 'tests');
  if (!isDir(tests) || !readdirSync(tests).some((name) => TEST_FILE.test(name) && isFile(join(tests, name))))
    spec('tests', 'no tests/*.test.* file');
  const seat = headers(join(dir, '.ia', 'src', 'workspace.ia'));
  const missing = ['workspace', 'agent', 'mandate'].filter((word) => !seat.has(word));
  if (missing.length)
    spec(
      'seat',
      `.ia/src/workspace.ia declares no @${missing.join(', @')}: a kit has a seat workspace with its agent and mandate`,
    );
  if (offers.length === 0) spec('offers', 'bindings.json offers no work, knowledge or delivery key');

  // Layering.
  const dependencies = Array.isArray(descriptor?.['dependencies'])
    ? (descriptor!['dependencies'] as { id?: unknown }[])
    : [];
  for (const dependency of dependencies) {
    const on = text(dependency?.id);
    if (on === undefined || on === LANGUAGE_ID) continue;
    if (kitClass === 'public') spec('layering', `a public kit depends only on the language, not on ${on}`);
    else if (!publicIds.has(on)) spec('layering', `depends on ${on}, which is not a public kit checked in this run`);
  }

  const major = version !== null && SEMVER.test(version) ? part(version)[0]! : 0;
  const findings = found.map((finding) => ({ ...finding, fails: finding.level === 'integrity' || major >= 1 }));
  const failing = findings.filter((finding) => finding.fails);
  return {
    dir,
    folder,
    id,
    version,
    class: kitClass,
    offers,
    findings,
    ok: failing.length === 0,
    ready: major === 0 && findings.length === 0,
  };
}

/** Every kit folder under the given paths, checked together: ids are unique, and private kits see the public ones. */
export function checkKits(paths: readonly string[]): KitReport[] {
  // One folder spelled two ways (case, a link) is one kit.
  const seen = new Set<string>();
  const dirs = paths.flatMap(kitFolders).filter((dir) => {
    const real = realpathSync.native(dir);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
  const first = dirs.map((dir) => checkKit(dir));
  const publicIds = new Set(
    first.filter((report) => report.class === 'public' && report.id).map((report) => report.id!),
  );
  const reports = dirs.map((dir) => checkKit(dir, publicIds));
  return reports.map((report) => {
    const twins = reports.filter((other) => other.id !== null && other.id === report.id && other.dir !== report.dir);
    if (twins.length === 0) return report;
    const finding: KitFinding = {
      rule: 'unique',
      level: 'integrity',
      fails: true,
      message: `id ${report.id} is also the kit at ${twins.map((twin) => twin.dir).join(', ')}`,
    };
    return { ...report, findings: [...report.findings, finding], ok: false, ready: false };
  });
}
