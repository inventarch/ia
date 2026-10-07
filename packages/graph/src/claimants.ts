import type { Band, CompiledChild, CompiledValue } from '@inventarch/language';
import { GraphUsageError } from './diagnostics.js';
import { canonicalRoot } from './paths.js';
import { compare } from './revision.js';
import type { Node } from './types.js';

/** A record field whose values are path selections (G15): `word` is the discriminator, `field` is `section.key`. */
export interface ClaimField {
  readonly word: string;
  readonly field: string;
}
/**
 * The closed table of path-selection fields the claimant index reads. A row whose word or field no schema declares yet
 * reads nothing; adding a field is one row here.
 */
export const CLAIM_FIELDS: readonly ClaimField[] = Object.freeze(
  [
    { word: 'convention', field: 'subject.covers' },
    { word: 'hook', field: 'hook.paths' },
    { word: 'law', field: 'subject.covers' },
    { word: 'mandate', field: 'authority.covers' },
    { word: 'playbook', field: 'subject.covers' },
    { word: 'spec', field: 'work.covers' },
  ].map((row) => Object.freeze(row)),
);
/** One path selection a winner declares in a CLAIM_FIELDS field; `source` is the field's span. */
export interface Claim {
  readonly identity: string;
  readonly word: string;
  readonly field: string;
  readonly selection: string;
  readonly band: Band;
  readonly source: { readonly path: string; readonly line: number; readonly endLine: number };
}
/** A declared selection that cannot be read, with the reason; it claims nothing. */
export interface InvalidClaim extends Claim {
  readonly reason: string;
}

const FORM =
  'Write a workspace-relative POSIX path: `*` matches within one segment, `**` matches any number of whole segments, a trailing `/` selects a directory and everything under it, and every other character is literal.';

/** Why `selection` is not a path selection, or undefined when it is one (G15). */
export function selectionProblem(selection: string): string | undefined {
  if (selection === '') return 'is empty';
  if (/^(?:\/|[A-Za-z]:)/.test(selection)) return 'is absolute; selections are relative to the workspace root';
  if (selection.includes('\\')) return 'uses a backslash; segments are separated by /';
  if (selection.startsWith('!')) return 'starts with !; negation is not supported';
  for (const segment of (selection.endsWith('/') ? selection.slice(0, -1) : selection).split('/')) {
    if (segment === '') return 'has an empty segment';
    if (segment === '.' || segment === '..') return 'has a . or .. segment';
    if (segment.includes('**') && segment !== '**') return 'uses ** inside a segment; ** must be a whole segment';
  }
  return undefined;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const segmentPattern = (segment: string): RegExp => new RegExp(`^${segment.split('*').map(escape).join('[^/]*')}$`);

/**
 * Whether the workspace-relative `path` lies in `selection` (G15). Both are POSIX paths compared case-sensitively;
 * `path` is canonicalized like a scope root. An invalid selection or a path outside the workspace is a usage error.
 */
export function matchesSelection(path: string, selection: string): boolean {
  const problem = selectionProblem(selection);
  if (problem !== undefined)
    throw new GraphUsageError('IA-GRAPH-SCOPE-INVALID', `Path selection '${selection}' ${problem}. ${FORM}`);
  const target = canonicalRoot(path),
    parts = target === '' ? [] : target.split('/');
  const pattern = selection.endsWith('/') ? [...selection.slice(0, -1).split('/'), '**'] : selection.split('/');
  const matchers = pattern.map((segment) => (segment === '**' ? null : segmentPattern(segment)));
  const memo = new Map<string, boolean>();
  const match = (p: number, s: number): boolean => {
    const key = `${p}:${s}`,
      known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (p === matchers.length) result = s === parts.length;
    else if (matchers[p] === null) result = match(p + 1, s) || (s < parts.length && match(p, s + 1));
    else result = s < parts.length && matchers[p]!.test(parts[s]!) && match(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

const texts = (value: CompiledValue): string[] =>
  value.kind === 'list'
    ? value.items.flatMap(texts)
    : value.kind === 'string' || value.kind === 'scalar' || value.kind === 'prose'
      ? [value.text]
      : [];
const claimOrder = (a: Claim, b: Claim): number =>
  compare(a.identity, b.identity) ||
  compare(a.field, b.field) ||
  compare(a.selection, b.selection) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line;

/**
 * G15: every path selection the winners declare in a CLAIM_FIELDS field, split into readable claims and invalid ones.
 * A selection is read from the field's value and from `- value` items beneath it; non-text values claim nothing.
 */
export function claimsOf(nodes: Iterable<Node>): { claims: Claim[]; invalidClaims: InvalidClaim[] } {
  const claims: Claim[] = [],
    invalidClaims: InvalidClaim[] = [];
  for (const node of nodes)
    for (const { word, field } of CLAIM_FIELDS) {
      if (node.discriminator !== word) continue;
      const [section, key] = field.split('.') as [string, string];
      const children: readonly CompiledChild[] = node.sections
        .filter((s) => s.name === section)
        .flatMap((s) => s.fields)
        .filter((child) => 'key' in child && child.key === key);
      for (const child of children) {
        if (!('key' in child)) continue;
        const values = [
          ...texts(child.value),
          ...(child.fields ?? []).flatMap((item) => ('item' in item ? texts(item.item) : [])),
        ];
        for (const selection of values) {
          const claim: Claim = {
            identity: node.identity,
            word,
            field,
            selection,
            band: node.band,
            source: { path: node.source.path, line: child.span.line, endLine: child.span.endLine },
          };
          const reason = selectionProblem(selection);
          if (reason === undefined) claims.push(claim);
          else invalidClaims.push({ ...claim, reason });
        }
      }
    }
  return { claims: claims.sort(claimOrder), invalidClaims: invalidClaims.sort(claimOrder) };
}
