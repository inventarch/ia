import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { runBounded } from '../../../tools/testing/subprocess.js';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { adoptWorkspace, captureWorkspace } from '../src/index.js';
import { captureResources, resolveResources, resourceOccurrences, verifyResources } from '../src/resources.js';
import {
  claudeProseCatalog,
  codexProseCatalog,
  compileProjection,
  ProjectionError,
  serializeProjection,
  verifyProjectionDescriptor,
} from '../src/projections.js';
import type {
  ProjectionCode,
  ProjectionDescriptor,
  ProjectionExport,
  ProjectionOptions,
  ProjectionResult,
} from '../src/projections.js';
import { keyOf, metadataDigest, occurrenceOf, ordered, sha256 } from '../src/resource-format.js';
import { clearNativeContexts } from '../src/resource-context.js';
import type { ResourceAssociation, ResourceFilePin, ResourceOccurrence, ResourceUse } from '../src/resources.js';
import { inert } from '../src/projection-host.js';
import { resourceVerifier } from '../src/projection-routine.js';
import { assignFeatures, featureFiles, resourcesResolve } from '../../../tools/projections/live-features.mjs';
// The one link rule for projected Markdown (private source history), shared with the isolated packed consumer.
import { linkCounts, linkProblems } from '../../../tools/projections/fixtures/link-walk.mjs';

// Cases rebuild adopted native views and serialize their host projections.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Counts full native rebuilds. The subclass is otherwise transparent to every caller.
const rebuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@inventarch/db/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/db/editor')>();
  class CountedSnapshot extends actual.EditorSnapshot {
    constructor(...input: ConstructorParameters<typeof actual.EditorSnapshot>) {
      super(...input);
      rebuilds.count += 1;
    }
  }
  return { ...actual, EditorSnapshot: CountedSnapshot };
});
function countRebuilds<T>(run: () => T): { value: T; rebuilds: number } {
  const before = rebuilds.count,
    value = run();
  return { value, rebuilds: rebuilds.count - before };
}

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'ia-prose-')),
  handles: Handle[] = [];
const capturedFoundation = adoptWorkspace(repository, 'foundation');
const selectedSystems = [
  '.ia/src/systems/workspace-system/records/system-packages.ia',
  '.ia/src/floor/artifact-set.ia',
  '.ia/src/floor/axis.ia',
  '.ia/src/floor/cardinality.ia',
  '.ia/src/floor/category.ia',
  '.ia/src/floor/dimension.ia',
  '.ia/src/floor/floor.schema.ia',
  '.ia/src/floor/intent-shape.ia',
  '.ia/src/floor/kernel.schema.ia',
  '.ia/src/floor/kind.ia',
  '.ia/src/floor/lane.ia',
  '.ia/src/floor/move.ia',
  '.ia/src/floor/phase.ia',
  '.ia/src/floor/placement.ia',
  '.ia/src/floor/predicate.ia',
  '.ia/src/floor/primitive.ia',
  '.ia/src/floor/taxonomy.system.ia',
  '.ia/src/floor/value-type.ia',
  '.ia/src/systems/agent-system/system.ia',
  '.ia/src/systems/agent-system/schemas/agent.schema.ia',
  '.ia/src/systems/agent-system/schemas/mandate.schema.ia',
  '.ia/src/systems/compliance-system/system.ia',
  '.ia/src/systems/compliance-system/schemas/case.schema.ia',
  '.ia/src/systems/compliance-system/schemas/check.schema.ia',
  '.ia/src/systems/compliance-system/schemas/contract.schema.ia',
  '.ia/src/systems/workspace-system/system.ia',
  '.ia/src/systems/workspace-system/schemas/distribution.schema.ia',
  '.ia/src/systems/workspace-system/schemas/workspace.schema.ia',
  '.ia/src/systems/governance-system/system.ia',
  '.ia/src/systems/governance-system/schemas/convention.schema.ia',
  '.ia/src/systems/governance-system/schemas/law.schema.ia',
  '.ia/src/systems/governance-system/schemas/playbook.schema.ia',
  '.ia/src/systems/governance-system/schemas/principle.schema.ia',
  '.ia/src/systems/session-system/system.ia',
  '.ia/src/systems/session-system/schemas/run.schema.ia',
  '.ia/src/systems/authoring-system/system.ia',
  '.ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia',
  '.ia/src/systems/authoring-system/schemas/operation.schema.ia',
  '.ia/src/systems/agent-composition-system/system.ia',
  '.ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia',
  '.ia/src/systems/agent-composition-system/schemas/capability.schema.ia',
  '.ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia',
  '.ia/src/systems/agent-composition-system/schemas/harness.schema.ia',
  '.ia/src/systems/agent-composition-system/schemas/voice.schema.ia',
  '.ia/src/systems/template-system/system.ia',
  '.ia/src/systems/template-system/schemas/template.schema.ia',
  '.ia/src/systems/hook-authoring-system/system.ia',
  '.ia/src/systems/hook-authoring-system/schemas/hook.schema.ia',
  '.ia/src/systems/learning-system/system.ia',
  '.ia/src/systems/learning-system/schemas/improvement.schema.ia',
  '.ia/src/systems/learning-system/schemas/observation.schema.ia',
  '.ia/src/systems/work-system/system.ia',
  '.ia/src/systems/work-system/schemas/decision.schema.ia',
  '.ia/src/systems/work-system/schemas/milestone.schema.ia',
  '.ia/src/systems/work-system/schemas/plan.schema.ia',
  '.ia/src/systems/work-system/schemas/task.schema.ia',
  '.ia/src/systems/work-system/schemas/spec.schema.ia',
  '.ia/src/systems/agent-composition-system/records/composition.ia',
  '.ia/src/systems/workspace-system/records/quality.ia',
  '.ia/src/systems/workspace-system/records/architecture.ia',
  '.ia/src/systems/learning-system/records/evidence.ia',
  '.ia/src/systems/workspace-system/records/language.ia',
  '.ia/src/systems/work-system/records/work.ia',
  '.ia/src/systems/authoring-system/operations/validate-ia.ia',
  '.ia/src/systems/authoring-system/operations/format-ia.ia',
  '.ia/src/systems/template-system/operations/render-template.ia',
  '.ia/src/systems/workspace-system/records/repository-distribution.ia',
];
const foundationSources = capturedFoundation.sources.filter((source) => selectedSystems.includes(source.path));
const foundation = { ...capturedFoundation, sources: foundationSources, revision: metadataDigest(foundationSources) };
let sequence = 0;
// A null guide keeps the fixture's own review-guide.md bytes, as the packed qualification does.
function setup(
  transform?: (native: string) => string,
  guide: string | null = '# Review\n\nRead the [example](examples/note.md).\n',
) {
  const base = join(temporary, String(sequence++)),
    fixture = join(base, 'source'),
    project = join(base, 'project');
  mkdirSync(base);
  cpSync(join(repository, 'tools/projections/fixtures/synthetic-review'), fixture, { recursive: true });
  mkdirSync(project);
  const nativePath = '.ia/src/systems/fictional-review-system/prose.ia';
  if (transform) writeFileSync(join(fixture, nativePath), transform(readFileSync(join(fixture, nativePath), 'utf8')));
  if (guide !== null) writeFileSync(join(fixture, 'references/review-guide.md'), guide);
  const adopted = [foundation, adoptWorkspace(fixture, 'review')],
    capture = captureWorkspace(project, 'project', { adopted });
  const reader = open(project, { cache: false, adopted });
  handles.push(reader);
  expect(reader.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const inventory = resourceOccurrences(capture);
  const owner = (name: string): ResourceOccurrence => {
    const result = inventory.occurrences.find((o) => o.identity.endsWith('/' + name));
    if (!result) throw new Error('Missing fixture owner ' + name);
    return result;
  };
  const capability = owner('fictional-review'),
    method = owner('fictional-review-method');
  const paths = ['references/review-guide.md', 'references/examples/note.md'];
  const pins: ResourceFilePin[] = paths.map((path) => {
    const bytes = readFileSync(join(fixture, path));
    return {
      key: { source: capability.source, revision: capability.revision, path },
      bytes: bytes.length,
      sha256: sha256(bytes),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    };
  });
  const uses: ResourceUse[] = pins.map((pin, index) => ({
    key: pin.key,
    role: index ? 'example' : 'body',
    order: 0,
    required: true,
    delivery: index ? 'installed-reference' : 'inline',
  }));
  const associations: ResourceAssociation[] = [capability, method].map((owner) => ({ owner, resources: uses }));
  const resources = captureResources(capture, {
    roots: [{ source: capability.source, revision: capability.revision, root: fixture }],
    files: pins,
    associations,
  });
  const catalog = claudeProseCatalog('a'.repeat(64), {
    models: [{ id: 'inherit', name: 'inherit' }],
    tools: [{ id: 'read', name: 'Read' }],
    inputFields: [{ name: 'topic', type: 'text' }],
  });
  const shared = {
    profile: catalog.profile.id,
    required: true,
    description: 'Review fictional notes using captured evidence.',
    requirements: [{ feature: 'resources', minimumEvidence: 'generated' as const }],
  };
  const exports: ProjectionExport[] = [
    {
      ...shared,
      id: 'reviewer',
      outputName: 'fictional-reviewer',
      target: owner('fictional-reviewer'),
      resources: [],
      presentation: {
        kind: 'agent',
        agent: owner('fictional-reviewer'),
        agentProfile: owner('fictional-review-profile'),
        voice: owner('fictional-concise'),
        mandate: owner('fictional-read-only'),
        model: 'inherit',
        tools: ['read'],
        delegates: [],
      },
    },
    {
      ...shared,
      id: 'review',
      outputName: 'fictional-review',
      target: capability,
      resources: uses,
      presentation: {
        kind: 'skill',
        invocation: 'automatic-or-explicit',
        arguments: [],
        patterns: [{ kind: 'prompt-literal', value: 'review this fictional note', priority: 10 }],
        body: [method],
      },
    },
    {
      ...shared,
      id: 'check',
      outputName: 'fictional-check',
      target: method,
      resources: uses,
      presentation: {
        kind: 'command',
        invocation: 'explicit',
        arguments: [{ name: 'topic', type: 'text', required: true, target: 'topic' }],
        body: [method],
      },
    },
  ];
  const body = {
    format: 'ia.projection-descriptor.v1' as const,
    sourceRevisions: inventory.sourceRevisions,
    product: 'plugin' as const,
    profiles: [catalog.profile],
    exports: ordered(exports, (e) => e.id),
    resourcesDigest: resources.digest,
    inventoryDigest: 'b'.repeat(64),
  };
  const descriptor: ProjectionDescriptor = { ...body, digest: metadataDigest(body) };
  const options: ProjectionOptions = {
    reader,
    within: reader.resolveScope().token,
    allowedResources: pins.map((p) => p.key),
    expectedResourcesDigest: resources.digest,
    inventoryDigest: descriptor.inventoryDigest,
    catalog,
    name: 'fictional-review',
    version: '0.1.0',
  };
  return { base, fixture, project, capture, reader, resources, descriptor, options, owner };
}
type Fixture = ReturnType<typeof setup>;
let fixture: Fixture;
beforeAll(() => {
  fixture = setup();
}, 30_000);
it('review regression: accepts explicit roots with ordinary canonical volume spellings', async () => {
  const script = join(temporary, 'canonical-root.mjs');
  writeFileSync(script, resourceVerifier([]));
  const native = await runBounded(process.execPath, [script, '--root', realpathSync.native(temporary)], {
    timeoutMs: 10000,
    maxBufferBytes: 65536,
  });
  expect(native.status, native.stderr).toBe(0);
  if (process.platform === 'win32') {
    const folded = await runBounded(
      process.execPath,
      [script, '--root', realpathSync.native(temporary).toUpperCase()],
      { timeoutMs: 10000, maxBufferBytes: 65536 },
    );
    expect(folded.status, folded.stderr).toBe(0);
  }
  for (const [platform, supplied, physical, expected] of [
    ['darwin', '/var/folders/product', '/private/var/folders/product', 1],
    ['darwin', '/Volumes/data/Product', '/Volumes/Data/product', 0],
    ['darwin', '/Volumes/Data/café', '/Volumes/Data/café', 0],
    ['win32', 'C:\\RUNNER~1\\product', 'C:\\Runner Long Name\\product', 1],
    ['win32', 'Z:\\product', 'C:\\data\\product', 1],
    ['darwin', '/data/alias/product', '/outside/product', 1],
  ]) {
    const stub = `const fake = { lstatSync: (p) => ({ isDirectory: () => true, isSymbolicLink: () => p === '/var' || p === '/data/alias', dev: 1, ino: 2 }), realpathSync: { native: () => ${JSON.stringify(physical)} } }; const {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} = fake;`;
    const code = resourceVerifier([])
      .replace(/import \{[^\n]+\} from 'node:fs';/, stub)
      .replace(/from 'node:path';/, `from 'node:path';`)
      .replace(
        /import \{([^\n]+)\} from 'node:path';/,
        `const {$1} = (await import('node:path')).${platform === 'win32' ? 'win32' : 'posix'};`,
      );
    writeFileSync(script, `Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});\n` + code);
    const run = await runBounded(process.execPath, [script, '--root', String(supplied)], {
      timeoutMs: 10_000,
      maxBufferBytes: 65536,
    });
    expect(run.status, run.stderr).toBe(expected);
  }
});
it('review regression: ten skills share thirty physical resources within the unchanged file ceiling', () => {
  const f = setup(),
    first = f.resources.files[0]!;
  const pins = f.resources.files.map(({ key, bytes, sha256, mediaType, encoding }) => ({
    key,
    bytes,
    sha256,
    mediaType,
    encoding,
  }));
  for (let index = 0; index < 28; index++) {
    const path = `references/shared-${index}.md`,
      content = `Shared ${index}\n`;
    writeFileSync(join(f.fixture, path), content);
    pins.push({
      key: { ...first.key, path },
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    });
  }
  const uses: ResourceUse[] = pins.map((pin, index) => ({
    key: pin.key,
    role: index === 0 ? 'body' : 'example',
    order: index,
    required: true,
    delivery: 'installed-reference',
  }));
  const resources = captureResources(f.capture, {
    roots: [{ source: first.key.source, revision: first.key.revision, root: f.fixture }],
    files: pins,
    associations: f.resources.associations.map((a) => ({ ...a, resources: uses })),
  });
  const original = f.descriptor.exports.find((e) => e.presentation.kind === 'skill')!;
  const descriptor = resign({
    ...f.descriptor,
    resourcesDigest: resources.digest,
    exports: Array.from({ length: 10 }, (_, index) => ({
      ...original,
      id: `skill-${index}`,
      outputName: `skill-${index}`,
      resources: uses,
    })),
  });
  const result = compileProjection(f.capture, descriptor, resources, {
    ...f.options,
    allowedResources: pins.map((p) => p.key),
    expectedResourcesDigest: resources.digest,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'compiled' });
  if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
  expect(result.manifest.outputs.filter((o) => o.role === 'resource')).toHaveLength(30);
  expect(result.files).toHaveLength(61);
  expect(result.files.length).toBeLessThanOrEqual(256);
});
it('review regression: verifier provenance cannot impersonate selected resource bytes', () => {
  const result = compiled();
  for (const output of result.manifest.outputs.filter((o) => o.path.endsWith('/verify-resources.mjs'))) {
    expect(output.role).toBe('host-metadata');
    expect(output.resources).toEqual([]);
  }
  for (const key of fixture.resources.files.map((f) => f.key))
    expect(
      result.manifest.outputs.filter((o) => o.role === 'resource' && o.resources.some((k) => keyOf(k) === keyOf(key))),
    ).toHaveLength(1);
});
it('review regression: the actual feature qualifier admits multiple resources and refuses old verifier claims and missing bytes', () => {
  const result = compiled(),
    features = [
      { id: 'role', name: 'fictional-reviewer' },
      { id: 'skill', name: 'fictional-review' },
      { id: 'command', name: 'fictional-check' },
      ...fixture.resources.files.map((file) => ({ id: file.key.path, resource: file.key.path })),
    ];
  expect(() => assignFeatures('fixture', result.manifest, features)).not.toThrow();
  const old = {
    ...result.manifest,
    outputs: result.manifest.outputs.map((output) =>
      output.path.endsWith('/verify-resources.mjs')
        ? { ...output, role: 'resource', resources: fixture.resources.files.map((file) => file.key) }
        : output,
    ),
  };
  const oldVerifier = old.outputs.find((output) => output.path.endsWith('/verify-resources.mjs'))!;
  expect(features.filter((feature) => featureFiles(old, feature).includes(oldVerifier))).toHaveLength(2);
  expect(() => assignFeatures('fixture', old, features)).toThrow('attest its own resource bytes');
  const root = join(temporary, `feature-${sequence++}`);
  for (const file of result.files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.content, file.encoding));
  }
  expect(() => resourcesResolve(root, result.manifest)).not.toThrow();
  const actual = result.manifest.outputs.find((output) => output.role === 'resource')!;
  unlinkSync(join(root, actual.path));
  expect(() => resourcesResolve(root, result.manifest)).toThrow('does not reach a file');
});
afterAll(() => {
  handles.forEach((h) => h.close());
  const target = resolve(temporary),
    parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('ia-prose-'))
    throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
});
const resign = (value: ProjectionDescriptor): ProjectionDescriptor => {
  const { digest: _digest, ...body } = value;
  return { ...body, digest: metadataDigest(body) };
};
/** The Claude disclosure (#444): agent host tools are bounded by native effects, and they stay host metadata. */
const CLAUDE_AGENT_PRESENTATION = {
  feature: 'agent-presentation',
  level: 'guidance',
  evidence: 'host tool names within native capability effects; not IA authorization or an enforced allowlist',
};
function compiled(
  f = fixture,
  descriptor = f.descriptor,
  options = f.options,
): Extract<ProjectionResult, { status: 'compiled' }> {
  const result = compileProjection(f.capture, descriptor, f.resources, options);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'compiled' });
  if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
  return result;
}
function refused(descriptor = fixture.descriptor, options = fixture.options, code?: string) {
  const result = compileProjection(fixture.capture, descriptor, fixture.resources, options);
  expect(result).toMatchObject({ status: 'refused', ...(code ? { diagnostics: [{ code }] } : {}) });
  expect(result).not.toHaveProperty('files');
  return result;
}

it('admits an adopted zero-new-word fixture and compiles a non-steward agent, skill and command without a harness', () => {
  const result = compiled();
  expect(result.files).toHaveLength(8);
  expect(result.files.map((f) => f.path)).toContain('agents/fictional-reviewer.md');
  const agent = result.files.find((f) => f.path === 'agents/fictional-reviewer.md')!.content;
  for (const text of [
    'model: inherit',
    'tools: "Read"',
    'fictional-concise',
    'fictional-read-only',
    'fictional-review-details',
    'when phase is act',
    'category is process',
    'review@',
  ])
    expect(agent).toContain(text);
  expect(agent).not.toContain('fictional-review-steward');
  const command = result.files.find((f) => f.path === 'commands/fictional-check.md')!.content;
  expect(command).toContain('disable-model-invocation: true');
  expect(command).toContain('topic (required text): $ARGUMENTS[0]');
  expect(result.manifest.exports.find((e) => e.id === 'reviewer')!.closure).toContainEqual(
    fixture.owner('fictional-review-profile'),
  );
  expect(result.manifest.enforcement).toEqual([
    { feature: 'prose-projection', level: 'guidance', evidence: expect.stringContaining('not established') },
    CLAUDE_AGENT_PRESENTATION,
  ]);
  expect(JSON.stringify(result)).not.toContain(temporary);
  expect(existsSync(join(fixture.project, '.claude'))).toBe(false);
});

it('is deterministic across JSON transport and keeps workspace and plugin products separate', () => {
  const result = compiled();
  expect(
    serializeProjection(
      fixture.capture,
      JSON.stringify(fixture.descriptor),
      JSON.stringify(fixture.resources),
      fixture.options,
    ),
  ).toEqual(result);
  expect(verifyProjectionDescriptor(JSON.stringify(fixture.descriptor))).toEqual(fixture.descriptor);
  expect(Object.isFrozen(result.manifest.outputs)).toBe(true);
  const workspace = compiled(fixture, resign({ ...fixture.descriptor, product: 'workspace' }));
  expect(workspace.files.some((f) => f.path === '.claude/skills/fictional-review/SKILL.md')).toBe(true);
  expect(workspace.files.some((f) => f.path.includes('plugin.json'))).toBe(false);
  expect(workspace.manifest.digest).not.toBe(result.manifest.digest);
});

it('rewrites inline links, preserves captured resource bytes and discovers everything after relocation', () => {
  const result = compiled(),
    artifact = join(temporary, 'artifact'),
    relocated = join(temporary, 'relocated');
  for (const file of result.files) {
    const path = join(artifact, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.content, file.encoding));
  }
  cpSync(artifact, relocated, { recursive: true });
  for (const file of result.files) expect(sha256(readFileSync(join(relocated, file.path)))).toBe(file.sha256);
  // Every local link reaches a regular file inside the relocated product. The fixture note's https:, mailto: and
  // fragment-only links name no product file; the counts show the walk saw them.
  expect(linkProblems(relocated, result.files)).toEqual([]);
  expect(linkCounts(result.files)).toMatchObject({ external: 2, fragment: 1, unsupported: 0 });
  for (const source of fixture.resources.files)
    expect(result.files.find((f) => f.path.endsWith('/' + source.key.path))!.sha256).toBe(source.sha256);
});

it('fails closed for scope exclusion and stale source/resource/inventory/profile pins', () => {
  const within = fixture.reader.resolveScope({ identities: [fixture.owner('fictional-reviewer').identity] }).token;
  refused(fixture.descriptor, { ...fixture.options, within }, 'IA-PROJECTION-SOURCE-UNAVAILABLE');
  refused(fixture.descriptor, { ...fixture.options, within: 'forged' }, 'IA-PROJECTION-SOURCE-UNAVAILABLE');
  refused(fixture.descriptor, { ...fixture.options, allowedResources: [] }, 'IA-RESOURCE-INVALID');
  refused(fixture.descriptor, { ...fixture.options, expectedResourcesDigest: '0'.repeat(64) }, 'IA-RESOURCE-INVALID');
  refused(
    fixture.descriptor,
    { ...fixture.options, inventoryDigest: '0'.repeat(64) },
    'IA-PROJECTION-SOURCE-UNAVAILABLE',
  );
  refused(
    resign({ ...fixture.descriptor, sourceRevisions: fixture.descriptor.sourceRevisions.slice(1) }),
    fixture.options,
    'IA-PROJECTION-SOURCE-UNAVAILABLE',
  );
  refused(
    resign({
      ...fixture.descriptor,
      profiles: [{ ...fixture.descriptor.profiles[0]!, implementationDigest: '0'.repeat(64) }],
    }),
    fixture.options,
    'IA-PROJECTION-FEATURE-UNAVAILABLE',
  );
});

describe('descriptor/profile refusal', () => {
  it('rejects unknown fields/version, duplicate JSON keys, changed digests and noncanonical order', () => {
    for (const value of [
      { ...fixture.descriptor, extra: true },
      { ...fixture.descriptor, format: 'future' },
      { ...fixture.descriptor, digest: '0'.repeat(64) },
      { ...fixture.descriptor, exports: [...fixture.descriptor.exports].reverse() },
      JSON.stringify(fixture.descriptor).replace('{', '{"f\\u006frmat":"ia.projection-descriptor.v1",'),
    ])
      expect(() => verifyProjectionDescriptor(value)).toThrow(ProjectionError);
  });
  it('refuses higher host evidence and typed inputs, with explicit optional export omissions', () => {
    const changed = resign({
      ...fixture.descriptor,
      exports: fixture.descriptor.exports.map((e) =>
        e.id === 'check' ? { ...e, requirements: [{ feature: 'commands', minimumEvidence: 'live-host' as const }] } : e,
      ),
    });
    refused(changed, fixture.options, 'IA-PROJECTION-FEATURE-UNAVAILABLE');
    const optional = compiled(
      fixture,
      resign({ ...changed, exports: changed.exports.map((e) => (e.id === 'check' ? { ...e, required: false } : e)) }),
    );
    expect(optional.manifest.omissions).toHaveLength(1);
    expect(optional.files.some((f) => f.path === 'commands/fictional-check.md')).toBe(false);
    const typed = resign({
      ...fixture.descriptor,
      exports: fixture.descriptor.exports.map((e) =>
        e.presentation.kind === 'command'
          ? {
              ...e,
              presentation: {
                ...e.presentation,
                arguments: [{ ...e.presentation.arguments[0]!, type: 'boolean' as const }],
              },
            }
          : e,
      ),
    });
    refused(typed, fixture.options, 'IA-PROJECTION-FEATURE-UNAVAILABLE');
  });
  it('refuses invocation collisions and host-authority argument targets', () => {
    refused(
      resign({
        ...fixture.descriptor,
        exports: fixture.descriptor.exports.map((e) =>
          e.presentation.kind === 'command' ? { ...e, outputName: 'fictional-review' } : e,
        ),
      }),
      fixture.options,
      'IA-PROJECTION-INPUT-INVALID',
    );
    const authority = resign({
      ...fixture.descriptor,
      exports: fixture.descriptor.exports.map((e) =>
        e.presentation.kind === 'command'
          ? {
              ...e,
              presentation: { ...e.presentation, arguments: [{ ...e.presentation.arguments[0]!, target: 'root' }] },
            }
          : e,
      ),
    });
    refused(authority, fixture.options, 'IA-PROJECTION-INPUT-INVALID');
  });
});

it('refuses cyclic composition and conflicting native profile presentation', () => {
  const cycle = setup((source) =>
    source.replace(
      'playbooks [@playbook fictional-review-method]',
      'playbooks [@playbook fictional-review-method]\n    includes [@capability fictional-review]',
    ),
  );
  expect(compileProjection(cycle.capture, cycle.descriptor, cycle.resources, cycle.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-PROJECTION-SOURCE-UNAVAILABLE', message: expect.stringContaining('Cyclic') }],
  });
  refused(
    resign({
      ...fixture.descriptor,
      exports: fixture.descriptor.exports.map((e) =>
        e.presentation.kind === 'agent'
          ? { ...e, presentation: { ...e.presentation, voice: fixture.owner('fictional-alternative') } }
          : e,
      ),
    }),
    fixture.options,
    'IA-PROJECTION-SOURCE-UNAVAILABLE',
  );
});

it.each([
  '# Unsafe\n\n!`echo should-never-run`\n',
  '# Unsafe\n\n<script>doSomething()</script>\n',
  '# Broken\n\n[missing](missing.md)\n',
  '# Unsafe\n\n![image](https://example.test/image.svg)\n',
  '# Unsafe\n\n![image][example]\n\n[example]: examples/note.md\n',
  '# Ambiguous\n\n[example][shared]\n\n[shared]: examples/note.md\n',
])('refuses executable or missing resource content without partial outputs', (guide) => {
  const f = setup(undefined, guide),
    result = compileProjection(f.capture, f.descriptor, f.resources, f.options);
  expect(result.status).toBe('refused');
  expect(result).not.toHaveProperty('files');
});

it('reports optional refused exports without leaking orphan files from them', () => {
  const f = setup(undefined, '# Unsupported\n\n!`echo never-run`\n');
  const descriptor = resign({ ...f.descriptor, exports: f.descriptor.exports.map((e) => ({ ...e, required: false })) });
  const result = compiled(f, descriptor);
  expect(result.manifest.omissions).toHaveLength(3);
  expect(result.files.map((f) => f.path)).toEqual(['.claude-plugin/plugin.json']);
});

it('retains literal fenced examples while checking links after their actual closing fence', () => {
  const literal = setup(
    undefined,
    '# Literal\n\n````md\n```\n[not a link](missing.md)\n````\n\n[example](examples/note.md)\n',
  );
  expect(compiled(literal).files.find((f) => f.path === 'commands/fictional-check.md')!.content).toContain(
    '[not a link](missing.md)',
  );
  const escaped = setup(undefined, '# Literal\n\n````md\n```\nexample\n````\n\n[missing](missing.md)\n');
  expect(compileProjection(escaped.capture, escaped.descriptor, escaped.resources, escaped.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-RESOURCE-INVALID' }],
  });
});

it('preserves literal HTML examples while refusing active HTML and unclosed fences', () => {
  const text = '# Example\n\nUse `<label>` with a name.\n\n```tsx\n<form><input /></form>\n```\n';
  expect(() => inert(text)).not.toThrow();
  const literal = setup(undefined, text);
  expect(compiled(literal).files.find((f) => f.path === 'commands/fictional-check.md')!.content).toContain(text);
  for (const value of [
    '<form>raw</form>',
    '```tsx\n<form/>\n```\n<script>active</script>',
    '```tsx\n<form/>',
    '```sh\n!`echo unsafe`\n```',
  ])
    expect(() => inert(value)).toThrow();
});

it('matches inline code delimiters exactly instead of hiding following Markdown links', () => {
  const literal = setup(undefined, '# Literal\n\n``a ` [literal](missing.md) ` code`` [example](examples/note.md)\n');
  expect(compiled(literal).files.find((f) => f.path === 'commands/fictional-check.md')!.content).toContain(
    '[literal](missing.md)',
  );
  const escaped = setup(undefined, '# Literal\n\n``a ` code`` [missing](missing.md) `\n');
  expect(compileProjection(escaped.capture, escaped.descriptor, escaped.resources, escaped.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-RESOURCE-INVALID' }],
  });
});

it('refuses an oversized generated body before returning files', () => {
  const f = setup(undefined, 'x'.repeat(1024 * 1024));
  expect(compileProjection(f.capture, f.descriptor, f.resources, f.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }],
  });
});

it('refuses native delegation, model disagreement and exact-owner substitution', () => {
  const delegated = setup((source) =>
    source.replace(
      'capabilities [@capability fictional-review]',
      'capabilities [@capability fictional-review]\n    delegates [@agent-profile inspection-architect-profile]',
    ),
  );
  expect(
    compileProjection(delegated.capture, delegated.descriptor, delegated.resources, delegated.options),
  ).toMatchObject({ status: 'refused', diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }] });
  const model = setup((source) => source.replace('role reviewer', 'role reviewer\n    model-profile other-model'));
  expect(compileProjection(model.capture, model.descriptor, model.resources, model.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-PROJECTION-SOURCE-UNAVAILABLE' }],
  });
  refused(
    resign({
      ...fixture.descriptor,
      exports: fixture.descriptor.exports.map((e) => ({ ...e, target: { ...e.target, line: e.target.line + 1 } })),
    }),
    fixture.options,
    'IA-PROJECTION-SOURCE-UNAVAILABLE',
  );
});

it('joins every recorded output hash and provenance to the exact result files', () => {
  const result = compiled();
  for (const output of result.manifest.outputs) {
    const file = result.files.find((f) => f.path === output.path)!;
    expect(output.sha256).toBe(sha256(Buffer.from(file.content, file.encoding)));
    expect(output.bytes).toBe(Buffer.byteLength(file.content, file.encoding));
    expect(new Set(output.sources.map(occurrenceOf)).size).toBe(output.sources.length);
    expect(
      output.resources.every((key) => fixture.resources.files.some((file) => keyOf(key) === keyOf(file.key))),
    ).toBe(true);
  }
});

function asCodex(f = fixture, product: 'workspace' | 'plugin' = 'plugin'): Fixture {
  const catalog = codexProseCatalog('a'.repeat(64), {
    models: [{ id: 'inherit', name: 'inherit' }],
    tools: [{ id: 'read', name: 'read' }],
    inputFields: [{ name: 'topic', type: 'text' }],
  });
  const descriptor = resign({
    ...f.descriptor,
    product,
    profiles: [catalog.profile],
    exports: f.descriptor.exports.map((e) => ({ ...e, profile: catalog.profile.id })),
  });
  return { ...f, descriptor, options: { ...f.options, catalog } };
}
const codexBody = (content: string): string =>
  JSON.parse(
    content
      .split('\n')
      .find((line) => line.startsWith('developer_instructions = '))!
      .slice('developer_instructions = '.length),
  ) as string;

it('pins byte/token budgets and refuses enlargements or required overflow', () => {
  const baseline = compiled(),
    largest = Math.max(
      ...baseline.files
        .filter((file) => ['.md', '.toml'].some((extension) => file.path.endsWith(extension)))
        .map((file) => file.bytes),
    );
  const exact = resign({ ...fixture.descriptor, contextBudget: { bytes: largest, tokens: Math.ceil(largest / 4) } });
  expect(compiled(fixture, exact).manifest.descriptorDigest).toBe(exact.digest);
  refused(
    resign({ ...exact, contextBudget: { bytes: largest - 1, tokens: 8192 } }),
    fixture.options,
    'IA-PROJECTION-FEATURE-UNAVAILABLE',
  );
  refused(
    resign({ ...exact, contextBudget: { bytes: 32768, tokens: 1 } }),
    fixture.options,
    'IA-PROJECTION-FEATURE-UNAVAILABLE',
  );
  for (const budget of [
    { bytes: 32769, tokens: 8192 },
    { bytes: 32768, tokens: 8193 },
    { bytes: 0, tokens: 1 },
  ])
    expect(() => verifyProjectionDescriptor(resign({ ...fixture.descriptor, contextBudget: budget }))).toThrow();
});

it('retains inert-body validation for required native cells before host serialization', () => {
  const f = setup((source) =>
    source.replace('Report gaps with citations and a proposed next action.', '<script>Unsafe native cell</script>'),
  );
  expect(compileProjection(f.capture, f.descriptor, f.resources, f.options)).toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }],
  });
});

it('omits optional inline material within the budget while keeping its verified bundled reference', () => {
  const f = setup(undefined, '# Optional detail\n' + 'Reference detail. '.repeat(1000));
  const make = (delivery: 'inline' | 'installed-reference') => {
    const resources = captureResources(f.capture, {
      roots: [
        { source: f.resources.files[0]!.key.source, revision: f.resources.files[0]!.key.revision, root: f.fixture },
      ],
      files: f.resources.files.map(({ key, bytes, sha256, mediaType, encoding }) => ({
        key,
        bytes,
        sha256,
        mediaType,
        encoding,
      })),
      associations: f.resources.associations.map((a) => ({
        ...a,
        resources: a.resources.map((use) => ({ ...use, required: false, delivery })),
      })),
    });
    const descriptor = resign({
      ...f.descriptor,
      resourcesDigest: resources.digest,
      exports: f.descriptor.exports.map((e) => ({
        ...e,
        resources: e.resources.map((use) => ({ ...use, required: false, delivery })),
      })),
    });
    return { ...f, resources, descriptor, options: { ...f.options, expectedResourcesDigest: resources.digest } };
  };
  const references = make('installed-reference'),
    baseline = compiled(references);
  const bytes = Math.max(
    ...baseline.manifest.outputs
      .filter((file) => ['agent', 'skill', 'command'].includes(file.role))
      .map((file) => file.bytes),
  );
  const inline = make('inline'),
    result = compiled(inline, resign({ ...inline.descriptor, contextBudget: { bytes, tokens: 8192 } }));
  expect(result.manifest.omissions.some((row) => row.feature === 'context')).toBe(true);
  expect(
    result.manifest.outputs
      .filter((file) => ['agent', 'skill', 'command'].includes(file.role))
      .every((file) => file.bytes <= bytes),
  ).toBe(true);
  expect(
    result.files.some(
      (file) => file.path.endsWith('/references/review-guide.md') && file.content.includes('Reference detail.'),
    ),
  ).toBe(true);
});

it('offers optional inline blocks to the budget in declared order, not resource path order', () => {
  // Review of #524: order 1 is references/review-guide.md and order 2 is references/examples/note.md, which sorts
  // first by path. With room for one block, the first declared use must survive, as resolveResourcesWith admits it.
  const f = setup(),
    [first, second] = ['First declared optional guide.', 'Second declared optional note.'];
  writeFileSync(join(f.fixture, 'references/review-guide.md'), `# Guide\n\n${`${first} `.repeat(60)}\n`);
  writeFileSync(join(f.fixture, 'references/examples/note.md'), `# Note\n\n${`${second} `.repeat(60)}\n`);
  const pins: ResourceFilePin[] = f.resources.files.map(({ key }) => {
    const bytes = readFileSync(join(f.fixture, key.path));
    return { key, bytes: bytes.length, sha256: sha256(bytes), mediaType: 'text/markdown', encoding: 'utf8' };
  });
  const pin = (path: string) => pins.find((row) => row.key.path === path)!;
  const make = (delivery: 'inline' | 'installed-reference') => {
    const uses: ResourceUse[] = [
      { key: pin('references/review-guide.md').key, role: 'example', order: 1, required: false, delivery },
      { key: pin('references/examples/note.md').key, role: 'example', order: 2, required: false, delivery },
    ];
    const resources = captureResources(f.capture, {
      roots: [{ source: pins[0]!.key.source, revision: pins[0]!.key.revision, root: f.fixture }],
      files: pins,
      associations: f.resources.associations.map((a) => ({ ...a, resources: uses })),
    });
    const descriptor = resign({
      ...f.descriptor,
      resourcesDigest: resources.digest,
      exports: f.descriptor.exports.map((e) => ({ ...e, resources: e.resources.length ? uses : [] })),
    });
    return {
      ...f,
      resources,
      descriptor,
      options: {
        ...f.options,
        allowedResources: pins.map((row) => row.key),
        expectedResourcesDigest: resources.digest,
      },
    };
  };
  const sizes = (result: ReturnType<typeof compiled>) =>
    result.manifest.outputs.filter((file) => ['agent', 'skill', 'command'].includes(file.role));
  const skill = (result: ReturnType<typeof compiled>) =>
    sizes(result).find((file) => file.path.endsWith('/SKILL.md'))!.bytes;
  const inline = make('inline'),
    referenced = compiled(make('installed-reference')),
    all = compiled(inline);
  const none = skill(referenced),
    full = skill(all),
    required = Math.max(...sizes(referenced).map((file) => file.bytes));
  expect(full - none).toBeGreaterThan(2 * 1000);
  // Room for one optional block in the skill; every export's required content still fits.
  const bytes = none + Math.floor(((full - none) * 3) / 4);
  expect(bytes).toBeGreaterThanOrEqual(required);
  const result = compiled(inline, resign({ ...inline.descriptor, contextBudget: { bytes, tokens: 8192 } }));
  const prompt = result.files.find((file) => file.path.endsWith('/SKILL.md'))!.content;
  expect(prompt).toContain(first);
  expect(prompt).not.toContain(second);
  expect(
    result.manifest.omissions
      .filter((row) => row.export === 'review' && row.feature === 'context')
      .map((row) => row.reason),
  ).toEqual([expect.stringContaining('references/examples/note.md: budget')]);
});

it('runs each relocated skill verifier offline and refuses missing, changed and aliased resources', async () => {
  for (const f of [fixture, asCodex(fixture, 'workspace'), asCodex(fixture, 'plugin')]) {
    const result = compiled(f),
      root = join(temporary, `offline-${sequence++}`);
    for (const file of result.files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(file.content, file.encoding));
    }
    const routines = result.files.filter((file) => file.path.endsWith('/scripts/verify-resources.mjs'));
    expect(routines.length).toBeGreaterThan(0);
    for (const routine of routines) {
      const run = (args = ['--root', realpathSync.native(root)]) =>
        runBounded(process.execPath, [join(root, routine.path), ...args], {
          cwd: temporary,
          timeoutMs: 10_000,
          maxBufferBytes: 64 * 1024,
        });
      expect((await run()).status).toBe(0);
      expect(JSON.parse((await run()).stdout)).toEqual({ status: 'verified', files: 2, effectAuthority: 'none' });
      expect((await run([])).status).toBe(1);
      expect((await run(['--root', '.'])).status).toBe(1);
      const member = result.files.find((file) => file.path.startsWith('resources/'))!;
      const path = join(root, member.path),
        before = readFileSync(path);
      writeFileSync(path, Buffer.alloc(before.length, 120));
      expect((await run()).status).toBe(1);
      unlinkSync(path);
      expect((await run()).status).toBe(1);
      writeFileSync(path, before);
      const alias = path + '.hardlink';
      linkSync(path, alias);
      expect((await run()).status).toBe(1);
      unlinkSync(alias);
      expect((await run()).status).toBe(0);
    }
    expect(JSON.stringify(result)).not.toContain('Private fixture');
  }
});

it('retains same-key required guide and optional example uses across owners and host products', async () => {
  for (const reverse of [false, true])
    for (const repeated of [false, true])
      for (const host of ['claude', 'codex'] as const)
        for (const product of ['workspace', 'plugin'] as const) {
          const f = setup(),
            { content: _content, ...original } = f.resources.files.find((file) =>
              file.key.path.endsWith('review-guide.md'),
            )!;
          const content = '# Shared guide\nRequired guide detail.\n';
          writeFileSync(join(f.fixture, original.key.path), content);
          const pin = { ...original, bytes: Buffer.byteLength(content), sha256: sha256(content) };
          const guide: ResourceUse = {
            key: pin.key,
            role: 'guide',
            order: 7,
            required: true,
            delivery: 'installed-reference',
          };
          const example: ResourceUse = { key: pin.key, role: 'example', order: 2, required: false, delivery: 'inline' };
          const associations = f.resources.associations.map((row, index) => ({
            ...row,
            resources:
              index === (reverse ? 1 : 0)
                ? repeated
                  ? reverse
                    ? [example, guide]
                    : [guide, example]
                  : [example]
                : [guide],
          }));
          const resources = captureResources(f.capture, {
            roots: [{ source: pin.key.source, revision: pin.key.revision, root: f.fixture }],
            files: [pin],
            associations,
          });
          const entry = f.descriptor.exports.find((row) => row.presentation.kind === 'skill')!;
          const descriptor = resign({
            ...f.descriptor,
            product,
            resourcesDigest: resources.digest,
            exports: [
              {
                ...entry,
                resources: resources.associations.find((row) => row.owner.identity === entry.target.identity)!
                  .resources,
              },
            ],
          });
          let selected: Fixture = {
            ...f,
            resources,
            descriptor,
            options: { ...f.options, allowedResources: [pin.key], expectedResourcesDigest: resources.digest },
          };
          if (host === 'codex') selected = asCodex(selected, product);
          const result = compiled(selected),
            prompt = result.files.find((file) => file.path.endsWith('/SKILL.md'))!.content;
          expect(prompt).toContain('## Required guide');
          expect(prompt).not.toContain('## Required example');
          expect(prompt.split(content)).toHaveLength(2);
          expect(prompt).toContain('guide; required package member');
          expect(prompt).toContain('example; optional');
          for (const association of resources.associations)
            for (const use of association.resources) {
              expect(prompt).toContain(
                `${use.role}; ${use.required ? 'required package member' : 'optional'}; delivery=${use.delivery}; order=${use.order}; owner=${occurrenceOf(association.owner)}`,
              );
            }
          expect(result.manifest.outputs.filter((row) => row.role === 'resource')).toHaveLength(1);
          const physical = result.files.find((file) => file.path.startsWith('resources/'))!;
          expect(physical.sha256).toBe(pin.sha256);
          const routine = result.files.find((file) => file.path.endsWith('/verify-resources.mjs'))!;
          expect(JSON.parse(routine.content.match(/const inventory = (.*);/)![1]!)).toHaveLength(1);
          const bound = Math.max(
            ...result.manifest.outputs
              .filter((row) => ['skill', 'command', 'agent'].includes(row.role))
              .map((row) => row.bytes),
          );
          const tight = compiled(
            selected,
            resign({ ...selected.descriptor, contextBudget: { bytes: bound, tokens: Math.ceil(bound / 4) } }),
          );
          expect(tight.files.find((file) => file.path.endsWith('/SKILL.md'))!.content).toContain('## Required guide');
          expect(tight.files.find((file) => file.path.endsWith('/SKILL.md'))!.content).not.toContain(
            '## Optional example',
          );
          expect(
            compileProjection(
              selected.capture,
              resign({ ...selected.descriptor, contextBudget: { bytes: bound - 1, tokens: Math.ceil(bound / 4) } }),
              resources,
              selected.options,
            ),
          ).toMatchObject({ status: 'refused', diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }] });
          const relocated = join(temporary, `shared-uses-${sequence++}`);
          for (const file of tight.files) {
            const target = join(relocated, file.path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, Buffer.from(file.content, file.encoding));
          }
          const run = await runBounded(
            process.execPath,
            [join(relocated, routine.path), '--root', realpathSync.native(relocated)],
            { cwd: temporary, timeoutMs: 10000, maxBufferBytes: 65536 },
          );
          expect(run.status, run.stderr).toBe(0);
          expect(JSON.parse(run.stdout).files).toBe(1);
        }
});
it('still refuses a repeated same-owner resource role/key association', () => {
  const f = setup(),
    { content: _content, ...first } = f.resources.files[0]!;
  const use: ResourceUse = { key: first.key, role: 'guide', order: 1, required: true, delivery: 'installed-reference' };
  expect(() =>
    captureResources(f.capture, {
      roots: [{ source: first.key.source, revision: first.key.revision, root: f.fixture }],
      files: [first],
      associations: [{ owner: f.owner('fictional-review'), resources: [use, { ...use, order: 2 }] }],
    }),
  ).toThrow(/Duplicate resource role\/key|Duplicate resource role\/order or role\/key/);
});
it('inlines required body/guide resources despite installed-reference presentation', () => {
  const resources = fixture.resources,
    associations = resources.associations.map((item) => ({
      ...item,
      resources: item.resources.map((use) =>
        use.role === 'body' ? { ...use, delivery: 'installed-reference' as const } : use,
      ),
    }));
  const { digest: _digest, ...body } = resources,
    next = { ...body, associations },
    captured = { ...next, digest: metadataDigest(next) };
  const descriptor = resign({
    ...fixture.descriptor,
    resourcesDigest: captured.digest,
    exports: fixture.descriptor.exports.map((entry) => ({
      ...entry,
      resources: entry.resources.map((use) =>
        use.role === 'body' ? { ...use, delivery: 'installed-reference' as const } : use,
      ),
    })),
  });
  const result = compileProjection(fixture.capture, descriptor, captured, {
    ...fixture.options,
    expectedResourcesDigest: captured.digest,
  });
  expect(result.status).toBe('compiled');
  if (result.status === 'compiled')
    expect(result.files.find((file) => file.path === 'skills/fictional-review/SKILL.md')!.content).toContain(
      '# Review',
    );
});

describe('Codex projections through the shared compiler', () => {
  it('emits native workspace agents and explicit command skills with the same native closure', () => {
    const f = asCodex(fixture, 'workspace'),
      result = compiled(f),
      claude = compiled();
    expect(result.files).toHaveLength(12);
    expect(result.manifest.exports).toEqual(claude.manifest.exports);
    const agent = result.files.find((v) => v.path === '.codex/agents/fictional-reviewer.toml')!.content;
    expect(agent).toContain('name = "fictional-reviewer"');
    expect(agent).not.toContain('\nmodel =');
    expect(agent).not.toContain('\ntools =');
    expect(result.files.find((v) => v.path === '.codex/config.toml')!.content).toContain(
      'config_file = "agents/fictional-reviewer.toml"',
    );
    for (const value of [
      'fictional-concise',
      'fictional-read-only',
      'fictional-review-details',
      'when phase is act',
      'category is process',
      'review@',
    ])
      expect(codexBody(agent)).toContain(value);
    expect(result.files.find((v) => v.path === '.agents/skills/fictional-check/agents/openai.yaml')!.content).toContain(
      'allow_implicit_invocation: false',
    );
    expect(
      result.files.find((v) => v.path === '.agents/skills/fictional-review/agents/openai.yaml')!.content,
    ).toContain('allow_implicit_invocation: true');
    const command = result.files.find((v) => v.path === '.agents/skills/fictional-check/SKILL.md')!.content;
    expect(command).toContain('topic -> topic (required text)');
    expect(command).not.toContain('$ARGUMENTS');
    expect(command).not.toContain('disable-model-invocation');
    expect(result.files.some((v) => v.path.includes('.claude') || v.path.includes('plugin.json'))).toBe(false);
    expect(existsSync(join(f.project, '.codex'))).toBe(false);
  });

  it('maps plugin agents to disclosed explicit-only role skills and emits a Codex manifest', () => {
    const f = asCodex(),
      result = compiled(f);
    expect(result.files).toHaveLength(15);
    const role = result.files.find((v) => v.path === 'skills/fictional-reviewer/SKILL.md')!.content;
    expect(role).toContain('## Role skill');
    expect(role).toContain('does not register or spawn a custom Codex agent');
    expect(role).toContain('fictional-concise');
    expect(role).toContain('fictional-read-only');
    expect(result.files.find((v) => v.path === 'skills/fictional-reviewer/agents/openai.yaml')!.content).toContain(
      'allow_implicit_invocation: false',
    );
    expect(JSON.parse(result.files.find((v) => v.path === '.codex-plugin/plugin.json')!.content)).toEqual({
      name: 'fictional-review',
      version: '0.1.0',
      description: 'Generated native prose projections.',
      skills: './skills/',
    });
    expect(result.manifest.enforcement).toContainEqual({
      feature: 'agent-presentation',
      level: 'guidance',
      evidence: expect.stringContaining('role skills'),
    });
    expect(
      result.manifest.outputs.filter((v) => v.role === 'host-metadata' && v.path.endsWith('/agents/openai.yaml')),
    ).toHaveLength(3);
    expect(result.files.some((v) => v.path.endsWith('.toml') || v.path.startsWith('agents/'))).toBe(false);
  });

  it.each(['workspace', 'plugin'] as const)(
    'retains deterministic hashes, exact resources and relocated links in %s output',
    (product) => {
      const f = asCodex(fixture, product),
        result = compiled(f);
      expect(
        serializeProjection(f.capture, JSON.stringify(f.descriptor), JSON.stringify(f.resources), f.options),
      ).toEqual(result);
      const directory = join(temporary, 'codex-' + product),
        relocated = directory + '-relocated';
      for (const file of result.files) {
        const target = join(directory, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(file.content, file.encoding));
      }
      cpSync(directory, relocated, { recursive: true });
      for (const file of result.files) {
        expect(sha256(readFileSync(join(relocated, file.path)))).toBe(file.sha256);
        expect(result.manifest.outputs.find((v) => v.path === file.path)).toMatchObject({
          sha256: file.sha256,
          bytes: file.bytes,
        });
      }
      // The same shared walk: Markdown files, decoded agent instructions and config.toml registrations.
      expect(linkProblems(relocated, result.files)).toEqual([]);
      expect(linkCounts(result.files)).toMatchObject({ external: 2, fragment: 1, unsupported: 0 });
      for (const resource of f.resources.files)
        expect(result.files.find((v) => v.path.endsWith('/' + resource.key.path))!.content).toBe(resource.content);
      expect(Object.isFrozen(result.files)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(temporary);
    },
  );

  it('shares scope, resource, inventory and implementation pin refusals', () => {
    const f = asCodex();
    for (const override of [
      { within: 'forged' },
      { within: f.reader.resolveScope({ identities: [f.owner('fictional-reviewer').identity] }).token },
      { allowedResources: [] },
      { expectedResourcesDigest: '0'.repeat(64) },
      { inventoryDigest: '0'.repeat(64) },
      {
        catalog: {
          ...f.options.catalog,
          profile: { ...f.options.catalog.profile, implementationDigest: '0'.repeat(64) },
        },
      },
    ]) {
      const result = compileProjection(f.capture, f.descriptor, f.resources, { ...f.options, ...override });
      expect(result.status).toBe('refused');
      expect(result).not.toHaveProperty('files');
    }
  });

  it('refuses native plugin-agent requirements and unsupported permission/evidence mappings', () => {
    const f = asCodex();
    for (const feature of ['native-agents', 'tool-allowlist']) {
      const descriptor = resign({
        ...f.descriptor,
        exports: f.descriptor.exports.map((e) =>
          e.id === 'reviewer' ? { ...e, requirements: [{ feature, minimumEvidence: 'generated' as const }] } : e,
        ),
      });
      refused(descriptor, f.options, 'IA-PROJECTION-FEATURE-UNAVAILABLE');
      const result = compiled(
        f,
        resign({
          ...descriptor,
          exports: descriptor.exports.map((e) => (e.id === 'reviewer' ? { ...e, required: false } : e)),
        }),
      );
      expect(result.manifest.omissions).toHaveLength(1);
      expect(result.files.some((v) => v.path.includes('fictional-reviewer'))).toBe(false);
      if (feature === 'native-agents')
        expect(
          compiled(f, resign({ ...descriptor, product: 'workspace' })).files.some((v) => v.path.endsWith('.toml')),
        ).toBe(true);
    }
    refused(
      resign({
        ...f.descriptor,
        exports: f.descriptor.exports.map((e) => ({
          ...e,
          requirements: [{ feature: 'skills', minimumEvidence: 'process' as const }],
        })),
      }),
      f.options,
      'IA-PROJECTION-FEATURE-UNAVAILABLE',
    );
    refused(
      resign({
        ...f.descriptor,
        exports: f.descriptor.exports.map((e) =>
          e.presentation.kind === 'command'
            ? {
                ...e,
                presentation: {
                  ...e.presentation,
                  arguments: [{ ...e.presentation.arguments[0]!, type: 'boolean' as const }],
                },
              }
            : e,
        ),
      }),
      f.options,
      'IA-PROJECTION-FEATURE-UNAVAILABLE',
    );
  });

  it('checks role-skill collisions in the shared plugin invocation namespace', () => {
    const f = asCodex(),
      descriptor = resign({
        ...f.descriptor,
        exports: f.descriptor.exports.map((e) => (e.id === 'reviewer' ? { ...e, outputName: 'fictional-review' } : e)),
      });
    refused(descriptor, f.options, 'IA-PROJECTION-INPUT-INVALID');
    expect(
      compiled(f, resign({ ...descriptor, product: 'workspace' })).files.some(
        (v) => v.path === '.codex/agents/fictional-review.toml',
      ),
    ).toBe(true);
  });

  it('escapes native agent instructions as one TOML string and supports explicit workspace models only', () => {
    const f = asCodex(
      setup(undefined, '# Quoted\n\nA "quoted" value, a backslash \\ and unicode café.\n'),
      'workspace',
    );
    const catalog = codexProseCatalog('a'.repeat(64), {
      models: [{ id: 'inherit', name: 'host-selected-model' }],
      tools: f.options.catalog.tools,
      inputFields: f.options.catalog.inputFields,
    });
    const options = { ...f.options, catalog },
      result = compiled(f, f.descriptor, options);
    const agent = result.files.find((v) => v.path.startsWith('.codex/agents/'))!.content;
    expect(agent).toContain('model = "host-selected-model"');
    expect(codexBody(agent)).toContain('A "quoted" value, a backslash \\ and unicode café.');
    const plugin = resign({ ...f.descriptor, product: 'plugin' });
    expect(compileProjection(f.capture, plugin, f.resources, options)).toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }],
    });
  });

  it('retains shared cycle and executable-content refusals for both Codex products', () => {
    for (const original of [
      setup((source) =>
        source.replace(
          'playbooks [@playbook fictional-review-method]',
          'playbooks [@playbook fictional-review-method]\n    includes [@capability fictional-review]',
        ),
      ),
      setup(undefined, '# Unsafe\n\n!`echo should-never-run`\n'),
      setup(undefined, '# Missing\n\n[missing](missing.md)\n'),
    ]) {
      for (const product of ['workspace', 'plugin'] as const) {
        const f = asCodex(original, product),
          result = compileProjection(f.capture, f.descriptor, f.resources, f.options);
        expect(result.status).toBe('refused');
        expect(result).not.toHaveProperty('files');
      }
    }
  });

  it('refuses reserved agent keys and empty descriptions even for optional exports', () => {
    const f = asCodex(fixture, 'workspace');
    for (const change of [{ outputName: 'enabled' }, { description: ' ' }, { description: 'bad\u0000description' }]) {
      const descriptor = resign({
        ...f.descriptor,
        exports: f.descriptor.exports.map((e) => (e.id === 'reviewer' ? { ...e, required: false, ...change } : e)),
      });
      refused(descriptor, f.options, 'IA-PROJECTION-INPUT-INVALID');
    }
  });

  it('does not register omitted workspace agents or leave their policy sidecars behind', () => {
    for (const product of ['workspace', 'plugin'] as const) {
      const f = asCodex(fixture, product),
        descriptor = resign({
          ...f.descriptor,
          exports: f.descriptor.exports.map((e) =>
            e.id === 'reviewer'
              ? { ...e, required: false, requirements: [{ feature: 'agents', minimumEvidence: 'live-host' as const }] }
              : e,
          ),
        });
      const result = compiled(f, descriptor);
      expect(result.manifest.omissions).toHaveLength(1);
      expect(result.files.some((v) => v.path.includes('fictional-reviewer') || v.path === '.codex/config.toml')).toBe(
        false,
      );
    }
  });

  it('counts Codex policy sidecars toward the total output limit', () => {
    const f = asCodex(),
      skill = f.descriptor.exports.find((e) => e.id === 'review')!;
    const exports = Array.from({ length: 128 }, (_, i) => ({
      ...skill,
      id: 'review-' + String(i).padStart(3, '0'),
      outputName: 'review-' + String(i).padStart(3, '0'),
    }));
    refused(resign({ ...f.descriptor, exports }), f.options, 'IA-PROJECTION-INPUT-INVALID');
  });

  it('builds one native context per verified capture, whatever the export count or entry point', () => {
    const f = asCodex(),
      skill = f.descriptor.exports.find((e) => e.id === 'review')!;
    const exports = Array.from({ length: 12 }, (_, i) => ({
      ...skill,
      id: 'review-' + String(i).padStart(3, '0'),
      outputName: 'review-' + String(i).padStart(3, '0'),
    }));
    clearNativeContexts();
    const many = countRebuilds(() =>
      compileProjection(f.capture, resign({ ...f.descriptor, exports }), f.resources, f.options),
    );
    expect(many.value.status).toBe('compiled');
    expect(many.rebuilds).toBe(1);
    // Later compiles, refusals and direct public entry points on the same capture reuse that context.
    expect(countRebuilds(() => compiled()).rebuilds).toBe(0);
    expect(
      countRebuilds(() =>
        refused(fixture.descriptor, { ...fixture.options, allowedResources: [] }, 'IA-RESOURCE-INVALID'),
      ).rebuilds,
    ).toBe(0);
    const resolveOptions = {
      reader: f.reader,
      within: f.options.within,
      owners: [],
      allowedResources: f.options.allowedResources,
      expectedDigest: f.resources.digest,
      maxBytes: 1024 * 1024,
    };
    const direct: (() => unknown)[] = [
      () => resourceOccurrences(f.capture),
      () => verifyResources(f.resources, f.capture),
      () => resolveResources(f.resources, f.capture, resolveOptions),
    ];
    for (const run of direct) expect(countRebuilds(run).rebuilds).toBe(0);
    // A refusal on a cold cache still costs exactly one rebuild.
    clearNativeContexts();
    expect(
      countRebuilds(() =>
        refused(fixture.descriptor, { ...fixture.options, allowedResources: [] }, 'IA-RESOURCE-INVALID'),
      ).rebuilds,
    ).toBe(1);
  });

  // Runs a hook once the "reviewer" agent export resolves its profile's voice; no earlier export needs that record.
  function atReviewerExport(onReviewer: () => void): typeof fixture.reader {
    let reached = false;
    return new Proxy(fixture.reader, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'resolve' && typeof value === 'function')
          return (reference: { discriminator?: string; name?: string }, ...rest: unknown[]) => {
            if (!reached && reference.discriminator === 'voice' && reference.name === 'fictional-concise') {
              reached = true;
              onReviewer();
            }
            return (value as (...a: unknown[]) => unknown).apply(target, [reference, ...rest]);
          };
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  it('still fails closed when the host view changes between exports', () => {
    const stale = (optional: boolean) => {
      let changed = false;
      const inner = atReviewerExport(() => {
        changed = true;
      });
      const reader = new Proxy(inner, {
        get: (target, key) => (key === 'revision' && changed ? '0'.repeat(64) : (Reflect.get(target, key) as unknown)),
      });
      const descriptor = optional
        ? resign({ ...fixture.descriptor, exports: fixture.descriptor.exports.map((e) => ({ ...e, required: false })) })
        : fixture.descriptor;
      return compileProjection(fixture.capture, descriptor, fixture.resources, { ...fixture.options, reader });
    };
    expect(stale(false)).toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'IA-RESOURCE-INVALID', message: expect.stringContaining('Native resource view differs') }],
    });
    const partial = stale(true);
    if (partial.status !== 'compiled') throw new Error(JSON.stringify(partial));
    expect(partial.manifest.exports.map((e) => e.id)).toEqual(['check', 'review']);
    expect(partial.manifest.omissions.map((o) => [o.export, o.reason])).toEqual([
      ['reviewer', 'IA-RESOURCE-INVALID: Native resource view differs from the captured source generation'],
    ]);
  });

  it('reads the caller capture once, so a mid-compile mutation cannot reach any later check', () => {
    const capture = structuredClone(fixture.capture),
      expected = compiled();
    let mutated = false;
    const reader = atReviewerExport(() => {
      capture.revision = '0'.repeat(64);
      capture.sources = [];
      mutated = true;
    });
    expect(compileProjection(capture, fixture.descriptor, fixture.resources, { ...fixture.options, reader })).toEqual(
      expected,
    );
    expect(mutated).toBe(true);
  });

  it('checks the final TOML byte limit after escaping instructions', () => {
    const f = asCodex(setup(undefined, '"'.repeat(600_000)), 'workspace');
    const result = compileProjection(f.capture, f.descriptor, f.resources, f.options);
    expect(result).toMatchObject({ status: 'refused', diagnostics: [{ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE' }] });
    expect(result).not.toHaveProperty('files');
  });
});

// HOST-01 (private source history): the existing emitted Claude/Codex workspace and plugin products for the public synthetic
// fixture, compiled with the canonical descriptor of tools/projections/fixtures/compile-prose.mjs. Exact output hashes
// are revision-bound evidence in docs/reports/host-projection-baseline, never pinned here.
describe('HOST-01 emitted projection baseline', () => {
  const DESCRIPTION = 'Review fictional notes with source evidence.',
    INVENTORY = metadataDigest({ fixture: 'original-public-prose' });
  const PRODUCTS = [
    ['claude', 'workspace'],
    ['claude', 'plugin'],
    ['codex', 'workspace'],
    ['codex', 'plugin'],
  ] as const;
  type Host = (typeof PRODUCTS)[number][0];
  type Product = (typeof PRODUCTS)[number][1];

  /** The packed qualification's descriptor: real guide bytes, no requirements, no prompt patterns, public inventory digest. */
  function baseline(host: Host, product: Product, f: Fixture = setup(undefined, null)): Fixture {
    const hosted = host === 'codex' ? asCodex(f, product) : f;
    const exports = hosted.descriptor.exports.map((e) => ({
      ...e,
      description: DESCRIPTION,
      requirements: [],
      presentation: e.presentation.kind === 'skill' ? { ...e.presentation, patterns: [] } : e.presentation,
    }));
    return {
      ...hosted,
      descriptor: resign({ ...hosted.descriptor, product, inventoryDigest: INVENTORY, exports }),
      options: { ...hosted.options, inventoryDigest: INVENTORY },
    };
  }
  /** The exact product inventory: output path -> manifest role. */
  function inventory(f: Fixture, host: Host, product: Product): Record<string, string> {
    const owner = f.owner('fictional-review'),
      references = `resources/${f.resources.digest}/${owner.source}/${owner.revision}/references/`;
    const resources = { [references + 'examples/note.md']: 'resource', [references + 'review-guide.md']: 'resource' };
    const parts = (directory: string) => ({
      [`${directory}/parts/resources.md`]: 'host-metadata',
      [`${directory}/scripts/verify-resources.mjs`]: 'host-metadata',
    });
    if (host === 'claude') {
      const root = product === 'workspace' ? '.claude/' : '';
      return {
        ...resources,
        ...parts(root + 'skills/fictional-review'),
        [root + 'agents/fictional-reviewer.md']: 'agent',
        [root + 'commands/fictional-check.md']: 'command',
        [root + 'skills/fictional-review/SKILL.md']: 'skill',
        ...(product === 'plugin' ? { '.claude-plugin/plugin.json': 'plugin' } : {}),
      };
    }
    const skills = product === 'workspace' ? '.agents/skills/' : 'skills/';
    const shared = {
      ...resources,
      ...parts(skills + 'fictional-check'),
      ...parts(skills + 'fictional-review'),
      [skills + 'fictional-check/SKILL.md']: 'command',
      [skills + 'fictional-check/agents/openai.yaml']: 'host-metadata',
      [skills + 'fictional-review/SKILL.md']: 'skill',
      [skills + 'fictional-review/agents/openai.yaml']: 'host-metadata',
    };
    return product === 'workspace'
      ? { ...shared, '.codex/agents/fictional-reviewer.toml': 'agent', '.codex/config.toml': 'host-metadata' }
      : {
          ...shared,
          ...parts('skills/fictional-reviewer'),
          'skills/fictional-reviewer/SKILL.md': 'agent',
          'skills/fictional-reviewer/agents/openai.yaml': 'host-metadata',
          '.codex-plugin/plugin.json': 'plugin',
        };
  }

  it.each(PRODUCTS)(
    'inventories the %s %s product with exact files, roles, closures and guidance-only enforcement',
    (host, product) => {
      const f = baseline(host, product),
        result = compiled(f),
        expected = inventory(f, host, product);
      expect(result.files.map((file) => file.path)).toEqual(Object.keys(expected).sort());
      expect(Object.fromEntries(result.manifest.outputs.map((o) => [o.path, o.role]))).toEqual(expected);
      // Product metadata: the plugin manifest holds only a name, version and fixed description, with no author; Codex adds its skills root.
      if (product === 'plugin')
        expect(JSON.parse(result.files.find((file) => file.path === `.${host}-plugin/plugin.json`)!.content)).toEqual({
          name: 'fictional-review',
          version: '0.1.0',
          description: 'Generated native prose projections.',
          ...(host === 'codex' ? { skills: './skills/' } : {}),
        });
      const closure = (id: string) =>
        result.manifest.exports.find((e) => e.id === id)!.closure.map((o) => o.identity.split('/').pop());
      expect(closure('check')).toEqual(['fictional-review-method', 'fictional-evidence']);
      expect(closure('review')).toEqual([
        'fictional-review-method',
        'fictional-evidence',
        'fictional-review-details',
        'fictional-review',
      ]);
      expect(closure('reviewer')).toEqual([
        'fictional-reviewer',
        'fictional-concise',
        'fictional-read-only',
        'fictional-review-method',
        'fictional-evidence',
        'fictional-review-details',
        'fictional-review',
        'fictional-review-profile',
      ]);
      expect(JSON.stringify(result.files)).not.toContain('fictional-review-steward');
      expect(result.manifest.omissions).toEqual([]);
      expect(result.manifest.enforcement).toEqual([
        {
          feature: 'prose-projection',
          level: 'guidance',
          evidence: `generated:ia.host.${host}-prose.v1; installed/live-host qualification not established`,
        },
        host === 'claude'
          ? CLAUDE_AGENT_PRESENTATION
          : {
              feature: 'agent-presentation',
              level: 'guidance',
              evidence:
                product === 'workspace'
                  ? 'native workspace TOML agents; tool intent is guidance, not an enforced allowlist'
                  : 'explicit role skills; no native custom-agent registration or model/tool override',
            },
      ]);
    },
  );

  type Compiled = Extract<ProjectionResult, { status: 'compiled' }>;
  /** One export kind's entry file; a Codex workspace agent's instructions are decoded from its TOML string. */
  function entry(result: Compiled, role: 'agent' | 'skill' | 'command'): { path: string; text: string } {
    const output = result.manifest.outputs.find((o) => o.role === role)!,
      file = result.files.find((v) => v.path === output.path)!;
    return { path: file.path, text: file.path.endsWith('.toml') ? codexBody(file.content) : file.content };
  }
  const sidecar = (result: Compiled, name: string): string =>
    result.files.find((v) => v.path.endsWith(`${name}/agents/openai.yaml`))!.content;

  it.each(PRODUCTS)(
    'maps role, voice, profile, capability, skill, command and resources in the %s %s product as the matrix records',
    (host, product) => {
      const f = baseline(host, product),
        result = compiled(f);
      const agent = entry(result, 'agent'),
        skill = entry(result, 'skill'),
        command = entry(result, 'command');
      const guide = f.resources.files.find((r) => r.key.path === 'references/review-guide.md')!;
      for (const { text } of [agent, skill, command]) {
        // Contract (#445): method, convention and the inlined guide are prose in every export, and native activation stays text,
        // never a host trigger. Runtime context selection evaluates activation (SPEC.md, PT2); no prose profile derives triggers from it.
        for (const value of [
          '## @playbook fictional-review-method',
          'activate (when category is process): ',
          'requires (when phase is act): Cite the observed outcome.',
          `Source: ${guide.key.source}@${guide.key.revision}:${guide.key.path}#sha256=${guide.sha256}`,
          'Reference (example; required package member): [references/examples/note.md]',
        ])
          expect(text).toContain(value);
        // Method cells render as phase/Primitive (primary) followed by their authored text.
        expect(text).toContain(
          '### cognition\n\norient/Attention (primary): Locate the named owner and stated outcome.\n\nact/Decision (primary): Report gaps with citations and a proposed next action.\n',
        );
        expect(text).not.toContain('## When to invoke');
      }
      // Voice, profile and mandate are prose in the role only; capability effects are text, not tool grants.
      for (const heading of [
        '## @voice fictional-concise',
        '## @agent-profile fictional-review-profile',
        '## @mandate fictional-read-only',
      ]) {
        expect(agent.text).toContain(heading);
        expect(skill.text).not.toContain(heading);
        expect(command.text).not.toContain(heading);
      }
      for (const { text } of [agent, skill]) {
        expect(text).toContain('## @capability fictional-review\n');
        expect(text).toContain('effects: read');
      }
      expect(command.text).not.toContain('## @capability');
      const skillHead =
        '---\nname: fictional-review\ndescription: "Review fictional notes with source evidence."\n---\n';
      expect(skill.text.slice(0, skillHead.length)).toBe(skillHead);
      if (host === 'claude') {
        const roleHead = '---\nname: fictional-reviewer\ndescription: "Review fictional notes with source evidence."\n';
        expect(agent.text.slice(0, roleHead.length)).toBe(roleHead);
        expect(agent.text).toContain('\nmodel: inherit\ntools: "Read"\n---\n');
        expect(command.text).toContain('\ndisable-model-invocation: true\nargument-hint: "[topic]"\n---\n');
        expect(command.text).toContain('- topic (required text): $ARGUMENTS[0]');
      } else {
        expect(agent.text).toContain(
          '## Tool intent\n\nRequested tool capabilities: read. These names describe intent, not a Codex tool allowlist.',
        );
        expect(command.text).toContain('- Input 1: topic -> topic (required text).');
        expect(command.text).not.toContain('$ARGUMENTS');
        expect(sidecar(result, 'fictional-review')).toContain('allow_implicit_invocation: true');
        expect(sidecar(result, 'fictional-check')).toContain('allow_implicit_invocation: false');
        if (product === 'workspace') {
          expect(result.files.find((v) => v.path === agent.path)!.content).not.toContain('\nmodel =');
          expect(result.files.find((v) => v.path === '.codex/config.toml')!.content).toBe(
            '[agents."fictional-reviewer"]\ndescription = "Review fictional notes with source evidence."\nconfig_file = "agents/fictional-reviewer.toml"\n',
          );
        } else {
          expect(agent.text).toContain('This skill does not register or spawn a custom Codex agent.');
          expect(sidecar(result, 'fictional-reviewer')).toContain('allow_implicit_invocation: false');
        }
      }
    },
  );

  const owned: string[] = [];
  afterAll(() => {
    for (const root of owned) {
      if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('ia-host-'))
        throw new Error('Unsafe fixture cleanup');
      rmSync(root, { recursive: true, force: true });
    }
  });
  /** A fresh root outside the suite's fixture tree, so it is no sibling of any fixture source. */
  function ownedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'ia-host-'));
    owned.push(root);
    return root;
  }
  /**
   * Product-relative targets of every local Markdown link (Codex TOML instructions decoded) and Codex agent registration.
   * Scheme-qualified links (the serializer passes https: and mailto: through) and fragment-only links name no product file.
   */
  function targets(file: { path: string; content: string }): string[] {
    const toml = file.path.endsWith('.toml'),
      text = toml && file.content.includes('developer_instructions = ') ? codexBody(file.content) : file.content;
    const links = [...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g)]
      .map((m) => m[1] ?? m[2]!)
      .filter((raw) => !/^[a-z][a-z0-9+.-]*:/i.test(raw))
      .map((raw) => decodeURIComponent(raw).split('#')[0]!)
      .filter((path) => path !== '');
    const registrations = toml ? [...file.content.matchAll(/^config_file = "([^"]+)"$/gm)].map((m) => m[1]!) : [];
    return [...links, ...registrations].map((link) => posix.normalize(posix.join(posix.dirname(file.path), link)));
  }
  /** Every target that is missing, resolves outside root through any alias, or is not a regular file. */
  function escapes(root: string, files: readonly { path: string; content: string }[]): string[] {
    const inside = realpathSync(root) + sep,
      problems: string[] = [];
    for (const file of files)
      for (const target of targets(file)) {
        const path = join(root, target);
        if (!existsSync(path)) problems.push(`${file.path}: missing ${target}`);
        else if (!realpathSync(path).startsWith(inside)) problems.push(`${file.path}: escapes ${target}`);
        else if (!lstatSync(path).isFile()) problems.push(`${file.path}: not a regular file ${target}`);
      }
    return problems;
  }

  it('reports relocation targets that are missing or leave the product root', () => {
    const outside = ownedRoot(),
      root = ownedRoot(),
      leaving = `../${basename(outside)}/source.md`;
    writeFileSync(join(outside, 'source.md'), '# Source\n');
    mkdirSync(join(root, 'folder'));
    // Scheme-qualified and fragment-only links are skipped; the directory exists inside the root but is no regular file.
    const file = {
      path: 'note.md',
      content: `[leaving](<${leaving}>) and [missing](missing.md), [site](<https://example.test/guide>), [mail](mailto:owner@example.test), [top](<#top>) and [folder](<folder>)\n`,
    };
    writeFileSync(join(root, file.path), file.content);
    expect(targets(file)).toEqual([leaving, 'missing.md', 'folder']);
    expect(escapes(root, [file])).toEqual([
      `note.md: escapes ${leaving}`,
      'note.md: missing missing.md',
      'note.md: not a regular file folder',
    ]);
  });

  it.each(PRODUCTS)(
    'keeps every required resource reachable after relocating the %s %s product away from its deleted source',
    (host, product) => {
      const f = baseline(host, product),
        result = compiled(f),
        staged = join(f.base, 'staged'),
        relocated = ownedRoot();
      for (const file of result.files) {
        const path = join(staged, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(file.content, file.encoding));
      }
      cpSync(staged, relocated, { recursive: true });
      // Remove the staged copy, the fixture source and the project: nothing outside the relocated root can satisfy a link.
      f.reader.close();
      rmSync(f.base, { recursive: true, force: true });
      expect(existsSync(f.fixture)).toBe(false);
      expect(escapes(relocated, result.files)).toEqual([]);
      for (const file of result.files)
        expect(sha256(readFileSync(join(relocated, file.path))), file.path).toBe(file.sha256);
      for (const output of result.manifest.outputs.filter((o) => ['agent', 'skill', 'command'].includes(o.role))) {
        const required = f.resources.files.map(
          (r) => `resources/${f.resources.digest}/${r.key.source}/${r.key.revision}/${r.key.path}`,
        );
        expect(targets(result.files.find((v) => v.path === output.path)!), output.path).toEqual(
          expect.arrayContaining(required),
        );
      }
      for (const path of [relocated, f.base, repository]) expect(JSON.stringify(result.files)).not.toContain(path);
      if (host === 'codex' && product === 'plugin')
        expect(statSync(join(relocated, 'skills')).isDirectory()).toBe(true);
    },
  );

  it.each(PRODUCTS)(
    'emits byte-identical %s %s products from independent source roots and JSON transport',
    (host, product) => {
      const first = baseline(host, product),
        second = baseline(host, product),
        expected = compiled(first);
      expect(second.base).not.toBe(first.base);
      // The native-context cache is keyed by capture content; clear it so the second root's compile rebuilds its own context.
      clearNativeContexts();
      const again = countRebuilds(() => compiled(second));
      expect(again.rebuilds).toBe(1);
      expect(again.value).toEqual(expected);
      expect(
        serializeProjection(
          second.capture,
          JSON.stringify(second.descriptor),
          JSON.stringify(second.resources),
          second.options,
        ),
      ).toEqual(expected);
    },
  );

  /** One refused diagnostic. Every row shares the code, so only the fixed message names the check that decided it. */
  type Refusal = { readonly code: ProjectionCode; readonly message: string };
  type Outcomes = Record<`${Host}:${Product}`, 'compiled' | Refusal>;
  const unavailable = (message: string): Refusal => ({ code: 'IA-PROJECTION-FEATURE-UNAVAILABLE', message });
  // The fixed messages of checkFeatures (src/projection-host.ts:54-65); none varies with the host or product that refuses.
  const EVIDENCE = unavailable('Required feature/evidence is unavailable in the prose profile'),
    BINDING = unavailable('Executable binding projection is unavailable in the prose profile');
  const CATALOG = unavailable('Model or tool metadata is absent from the host catalog'),
    RESTRICTED = unavailable('Empty tool sets and delegated-agent restrictions are not qualified by this profile');
  const TYPED = unavailable('Typed argument mapping is unavailable in the host catalog'),
    TRIGGER = unavailable('This profile supports prompt-literal guidance only');
  // The fixed messages of the host-tool effect ceiling (#444) in NativeClosure.export (src/projections.ts).
  const sourceUnavailable = (message: string): Refusal => ({ code: 'IA-PROJECTION-SOURCE-UNAVAILABLE', message });
  const NO_PROFILE = sourceUnavailable('Host tools need native capability effects from an agent profile'),
    EXCEEDS = sourceUnavailable('Host tools exceed the native capability effects');
  const everywhere = (outcome: 'compiled' | Refusal): Outcomes => ({
    'claude:workspace': outcome,
    'claude:plugin': outcome,
    'codex:workspace': outcome,
    'codex:plugin': outcome,
  });
  const withRequirement =
    (feature: string, minimumEvidence: 'generated' | 'process' | 'live-host' = 'generated') =>
    (e: ProjectionExport): ProjectionExport => ({ ...e, requirements: [{ feature, minimumEvidence }] });
  const withAgent =
    (change: { tools?: string[]; delegates?: string[]; model?: string }) =>
    (e: ProjectionExport): ProjectionExport =>
      e.presentation.kind === 'agent' ? { ...e, presentation: { ...e.presentation, ...change } } : e;
  const withoutProfile = (e: ProjectionExport): ProjectionExport => {
    if (e.presentation.kind !== 'agent') return e;
    const { agentProfile: _agentProfile, ...presentation } = e.presentation;
    return { ...e, presentation };
  };
  /** Adds host catalog entries (Claude names capitalized, Codex names lowercase); a catalog entry only maps an id to a name. */
  function withCatalogTools(f: Fixture, host: Host, tools: readonly string[]): Fixture {
    const create = host === 'claude' ? claudeProseCatalog : codexProseCatalog,
      extra = tools.map((id) => ({ id, name: host === 'claude' ? id[0]!.toUpperCase() + id.slice(1) : id }));
    return {
      ...f,
      options: {
        ...f.options,
        catalog: create('a'.repeat(64), {
          models: f.options.catalog.models,
          tools: [...f.options.catalog.tools, ...extra],
          inputFields: f.options.catalog.inputFields,
        }),
      },
    };
  }
  const withTrigger =
    (kind: 'path-glob' | 'command-prefix' | 'import-prefix') =>
    (e: ProjectionExport): ProjectionExport =>
      e.presentation.kind === 'skill'
        ? { ...e, presentation: { ...e.presentation, patterns: [{ kind, value: 'notes', priority: 0 }] } }
        : e;
  const withArgument =
    (type: 'boolean' | 'integer') =>
    (e: ProjectionExport): ProjectionExport =>
      e.presentation.kind === 'command'
        ? {
            ...e,
            presentation: { ...e.presentation, arguments: e.presentation.arguments.map((a) => ({ ...a, type })) },
          }
        : e;
  /**
   * `tools` adds host catalog entries for the row; `emits` is the agent text a compiled product must contain; `agentFile` is the
   * host-native agent file a compiled product emits, with every output byte equal to the product without the change.
   */
  const ROWS: readonly {
    name: string;
    id: string;
    change: (e: ProjectionExport) => ProjectionExport;
    outcomes: Outcomes;
    tools?: readonly string[];
    emits?: Record<Host, string>;
    agentFile?: Partial<Record<`${Host}:${Product}`, string>>;
  }[] = [
    {
      name: 'process evidence',
      id: 'review',
      change: withRequirement('resources', 'process'),
      outcomes: everywhere(EVIDENCE),
    },
    {
      name: 'live-host evidence',
      id: 'reviewer',
      change: withRequirement('resources', 'live-host'),
      outcomes: everywhere(EVIDENCE),
    },
    // #443: an agent export is a host-native agent file in both Claude products and the Codex workspace; the Codex plugin adapts roles to explicit skills.
    {
      name: 'a native-agents requirement',
      id: 'reviewer',
      change: withRequirement('native-agents'),
      outcomes: { ...everywhere('compiled'), 'codex:plugin': EVIDENCE },
      agentFile: {
        'claude:workspace': '.claude/agents/fictional-reviewer.md',
        'claude:plugin': 'agents/fictional-reviewer.md',
        'codex:workspace': '.codex/agents/fictional-reviewer.toml',
      },
    },
    {
      name: 'an agent-role-skills requirement',
      id: 'reviewer',
      change: withRequirement('agent-role-skills'),
      outcomes: { ...everywhere(EVIDENCE), 'codex:plugin': 'compiled' },
    },
    {
      name: 'a tool-allowlist requirement',
      id: 'reviewer',
      change: withRequirement('tool-allowlist'),
      outcomes: everywhere(EVIDENCE),
    },
    {
      name: 'an executable binding',
      id: 'review',
      change: (e) => ({ ...e, binding: e.target }),
      outcomes: everywhere(BINDING),
    },
    { name: 'an empty tool set', id: 'reviewer', change: withAgent({ tools: [] }), outcomes: everywhere(RESTRICTED) },
    {
      name: 'delegated agents',
      id: 'reviewer',
      change: withAgent({ delegates: ['fictional-helper'] }),
      outcomes: everywhere(RESTRICTED),
    },
    {
      name: 'a model absent from the host catalog',
      id: 'reviewer',
      change: withAgent({ model: 'fictional-model' }),
      outcomes: everywhere(CATALOG),
    },
    { name: 'a path-glob trigger', id: 'review', change: withTrigger('path-glob'), outcomes: everywhere(TRIGGER) },
    {
      name: 'a command-prefix trigger',
      id: 'review',
      change: withTrigger('command-prefix'),
      outcomes: everywhere(TRIGGER),
    },
    {
      name: 'an import-prefix trigger',
      id: 'review',
      change: withTrigger('import-prefix'),
      outcomes: everywhere(TRIGGER),
    },
    { name: 'a boolean argument', id: 'check', change: withArgument('boolean'), outcomes: everywhere(TYPED) },
    { name: 'an integer argument', id: 'check', change: withArgument('integer'), outcomes: everywhere(TYPED) },
    // #444: the agent profile's capabilities declare `effects [read]`, and v1 maps read to the read, glob and grep tool ids.
    {
      name: 'an agent export without an agent profile',
      id: 'reviewer',
      change: withoutProfile,
      outcomes: everywhere(NO_PROFILE),
    },
    {
      name: 'glob and grep within the read effect',
      id: 'reviewer',
      tools: ['glob', 'grep'],
      change: withAgent({ tools: ['read', 'glob', 'grep'] }),
      outcomes: everywhere('compiled'),
      emits: { claude: '\ntools: "Read, Glob, Grep"\n', codex: 'Requested tool capabilities: read, glob, grep.' },
    },
    {
      name: 'a bash tool beyond the read effect',
      id: 'reviewer',
      tools: ['bash'],
      change: withAgent({ tools: ['read', 'bash'] }),
      outcomes: everywhere(EXCEEDS),
    },
  ];
  it.each(ROWS)(
    'keeps $name visible: where a product lacks it, the required export refuses with its exact diagnostic and the optional one records one omission without orphan files',
    ({ id, change, outcomes, tools, emits, agentFile }) => {
      const source = setup(undefined, null);
      const cells = PRODUCTS.map(([host, product]) => {
        const base = baseline(host, product, source),
          f = tools ? withCatalogTools(base, host, tools) : base;
        const mutated = (required: boolean) =>
          resign({
            ...f.descriptor,
            exports: f.descriptor.exports.map((e) => (e.id === id ? { ...change(e), required } : e)),
          });
        return {
          host,
          product,
          f,
          mutated,
          result: compileProjection(f.capture, mutated(true), f.resources, f.options),
        };
      });
      // Every product's outcome at once, so a failure names each product that differs.
      expect(
        Object.fromEntries(
          cells.map(({ host, product, result }) => [
            `${host}:${product}`,
            result.status === 'compiled'
              ? 'compiled'
              : { code: result.diagnostics[0]?.code, message: result.diagnostics[0]?.message },
          ]),
        ),
      ).toEqual(outcomes);
      for (const { host, product, f, mutated, result } of cells) {
        const expected = outcomes[`${host}:${product}`];
        if (expected === 'compiled') {
          expect(result.status, `${host} ${product}`).toBe('compiled');
          if (emits && result.status === 'compiled')
            expect(entry(result, 'agent').text, `${host} ${product}`).toContain(emits[host]);
          if (agentFile && result.status === 'compiled') {
            expect(entry(result, 'agent').path, `${host} ${product}`).toBe(agentFile[`${host}:${product}`]);
            expect(result.files, `${host} ${product}`).toEqual(compiled(f).files);
          }
          continue;
        }
        expect(result, `${host} ${product}`).toMatchObject({
          status: 'refused',
          diagnostics: [{ code: expected.code, message: expected.message }],
        });
        expect(result).not.toHaveProperty('files');
        const optional = compiled(f, mutated(false)),
          without = compiled(f, resign({ ...f.descriptor, exports: f.descriptor.exports.filter((e) => e.id !== id) }));
        expect(optional.manifest.omissions).toEqual([
          { export: id, feature: f.descriptor.profiles[0]!.id, reason: `${expected.code}: ${expected.message}` },
        ]);
        expect(optional.files).toEqual(without.files);
      }
    },
  );

  it('refuses inline image delivery wherever it enters an export closure and records optional omissions', () => {
    const source = setup(undefined, null),
      capability = source.owner('fictional-review'),
      method = source.owner('fictional-review-method');
    const image = Buffer.from('fictional image bytes'),
      key = { source: capability.source, revision: capability.revision, path: 'references/pixel.png' };
    writeFileSync(join(source.fixture, key.path), image);
    const uses = (owner: ResourceOccurrence) =>
      source.resources.associations.find((a) => occurrenceOf(a.owner) === occurrenceOf(owner))!.resources;
    const withImage: ResourceUse[] = [
      ...uses(capability),
      { key, role: 'image', order: 0, required: true, delivery: 'inline' },
    ];
    const pins: ResourceFilePin[] = [
      ...source.resources.files.map(({ content: _content, ...pin }) => pin),
      { key, bytes: image.length, sha256: sha256(image), mediaType: 'image/png', encoding: 'base64' },
    ];
    const resources = captureResources(source.capture, {
      roots: [{ source: key.source, revision: key.revision, root: source.fixture }],
      files: pins,
      associations: [
        { owner: capability, resources: withImage },
        { owner: method, resources: uses(method) },
      ],
    });
    for (const [host, product] of PRODUCTS) {
      const f = { ...baseline(host, product, source), resources },
        options = { ...f.options, allowedResources: pins.map((p) => p.key), expectedResourcesDigest: resources.digest };
      const mutated = (required: boolean) =>
        resign({
          ...f.descriptor,
          resourcesDigest: resources.digest,
          exports: f.descriptor.exports.map((e) => ({
            ...e,
            required,
            ...(e.id === 'review' ? { resources: withImage } : {}),
          })),
        });
      expect(compileProjection(f.capture, mutated(true), resources, options), `${host} ${product}`).toMatchObject({
        status: 'refused',
        diagnostics: [
          { code: 'IA-PROJECTION-FEATURE-UNAVAILABLE', message: 'This inert profile cannot inline image content' },
        ],
      });
      const optional = compiled(f, mutated(false), options),
        without = compiled(
          f,
          resign({ ...mutated(true), exports: mutated(true).exports.filter((e) => e.id === 'check') }),
          options,
        );
      expect(optional.manifest.omissions.map((o) => [o.export, o.reason])).toEqual(
        ['review', 'reviewer'].map((id) => [
          id,
          'IA-PROJECTION-FEATURE-UNAVAILABLE: This inert profile cannot inline image content',
        ]),
      );
      expect(optional.files).toEqual(without.files);
      expect(optional.files.some((v) => v.path.endsWith('/pixel.png'))).toBe(false);
    }
  });

  it("bounds agent host tools by the effects of the agent profile's own capabilities, not their includes", () => {
    // The profile lists only fictional-review; its include fictional-review-details keeps `effects [read]`. v1 maps no tool to local-write.
    const anchor = 'includes [@capability fictional-review-details]\n  execution\n    effects [read]\n';
    const writer = setup((native) => {
      if (native.split(anchor).length !== 2) throw new Error('Fixture anchor moved');
      return native.replace(anchor, anchor.replace('[read]', '[local-write]'));
    }, null);
    const clean = setup(undefined, null);
    for (const [host, product] of PRODUCTS) {
      expect(compiled(baseline(host, product, clean)).status, `${host} ${product}`).toBe('compiled');
      const f = baseline(host, product, writer);
      expect(compileProjection(f.capture, f.descriptor, f.resources, f.options), `${host} ${product}`).toMatchObject({
        status: 'refused',
        diagnostics: [{ code: EXCEEDS.code, message: EXCEEDS.message }],
      });
    }
  });
});
