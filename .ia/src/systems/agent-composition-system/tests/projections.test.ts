import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '@ia/db';
import type { Handle } from '@ia/db';
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
  ProjectionDescriptor,
  ProjectionExport,
  ProjectionOptions,
  ProjectionResult,
} from '../src/projections.js';
import { keyOf, metadataDigest, occurrenceOf, ordered, sha256 } from '../src/resource-format.js';
import { clearNativeContexts } from '../src/resource-context.js';
import type { ResourceAssociation, ResourceFilePin, ResourceOccurrence, ResourceUse } from '../src/resources.js';
import { inert } from '../src/projection-host.js';

// Cases rebuild adopted native views and serialize their host projections.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Counts full native rebuilds. The subclass is otherwise transparent to every caller.
const rebuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@ia/db/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ia/db/editor')>();
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

const repository = fileURLToPath(new URL('../../../../..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'ia-prose-')),
  handles: Handle[] = [];
const capturedFoundation = adoptWorkspace(repository, 'foundation');
const selectedSystems = [
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
function setup(transform?: (native: string) => string, guide = '# Review\n\nRead the [example](examples/note.md).\n') {
  const base = join(temporary, String(sequence++)),
    fixture = join(base, 'source'),
    project = join(base, 'project');
  mkdirSync(base);
  cpSync(join(repository, 'tools/projections/fixtures/synthetic-review'), fixture, { recursive: true });
  mkdirSync(project);
  const nativePath = '.ia/src/systems/fictional-review-system/prose.ia';
  if (transform) writeFileSync(join(fixture, nativePath), transform(readFileSync(join(fixture, nativePath), 'utf8')));
  writeFileSync(join(fixture, 'references/review-guide.md'), guide);
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
  expect(result.files).toHaveLength(6);
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
  for (const file of result.files) {
    expect(sha256(readFileSync(join(relocated, file.path)))).toBe(file.sha256);
    if (file.path.endsWith('.md'))
      for (const match of file.content.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
        const link = decodeURIComponent(match[1] ?? match[2]!).split('#')[0]!;
        expect(existsSync(join(relocated, posix.dirname(file.path), link)), file.path + ': ' + link).toBe(true);
      }
  }
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
    diagnostics: [{ code: 'IA-PROJECTION-INPUT-INVALID' }],
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

describe('Codex projections through the shared compiler', () => {
  it('emits native workspace agents and explicit command skills with the same native closure', () => {
    const f = asCodex(fixture, 'workspace'),
      result = compiled(f),
      claude = compiled();
    expect(result.files).toHaveLength(8);
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
    expect(result.files).toHaveLength(9);
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
    expect(result.manifest.outputs.filter((v) => v.role === 'host-metadata')).toHaveLength(3);
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
        const content = file.path.startsWith('.codex/agents/') ? codexBody(file.content) : file.content;
        for (const match of content.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g))
          expect(
            existsSync(
              join(relocated, posix.dirname(file.path), decodeURIComponent(match[1] ?? match[2]!).split('#')[0]!),
            ),
          ).toBe(true);
        expect(result.manifest.outputs.find((v) => v.path === file.path)).toMatchObject({
          sha256: file.sha256,
          bytes: file.bytes,
        });
      }
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
    expect(result).toMatchObject({ status: 'refused', diagnostics: [{ code: 'IA-PROJECTION-INPUT-INVALID' }] });
    expect(result).not.toHaveProperty('files');
  });
});
