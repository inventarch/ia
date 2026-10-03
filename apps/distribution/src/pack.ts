import { readInputs } from '@inventarch/db';
import { decodeReleaseDescriptor, DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { bytes, fail, workspace } from './files.js';
import { distributionSnapshot, packSnapshot, type PackedDistribution } from './snapshot.js';

/** Physical adapter: capture once, delegate native semantics, then recheck all bytes. */
export function packDistribution(rootInput: string, descriptorInput: unknown): PackedDistribution {
  const root = workspace(rootInput),
    descriptor = decodeReleaseDescriptor(descriptorInput),
    before = readInputs(root);
  const assets = new Map(
    descriptor.assets.map((asset) => {
      const content = bytes(root, asset.path, DISTRIBUTION_LIMITS.file);
      if (!content) fail('CLOSURE-INVALID', `Missing explicit asset: ${asset.path}`);
      return [asset.path, content] as const;
    }),
  );
  const snapshot = distributionSnapshot({
    sources: before.sources,
    folders: before.folders,
    floorOrigin: before.floorOrigin,
    ...(before.activation ? { activation: before.activation } : {}),
  });
  const packed = packSnapshot(snapshot, descriptor, assets);
  // Regular-file/link checks remain physical responsibilities even when bytes are unchanged.
  for (const pin of packed.manifest.files.filter((file) => file.role === 'source'))
    if (!bytes(root, pin.path, DISTRIBUTION_LIMITS.file)?.equals(packed.files.get(pin.path)!))
      fail('SOURCE-CHANGED', 'Native source changed during packing');
  if (
    readInputs(root).fingerprint !== before.fingerprint ||
    descriptor.assets.some(
      (asset) => !bytes(root, asset.path, DISTRIBUTION_LIMITS.file)?.equals(assets.get(asset.path)!),
    )
  )
    fail('SOURCE-CHANGED', 'Release inputs changed during packing');
  return packed;
}
