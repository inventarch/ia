import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { fetchBounded } from './bounded-fetch.js';
import { bytes, contained, fail, portable, utf8 } from './files.js';
import {
  decodePackageIndex,
  decodeRegistryInfo,
  packageIndexPath,
  REGISTRY_LIMITS,
  relabel,
} from './registry-layout.js';
import type { PackageIndex, RegistryInfo } from './registry-layout.js';

export type RegistryBase =
  | { readonly kind: 'https'; readonly url: string }
  | { readonly kind: 'dir'; readonly path: string };
/** Shared by every registry one command opens (spec §5.1); each document read takes one unit of `total`. */
export interface RegistryBudget {
  readonly total: number;
  remaining: number;
}
export const registryBudget = (total: number = REGISTRY_LIMITS.reads): RegistryBudget => ({ total, remaining: total });
export interface Registry {
  readonly base: RegistryBase;
  readonly info: RegistryInfo;
  /** Reads the current index on every call (§5.1: never cached); a missing index is an empty one ("the registry has no releases of X"). */
  index(id: string): Promise<PackageIndex>;
  artifactUrl(archive: string): string;
  /** A directory registry's exact artifact bytes, read with links and hard links refused (`bytes`); a missing artifact is ARTIFACT-UNAVAILABLE. */
  artifactBytes(archive: string): Buffer;
}
export const registryLocation = (base: RegistryBase): string => (base.kind === 'https' ? base.url : base.path);
/** Registry spec §4: an HTTPS URL (credential-free, no query or fragment) or a directory, resolved against `from` when relative. A scheme of two or more characters marks a URL, so `C:\…` stays a directory. */
export function parseRegistryBase(value: string, from: string): RegistryBase {
  if (!value) fail('INPUT-INVALID', 'Registry base must not be empty');
  if (value.trim() !== value) fail('INPUT-INVALID', 'Registry base must not have surrounding whitespace');
  if (!/^[a-z][a-z0-9+.-]+:/i.test(value))
    return { kind: 'dir', path: isAbsolute(value) ? resolve(value) : resolve(from, value) };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('INPUT-INVALID', 'Registry base is not a valid URL');
  }
  if (url.protocol !== 'https:') fail('INPUT-INVALID', 'Registry URLs must be HTTPS');
  // `new URL` drops an empty userinfo, query or fragment, so the raw text is checked too.
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value) || /^[^/]*\/\/[^/?#]*@/.test(value))
    fail('INPUT-INVALID', 'Registry URLs must be credential-free, without query or fragment');
  return { kind: 'https', url: url.href.endsWith('/') ? url.href : `${url.href}/` };
}
const archivePath = (archive: string): string => {
  if (!/^[a-f0-9]{64}$/.test(archive)) fail('INPUT-INVALID', 'Invalid registry archive digest');
  return `artifacts/${archive}.ia.tgz`;
};
/** A registry document under the shared transport bounds (`fetchBounded`); a 404 is `null`. */
const fetchDocument = (url: string, signal: AbortSignal | undefined): Promise<Buffer | null> =>
  fetchBounded({
    url,
    signal,
    limit: REGISTRY_LIMITS.indexBytes,
    label: 'Registry request',
    optional: true,
    oversize: (grew) =>
      grew ? `Registry document grew beyond 4 MiB: ${url}` : `Registry document exceeds 4 MiB: ${url}`,
  });
/** A directory base must exist as a directory; links and junctions on its path refuse (`contained`). */
function directory(path: string): string {
  const root = contained(path);
  if (!existsSync(root) || !lstatSync(root).isDirectory())
    fail('INPUT-INVALID', `Not a registry: ${path} is not a directory`);
  return realpathSync(root);
}
/** Decodes one document, re-raising a refusal with `prefix` and `suffix` around its message (`relabel`). */
const decoded = <T>(content: Buffer, decode: (text: string) => T, prefix: string, suffix: string): T =>
  relabel(() => decode(utf8(content)), prefix, suffix);
/**
 * Opens one registry: reads `ia-registry.json` once (§3). `budget` is shared across every registry a command opens (§5.1).
 * `missing`, when given, refuses in place of "Not a registry" for a base that answers without `ia-registry.json`, and
 * receives its location; every other refusal is unchanged.
 */
export async function openRegistry(
  base: RegistryBase,
  options: {
    budget?: RegistryBudget;
    signal?: AbortSignal | undefined;
    missing?: ((location: string) => never) | undefined;
  } = {},
): Promise<Registry> {
  const { signal } = options,
    budget = options.budget ?? registryBudget(),
    where = registryLocation(base);
  signal?.throwIfAborted();
  const root = base.kind === 'dir' ? directory(base.path) : undefined;
  const at = (path: string): string => (root === undefined ? `${where}${path}` : join(where, path));
  const read = async (path: string): Promise<Buffer | null> => {
    portable(path);
    signal?.throwIfAborted();
    if (budget.remaining <= 0) fail('RESOLUTION-LIMIT', `Resolution exceeded ${budget.total} registry reads`);
    budget.remaining -= 1;
    return root === undefined ? fetchDocument(at(path), signal) : bytes(root, path, REGISTRY_LIMITS.indexBytes);
  };
  const infoContent = await read('ia-registry.json');
  if (infoContent === null) {
    options.missing?.(where);
    fail('INPUT-INVALID', `Not a registry: ${where} has no ia-registry.json`);
  }
  const info = decoded(infoContent, decodeRegistryInfo, `Not a registry: ${where}: `, '');
  return {
    base,
    info,
    async index(id) {
      const path = packageIndexPath(id),
        content = await read(path);
      if (content === null)
        return Object.freeze({ format: 'ia.registry-package.v1' as const, id, releases: Object.freeze([]) });
      return decoded(content, (text) => decodePackageIndex(text, id), '', `: ${at(path)}`);
    },
    artifactUrl: (archive) => {
      if (root !== undefined) fail('INPUT-INVALID', 'Directory registries have no artifact URL');
      return `${where}${archivePath(archive)}`;
    },
    artifactBytes: (archive) => {
      if (root === undefined) fail('INPUT-INVALID', 'HTTPS registries have no artifact path');
      const path = archivePath(archive);
      return (
        bytes(root, path, DISTRIBUTION_LIMITS.compressed) ??
        fail('ARTIFACT-UNAVAILABLE', `Registry ${where} has no ${path}`)
      );
    },
  };
}
