import { randomUUID } from 'node:crypto';
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
import type { InertDeclaration, MembershipRow } from './membership.js';
import { digestIn, readCapture, readinessOf, rotate, stalenessOf } from './retention.js';
import type { Readiness, RetainedSnapshot, Staleness } from './retention.js';
import { seatOf } from './seat.js';
import type { SeatResolution } from './seat.js';
import { occurrenceKey, viewBuilder } from './view.js';
import type { RefusedRecord, View } from './view.js';
import { previewInputs } from './preview.js';
import type { DraftChange, DraftPreview } from './preview.js';

export interface OpenOptions extends InputOptions {
  readonly cache?: boolean;
}
export interface ReadOptions {
  readonly root?: string;
  readonly phase?: Phase | null;
  readonly revision?: string;
  readonly within?: string;
}
export interface ScopeRequest extends ReadOptions {
  readonly identities?: readonly string[];
}
export interface Scope {
  readonly token: string;
  readonly root: string;
  readonly phase?: Phase;
  readonly revision: string;
}
export interface Snapshot {
  readonly revision: string;
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
  readonly views: Map<string, View>;
  /** D08: the retained pair's previous side and the capture pair's current revision; absent in an editor reader. */
  readonly retention?: Retention;
}
/**
 * D08: each side is read on its first use, so a read that never asks (every frozen Door route) never opens the capture
 * files, and a refresh hands the previous side on unread.
 */
interface Retention {
  /** The most recent admitted root snapshot whose revision differs from rootView's. */
  readonly previous: () => RetainedSnapshot | undefined;
  /** D08a: the revision of the capture at `.ia/work/snapshot/current.json`, when that file holds one. */
  readonly captured: () => string | undefined;
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
interface BoundScope {
  readonly binding: Scope;
  readonly generation: number;
  readonly boundary: ReadonlySet<string>;
  readonly allowed: ReadonlySet<string>;
  readonly view: View;
  readonly registry: string;
  readonly complete: boolean;
}
interface Selection {
  readonly view: View;
  readonly allowed?: ReadonlySet<string>;
}
function scopeRoot(value: string): string {
  try {
    return canonicalRoot(value);
  } catch {
    throw new DbError('IA-DB-SCOPE-MISMATCH', 'Scope root must be a canonical workspace-relative path');
  }
}

/** Internal observation seam: production supplies readInputs, tests can prove
 * the bounded retry and no-publication invariant with real captured inputs. */
export function stableState(read: () => InputSnapshot, cache: boolean): State {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const inputs = read(),
        build = viewBuilder(inputs),
        rootView = build();
      if (read().fingerprint !== inputs.fingerprint) continue;
      return {
        inputs,
        build,
        rootView,
        cache: publishCache(inputs.root, rootView.graph, cache),
        views: new Map([['["",null]', rootView]]),
      };
    } catch (error) {
      if (!(error instanceof DbError) || error.code !== 'IA-DB-SOURCE-CHANGED') throw error;
    }
  }
  throw new DbError('IA-DB-SOURCE-CHANGED', 'Source inputs changed during three consecutive snapshot attempts');
}
const rootSnapshot = (state: State): RetainedSnapshot =>
  Object.freeze({ revision: state.rootView.graph.revision, membership: state.rootView.membership });
/** Shared read engine for disk handles and cache-free editor snapshots. */
export class Reader {
  readonly root: string;
  #locations: Readonly<Record<string, import('@inventarch/language').Location>>;
  #state: State;
  #closed = false;
  #generation = 0;
  #scopes = new Map<string, BoundScope>();
  constructor(state: State, locations: Readonly<Record<string, import('@inventarch/language').Location>> = {}) {
    this.#locations = locations;
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
    if (next.inputs.fingerprint !== this.#state.inputs.fingerprint) this.#generation++;
    this.#state = next;
  }
  #assertOpen(): void {
    if (this.#closed) throw new DbError('IA-DB-CLOSED', 'This database handle is closed');
  }
  protected view(options: ReadOptions): View {
    this.#assertOpen();
    const root = scopeRoot(options.root ?? ''),
      key = JSON.stringify([root, options.phase ?? null]);
    let view = this.#state.views.get(key);
    if (view === undefined) {
      view = this.#state.build(root, options.phase ?? undefined);
      this.#state.views.set(key, view);
    }
    if (options.revision !== undefined && options.revision !== view.graph.revision)
      throw new DbError('IA-DB-STALE', `Requested revision ${options.revision} differs from ${view.graph.revision}`);
    return view;
  }
  #scope(token: string): BoundScope {
    this.#assertOpen();
    const scope = this.#scopes.get(token);
    if (scope === undefined) throw new DbError('IA-DB-SCOPE-UNAVAILABLE', 'Unknown token for this handle');
    if (scope.generation !== this.#generation)
      throw new DbError('IA-DB-STALE', 'Scope belongs to a previous source generation');
    return scope;
  }
  #select(options: ReadOptions): Selection {
    if (options.within === undefined) return { view: this.view(options) };
    const scope = this.#scope(options.within),
      binding = scope.binding;
    if (
      (options.root !== undefined && scopeRoot(options.root) !== binding.root) ||
      (options.phase !== undefined && (options.phase ?? undefined) !== binding.phase) ||
      (options.revision !== undefined && options.revision !== binding.revision)
    ) {
      throw new DbError('IA-DB-SCOPE-MISMATCH', 'Explicit read bindings differ from the supplied scope');
    }
    return { view: scope.view, allowed: scope.allowed };
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
    const registry = stableSerialize(view.graph.registry);
    if (parent !== undefined && registry !== parent.registry)
      throw new DbError(
        'IA-DB-SCOPE-MISMATCH',
        'Child view changes the effective registry; an independent scope is required',
      );
    const identities = options.identities === undefined ? undefined : new Set(options.identities);
    const boundary = new Set(
      view.boundary.filter(
        (key) =>
          (parent === undefined || parent.boundary.has(key)) &&
          (identities === undefined || identities.has((JSON.parse(key) as [string])[0])),
      ),
    );
    const allowed = new Set(
      [...view.graph.nodes.values()].filter((node) => boundary.has(occurrenceKey(node))).map((node) => node.identity),
    );
    const token = randomUUID(),
      binding = Object.freeze({
        token,
        root,
        ...(phase === undefined ? {} : { phase }),
        revision: view.graph.revision,
      });
    this.#scopes.set(token, {
      binding,
      generation: this.#generation,
      boundary,
      allowed,
      view,
      registry,
      complete:
        root === '' && phase === undefined && identities === undefined && (parent === undefined || parent.complete),
    });
    return binding;
  }
  /** Whole-workspace preview can expose refused sources as diagnostics. Admitted-record counts cannot prove disclosure. */
  isCompleteScope(token: string): boolean {
    return this.#scope(token).complete;
  }
  get revision(): string {
    this.#assertOpen();
    return this.#state.rootView.graph.revision;
  }
  get report(): Report {
    this.#assertOpen();
    return this.#state.rootView.report;
  }
  get refused(): readonly RefusedRecord[] {
    this.#assertOpen();
    return this.#state.rootView.refused;
  }
  get cache(): CacheStatus {
    this.#assertOpen();
    return this.#state.cache;
  }
  snapshot(options: ReadOptions = {}): Snapshot {
    const { view, allowed } = this.#select(options);
    return Object.freeze({
      revision: view.graph.revision,
      root: view.graph.location,
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
    return previewInputs(this.#state.inputs, this.revision, changes, this.#locations);
  }
  get(identity: string, options: ReadOptions = {}): Node | undefined {
    return this.#admit(identity, options).view.graph.nodes.get(identity);
  }
  /** D08: the revision of the retained previous root snapshot, when one is retained. */
  get previousRevision(): string | undefined {
    this.#assertOpen();
    return this.#previous()?.revision;
  }
  /**
   * D08a: the revision of the capture `ia capture` last wrote, at `.ia/work/snapshot/current.json`; undefined when there
   * is none or the file holds no capture this handle trusts. A capture at another revision than `revision` is stale.
   */
  get capturedRevision(): string | undefined {
    this.#assertOpen();
    return this.#state.retention?.captured();
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
  /** D08 (position-and-projection row 20): which retained snapshot gives the record `get` returns an observed `digest`. */
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
   * D02b (position-and-projection row 17): the seat `path` is declared at, a @system or @workspace identity, and the
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
   * D09a (position-and-projection row 10): the words the read's registry registers for its admitted systems, the
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
  }
}
export class Handle extends Reader {
  #options: OpenOptions;
  constructor(root: string, options: OpenOptions = {}) {
    const selected = Object.freeze({ ...inputOptions(options), cache: options.cache ?? true });
    const state = stableState(() => readInputs(root, selected), selected.cache),
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
    );
    this.#options = selected;
    Object.freeze(this);
  }
  refresh(): Snapshot {
    const held = this.retention,
      next = stableState(() => readInputs(this.root, this.#options), this.#options.cache!),
      root = next.inputs.root,
      current = rootSnapshot(next);
    // D08 rotation (`rotate`) without reading the pair: a changed revision makes the held root snapshot previous, an
    // unchanged one keeps the held previous side, still unread until asked, so no refresh lengthens what a handle holds.
    // The capture pair's current revision is read again when asked, as `ia capture` may have run.
    const before = held.current,
      previous = before.revision === current.revision ? held.previous : (): RetainedSnapshot => before;
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
