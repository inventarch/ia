import type { ChildNode, FieldNode, FileNode, RecordNode, Span } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { collisions, identityOf, renderIdentity } from '../identity.js';
import type { Identity, IdentityOccurrence } from '../identity.js';
import { canonicalPath } from '../paths.js';
import { spelledAs } from '../registry/fields.js';
import { FLOOR_SYSTEM } from '../registry/floor.js';
import { conditionsIn, recordsIn } from '../registry/records.js';
import { sortDiagnostics } from '../registry/index.js';
import type { FrozenRegistry, Location, Placement } from '../registry/types.js';
import type { Kind, Provenance } from '../taxonomy.js';
import { spellingsFor } from './spellings.js';
import { compiledValue, resolveKey } from './values.js';
import type { CompiledValue, Spelling } from './values.js';
import type { Cell, CompiledEdge, Requirement, Selector, Variant } from '../semantic/types.js';
import { readCells } from '../semantic/cells.js';
import { readSelectors } from '../semantic/selectors.js';
import { readVariants } from '../semantic/variants.js';
import { readEdges } from '../semantic/edges.js';
import { readContract } from '../semantic/contracts.js';
import { validateCase } from '../semantic/cases.js';
import { misplacedConditions } from '../semantic/placement.js';
import { requirementCollisions } from '../semantic/requirements.js';
import { indexedResolver, validatePool } from '../semantic/resolve.js';
export type { CompiledEdge } from '../semantic/types.js';

export interface CompiledField {
  readonly key: string;
  readonly value: CompiledValue;
  /** Authored words retained for tools; admitted semantic carriers also expose canonical terms. */
  readonly when?: readonly string[];
  readonly span: Span;
  readonly fields?: readonly CompiledChild[];
}

/** A `- value` line beside the fields of its section or block. */
export interface CompiledItem {
  readonly item: CompiledValue;
  readonly span: Span;
}

export type CompiledChild = CompiledField | CompiledItem;

export interface CompiledSection {
  readonly name: string;
  readonly span: Span;
  readonly fields: readonly CompiledChild[];
}

/** The structured record and semantic products of spec 10.2. Errors leave only a preview, not loadable data. */
export interface CompiledRecord {
  readonly identity: string;
  readonly system: string;
  readonly kind: Kind;
  readonly facet: string;
  readonly name: string;
  readonly displayName: string;
  readonly discriminator: string;
  readonly parent?: string;
  readonly source: { readonly path: string; readonly line: number; readonly endLine: number };
  readonly head: readonly CompiledField[];
  readonly sections: readonly CompiledSection[];
  readonly edges: readonly CompiledEdge[];
  readonly cells: readonly Cell[];
  readonly selectors: readonly Selector[];
  readonly variants: readonly Variant[];
  readonly requirements: readonly Requirement[];
  readonly schema: string;
  readonly provenance: Provenance;
  readonly placement: Placement;
}

/** Spec 10.4: authored spans plus arrays parallel to every emitted semantic product. */
export interface SourceMapEntry {
  readonly identity: string;
  readonly header: Span;
  readonly sections: readonly { readonly name: string; readonly span: Span }[];
  readonly fields: readonly { readonly path: string; readonly span: Span }[];
  /** Parallel to the record's emitted edges. */
  readonly edges: readonly Span[];
  readonly cells: readonly Span[];
  readonly selectors: readonly Span[];
  readonly variants: readonly Span[];
  readonly requirements: readonly Span[];
}

export interface CompileResult {
  readonly records: readonly CompiledRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly sourceMap: readonly SourceMapEntry[];
}

interface Draft {
  readonly node: RecordNode;
  readonly record: CompiledRecord;
  readonly map: SourceMapEntry;
  readonly occurrence: IdentityOccurrence;
  readonly parent: IdentityOccurrence | undefined;
}

interface Context {
  readonly registry: FrozenRegistry;
  readonly location: Location;
  readonly path: string;
  readonly diagnostics: Diagnostic[];
  readonly drafts: Draft[];
  readonly syntaxRefused: ReadonlySet<RecordNode>;
}

/**
 * Lower one parsed file at a location (spec 10.1). Pure: no I/O, no clock, no default vocabulary.
 * pool contains external admitted occurrences and must exclude this canonical source path.
 */
export function compile(
  ast: FileNode,
  registry: FrozenRegistry,
  location: Location,
  pool: readonly CompiledRecord[],
): CompileResult {
  validatePool(registry, pool, ast.path);
  const syntaxRefused = new Set(
    recordsIn(ast, ast.syntaxDiagnostics ?? [])
      .filter((source) => source.errors.length > 0)
      .map((source) => source.record),
  );
  const ctx: Context = {
    registry,
    location,
    path: canonicalPath(ast.path),
    diagnostics: [],
    drafts: [],
    syntaxRefused,
  };
  for (const record of ast.records) compileRecord(record, undefined, ctx);
  // One identity twice in this file is a collision on both (spec 3.2); across files the caller and the graph decide.
  const found = collisions(ctx.drafts.map((draft) => draft.occurrence));
  ctx.diagnostics.push(...found.diagnostics);
  // Parents precede their descendants in source order. Follow actual occurrences, not names:
  // a refused enclosing record cannot leave compiled children with a dangling parent.
  const refused = new Set(found.refused);
  const kept: Draft[] = [];
  for (const draft of ctx.drafts.sort((a, b) => a.record.source.line - b.record.source.line)) {
    if (draft.parent !== undefined && refused.has(draft.parent)) refused.add(draft.occurrence);
    if (!refused.has(draft.occurrence)) kept.push(draft);
  }
  const local = kept.map((draft) => lowerProducts(draft, ctx));
  const candidates = [...local.map((draft) => draft.record), ...pool];
  const resolver = indexedResolver(registry, candidates);
  const related = local.map((draft) => lowerRelationships(draft, resolver, ctx));
  const occurrences = related.flatMap(({ record }) =>
    record.requirements.map((requirement) => ({
      id: requirement.id,
      identity: record.identity,
      path: record.source.path,
      line: requirement.span.line,
      requirement,
    })),
  );
  const duplicateRequirements = requirementCollisions(occurrences);
  ctx.diagnostics.push(...duplicateRequirements.diagnostics);
  const refusedRequirements = new Set([...duplicateRequirements.refused].map((occurrence) => occurrence.requirement));
  const final = related.map((draft) => {
    const requirements = draft.record.requirements.filter((requirement) => !refusedRequirements.has(requirement));
    return {
      ...draft,
      record: { ...draft.record, requirements },
      map: { ...draft.map, requirements: requirements.map((requirement) => requirement.span) },
    };
  });
  return {
    records: final.map((draft) => draft.record),
    diagnostics: sortDiagnostics(ctx.diagnostics),
    sourceMap: final.map((draft) => draft.map),
  };
}

/** Schema extraction owns all of that dialect's conditions, including extra field blocks. */
function schemaOwnsRefusal(node: RecordNode): boolean {
  return (
    node.discriminator === 'schema' &&
    (node.sections.some((section) => section.name === 'when') ||
      conditionsIn([...node.head, ...node.sections.flatMap((section) => section.children)]).length > 0)
  );
}

function lowerProducts(draft: Draft, ctx: Context): Draft {
  if (schemaOwnsRefusal(draft.node)) return draft;
  const registration = ctx.registry.registrations.get(draft.record.discriminator)!;
  const cells = readCells(draft.node, ctx.path);
  const selectors = readSelectors(draft.node, ctx.path);
  const variants = readVariants(
    draft.node,
    ctx.path,
    spellingsFor(registration, ctx.registry.schemas.get(registration.schema), 'governance'),
  );
  ctx.diagnostics.push(
    ...misplacedConditions(draft.node, ctx.path),
    ...cells.diagnostics,
    ...selectors.diagnostics,
    ...variants.diagnostics,
  );
  return {
    ...draft,
    record: { ...draft.record, cells: cells.cells, selectors: selectors.selectors, variants: variants.variants },
    map: {
      ...draft.map,
      cells: cells.cells.map((cell) => cell.span),
      selectors: selectors.spans,
      variants: variants.variants.map((variant) => variant.span),
    },
  };
}

function lowerRelationships(draft: Draft, pool: ReturnType<typeof indexedResolver>, ctx: Context): Draft {
  if (schemaOwnsRefusal(draft.node)) return draft;
  const edges = readEdges(draft.node, draft.record, ctx.registry, pool, draft.record.edges);
  const contract = readContract(draft.node, ctx.path, ctx.registry, edges.edges, edges.refusedBindings);
  const scenario = validateCase(draft.node, ctx.path, ctx.registry, edges.edges, edges.refusedBindings);
  ctx.diagnostics.push(...edges.diagnostics, ...contract.diagnostics, ...scenario.diagnostics);
  return {
    ...draft,
    record: { ...draft.record, edges: edges.edges, requirements: contract.requirements },
    map: { ...draft.map, edges: edges.edges.map((edge) => edge.span) },
  };
}

function compileRecord(record: RecordNode, parent: IdentityOccurrence | undefined, ctx: Context): void {
  if (ctx.syntaxRefused.has(record)) return; // parser owns this refusal; descendants cannot outlive their parent
  const { registry, path } = ctx;
  const line = record.span.line;
  const registration = registry.registrations.get(record.discriminator);
  if (registration === undefined) {
    const why = registry.blocked.has(record.discriminator)
      ? 'is blocked at this location: two systems register it at the winning band'
      : 'is not registered at this location';
    ctx.diagnostics.push(
      diag(
        'IA-LANG-DISCRIMINATOR-UNREGISTERED',
        path,
        line,
        `${path}:${line}: discriminator '${record.discriminator}' ${why}; visible systems: ${registry.order.join(', ')}`,
      ),
    );
    return; // nothing beneath a refused record compiles: a nested record would have no parent identity
  }
  const identified = identityOf(record, registration, path);
  ctx.diagnostics.push(...identified.diagnostics);
  const identity = identified.identity;
  if (identity === undefined) return;
  const occurrence: IdentityOccurrence = { identity: identity.identity, path, line, band: ctx.location.placement.band };

  const schema = registry.schemas.get(registration.schema);
  const fieldSpans: { path: string; span: Span }[] = [];
  const head: CompiledField[] = [];
  for (const field of record.head) {
    const compiled = compileField(
      field,
      spellingsFor(registration, schema, 'head'),
      'head',
      occurrence,
      fieldSpans,
      ctx,
    );
    if (!spelledAs(field, ['facet'])) head.push(compiled); // facet is consumed; its source span and nested records survive
  }
  const sections: CompiledSection[] = record.sections.map((section) => ({
    name: section.name,
    span: section.span,
    fields: compileChildren(
      section.children,
      spellingsFor(registration, schema, section.name),
      section.name,
      occurrence,
      fieldSpans,
      ctx,
    ),
  }));
  const edges =
    registration.system === FLOOR_SYSTEM && registration.keyword === 'system' ? groundEdges(record, identity, ctx) : [];
  const compiled: CompiledRecord = {
    identity: identity.identity,
    system: identity.system,
    kind: identity.kind,
    facet: identity.facet,
    name: identity.name,
    displayName: identity.displayName,
    discriminator: record.discriminator,
    ...(parent === undefined ? {} : { parent: parent.identity }),
    source: { path, line: record.span.line, endLine: record.span.endLine },
    head,
    sections,
    edges,
    cells: [],
    selectors: [],
    variants: [],
    requirements: [],
    schema: renderIdentity(FLOOR_SYSTEM, 'contract', 'head', registration.schema),
    provenance: ctx.location.provenance,
    placement: ctx.location.placement,
  };
  ctx.drafts.push({
    node: record,
    record: compiled,
    map: {
      identity: identity.identity,
      header: { line, endLine: line },
      sections: sections.map((s) => ({ name: s.name, span: s.span })),
      fields: fieldSpans,
      edges: edges.map((edge) => edge.span),
      cells: [],
      selectors: [],
      variants: [],
      requirements: [],
    },
    occurrence,
    parent,
  });
}

function compileChildren(
  children: readonly ChildNode[],
  spellings: readonly Spelling[],
  prefix: string,
  parent: IdentityOccurrence,
  fieldSpans: { path: string; span: Span }[],
  ctx: Context,
): CompiledChild[] {
  const out: CompiledChild[] = [];
  for (const child of children) {
    if (child.kind === 'record') {
      compileRecord(child, parent, ctx);
      continue;
    } // containment is structural, not a field (spec 2.5)
    if (child.kind === 'item') {
      out.push({ item: compiledValue(child.value), span: child.span });
      continue;
    }
    out.push(compileField(child, spellings, prefix, parent, fieldSpans, ctx));
  }
  return out;
}

function compileField(
  field: FieldNode,
  spellings: readonly Spelling[],
  prefix: string,
  parent: IdentityOccurrence,
  fieldSpans: { path: string; span: Span }[],
  ctx: Context,
): CompiledField {
  const { key, value } = resolveKey(field, spellings);
  const fieldPath = `${prefix}.${key}`;
  fieldSpans.push({ path: fieldPath, span: field.span });
  const nested =
    field.children.length === 0
      ? undefined
      : compileChildren(field.children, spellings, fieldPath, parent, fieldSpans, ctx);
  return {
    key,
    value,
    ...(field.when === undefined ? {} : { when: field.when }),
    span: field.span,
    ...(nested === undefined ? {} : { fields: nested }),
  };
}

/** Spec 4.2: the compiler emits a `ground` edge from a system record to each schema an entry it registered names. */
function groundEdges(record: RecordNode, identity: Identity, ctx: Context): CompiledEdge[] {
  const { registry } = ctx;
  const system = registry.systems.get(identity.name);
  if (
    system === undefined ||
    canonicalPath(system.path) !== ctx.path ||
    system.band !== ctx.location.placement.band ||
    system.span.line !== record.span.line
  )
    return [];
  const edges: CompiledEdge[] = [];
  const named = new Set<string>();
  for (const entry of system.entries) {
    const registration = registry.registrations.get(entry.keyword);
    if (
      registration === undefined ||
      registration.system !== system.name ||
      registration.band !== system.band ||
      registration.schema !== entry.schema ||
      named.has(entry.schema)
    )
      continue;
    named.add(entry.schema);
    edges.push({
      predicate: 'ground',
      direction: 'out',
      reference: { kind: 'ref', discriminator: 'schema', name: entry.schema },
      target: renderIdentity(FLOOR_SYSTEM, 'contract', 'head', entry.schema),
      span: entry.span,
    });
  }
  return edges;
}
