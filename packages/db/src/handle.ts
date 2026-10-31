import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { EdgeReference, Phase } from '@inventarch/language';
import {
  canonicalRoot,
  directedView,
  isSelection,
  reaches,
  resolve,
  search,
  stableSerialize,
  traverse,
} from '@inventarch/graph';
import type {
  DirectedRow,
  FieldReference,
  Node,
  Resolution,
  SearchHit,
  Traversal,
  TraverseOptions,
} from '@inventarch/graph';
import type { Report } from '@inventarch/compliance';
import { publishCache } from './cache.js';
import type { CacheStatus } from './cache.js';
import { DbError } from './errors.js';
import { inputOptions, readInputs } from './inputs.js';
import type { InputOptions, InputSnapshot } from './inputs.js';
import { inertSources } from './membership.js';
import type { DeclaredRoot, InertDeclaration, MembershipRow } from './membership.js';
import { digestIn, readCapture, readinessOf, rotate, stalenessOf } from './retention.js';
import type { Readiness, RetainedSnapshot, Staleness } from './retention.js';
import { seatOf } from './seat.js';
import type { SeatResolution } from './seat.js';
import { declaredReaches, occurrenceKey, reachAt, viewBuilder } from './view.js';
import type { ViewOptions } from './view.js';
import type { RefusedRecord, UnadmittedRecord, View } from './view.js';
import { previewInputs } from './preview.js';
import type { DraftChange, DraftPreview } from './preview.js';

export interface OpenOptions extends InputOptions {
  readonly cache?: boolean;
  /**
   * D13: how `@check` records are admitted (`ViewOptions.checks`). `strict`, the default, keeps every existing reader's
   * admission; `structural` is for the validate path that binds checks, and `preview` drafts under it too. A handle
   * opened `structural` or with `evidence` never reads or writes the cache, whatever `cache` says, so
   * `.ia/.iadb/graph.json` only ever holds a strict, evidence-free graph.
   */
  readonly checks?: 'strict' | 'structural';
  /**
   * D10: `verify` binds verified COMP-KERNEL and COMP-FIXTURES evidence to every view's report, `preview` drafts and
   * refreshes included (`ViewOptions.conformance`). The graph is the same either way, so the cache is too.
   */
  readonly conformance?: 'verify';
}
export interface ReadOptions {
  readonly root?: string;
  readonly phase?: Phase | null;
  readonly revision?: string;
  readonly within?: string;
}
export interface ScopeRequest extends ReadOptions {
  readonly identities?: readonly string[];
  /**
   * D08c: held outside the bound, neither counted nor evicted, for the scope a host keeps for the life of its handle
   * whether or not a read names it. Nothing limits how many a caller pins, so only a host that holds the reader may, and
   * only what it can count; a scope a client asks for through the Door cannot be pinned.
   */
  readonly pinned?: boolean;
}
export interface Scope {
  readonly token: string;
  readonly root: string;
  readonly phase?: Phase;
  readonly revision: string;
}
export interface Snapshot {
  readonly revision: string;
  /**
   * The view's authored revision (graph `authoredRevisionOf`): `revision` without the sources at runtime placement, so
   * runtime-band evidence leaves it unchanged; it equals `revision` while no source is placed so.
   */
  readonly authoredRevision: string;
  readonly root: string;
  readonly phase?: Phase;
  readonly records: readonly Node[];
  readonly systems: readonly string[];
  /** D02a capture membership: one row per record, in `records` order. */
  readonly membership: readonly MembershipRow[];
}
export interface DatabaseTraversalOptions extends Omit<TraverseOptions, 'scope'>, ReadOptions {}
interface State {
  readonly inputs: InputSnapshot;
  readonly build: ReturnType<typeof viewBuilder>;
  readonly rootView: View;
  readonly cache: CacheStatus;
  /** D08c: the views held, by declared reach and phase, a location reading its reach's; least recently used first. */
  readonly views: Map<string, View>;
  readonly reaches: readonly string[];
  /** D08: the retained pair's previous side and the capture pair's current revision; absent in an editor reader. */
  readonly retention?: Retention;
}
/**
 * D08: each side is read on its first use, so a read that never asks (every frozen Door route) never opens the capture
 * files, and a refresh hands the previous side on unread.
 */
interface Retention {
  /** The most recent admitted root snapshot whose authored revision differs from rootView's. */
  readonly previous: () => RetainedSnapshot | undefined;
  /** D08a: the revisions of the capture at `.ia/work/snapshot/current.json`, when that file holds one. */
  readonly captured: () => Pick<RetainedSnapshot, 'revision' | 'authoredRevision'> | undefined;
}
/** D08: what a refresh rotates: the root snapshot a reader holds and its previous side, read on first use. */
interface Held {
  readonly current: RetainedSnapshot;
  readonly previous: () => RetainedSnapshot | undefined;
}
/** A thunk evaluated once, on its first call, which then releases what it computed from. */
function once<T>(compute: () => T): () => T {
  let pending: (() => T) | undefined = compute,
    value: { readonly result: T } | undefined;
  return () => {
    if (value === undefined) {
      value = { result: pending!() };
      pending = undefined;
    }
    return value.result;
  };
}
/** D07: a scope's occurrence boundary and the identities its view admits there. */
interface ScopeSets {
  readonly boundary: ReadonlySet<string>;
  readonly allowed: ReadonlySet<string>;
}
/**
 * D08c: a scope holds no view, which its binding finds again, and of a registry only the digest. It holds sets of its
 * own only when it narrows its view; one that keeps the whole of it (`own` undefined) reads the view's (`basisOf`).
 */
interface BoundScope {
  readonly binding: Scope;
  readonly own: ScopeSets | undefined;
  readonly registry: string;
  readonly complete: boolean;
}
interface Selection {
  readonly view: View;
  /** The root the read names: a view is its reach's, so it does not say. */
  readonly root: string;
  readonly allowed?: ReadonlySet<string>;
}
/** What every scope that keeps the whole of one view reads, computed once per view and released with it (D08c). */
interface ViewBasis extends ScopeSets {
  /** The digest of the view's registry, which a child's must equal (D07). */
  readonly registry: string;
}
const bases = new WeakMap<View, ViewBasis>();
const setsIn = (view: View, boundary: ReadonlySet<string>): ScopeSets => ({
  boundary,
  allowed: new Set(
    [...view.graph.nodes.values()].filter((node) => boundary.has(occurrenceKey(node))).map((node) => node.identity),
  ),
});
function basisOf(view: View): ViewBasis {
  let basis = bases.get(view);
  if (basis === undefined) {
    basis = {
      registry: createHash('sha256').update(stableSerialize(view.graph.registry)).digest('hex'),
      ...setsIn(view, new Set(view.boundary)),
    };
    bases.set(view, basis);
  }
  return basis;
}
/**
 * D08c: the ordinary scopes a reader holds. A token leaves only once this many others were issued or read since it last
 * was, about three heavy door sessions of one scope a call, and a scope that keeps its whole view holds a few hundred
 * bytes.
 */
const HELD_SCOPES = 4096;
/** D08c: the views a state holds, the root view among them: three reaches, each read whole and at all four phases. */
const HELD_VIEWS = 16;
/** Makes `key` the most recently used of `held`, then evicts the least recently used entry past `limit`, never `kept`. */
function retain<T>(held: Map<string, T>, key: string, value: T, limit: number, kept?: T): void {
  held.delete(key);
  held.set(key, value);
  if (held.size <= limit) return;
  for (const [oldest, entry] of held)
    if (entry !== kept) {
      held.delete(oldest);
      return;
    }
}
/** D08c: a token is a UUID whose last twelve digits are the keyed tag of the rest. */
const TAG_DIGITS = 12;
function scopeRoot(value: string): string {
  try {
    return canonicalRoot(value);
  } catch {
    throw new DbError('IA-DB-SCOPE-MISMATCH', 'Scope root must be a canonical workspace-relative path');
  }
}

/** Internal observation seam: production supplies readInputs, tests can prove
 * the bounded retry and no-publication invariant with real captured inputs. */
export function stableState(read: () => InputSnapshot, cache: boolean, view: ViewOptions = {}): State {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const inputs = read(),
        build = viewBuilder(inputs, view),
        rootView = build();
      if (read().fingerprint !== inputs.fingerprint) continue;
      return {
        inputs,
        build,
        rootView,
        cache: publishCache(inputs.root, rootView.graph, cache),
        views: new Map([['["",null]', rootView]]),
        reaches: declaredReaches(inputs.sources),
      };
    } catch (error) {
      if (!(error instanceof DbError) || error.code !== 'IA-DB-SOURCE-CHANGED') throw error;
    }
  }
  throw new DbError('IA-DB-SOURCE-CHANGED', 'Source inputs changed during three consecutive snapshot attempts');
}
const rootSnapshot = (state: State): RetainedSnapshot =>
  Object.freeze({
    revision: state.rootView.graph.revision,
    authoredRevision: state.rootView.authoredRevision,
    membership: state.rootView.membership,
  });
/** Shared read engine for disk handles and cache-free editor snapshots. */
export class Reader {
  readonly root: string;
  #locations: Readonly<Record<string, import('@inventarch/language').Location>>;
  /** How `preview` admits a draft: as this reader's view does (`OpenOptions.checks`). */
  #view: ViewOptions;
  #state: State;
  #closed = false;
  /** D08c: ordinary scopes, least recently used first, and only what a token can still read. */
  #scopes = new Map<string, BoundScope>();
  /** D08c: pinned scopes, outside that bound: they take no place in it, and nothing evicts them. */
  #pinned = new Map<string, BoundScope>();
  #tokenKey = randomBytes(32);
  constructor(
    state: State,
    locations: Readonly<Record<string, import('@inventarch/language').Location>> = {},
    view: ViewOptions = {},
  ) {
    this.#locations = locations;
    this.#view = view;
    this.#state = state;
    this.root = state.inputs.root;
  }
  protected get capturedInputs(): InputSnapshot {
    this.#assertOpen();
    return this.#state.inputs;
  }
  /** D08: the root snapshot this reader holds and the previous side it retains, unread, as a refresh rotates them. */
  protected get retention(): Held {
    this.#assertOpen();
    return Object.freeze({
      current: rootSnapshot(this.#state),
      previous: this.#state.retention?.previous ?? ((): RetainedSnapshot | undefined => undefined),
    });
  }
  /** D08: the previous side of the pair this handle retains. */
  #previous(): RetainedSnapshot | undefined {
    return this.#state.retention?.previous();
  }
  protected replaceState(next: State): void {
    this.#assertOpen();
    // D08: a token never revives, so a new generation releases every scope, and each token then answers as evicted.
    if (next.inputs.fingerprint !== this.#state.inputs.fingerprint) {
      this.#scopes.clear();
      this.#pinned.clear();
    }
    this.#state = next;
  }
  #assertOpen(): void {
    if (this.#closed) throw new DbError('IA-DB-CLOSED', 'This database handle is closed');
  }
  protected view(options: ReadOptions): View {
    this.#assertOpen();
    const { build, reaches: declared, rootView, views } = this.#state,
      reach = reachAt(declared, scopeRoot(options.root ?? '')),
      key = JSON.stringify([reach, options.phase ?? null]),
      view = views.get(key) ?? build(reach, options.phase ?? undefined);
    retain(views, key, view, HELD_VIEWS, rootView);
    if (options.revision !== undefined && options.revision !== view.graph.revision)
      throw new DbError('IA-DB-STALE', `Requested revision ${options.revision} differs from ${view.graph.revision}`);
    return view;
  }
  /** D08c: the keyed tag of a token's random digits. It tells an evicted token from a forged one and authorizes nothing. */
  #tokenTag(digits: string): string {
    return createHmac('sha256', this.#tokenKey).update(digits).digest('hex').slice(0, TAG_DIGITS);
  }
  #scope(token: string): BoundScope {
    this.#assertOpen();
    const pinned = this.#pinned.get(token);
    if (pinned !== undefined) return pinned;
    const scope = this.#scopes.get(token);
    if (scope === undefined) {
      if (this.isIssuedScope(token))
        throw new DbError(
          'IA-DB-STALE',
          'Scope belongs to a previous source generation or was evicted by newer scopes; issue a new scope',
        );
      throw new DbError('IA-DB-SCOPE-UNAVAILABLE', 'Unknown token for this handle');
    }
    retain(this.#scopes, token, scope, HELD_SCOPES);
    return scope;
  }
  #select(options: ReadOptions): Selection {
    if (options.within === undefined) return { view: this.view(options), root: scopeRoot(options.root ?? '') };
    const scope = this.#scope(options.within),
      binding = scope.binding;
    if (
      (options.root !== undefined && scopeRoot(options.root) !== binding.root) ||
      (options.phase !== undefined && (options.phase ?? undefined) !== binding.phase) ||
      (options.revision !== undefined && options.revision !== binding.revision)
    ) {
      throw new DbError('IA-DB-SCOPE-MISMATCH', 'Explicit read bindings differ from the supplied scope');
    }
    const view = this.view(binding);
    return { view, root: binding.root, allowed: (scope.own ?? basisOf(view)).allowed };
  }
  /** D09: the selection for a read about one identity, which must be inside the supplied scope. */
  #admit(identity: string, options: ReadOptions): Selection {
    const selection = this.#select(options);
    if (selection.allowed !== undefined && !selection.allowed.has(identity))
      throw new DbError('IA-DB-OUT-OF-SCOPE', 'Identity is outside the supplied scope');
    return selection;
  }
  resolveScope(options: ScopeRequest = {}): Scope {
    this.#assertOpen();
    const parent = options.within === undefined ? undefined : this.#scope(options.within);
    const root = scopeRoot(options.root ?? parent?.binding.root ?? '');
    const phase = options.phase === undefined ? parent?.binding.phase : (options.phase ?? undefined);
    if (
      parent !== undefined &&
      (!reaches(parent.binding.root, root) ||
        (options.revision !== undefined && options.revision !== parent.binding.revision))
    ) {
      throw new DbError('IA-DB-SCOPE-MISMATCH', 'Child bindings widen or contradict the parent scope');
    }
    const view = this.view({
      root,
      ...(phase === undefined ? {} : { phase }),
      ...(options.revision === undefined || parent !== undefined ? {} : { revision: options.revision }),
    });
    const basis = basisOf(view);
    if (parent !== undefined && basis.registry !== parent.registry)
      throw new DbError(
        'IA-DB-SCOPE-MISMATCH',
        'Child view changes the effective registry; an independent scope is required',
      );
    const identities = options.identities === undefined ? undefined : new Set(options.identities);
    const bound = parent === undefined ? undefined : (parent.own ?? basisOf(this.view(parent.binding))).boundary;
    const kept = view.boundary.filter(
      (key) =>
        (bound === undefined || bound.has(key)) &&
        (identities === undefined || identities.has((JSON.parse(key) as [string])[0])),
    );
    const digits = randomUUID().slice(0, -TAG_DIGITS),
      token = digits + this.#tokenTag(digits),
      binding = Object.freeze({
        token,
        root,
        ...(phase === undefined ? {} : { phase }),
        revision: view.graph.revision,
      });
    const scope = {
      binding,
      own: kept.length === view.boundary.length ? undefined : setsIn(view, new Set(kept)),
      registry: basis.registry,
      complete:
        root === '' && phase === undefined && identities === undefined && (parent === undefined || parent.complete),
    };
    if (options.pinned === true) this.#pinned.set(token, scope);
    else retain(this.#scopes, token, scope, HELD_SCOPES);
    return binding;
  }
  /** Whole-workspace preview can expose refused sources as diagnostics. Admitted-record counts cannot prove disclosure. */
  isCompleteScope(token: string): boolean {
    return this.#scope(token).complete;
  }
  /**
   * D08c: whether this reader issued `token`, whatever has become of its scope: true of a token it evicted or a refresh
   * retired, which reads refuse as IA-DB-STALE, false of a forged token or another reader's, which they refuse as
   * IA-DB-SCOPE-UNAVAILABLE. It costs no memory per token, and grants nothing: a read needs a scope still held.
   */
  isIssuedScope(token: string): boolean {
    this.#assertOpen();
    return typeof token === 'string' && token.slice(-TAG_DIGITS) === this.#tokenTag(token.slice(0, -TAG_DIGITS));
  }
  get revision(): string {
    this.#assertOpen();
    return this.#state.rootView.graph.revision;
  }
  /**
   * The root view's authored revision (graph `authoredRevisionOf`): `revision` without the sources at runtime
   * placement, the derived revision-only input (D03) kept, so a runtime-band source moves `revision` and leaves this
   * unchanged, while an authored edit moves both. It equals `revision` while no source is placed so. `revision` stays
   * what read bindings assert (IA-DB-STALE) and scopes bind; retention and the capture pair key on this one (D08, D08a).
   */
  get authoredRevision(): string {
    this.#assertOpen();
    return this.#state.rootView.authoredRevision;
  }
  get report(): Report {
    this.#assertOpen();
    return this.#state.rootView.report;
  }
  get refused(): readonly RefusedRecord[] {
    this.#assertOpen();
    return this.#state.rootView.refused;
  }
  /**
   * D15: every record occurrence of the root view's sources that it does not admit, at the band of its source's
   * placement (`UnadmittedRecord`): those `refused` names, those an identity tie drops, and those of a file refused whole
   * by a language error or a duplicate requirement id, which `refused` cannot name because no graph ever held them. Like
   * `refused` and `report` it reads the root view, whatever scope a read binds: an occurrence that is not admitted is in
   * no scope. Nothing is read from disk for it: the view's own parse, compile and captured text decide it.
   */
  get unadmitted(): readonly UnadmittedRecord[] {
    this.#assertOpen();
    return this.#state.rootView.unadmitted;
  }
  get cache(): CacheStatus {
    this.#assertOpen();
    return this.#state.cache;
  }
  snapshot(options: ReadOptions = {}): Snapshot {
    const { view, root, allowed } = this.#select(options);
    return Object.freeze({
      revision: view.graph.revision,
      authoredRevision: view.authoredRevision,
      root,
      ...(view.graph.phase === undefined ? {} : { phase: view.graph.phase }),
      records: Object.freeze(
        [...view.graph.nodes.values()].filter((node) => allowed === undefined || allowed.has(node.identity)),
      ),
      systems: view.admittedSystems,
      // A row depends only on its occurrence and the capture's declared roots, so a narrowed scope prunes rows and
      // never re-roots one.
      membership:
        allowed === undefined
          ? view.membership
          : Object.freeze(view.membership.filter((row) => allowed.has(row.identity))),
    });
  }
  records(options: ReadOptions = {}): readonly Node[] {
    return this.snapshot(options).records;
  }
  preview(changes: readonly DraftChange[]): DraftPreview {
    this.#assertOpen();
    return previewInputs(this.#state.inputs, this.revision, changes, this.#locations, this.#view);
  }
  get(identity: string, options: ReadOptions = {}): Node | undefined {
    return this.#admit(identity, options).view.graph.nodes.get(identity);
  }
  /** D08: the revision of the retained previous root snapshot, when one is retained. */
  get previousRevision(): string | undefined {
    this.#assertOpen();
    return this.#previous()?.revision;
  }
  /** D08: the authored revision of the retained previous root snapshot, when one is retained. */
  get previousAuthoredRevision(): string | undefined {
    this.#assertOpen();
    return this.#previous()?.authoredRevision;
  }
  /**
   * D08a: the revision of the capture `ia capture` last wrote, at `.ia/work/snapshot/current.json`; undefined when there
   * is none or the file holds no capture this handle trusts.
   */
  get capturedRevision(): string | undefined {
    this.#assertOpen();
    return this.#state.retention?.captured()?.revision;
  }
  /**
   * D08a: the authored revision of that capture, under the same conditions. A capture at another authored revision than
   * `authoredRevision` is stale; one that differs only in runtime-band sources is not.
   */
  get capturedAuthoredRevision(): string | undefined {
    this.#assertOpen();
    return this.#state.retention?.captured()?.authoredRevision;
  }
  /**
   * D08: the identity's digest in the view `get` reads under `options` and, when that is also its current root digest
   * (always for a root read), its digest in the previous root snapshot. Only root snapshots are retained, so a narrower
   * root or phase that reads another digest, or a record only one of the two views holds, is not `rooted`.
   */
  #compared(
    identity: string,
    options: ReadOptions,
  ): { readonly now: string | undefined; readonly before: string | undefined; readonly rooted: boolean } {
    const now = this.#admit(identity, options).view.graph.nodes.get(identity)?.digest,
      rooted = now === this.#state.rootView.graph.nodes.get(identity)?.digest;
    return { now, before: rooted ? digestIn(this.#previous(), identity) : undefined, rooted };
  }
  /**
   * D08: the digest of the record `get` returns against the previous root snapshot's. Undefined when neither side has
   * one, or when the selected view reads an occurrence the root snapshots do not describe; every current identity is
   * `new` while no previous snapshot is retained.
   */
  staleness(identity: string, options: ReadOptions = {}): Staleness | undefined {
    const { now, before, rooted } = this.#compared(identity, options);
    return rooted ? stalenessOf(now, before) : undefined;
  }
  /** D08: which retained snapshot gives the record `get` returns an observed `digest`. */
  readiness(identity: string, digest: string, options: ReadOptions = {}): Readiness {
    const { now, before } = this.#compared(identity, options);
    return readinessOf(now, before, digest);
  }
  resolve(reference: EdgeReference, options: ReadOptions = {}): Resolution {
    const { view, allowed } = this.#select(options);
    const identities =
      reference.kind === 'identity'
        ? [reference.identity]
        : (view.graph.byName.get(reference.name.toLowerCase()) ?? []);
    const candidates = identities.flatMap((id) => {
      const node = view.graph.nodes.get(id);
      return node === undefined || (allowed !== undefined && !allowed.has(id)) ? [] : [node];
    });
    return Object.freeze(resolve(reference, candidates, view.graph.registry));
  }
  /** Graph G06a typed field references naming `identity`, holders pruned to the scope. Derived, not edges: traverse never walks them. */
  referencedBy(identity: string, options: ReadOptions = {}): readonly FieldReference[] {
    const { view, allowed } = this.#admit(identity, options);
    return Object.freeze(
      (view.graph.referencedBy.get(identity) ?? []).filter(
        (reference) => allowed === undefined || allowed.has(reference.from),
      ),
    );
  }
  /**
   * Graph G06b directed view of `identity`: its declared edge rows, the derived inverses of its counterparts' declarations
   * and its typed field references both ways, rows whose counterpart is outside the scope pruned (D09).
   */
  directedView(identity: string, options: ReadOptions = {}): readonly DirectedRow[] {
    const { view, allowed } = this.#admit(identity, options);
    const rows = directedView(view.graph, identity);
    return allowed === undefined ? rows : Object.freeze(rows.filter((row) => allowed.has(row.counterpart)));
  }
  /**
   * D02b: the seat `path` is declared at, a @system or @workspace identity, and the
   * graph G06c claimants whose path selections select it, records outside the scope treated as absent (D09).
   */
  resolveSeat(path: string, options: ReadOptions = {}): SeatResolution {
    const { view, allowed } = this.#select(options);
    return seatOf(view, path, allowed);
  }
  /**
   * D02a and D02b: the declarations the capture reads that declare nothing, so a host can say so where they are
   * authored: each `composition.sources` entry of an admitted @workspace that names no root, and each claimant
   * selection (graph G06c) the dialect reads as none, ordered by path, line and identity, records outside the scope
   * pruned. They are not report findings, so admission, the snapshot and the frozen Door routes are unchanged.
   */
  inertDeclarations(options: ReadOptions = {}): readonly InertDeclaration[] {
    const { view, allowed } = this.#select(options);
    const selections = view.graph.claims
      .filter((claim) => !isSelection(claim.selection))
      .map((claim) => ({
        identity: claim.from,
        field: claim.field,
        value: claim.selection,
        path: claim.source.path,
        line: claim.source.line,
        reason: 'selects nothing: a selection is a workspace-relative path with no empty, . or .. segment',
      }));
    const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return Object.freeze(
      [...inertSources(view.graph), ...selections]
        .filter((declaration) => allowed === undefined || allowed.has(declaration.identity))
        .sort((a, b) => order(a.path, b.path) || a.line - b.line || order(a.identity, b.identity))
        .map((declaration) => Object.freeze(declaration)),
    );
  }
  /**
   * D09a: the words the read's registry registers for its admitted systems, the
   * floor's two included, sorted. A scope narrows records, never the registry, so every scope of a view reads the same
   * words; the registry itself stays private.
   */
  words(options: ReadOptions = {}): readonly string[] {
    const { view } = this.#select(options),
      admitted = new Set(view.admittedSystems);
    return Object.freeze(
      [...view.graph.registry.registrations.values()]
        .filter((registration) => admitted.has(registration.system))
        .map((registration) => registration.keyword)
        .sort(),
    );
  }
  /**
   * D02c: the roots the capture declares (D02a), longest first, then by declaring
   * workspace, as frozen copies; a root whose declaring @workspace the read does not admit is pruned, as the seat rule
   * prunes it (D02b, D09). Membership rows keep their roots whatever the scope, so a pruned root is never re-rooted.
   */
  roots(options: ReadOptions = {}): readonly DeclaredRoot[] {
    const { view, allowed } = this.#select(options);
    return Object.freeze(
      view.declared
        .filter(
          (root) => view.graph.nodes.has(root.workspace) && (allowed === undefined || allowed.has(root.workspace)),
        )
        .map((root) => Object.freeze({ ...root })),
    );
  }
  search(text: string, options: ReadOptions = {}): readonly SearchHit[] {
    const { view, allowed } = this.#select(options);
    return search(view.graph, text, allowed);
  }
  traverse(options: DatabaseTraversalOptions): Traversal {
    const { view, allowed } = this.#select(options);
    return traverse(view.graph, { ...options, ...(allowed === undefined ? {} : { scope: allowed }) });
  }
  close(): void {
    this.#closed = true;
    this.#scopes.clear();
    this.#pinned.clear();
  }
}
export class Handle extends Reader {
  #options: OpenOptions;
  constructor(root: string, options: OpenOptions = {}) {
    const selected = Object.freeze({
      ...inputOptions(options),
      cache: options.checks === 'structural' || options.evidence === true ? false : (options.cache ?? true),
      ...(options.checks === 'structural' ? { checks: 'structural' as const } : {}),
      ...(options.conformance === 'verify' ? { conformance: 'verify' as const } : {}),
    });
    const state = stableState(() => readInputs(root, selected), selected.cache, selected),
      canonical = state.inputs.root,
      current = rootSnapshot(state),
      seed = once(() => readCapture(canonical, current));
    // D08a: whatever the cache setting, the capture pair seeds the previous snapshot, the first time it is asked; the
    // handle never writes it.
    super(
      {
        ...state,
        retention: {
          previous: once(() => rotate(seed().prior, current).previous),
          captured: () => seed().captured,
        },
      },
      selected.locations,
      {
        ...(selected.checks === 'structural' ? { checks: 'structural' as const } : {}),
        ...(selected.conformance === 'verify' ? { conformance: 'verify' as const } : {}),
      },
    );
    this.#options = selected;
    Object.freeze(this);
  }
  refresh(): Snapshot {
    const held = this.retention,
      next = stableState(() => readInputs(this.root, this.#options), this.#options.cache!, this.#options),
      root = next.inputs.root,
      current = rootSnapshot(next);
    // D08 rotation (`rotate`) without reading the pair: a changed authored revision makes the held root snapshot
    // previous, an unchanged one (a runtime-band change alone among them) keeps the held previous side, still unread
    // until asked, so no refresh lengthens what a handle holds. The capture pair's current revisions are read again
    // when asked, as `ia capture` may have run.
    const before = held.current,
      previous = before.authoredRevision === current.authoredRevision ? held.previous : (): RetainedSnapshot => before;
    this.replaceState({
      ...next,
      retention: { previous, captured: once(() => readCapture(root, current).captured) },
    });
    return this.snapshot();
  }
}
export type ReadHandle = Omit<Handle, 'refresh'>;
export function open(root: string, options: OpenOptions = {}): Handle {
  return new Handle(root, options);
}
