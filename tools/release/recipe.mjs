/** The v2 companion keeps its original membership; the enclosing input descriptor binds all source bytes. */
export const RECIPE_VERSION = 'ia.packing-recipe.v1';
export const RECIPE_FILES = Object.freeze([
  'tools/distribution/system-package-policy.json',
  'tools/release/SPEC.md',
  'tools/release/distribution.d.mts',
  'tools/release/distribution.mjs',
  'tools/release/native-archives.ts',
  'tools/release/native-selectors.d.mts',
  'tools/release/native-selectors.mjs',
  'tools/release/native-version.test.ts',
  'tools/release/native-version.ts',
  'tools/release/pack-manifest.mjs',
  'tools/release/packed-content.d.mts',
  'tools/release/packed-content.mjs',
  'tools/release/product-structure.d.mts',
  'tools/release/product-structure.mjs',
  'tools/release/public-content.test.ts',
  'tools/release/public-pack.d.mts',
  'tools/release/public-pack.mjs',
  'tools/release/public/content-scan.d.mts',
  'tools/release/public/content-scan.mjs',
  'tools/release/scan-packed.d.mts',
  'tools/release/scan-packed.mjs',
  'tools/release/shared/pack-inputs.mjs',
  'tools/release/shared/paths.d.mts',
  'tools/release/shared/paths.mjs',
  'tools/release/system-packages.ts',
  'tools/release/system-partitions.ts',
]);

/** Reviewed tooling import closure, including helpers bound by the enclosing full-source descriptor. */
export const RECIPE_TOOL_MODULES = Object.freeze([
  'tools/entry/is-entry.mjs',
  'tools/entry/package-manager.mjs',
  'tools/native/check.ts',
  'tools/native/compile.ts',
  'tools/native/language-base.ts',
  'tools/native/meaning.ts',
  'tools/native/public-language.ts',
  'tools/native/public-manifest.mjs',
  'tools/native/release-roots.ts',
  'tools/native/release-work.ts',
  'tools/native/repository-architecture.ts',
  'tools/release/distribution.mjs',
  'tools/release/native-archives.ts',
  'tools/release/native-selectors.mjs',
  'tools/release/native-version.ts',
  'tools/release/pack-manifest.mjs',
  'tools/release/packed-content.mjs',
  'tools/release/product-structure.mjs',
  'tools/release/public-pack.mjs',
  'tools/release/public/content-scan.mjs',
  'tools/release/recipe.mjs',
  'tools/release/scan-packed.mjs',
  'tools/release/shared/pack-inputs.mjs',
  'tools/release/shared/paths.mjs',
  'tools/release/system-packages.ts',
  'tools/release/system-partitions.ts',
  'tools/shared/args.mjs',
  'tools/shared/paths.mjs',
  'tools/temp/physical-temp.mjs',
]);

/**
 * Select the same rows, in the same order, for the producer, verifier and fixture. New files never enter implicitly.
 * @template {{path: string, sha256: string}} T
 * @param {readonly T[]} inputs
 * @returns {T[]}
 */
export function recipeFiles(inputs) {
  const selected = new Set(RECIPE_FILES);
  const seen = new Set();
  const rows = [];
  for (const row of inputs) {
    if (seen.has(row.path)) throw new Error('Duplicate recipe input: ' + row.path);
    seen.add(row.path);
    if (!selected.has(row.path)) continue;
    if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid recipe input digest: ' + row.path);
    rows.push(row);
  }
  for (const path of selected) if (!seen.has(path)) throw new Error('Missing recipe input: ' + path);
  return rows;
}
