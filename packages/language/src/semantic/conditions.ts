import type { FieldNode, Span } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic, LangCode } from '../diagnostics.js';
import { AXES } from '../taxonomy.js';
import type { SelectorTerm, Term } from './types.js';
import { canonicalValue, CONDITION_AXES, valuesFor } from './vocabulary.js';

type Refusal = { readonly ok: false; readonly diagnostic: Diagnostic };
type TermsResult<T> = { readonly ok: true; readonly terms: readonly T[] } | Refusal;
export type ConditionResult = { readonly ok: true; readonly condition?: readonly Term[] } | Refusal;

export function readTerms(
  words: readonly string[],
  mode: 'selector',
  path: string,
  span: Span,
): TermsResult<SelectorTerm>;
export function readTerms(words: readonly string[], mode: 'condition', path: string, span: Span): TermsResult<Term>;
export function readTerms(
  words: readonly string[],
  mode: 'condition' | 'selector',
  path: string,
  span: Span,
): TermsResult<Term>;
export function readTerms(
  words: readonly string[],
  mode: 'condition' | 'selector',
  path: string,
  span: Span,
): TermsResult<Term> {
  const axes: readonly string[] = mode === 'selector' ? AXES : CONDITION_AXES;
  const prefix = mode === 'selector' ? 'IA-LANG-SELECTOR' : 'IA-LANG-CONDITION';
  const fail = (suffix: string, message: string): Refusal => ({
    ok: false,
    diagnostic: diag(`${prefix}-${suffix}` as LangCode, path, span.line, message, { endLine: span.endLine }),
  });
  if (words.length < 3 || (words.length + 1) % 4 !== 0)
    return fail('MALFORMED', 'Expected one or more <name> is <value> terms joined by and.');
  const terms: Term[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < words.length; index += 4) {
    const axis = words[index]!;
    const authored = words[index + 2]!;
    if (
      words[index + 1] !== 'is' ||
      (index > 0 && words[index - 1] !== 'and') ||
      !/^[A-Za-z][A-Za-z0-9-]*$/.test(authored)
    ) {
      return fail('MALFORMED', 'Terms require literal is/and and bare word values.');
    }
    if (!axes.includes(axis))
      return fail(
        mode === 'selector' ? 'AXIS-UNKNOWN' : 'TERM-UNKNOWN',
        `Unknown ${mode} name ${axis}; expected ${axes.join(', ')}.`,
      );
    if (seen.has(axis)) return fail('MALFORMED', `Repeated ${mode} name ${axis}.`);
    const value = canonicalValue(axis, authored);
    if (value === undefined)
      return fail('VALUE-UNKNOWN', `Unknown ${axis} value ${authored}; expected ${valuesFor(axis)!.join(', ')}.`);
    seen.add(axis);
    terms.push({ axis: axis as Term['axis'], value });
  }
  terms.sort((a, b) => CONDITION_AXES.indexOf(a.axis) - CONDITION_AXES.indexOf(b.axis));
  return { ok: true, terms };
}

/** Reads only the condition. The specialized carrier reader owns other child structure. */
export function conditionOf(field: FieldNode, path: string): ConditionResult {
  const children = field.children.filter(
    (child): child is FieldNode => child.kind === 'field' && child.words[0] === 'when',
  );
  const fail = (message: string): Refusal => ({
    ok: false,
    diagnostic: diag('IA-LANG-CONDITION-MALFORMED', path, field.span.line, message, { endLine: field.span.endLine }),
  });
  if (children.length > 1 || (children.length > 0 && field.when !== undefined))
    return fail('Use one inline condition or one direct child when, never both or repeated children.');
  const child = children[0];
  if (child && (child.when !== undefined || child.value.kind !== 'scalar' || child.children.length > 0))
    return fail('A child when must contain bare condition terms and no children.');
  const words = field.when ?? child?.words.slice(1);
  if (words === undefined) return { ok: true };
  const result = readTerms(words, 'condition', path, child?.span ?? field.span);
  return result.ok ? { ok: true, condition: result.terms } : result;
}
