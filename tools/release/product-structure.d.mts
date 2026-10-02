import type { LanguageBase } from '../native/language-base.js';
import type { PackedDistribution } from '../../apps/distribution/src/snapshot.js';
export function productStructure(root: string): { language: LanguageBase; product: PackedDistribution };
