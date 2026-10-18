// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/**
 * Select the same rows, in the same order, for the producer, verifier and fixture. New files never enter implicitly.
 * @template {{path: string, sha256: string}} T
 * @param {readonly T[]} inputs
 * @returns {T[]}
 */
export function recipeFiles<
  T extends {
    path: string;
    sha256: string;
  },
>(inputs: readonly T[]): T[];
/** The v2 companion keeps its original membership; the enclosing input descriptor binds all source bytes. */
export const RECIPE_VERSION: 'ia.packing-recipe.v1';
export const RECIPE_FILES: readonly string[];
/** Reviewed tooling import closure, including helpers bound by the enclosing full-source descriptor. */
export const RECIPE_TOOL_MODULES: readonly string[];
