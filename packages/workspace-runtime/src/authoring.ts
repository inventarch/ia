import type { CompiledRecord } from '@inventarch/language';
import type { Capture } from './corpus.js';
import type { CapturedResources, ResourceOccurrence } from './resource-format.js';
import { frozen, integer, keyOf, list, metadataDigest, object, occurrenceOf } from './resource-format.js';
import { nativeResourcePath } from './resource-sources.js';
import { AUTHORING_LIMITS, AuthoringError, authoringRequest, invalidAuthoring } from './authoring-format.js';
import { authoringContext, nativePart, resourcePart, verifyAuthoringIndex } from './authoring-index.js';
import type { AuthoringContext } from './authoring-index.js';
import type {
  AuthoringRequirements,
  AuthoringScope,
  AuthoringTargetRequest,
  AuthoringView,
  CapturedAuthoringIndex,
  PrimaryGuide,
  RequiredAuthoringPart,
} from './authoring-types.js';
export { AUTHORING_LIMITS, AuthoringError } from './authoring-format.js';
export { createAuthoringIndex, verifyAuthoringIndex } from './authoring-index.js';
export type * from './authoring-types.js';

interface State {
  readonly context: AuthoringContext;
  readonly index: CapturedAuthoringIndex;
  readonly scope: AuthoringScope;
  readonly visible: ReadonlySet<string>;
  readonly resources: ReadonlySet<string>;
}
const states = new WeakMap<AuthoringView, State>();
/** Release this resolver's internal reader; the caller retains ownership of its scope reader. */
export function closeAuthoringView(view: AuthoringView): void {
  const state = states.get(view);
  if (state) {
    states.delete(view);
    state.context.reader.close();
  }
}
const scopeFailure = (): never => {
  throw new AuthoringError('Authoring target or required evidence is unavailable in this scope', 'IA-AUTHORING-SCOPE');
};
const field = (node: CompiledRecord, section: string, key: string) => {
  const fields = node.sections.find((s) => s.name === section)?.fields.filter((f) => 'key' in f && f.key === key) ?? [];
  const selected = fields.length === 1 ? fields[0] : undefined;
  return selected && 'value' in selected ? selected.value : null;
};
const stringField = (node: CompiledRecord, section: string, key: string): string | null => {
  const value = field(node, section, key);
  return value && ['scalar', 'string', 'prose'].includes(value.kind) ? (value as { text: string }).text : null;
};
function occurrenceFor(
  context: AuthoringContext,
  path: string,
  line: number,
  identity?: string,
): ResourceOccurrence | undefined {
  return context.inventory.occurrences.find(
    (o) =>
      nativeResourcePath(context.capture, o) === path &&
      o.line === line &&
      (identity === undefined || o.identity === identity),
  );
}
function part(id: string, value: { text: string; citation: string }): RequiredAuthoringPart {
  return { id, text: value.text, citations: [value.citation] };
}
function nativeAllowed(state: State, occurrence: ResourceOccurrence): boolean {
  return state.visible.has(occurrenceOf(occurrence));
}
function guideRows(state: State): PrimaryGuide[] {
  const { context, scope } = state,
    registry = context.reader.inspect().graph.registry;
  const allowedWords = new Set(scope.allowedRegistrations),
    allowedSystems = new Set(scope.allowedSystems);
  return [...registry.registrations.values()]
    .filter((r) => allowedWords.has(r.keyword) && allowedSystems.has(r.system))
    .sort((a, b) => a.keyword.localeCompare(b.keyword))
    .map((registration): PrimaryGuide => {
      const key = `${registration.system}/${registration.keyword}`;
      const schemaDefinition = registry.schemas.get(registration.schema),
        schema = schemaDefinition && occurrenceFor(context, schemaDefinition.path, schemaDefinition.span.line);
      const basis = metadataDigest({ registration, schema: schema ? nativePart(context, schema).text : null });
      const empty = (status: PrimaryGuide['status']): PrimaryGuide => ({
        key,
        owner: registration.system,
        word: registration.keyword,
        status,
        descriptor: null,
        schema: null,
        document: null,
        proof: metadataDigest({ key, status, basis }),
      });
      if (!schema || !nativeAllowed(state, schema)) return empty('unavailable');
      const candidates = [...context.nodes].filter(
        ([, n]) =>
          n.discriminator === 'authoring-guide' &&
          n.system === 'authoring-system' &&
          stringField(n, 'reference', 'owner') === registration.system &&
          stringField(n, 'reference', 'word') === registration.keyword,
      );
      if (!candidates.length) return empty('missing');
      if (candidates.some(([o]) => !state.visible.has(o))) return empty('unavailable');
      if (candidates.length !== 1) return empty('conflict');
      const [candidateKey, candidate] = candidates[0]!,
        descriptor = context.inventory.occurrences.find((o) => occurrenceOf(o) === candidateKey)!;
      const reference = field(candidate, 'reference', 'schema'),
        documentPath = stringField(candidate, 'reference', 'document');
      if (
        !reference ||
        reference.kind !== 'ref' ||
        reference.discriminator !== 'schema' ||
        reference.name.toLowerCase() !== schemaDefinition.name ||
        reference.fragment !== undefined ||
        !documentPath
      )
        return empty('conflict');
      const matching = candidate.edges.filter(
        (e) =>
          e.predicate === 'cite' &&
          e.direction === 'out' &&
          (e.reference.kind === 'ref'
            ? e.reference.discriminator === 'schema' && e.reference.name.toLowerCase() === schemaDefinition.name
            : e.reference.identity === schema.identity),
      );
      if (matching.length !== 1 || matching[0]!.condition !== undefined || matching[0]!.fragment !== undefined)
        return empty('conflict');
      const accepted = context.reader
        .inspect()
        .graph.edges.some(
          (e) =>
            e.author === candidate.identity &&
            e.from === candidate.identity &&
            e.to === schema.identity &&
            e.predicate === 'cite' &&
            e.condition === undefined &&
            e.fragment === undefined,
        );
      if (!accepted) return empty('conflict');
      const uses =
        context.resources.associations
          .find((a) => occurrenceOf(a.owner) === candidateKey)
          ?.resources.filter((u) => u.role === 'guide' && u.key.path === documentPath) ?? [];
      if (uses.length !== 1) return empty(uses.length ? 'conflict' : 'missing');
      const use = uses[0]!;
      if (!state.resources.has(keyOf(use.key))) return empty('unavailable');
      const file = context.files.get(keyOf(use.key)),
        resource = resourcePart(context, use.key);
      if (!file || !resource) return empty('missing');
      const document = { key: use.key, sha256: file.sha256, content: resource.text, citation: resource.citation };
      return {
        key,
        owner: registration.system,
        word: registration.keyword,
        status: 'resolved',
        descriptor,
        schema,
        document,
        proof: metadataDigest({
          criterion: 'primary-guide-v1',
          registration,
          descriptor,
          descriptorText: nativePart(context, descriptor).text,
          schema,
          schemaText: nativePart(context, schema).text,
          document,
        }),
      };
    });
}
/** Current scope and resource permissions are independent of index validity. */
export function resolveAuthoring(
  capture: Capture,
  resources: CapturedResources,
  value: CapturedAuthoringIndex,
  scope: AuthoringScope,
): AuthoringView {
  const index = verifyAuthoringIndex(value, capture, resources),
    context = authoringContext(capture, resources);
  try {
    const snapshot = scope.reader.snapshot({ within: scope.within });
    if (snapshot.revision !== context.reader.revision || scope.reader.revision !== context.reader.revision)
      throw new AuthoringError('Authoring native view changed', 'IA-AUTHORING-STALE');
    const selected = new Set(snapshot.records.map((r) => JSON.stringify([r.identity, r.source.path, r.source.line])));
    const visible = new Set(
      context.inventory.occurrences
        .filter((o) => selected.has(JSON.stringify([o.identity, nativeResourcePath(capture, o), o.line])))
        .map(occurrenceOf),
    );
    const copiedScope = {
      ...scope,
      allowedResources: scope.allowedResources.map((k) => ({ ...k })),
      allowedSystems: [...scope.allowedSystems],
      allowedRegistrations: [...scope.allowedRegistrations],
      allowedArtifacts: [...scope.allowedArtifacts],
      allowedDocuments: [...scope.allowedDocuments],
    };
    for (const rows of [
      copiedScope.allowedSystems,
      copiedScope.allowedRegistrations,
      copiedScope.allowedArtifacts,
      copiedScope.allowedDocuments,
    ])
      if (new Set(rows).size !== rows.length || rows.some((id) => typeof id !== 'string')) scopeFailure();
    const permitted = new Set(copiedScope.allowedResources.map(keyOf));
    const state: State = { context, index, scope: copiedScope, visible, resources: permitted },
      guides = guideRows(state);
    const systems: AuthoringView['systems'] = [...context.reader.inspect().graph.registry.systems.values()]
      .filter((s) => copiedScope.allowedSystems.includes(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((declaration) => {
        const occurrence = occurrenceFor(context, declaration.path, declaration.span.line),
          associations = index.systems.filter((s) => occurrence && occurrenceOf(s.system) === occurrenceOf(occurrence));
        let status: PrimaryGuide['status'] =
          !occurrence || !visible.has(occurrenceOf(occurrence))
            ? 'unavailable'
            : associations.length > 1
              ? 'conflict'
              : associations.length === 0
                ? 'missing'
                : 'resolved';
        const parts: RequiredAuthoringPart[] = [];
        if (status === 'resolved') {
          const association = associations[0]!;
          parts.push(part(`native-${metadataDigest(association.system)}`, nativePart(context, association.system)));
          if (!association.authoring.length || !association.architecture.length) status = 'missing';
          for (const key of [...association.authoring, ...association.architecture, ...association.extensions]) {
            if (!permitted.has(keyOf(key))) {
              status = 'unavailable';
              break;
            }
            const resource = resourcePart(context, key);
            if (!resource) {
              status = 'missing';
              break;
            }
            parts.push(part(`resource-${metadataDigest(key)}`, resource));
          }
          for (const native of [...association.methods, ...(association.steward ? [association.steward] : [])]) {
            if (!visible.has(occurrenceOf(native))) {
              status = 'unavailable';
              break;
            }
            parts.push(part(`native-${metadataDigest(native)}`, nativePart(context, native)));
          }
        }
        const output = {
          name: declaration.name,
          status,
          system: status === 'resolved' ? occurrence! : null,
          teaching: 'not-evaluated' as const,
          parts: status === 'resolved' ? parts : [],
        };
        return { ...output, proof: metadataDigest(output) };
      });
    const artifacts: AuthoringView['artifacts'] = index.artifacts
      .filter((a) => copiedScope.allowedArtifacts.includes(a.id))
      .map((artifact) => {
        let available =
          artifact.source.kind === 'native'
            ? visible.has(occurrenceOf(artifact.source.occurrence))
            : permitted.has(keyOf(artifact.source.key));
        if (
          (artifact.contract && !permitted.has(keyOf(artifact.contract))) ||
          artifact.dependencies.some((id) => !copiedScope.allowedArtifacts.includes(id))
        )
          available = false;
        const source = !available
          ? null
          : artifact.source.kind === 'native'
            ? nativePart(context, artifact.source.occurrence)
            : resourcePart(context, artifact.source.key, artifact.source.range);
        return {
          id: artifact.id,
          revision: artifact.revision,
          status: source ? ('resolved' as const) : ('unavailable' as const),
          part: source ? part(`artifact-${artifact.id}`, source) : null,
          dependencies: artifact.dependencies.filter((id) => copiedScope.allowedArtifacts.includes(id)),
          lifecycle: available ? artifact.lifecycle : [],
        };
      });
    const documents: AuthoringView['documents'] = index.documents
      .filter((d) => copiedScope.allowedDocuments.includes(d.id))
      .map((doc) => {
        const status = doc.members.some((m) => !artifacts.some((a) => a.id === m.artifact && a.status === 'resolved'))
          ? ('unavailable' as const)
          : ('resolved' as const);
        return {
          id: doc.id,
          status,
          proof: metadataDigest({ id: doc.id, status, ...(status === 'resolved' ? { doc } : {}) }),
        };
      });
    const expectedKeys = [...new Set(copiedScope.allowedRegistrations)].sort(),
      keys = guides.map((g) => g.word).sort();
    const scopeDigest = metadataDigest({
      visible: [...visible].sort(),
      systems: [...copiedScope.allowedSystems].sort(),
      words: [...copiedScope.allowedRegistrations].sort(),
      resources: [...permitted].sort(),
      artifacts: [...copiedScope.allowedArtifacts].sort(),
      documents: [...copiedScope.allowedDocuments].sort(),
    });
    const body = {
      format: 'ia.authoring-view.v1' as const,
      captureRevision: capture.revision,
      resourceDigest: resources.digest,
      indexDigest: index.digest,
      viewRevision: snapshot.revision,
      scopeDigest,
      guides,
      systems,
      artifacts,
      documents,
      catalogue: {
        expectedKeys,
        keys,
        complete: JSON.stringify(expectedKeys) === JSON.stringify(keys),
        digest: metadataDigest({ scopeDigest, keys, guides: guides.map((g) => g.proof) }),
      },
    };
    const view = frozen({ ...body, proof: metadataDigest(body) });
    states.set(view, state);
    return view;
  } catch (error) {
    context.reader.close();
    throw error;
  }
}

export function prepareAuthoringTarget(view: AuthoringView, request: AuthoringTargetRequest): AuthoringRequirements {
  request = authoringRequest(request);
  const state = states.get(view) ?? scopeFailure();
  if (state.scope.reader.snapshot({ within: state.scope.within }).revision !== view.viewRevision)
    throw new AuthoringError('Authoring scope changed', 'IA-AUTHORING-STALE');
  const parts = new Map<string, RequiredAuthoringPart>(),
    missing = new Map<string, { id: string; reason: string }>(),
    expectedOutputs: AuthoringRequirements['expectedOutputs'][number][] = [],
    criteria: AuthoringRequirements['criteria'][number][] = [];
  const add = (p: RequiredAuthoringPart) => {
      parts.set(p.id, p);
    },
    absent = (id: string, reason: string) => {
      missing.set(id, { id, reason });
    };
  const addSystem = (name: string): void => {
    const system = view.systems.find((s) => s.name === name);
    if (!system || system.status !== 'resolved') absent(`system-${name}`, 'System references unavailable');
    else system.parts.forEach(add);
  };
  const addGuide = (word: string): void => {
    const guide = view.guides.find((g) => g.word === word);
    if (!guide || guide.status !== 'resolved' || !guide.document || !guide.schema) {
      absent(`guide-${word}`, 'Primary guide unavailable');
      return;
    }
    add(
      part(`resource-${metadataDigest(guide.document.key)}`, {
        text: guide.document.content,
        citation: guide.document.citation,
      }),
    );
    add(part(`native-${metadataDigest(guide.schema)}`, nativePart(state.context, guide.schema)));
    // Built-in floor registrations belong to the verified taxonomy bootstrap, not a synthetic floor system.
    addSystem(guide.owner === 'floor' ? 'taxonomy' : guide.owner);
  };
  const visited = new Set<string>();
  const addArtifact = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const artifact = view.artifacts.find((a) => a.id === id);
    if (!artifact || artifact.status !== 'resolved' || !artifact.part) {
      absent(`artifact-${id}`, 'Required artifact unavailable');
      return;
    }
    artifact.dependencies.forEach(addArtifact);
    add(artifact.part);
    const contract = state.index.artifacts.find((a) => a.id === id)!.contract;
    if (contract) {
      const source = state.resources.has(keyOf(contract)) ? resourcePart(state.context, contract) : null;
      if (!source) absent(`artifact-${id}-contract`, 'Required artifact contract unavailable');
      else add(part(`resource-${metadataDigest(contract)}`, source));
    }
  };
  const target = request.target;
  let documentId = request.document;
  if ('kind' in target) {
    if (target.kind === 'word') {
      if (!state.scope.allowedRegistrations.includes(target.word)) scopeFailure();
      addGuide(target.word);
    } else if (target.kind === 'system') {
      if (!state.scope.allowedSystems.includes(target.name)) scopeFailure();
      addSystem(target.name);
    } else if (target.kind === 'artifact') {
      if (!state.scope.allowedArtifacts.includes(target.id)) scopeFailure();
      addArtifact(target.id);
    } else {
      if (documentId !== null && documentId !== target.id) scopeFailure();
      documentId = target.id;
    }
  } else {
    if (!nativeAllowed(state, target)) scopeFailure();
    const native = nativePart(state.context, target);
    add(part(`native-${metadataDigest(target)}`, native));
    addGuide(native.node.discriminator);
  }
  if (documentId !== null) {
    if (!state.scope.allowedDocuments.includes(documentId)) scopeFailure();
    const viewDocument = view.documents.find((d) => d.id === documentId),
      document = state.index.documents.find((d) => d.id === documentId);
    if (!viewDocument || !document || viewDocument.status !== 'resolved')
      absent(`document-${documentId}`, 'Document membership unavailable');
    else {
      const profile = state.index.profiles.find(
        (p) => p.id === document.profile.id && p.version === document.profile.version,
      )!;
      for (const role of profile.roles) {
        const members = document.members.filter((m) => m.role === role.id);
        if (members.length < role.min) {
          const reason = document.gaps.find((g) => g.role === role.id)?.reason ?? 'Profile role is not yet supplied';
          if (role.context === 'expected-output') expectedOutputs.push({ role: role.id, reason });
          else if (role.context === 'required-input') absent(`role-${role.id}`, reason);
        }
        if (role.context === 'required-input') members.forEach((m) => addArtifact(m.artifact));
        if (role.contract && role.context === 'required-input') {
          const p = state.resources.has(keyOf(role.contract)) ? resourcePart(state.context, role.contract) : null;
          if (!p) absent(`role-${role.id}-contract`, 'Required role contract unavailable');
          else add(part(`resource-${metadataDigest(role.contract)}`, p));
        }
      }
      criteria.push(
        ...profile.criteria.map((c) => ({
          id: c.id,
          version: c.version,
          basis: c.basis,
          status: 'not-evaluated' as const,
        })),
      );
    }
  }
  if (request.lifecycle) {
    const selection = request.lifecycle,
      model = state.index.lifecycles.find((m) => m.id === selection.model && m.version === selection.version);
    const document =
      documentId === null
        ? undefined
        : state.index.documents.find(
            (d) => d.id === documentId && view.documents.some((v) => v.id === d.id && v.status === 'resolved'),
          );
    const selectedArtifacts = document
      ? document.members.map((m) => m.artifact)
      : 'kind' in target && target.kind === 'artifact'
        ? [target.id]
        : 'kind' in target
          ? []
          : state.index.artifacts
              .filter((a) => a.source.kind === 'native' && occurrenceOf(a.source.occurrence) === occurrenceOf(target))
              .map((a) => a.id);
    const matches = (id: string): boolean =>
      !!view.artifacts
        .find((a) => a.id === id && a.status === 'resolved')
        ?.lifecycle.some(
          (c) =>
            c.model === selection.model &&
            c.version === selection.version &&
            c.workflow === selection.workflow &&
            c.iteration === selection.iteration &&
            c.stage === selection.stage &&
            c.phase === selection.phase &&
            c.primitive === selection.primitive,
        );
    if (!model || !model.stages.includes(selection.stage) || !selectedArtifacts.some(matches))
      absent('lifecycle', 'Lifecycle selection unavailable');
    else {
      const profile =
        document &&
        state.index.profiles.find((p) => p.id === document.profile.id && p.version === document.profile.version)!;
      for (const transition of model.transitions.filter((t) => t.from === selection.stage)) {
        for (const role of transition.inputs) {
          const members = document?.members.filter((m) => m.role === role && matches(m.artifact)) ?? [];
          const required = Math.max(1, profile?.roles.find((r) => r.id === role)?.min ?? 1);
          if (members.length < required) absent(`lifecycle-input-${role}`, 'Exact lifecycle input role is unavailable');
          members.forEach((m) => addArtifact(m.artifact));
        }
        for (const role of transition.outputs)
          if (!document?.members.some((m) => m.role === role) && !expectedOutputs.some((o) => o.role === role))
            expectedOutputs.push({
              role,
              reason:
                document?.gaps.find((g) => g.role === role)?.reason ??
                'Expected lifecycle output has not yet been authored',
            });
        criteria.push(
          ...transition.criteria.map((c) => ({
            id: c.id,
            version: c.version,
            basis: c.basis,
            status: 'not-evaluated' as const,
          })),
        );
      }
    }
  }
  const body = { parts: [...parts.values()], missing: [...missing.values()], expectedOutputs, criteria };
  return frozen({ ...body, proof: metadataDigest({ view: view.proof, request, body }) });
}

export interface AuthoringCataloguePage {
  readonly viewProof: string;
  readonly start: number;
  readonly limit: number;
  readonly items: readonly PrimaryGuide[];
  readonly next: string | null;
  readonly digest: string;
}
function current(view: AuthoringView): State {
  const state = states.get(view) ?? scopeFailure();
  if (state.scope.reader.snapshot({ within: state.scope.within }).revision !== view.viewRevision)
    throw new AuthoringError('Authoring scope changed', 'IA-AUTHORING-STALE');
  return state;
}
/** Exact admitted schema bytes for the already authorized catalogue, with one live-scope assertion. */
export function authoringSchemaParts(
  view: AuthoringView,
): readonly { readonly key: string; readonly part: RequiredAuthoringPart }[] {
  const state = current(view);
  return frozen(
    view.guides.flatMap((guide) =>
      guide.status === 'resolved' && guide.schema && nativeAllowed(state, guide.schema)
        ? [
            {
              key: guide.key,
              part: part(`native-${metadataDigest(guide.schema)}`, nativePart(state.context, guide.schema)),
            },
          ]
        : [],
    ),
  );
}
/** Pages bind exact scoped rows; a cursor carries no new authority. */
export function pageAuthoringCatalogue(
  view: AuthoringView,
  request: { readonly cursor: string | null; readonly limit: number },
): AuthoringCataloguePage {
  current(view);
  const input = object(request, ['cursor', 'limit']),
    limit = integer(input['limit'], 200, 1);
  let start = 0;
  if (input['cursor'] !== null) {
    if (typeof input['cursor'] !== 'string') invalidAuthoring('Invalid catalogue cursor');
    const match = /^([a-f0-9]{64})\.([0-9]+)$/.exec(input['cursor']);
    if (!match || match[1] !== view.catalogue.digest)
      throw new AuthoringError('Catalogue cursor belongs to another view', 'IA-AUTHORING-STALE');
    start = Number(match[2]);
    integer(start, view.guides.length);
  }
  const items = view.guides.slice(start, start + limit),
    end = start + items.length;
  const body = {
    viewProof: view.proof,
    start,
    limit,
    items,
    next: end < view.guides.length ? `${view.catalogue.digest}.${end}` : null,
  };
  if (Buffer.byteLength(JSON.stringify(body)) > AUTHORING_LIMITS.metadataBytes)
    invalidAuthoring('Catalogue page exceeds its byte ceiling; request fewer rows');
  return frozen({ ...body, digest: metadataDigest(body) });
}
export function reconcileAuthoringCatalogue(
  view: AuthoringView,
  values: readonly AuthoringCataloguePage[],
): {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly duplicates: readonly string[];
  readonly proof: string;
} {
  current(view);
  const pages = list(values, AUTHORING_LIMITS.artifacts),
    keys: string[] = [];
  let next = 0,
    contiguous = true,
    terminal = false;
  for (const input of pages) {
    const row = object(input, ['viewProof', 'start', 'limit', 'items', 'next', 'digest']);
    const start = integer(row['start'], view.guides.length),
      limit = integer(row['limit'], 200, 1);
    const expected = pageAuthoringCatalogue(view, {
      cursor: start === 0 ? null : `${view.catalogue.digest}.${start}`,
      limit,
    });
    if (metadataDigest(input) !== metadataDigest(expected))
      invalidAuthoring('Catalogue page differs from the exact current rows');
    if (start !== next) contiguous = false;
    next = start + expected.items.length;
    terminal = expected.next === null;
    keys.push(...expected.items.map((g) => g.word));
  }
  const missing = view.catalogue.expectedKeys.filter((key) => !keys.includes(key)),
    duplicates = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))].sort();
  const body = {
    complete:
      view.catalogue.complete && pages.length > 0 && contiguous && terminal && !missing.length && !duplicates.length,
    missing,
    duplicates,
  };
  return frozen({
    ...body,
    proof: metadataDigest({ view: view.proof, pages: pages.map((p) => (p as AuthoringCataloguePage).digest), body }),
  });
}
/** Mechanical minting readiness over explicitly disclosed baseline/candidate views; no publication effect. */
export function assessAuthoringMinting(
  baseline: AuthoringView,
  candidate: AuthoringView,
): {
  readonly ready: boolean;
  readonly changed: readonly {
    readonly key: string;
    readonly change: 'added' | 'changed' | 'removed';
    readonly status: PrimaryGuide['status'];
  }[];
  readonly legacyMissing: readonly string[];
  readonly proof: string;
} {
  const before = current(baseline),
    after = current(candidate);
  if (before.context.capture.id !== after.context.capture.id) scopeFailure();
  const complete = (view: AuthoringView, state: State): boolean =>
    state.scope.reader.isCompleteScope(state.scope.within) &&
    view.catalogue.complete &&
    view.guides.length === state.context.reader.inspect().graph.registry.registrations.size &&
    !state.context.reader.refused.length &&
    !state.context.reader.inspect().blockedSystems.length &&
    !state.context.reader.report.findings.some((finding) => finding.severity === 'error');
  const old = new Map(baseline.guides.map((g) => [g.key, g])),
    fresh = new Map(candidate.guides.map((g) => [g.key, g]));
  const changed: { key: string; change: 'added' | 'changed' | 'removed'; status: PrimaryGuide['status'] }[] = [];
  for (const row of candidate.guides) {
    const previous = old.get(row.key);
    if (!previous || previous.proof !== row.proof)
      changed.push({ key: row.key, change: previous ? 'changed' : 'added', status: row.status });
  }
  for (const row of baseline.guides)
    if (!fresh.has(row.key)) changed.push({ key: row.key, change: 'removed', status: 'missing' });
  const legacyMissing = candidate.guides
    .filter((g) => g.status !== 'resolved' && !changed.some((r) => r.key === g.key))
    .map((g) => g.key);
  const body = {
    ready:
      complete(baseline, before) &&
      complete(candidate, after) &&
      changed.every((g) => g.change !== 'removed' && g.status === 'resolved'),
    changed,
    legacyMissing,
  };
  return frozen({
    ...body,
    proof: metadataDigest({
      criterion: 'minting-readiness-v1',
      baseline: baseline.proof,
      candidate: candidate.proof,
      body,
    }),
  });
}
