import { KIND_LANES, canonicalPath, consentFor, isPhase, validatePool } from '@inventarch/language';
import type {
  CompiledChild,
  CompiledEdge,
  CompiledRecord,
  CompiledValue,
  FrozenRegistry,
  Predicate,
} from '@inventarch/language';
import { dimensionsOf } from './coordinate.js';
import { recordDigest } from './digest.js';
import { GraphUsageError, graphDiagnostic } from './diagnostics.js';
import type { GraphDiagnostic } from './diagnostics.js';
import { snapshot } from './immutable.js';
import { assertLocation, canonicalRoot, reaches } from './paths.js';
import { referenceKey, resolve } from './resolve.js';
import { compare, revisionOf, stableSerialize } from './revision.js';
import { buildTextIndex } from './text.js';
import type { CellRef, Edge, FieldReference, Graph, LoadOptions, Node, Occurrence, Shadow, Tie } from './types.js';

export const edgeOrder = (a: Edge, b: Edge): number =>
  compare(a.from ?? '', b.from ?? '') ||
  compare(a.predicate, b.predicate) ||
  compare(a.to ?? '', b.to ?? '') ||
  compare(a.fragment ?? '', b.fragment ?? '') ||
  compare(a.fragmentEndpoint ?? '', b.fragmentEndpoint ?? '') ||
  compare(stableSerialize(a.condition ?? []), stableSerialize(b.condition ?? [])) ||
  compare(a.author, b.author) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line;
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
  const sourceTexts = new Map(options.sources.map((s) => [canonicalPath(s.path), s.text]));
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
      const key = JSON.stringify([record.identity, record.source.path, record.source.line]);
      if (seen.has(key)) throw new TypeError(`Duplicate record occurrence ${key}`);
      seen.add(key);
      const dimensions = dimensionsOf(record);
      diagnostics.push(...dimensions.diagnostics);
      const node: Node = {
        ...record,
        band: record.placement.band,
        reach: canonicalRoot(record.placement.reach),
        dimensions: dimensions.dimensions,
        digest: recordDigest(sourceTexts.get(record.source.path)!, record.source),
      };
      return { key, node, status: dimensions.diagnostics.length > 0 ? 'refused' : 'inactive' };
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
    const band = Math.max(...group.map((o) => o.node.band));
    const highest = group.filter((o) => o.node.band === band);
    if (highest.length > 1) {
      ties.push({ identity, band: highest[0]!.node.band, occurrences: highest.map((o) => o.key) });
      for (const occurrence of highest) {
        states.set(occurrence.key, { status: 'tied' });
        diagnostics.push(
          graphDiagnostic(
            'IA-GRAPH-IDENTITY-TIE',
            occurrence.node.source.path,
            occurrence.node.source.line,
            `${identity} ties at band ${band}: ${highest.map((o) => `${o.node.source.path}:${o.node.source.line}`).join(', ')}`,
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
    if (!list.includes(identity)) list.push(identity);
    map.set(key, list);
  };
  for (const node of nodes.values()) {
    post(byName, node.name, node.identity);
    post(byDiscriminator, node.discriminator, node.identity);
    post(byKind, node.kind, node.identity);
    post(bySystem, node.system, node.identity);
    post(byCategory, registry.registrations.get(node.discriminator)!.category, node.identity);
    post(
      byLane,
      node.kind === 'contract' && node.facet === 'authority' ? 'authority' : KIND_LANES[node.kind],
      node.identity,
    );
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
  const edgeMap = new Map<string, Edge>();
  const pool = [...nodes.values()];
  for (const author of pool)
    for (const assertion of author.edges) {
      const candidates = (
        assertion.reference.kind === 'identity'
          ? [assertion.reference.identity]
          : (byName.get(assertion.reference.name.toLowerCase()) ?? [])
      ).flatMap((id) => {
        const node = nodes.get(id);
        return node === undefined ? [] : [node];
      });
      const resolved = resolve(assertion.reference, candidates, registry);
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
      if (from !== null && to !== null && !structuralGround(author, assertion, nodes.get(to)!, registry)) {
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
      const edge: Edge = {
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
      edgeMap.set(
        key,
        prior === undefined ? edge : { ...prior, assertions: [...prior.assertions, ...edge.assertions] },
      );
    }
  const edges = [...edgeMap.values()].sort(edgeOrder);
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
  const references = fieldReferences(nodes, byName, registry),
    referencedBy = new Map<string, FieldReference[]>();
  for (const reference of references) {
    const list = referencedBy.get(reference.to) ?? [];
    list.push(reference);
    referencedBy.set(reference.to, list);
  }
  return snapshot({
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
    text: buildTextIndex(nodes.values()),
  });
}

function structuralGround(author: Node, edge: CompiledEdge, target: Node, registry: FrozenRegistry): boolean {
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
    declaration.entries.some((e) => e.schema === target.name && e.span.line === edge.span.line)
  );
}
const referenceOrder = (a: FieldReference, b: FieldReference): number =>
  compare(a.from, b.from) ||
  compare(a.field, b.field) ||
  compare(a.to, b.to) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line ||
  compare(stableSerialize(a.reference), stableSerialize(b.reference));
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
  byName: ReadonlyMap<string, readonly string[]>,
  registry: FrozenRegistry,
): FieldReference[] {
  const found = new Map<string, FieldReference>();
  const refs = (value: CompiledValue): readonly Extract<CompiledValue, { kind: 'ref' }>[] =>
    value.kind === 'ref' ? [value] : value.kind === 'list' ? value.items.flatMap(refs) : [];
  for (const author of nodes.values()) {
    const lowered = author.edges.map((edge) => edge.span);
    const visit = (children: readonly CompiledChild[], path: string): void => {
      for (const child of children) {
        const [value, field] = 'item' in child ? [child.item, path] : [child.value, `${path}.${child.key}`];
        if (!lowered.some((span) => span.line <= child.span.line && child.span.line <= span.endLine))
          for (const reference of refs(value)) {
            const candidates = (byName.get(reference.name.toLowerCase()) ?? []).flatMap((id) => {
              const node = nodes.get(id);
              return node === undefined ? [] : [node];
            });
            const resolved = resolve(reference, candidates, registry);
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
export function serialize(graph: Graph): string {
  return stableSerialize(graph);
}
