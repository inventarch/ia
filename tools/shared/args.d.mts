// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/**
 * Strict named options for repository commands. Parsing has no effects. A value is
 * one argv item, even when it contains spaces; positional and repeated flags refuse.
 * @param {readonly string[]} argv
 * @param {{values?: readonly string[], booleans?: readonly string[], required?: readonly string[], exclusive?: readonly (readonly string[])[], allowEmpty?: readonly string[]}} contract
 */
export function parseOptions(
  argv: readonly string[],
  contract: {
    values?: readonly string[];
    booleans?: readonly string[];
    required?: readonly string[];
    exclusive?: readonly (readonly string[])[];
    allowEmpty?: readonly string[];
  },
): {
  /** @param {string} name @returns {string | undefined} */
  value(name: string): string | undefined;
  /** @param {string} name */
  has(name: string): boolean;
};
/** Shared explicit generation modes; usage parsing remains separate from evaluation.
 * @param {readonly string[]} argv @param {{defaultCheck?:boolean}} [options] @returns {'check'|'write'}
 */
export function generationMode(
  argv: readonly string[],
  {
    defaultCheck,
  }?: {
    defaultCheck?: boolean;
  },
): 'check' | 'write';
