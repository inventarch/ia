/**
 * The one switch of this package for the contract names it compiles into harnesses (decision dec-008, amendment A15).
 *
 * Older, separately released programs read the harnesses and manifests that name these contracts. While this is
 * `false` a record that names an original contract (`runner-local-v1` and the others) compiles to that original
 * entry, which the catalog still installs byte for byte; the plain entries stay installed and a record that names one
 * still compiles to it. The follow-up release flips it to `true`, and records that name an original contract then
 * compile to the plain entry.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
