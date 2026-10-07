import { PRIMITIVE_ANCHORS, SHAPE_ROWS } from '@inventarch/language';
import type { Phase, Primitive } from '@inventarch/language';
import { validateCoordinate } from '@inventarch/graph';
import type { Coordinate } from '@inventarch/graph';
import type { Shape } from './classify.js';
import { RuntimeError } from './errors.js';
import { freeze } from './types.js';

/**
 * The scope key K = (seat, shape, phase, depth, budget, word): what a position request asks for, before any record is
 * read. Normalizing a key is pure; resolving its seat and seeding its body belong to the reads that consume it.
 *
 * The primitive is derived here and only here: the frozen `context` and `select` routes keep requiring a declared
 * phase and primitive through `prepareCoordinate`, which this module does not change.
 */

/** The parts of a scope key, in key order. A primitive is not a part: it is derived from the shape. */
export const SCOPE_KEY_PARTS = Object.freeze(['seat', 'shape', 'phase', 'depth', 'budget', 'word'] as const);
export type ScopeKeyPart = (typeof SCOPE_KEY_PARTS)[number];
/** The largest depth (hops from the seeds) and budget (loaded records beyond the seat) a key may ask for. */
export const SCOPE_KEY_CAPS = Object.freeze({ depth: 2, budget: 64 });
/** The depth and budget a non-empty key gets when it omits them. An empty key is K0, with depth 0 and budget 0. */
export const SCOPE_KEY_DEFAULTS = Object.freeze({ depth: 1, budget: 16 });
/**
 * Constants of every body, not parts of the key: at most `pointers` record pointers before the rest is told as
 * tallies, and at most `cells` cells per record. Rules whose effective severity is blocking are outside the budget.
 */
export const SCOPE_BODY_LIMITS = Object.freeze({ pointers: 48, cells: 4 });

/** A scope key as a caller spells it; every part is optional. */
export interface ScopeKey {
  /** A seat: a path or a record identity, resolved against the workspace when the body is seeded. */
  readonly seat?: string;
  readonly shape?: string;
  readonly phase?: string;
  readonly depth?: number;
  readonly budget?: number;
  /** A word that restricts the seeds and tallies of the body. */
  readonly word?: string;
}
/** `declared` by the caller, `derived` from another part of the key, or a `default` constant. */
export type ScopeKeySource = 'declared' | 'derived' | 'default';
export interface NormalizedScopeKey {
  /** The declared seat, or null for the workspace seat. */
  readonly seat: string | null;
  readonly shape: Shape;
  readonly phase: Phase;
  readonly primitive: Primitive;
  readonly depth: number;
  readonly budget: number;
  readonly word: string | null;
  /** True when the key's value is K0, however it was spelled. */
  readonly k0: boolean;
  readonly sources: Readonly<Record<ScopeKeyPart | 'primitive', ScopeKeySource>>;
  /** The complete coordinate the key stands for: shape, phase and primitive. */
  readonly coordinate: Coordinate;
}

/** The shape of K0, which is also the shape a key gets when it omits one. */
const DEFAULT_SHAPE: Shape = 'context';
function invalid(message: string): never {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message);
}
function text(value: unknown, part: ScopeKeyPart): string {
  if (typeof value !== 'string' || value.length === 0) return invalid(`Scope key ${part} must be a non-empty string`);
  return value;
}
function count(value: unknown, part: 'depth' | 'budget'): number {
  const cap = SCOPE_KEY_CAPS[part];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > cap)
    return invalid(`Scope key ${part} must be an integer from 0 to ${cap}`);
  return value;
}

/**
 * Validate and complete a scope key. An empty key is K0: the workspace seat, the context shape, the orient phase,
 * depth 0, budget 0 and no word. A non-empty key gets depth 1 and budget 16 when it omits them. The primitive is the
 * shape row's primitive, and an omitted phase is that primitive's anchor phase. Unknown parts, values outside the
 * caps and malformed seats or words are IA-RUNTIME-REQUEST-INVALID; an unknown shape or phase keeps the coordinate
 * refusal, IA-GRAPH-COORDINATE-VALUE-UNKNOWN.
 */
export function normalizeScopeKey(input: unknown = {}): NormalizedScopeKey {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return invalid('Scope key must be an object');
  const key = input as Readonly<Record<string, unknown>>;
  for (const part of Object.keys(key))
    if (!(SCOPE_KEY_PARTS as readonly string[]).includes(part))
      invalid(`Unknown scope key part '${part}'; admitted: ${SCOPE_KEY_PARTS.join(', ')}`);
  const declared = (part: ScopeKeyPart): boolean => key[part] !== undefined;
  const empty = !SCOPE_KEY_PARTS.some(declared);
  const axes = validateCoordinate({ shape: key['shape'], phase: key['phase'] });
  const shape = (axes.shape ?? DEFAULT_SHAPE) as Shape,
    primitive = SHAPE_ROWS[shape].primitive as Primitive,
    phase = (axes.phase ?? PRIMITIVE_ANCHORS[primitive]) as Phase;
  const limits = empty ? { depth: 0, budget: 0 } : SCOPE_KEY_DEFAULTS;
  const seat = declared('seat') ? text(key['seat'], 'seat') : null,
    word = declared('word') ? text(key['word'], 'word') : null,
    depth = declared('depth') ? count(key['depth'], 'depth') : limits.depth,
    budget = declared('budget') ? count(key['budget'], 'budget') : limits.budget;
  const source = (part: ScopeKeyPart, omitted: ScopeKeySource): ScopeKeySource =>
    declared(part) ? 'declared' : omitted;
  return freeze({
    seat,
    shape,
    phase,
    primitive,
    depth,
    budget,
    word,
    k0:
      seat === null &&
      word === null &&
      depth === 0 &&
      budget === 0 &&
      shape === DEFAULT_SHAPE &&
      phase === PRIMITIVE_ANCHORS[SHAPE_ROWS[DEFAULT_SHAPE].primitive],
    sources: {
      seat: source('seat', 'default'),
      shape: source('shape', 'default'),
      phase: source('phase', 'derived'),
      primitive: 'derived',
      depth: source('depth', 'default'),
      budget: source('budget', 'default'),
      word: source('word', 'default'),
    },
    coordinate: { shape, phase, primitive },
  });
}
/** K0, the empty key's value: the body every workspace serves before anything is asked. */
export const K0: NormalizedScopeKey = normalizeScopeKey({});
