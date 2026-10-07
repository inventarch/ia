import type { Band } from '@inventarch/language';
import { snapshot } from './immutable.js';
import { canonicalRoot } from './paths.js';
import { compare, stableSerialize } from './revision.js';
import type { Claim, Graph, Node } from './types.js';

/**
 * G06c: the claimant fields, each a section field whose text values are path selections (position-and-projection row
 * 17; the covers-field-vs-predicate decision keeps `covers` a field, not a predicate): `covers` in a @mandate's
 * `authority`, a @law's or @convention's `subject` and a @spec's `work`, a @hook's `hook.paths` and a @check's
 * `check.scope`. A field is read by its path on any winner that holds it; schema admission keeps undeclared ones out.
 */
export const CLAIM_FIELDS: readonly string[] = Object.freeze([
  'authority.covers',
  'subject.covers',
  'work.covers',
  'hook.paths',
  'check.scope',
]);

/**
 * G06c: the claimant index, read once at load from every text value a winner holds in a claimant field, a list's
 * items in authored order. Equal (holder, field, selection) claims are stored once; holders order by identity.
 */
export function claimsOf(nodes: Iterable<Node>): Claim[] {
  const found = new Map<string, Claim>();
  for (const node of nodes)
    for (const section of node.sections)
      for (const child of section.fields) {
        if ('item' in child) continue;
        const field = `${section.name}.${child.key}`;
        if (!CLAIM_FIELDS.includes(field)) continue;
        for (const value of child.value.kind === 'list' ? child.value.items : [child.value]) {
          if (!('text' in value)) continue;
          const key = stableSerialize([node.identity, field, value.text]);
          if (!found.has(key))
            found.set(key, {
              from: node.identity,
              field,
              selection: value.text,
              source: { path: node.source.path, line: child.span.line, endLine: child.span.endLine },
            });
        }
      }
  // A stable sort: one holder's claims keep the order its record states them in.
  return [...found.values()].sort((a, b) => compare(a.from, b.from));
}

/** A selection's segments, a trailing `/` read as `/**`; undefined when it is not a workspace-relative selection. */
function selectionSegments(selection: string): readonly string[] | undefined {
  const text = selection.replaceAll('\\', '/');
  if (text === '' || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return undefined;
  const segments = (text.endsWith('/') ? `${text}**` : text).split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ? undefined : segments;
}
/** A path's canonical segments (none for the workspace root); undefined when it is absolute or escapes the workspace. */
function pathSegments(path: string): readonly string[] | undefined {
  let canonical: string;
  try {
    canonical = canonicalRoot(path);
  } catch {
    return undefined;
  }
  return canonical === '' ? [] : canonical.split('/');
}
/**
 * Wildcard matching with one backtrack point: `star(token)` matches any run of elements, every other token exactly one
 * element it accepts. At most pattern × text steps, so no authored selection backtracks exponentially.
 */
function wildcard<T>(
  pattern: readonly T[],
  text: readonly T[],
  star: (token: T) => boolean,
  accepts: (token: T, element: T) => boolean,
): boolean {
  let p = 0,
    t = 0,
    starAt = -1,
    resume = 0;
  while (t < text.length) {
    if (p < pattern.length && !star(pattern[p]!) && accepts(pattern[p]!, text[t]!)) {
      p++;
      t++;
    } else if (p < pattern.length && star(pattern[p]!)) {
      starAt = p++;
      resume = t;
    } else if (starAt >= 0) {
      p = starAt + 1;
      t = ++resume;
    } else return false;
  }
  while (p < pattern.length && star(pattern[p]!)) p++;
  return p === pattern.length;
}
const segmentAccepts = (pattern: string, segment: string): boolean =>
  wildcard(
    [...pattern],
    [...segment],
    (c) => c === '*',
    (c, d) => c === '?' || c === d,
  );
const matches = (pattern: readonly string[], target: readonly string[]): boolean =>
  wildcard(pattern, target, (segment) => segment === '**', segmentAccepts);

/**
 * G06c path selection dialect: whether `selection` selects the workspace-relative `path`. Both read `\` as `/`; the
 * path is canonicalized like a scope root and selects nothing when it is absolute or escapes the workspace. A selection
 * is `/`-separated segments: `**` as a whole segment matches zero or more segments, `*` any run of characters within
 * one segment, `?` exactly one character, anything else itself, case-sensitively; a trailing `/` stands for `/**`, so
 * `docs/` selects `docs` and everything below it. No braces, classes, escapes or negation, and a leading dot is not
 * special. An empty or absolute selection, or one with an empty, `.` or `..` segment, selects nothing.
 */
export function selects(selection: string, path: string): boolean {
  const pattern = selectionSegments(selection),
    target = pathSegments(path);
  return pattern !== undefined && target !== undefined && matches(pattern, target);
}

/** One claim of a claimant that selects the path: its claimant field and the selection as authored. */
export interface ClaimMatch {
  readonly field: string;
  readonly selection: string;
}
/** G06c: a record whose claimant field selects a path, with every claim that does, in index order. */
export interface Claimant {
  readonly identity: string;
  readonly band: Band;
  readonly matches: readonly ClaimMatch[];
}
/**
 * G06c: the winners whose claims select `path`, holders outside `scope` pruned, ordered band descending then identity
 * ascending (position-and-projection row 17). Reads the load-time claimant index; nothing is rescanned per query.
 */
export function claimants(graph: Graph, path: string, scope?: ReadonlySet<string>): readonly Claimant[] {
  const target = pathSegments(path);
  if (target === undefined) return Object.freeze([]);
  const found = new Map<string, ClaimMatch[]>();
  for (const claim of graph.claims) {
    if (scope !== undefined && !scope.has(claim.from)) continue;
    const pattern = selectionSegments(claim.selection);
    if (pattern === undefined || !matches(pattern, target)) continue;
    const held = found.get(claim.from) ?? [];
    held.push({ field: claim.field, selection: claim.selection });
    found.set(claim.from, held);
  }
  return snapshot(
    [...found]
      .map(([identity, held]) => ({ identity, band: graph.nodes.get(identity)!.band, matches: held }))
      .sort((a, b) => b.band - a.band || compare(a.identity, b.identity)),
  );
}
