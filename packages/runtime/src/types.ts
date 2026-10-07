import type { Band, EdgeReference, Kind, Span, Term } from '@inventarch/language';
import type { Edge } from '@inventarch/graph';
import type { Scope } from '@inventarch/db';
import type { CoordinateOptions, PreparedCoordinate } from './coordinate.js';

export interface ContextRequest {
  readonly within: string;
  readonly text: string;
  readonly coordinate: Readonly<Record<string, unknown>>;
  readonly subject?: string | EdgeReference;
  readonly follow?: readonly string[];
  readonly revision?: string;
}
export interface Budget {
  readonly tokens: number;
  readonly records: number;
}
export interface Tokenizer {
  readonly name: string;
  count(text: string): number;
}
export interface ContextOptions extends CoordinateOptions {
  /** Opt-in topical assembly; all blocking governance is still reserved first. Selection is unchanged. */
  readonly ranking?: 'native' | 'topical';
  readonly tokenizer?: Tokenizer;
  /**
   * Attach each cell entry's `purpose` and count it toward the text budget. Off by default, so a caller that delivers
   * only `text` is not charged for text it drops.
   */
  readonly purpose?: boolean;
}
export interface Citation extends Span {
  readonly path: string;
}
export interface Clause {
  readonly key: string;
  readonly text: string;
  readonly condition?: readonly Term[];
  readonly citation: Citation;
}
export interface Entry {
  readonly address: string;
  readonly identity: string;
  readonly kind: Kind;
  readonly band: Band;
  readonly step: 1 | 2 | 3 | 4 | 5 | 6;
  readonly score: number;
  readonly why: string;
  readonly text: string;
  readonly citations: readonly Citation[];
  readonly condition?: readonly Term[];
  readonly clauses?: readonly Clause[];
  readonly severity?: string;
  /**
   * A cell entry's record `says` and `answers`, so a delivered step names what its method is for, present when the
   * caller asks for it (`ContextOptions.purpose`). It counts toward the text budget with `text`. Other entries carry the
   * record's meaning in their `text` already.
   */
  readonly purpose?: string;
}
export interface Omission {
  readonly address: string;
  readonly reason: 'budget' | 'disqualified' | 'unresolved';
  readonly detail: string;
}
export interface Packet {
  readonly ranking?: 'topical';
  readonly revision: string;
  readonly scope: Scope;
  readonly coordinate: PreparedCoordinate;
  readonly included: readonly Entry[];
  readonly omitted: readonly Omission[];
  readonly followed: readonly Edge[];
  readonly gated: readonly Edge[];
  readonly dangling: readonly Edge[];
  readonly limits: Budget & {
    readonly tokensUsed: number;
    readonly recordsUsed: number;
    readonly estimator: string;
    readonly envelopeBytes: number;
  };
}
export interface Refusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly escalation?: 'coordinate-incomplete' | 'deny-wins-tie' | 'no-candidate';
  readonly missing?: readonly string[];
  readonly required?: Budget;
  readonly reduction?: readonly string[];
  /**
   * What to do instead: set on refusals of the operations protocol version 2 added (position, read), from their
   * protocol rows. The nine version-1 operations never set it, so their refusals stay as version 1 printed them.
   */
  readonly next?: string;
}
export type ContextResult = { readonly ok: true; readonly packet: Packet } | Refusal;

/** Result objects contain plain JSON data and already immutable graph products. */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
