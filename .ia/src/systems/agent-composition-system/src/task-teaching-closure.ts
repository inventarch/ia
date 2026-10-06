import { systemMember } from '@inventarch/db';
import type { Graph, Node } from '@inventarch/graph';
import { prepareAuthoringTarget, createAuthoringIndex } from '@inventarch/workspace-runtime/authoring';
import type {
  AuthoringIndexInput,
  AuthoringTargetRequest,
  AuthoringView,
  CapturedAuthoringIndex,
  AuthoringRequirements,
} from '@inventarch/workspace-runtime/authoring-types';
import type { Capture } from '@inventarch/workspace-runtime/corpus';
import type { CapturedResources, ResourceKey, ResourceOccurrence } from '@inventarch/workspace-runtime/resource-format';
import { keyOf, metadataDigest, occurrenceOf } from '@inventarch/workspace-runtime/resource-format';
import { resourceOccurrences, verifyResources } from '@inventarch/workspace-runtime/resources';
import { nativeResourcePath } from '@inventarch/workspace-runtime/resource-sources';

/** Positive metadata closure. No source discovery, ranking, or authorization lives here. */
export function taskTeachingClosure(
  capture: Capture,
  resources: CapturedResources,
  index: CapturedAuthoringIndex,
  graph: Graph,
  view: AuthoringView,
  addNative: (identity: string, reason: string) => boolean,
  fail: (message: string) => never,
) {
  const inventory = resourceOccurrences(capture).occurrences;
  const nativeParts = new Map(inventory.map((o) => ['native-' + metadataDigest(o), o]));
  const resourceParts = new Map(resources.files.map((f) => ['resource-' + metadataDigest(f.key), f.key]));
  const resourceKeys = new Set<string>(),
    systems = new Set<string>(),
    artifacts = new Set<string>(),
    documents = new Set<string>(),
    profiles = new Set<string>(),
    models = new Set<string>();
  const checkedRequests = new Map<string, { request: AuthoringTargetRequest; requirements: AuthoringRequirements }>();
  const native = (o: ResourceOccurrence, reason: string): void => {
    if (!inventory.some((v) => occurrenceOf(v) === occurrenceOf(o))) fail('Required authoring occurrence is stale');
    addNative(o.identity, reason);
  };
  const resource = (key: ResourceKey): void => {
    if (!resources.files.some((f) => keyOf(f.key) === keyOf(key))) fail('Required authoring resource is absent');
    if (resourceKeys.has(keyOf(key))) return;
    resourceKeys.add(keyOf(key));
    const associations = resources.associations.filter((a) => a.resources.some((u) => keyOf(u.key) === keyOf(key)));
    if (!associations.length) fail('Required resource has no authoritative native association');
    for (const a of associations) native(a.owner, 'required resource owner');
  };
  const system = (name: string): void => {
    if (name === 'floor') name = 'taxonomy';
    if (systems.has(name)) return;
    const declaration = graph.registry.systems.get(name);
    const matches = index.systems.filter((s) => s.system.identity === 'floor/definition/system/' + name);
    if (!declaration || matches.length !== 1) fail('Required system teaching is unavailable: ' + name);
    const association = matches[0]!;
    systems.add(name);
    native(association.system, 'required owning system');
    for (const item of [
      ...association.methods,
      ...(association.steward ? [association.steward] : []),
      ...(association.base ? [association.base] : []),
    ])
      native(item, 'required system teaching occurrence');
    for (const key of [...association.authoring, ...association.architecture, ...association.extensions]) resource(key);
    for (const dependency of declaration.requires) system(dependency.name);
    // Retaining a declaration retains all its registrations: each needs its exact schema.
    for (const registration of graph.registry.registrations.values())
      if (registration.system === name || (name === 'taxonomy' && registration.system === 'floor')) {
        const schema = graph.registry.schemas.get(registration.schema);
        const occurrence =
          schema &&
          inventory.find((o) => nativeResourcePath(capture, o) === schema.path && o.line === schema.span.line);
        if (!occurrence) fail('Required registration schema is unavailable');
        native(occurrence, 'required registration schema');
      }
  };
  const guide = (word: string): void => {
    const row = view.guides.find((g) => g.word === word);
    if (!row || row.status !== 'resolved' || !row.descriptor || !row.schema || !row.document)
      fail('Required primary guide is unavailable: ' + word);
    native(row.descriptor, 'required primary guide descriptor');
    native(row.schema, 'required primary guide schema');
    resource(row.document.key);
    system(row.owner);
  };
  const artifact = (id: string): void => {
    if (artifacts.has(id)) return;
    const row = index.artifacts.find((a) => a.id === id);
    if (!row) fail('Required artifact is unavailable');
    artifacts.add(id);
    if (row.source.kind === 'native') native(row.source.occurrence, 'required artifact source');
    else resource(row.source.key);
    if (row.contract) resource(row.contract);
    for (const dependency of row.dependencies) artifact(dependency);
    for (const coordinate of row.lifecycle) models.add(coordinate.model + '@' + coordinate.version);
  };
  const document = (id: string): void => {
    if (documents.has(id)) return;
    const row = index.documents.find((d) => d.id === id);
    if (!row) fail('Required document is unavailable');
    documents.add(id);
    profiles.add(row.profile.id + '@' + row.profile.version);
    // Preserve complete selected document membership; omission must not fabricate gaps.
    for (const member of row.members) artifact(member.artifact);
    const profile = index.profiles.find((p) => p.id === row.profile.id && p.version === row.profile.version);
    if (!profile) fail('Required document profile is unavailable');
    for (const role of profile.roles) if (role.contract) resource(role.contract);
  };
  const require = (request: AuthoringTargetRequest): void => {
    const pin = metadataDigest(request);
    if (checkedRequests.has(pin)) return;
    const requirements = prepareAuthoringTarget(view, request);
    if (requirements.missing.length)
      fail('Required authoring coverage is unavailable: ' + requirements.missing.map((m) => m.id).join(','));
    checkedRequests.set(pin, { request, requirements });
    const target = request.target;
    if (!('kind' in target)) {
      native(target, 'declared authoring target');
      const node = graph.nodes.get(target.identity);
      if (!node) fail('Required native target is unavailable');
      guide(node.discriminator);
    } else if (target.kind === 'word') guide(target.word);
    else if (target.kind === 'system') system(target.name);
    else if (target.kind === 'artifact') artifact(target.id);
    else document(target.id);
    if (request.document !== null) document(request.document);
    if (request.lifecycle) models.add(request.lifecycle.model + '@' + request.lifecycle.version);
    for (const part of requirements.parts) {
      const o = nativeParts.get(part.id),
        key = resourceParts.get(part.id);
      if (o) native(o, 'required authoring dependency');
      else if (key) resource(key);
      else if (part.id.startsWith('artifact-')) artifact(part.id.slice('artifact-'.length));
      else fail('Unknown authoring requirement cannot be omitted');
    }
  };
  const retainNode = (node: Node): void => {
    const registration = graph.registry.registrations.get(node.discriminator);
    if (!registration) fail('Required registration is unavailable');
    system(registration.system);
    // Folder admission is independent of the discriminator's registration owner.
    for (const occurrence of graph.occurrences.filter((o) => o.node.identity === node.identity)) {
      const owner = systemMember(occurrence.node.source.path);
      if (owner) system(owner.name);
    }
    if (node.discriminator === 'system' && graph.registry.systems.has(node.name)) system(node.name);
    for (const association of resources.associations)
      if (association.owner.identity === node.identity) {
        native(association.owner, 'retained explicit resource association');
        for (const use of association.resources) {
          if (use.required || resources.files.some((f) => keyOf(f.key) === keyOf(use.key))) resource(use.key);
        }
      }
  };
  return {
    native,
    resource,
    system,
    guide,
    require,
    retainNode,
    requirements: () => [...checkedRequests.values()],
    finish: () => {
      const body = {
        format: resources.format,
        sourceRevisions: resources.sourceRevisions,
        nativeCaptureRevision: capture.revision,
        files: resources.files.filter((f) => resourceKeys.has(keyOf(f.key))),
        associations: resources.associations
          .filter((a) => a.resources.some((u) => resourceKeys.has(keyOf(u.key))))
          .map((a) => ({ ...a, resources: a.resources.filter((u) => resourceKeys.has(keyOf(u.key))) })),
      };
      const selectedResources = verifyResources({ ...body, digest: metadataDigest(body) }, capture);
      const input: AuthoringIndexInput = {
        systems: index.systems.filter((s) => systems.has(s.system.identity.split('/').at(-1)!)),
        artifacts: index.artifacts.filter((a) => artifacts.has(a.id)).map(({ revision: _revision, ...a }) => a),
        documents: index.documents
          .filter((d) => documents.has(d.id))
          .map((d) => ({ ...d, members: d.members.map(({ revision: _revision, ...m }) => m) })),
        profiles: index.profiles.filter((p) => profiles.has(p.id + '@' + p.version)),
        lifecycles: index.lifecycles.filter((m) => models.has(m.id + '@' + m.version)),
      };
      return { resources: selectedResources, index: createAuthoringIndex(capture, selectedResources, input) };
    },
  };
}
