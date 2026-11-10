/**
 * The identity of a persisted or wire document (decision dec-008, amendments A14 and A15): the plain kebab `format`
 * name and an integer `formatVersion`. A document written before that carries one of a few exact released shapes (an
 * integer `format`, a `schema` or `contract` literal, or a `formatVersion` with no name). Every reader lists those
 * shapes explicitly and refuses any other value; nothing here parses a suffix.
 */

/** One exact released shape: `key` holds `value`, and the document stood for `version`. */
export interface ReleasedIdentity {
  readonly key: 'format' | 'formatVersion' | 'schema' | 'contract';
  readonly value: string | number;
  readonly version: number;
}
/** What a reader found: the version the document stands for, whether it is the plain shape, and the keys it occupies. */
export interface DocumentIdentity {
  readonly version: number;
  readonly plain: boolean;
  readonly keys: readonly string[];
}
const own = (value: object, key: string): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(value, key);

/**
 * The identity `value` carries, or undefined when it is neither the plain shape (`format` equal to `name` with a
 * `formatVersion` in `versions`) nor one of the `released` shapes. A released shape carries no other identity key.
 */
export function readIdentity(
  value: unknown,
  name: string,
  versions: readonly number[],
  released: readonly ReleasedIdentity[],
): DocumentIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const format = own(value, 'format')?.value,
    version = own(value, 'formatVersion')?.value;
  if (format === name && typeof version === 'number' && versions.includes(version)) {
    // A document that also carries a released identity key (`schema`, `contract`) names itself twice, so it is neither.
    const mixed = released.some((shape) => !['format', 'formatVersion'].includes(shape.key) && own(value, shape.key));
    return mixed ? undefined : { version, plain: true, keys: ['format', 'formatVersion'] };
  }
  for (const shape of released) {
    if (own(value, shape.key)?.value !== shape.value) continue;
    if (shape.key !== 'format' && own(value, 'format') !== undefined) continue;
    if (shape.key !== 'formatVersion' && own(value, 'formatVersion') !== undefined) continue;
    return { version: shape.version, plain: false, keys: [shape.key] };
  }
  return undefined;
}

/**
 * The identity keys a writer emits: the plain name with its version when `plain`, else exactly the `released` keys, so
 * a released program that reads the document sees what it was released with.
 */
export function identityOf<N extends string, V extends number, R extends Readonly<Record<string, string | number>>>(
  plain: boolean,
  name: N,
  version: V,
  released: R,
): R | { readonly format: N; readonly formatVersion: V } {
  return plain ? { format: name, formatVersion: version } : released;
}
