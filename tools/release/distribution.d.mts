import type { LanguageBase } from '../native/language-base.js';
import type { PackedDistribution } from '../../apps/distribution/src/snapshot.js';
import type { ReleaseDescriptor } from '../../packages/db/src/distribution/index.js';
export interface OptionalDistributionOptions {
  readonly directory: string;
  readonly systems: readonly string[];
  readonly descriptor: Omit<ReleaseDescriptor, 'engine' | 'language' | 'dependencies' | 'assets'> & {
    readonly engine?: string;
  };
  readonly assets: ReadonlyMap<string, Uint8Array> | readonly string[];
}
export function packOptionalDistribution(
  root: string,
  options: OptionalDistributionOptions,
): { language: LanguageBase; product: PackedDistribution };
