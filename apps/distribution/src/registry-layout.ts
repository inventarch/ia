import {
  DISTRIBUTION_LIMITS,
  decodeDistributionJson,
  packageId,
  range,
  text,
  version,
} from '@inventarch/db/distribution';
import { DistributionError, fail, object } from './files.js';

/** Registry spec §3 and §5.1 bounds. */
export const REGISTRY_LIMITS = Object.freeze({ indexBytes: 4 * 1024 * 1024, releases: 1000, reads: 256 });
export interface RegistryInfo {
  readonly format: 'ia.registry.v1';
  readonly name: string;
}
export interface RegistryDependency {
  readonly id: string;
  readonly range: string;
}
export interface RegistryRelease {
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly engine: string;
  readonly language: readonly string[];
  readonly dependencies: readonly RegistryDependency[];
  readonly withdrawn: boolean;
  readonly access: 'public' | 'licensed';
  readonly artifact?: string;
}
export interface PackageIndex {
  readonly format: 'ia.registry-package.v1';
  readonly id: string;
  readonly releases: readonly RegistryRelease[];
}
/** Deep freeze, matching installation-core.ts/minting.ts. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
const hex = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('INPUT-INVALID', `Invalid registry ${what} digest`);
  return v;
};
export const isDbRefusal = (error: unknown): error is Error & { code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'string' &&
  /^IA-DB-/.test((error as { code: string }).code);
/** `DbError.message` is `<IA-DB-code>: Distribution <reason>: <detail>` (packages/db/src/errors.ts:8); strip both so only the detail remains. */
export const stripDbPrefix = (message: string): string =>
  message.replace(/^IA-DB-[A-Z-]+: (?:Distribution [a-z-]+: )?/, '');
/** Re-raises a refusal from `work` with `prefix` and `suffix` around its message: a distribution refusal keeps its code, a db-layer refusal becomes INPUT-INVALID with its db prefix stripped. */
export function relabel<T>(work: () => T, prefix: string, suffix = ''): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DistributionError)
      fail(error.code.replace(/^IA-DIST-/, ''), `${prefix}${error.message}${suffix}`);
    if (isDbRefusal(error)) fail('INPUT-INVALID', `${prefix}${stripDbPrefix(error.message)}${suffix}`);
    throw error;
  }
}
/** Wraps one named field's decode: on a db-layer refusal, names the field (and the release version, once known) and drops the db code so the caller sees only `IA-DIST-*`. */
function field<T>(name: string, context: string | undefined, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (isDbRefusal(error))
      fail(
        'INPUT-INVALID',
        `Invalid registry metadata${context !== undefined ? ` for ${context}` : ''}: ${name}: ${stripDbPrefix(error.message)}`,
      );
    throw error;
  }
}
/** Catch-all for db-layer refusals not tied to one named field, e.g. malformed JSON. */
function dbDecode<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (isDbRefusal(error)) fail('INPUT-INVALID', stripDbPrefix(error.message));
    throw error;
  }
}
export function packageIndexPath(id: string): string {
  return dbDecode(() => `packages/${packageId(id)}.json`);
}
export function decodeRegistryInfo(content: string): RegistryInfo {
  return dbDecode(() => {
    const row = object(decodeDistributionJson(content), ['format', 'name']);
    if (row['format'] !== 'ia.registry.v1') fail('INPUT-INVALID', 'Not an ia.registry.v1 registry');
    return frozen({ format: 'ia.registry.v1' as const, name: field('name', undefined, () => text(row['name'], 128)) });
  });
}
export function decodePackageIndex(content: string, expectedId: string): PackageIndex {
  return dbDecode(() => {
    const id = field('id', undefined, () => packageId(expectedId));
    const value = decodeDistributionJson(content),
      keys =
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'signatures')
          ? ['format', 'id', 'releases', 'signatures']
          : ['format', 'id', 'releases'];
    const row = object(value, keys);
    if (row['format'] !== 'ia.registry-package.v1') fail('INPUT-INVALID', 'Not an ia.registry-package.v1 index');
    if (row['id'] !== id) fail('INPUT-INVALID', `Registry index names a different package than ${id}`);
    if (!Array.isArray(row['releases'])) fail('INPUT-INVALID', 'Registry releases must be an array');
    if (row['releases'].length > REGISTRY_LIMITS.releases)
      fail('LIMIT-EXCEEDED', 'Registry index exceeds 1000 releases');
    const versions = new Set<string>();
    const releases = row['releases'].map((entry): RegistryRelease => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        fail('INPUT-INVALID', 'Registry release must be an object');
      const raw = entry as Record<string, unknown>,
        access = raw['access'];
      if (access !== 'public' && access !== 'licensed')
        fail('INPUT-INVALID', 'Registry release access must be "public" or "licensed"');
      const licensed = access === 'licensed';
      // §3: `artifact` is present if and only if `access` is `"public"`; check that up front so the refusal names "artifact" instead of a generic unknown-field message.
      const hasArtifactField = Object.hasOwn(raw, 'artifact');
      if (hasArtifactField === licensed)
        fail('INPUT-INVALID', 'Registry artifact must be present if and only if access is public');
      const r = object(
        entry,
        licensed
          ? ['version', 'archive', 'manifest', 'engine', 'language', 'dependencies', 'withdrawn', 'access']
          : ['version', 'archive', 'manifest', 'engine', 'language', 'dependencies', 'withdrawn', 'access', 'artifact'],
      );
      // Registry metadata copies the release manifest's own fields (spec §3), so it decodes with the same codecs: `version`, `range` (engine and each dependency range) and the exact `['1.0']` grammar.
      const releaseVersion = field('version', undefined, () => version(r['version']));
      const archive = hex(r['archive'], 'archive');
      if (versions.has(releaseVersion)) fail('INPUT-INVALID', `Registry lists ${releaseVersion} more than once`);
      versions.add(releaseVersion);
      if (typeof r['withdrawn'] !== 'boolean') fail('INPUT-INVALID', 'Invalid registry withdrawn flag');
      if (!licensed && r['artifact'] !== `artifacts/${archive}.ia.tgz`)
        fail('INPUT-INVALID', 'Registry artifact must be artifacts/<archive>.ia.tgz relative to the base');
      if (!Array.isArray(r['language']) || r['language'].length !== 1 || r['language'][0] !== '1.0')
        fail('INPUT-INVALID', 'Registry language must be exactly ["1.0"]');
      if (!Array.isArray(r['dependencies']) || r['dependencies'].length > DISTRIBUTION_LIMITS.bundles)
        fail('INPUT-INVALID', 'Invalid registry dependency list');
      // Duplicate/self dependencies refuse the same way the manifest's own dependency lists do (packages/db/src/distribution/contracts.ts:29,45).
      const seenDependencies = new Set<string>();
      const dependencies = r['dependencies'].map((d) => {
        const dep = object(d, ['id', 'range']);
        const depId = field('dependency id', releaseVersion, () => packageId(dep['id']));
        if (depId === id) fail('INPUT-INVALID', `Registry release ${releaseVersion} depends on itself: ${depId}`);
        if (seenDependencies.has(depId))
          fail('INPUT-INVALID', `Registry release ${releaseVersion} lists dependency ${depId} more than once`);
        seenDependencies.add(depId);
        return { id: depId, range: field('dependency range', releaseVersion, () => range(dep['range'])) };
      });
      const engineValue = field('engine', releaseVersion, () => range(r['engine']));
      return {
        version: releaseVersion,
        archive,
        manifest: hex(r['manifest'], 'manifest'),
        engine: engineValue,
        language: ['1.0'],
        dependencies,
        withdrawn: r['withdrawn'],
        access,
        ...(licensed ? {} : { artifact: r['artifact'] as string }),
      };
    });
    return frozen({ format: 'ia.registry-package.v1' as const, id, releases });
  });
}
