import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIdentity } from '@inventarch/db';
import { MethodError } from './errors.js';

/**
 * A kit's recorded releases, in either layout.
 *
 * Format 1: `releases.json` is `{ kit, releases: [{ version, archive, manifest, sources, language, cli, records }] }`.
 * Format 2: `releases.json` is an index `{ format: 2, kit, latest, releases }` whose rows keep every format 1 field in
 * order but name `releases/<version>.json` in `file` where `records` was, and each per-version file is
 * `{ format: 2, kit, version, archive, records, offers? }`. Expanding an index rebuilds the format 1 document.
 *
 * Decision dec-008 gives each document a plain identity beside those: `releases.json` is `kit-releases` and a per-version
 * file is `kit-release`, each `{ format: "<name>", formatVersion: N }` with the same members. The released shapes (no
 * identity key at all for format 1, an integer `format` of 2 otherwise) stay read; any other identity is refused.
 */
export const RELEASES_FORMAT = 2;

export interface ReleaseRow {
  readonly version: string;
  readonly archive?: string;
  readonly cli?: string;
  readonly file?: string;
  readonly records?: readonly unknown[];
  readonly [field: string]: unknown;
}
export interface ReleaseIndex {
  /** Absent in format 1; the integer 2, or the plain name `kit-releases` beside `formatVersion` (decision dec-008). */
  readonly format?: number | string;
  readonly formatVersion?: number;
  readonly kit: string;
  readonly latest?: string;
  readonly releases: readonly ReleaseRow[];
}
interface ReleaseFile {
  readonly format: number | string;
  readonly formatVersion?: number;
  readonly kit: string;
  readonly version: string;
  readonly archive: string;
  readonly records: readonly unknown[];
}

/** The version a `releases.json` document stands for: 1 (no identity at all) or 2, in either shape; undefined for any other. */
function indexVersion(index: object): 1 | 2 | undefined {
  if (!Object.hasOwn(index, 'format') && !Object.hasOwn(index, 'formatVersion')) return 1;
  return readIdentity(index, 'kit-releases', [1, 2], [{ key: 'format', value: RELEASES_FORMAT, version: 2 }])
    ?.version as 1 | 2 | undefined;
}

export const releaseFile = (version: string): string => `releases/${version}.json`;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** Checks a format 2 index: its latest is its last row, and every row names its own file. */
export function checkIndex(index: ReleaseIndex): ReleaseIndex {
  if (indexVersion(index) !== RELEASES_FORMAT || typeof index.kit !== 'string' || !Array.isArray(index.releases))
    throw new MethodError('not a format 2 releases.json index', 'IA-CORE-RELEASES');
  if (index.latest !== (index.releases.at(-1)?.version ?? null))
    throw new MethodError(
      `index latest ${index.latest} is not its last release ${index.releases.at(-1)?.version}`,
      'IA-CORE-RELEASES',
    );
  for (const row of index.releases)
    if (row.file !== releaseFile(row.version))
      throw new MethodError(
        `release ${row.version} names file ${row.file}, expected ${releaseFile(row.version)}`,
        'IA-CORE-RELEASES',
      );
  return index;
}

/** One per-version file, checked against its index row. */
export function checkFile(index: ReleaseIndex, row: ReleaseRow, file: unknown): ReleaseFile {
  const value = file as Partial<ReleaseFile> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    readIdentity(value, 'kit-release', [RELEASES_FORMAT], [{ key: 'format', value: RELEASES_FORMAT, version: 2 }]) ===
      undefined ||
    value.kit !== index.kit ||
    value.version !== row.version ||
    value.archive !== row.archive ||
    !Array.isArray(value.records)
  )
    throw new MethodError(
      `${row.file} does not belong to ${index.kit} ${row.version} ${row.archive}`,
      'IA-CORE-RELEASES',
    );
  return value as ReleaseFile;
}

/** Format 2 to format 1; `readFile` returns the parsed per-version file at a relative path. */
export function expandIndex(index: ReleaseIndex, readFile: (path: string) => unknown): ReleaseIndex {
  checkIndex(index);
  const releases = index.releases.map((row) => {
    const file = checkFile(index, row, readFile(row.file!));
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => (key === 'file' ? ['records', file.records] : [key, value])),
    ) as ReleaseRow;
  });
  return { kit: index.kit, releases };
}

/** The kit folder's release index as read: format 1, or a checked format 2 index. */
export function readReleases(kitDir: string): ReleaseIndex {
  const path = join(kitDir, 'releases.json');
  if (!existsSync(path)) throw new MethodError(`${kitDir} carries no releases.json`, 'IA-CORE-KIT');
  const releases = readJson(path) as ReleaseIndex;
  if (!releases.kit || !Array.isArray(releases.releases)) throw new MethodError(`${path} is malformed`, 'IA-CORE-KIT');
  const version = indexVersion(releases);
  if (version === undefined)
    throw new MethodError(
      `${path} has format ${String(releases.format)}; this core reads formats 1 and ${RELEASES_FORMAT}`,
      'IA-CORE-KIT',
    );
  if (version === RELEASES_FORMAT)
    try {
      checkIndex(releases);
    } catch (error) {
      throw new MethodError(`${path}: ${(error as Error).message}`, 'IA-CORE-KIT');
    }
  return releases;
}

/** One release's record names: embedded (format 1) or its per-version file (format 2), checked against the row. */
export function releaseRecords(kitDir: string, release: ReleaseRow): readonly unknown[] {
  if (Array.isArray(release.records)) return release.records;
  const index = readReleases(kitDir);
  const row = index.releases.find((r) => r.version === release.version && r.archive === release.archive);
  if (!row || typeof row.file !== 'string')
    throw new MethodError(
      `${kitDir} records no release ${release.version} with archive ${release.archive}`,
      'IA-CORE-KIT',
    );
  const path = join(kitDir, row.file);
  if (!existsSync(path)) throw new MethodError(`${kitDir} lacks ${row.file}`, 'IA-CORE-KIT');
  try {
    return checkFile(index, row, readJson(path)).records;
  } catch (error) {
    throw new MethodError((error as Error).message, 'IA-CORE-KIT');
  }
}

/** The whole history as format 1; a format 1 document passes through unchanged. */
export function expandReleases(kitDir: string): ReleaseIndex {
  const index = readReleases(kitDir);
  try {
    return indexVersion(index) === RELEASES_FORMAT ? expandIndex(index, (path) => readJson(join(kitDir, path))) : index;
  } catch (error) {
    throw error instanceof MethodError && error.code === 'IA-CORE-KIT'
      ? error
      : new MethodError((error as Error).message, 'IA-CORE-KIT');
  }
}

const parts = (version: string): (string | number)[] =>
  version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
/** Release order: numeric parts numerically, others as text; a missing part sorts first. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? -1) < (y[i] ?? -1) ? -1 : 1;
  return 0;
}
