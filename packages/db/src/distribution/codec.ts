import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import semver from 'semver';
import { DbError } from '../errors.js';
import { parseStrictJson } from '../json.js';

export const DISTRIBUTION_LIMITS = Object.freeze({
  metadata: 4 * 1024 * 1024,
  compressed: 64 * 1024 * 1024,
  expanded: 256 * 1024 * 1024,
  files: 10_000,
  file: 16 * 1024 * 1024,
  bundles: 128,
  assignments: 1000,
});
export type DistributionReason =
  | 'contract-invalid'
  | 'restore-required'
  | 'lock-drift'
  | 'engine-incompatible'
  | 'corrupt-state'
  | 'recovery-required'
  | 'conflict';
export class InstallationError extends DbError {
  constructor(
    readonly reason: DistributionReason,
    message: string,
  ) {
    super('IA-DB-SOURCE-UNAVAILABLE', `Distribution ${reason}: ${message}`);
    this.name = 'InstallationError';
  }
}
export function refuse(message: string): never {
  throw new InstallationError('contract-invalid', message);
}
export const sha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');
export const metadataDigest = (value: unknown): string => sha256(stableSerialize(value));
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refuse('Expected a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !keys.includes(name) ||
        !descriptors[name]?.enumerable ||
        !Object.hasOwn(descriptors[name]!, 'value'),
    )
  )
    refuse('Unknown, missing or accessor field');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > max ||
    Buffer.from(value).toString('utf8') !== value ||
    /[\u0000-\u001f]/.test(value)
  )
    refuse('Expected bounded Unicode text');
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    refuse('Integer exceeds its bound');
  return value;
}
export function array(value: unknown, max: number = DISTRIBUTION_LIMITS.files): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !Object.hasOwn(d, 'value'))
  )
    refuse('Expected bounded dense data array');
  return value;
}
export function sorted<T>(values: readonly T[], key: (v: T) => string): readonly T[] {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && compare(previous, current) >= 0) refuse('Rows must be sorted and unique');
    previous = current;
  }
  return values;
}
export function identifier(value: unknown): string {
  const v = text(value, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(v)) refuse('Invalid identifier');
  return v;
}
export function packageId(value: unknown): string {
  const v = text(value, 128);
  if (!/^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*$/.test(v) || v.includes('..'))
    refuse('Expected provider/name distribution id');
  return v;
}
export function hash(value: unknown): string {
  const v = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(v)) refuse('Expected SHA-256');
  return v;
}
export function identity(value: unknown): string {
  const v = text(value);
  if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(v))
    refuse('Expected canonical native identity');
  return v;
}
export function version(value: unknown): string {
  const v = text(value, 128),
    parsed = semver.parse(v);
  if (!parsed || `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}` !== v)
    refuse('Expected exact canonical SemVer');
  return v;
}
export function range(value: unknown): string {
  const v = text(value, 256);
  if (semver.validRange(v) === null) refuse('Expected a SemVer range');
  return v;
}
export const satisfies = (v: string, r: string): boolean => semver.satisfies(version(v), range(r));
/**
 * The distribution engine this reader is. 0.1.2 reads a lock's `entries`, whose one kind is the npm package of kits
 * (`package`); every lock and archive an earlier 0.1 engine reads, it reads unchanged.
 */
export const DISTRIBUTION_ENGINE_VERSION = '0.1.2';
/**
 * The engine marker an archive descriptor, and a lock with no `entries`, still declares: what 3.x CLIs before the
 * package entry wrote, so such a lock or archive keeps its bytes and every released 0.1.1 engine still reads it.
 */
export const RELEASE_ENGINE_VERSION = '0.1.1';
/** First engine that reads a lock's `entries`; a lock holding one declares a range no earlier engine satisfies. */
export const PACKAGE_ENTRY_ENGINE_VERSION = '0.1.2';
/** The first `@inventarch/cli` release of each engine, for the version a refusal tells an older reader to install. */
export const ENGINE_RELEASES: Readonly<Record<string, string>> = Object.freeze({
  '0.1.0': '2.0.0',
  '0.1.1': '3.0.0',
  '0.1.2': '3.5.0',
});
/** Released solvers wrote their exact producer marker (0.1.0 in 2.x, 0.1.1 in 3.x); each reads as its 0.1 line. */
const RELEASED_LOCK_MARKERS: ReadonlySet<string> = new Set(['0.1.0', '0.1.1']);
export const supportsDistributionLockEngine = (engine: string, declared: string): boolean =>
  satisfies(engine, RELEASED_LOCK_MARKERS.has(declared) ? `^${declared}` : declared);
/**
 * The engine a lock written by an engine-`reader` solver declares: the marker every released 0.1.1 engine reads, or,
 * when the lock holds `entries`, the package entry's range. A reader other than this one keeps its own marker.
 */
export const lockEngineMarker = (reader: string, entries: boolean): string =>
  entries
    ? `^${PACKAGE_ENTRY_ENGINE_VERSION}`
    : reader === DISTRIBUTION_ENGINE_VERSION
      ? RELEASE_ENGINE_VERSION
      : reader;
/** The `ia` release that first reads `declared`, as `ia >= <version>`, or null when no engine this reader knows does. */
export function requiredRelease(declared: string): string | null {
  const first = Object.keys(ENGINE_RELEASES)
    .sort(semver.compare)
    .find((engine) => supportsDistributionLockEngine(engine, declared));
  return first === undefined ? null : `ia >= ${ENGINE_RELEASES[first]}`;
}
/** First engine capability that can read a pinned root release-control source. */
export const ROOT_RELEASE_CONTROL_ENGINE_VERSION = '0.1.1';
/** Every engine a control archive advertises must support its source profile, including disjoint range branches. */
export const supportsRootReleaseControls = (engine: string): boolean =>
  semver.subset(range(engine), `>=${ROOT_RELEASE_CONTROL_ENGINE_VERSION}`);
export const compareVersions = (a: string, b: string): number =>
  semver.rcompare(version(a), version(b)) || compare(a, b);
export function portablePath(value: unknown): string {
  const v = text(value);
  if (
    v !== v.normalize('NFC') ||
    /[\\<>:"|?*]/.test(v) ||
    v
      .split('/')
      .some(
        (p) =>
          !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      )
  )
    refuse('Unsafe portable path');
  return v;
}
/** Strict JSON transport; duplicate decoded keys are rejected before object construction. */
export function decodeDistributionJson(input: string): unknown {
  return parseStrictJson(input, { bytes: DISTRIBUTION_LIMITS.metadata, depth: 16, nodes: 200_000 }, (_fault, message) =>
    refuse(message),
  );
}
/** Bounded canonical data copy also rejects accessors, cycles and custom instances. */
export function data(value: unknown): unknown {
  if (typeof value === 'string') return decodeDistributionJson(value);
  let budget = DISTRIBUTION_LIMITS.metadata,
    count = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 16 || ++count > 200_000 || (budget -= 8) < 0) refuse('Metadata complexity limit');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v))) return v;
    if (typeof v === 'string') {
      if (Buffer.from(v).toString('utf8') !== v || (budget -= Buffer.byteLength(v)) < 0)
        refuse('Metadata string limit/encoding');
      return v;
    }
    if (!v || typeof v !== 'object' || seen.has(v)) refuse('Expected acyclic metadata data');
    seen.add(v);
    if (Array.isArray(v)) {
      const result = array(v, 200_000).map((item) => visit(item, depth + 1));
      seen.delete(v);
      return result;
    }
    const names = Reflect.ownKeys(v);
    if (names.some((n) => typeof n !== 'string')) refuse('Symbol metadata key');
    const row = object(v, names as string[]),
      result = Object.create(null) as Record<string, unknown>;
    for (const name of names as string[]) {
      budget -= Buffer.byteLength(name);
      result[name] = visit(row[name], depth + 1);
    }
    seen.delete(v);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > DISTRIBUTION_LIMITS.metadata) refuse('Metadata serialized limit');
  return result;
}
export function canonicalDistributionJson(value: unknown): string {
  const clean = data(value);
  return (
    JSON.stringify(clean, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
        : item,
    ) + '\n'
  );
}
