import { EditorSnapshot } from '@inventarch/db/editor';
import { parse } from '@inventarch/language';
import type { Node } from '@inventarch/graph';
import type { Capture } from './corpus.js';
import { verifyCapture } from './corpus.js';
import { resourceOccurrences, verifyResources } from './resources.js';
import { nativeResourcePath } from './resource-sources.js';
import { nativeCoordinate } from './resource-context.js';
import { frozen, keyOf, metadataDigest, occurrenceOf, ordered, sha256 } from './resource-format.js';
import type { CapturedResources, ResourceKey, ResourceOccurrence } from './resource-format.js';
import type {
  ArtifactInput,
  AuthoringIndexInput,
  CapturedArtifact,
  CapturedAuthoringIndex,
  CapturedDocument,
} from './authoring-types.js';
import { decodeAuthoring, indexBody, invalidAuthoring } from './authoring-format.js';

export function authoringContext(native: Capture, resourceInput: unknown) {
  const capture = verifyCapture(native),
    resources = verifyResources(resourceInput, capture);
  const reader = new EditorSnapshot({
    root: '.',
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  const inventory = resourceOccurrences(capture),
    records = reader.records({ within: reader.resolveScope().token });
  const nodes = new Map<string, Node>();
  // The first record at each native coordinate wins, as a scan in record order would.
  const byCoordinate = new Map<string, Node>();
  for (const n of records) {
    const key = nativeCoordinate(n.identity, n.source.line, n.source.path);
    if (!byCoordinate.has(key)) byCoordinate.set(key, n);
  }
  for (const row of inventory.occurrences) {
    const node = byCoordinate.get(nativeCoordinate(row.identity, row.line, nativeResourcePath(capture, row)));
    if (node) nodes.set(occurrenceOf(row), node);
  }
  return {
    capture,
    resources,
    reader,
    inventory,
    nodes,
    files: new Map(resources.files.map((f) => [keyOf(f.key), f])),
  };
}
export type AuthoringContext = ReturnType<typeof authoringContext>;
export function nativePart(
  context: AuthoringContext,
  occurrence: ResourceOccurrence,
): { text: string; citation: string; node: Node } {
  const node = context.nodes.get(occurrenceOf(occurrence)),
    source = context.capture.sources.find((s) => s.path === nativeResourcePath(context.capture, occurrence));
  if (!node || !source) invalidAuthoring('Native authoring occurrence is absent or stale');
  return {
    node,
    text: source.text
      .split('\n')
      .slice(node.source.line - 1, node.source.endLine)
      .join('\n'),
    citation: `${keyOf(occurrence)}#sha256=${sha256(source.text)}&lines=${node.source.line}-${node.source.endLine}&identity=${node.identity}`,
  };
}
export function resourcePart(
  context: AuthoringContext,
  key: ResourceKey,
  range: { start: number; end: number } | null = null,
): { text: string; citation: string } | null {
  const file = context.files.get(keyOf(key));
  if (!file) return null;
  if (file.encoding !== 'utf8') invalidAuthoring('Authoring context requires explicit UTF-8 resources');
  const lines = file.content.split('\n');
  if (range && range.end > lines.length) invalidAuthoring('Artifact source range exceeds exact captured bytes');
  return {
    text: range ? lines.slice(range.start - 1, range.end).join('\n') : file.content,
    citation: `${keyOf(key)}#sha256=${file.sha256}${range ? `&lines=${range.start}-${range.end}` : ''}`,
  };
}
function selectedKey(context: AuthoringContext, key: ResourceKey): void {
  if (!context.resources.sourceRevisions.some((s) => s.source === key.source && s.revision === key.revision))
    invalidAuthoring('Authoring resource names an unselected source revision');
}
function retainedArtifact(context: AuthoringContext, input: ArtifactInput): CapturedArtifact {
  let source;
  if (input.source.kind === 'native') source = nativePart(context, input.source.occurrence);
  else {
    selectedKey(context, input.source.key);
    source = resourcePart(context, input.source.key, input.source.range);
    if (!source) invalidAuthoring('Artifact has no retained authoritative source');
  }
  if (input.contract) selectedKey(context, input.contract);
  const contract = input.contract ? context.files.get(keyOf(input.contract)) : undefined;
  return {
    ...input,
    revision: metadataDigest({
      input,
      content: sha256(source.text),
      citation: source.citation,
      contract: contract
        ? {
            key: contract.key,
            sha256: contract.sha256,
            bytes: contract.bytes,
            encoding: contract.encoding,
            mediaType: contract.mediaType,
          }
        : null,
    }),
  };
}
function validateBase(context: AuthoringContext, base: ResourceOccurrence, systemName: string): void {
  const path = nativeResourcePath(context.capture, base),
    source = context.capture.sources.find((s) => s.path === path);
  if (
    !source ||
    source.location.placement.kind !== 'adopted' ||
    base.identity !== `floor/definition/system/${systemName}`
  )
    invalidAuthoring('System base is not a retained adopted declaration');
  const parsed = parse(source.text, path);
  if (
    parsed.diagnostics.length ||
    !parsed.ast.records.some(
      (r) => r.discriminator === 'system' && r.name.toLowerCase() === systemName && r.span.line === base.line,
    )
  )
    invalidAuthoring('System base occurrence is stale');
  selectedKey(context, base);
}
function derive(context: AuthoringContext, input: AuthoringIndexInput): CapturedAuthoringIndex {
  const registry = context.reader.inspect().graph.registry;
  for (const association of input.systems) {
    const node = nativePart(context, association.system).node,
      declaration = registry.systems.get(node.name);
    if (
      node.discriminator !== 'system' ||
      !declaration ||
      declaration.path !== node.source.path ||
      declaration.span.line !== node.source.line
    )
      invalidAuthoring('System reference does not name the winning declaration');
    if (association.steward === null) {
      if (
        node.name !== 'taxonomy' ||
        node.provenance !== 'bootstrap' ||
        node.placement.kind !== 'floor' ||
        declaration.steward !== undefined
      )
        invalidAuthoring('Only native taxonomy bootstrap may omit its steward');
    } else {
      const steward = nativePart(context, association.steward).node;
      if (
        !declaration.steward ||
        steward.discriminator !== declaration.steward.discriminator ||
        steward.name !== declaration.steward.name
      )
        invalidAuthoring('System steward differs from its declaration');
      const folder = node.source.path.slice(0, node.source.path.lastIndexOf('/') + 1);
      if (!steward.source.path.startsWith(folder)) invalidAuthoring('System steward is not local to its declaration');
    }
    for (const method of association.methods) {
      const target = nativePart(context, method).node;
      if (target.discriminator !== 'playbook') invalidAuthoring('System method is not an admitted playbook');
    }
    const selected = context.resources.associations.find(
      (a) => occurrenceOf(a.owner) === occurrenceOf(association.system),
    );
    for (const key of [...association.authoring, ...association.architecture, ...association.extensions]) {
      selectedKey(context, key);
      if (!selected?.resources.some((u) => keyOf(u.key) === keyOf(key)))
        invalidAuthoring('System reference lacks its exact captured association');
    }
    if (association.base) validateBase(context, association.base, node.name);
  }
  const artifacts = ordered(
      input.artifacts.map((a) => retainedArtifact(context, a)),
      (a) => a.id,
    ),
    byArtifact = new Map(artifacts.map((a) => [a.id, a]));
  const models = new Map(input.lifecycles.map((m) => [`${m.id}@${m.version}`, m]));
  for (const artifact of artifacts) {
    if (artifact.dependencies.some((id) => !byArtifact.has(id)))
      invalidAuthoring('Artifact dependency is absent from the captured index');
    for (const coordinate of artifact.lifecycle) {
      const model = models.get(`${coordinate.model}@${coordinate.version}`);
      if (!model || !model.stages.includes(coordinate.stage))
        invalidAuthoring('Artifact lifecycle coordinate is stale or unbound');
    }
  }
  for (const profile of input.profiles)
    for (const role of profile.roles) if (role.contract) selectedKey(context, role.contract);
  const profiles = new Map(input.profiles.map((p) => [`${p.id}@${p.version}`, p]));
  const documents: CapturedDocument[] = input.documents.map((doc) => {
    const profile = profiles.get(`${doc.profile.id}@${doc.profile.version}`);
    if (!profile) invalidAuthoring('Document profile is missing or stale');
    const roles = new Set(profile.roles.map((r) => r.id));
    if (doc.gaps.some((g) => !roles.has(g.role))) invalidAuthoring('Document gap names an undeclared role');
    const members = ordered(
      doc.members.map((m) => {
        const artifact = byArtifact.get(m.artifact);
        if (!artifact || !roles.has(m.role)) invalidAuthoring('Document member or role is unavailable');
        return { ...m, revision: artifact.revision };
      }),
      (m) => String(m.order).padStart(10, '0'),
    );
    for (const role of profile.roles)
      if (members.filter((m) => m.role === role.id).length > role.max)
        invalidAuthoring('Document exceeds profile role cardinality');
    return { ...doc, members };
  });
  for (const model of input.lifecycles) {
    const stages = new Set(model.stages),
      visiting = new Set<string>(),
      done = new Set<string>();
    for (const t of model.transitions)
      if (!stages.has(t.from) || !stages.has(t.to)) invalidAuthoring('Lifecycle transition names an undeclared stage');
    const visit = (id: string): void => {
      if (visiting.has(id)) invalidAuthoring('Impossible same-iteration lifecycle ordering');
      if (done.has(id)) return;
      visiting.add(id);
      for (const next of model.transitions.filter((t) => t.from === id && !t.feedback)) visit(next.to);
      visiting.delete(id);
      done.add(id);
    };
    for (const stage of stages) visit(stage);
  }
  const body = {
    format: 'ia.authoring-index.v1' as const,
    nativeCaptureRevision: context.capture.revision,
    resourceDigest: context.resources.digest,
    systems: ordered(input.systems, (s) => `${occurrenceOf(s.system)}:${metadataDigest(s)}`),
    artifacts,
    profiles: ordered(input.profiles, (p) => `${p.id}@${p.version}`),
    documents: ordered(documents, (d) => d.id),
    lifecycles: ordered(input.lifecycles, (m) => `${m.id}@${m.version}`),
  };
  return frozen({ ...body, digest: metadataDigest(body) });
}
export function createAuthoringIndex(
  capture: Capture,
  resources: CapturedResources,
  input: unknown,
): CapturedAuthoringIndex {
  const checked = decodeAuthoring(input, false),
    context = authoringContext(capture, resources);
  try {
    const result = derive(context, checked);
    return decodeAndFreeze(result);
  } finally {
    context.reader.close();
  }
}
function decodeAndFreeze(index: CapturedAuthoringIndex): CapturedAuthoringIndex {
  return frozen(decodeAuthoring(index, true));
}
export function verifyAuthoringIndex(
  value: unknown,
  capture: Capture,
  resources: CapturedResources,
): CapturedAuthoringIndex {
  const index = decodeAuthoring(value, true);
  if (
    metadataDigest(indexBody(index)) !== index.digest ||
    index.nativeCaptureRevision !== capture.revision ||
    index.resourceDigest !== resources.digest
  )
    invalidAuthoring('Authoring index pins or digest differ');
  const input = {
    systems: index.systems,
    artifacts: index.artifacts.map(({ revision: _revision, ...a }) => a),
    profiles: index.profiles,
    documents: index.documents.map((d) => ({ ...d, members: d.members.map(({ revision: _revision, ...m }) => m) })),
    lifecycles: index.lifecycles,
  };
  const expected = createAuthoringIndex(capture, resources, input);
  if (expected.digest !== index.digest) invalidAuthoring('Retained authoring artifact or membership proof differs');
  return expected;
}
