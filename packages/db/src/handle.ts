import { randomUUID } from 'node:crypto';
import type { EdgeReference, Phase } from '@inventarch/language';
import { canonicalRoot, directedView, reaches, resolve, search, stableSerialize, traverse } from '@inventarch/graph';
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
import type { CacheObservation, CacheStatus } from './cache.js';
import { DbError } from './errors.js';
import { inputOptions, readInputs } from './inputs.js';
import type { InputOptions, InputSnapshot } from './inputs.js';
import type { MembershipRow } from './membership.js';
import { digestIn, publishRetained, readRetained, readinessOf, rotate, stalenessOf } from './retention.js';
import type { Readiness, Retained, RetainedSnapshot, Staleness } from './retention.js';
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
  /** D08: the most recent admitted root snapshot whose revision differs from rootView's; none in an editor reader. */
  readonly previous?: RetainedSnapshot;
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
/** D08: rotate `prior` against the published state's root snapshot and publish the pair beside the graph cache. */
function retain(
  state: State,
  prior: Retained | undefined,
  observations: readonly CacheObservation[],
  enabled: boolean,
): State {
  const retained = rotate(prior, rootSnapshot(state)),
    published = publishRetained(state.inputs.root, retained, enabled);
  return {
    ...state,
    ...(retained.previous === undefined ? {} : { previous: retained.previous }),
    cache: Object.freeze({
      state: state.cache.state,
      observations: Object.freeze([...state.cache.observations, ...observations, ...published.observations]),
    }),
  };
}
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
  /** D08: the retained root snapshot pair that a refresh rotates. */
  protected get retention(): Retained {
    this.#assertOpen();
    const previous = this.#state.previous;
    return Object.freeze({ current: rootSnapshot(this.#state), ...(previous === undefined ? {} : { previous }) });
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
    return this.#state.previous?.revision;
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
    return { now, before: rooted ? digestIn(this.#state.previous, identity) : undefined, rooted };
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
      read: ReturnType<typeof readRetained> = selected.cache
        ? readRetained(state.inputs.root, rootSnapshot(state))
        : { observations: [] };
    super(retain(state, read.prior, read.observations, selected.cache), selected.locations);
    this.#options = selected;
    Object.freeze(this);
  }
  refresh(): Snapshot {
    const next = stableState(() => readInputs(this.root, this.#options), this.#options.cache!);
    this.replaceState(retain(next, this.retention, [], this.#options.cache!));
    return this.snapshot();
  }
}
export type ReadHandle = Omit<Handle, 'refresh'>;
export function open(root: string, options: OpenOptions = {}): Handle {
  return new Handle(root, options);
}
