import { randomUUID } from 'node:crypto';
import type { EdgeReference, Phase } from '@inventarch/language';
import { canonicalRoot, reaches, resolve, search, stableSerialize, traverse } from '@inventarch/graph';
import type { FieldReference, Node, Resolution, SearchHit, Traversal, TraverseOptions } from '@inventarch/graph';
import type { Report } from '@inventarch/compliance';
import { publishCache } from './cache.js';
import type { CacheStatus } from './cache.js';
import { DbError } from './errors.js';
import { inputOptions, readInputs } from './inputs.js';
import type { InputOptions, InputSnapshot } from './inputs.js';
import { occurrenceKey, viewBuilder } from './view.js';
import type { RefusedRecord, View } from './view.js';
import { membershipOf } from './membership.js';
import type { MembershipRow } from './membership.js';
import { previewInputs } from './preview.js';
import type { DigestIndex } from './snapshot-store.js';
import type { DraftChange, DraftPreview } from './preview.js';

export interface OpenOptions extends InputOptions {
  readonly cache?: boolean;
  /** Seeds `staleness`/`readiness` before the first refresh, e.g. from the capture store (D14). Copied. */
  readonly previous?: DigestIndex;
}
/**
 * A record's digest against the retained previous one (D08): absent there is `new`, absent now is `removed`, absent
 * from both is `unknown`.
 */
export type Staleness = 'unchanged' | 'changed' | 'new' | 'removed' | 'unknown';
/** Which retained digest an observed subject revision matches: the current one, the previous one, or neither. */
export type Readiness = 'current' | 'previous' | 'unknown';
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
}
export interface DatabaseTraversalOptions extends Omit<TraverseOptions, 'scope'>, ReadOptions {}
interface State {
  readonly inputs: InputSnapshot;
  readonly build: ReturnType<typeof viewBuilder>;
  readonly rootView: View;
  readonly cache: CacheStatus;
  readonly views: Map<string, View>;
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
function indexOf(view: View): DigestIndex {
  return Object.freeze({
    revision: view.graph.revision,
    digests: new Map([...view.graph.nodes.values()].map((node) => [node.identity, node.digest])),
  });
}
function copyIndex(index: DigestIndex): DigestIndex {
  const refused = () =>
    new DbError('IA-DB-SNAPSHOT-UNAVAILABLE', 'A previous digest index needs a revision and a map of digests');
  if (typeof index !== 'object' || index === null || typeof index.revision !== 'string') throw refused();
  const source: unknown = index.digests;
  let entries: unknown[];
  try {
    // Any ReadonlyMap: read through its entries(), never trusting its class.
    entries = [...(source as ReadonlyMap<unknown, unknown>).entries()];
  } catch {
    throw refused();
  }
  const digests = new Map<string, string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw refused();
    digests.set(entry[0], entry[1]);
  }
  return Object.freeze({ revision: index.revision, digests });
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
/** Shared read engine for disk handles and cache-free editor snapshots. */
export class Reader {
  readonly root: string;
  #locations: Readonly<Record<string, import('@inventarch/language').Location>>;
  #state: State;
  #closed = false;
  #generation = 0;
  #scopes = new Map<string, BoundScope>();
  #previous: DigestIndex | undefined;
  constructor(
    state: State,
    locations: Readonly<Record<string, import('@inventarch/language').Location>> = {},
    previous?: DigestIndex,
  ) {
    this.#locations = locations;
    this.#state = state;
    this.#previous = previous;
    this.root = state.inputs.root;
  }
  protected get capturedInputs(): InputSnapshot {
    this.#assertOpen();
    return this.#state.inputs;
  }
  protected replaceState(next: State): void {
    this.#assertOpen();
    // Rotate with the generation: a refresh that changed nothing keeps the retained previous digests.
    if (next.inputs.fingerprint !== this.#state.inputs.fingerprint) {
      this.#generation++;
      this.#previous = indexOf(this.#state.rootView);
    }
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
    const { view, allowed } = this.#select(options);
    if (allowed !== undefined && !allowed.has(identity))
      throw new DbError('IA-DB-OUT-OF-SCOPE', 'Identity is outside the supplied scope');
    return view.graph.nodes.get(identity);
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
    const { view, allowed } = this.#select(options);
    if (allowed !== undefined && !allowed.has(identity))
      throw new DbError('IA-DB-OUT-OF-SCOPE', 'Identity is outside the supplied scope');
    return Object.freeze(
      (view.graph.referencedBy.get(identity) ?? []).filter(
        (reference) => allowed === undefined || allowed.has(reference.from),
      ),
    );
  }
  /** D13: one capture-membership row per admitted record in the scope, ordered by identity; seats are view-wide. */
  membership(options: ReadOptions = {}): readonly MembershipRow[] {
    const { view, allowed } = this.#select(options);
    const nodes = [...view.graph.nodes.values()];
    return membershipOf(
      nodes,
      nodes.filter((node) => allowed === undefined || allowed.has(node.identity)),
    );
  }
  /** D08: a copy of the retained previous root-view digest index, pruned to a supplied scope; undefined before any. */
  previous(options: ReadOptions = {}): DigestIndex | undefined {
    const { allowed } = this.#select(options),
      retained = this.#previous;
    if (retained === undefined) return undefined;
    return Object.freeze({
      revision: retained.revision,
      digests: new Map([...retained.digests].filter(([identity]) => allowed === undefined || allowed.has(identity))),
    });
  }
  /** D08: the record's digest against the retained previous root-view digest; `unknown` when neither holds it. */
  staleness(identity: string, options: ReadOptions = {}): Staleness {
    const { view, allowed } = this.#select(options);
    if (allowed !== undefined && !allowed.has(identity))
      throw new DbError('IA-DB-OUT-OF-SCOPE', 'Identity is outside the supplied scope');
    const current = view.graph.nodes.get(identity)?.digest,
      previous = this.#previous?.digests.get(identity);
    if (current === undefined) return previous === undefined ? 'unknown' : 'removed';
    return previous === undefined ? 'new' : previous === current ? 'unchanged' : 'changed';
  }
  /** D08: whether an observed subject revision (a per-record digest) is the current or the previous one. */
  readiness(identity: string, subjectRevision: string, options: ReadOptions = {}): Readiness {
    const { view, allowed } = this.#select(options);
    if (allowed !== undefined && !allowed.has(identity))
      throw new DbError('IA-DB-OUT-OF-SCOPE', 'Identity is outside the supplied scope');
    if (view.graph.nodes.get(identity)?.digest === subjectRevision) return 'current';
    return this.#previous?.digests.get(identity) === subjectRevision ? 'previous' : 'unknown';
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
    const { previous, ...rest } = options,
      seed = previous === undefined ? undefined : copyIndex(previous),
      selected = Object.freeze({ ...inputOptions(rest), cache: options.cache ?? true });
    super(
      stableState(() => readInputs(root, selected), selected.cache),
      selected.locations,
      seed,
    );
    this.#options = selected;
    Object.freeze(this);
  }
  refresh(): Snapshot {
    this.replaceState(stableState(() => readInputs(this.root, this.#options), this.#options.cache!));
    return this.snapshot();
  }
}
export type ReadHandle = Omit<Handle, 'refresh'>;
export function open(root: string, options: OpenOptions = {}): Handle {
  return new Handle(root, options);
}
