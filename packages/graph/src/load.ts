import { canonicalPath, consentFor, isPhase, listed, validatePool } from '@inventarch/language';
import type {
  CompiledChild,
  CompiledEdge,
  CompiledRecord,
  CompiledValue,
  EdgeReference,
  FrozenRegistry,
  Predicate,
  Span,
  SystemDeclaration,
} from '@inventarch/language';
import { claimsOf } from './claims.js';
import { dimensionsOf } from './coordinate.js';
import { GraphUsageError, graphDiagnostic } from './diagnostics.js';
import type { GraphDiagnostic } from './diagnostics.js';
import { hold, isFrozen, snapshot } from './immutable.js';
import { assertLocation, canonicalRoot, reaches } from './paths.js';
import { laneOf } from './queries.js';
import { referenceKey, resolve } from './resolve.js';
import { compare, recordDigest, revisionOf, stableSerialize } from './revision.js';
import { buildTextIndex } from './text.js';
import type {
  CellRef,
  Edge,
  EdgeAssertion,
  FieldReference,
  Graph,
  LoadOptions,
  Node,
  Occurrence,
  Shadow,
  Tie,
} from './types.js';

export const edgeOrder = (a: Edge, b: Edge): number =>
  compare(a.from ?? '', b.from ?? '') ||
  compare(a.predicate, b.predicate) ||
  compare(a.to ?? '', b.to ?? '') ||
  compare(a.fragment ?? '', b.fragment ?? '') ||
  compare(a.fragmentEndpoint ?? '', b.fragmentEndpoint ?? '') ||
  (a.condition === b.condition ? 0 : compare(stableSerialize(a.condition ?? []), stableSerialize(b.condition ?? []))) ||
  compare(a.author, b.author) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line;
/**
 * What every graph of one compiled record shares: its node, frozen, with its digest and dimensions, and its occurrence
 * key. All of it follows from the record, so of a record `frozen` made, which cannot change, it is made once however many
 * passes and views load it. Of any other it is made each time.
 */
interface Held {
  readonly key: string;
  readonly node: Node;
  readonly diagnostics: readonly GraphDiagnostic[];
}
const held = new WeakMap<CompiledRecord, Held>();
function heldOf(record: CompiledRecord): Held {
  let known = held.get(record);
  if (known === undefined) {
    const { dimensions, diagnostics } = dimensionsOf(record);
    known = {
      key: JSON.stringify([record.identity, record.source.path, record.source.line]),
      node: hold(
        Object.freeze({
          ...snapshot(record),
          band: record.placement.band,
          reach: canonicalRoot(record.placement.reach),
          dimensions,
          digest: recordDigest(record),
        }),
      ),
      diagnostics,
    };
    if (isFrozen(record)) held.set(record, known);
  }
  return known;
}
export function load(records: readonly CompiledRecord[], registry: FrozenRegistry, options: LoadOptions): Graph {
  validatePool(registry, records);
  const location = canonicalRoot(options.location);
  if (options.phase !== undefined && !isPhase(options.phase))
    throw new GraphUsageError(
      'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
      `Unknown phase '${options.phase}'; admitted: orient, plan, act, learn`,
    );
  const revision = revisionOf(registry, options);
  const sourceLocations = new Map(options.sources.map((s) => [canonicalPath(s.path), s.location]));
  const seen = new Set<string>();
  const diagnostics: GraphDiagnostic[] = [];
  let occurrences: Occurrence[] = records
    .map<Occurrence>((record) => {
      assertLocation({ placement: record.placement, provenance: record.provenance });
      const sourceLocation = sourceLocations.get(record.source.path);
      if (sourceLocation === undefined)
        throw new TypeError(`Record source ${record.source.path} is absent from revision inputs`);
      if (
        sourceLocation.placement.kind !== record.placement.kind ||
        sourceLocation.placement.band !== record.placement.band ||
        canonicalRoot(sourceLocation.placement.reach) !== canonicalRoot(record.placement.reach) ||
        sourceLocation.provenance !== record.provenance
      )
        throw new TypeError(`Record placement/provenance disagrees with revision source ${record.source.path}`);
      const { key, node, diagnostics: refused } = heldOf(record);
      if (seen.has(key)) throw new TypeError(`Duplicate record occurrence ${key}`);
      seen.add(key);
      diagnostics.push(...refused);
      return { key, node, status: refused.length > 0 ? 'refused' : 'inactive' };
    })
    .sort(
      (a, b) =>
        compare(a.node.identity, b.node.identity) ||
        compare(a.node.source.path, b.node.source.path) ||
        a.node.source.line - b.node.source.line,
    );
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const node = occurrence.node;
    const phaseAdmitted =
      options.phase === undefined ||
      node.selectors.length === 0 ||
      node.selectors.some(
        (group) =>
          !group.some((t) => t.axis === 'phase') || group.some((t) => t.axis === 'phase' && t.value === options.phase),
      );
    if (occurrence.status === 'refused' || !reaches(node.reach, location) || !phaseAdmitted) continue;
    const group = groups.get(node.identity) ?? [];
    group.push(occurrence);
    groups.set(node.identity, group);
  }
  const states = new Map<string, Pick<Occurrence, 'status' | 'shadowedBy'>>();
  const nodes = new Map<string, Node>();
  const shadows: Shadow[] = [];
  const ties: Tie[] = [];
  for (const [identity, group] of groups) {
    const band = group.reduce((highest, o) => Math.max(highest, o.node.band), -Infinity);
    const highest = group.filter((o) => o.node.band === band);
    if (highest.length > 1) {
      ties.push({ identity, band: highest[0]!.node.band, occurrences: highest.map((o) => o.key) });
      const tied = listed(highest, (o) => `${o.node.source.path}:${o.node.source.line}`);
      for (const occurrence of highest) {
        states.set(occurrence.key, { status: 'tied' });
        diagnostics.push(
          graphDiagnostic(
            'IA-GRAPH-IDENTITY-TIE',
            occurrence.node.source.path,
            occurrence.node.source.line,
            `${identity} ties at band ${band}: ${tied}`,
          ),
        );
      }
      for (const occurrence of group)
        if (occurrence.node.band !== band) states.set(occurrence.key, { status: 'blocked' });
      continue;
    }
    const winner = highest[0]!;
    nodes.set(identity, winner.node);
    states.set(winner.key, { status: 'winner' });
    for (const loser of group)
      if (loser !== winner) {
        states.set(loser.key, { status: 'shadowed', shadowedBy: winner.key });
        shadows.push({ identity, winner: winner.key, shadowed: loser.key });
      }
  }
  occurrences = occurrences.map((o) => ({ ...o, ...states.get(o.key) }));
  const byName = new Map<string, string[]>(),
    byDiscriminator = new Map<string, string[]>(),
    byKind = new Map<string, string[]>(),
    bySystem = new Map<string, string[]>(),
    byCategory = new Map<string, string[]>(),
    byLane = new Map<string, string[]>(),
    byArtifactSet = new Map<string, string[]>();
  const cells = new Map<string, CellRef[]>(),
    selectors = new Map<string, Map<string, string[]>>(),
    conditions = new Map<string, string[]>();
  const post = (map: Map<string, string[]>, key: string, identity: string): void => {
    const list = map.get(key) ?? [];
    // Every post of a node comes before the next node's, so a repeat can only be the last entry.
    if (list[list.length - 1] !== identity) list.push(identity);
    map.set(key, list);
  };
  for (const node of nodes.values()) {
    post(byName, node.name, node.identity);
    post(byDiscriminator, node.discriminator, node.identity);
    post(byKind, node.kind, node.identity);
    post(bySystem, node.system, node.identity);
    post(byCategory, registry.registrations.get(node.discriminator)!.category, node.identity);
    post(byLane, laneOf(node), node.identity);
    if (node.dimensions.artifactSet !== undefined) post(byArtifactSet, node.dimensions.artifactSet, node.identity);
    for (const cell of node.cells) {
      const key = `${cell.phase}/${cell.primitive}`,
        list = cells.get(key) ?? [];
      list.push({ identity: node.identity, primary: cell.primary, span: cell.span });
      cells.set(key, list);
    }
    for (const group of node.selectors)
      for (const term of group) {
        const map = selectors.get(term.axis) ?? new Map<string, string[]>();
        post(map, term.value, node.identity);
        selectors.set(term.axis, map);
      }
    for (const product of [...node.cells, ...node.edges, ...node.variants, ...node.requirements])
      for (const term of product.condition ?? []) post(conditions, `${term.axis}=${term.value}`, node.identity);
  }
  /** Each declaration's entries by schema and line, read once: a system of many entries has as many `ground` edges. */
  const entrySpans = new Map<SystemDeclaration, ReadonlySet<string>>();
  /** The assertions of each edge under construction, published frozen with it, in the order they are met. */
  const edgeMap = new Map<string, Edge & { readonly assertions: EdgeAssertion[] }>();
  const pool = [...nodes.values()],
    named = namedIndex(pool);
  for (const author of pool)
    for (const assertion of author.edges) {
      const resolved = resolve(assertion.reference, candidatesOf(assertion.reference, nodes, named), registry);
      if (!resolved.ok && resolved.code === 'IA-GRAPH-TARGET-AMBIGUOUS') {
        diagnostics.push(
          graphDiagnostic(
            resolved.code,
            author.source.path,
            assertion.span.line,
            `Ambiguous ${referenceKey(assertion.reference)}`,
          ),
        );
        continue;
      }
      const target = resolved.ok ? resolved.identity : null;
      if (!resolved.ok)
        diagnostics.push(
          graphDiagnostic(
            resolved.code,
            author.source.path,
            assertion.span.line,
            `Missing ${referenceKey(assertion.reference)}`,
            true,
          ),
        );
      const from = assertion.direction === 'out' ? author.identity : target;
      const to = assertion.direction === 'out' ? target : author.identity;
      if (from !== null && to !== null && !structuralGround(author, assertion, nodes.get(to)!, registry, entrySpans)) {
        const refusal = consentFor(
          registry,
          assertion.predicate,
          nodes.get(from)!.discriminator,
          nodes.get(to)!.discriminator,
          assertion.direction === 'out' ? assertion.fragment : undefined,
        );
        if (refusal !== undefined) {
          diagnostics.push(
            graphDiagnostic(
              'IA-GRAPH-EDGE-UNCONSENTED',
              author.source.path,
              assertion.span.line,
              `${refusal} system refuses ${assertion.predicate} from ${from} to ${to}`,
            ),
          );
          continue;
        }
      }
      const source = { path: author.source.path, ...assertion.span };
      const edge = {
        from,
        predicate: assertion.predicate,
        to,
        author: author.identity,
        reference: assertion.reference,
        conditionSubject: author.identity,
        source,
        ...(assertion.fragment === undefined
          ? {}
          : {
              fragment: assertion.fragment,
              fragmentEndpoint: assertion.direction === 'out' ? ('to' as const) : ('from' as const),
            }),
        ...(assertion.condition === undefined ? {} : { condition: assertion.condition }),
        assertions: [
          {
            author: author.identity,
            direction: assertion.direction,
            spelling: assertion.spelling,
            reference: assertion.reference,
            source,
          },
        ],
      };
      const key = stableSerialize([
        from,
        edge.predicate,
        to,
        edge.fragment ?? null,
        edge.fragmentEndpoint ?? null,
        edge.condition ?? [],
        edge.condition === undefined ? null : author.identity,
        target === null ? referenceKey(edge.reference) : null,
      ]);
      const prior = edgeMap.get(key);
      if (prior === undefined) edgeMap.set(key, edge);
      else prior.assertions.push(edge.assertions[0]!);
    }
  // Every list that holds an edge holds this one object.
  const edges: Edge[] = [...edgeMap.values()].map((edge) => hold(snapshot<Edge>(edge))).sort(edgeOrder);
  const out = new Map<string, Map<Predicate, Edge[]>>(),
    inbound = new Map<string, Map<Predicate, Edge[]>>();
  const dangling: Edge[] = [],
    byDanglingReference = new Map<string, Edge[]>();
  const adjacent = (map: Map<string, Map<Predicate, Edge[]>>, identity: string, edge: Edge): void => {
    const predicates = map.get(identity) ?? new Map<Predicate, Edge[]>();
    const list = predicates.get(edge.predicate) ?? [];
    list.push(edge);
    predicates.set(edge.predicate, list);
    map.set(identity, predicates);
  };
  for (const edge of edges) {
    if (edge.from !== null) adjacent(out, edge.from, edge);
    if (edge.to !== null) adjacent(inbound, edge.to, edge);
    if (edge.from === null || edge.to === null) {
      dangling.push(edge);
      const key = referenceKey(edge.reference),
        list = byDanglingReference.get(key) ?? [];
      list.push(edge);
      byDanglingReference.set(key, list);
    }
  }
  diagnostics.sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code));
  const references = fieldReferences(nodes, named, registry).map((reference) => hold(snapshot(reference))),
    referencedBy = new Map<string, FieldReference[]>(),
    referencesFrom = new Map<string, FieldReference[]>();
  const keyed = (map: Map<string, FieldReference[]>, identity: string, reference: FieldReference): void => {
    const list = map.get(identity) ?? [];
    list.push(reference);
    map.set(identity, list);
  };
  for (const reference of references) {
    keyed(referencedBy, reference.to, reference);
    keyed(referencesFrom, reference.from, reference);
  }
  const graph = snapshot({
    revision,
    location,
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    registry,
    nodes,
    occurrences,
    shadows,
    ties,
    diagnostics,
    edges,
    out,
    in: inbound,
    byName,
    byDiscriminator,
    byKind,
    bySystem,
    byCategory,
    byLane,
    byArtifactSet,
    cells,
    selectors,
    conditions,
    dangling,
    byDanglingReference,
    references,
    referencedBy,
    referencesFrom,
    claims: claimsOf(nodes.values()),
  });
  // G11a: built when first read. Only a graph that is searched pays for an index, and a view is rebuilt pass by pass.
  let text: Graph['text'] | undefined;
  return Object.freeze(
    Object.defineProperty({ ...graph }, 'text', {
      enumerable: true,
      get: () => (text ??= snapshot(buildTextIndex(nodes.values()))),
    }),
  ) as unknown as Graph;
}
/** Admitted nodes by the word and name a typed reference spells: each reference reads only what can resolve it. */
function namedIndex(nodes: readonly Node[]): ReadonlyMap<string, readonly Node[]> {
  const named = new Map<string, Node[]>();
  for (const node of nodes) {
    const key = `${node.discriminator} ${node.name}`,
      list = named.get(key);
    if (list === undefined) named.set(key, [node]);
    else list.push(node);
  }
  return named;
}
function candidatesOf(
  reference: EdgeReference,
  nodes: ReadonlyMap<string, Node>,
  named: ReadonlyMap<string, readonly Node[]>,
): readonly Node[] {
  if (reference.kind === 'ref') return named.get(`${reference.discriminator} ${reference.name.toLowerCase()}`) ?? [];
  const node = nodes.get(reference.identity);
  return node === undefined ? [] : [node];
}
function entryAt(
  declaration: SystemDeclaration,
  schema: string,
  line: number,
  entrySpans: Map<SystemDeclaration, ReadonlySet<string>>,
): boolean {
  let spans = entrySpans.get(declaration);
  if (spans === undefined) {
    spans = new Set(declaration.entries.map((entry) => `${entry.schema} ${entry.span.line}`));
    entrySpans.set(declaration, spans);
  }
  return spans.has(`${schema} ${line}`);
}

function structuralGround(
  author: Node,
  edge: CompiledEdge,
  target: Node,
  registry: FrozenRegistry,
  entrySpans: Map<SystemDeclaration, ReadonlySet<string>>,
): boolean {
  if (
    author.discriminator !== 'system' ||
    target.discriminator !== 'schema' ||
    edge.direction !== 'out' ||
    edge.predicate !== 'ground' ||
    edge.condition !== undefined ||
    edge.fragment !== undefined
  )
    return false;
  const declaration = registry.systems.get(author.name);
  return (
    declaration !== undefined &&
    canonicalPath(declaration.path) === author.source.path &&
    entryAt(declaration, target.name, edge.span.line, entrySpans)
  );
}
const referenceOrder = (a: FieldReference, b: FieldReference): number =>
  compare(a.from, b.from) ||
  compare(a.field, b.field) ||
  compare(a.to, b.to) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line ||
  compare(stableSerialize(a.reference), stableSerialize(b.reference));
/** Whether a line falls in one of `spans`, from their union, read once: a record's fields each ask of its edges. */
function lineCover(spans: readonly Span[]): (line: number) => boolean {
  const union: { line: number; endLine: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.line - b.line)) {
    const last = union[union.length - 1];
    if (last !== undefined && span.line <= last.endLine + 1) last.endLine = Math.max(last.endLine, span.endLine);
    else union.push({ line: span.line, endLine: span.endLine });
  }
  return (line) => {
    let low = 0,
      high = union.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (union[middle]!.endLine < line) low = middle + 1;
      else high = middle;
    }
    return low < union.length && union[low]!.line <= line;
  };
}
/**
 * G06a: every resolved typed ref value a winner holds in its head or sections, as a derived index beside the edges.
 * It reads what the compiler kept as fields, so it never duplicates an edge: `relationships` is skipped by name (its
 * refs are edge assertions, and a consent-refused one must not reappear here), and a ref inside the span of an edge
 * the compiler already lowered (a floor @system `discriminators` entry's `ground`) is skipped too. A field reference
 * carries no predicate and is never consent-, cardinality- or COMP-checked; an unresolved or ambiguous ref is left
 * out without a diagnostic, since compliance already reports it (IA-COMP-FIELD-REF-MISSING).
 */
function fieldReferences(
  nodes: ReadonlyMap<string, Node>,
  named: ReadonlyMap<string, readonly Node[]>,
  registry: FrozenRegistry,
): FieldReference[] {
  const found = new Map<string, FieldReference>();
  const refs = (value: CompiledValue): readonly Extract<CompiledValue, { kind: 'ref' }>[] =>
    value.kind === 'ref' ? [value] : value.kind === 'list' ? value.items.flatMap(refs) : [];
  for (const author of nodes.values()) {
    const lowered = lineCover(author.edges.map((edge) => edge.span));
    const visit = (children: readonly CompiledChild[], path: string): void => {
      for (const child of children) {
        const [value, field] = 'item' in child ? [child.item, path] : [child.value, `${path}.${child.key}`];
        if (!lowered(child.span.line))
          for (const reference of refs(value)) {
            const resolved = resolve(reference, candidatesOf(reference, nodes, named), registry);
            if (!resolved.ok) continue;
            const entry: FieldReference = {
              from: author.identity,
              to: resolved.identity,
              field,
              reference,
              source: { path: author.source.path, line: child.span.line, endLine: child.span.endLine },
            };
            found.set(
              stableSerialize([
                entry.from,
                entry.field,
                entry.to,
                entry.source.path,
                entry.source.line,
                entry.reference,
              ]),
              entry,
            );
          }
        if (!('item' in child)) visit(child.fields ?? [], field);
      }
    };
    visit(author.head, 'head');
    for (const section of author.sections) if (section.name !== 'relationships') visit(section.fields, section.name);
  }
  return [...found.values()].sort(referenceOrder);
}
export function serialize(graph: Graph, limit?: number): string {
  return stableSerialize(graph, limit);
}
