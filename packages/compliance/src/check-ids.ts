/** The built-in compliance evaluators (C16). A leaf module so catalog code can import it without a cycle. */
export const CHECK_IDS = Object.freeze([
  'COMP-PARSE',
  'COMP-SCHEMA',
  'COMP-SYSTEM',
  'COMP-SCHEMA-ENROLLED',
  'COMP-CONSENT-DECLARED',
  'COMP-CONSENT',
  'COMP-IDENTITY',
  'COMP-SELECTOR',
  'COMP-VARIANT',
  'COMP-COVERAGE',
  'COMP-FRAGMENT',
  'COMP-ADOPTION',
  'COMP-KERNEL',
  'COMP-FIXTURES',
  'COMP-STEWARD',
  'COMP-BOOTSTRAP',
  'COMP-CHECK',
] as const);
export const isBuiltinCheck = (id: string): boolean => (CHECK_IDS as readonly string[]).includes(id);
