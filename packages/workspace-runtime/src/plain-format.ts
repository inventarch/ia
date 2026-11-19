import { WRITE_PLAIN_NAMES } from './written-names.js';

/**
 * A document names its format plainly and carries an integer `formatVersion`, so no identifier carries its version in
 * its name. A document written before that carries exactly one of its recorded legacy literals and no `formatVersion`;
 * each reader lists those literals explicitly, and nothing here parses a suffix.
 */
export type Stamp<N extends string = string, L extends string = string> =
  | { readonly format: N; readonly formatVersion: 1 }
  | { readonly format: L; readonly formatVersion?: never };
export type FormatStamp = Stamp;
/** The plain stamp, with `formatVersion` 1. */
export const currentStamp = <N extends string>(name: N): { readonly format: N; readonly formatVersion: 1 } => ({
  format: name,
  formatVersion: 1,
});
/** The stamp a writer emits: the plain one once `WRITE_PLAIN_NAMES` is `true`, otherwise the released literal. */
export const writeStamp = <N extends string, L extends string>(name: N, legacy: L): Stamp<N, L> =>
  WRITE_PLAIN_NAMES ? currentStamp(name) : { format: legacy };
/** A scalar identifier a writer emits: `plain` once `WRITE_PLAIN_NAMES` is `true`, otherwise `legacy`. */
export const written = <N, L>(plain: N, legacy: L): N | L => (WRITE_PLAIN_NAMES ? plain : legacy);
/** The stamp `value` already carries under its own recorded literal, or undefined when it is neither form. */
export function peekStamp<N extends string, L extends string>(
  value: unknown,
  name: N,
  legacy: readonly L[] = [],
): Stamp<N, L> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const format = Object.getOwnPropertyDescriptor(value, 'format')?.value as unknown,
    version = Object.getOwnPropertyDescriptor(value, 'formatVersion');
  if (format === name && version?.value === 1) return currentStamp(name);
  if (typeof format === 'string' && version === undefined) {
    const known = legacy.find((literal) => literal === format);
    if (known !== undefined) return { format: known };
  }
  return undefined;
}
/** The keys a stamp occupies in a closed document. */
export const stampKeys = (stamp: Stamp | undefined): readonly string[] =>
  stamp?.formatVersion === undefined ? ['format'] : ['format', 'formatVersion'];
