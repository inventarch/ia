import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { canonical, digest } from '@inventarch/session-system';
import { createSourcePolicy, mountSourceCapture } from '../src/sources.js';
import { verifyCapture } from '../src/corpus.js';
import { openLocalAuthoringView } from '../src/authoring-manifest.js';
import { prepareTaskCapture, verifyTaskCapture, TASK_CAPTURE_BYTES, TaskCaptureError } from '../src/task-capture.js';
import type { TaskCaptureRequest, TaskContextDeclaration } from '../src/task-capture.js';
import { resourceOccurrences } from '../src/resources.js';
import { sha256 } from '../src/resource-format.js';

const fixture = fileURLToPath(new URL('../fixtures/task-capture.json', import.meta.url));
const areas: string[] = [];
const implementation = 'a'.repeat(64),
  options = { implementation };
const request: TaskCaptureRequest = {
  target: 'work-system/definition/task/requirement',
  phase: 'plan',
  primitive: 'Attention',
};
afterEach(() => {
  for (const root of areas.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir(), 'ia-task-capture-')))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function declaration(full: ReturnType<typeof openLocalAuthoringView>): TaskContextDeclaration {
  const occurrences = resourceOccurrences(full.capture).occurrences;
  const task = occurrences.find((o) => o.identity === request.target)!;
  const basis = occurrences.find((o) => o.identity === 'work-system/definition/decision/policy')!;
  return {
    format: 'ia.task-context-declaration.v1',
    task,
    basis,
    coordinate: { phase: request.phase, primitive: request.primitive },
    affectedSources: [{ source: task.source, path: task.path }],
    authoring: [{ target: task, document: 'brief', lifecycle: null }],
    requiredResources: [],
  };
}
function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-task-capture-'));
  areas.push(root);
  for (const file of JSON.parse(readFileSync(fixture, 'utf8')) as { path: string; content: string }[]) {
    const target = resolve(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  const raw = () =>
    openLocalAuthoringView({
      root,
      id: 'task-fixture',
      adopted: [],
      manifests: [{ source: 'self', root }],
      scope: { root: '.', identities: null },
    });
  const open = () => {
    const full = raw();
    return { ...full, resolveTaskContext: (_request: TaskCaptureRequest) => declaration(full) };
  };
  return { root, open, raw };
}
const unrelated = '.ia/src/systems/work-system/records/unrelated.ia';

it('retains exact governance, teaching and required work while disclosing a disconnected work-only omission', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    expect(prepared.capture.version).toBe(2);
    expect(prepared.capture.selection?.fullRevision).toBe(full.capture.revision);
    expect(prepared.disclosure.omitted.map((f) => f.path)).toEqual([unrelated]);
    expect(prepared.capture.sources.some((f) => f.path.endsWith('/dependency.ia'))).toBe(true);
    expect(prepared.capture.sources.some((f) => f.path.endsWith('/policy.ia'))).toBe(true);
    expect(prepared.capture.sources.filter((s) => s.location.placement.kind === 'floor')).toEqual(
      full.capture.sources.filter((s) => s.location.placement.kind === 'floor'),
    );
    expect(prepared.resources.files.map((f) => f.sha256)).toEqual(full.resources.files.map((f) => f.sha256));
    expect(verifyTaskCapture(prepared.capture, full, options)).toEqual(prepared);
    expect(JSON.stringify(prepared.capture)).not.toContain('Independent work evidence');
    expect(prepareTaskCapture(full, request, options)).toEqual(prepared);
  } finally {
    full.close();
  }
});
it('omits an incoming dependent without inventing a reverse prerequisite', () => {
  const f = setup();
  writeFileSync(
    resolve(f.root, unrelated),
    '#! ia 1.0\n@task unrelated\n  relationships\n    requires @task dependency\n',
  );
  const full = f.open();
  try {
    expect(prepareTaskCapture(full, request, options).disclosure.omitted.map((row) => row.path)).toEqual([unrelated]);
  } finally {
    full.close();
  }
});
it('retains whole files when relevant and disconnected work share a source', () => {
  const f = setup();
  writeFileSync(resolve(f.root, unrelated), '#! ia 1.0\n@task unrelated\n@task co-located\n');
  writeFileSync(
    resolve(f.root, '.ia/src/systems/work-system/records/dependency.ia'),
    '#! ia 1.0\n@task dependency\n  relationships\n    requires @task co-located\n',
  );
  const full = f.open();
  try {
    expect(prepareTaskCapture(full, request, options).disclosure.omitted).toEqual([]);
  } finally {
    full.close();
  }
});
it('refuses changed excluded source after preparation and verifies against fresh full pins', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    writeFileSync(
      resolve(f.root, unrelated),
      readFileSync(resolve(f.root, unrelated), 'utf8') + '\n# changed excluded bytes\n',
    );
    expect(() => verifyTaskCapture(prepared.capture, full, options)).toThrow(/changed/);
    const changed = f.open();
    try {
      expect(() => verifyTaskCapture(prepared.capture, changed, options)).toThrow(/pins changed/);
    } finally {
      changed.close();
    }
  } finally {
    full.close();
  }
});
it('refuses withdrawn or changed teaching rather than omitting required resources', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    writeFileSync(resolve(f.root, 'references/system.md'), '# Changed system teaching\n');
    expect(() => verifyTaskCapture(prepared.capture, full, options)).toThrow();
    expect(() => f.open()).toThrow();
  } finally {
    full.close();
  }
});
it('refuses a forged selected capture even after its outer digest is recomputed', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    const { revision: _revision, ...body } = prepared.capture;
    const changed = { ...body, sources: body.sources.filter((s) => !s.path.endsWith('/dependency.ia')) };
    expect(() => verifyTaskCapture({ ...changed, revision: digest(changed) }, full, options)).toThrow(/differs/);
    expect(() => verifyTaskCapture(prepared.capture, full, { implementation: 'b'.repeat(64) })).toThrow(/differs/);
  } finally {
    full.close();
  }
});
it('accepts the exact byte limit and refuses one byte less with retained required-size evidence', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options),
      bytes = Buffer.byteLength(canonical(prepared.capture));
    expect(prepareTaskCapture(full, request, { ...options, maxBytes: bytes }).capture).toEqual(prepared.capture);
    try {
      prepareTaskCapture(full, request, { ...options, maxBytes: bytes - 1 });
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskCaptureError);
      expect((error as TaskCaptureError).evidence).toMatchObject({ requiredBytes: bytes, limit: bytes - 1 });
    }
    expect(() => prepareTaskCapture(full, request, { ...options, maxBytes: TASK_CAPTURE_BYTES + 1 })).toThrow(/widen/);
  } finally {
    full.close();
  }
});
it('refuses complete required overflow even when an unrelated work file can be omitted', () => {
  const f = setup();
  writeFileSync(
    resolve(f.root, '.ia/src/systems/work-system/records/dependency.ia'),
    '#! ia 1.0\n@task dependency\n  meaning\n    says "' + 'é'.repeat(365000) + '"\n',
  );
  const full = f.open();
  try {
    expect(() => prepareTaskCapture(full, request, options)).toThrow(/exceeds/);
  } finally {
    full.close();
  }
});
it('refuses unknown completeness and cannot select a subset as if it were the trusted full view', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    expect(() => prepareTaskCapture({ ...prepared, assertCurrent() {} }, request, options)).toThrow(
      /trusted full view/,
    );
    const { revision: _revision, ...body } = prepared.capture;
    const legacy = { ...body, version: 1 as const };
    expect(() => verifyCapture({ ...legacy, revision: digest(legacy) })).toThrow(/version 2/);
    const { selection: _selection, ...anonymous } = body;
    expect(() => verifyCapture({ ...anonymous, revision: digest(anonymous) })).toThrow(/explicit selection/);
    expect(() =>
      prepareTaskCapture(full, { ...request, target: 'work-system/definition/task/missing' }, options),
    ).toThrow(/exact admitted|target|declaration/);
    expect(() => prepareTaskCapture(full, { ...request, phase: 'invalid' as 'plan' }, options)).toThrow(/coordinate/);
  } finally {
    full.close();
  }
});
it('refuses a dangling required relation rather than claiming a complete closure', () => {
  const f = setup();
  writeFileSync(
    resolve(f.root, '.ia/src/systems/work-system/records/dependency.ia'),
    '#! ia 1.0\n@task dependency\n  relationships\n    requires @task missing\n',
  );
  const full = f.open();
  try {
    expect(() => prepareTaskCapture(full, request, options)).toThrow(/admitted|Unresolved/);
  } finally {
    full.close();
  }
});

it('refuses source mounting that would erase task scope instead of preserving whole-corpus review semantics', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options),
      policy = createSourcePolicy(f.root, { validator: implementation });
    expect(() => mountSourceCapture(prepared.capture, full.capture, 'b'.repeat(64), policy)).toThrow(
      /new trusted full-view selection/,
    );
  } finally {
    full.close();
  }
});

function writeSource(root: string, path: string, content: string): void {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const workRecords = '.ia/src/systems/work-system/records/';
function installGovernance(root: string): void {
  const systemPath = '.ia/src/systems/governance-system/system.ia';
  writeSource(
    root,
    systemPath,
    `#! ia 1.0
@system governance-system
  provider "fixture"
  version "1.0.0"
  steward @agent governance-steward
  requires
    - taxonomy
    - agent-system
    - authoring-system
  discriminators
    law lowers to governance
      category rule
      facets [law]
      schema @schema law
  edges
    cite * using *
@schema law
  lowers to governance
  sections
    must have meaning
    must have governance
    may have relationships
    closed
  fields
    must have meaning.says as text
    must have meaning.answers as text
    must have governance.severity as id
@agent governance-steward
  governance
    applies [law]
@authoring-guide law-guide
  meaning
    says "A law records an obligation."
    answers "Which obligation governs this task?"
  reference
    owner governance-system
    word law
    schema @schema law
    document "references/law.md"
  guidance
    select-when "An obligation applies."
    avoid-when "Only a nonbinding preference exists."
    consider "Keep its applicability explicit."
  relationships
    cites @schema law
`,
  );
  const content = '# Law\nPreserve complete applicable obligations.\n',
    path = 'references/law.md',
    key = { source: 'self', path };
  writeSource(root, path, content);
  const manifestPath = resolve(root, '.ia/authoring.resources.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.push({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  });
  const owner = (identity: string) => ({ source: 'self', path: systemPath, identity });
  for (const identity of [
    'floor/definition/system/governance-system',
    'authoring-system/definition/authoring-guide/law-guide',
  ])
    manifest.associations.push({
      owner: owner(identity),
      resources: [{ key, role: 'guide', required: true, order: 0, delivery: 'inline' }],
    });
  manifest.index.systems.push({
    system: owner('floor/definition/system/governance-system'),
    authoring: [key],
    architecture: [key],
    extensions: [],
    methods: [],
    steward: owner('agent-system/definition/head/governance-steward'),
    base: null,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
}
function law(name: string, activation = ''): string {
  return `#! ia 1.0\n@law ${name}\n  meaning\n    says "Preserve ${name} obligations."\n    answers "Does ${name} apply?"\n  governance\n    severity blocking\n${activation ? '  activation\n    activate when ' + activation + '\n' : ''}`;
}

it('refuses missing host-owned declarations instead of deriving relevance from the remote request', () => {
  const f = setup(),
    full = f.raw();
  try {
    expect(() => prepareTaskCapture(full, request, options)).toThrow(/declaration|context|resolver/i);
  } finally {
    full.close();
  }
});
it('binds the reviewed declaration and refuses a changed declaration with unchanged native and resource pins', () => {
  const f = setup(),
    full = f.open();
  try {
    let current = full.resolveTaskContext(request);
    const trusted = { ...full, resolveTaskContext: () => current },
      prepared = prepareTaskCapture(trusted, request, options);
    expect(prepared.capture.selection?.declaration).toMatch(/^[a-f0-9]{64}$/);
    current = { ...current, coordinate: { ...current.coordinate, move: 'Verification' } };
    expect(() => verifyTaskCapture(prepared.capture, trusted, options)).toThrow(/declaration|differs|stale/i);
  } finally {
    full.close();
  }
});
it.each(['open', 'superseded', 'withdrawn'])(
  'refuses a %s basis even when the host supplies its exact occurrence',
  (status) => {
    const f = setup(),
      path = resolve(f.root, workRecords + 'policy.ia');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status made', 'status ' + status));
    const full = f.open();
    try {
      expect(() => prepareTaskCapture(full, request, options)).toThrow(/basis|made|decision|ground/i);
    } finally {
      full.close();
    }
  },
);
it('refuses a stale basis occurrence without trusting its unchanged identity', () => {
  const f = setup(),
    full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    const stale = { ...declared, basis: { ...declared.basis, revision: 'b'.repeat(64) } };
    expect(() => prepareTaskCapture({ ...full, resolveTaskContext: () => stale }, request, options)).toThrow(
      /basis|occurrence|revision|declaration|stale/i,
    );
  } finally {
    full.close();
  }
});
it('refuses missing exact task authoring coverage and undeclared affected-source coverage', () => {
  const f = setup(),
    full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    const withoutTask = {
      ...declared,
      authoring: [{ target: { kind: 'word' as const, word: 'task' }, document: 'brief', lifecycle: null }],
    };
    expect(() => prepareTaskCapture({ ...full, resolveTaskContext: () => withoutTask }, request, options)).toThrow(
      /coverage|authoring|target|declaration/i,
    );
    const extraSource = {
      ...declared,
      affectedSources: [
        ...declared.affectedSources,
        { source: declared.task.source, path: workRecords + 'dependency.ia' },
      ],
    };
    expect(() => prepareTaskCapture({ ...full, resolveTaskContext: () => extraSource }, request, options)).toThrow(
      /authoring coverage/i,
    );
  } finally {
    full.close();
  }
});
it('refuses coordinate contradictions and paths outside the trusted captured source', () => {
  const f = setup(),
    full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    for (const changed of [
      { ...declared, coordinate: { ...declared.coordinate, phase: 'act' } },
      { ...declared, affectedSources: [{ source: 'foreign', path: workRecords + 'requirement.ia' }] },
    ])
      expect(() => prepareTaskCapture({ ...full, resolveTaskContext: () => changed }, request, options)).toThrow(
        /coordinate|source|scope|declaration|affected/i,
      );
  } finally {
    full.close();
  }
});
it('requires the explicitly declared document input while preserving its absent future output as an obligation', () => {
  const f = setup(),
    manifestPath = resolve(f.root, '.ia/authoring.resources.json');
  const positive = f.open();
  try {
    const prepared = prepareTaskCapture(positive, request, options);
    expect(prepared.resources.files.some((file) => file.key.path === 'documents/requirement.md')).toBe(true);
    expect(prepared.index.documents.find((document) => document.id === 'brief')?.gaps).toEqual([
      { role: 'acceptance', reason: 'Expected after requirements are authored.' },
    ]);
  } finally {
    positive.close();
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.index.documents[0].members = [];
  manifest.index.documents[0].gaps.push({ role: 'requirement', reason: 'Required upstream input is missing.' });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const missing = f.open();
  try {
    expect(() => prepareTaskCapture(missing, request, options)).toThrow(/teaching|required|document|input/i);
  } finally {
    missing.close();
  }
});
it('omits unrelated resource artifacts instead of seeding the entire authoring index', () => {
  const f = setup(),
    path = 'documents/unrelated.md',
    content = 'Not a declared input or teaching dependency.\n';
  writeSource(f.root, path, content);
  const manifestPath = resolve(f.root, '.ia/authoring.resources.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.push({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  });
  manifest.associations.push({
    owner: { source: 'self', path: unrelated, identity: 'work-system/definition/task/unrelated' },
    resources: [{ key: { source: 'self', path }, role: 'support', required: false, order: 0, delivery: 'inline' }],
  });
  manifest.index.artifacts.push({
    id: 'unrelated-evidence',
    source: { kind: 'resource', key: { source: 'self', path }, range: null },
    purpose: 'Independent fixture evidence',
    contract: null,
    dependencies: [],
    lifecycle: [],
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    expect(prepared.resources.files.some((file) => file.key.path === path)).toBe(false);
    expect(prepared.index.artifacts.some((artifact) => artifact.id === 'unrelated-evidence')).toBe(false);
    const resource = full.resources.files.find((file) => file.key.path === path)!.key;
    const declared = full.resolveTaskContext(request);
    const explicit = prepareTaskCapture(
      { ...full, resolveTaskContext: () => ({ ...declared, requiredResources: [resource] }) },
      request,
      options,
    );
    expect(explicit.resources.files.some((file) => file.key.path === path)).toBe(true);
  } finally {
    full.close();
  }
});
it('retains global governance without a task edge and excludes only a definitively contradictory selector', () => {
  const f = setup();
  installGovernance(f.root);
  const directory = '.ia/src/systems/governance-system/records/';
  writeSource(f.root, directory + 'global.ia', law('global'));
  writeSource(f.root, directory + 'rule-only.ia', law('rule-only', 'category is rule'));
  writeSource(f.root, directory + 'process-only.ia', law('process-only', 'category is process'));
  const full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    const prepared = prepareTaskCapture(
      {
        ...full,
        resolveTaskContext: () => ({ ...declared, coordinate: { ...declared.coordinate, category: 'process' } }),
      },
      request,
      options,
    );
    const selected = prepared.capture.sources.map((source) => source.path);
    expect(selected).toContain(directory + 'global.ia');
    expect(selected).toContain(directory + 'process-only.ia');
    expect(selected).not.toContain(directory + 'rule-only.ia');
    expect(prepared.resources.files.some((file) => file.key.path === 'references/law.md')).toBe(true);
    const unknown = prepareTaskCapture(full, request, options).capture.sources.map((source) => source.path);
    expect(unknown).toContain(directory + 'rule-only.ia');
    expect(unknown).toContain(directory + 'process-only.ia');
  } finally {
    full.close();
  }
});
it('retains disqualified co-located governance bytes when its file also contains a global obligation', () => {
  const f = setup();
  installGovernance(f.root);
  const path = '.ia/src/systems/governance-system/records/shared.ia';
  writeSource(f.root, path, law('global') + law('rule-only', 'category is rule').replace('#! ia 1.0\n', ''));
  const full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    const prepared = prepareTaskCapture(
      {
        ...full,
        resolveTaskContext: () => ({ ...declared, coordinate: { ...declared.coordinate, category: 'process' } }),
      },
      request,
      options,
    );
    expect(prepared.capture.sources.find((source) => source.path === path)?.text).toContain('@law rule-only');
  } finally {
    full.close();
  }
});
it('retains exact supersession history and a unique successor without replacing the declared task', () => {
  const f = setup(),
    taskPath = resolve(f.root, workRecords + 'requirement.ia');
  writeFileSync(taskPath, readFileSync(taskPath, 'utf8') + '    supersedes @task predecessor\n');
  writeSource(f.root, workRecords + 'predecessor.ia', '#! ia 1.0\n@task predecessor\n  work\n    status superseded\n');
  writeSource(
    f.root,
    workRecords + 'successor.ia',
    '#! ia 1.0\n@task successor\n  work\n    status open\n  relationships\n    supersedes @task requirement\n',
  );
  const full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options),
      paths = prepared.capture.sources.map((source) => source.path);
    expect(paths).toContain(workRecords + 'predecessor.ia');
    expect(paths).toContain(workRecords + 'successor.ia');
    expect(prepared.capture.selection?.request.target).toBe(request.target);
    expect(prepared.disclosure.required).toContain(request.target);
  } finally {
    full.close();
  }
});
it.each(['two-successors', 'cycle'])('refuses %s instead of inventing supersession currentness', (form) => {
  const f = setup();
  writeSource(
    f.root,
    workRecords + 'successor.ia',
    '#! ia 1.0\n@task successor\n  relationships\n    supersedes @task requirement\n',
  );
  if (form === 'two-successors')
    writeSource(
      f.root,
      workRecords + 'other-successor.ia',
      '#! ia 1.0\n@task other-successor\n  relationships\n    supersedes @task requirement\n',
    );
  else {
    const path = resolve(f.root, workRecords + 'requirement.ia');
    writeFileSync(path, readFileSync(path, 'utf8') + '    supersedes @task successor\n');
  }
  const full = f.open();
  try {
    expect(() => prepareTaskCapture(full, request, options)).toThrow(/supersed|cycle|ambigu|current/i);
  } finally {
    full.close();
  }
});
it('refuses a superseded basis even when its old record still claims made status', () => {
  const f = setup();
  writeSource(
    f.root,
    workRecords + 'replacement-policy.ia',
    '#! ia 1.0\n@decision replacement-policy\n  work\n    status made\n  relationships\n    supersedes @decision policy\n',
  );
  const full = f.open();
  try {
    expect(() => prepareTaskCapture(full, request, options)).toThrow(/basis|supersed|current/i);
  } finally {
    full.close();
  }
});

it('follows made grounding decisions inward without retaining every disconnected decision', () => {
  const f = setup();
  writeSource(
    f.root,
    workRecords + 'supporting-decision.ia',
    '#! ia 1.0\n@decision supporting-decision\n  work\n    status made\n  relationships\n    grounds @task dependency\n',
  );
  writeSource(
    f.root,
    workRecords + 'independent-decision.ia',
    '#! ia 1.0\n@decision independent-decision\n  work\n    status made\n',
  );
  const full = f.open();
  try {
    const paths = prepareTaskCapture(full, request, options).capture.sources.map((source) => source.path);
    expect(paths).toContain(workRecords + 'supporting-decision.ia');
    expect(paths).not.toContain(workRecords + 'independent-decision.ia');
  } finally {
    full.close();
  }
});
it('follows a typed milestone parent upward without making every sibling a prerequisite', () => {
  const f = setup(),
    systemPath = '.ia/src/systems/work-system/system.ia',
    file = resolve(f.root, systemPath);
  let system = readFileSync(file, 'utf8');
  system = system.replace(
    '  edges\n',
    '    milestone lowers to definition\n      category state\n      facets [milestone]\n      schema @schema milestone\n  edges\n',
  );
  system = system.replace(
    '\n@agent work-steward',
    '\n@schema milestone\n  lowers to definition\n  sections\n    open\n@agent work-steward',
  );
  system = system.replace('applies [task, decision]', 'applies [task, decision, milestone]');
  system += `@authoring-guide milestone-guide
  meaning
    says "A milestone records a bounded work outcome."
    answers "Which outcome contains this work?"
  reference
    owner work-system
    word milestone
    schema @schema milestone
    document "references/task.md"
  guidance
    select-when "The work has an explicit parent outcome."
    avoid-when "A prerequisite is intended instead of membership."
    consider "Do not infer every sibling is required."
  relationships
    cites @schema milestone
`;
  writeFileSync(file, system);
  const manifestPath = resolve(f.root, '.ia/authoring.resources.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.associations.push({
    owner: {
      source: 'self',
      path: systemPath,
      identity: 'authoring-system/definition/authoring-guide/milestone-guide',
    },
    resources: [
      {
        key: { source: 'self', path: 'references/task.md' },
        role: 'guide',
        order: 0,
        required: true,
        delivery: 'inline',
      },
    ],
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const taskPath = resolve(f.root, workRecords + 'requirement.ia');
  writeFileSync(taskPath, readFileSync(taskPath, 'utf8') + '  work\n    milestone @milestone shared\n');
  writeSource(f.root, workRecords + 'milestone.ia', '#! ia 1.0\n@milestone shared\n');
  writeSource(f.root, unrelated, '#! ia 1.0\n@task unrelated\n  work\n    milestone @milestone shared\n');
  const full = f.open();
  try {
    const paths = prepareTaskCapture(full, request, options).capture.sources.map((source) => source.path);
    expect(paths).toContain(workRecords + 'milestone.ia');
    expect(paths).not.toContain(unrelated);
  } finally {
    full.close();
  }
});
it('refuses an explicitly selected unavailable lifecycle instead of treating it as null', () => {
  const f = setup(),
    full = f.open();
  try {
    const declared = full.resolveTaskContext(request);
    const selected = {
      ...declared,
      authoring: declared.authoring.map((target) => ({
        ...target,
        lifecycle: {
          model: 'missing',
          version: '1',
          workflow: 'review',
          iteration: 1,
          stage: 'review',
          phase: request.phase,
          primitive: request.primitive,
        },
      })),
    };
    expect(() => prepareTaskCapture({ ...full, resolveTaskContext: () => selected }, request, options)).toThrow(
      /lifecycle|teaching|required/i,
    );
  } finally {
    full.close();
  }
});
it('does not accept a declaration or resolver smuggled into a remote request', () => {
  const f = setup(),
    full = f.raw();
  try {
    const forged = { ...request, declaration: declaration(full), resolveTaskContext: () => declaration(full) };
    expect(() => prepareTaskCapture(full, forged, options)).toThrow(/Unknown|field|request|declaration/i);
  } finally {
    full.close();
  }
});

it('decodes the exact historical policy for retained reads while refusing its current admission', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    const { revision: _revision, selection, ...body } = prepared.capture;
    const { declaration: _declaration, ...oldSelection } = selection!;
    const oldPolicy = digest({
      version: 1,
      closure: 'all-policy-and-connected-work',
      files: 'whole',
      teaching: 'all-explicit-resources',
      incomplete: 'refuse',
    });
    const legacyBody = { ...body, selection: { ...oldSelection, policy: oldPolicy } },
      legacy = { ...legacyBody, revision: digest(legacyBody) };
    expect(verifyCapture(legacy)).toEqual(legacy);
    expect(verifyCapture(legacy).selection?.policy).toBe(oldPolicy);
    expect(verifyCapture(legacy).selection?.declaration).toBeUndefined();
    expect(() => verifyTaskCapture(legacy, full, options)).toThrow(/legacy|reviewed.*declaration/i);
  } finally {
    full.close();
  }
});
it('keeps current and historical selection envelopes closed and rejects unknown policies', () => {
  const f = setup(),
    full = f.open();
  try {
    const { revision: _revision, selection, ...body } = prepareTaskCapture(full, request, options).capture;
    const { declaration: _declaration, ...withoutDeclaration } = selection!;
    const oldPolicy = digest({
      version: 1,
      closure: 'all-policy-and-connected-work',
      files: 'whole',
      teaching: 'all-explicit-resources',
      incomplete: 'refuse',
    });
    for (const invalidSelection of [
      withoutDeclaration,
      { ...selection!, policy: oldPolicy },
      { ...withoutDeclaration, policy: 'b'.repeat(64) },
    ]) {
      const invalid = { ...body, selection: invalidSelection };
      expect(() => verifyCapture({ ...invalid, revision: digest(invalid) })).toThrow();
    }
  } finally {
    full.close();
  }
});

it('retains both endpoints of an inverse assertion authored by a required record', () => {
  const f = setup();
  writeSource(
    f.root,
    workRecords + 'dependency.ia',
    '#! ia 1.0\n@task dependency\n  relationships\n    required-by @task unrelated\n',
  );
  const full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options);
    expect(prepared.capture.sources.some((source) => source.path === unrelated)).toBe(true);
    expect(prepared.capture.sources.find((source) => source.path === workRecords + 'dependency.ia')?.text).toContain(
      'required-by @task unrelated',
    );
    expect(verifyTaskCapture(prepared.capture, full, options)).toEqual(prepared);
  } finally {
    full.close();
  }
});
it('retains the enclosing system of a required schema whose vocabulary owner is the floor', () => {
  const f = setup(),
    workSystemPath = resolve(f.root, '.ia/src/systems/work-system/system.ia');
  const schema = '@schema task\n  lowers to definition\n  sections\n    open\n';
  const workSystem = readFileSync(workSystemPath, 'utf8');
  expect(workSystem).toContain(schema);
  writeFileSync(workSystemPath, workSystem.replace(schema, ''));
  const containerPath = '.ia/src/systems/schema-fixture-system/system.ia',
    schemaPath = '.ia/src/systems/schema-fixture-system/schemas/task.schema.ia';
  writeSource(f.root, schemaPath, '#! ia 1.0\n' + schema);
  writeSource(
    f.root,
    containerPath,
    `#! ia 1.0
@system schema-fixture-system
  provider "fixture"
  version "1.0.0"
  steward @agent schema-fixture-steward
  requires
    - taxonomy
    - agent-system
@agent schema-fixture-steward
  governance
    applies [schema]
`,
  );
  const path = 'references/schema-fixture.md',
    content =
      '# Synthetic schema container\nThe schema uses the floor-owned word while source admission requires this enclosing system declaration.\n';
  writeSource(f.root, path, content);
  const manifestPath = resolve(f.root, '.ia/authoring.resources.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const system = { source: 'self', path: containerPath, identity: 'floor/definition/system/schema-fixture-system' },
    key = { source: 'self', path };
  manifest.files.push({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  });
  manifest.associations.push({
    owner: system,
    resources: [{ key, role: 'guide', order: 0, required: true, delivery: 'inline' }],
  });
  manifest.index.systems.push({
    system,
    authoring: [key],
    architecture: [key],
    extensions: [],
    methods: [],
    steward: { source: 'self', path: containerPath, identity: 'agent-system/definition/head/schema-fixture-steward' },
    base: null,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const full = f.open();
  try {
    expect(full.reader.get('floor/contract/head/task', { within: full.within })?.source.path).toBe(schemaPath);
    const prepared = prepareTaskCapture(full, request, options),
      paths = prepared.capture.sources.map((source) => source.path);
    expect(paths).toContain(schemaPath);
    expect(paths).toContain(containerPath);
    expect(prepared.resources.files.some((file) => file.key.path === path)).toBe(true);
    expect(verifyTaskCapture(prepared.capture, full, options)).toEqual(prepared);
  } finally {
    full.close();
  }
});

it('distinguishes implementation skew before recomputing and preserves exact release pins', () => {
  const f = setup(),
    full = f.open();
  try {
    const prepared = prepareTaskCapture(full, request, options),
      requiredImplementation = 'b'.repeat(64);
    let caught: unknown;
    try {
      verifyTaskCapture(
        prepared.capture,
        {
          ...full,
          assertCurrent: () => {
            throw Error('Must not recompute another implementation');
          },
        },
        { implementation: requiredImplementation },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskCaptureError);
    expect(caught).toMatchObject({
      reason: 'implementation',
      code: 'IA-TASK-CAPTURE-IMPLEMENTATION',
      evidence: { preparedImplementation: implementation, requiredImplementation },
    });
  } finally {
    full.close();
  }
});
