import { systemMember } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import { canonical, digest, SessionError } from '@inventarch/session-system';
import { selectors } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { verifyCapture } from '@inventarch/workspace-runtime/corpus';
import type { Capture } from '@inventarch/workspace-runtime/corpus';
import {
  closeAuthoringView,
  createAuthoringIndex,
  prepareAuthoringTarget,
  resolveAuthoring,
  verifyAuthoringIndex,
} from '@inventarch/workspace-runtime/authoring';
import type {
  AuthoringIndexInput,
  AuthoringView,
  CapturedAuthoringIndex,
} from '@inventarch/workspace-runtime/authoring-types';
import type { CapturedAuthoringManifest } from '@inventarch/workspace-runtime/authoring-manifest';
import { resourceOccurrences, verifyResources } from '@inventarch/workspace-runtime/resources';
import type { CapturedResources } from '@inventarch/workspace-runtime/resource-format';
import { frozen, hash, metadataDigest, sha256, ResourceError } from '@inventarch/workspace-runtime/resource-format';
import { nativeResourcePath } from '@inventarch/workspace-runtime/resource-sources';
import { installedImplementationDigest } from './installed-catalog.js';
import {
  TASK_CAPTURE_BYTES,
  TASK_CAPTURE_POLICY,
  taskCaptureRequest,
} from '@inventarch/workspace-runtime/task-capture-format';
import type { TaskCaptureRequest } from '@inventarch/workspace-runtime/task-capture-format';
import { taskContextDeclaration } from './task-context-declaration.js';
import type { TaskContextDeclaration } from './task-context-declaration.js';
import { taskTeachingClosure } from './task-teaching-closure.js';
import { occurrenceOf } from '@inventarch/workspace-runtime/resource-format';
export type { TaskContextDeclaration } from './task-context-declaration.js';
export {
  TASK_CAPTURE_BYTES,
  TASK_CAPTURE_POLICY,
  taskCaptureRequest,
} from '@inventarch/workspace-runtime/task-capture-format';
export type { TaskCaptureRequest, TaskCaptureSelection } from '@inventarch/workspace-runtime/task-capture-format';

/** A trusted host supplies the complete authorized snapshot and a current-state check.
 * Neither this callback nor the full view is accepted from a remote capture request. */
export interface TaskCaptureFullView extends CapturedAuthoringManifest {
  readonly capture: Capture;
  assertCurrent(): void;
  /** Select a reviewed current declaration from host authority, never remote input. */
  resolveTaskContext?(request: TaskCaptureRequest): TaskContextDeclaration;
}
export interface PreparedTaskCapture extends CapturedAuthoringManifest {
  readonly capture: Capture;
  readonly disclosure: {
    readonly scope: 'task';
    readonly fullRevision: string;
    readonly selectedRevision: string;
    readonly declaration: TaskContextDeclaration;
    readonly bytes: number;
    readonly limit: number;
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly reasons: readonly string[];
    }[];
    readonly omitted: readonly { readonly path: string; readonly sha256: string; readonly reason: string }[];
    readonly resources: readonly {
      readonly source: string;
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
    readonly required: readonly string[];
    readonly proof: string;
  };
}
export class TaskCaptureError extends SessionError {
  constructor(
    readonly reason: 'incomplete' | 'stale' | 'overflow' | 'scope' | 'implementation',
    message: string,
    readonly evidence: Readonly<Record<string, string | number>> = {},
  ) {
    super('IA-TASK-CAPTURE-' + reason.toUpperCase(), message);
    this.name = 'TaskCaptureError';
  }
}
function fail(
  reason: TaskCaptureError['reason'],
  message: string,
  evidence?: Readonly<Record<string, string | number>>,
): never {
  throw new TaskCaptureError(reason, message, evidence);
}
const workWords = new Set(['task', 'decision', 'milestone', 'plan', 'spec']);
const work = (node: Node | undefined): boolean =>
  !!node &&
  node.identity.split('/')[0] === 'work-system' &&
  node.kind === 'definition' &&
  workWords.has(node.discriminator);
const status = (node: Node): string | undefined => {
  const fields = node.sections
    .filter((s) => s.name === 'work')
    .flatMap((s) => s.fields)
    .filter((f) => 'key' in f && f.key === 'status');
  const value = fields.length === 1 && fields[0] && 'value' in fields[0] ? fields[0].value : undefined;
  return value && 'text' in value ? value.text : undefined;
};
const snapshot = (capture: Capture): EditorSnapshot =>
  new EditorSnapshot({
    root: '.',
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
function admitted(reader: EditorSnapshot): void {
  if (
    reader.refused.length ||
    reader.inspect().blockedSystems.length ||
    reader.report.findings.some((f) => f.severity === 'error')
  )
    fail('incomplete', 'The full or selected source view is not completely admitted', {
      refused: reader.refused.length,
      blockedSystems: reader.inspect().blockedSystems.length,
      missingCoverage: [
        ...new Set(
          reader.report.findings
            .filter((f) => f.code === 'IA-COMP-COVERAGE-MISSING' || f.code === 'IA-COMP-COVERAGE-KIND')
            .map((f) => f.identity),
        ),
      ]
        .join(',')
        .slice(0, 8192),
      diagnostics: reader.report.findings
        .filter((f) => f.severity === 'error')
        .slice(0, 8)
        .map((f) => f.code + ': ' + f.message)
        .join('; ')
        .slice(0, 4096),
    });
}
export function taskTeachingDigest(resources: CapturedResources, index: CapturedAuthoringIndex): string {
  const authoring = {
    systems: index.systems,
    artifacts: index.artifacts.map(({ revision: _revision, ...a }) => a),
    profiles: index.profiles,
    documents: index.documents.map((d) => ({ ...d, members: d.members.map(({ revision: _revision, ...m }) => m) })),
    lifecycles: index.lifecycles,
  };
  const body = {
    files: resources.files.map(({ content: _content, ...f }) => f),
    associations: resources.associations,
    authoring,
  };
  return digest(
    JSON.parse(
      JSON.stringify(body, (key, value: unknown) =>
        key === 'revision' && value === resources.nativeCaptureRevision ? 'selected-native-view' : value,
      ),
    ),
  );
}
function authoring(
  capture: Capture,
  resources: CapturedResources,
  index: CapturedAuthoringIndex,
  reader: EditorSnapshot,
): AuthoringView {
  const registry = reader.inspect().graph.registry;
  return resolveAuthoring(capture, resources, index, {
    reader,
    within: reader.resolveScope().token,
    allowedResources: resources.files.map((f) => f.key),
    allowedSystems: [...registry.systems.keys(), 'floor'],
    allowedRegistrations: [...new Set([...registry.registrations.keys(), ...registry.blocked])],
    allowedArtifacts: index.artifacts.map((a) => a.id),
    allowedDocuments: index.documents.map((d) => d.id),
  });
}
/** Retain exact files and all explicit teaching assets; rebind their native snapshot pins without changing content. */
function rebind(
  full: Capture,
  selected: Capture,
  resources: CapturedResources,
  index: CapturedAuthoringIndex,
): CapturedAuthoringManifest {
  const remap = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, value: unknown) =>
        key === 'revision' && value === full.revision ? selected.revision : value,
      ),
    ) as T;
  const resourceBody = {
    format: resources.format,
    sourceRevisions: resourceOccurrences(selected).sourceRevisions,
    nativeCaptureRevision: selected.revision,
    files: remap(resources.files),
    associations: remap(resources.associations),
  };
  const rebound = verifyResources({ ...resourceBody, digest: metadataDigest(resourceBody) }, selected);
  const input: AuthoringIndexInput = remap({
    systems: index.systems,
    artifacts: index.artifacts.map(({ revision: _revision, ...a }) => a),
    profiles: index.profiles,
    documents: index.documents.map((d) => ({ ...d, members: d.members.map(({ revision: _revision, ...m }) => m) })),
    lifecycles: index.lifecycles,
  });
  return { resources: rebound, index: createAuthoringIndex(selected, rebound, input) };
}
/** Pure selection over a trusted full native/resource view. No filesystem discovery or disclosure occurs here. */
export function prepareTaskCapture(
  full: TaskCaptureFullView,
  input: TaskCaptureRequest,
  options: { readonly maxBytes?: number; readonly implementation?: string } = {},
): PreparedTaskCapture {
  const request = taskCaptureRequest(input),
    maxBytes = options.maxBytes ?? TASK_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TASK_CAPTURE_BYTES)
    fail('scope', 'Task capture cannot widen the published byte bound');
  const assertCurrent = (): void => {
    try {
      full.assertCurrent();
    } catch (error) {
      if (error instanceof ResourceError)
        fail('stale', 'Trusted source or required teaching changed; prepare a fresh task capture');
      throw error;
    }
  };
  assertCurrent();
  const capture = verifyCapture(full.capture);
  if (capture.selection)
    fail('incomplete', 'Task selection requires a trusted full view, not a previously selected capture');
  const resources = verifyResources(full.resources, capture),
    index = verifyAuthoringIndex(full.index, capture, resources);
  const implementation = hash(options.implementation ?? installedImplementationDigest());
  const reader = snapshot(capture);
  let view: AuthoringView | undefined,
    selectedView: AuthoringView | undefined,
    selectedReader: EditorSnapshot | undefined;
  try {
    admitted(reader);
    const inventory = resourceOccurrences(capture).occurrences;
    const graph = reader.inspect().graph,
      target = graph.nodes.get(request.target);
    if (!target || target.identity.split('/')[0] !== 'work-system' || !workWords.has(target.discriminator))
      fail('scope', 'An exact admitted work-system task, decision, milestone, plan or spec is required');
    if (graph.dangling.length || graph.ties.length)
      fail('incomplete', 'Unresolved or ambiguous native relationships prevent complete task selection');
    if (!full.resolveTaskContext) fail('incomplete', 'A trusted reviewed task context declaration is required');
    const declaration = taskContextDeclaration(full.resolveTaskContext(request)),
      declarationPin = digest(declaration);
    if (
      declaration.task.identity !== request.target ||
      declaration.coordinate.phase !== request.phase ||
      declaration.coordinate.primitive !== request.primitive
    )
      fail('scope', 'Reviewed declaration differs from the requested target or coordinate');
    const exact = (o: typeof declaration.task): Node => {
      const node = graph.nodes.get(o.identity);
      if (
        !inventory.some((v) => occurrenceOf(v) === occurrenceOf(o)) ||
        !node ||
        node.source.path !== nativeResourcePath(capture, o) ||
        node.source.line !== o.line
      )
        fail('incomplete', 'Task declaration occurrence is stale or not the winning record');
      return node;
    };
    exact(declaration.task);
    const basis = exact(declaration.basis);
    if (
      !work(basis) ||
      basis.discriminator !== 'decision' ||
      status(basis) !== 'made' ||
      !graph.edges.some(
        (e) => e.predicate === 'ground' && e.from === basis.identity && e.to === request.target && !e.condition,
      ) ||
      graph.edges.some((e) => e.predicate === 'supersede' && e.to === basis.identity)
    )
      fail('incomplete', 'Task declaration requires a current made grounding decision');
    const declaredNative = new Set(
      declaration.authoring.flatMap((r) => ('kind' in r.target ? [] : [occurrenceOf(r.target)])),
    );
    if (!declaredNative.has(occurrenceOf(declaration.task)))
      fail('incomplete', 'Explicit authoring coverage for the task is required');
    for (const r of declaration.authoring) if (!('kind' in r.target)) exact(r.target);
    const retained = new Map<string, Set<string>>(),
      files = new Map<string, Set<string>>();
    const add = (identity: string, reason: string): boolean => {
      if (!graph.nodes.has(identity)) fail('incomplete', 'Required identity is unavailable');
      const reasons = retained.get(identity);
      if (reasons) {
        reasons.add(reason);
        return false;
      }
      retained.set(identity, new Set([reason]));
      return true;
    };
    const addFile = (path: string, reason: string): boolean => {
      if (!capture.sources.some((s) => s.path === path)) fail('incomplete', 'Required source file is unavailable');
      const reasons = files.get(path);
      if (reasons) {
        reasons.add(reason);
        return false;
      }
      files.set(path, new Set([reason]));
      return true;
    };
    add(request.target, 'explicit task target');
    add(basis.identity, 'reviewed declaration basis');
    const vector = resourceOccurrences(capture).sourceRevisions;
    for (const affected of declaration.affectedSources) {
      const revision = vector.find((s) => s.source === affected.source)?.revision;
      if (!revision) fail('incomplete', 'Declared affected source is not in the trusted view');
      const path = nativeResourcePath(capture, { ...affected, revision });
      addFile(path, 'declared affected native source');
      for (const o of inventory.filter((o) => nativeResourcePath(capture, o) === path)) {
        const winner = graph.nodes.get(o.identity);
        if (winner?.source.path === path && winner.source.line === o.line && !declaredNative.has(occurrenceOf(o)))
          fail('incomplete', 'Affected native source lacks explicit authoring coverage');
      }
    }
    view = authoring(capture, resources, index, reader);
    const teaching = taskTeachingClosure(capture, resources, index, graph, view, add, (message) =>
      fail('incomplete', message),
    );
    for (const r of declaration.authoring) teaching.require(r);
    for (const key of declaration.requiredResources) teaching.resource(key);
    for (const node of graph.nodes.values())
      if (node.kind === 'governance' && selectors(node, declaration.coordinate).status !== 'disqualified') {
        add(node.identity, 'global or coordinate-applicable governance');
        teaching.require({ target: { kind: 'word', word: node.discriminator }, document: null, lifecycle: null });
      }
    for (const source of capture.sources)
      if (
        source.location.placement.kind === 'floor' ||
        !graph.occurrences.some((o) => o.node.source.path === source.path)
      )
        addFile(
          source.path,
          source.location.placement.kind === 'floor' ? 'complete native floor' : 'preserve unclassified source bytes',
        );
    const incoming = new Set(['govern', 'constrain', 'forbid', 'enforce', 'supersede']),
      processed = new Set<string>();
    let changed = true;
    while (changed) {
      const before = retained.size + files.size;
      for (const edge of graph.edges) {
        if (!edge.from || !edge.to) fail('incomplete', 'Unknown relationship endpoint');
        if (retained.has(edge.from)) add(edge.to, 'outgoing relationship dependency');
        if (edge.assertions.some((assertion) => retained.has(assertion.author))) {
          add(edge.from, 'whole-file authored relationship endpoint');
          add(edge.to, 'whole-file authored relationship endpoint');
        }
        if (
          retained.has(edge.to) &&
          (incoming.has(edge.predicate) ||
            (edge.predicate === 'ground' && graph.nodes.get(edge.from)?.discriminator === 'decision'))
        ) {
          if (edge.predicate === 'ground' && status(graph.nodes.get(edge.from)!) !== 'made')
            fail('incomplete', 'A non-made decision cannot ground complete task context');
          add(edge.from, 'incoming obligation or currentness relationship');
        }
      }
      for (const ref of graph.references)
        if (retained.has(ref.from)) add(ref.to, 'outgoing typed reference including parent');
      for (const identity of [...retained.keys()]) {
        const node = graph.nodes.get(identity)!;
        if (graph.edges.filter((e) => e.predicate === 'supersede' && e.to === identity).length > 1)
          fail('incomplete', 'Ambiguous supersession prevents current task context');
        for (const o of graph.occurrences)
          if (o.node.identity === identity) addFile(o.node.source.path, 'exact native resolution occurrences');
        if (!processed.has(identity)) {
          processed.add(identity);
          teaching.retainNode(node);
        }
      }
      for (const source of capture.sources) {
        const occurrences = graph.occurrences.filter((o) => o.node.source.path === source.path);
        if (!files.has(source.path) && !occurrences.some((o) => retained.has(o.node.identity))) continue;
        addFile(source.path, 'whole-file native context');
        for (const o of occurrences)
          if (graph.nodes.has(o.node.identity)) {
            for (const reason of retained.get(o.node.identity) ?? []) files.get(source.path)!.add(reason);
            add(o.node.identity, 'whole-file co-location');
          }
      }
      changed = retained.size + files.size !== before;
    }
    for (const identity of retained.keys()) {
      const visiting = new Set<string>();
      let current: string | undefined = identity;
      while (current) {
        if (visiting.has(current)) fail('incomplete', 'Cyclic supersession prevents current task context');
        visiting.add(current);
        current = graph.edges.find((e) => e.predicate === 'supersede' && e.to === current)?.from ?? undefined;
      }
    }
    const required = teaching.requirements(),
      selectedTeaching = teaching.finish();
    const selectedFiles = capture.sources.filter((s) => files.has(s.path));
    const omitted = capture.sources
      .filter((s) => !files.has(s.path))
      .map((s) => ({
        path: s.path,
        sha256: sha256(s.text),
        reason: 'outside declared subjects, applicable governance, required teaching and whole-file dependency closure',
      }));
    const requiredIds = [...retained.keys()].sort();
    const proof = digest({
      fullRevision: capture.revision,
      resources: resources.digest,
      index: index.digest,
      request,
      declaration: declarationPin,
      policy: TASK_CAPTURE_POLICY,
      implementation,
      files: selectedFiles.map((s) => ({ path: s.path, sha256: sha256(s.text) })),
      omitted,
      required: requiredIds,
      requirements: required.map((r) => r.requirements.proof),
      selectedResources: selectedTeaching.resources.digest,
      selectedIndex: selectedTeaching.index.digest,
    });
    const { revision: _revision, ...body } = capture;
    const selectedBody = {
      ...body,
      version: 2 as const,
      sources: selectedFiles,
      folders: capture.folders.filter((name) =>
        selectedFiles.some((source) => systemMember(source.path)?.name === name),
      ),
      selection: {
        format: 'ia.task-capture-selection.v1' as const,
        request,
        policy: TASK_CAPTURE_POLICY,
        implementation,
        fullRevision: capture.revision,
        resources: resources.digest,
        index: index.digest,
        declaration: declarationPin,
        teaching: taskTeachingDigest(selectedTeaching.resources, selectedTeaching.index),
        proof,
      },
    };
    const selected = verifyCapture({ ...selectedBody, revision: digest(selectedBody) });
    const bytes = Buffer.byteLength(canonical(selected));
    if (bytes > maxBytes)
      fail('overflow', 'Complete required task capture exceeds the preserved byte limit', {
        requiredBytes: bytes,
        limit: maxBytes,
        fullBytes: Buffer.byteLength(canonical(capture)),
        omittedFiles: omitted.length,
        proof,
      });
    selectedReader = snapshot(selected);
    admitted(selectedReader);
    const selectedGraph = selectedReader.inspect().graph;
    for (const identity of requiredIds)
      if (canonical(selectedGraph.nodes.get(identity)) !== canonical(graph.nodes.get(identity)))
        fail('incomplete', 'Selected source changes required resolution or governance');
    if (selectedGraph.dangling.length || selectedGraph.ties.length)
      fail('incomplete', 'Selected source changes relationship completeness');
    const rebound = rebind(capture, selected, selectedTeaching.resources, selectedTeaching.index);
    selectedView = authoring(selected, rebound.resources, rebound.index, selectedReader);
    for (const { request: requiredRequest } of required) {
      const remapped = JSON.parse(
        JSON.stringify(requiredRequest, (key, value: unknown) =>
          key === 'revision' && value === capture.revision ? selected.revision : value,
        ),
      );
      if (prepareAuthoringTarget(selectedView, remapped).missing.length)
        fail('incomplete', 'Selection loses required teaching');
    }
    if (digest(taskContextDeclaration(full.resolveTaskContext(request))) !== declarationPin)
      fail('stale', 'Reviewed task declaration changed during preparation');
    assertCurrent();
    return frozen({
      capture: selected,
      ...rebound,
      disclosure: {
        scope: 'task',
        fullRevision: capture.revision,
        selectedRevision: selected.revision,
        declaration,
        bytes,
        limit: maxBytes,
        files: selectedFiles.map((s) => ({
          path: s.path,
          bytes: Buffer.byteLength(s.text),
          sha256: sha256(s.text),
          reasons: [...files.get(s.path)!].sort(),
        })),
        omitted,
        resources: selectedTeaching.resources.files.map((f) => ({
          source: f.key.source,
          path: f.key.path,
          bytes: f.bytes,
          sha256: f.sha256,
        })),
        required: requiredIds,
        proof,
      },
    });
  } finally {
    if (view) closeAuthoringView(view);
    if (selectedView) closeAuthoringView(selectedView);
    selectedReader?.close();
    reader.close();
  }
}
/** A serialized proof alone is not trusted. The receiver supplies its authorized full view and recomputes. */
export function verifyTaskCapture(
  input: Capture,
  full: TaskCaptureFullView,
  options: { readonly implementation?: string } = {},
): PreparedTaskCapture {
  const capture = verifyCapture(input);
  if (!capture.selection) fail('scope', 'Expected an explicitly task-scoped capture');
  if (capture.selection.policy !== TASK_CAPTURE_POLICY)
    fail(
      'scope',
      'Historical task capture policy is readable but requires a reviewed declaration for current admission',
    );
  const implementation = hash(options.implementation ?? installedImplementationDigest());
  if (capture.selection.implementation !== implementation)
    fail(
      'implementation',
      'Task capture implementation differs; client and receiver require identical selected implementation bytes',
      { preparedImplementation: capture.selection.implementation, requiredImplementation: implementation },
    );
  if (
    full.capture.revision !== capture.selection.fullRevision ||
    full.resources.digest !== capture.selection.resources ||
    full.index.digest !== capture.selection.index
  )
    fail('stale', 'Trusted full source/resource pins changed');
  const prepared = prepareTaskCapture(full, capture.selection.request, { implementation });
  if (canonical(prepared.capture) !== canonical(capture))
    fail('stale', 'Task capture differs from the trusted complete selection');
  return prepared;
}
