import type { BundleMetadata, Dependency } from '@ia/db/distribution';
import type { RegistryRelease } from './registry-layout.js';
import { fail, json } from './files.js';

/** §5.3 step 2: the verified manifest must say what the index said. */
export function matchRegistryRelease<T extends BundleMetadata>(id: string, entry: RegistryRelease, archive: T): T {
  const m = archive.manifest,
    sorted = (list: readonly Dependency[]): string =>
      json(
        [...list].map((d) => ({ id: d.id, range: d.range })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      );
  if (
    m.id !== id ||
    m.version !== entry.version ||
    m.engine !== entry.engine ||
    JSON.stringify(m.language) !== JSON.stringify(entry.language) ||
    sorted(m.dependencies) !== sorted(entry.dependencies) ||
    archive.manifestDigest !== entry.manifest
  )
    fail('INTEGRITY-MISMATCH', `Registry metadata differs from the archive it names: ${id}@${entry.version}`);
  // §3 and §8: no registry can list an unpublished archive, so a registry that does is not serving what it claims to.
  if (m.source.repository === null)
    fail('INTEGRITY-MISMATCH', `Registry lists an unpublished archive: ${id}@${entry.version}`);
  return archive;
}
