import {
  canonicalDistributionJson,
  DISTRIBUTION_LIMITS,
  InstallationError,
  metadataDigest,
  satisfies,
} from './codec.js';
import { decodeGenerationInputs } from './contracts.js';
import type { BundleManifest, DistributionLock, GenerationInputs } from './contracts.js';

export interface BundleMetadata {
  readonly manifest: BundleManifest;
  readonly archiveDigest: string;
  readonly manifestDigest: string;
}
export function deriveGenerationInputs(
  lock: DistributionLock,
  releases: ReadonlyMap<string, BundleMetadata>,
): GenerationInputs {
  const fail = (message: string): never => {
    throw new InstallationError('conflict', message);
  };
  const systems = new Map<string, GenerationInputs['systems'][number] & { signature: string }>();
  let fileCount = 0;
  for (const pkg of lock.packages) {
    const release = releases.get(pkg.id);
    if (
      !release ||
      release.archiveDigest !== pkg.archive ||
      release.manifestDigest !== pkg.manifest ||
      release.manifest.id !== pkg.id ||
      release.manifest.version !== pkg.version
    )
      fail(`Missing exact selected artifact: ${pkg.id}`);
    const dependencies = release!.manifest.dependencies;
    fileCount += release!.manifest.files.length;
    if (fileCount > DISTRIBUTION_LIMITS.files) fail('Combined installation file limit');
    if (
      canonicalDistributionJson(dependencies.map((d) => d.id)) !== canonicalDistributionJson(pkg.dependencies) ||
      dependencies.some((d) => !lock.packages.some((p) => p.id === d.id && satisfies(p.version, d.range)))
    )
      fail(`Locked dependencies differ: ${pkg.id}`);
    for (const system of release!.manifest.systems) {
      const pins = release!.manifest.files.filter((f) => f.role === 'source' && f.path.startsWith(`${system.path}/`)),
        files = pins.map((f) => f.path),
        signature = metadataDigest({ provider: system.provider, version: system.version, files: pins });
      const known = systems.get(system.name);
      if (known && known.signature !== signature) fail(`Different provider/version/source bytes for ${system.name}`);
      systems.set(
        system.name,
        known
          ? { ...known, bundles: [...known.bundles, pkg.id] }
          : {
              name: system.name,
              provider: system.provider,
              version: system.version,
              bundles: [pkg.id],
              selected: pkg.id,
              files,
              signature,
            },
      );
    }
  }
  return decodeGenerationInputs({
    formatVersion: 1,
    bundles: lock.packages.map(({ id, archive }) => ({ id, archive })),
    systems: [...systems.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(({ signature: _signature, ...row }) => row),
  });
}
export function installationWorkspace(
  lock: DistributionLock,
  inputs: GenerationInputs,
  releases: ReadonlyMap<string, BundleMetadata>,
): string | null {
  if (!lock.packages.length) return null;
  const uses = lock.requests.map((r) => {
    const release = releases.get(r.id);
    if (!release) throw new InstallationError('conflict', 'Missing direct distribution');
    return `    uses @distribution ${release.manifest.distribution.split('/')[3]}`;
  });
  return `#! ia 1.0\n\n@workspace installed-distributions\n  meaning\n    says "The exact installed native distribution closure."\n    answers "Which distributions and systems are active?"\n  composition\n    systems [${inputs.systems.map((s) => `@system ${s.name}`).join(', ')}]\n  relationships\n${uses.join('\n')}\n`;
}
