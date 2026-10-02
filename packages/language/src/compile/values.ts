import type { FieldNode, Value } from '../ast.js';

/** A compiled value: the AST value without its raw spelling (spec 10.2). */
export type CompiledValue =
  | { readonly kind: 'scalar' | 'string' | 'prose'; readonly text: string }
  | { readonly kind: 'ref'; readonly discriminator: string; readonly name: string; readonly fragment?: string }
  | { readonly kind: 'list'; readonly items: readonly CompiledValue[] }
  | { readonly kind: 'block' }
  | { readonly kind: 'none' };

export function compiledValue(value: Value): CompiledValue {
  switch (value.kind) {
    case 'scalar':
    case 'string':
    case 'prose':
      return { kind: value.kind, text: value.text };
    case 'ref':
      return {
        kind: 'ref',
        discriminator: value.discriminator,
        name: value.name,
        ...(value.fragment === undefined ? {} : { fragment: value.fragment }),
      };
    case 'list':
      return { kind: 'list', items: value.items.map(compiledValue) };
    case 'block':
      return { kind: 'block' };
    case 'none':
      return { kind: 'none' };
  }
}

/** The words of a spelled key: `['lowers', 'to']`. */
export type Spelling = readonly string[];

/**
 * The key rule (spec 2.1) resolved against spelled keys (spec 10.2). A line whose value is not a
 * bare scalar keeps the parser's key: every word before the value. On an all-words line the longest
 * spelling that starts the words is the key and the remaining words are the scalar; with no spelling
 * the parser's first-word key stands. The assertive form keeps the parser's reading.
 */
export function resolveKey(
  field: FieldNode,
  spellings: readonly Spelling[],
): { readonly key: string; readonly value: CompiledValue } {
  if (field.assertive === true || field.value.kind !== 'scalar')
    return { key: field.key, value: compiledValue(field.value) };
  let best: Spelling | undefined;
  for (const spelling of spellings) {
    if (spelling.length === 0 || spelling.length > field.words.length) continue;
    if (!spelling.every((word, index) => field.words[index] === word)) continue;
    if (best === undefined || spelling.length > best.length) best = spelling;
  }
  if (best === undefined) return { key: field.key, value: compiledValue(field.value) };
  const rest = field.words.slice(best.length);
  return {
    key: best.join(' '),
    value: rest.length === 0 ? { kind: 'none' } : { kind: 'scalar', text: rest.join(' ') },
  };
}
