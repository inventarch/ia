import { isAbsolute, relative, sep } from 'node:path';
import { PHASES, PRIMITIVE_ANCHORS, SHAPE_ROWS, SHAPES, isPhase } from '@inventarch/language';
import type { Phase } from '@inventarch/language';
import type { ReadHandle, SeatResolution } from '@inventarch/db';
import type { Shape } from './classify.js';
import { scopeCoordinate } from './coordinate.js';
import type { PreparedCoordinate } from './coordinate.js';
import { RuntimeError } from './errors.js';
import { freeze } from './types.js';

/**
 * The scope key K = (S, H, P, d, n, w) (position-and-projection §1, design item 10; decision scope-key-caps).
 *
 * A key names where a reader sits (the seat), what it intends (the shape), the phase it works in, how many rows a body
 * may hop (depth) and how many entries it may load (budget), optionally restricted to one word. This module holds the
 * caps, the defaults and K0, completes a partial key, validates a key against a scoped read, resolves its seat and
 * derives its coordinate. `positionBody` (src/position.ts, R15) assembles the body a resolved key gives, and `position`
 * (R16) adds its digest and host note, which the Door's `position` operation (MACHINE_PROTOCOL version 2) serves; no
 * version 1 Door route reads a key. Each key refusal names the one command to run as its `next` (design row 27).
 */

/** Decision scope-key-caps: depth in 0..2 hops, budget in 0..64 entries. */
export const SCOPE_KEY_CAPS = Object.freeze({ depth: 2, budget: 64 } as const);
/** Design §1 and open decision 6: the depth and budget of a key that names any part; K0 alone takes 0 and 0. */
const DEFAULTS = { depth: 1, budget: 16 } as const;

export interface ScopeKey {
  /**
   * S, the key's seat: what the caller names (R14). Absent, the repository's `@workspace` (K0's seat): the seat the
   * database resolves for the repository root `''`. A string, the identity of an admitted record in the read's scope.
   * `{path}`, a location: a workspace-relative path, or an absolute path inside the workspace root, which reads as the
   * root-relative path it names.
   */
  readonly seat?: string | { readonly path: string };
  /** H: one of the five intent shapes. */
  readonly shape: Shape;
  /** P: one of the four phases. */
  readonly phase: Phase;
  /** d: rows a body may hop along the shape's predicate focus, 0..2. */
  readonly depth: number;
  /** n: entries a body may load beyond the seat, 0..64; blockers are reserved outside it, and 0 loads none. */
  readonly budget: number;
  /** w: a word registered in the closure, restricting seeds and tallies inside the body; absent for none. */
  readonly word?: string;
}

/** K0 = (the repository's `@workspace`, context, orient, 0, 0, no word): a pointers-only first position. */
export const K0: ScopeKey = Object.freeze({ shape: 'context', phase: 'orient', depth: 0, budget: 0 });

/**
 * The resolved seat (R14): what the key's seat names once read through the scope. It is distinct from the database's
 * `SeatResolution.seat`, the record a path is declared at: a workspace seat's identity is that record for `''`, while a
 * location keeps it in `ResolvedScopeKey.resolution`, never as its own identity.
 */
export interface ResolvedSeat {
  /** `workspace` when the key names no seat, `record` when it names an identity, `location` when it names a path. */
  readonly kind: 'workspace' | 'record' | 'location';
  /** The record seated at: the repository's `@workspace`, or the named record. A location is not a record. */
  readonly identity?: string;
  /** A location's canonical workspace-relative path. */
  readonly path?: string;
  /**
   * `undeclared` exactly when no admitted record in the scope is declared at a workspace or location seat (the
   * database resolution's `unknown`); a workspace seat then has no identity.
   */
  readonly unknown?: 'undeclared';
}
export interface ResolvedScopeKey {
  /** A frozen copy of the validated key, its parts in K order and a location as its canonical path. */
  readonly key: ScopeKey;
  readonly seat: ResolvedSeat;
  /**
   * For a workspace or location seat, the database's resolution of the repository root `''` or of the path (db D02b):
   * the record declared at it (`seat`), the rule `by` that declares it and the path's claimants.
   */
  readonly resolution?: SeatResolution;
  /** The key's coordinate: shape and phase declared, category and primitive derived from SHAPE_ROWS[shape]. */
  readonly coordinate: PreparedCoordinate;
}

const PARTS = ['seat', 'shape', 'phase', 'depth', 'budget', 'word'] as const;
type Part = (typeof PARTS)[number];
/**
 * Design row 27 and §11: the one command each key refusal names, its closed set printed or its cap given. A key that is
 * no key and a seat the scope does not hold name the position without one, K0, which every scope can compute, and a
 * word the closure does not register names the vocabulary.
 */
const NEXT = {
  key: 'ia position',
  seat: 'ia position',
  shape: `ia position --shape <${SHAPES.join('|')}>`,
  phase: `ia position --phase <${PHASES.join('|')}>`,
  depth: `ia position --depth ${SCOPE_KEY_CAPS.depth}`,
  budget: `ia position --budget ${SCOPE_KEY_CAPS.budget}`,
  word: 'ia vocabulary',
} as const;
function invalid(message: string, next?: string): never {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message, next);
}
function capped(value: unknown, part: keyof typeof SCOPE_KEY_CAPS): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > SCOPE_KEY_CAPS[part])
    invalid(`Scope key ${part} must be an integer in 0..${SCOPE_KEY_CAPS[part]}`, NEXT[part]);
  return value as number;
}
function shapeOf(value: unknown): Shape {
  if (!(SHAPES as readonly unknown[]).includes(value))
    invalid(`Scope key shape must be one of ${SHAPES.join(', ')}`, NEXT.shape);
  return value as Shape;
}
/** An object whose own parts are all key parts. */
function parted(key: unknown): Readonly<Partial<Record<Part, unknown>>> {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) invalid('A scope key must be an object', NEXT.key);
  for (const part of Object.keys(key))
    if (!(PARTS as readonly string[]).includes(part))
      invalid(`Unknown scope key part '${part}'; admitted: ${PARTS.join(', ')}`, NEXT.key);
  return key as Readonly<Partial<Record<Part, unknown>>>;
}
/**
 * R14: the key's form, checked without a read: its parts, the closed shape and phase sets, both caps, the seat's form
 * and the word's type. Returns a frozen copy, its parts in K order.
 */
function formed(supplied: unknown): ScopeKey {
  const key = parted(supplied),
    { seat, phase, word } = key,
    shape = shapeOf(key.shape);
  if (typeof phase !== 'string' || !isPhase(phase))
    invalid(`Scope key phase must be one of ${PHASES.join(', ')}`, NEXT.phase);
  const depth = capped(key.depth, 'depth'),
    budget = capped(key.budget, 'budget');
  if (word !== undefined && typeof word !== 'string') invalid('Scope key word must be a string', NEXT.word);
  if (
    seat !== undefined &&
    typeof seat !== 'string' &&
    (seat === null ||
      typeof seat !== 'object' ||
      Array.isArray(seat) ||
      Object.keys(seat).join() !== 'path' ||
      typeof (seat as { path: unknown }).path !== 'string')
  )
    invalid('Scope key seat must be a record identity or {path}', NEXT.seat);
  return freeze({
    ...(seat === undefined
      ? {}
      : { seat: typeof seat === 'string' ? seat : { path: (seat as { path: string }).path } }),
    shape,
    phase,
    depth,
    budget,
    ...(word === undefined ? {} : { word: word as string }),
  });
}
/**
 * R14: complete a partial key with the defaults of design §1, so every host applies the same ones. A partial naming
 * no part is K0. Otherwise `shape` defaults to context, `phase` to the anchor phase of the shape's primitive
 * (PRIMITIVE_ANCHORS[SHAPE_ROWS[shape].primitive]), `depth` to 1 and `budget` to 16, and a seat or word stays absent
 * unless named; a part whose value is `undefined` is not named. The result is checked as resolveScopeKey checks a
 * key's form, so its refusals are the same IA-RUNTIME-REQUEST-INVALID ones; nothing is read, so the word and the seat
 * are checked only when the key is resolved.
 */
export function normalizeScopeKey(partial: Partial<ScopeKey> = {}): ScopeKey {
  const key = parted(partial),
    named = (part: Part): boolean => key[part] !== undefined;
  if (!PARTS.some(named)) return K0;
  const shape = named('shape') ? shapeOf(key.shape) : 'context';
  return formed({
    ...key,
    shape,
    phase: named('phase') ? key.phase : PRIMITIVE_ANCHORS[SHAPE_ROWS[shape].primitive],
    depth: named('depth') ? key.depth : DEFAULTS.depth,
    budget: named('budget') ? key.budget : DEFAULTS.budget,
  });
}
/**
 * A location seat's path relative to the root. An absolute path reads as the path Node's `path.relative` gives from the
 * root, as `ia read` reads the path of a `<path>:<line>` locator, and the root itself, a location though no line is in
 * it, as `''`. A relative path, or an absolute one on another drive, which has no path from the root, is left as given.
 * The database then canonicalises the path segment by segment and names one that escapes the root `outside`, so an
 * in-root name that only begins with `..`, such as `..cache`, stays inside.
 */
function rootRelative(root: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const local = relative(root, path);
  return isAbsolute(local) ? path : local.split(sep).join('/');
}
/**
 * R14: validate `key` against the read `within` names and resolve its seat. Every key-validation refusal is
 * IA-RUNTIME-REQUEST-INVALID naming the bound it breaks, and its `next` the one command to run. The parts, closed sets,
 * caps and seat form are checked before any read, so a key malformed in them is refused whatever the token; the word
 * and the seat are then read through the token, and database token failures keep their codes. A path outside the
 * workspace root or escaping it is refused, but a seat inside it that no record declares is not: the seat names the
 * unknown, so K0 stays computable in a repository whose own `@workspace` is undecided.
 */
export function resolveScopeKey(handle: ReadHandle, within: string, key: ScopeKey): ResolvedScopeKey {
  if (typeof within !== 'string' || within.length === 0) invalid('Runtime reads require an explicit scope token');
  const valid = formed(key),
    { seat, word } = valid,
    coordinate = scopeCoordinate(valid.shape, valid.phase);
  // The reads, each through the token: the word against the view's registry, then the seat.
  if (word !== undefined) {
    const words = handle.words({ within });
    if (!words.includes(word))
      invalid(`Scope key word '${word}' is not registered in this closure; registered: ${words.join(', ')}`, NEXT.word);
  }
  const unknown = (resolution: SeatResolution) =>
    resolution.unknown === undefined ? {} : { unknown: resolution.unknown as 'undeclared' };
  if (typeof seat === 'string') {
    if (!handle.resolve({ kind: 'identity', identity: seat }, { within }).ok)
      invalid(`Scope key seat '${seat}' is not an admitted record in this scope`, NEXT.seat);
    return freeze({ key: valid, seat: { kind: 'record', identity: seat }, coordinate });
  }
  if (seat === undefined) {
    const resolution = handle.resolveSeat('', { within });
    return freeze({
      key: valid,
      seat: {
        kind: 'workspace',
        ...(resolution.seat === undefined ? {} : { identity: resolution.seat }),
        ...unknown(resolution),
      },
      resolution,
      coordinate,
    });
  }
  const resolution = handle.resolveSeat(rootRelative(handle.root, seat.path), { within });
  if (resolution.unknown === 'outside')
    invalid(
      `Scope key seat path '${seat.path}' must be inside the workspace: workspace-relative, or absolute under its root`,
      NEXT.seat,
    );
  return freeze({
    key: { ...valid, seat: { path: resolution.path } },
    seat: { kind: 'location', path: resolution.path, ...unknown(resolution) },
    resolution,
    coordinate,
  });
}
