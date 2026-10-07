import { readCapturedSnapshot } from '@inventarch/db';
import type { ReadHandle, SnapshotObservation } from '@inventarch/db';
import { digest } from '@inventarch/graph';
import { positionBody } from './body.js';
import type { PositionBody } from './body.js';
import { RuntimeError } from './errors.js';
import type { NormalizedScopeKey, ScopeKeyPart, ScopeKeySource } from './scope-key.js';
import type { SeedKey } from './seed.js';
import { freeze } from './types.js';

/**
 * A position hands over two outputs, always together and never merged: body(K), a pure function of the key's value
 * and the admitted revision, and the host note, which tells this host's state beside it. Nothing of the host note,
 * the scope token, the clock, the cache, absolute paths or how each key part was supplied reaches the body, so
 * equal key values over one revision give byte-equal bodies and one digest on every host.
 */

/** The tag inside every body digest; a new definition takes a new tag, never a new meaning for this one. */
export const BODY_DIGEST_FORMAT = 'ia-body-1';
/** The format of the host note. */
export const HOST_NOTE_FORMAT = 'ia-host-note-1';

/** Facts only the host knows. A host passes what it has; every fact it leaves out is null in the host note. */
export interface HostFacts {
  /** The CLI serving the position, as `id@version`. */
  readonly cli?: string;
  /** The host adapter rendering it, as `id@version`. */
  readonly adapter?: string;
  /** A digest of the host's installed state, computed by a host that can read it. */
  readonly installedStateDigest?: string;
}
export interface PositionOptions {
  /** Asked once per position, for the host note only; never read by the body. */
  readonly hostFacts?: () => HostFacts;
}
/** Whether the capture store's current snapshot is the admitted revision now, another one, or missing. */
export type Freshness = 'current' | 'stale' | 'absent';
export interface CapturedRevisions {
  /** The revision of the captured current snapshot; null when none is readable. */
  readonly revision: string | null;
  /** The revision of the captured previous snapshot; null when none is readable. */
  readonly previousRevision: string | null;
  readonly freshness: Freshness;
}
/** The admitted records now against the captured current snapshot, by their per-record digests. */
export interface StalenessSummary {
  readonly changed: number;
  readonly new: number;
  readonly removed: number;
  readonly unchanged: number;
}
/** The key as it was asked: its value, whether that value is K0, and how each part was supplied. */
export interface KeyUsed extends SeedKey {
  readonly k0: boolean;
  readonly sources: Readonly<Record<ScopeKeyPart | 'primitive', ScopeKeySource>>;
}
export interface HostNote {
  readonly format: typeof HOST_NOTE_FORMAT;
  /** The admitted revision the body was told at. */
  readonly revision: string;
  readonly captured: CapturedRevisions;
  /** Null when there is no captured current snapshot to compare against. */
  readonly staleness: StalenessSummary | null;
  readonly installedStateDigest: string | null;
  readonly cli: string | null;
  readonly adapter: string | null;
  readonly key: KeyUsed;
  /** Capture store slots that exist but cannot be read; such a slot counts as absent. */
  readonly observations: readonly SnapshotObservation[];
}
export interface Position {
  readonly body: PositionBody;
  /** `bodyDigest(body)`. */
  readonly digest: string;
  readonly hostNote: HostNote;
}

/** SHA-256 of `{format: 'ia-body-1', body}` in the canonical codec: equal bodies, equal digests. */
export function bodyDigest(body: PositionBody): string {
  return digest({ format: BODY_DIGEST_FORMAT, body });
}

const FACTS = ['cli', 'adapter', 'installedStateDigest'] as const;
type Fact = (typeof FACTS)[number];
/** The host's facts, copied: a supplied fact must be non-empty text. */
function factsOf(options: PositionOptions): Readonly<Record<Fact, string | null>> {
  const supplied = (options.hostFacts?.() ?? {}) as Readonly<Record<string, unknown>>;
  const facts: Record<Fact, string | null> = { cli: null, adapter: null, installedStateDigest: null };
  for (const name of FACTS) {
    if (!Object.hasOwn(supplied, name)) continue;
    const value = supplied[name];
    if (typeof value !== 'string' || value === '')
      throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', `Host fact ${name} must be non-empty text`);
    facts[name] = value;
  }
  return facts;
}

/**
 * The host note: the capture store at the handle's workspace root (`readCapturedSnapshot`, which needs no cache)
 * against the admitted revision and per-record digests now, the host's facts and the key used. Captures are of the
 * whole workspace, so freshness and staleness compare the whole admitted workspace, whatever the body's scope.
 */
function noteOf(
  handle: ReadHandle,
  body: PositionBody,
  key: NormalizedScopeKey,
  options: PositionOptions = {},
): HostNote {
  const facts = factsOf(options),
    store = readCapturedSnapshot(handle.root),
    current = store.current;
  let staleness: StalenessSummary | null = null;
  if (current !== undefined) {
    const captured = new Map(current.membership.map((member) => [member.identity, member.digest])),
      now = handle.membership();
    const summary = { changed: 0, new: 0, removed: 0, unchanged: 0 };
    for (const member of now) {
      const was = captured.get(member.identity);
      if (was === undefined) summary.new++;
      else if (was === member.digest) summary.unchanged++;
      else summary.changed++;
    }
    const present = new Set(now.map((member) => member.identity));
    for (const identity of captured.keys()) if (!present.has(identity)) summary.removed++;
    staleness = summary;
  }
  return freeze({
    format: HOST_NOTE_FORMAT,
    revision: body.revision,
    captured: {
      revision: current?.revision ?? null,
      previousRevision: store.previous?.revision ?? null,
      freshness: current === undefined ? 'absent' : current.revision === handle.revision ? 'current' : 'stale',
    },
    staleness,
    installedStateDigest: facts.installedStateDigest,
    cli: facts.cli,
    adapter: facts.adapter,
    key: { ...body.key, k0: key.k0, sources: { ...key.sources } },
    observations: [...store.observations],
  });
}

/**
 * Position a scope key: its body (`positionBody`, read through the `within` scope token only), the body's digest
 * and the host note. The body never reads the host note's inputs, so it is the same whatever the host.
 */
export function position(
  handle: ReadHandle,
  within: string,
  key: NormalizedScopeKey,
  options: PositionOptions = {},
): Position {
  const body = positionBody(handle, within, key);
  return freeze({ body, digest: bodyDigest(body), hostNote: noteOf(handle, body, key, options) });
}
