import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { open, type Handle } from '@inventarch/db';
import { runBounded } from '@tools/testing/subprocess.js';
import { adoptWorkspace, captureWorkspace } from '../src/index.js';
import {
  ANTIGRAVITY_PROSE_PROFILE,
  antigravityProseCatalog,
  GEMINI_PROSE_PROFILE,
  geminiProseCatalog,
  PROSE_EFFECT_TOOLS,
} from '../src/projection-host.js';
import { compileProjection, type ProjectionDescriptor, type ProjectionExport } from '../src/projections.js';
import { captureResources, resourceOccurrences, type ResourceFilePin, type ResourceUse } from '../src/resources.js';
import { metadataDigest, ordered, sha256 } from '../src/resource-format.js';
import { compileStandalonePlugin, generateHostSet, type StandalonePluginHost } from '../src/generate/index.js';
import { MANIFESTS, readPlugin } from '../src/host-plugin/inventory.js';
import { lowerPlugin, toolsOf } from '../src/host-plugin/lower.js';
import { pluginManifest } from '../src/host-plugin/manifest.js';
import { publicFixtureAdoption } from '../../../tools/native/public-fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src');
const NATIVE = resolve(repository, 'examples/conformance/native');
const SAMPLE = resolve(repository, 'tools/projections/fixtures/host-plugin/sample');
const temporary = mkdtempSync(join(tmpdir(), 'ia-gemini-agy-'));
const handles: Handle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};

function openFixture(
  authored: Readonly<Record<string, string | null>> = {},
  adopted: Readonly<Record<string, string>> = {},
): { readonly root: string; readonly db: Handle; readonly within: string } {
  const base = mkdtempSync(join(temporary, 'w-'));
  const root = join(base, 'root');
  const vendor = join(base, 'vendor');
  cpSync(NATIVE, join(vendor, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(adopted)) put(vendor, path, text);
  cpSync(FIXTURE, join(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(authored)) {
    if (text === null) rmSync(resolve(root, path), { force: true });
    else put(root, path, text);
  }
  const db = open(root, { cache: false, adopted: [adoptWorkspace(vendor, 'foundation')] });
  handles.push(db);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  return { root, db, within: db.resolveScope().token };
}

describe('PROSE_EFFECT_TOOLS and lower.ts multi-effect round-trip', () => {
  it('maps read, local-write and external-write effects cleanly', () => {
    expect(PROSE_EFFECT_TOOLS.get('read')).toEqual(['read', 'grep', 'glob']);
    expect(PROSE_EFFECT_TOOLS.get('local-write')).toEqual(['write', 'edit']);
    expect(PROSE_EFFECT_TOOLS.get('external-write')).toEqual(['bash']);
    expect(toolsOf(['read'])).toEqual(['Read', 'Grep', 'Glob']);
    expect(toolsOf(['local-write'])).toEqual(['Write', 'Edit']);
    expect(toolsOf(['external-write'])).toEqual(['Bash']);
    expect(toolsOf(['read', 'local-write', 'external-write'])).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Write',
      'Edit',
      'Bash',
    ]);
  });

  it.each([
    ['Write, Edit', 'effects [local-write]'],
    ['Bash', 'effects [external-write]'],
    ['Read, Grep, Glob, Write, Edit', 'effects [read, local-write]'],
    ['Read, Grep, Glob, Write, Edit, Bash', 'effects [read, local-write, external-write]'],
  ])('lowers agent tools "%s" into %s with zero unresolved entries', (tools, expectedEffects) => {
    const pluginDir = join(mkdtempSync(join(temporary, 'lower-')), 'sample');
    cpSync(SAMPLE, pluginDir, { recursive: true });
    const agentPath = join(pluginDir, 'agents/sample-reader.md');
    writeFileSync(agentPath, readFileSync(agentPath, 'utf8').replace('tools: Read, Grep, Glob', `tools: ${tools}`));
    const plan = lowerPlugin(readPlugin(pluginDir), 'sample-kit');
    expect(plan.unresolved).toEqual([]);
    const records = plan.files.find((f) => f.path.endsWith('records/plugin.ia'))!.bytes.toString('utf8');
    expect(records).toContain(expectedEffects);
  });
});

describe('gemini and antigravity prose catalogs & generated host files', () => {
  it('exposes geminiProseCatalog and antigravityProseCatalog with native tool names and deduplication', () => {
    const gemini = geminiProseCatalog('a'.repeat(64));
    expect(gemini.profile.id).toBe(GEMINI_PROSE_PROFILE);
    expect(gemini.tools).toEqual([
      { id: 'read', name: 'read_file' },
      { id: 'glob', name: 'glob' },
      { id: 'grep', name: 'grep_search' },
      { id: 'write', name: 'write_file' },
      { id: 'edit', name: 'replace' },
      { id: 'bash', name: 'run_shell_command' },
    ]);

    const agy = antigravityProseCatalog('b'.repeat(64));
    expect(agy.profile.id).toBe(ANTIGRAVITY_PROSE_PROFILE);
    expect(agy.tools).toEqual([
      { id: 'read', name: 'read_file' },
      { id: 'glob', name: 'read_file' },
      { id: 'grep', name: 'read_file' },
      { id: 'write', name: 'write_file' },
      { id: 'edit', name: 'edit_file' },
      { id: 'bash', name: 'run_command' },
    ]);
  });

  it('generates native Gemini and Antigravity workspace agents and skills with host-specific frontmatter', () => {
    const extraCapability = [
      '',
      '@capability note-editing',
      '  meaning',
      '    says "Edits workspace notes and runs checks."',
      '    answers "Which capability edits notes?"',
      '  execution',
      '    effects [read, local-write, external-write]',
      '  invocation',
      '    mode model',
      '',
    ].join('\n');
    const compositionSource =
      readFileSync(resolve(FIXTURE, 'composition.ia'), 'utf8').replace(
        '    capabilities [@capability note-reading]\n',
        '    capabilities [@capability note-reading, @capability note-editing]\n',
      ) + extraCapability;

    const { db, within } = openFixture({ '.ia/src/composition.ia': compositionSource });

    const geminiSet = generateHostSet(db, within, 'gemini');
    expect(geminiSet.files.map((f) => f.path)).toContain('.gemini/agents/reviewer.md');
    expect(geminiSet.files.some((f) => f.path.startsWith('.gemini/skills/'))).toBe(true);
    const geminiAgent = geminiSet.files.find((f) => f.path === '.gemini/agents/reviewer.md')!.text;
    expect(geminiAgent.split('\n').slice(0, 5)).toEqual([
      '---',
      'name: "reviewer"',
      'description: "Reviews the demo workspace\'s notes and reports what it finds."',
      'tools: [read_file, grep_search, glob, write_file, replace, run_shell_command]',
      '---',
    ]);

    const agySet = generateHostSet(db, within, 'antigravity');
    expect(agySet.files.map((f) => f.path)).toContain('.agents/agents/reviewer.md');
    expect(agySet.files.some((f) => f.path.startsWith('.agents/skills/'))).toBe(true);
    const agyAgent = agySet.files.find((f) => f.path === '.agents/agents/reviewer.md')!.text;
    expect(agyAgent.split('\n').slice(0, 7)).toEqual([
      '---',
      'name: "reviewer"',
      'description: "Reviews the demo workspace\'s notes and reports what it finds."',
      'subagent: true',
      'mainAgent: false',
      'tools: [read_file, write_file, edit_file, run_command]',
      '---',
    ]);
    expect(agyAgent).not.toContain('\nmodel:');
    expect(agyAgent).not.toContain('\ncolor:');
  });

  it('compiles prose projections for gemini and antigravity plugins and workspaces', () => {
    const foundation = publicFixtureAdoption(repository);
    const base = mkdtempSync(join(temporary, 'proj-'));
    const src = join(base, 'source');
    const proj = join(base, 'project');
    cpSync(join(repository, 'tools/projections/fixtures/synthetic-review'), src, { recursive: true });
    mkdirSync(proj);
    const adopted = [foundation, adoptWorkspace(src, 'review')];
    const capture = captureWorkspace(proj, 'project', { adopted });
    const reader = open(proj, { cache: false, adopted });
    handles.push(reader);
    const inventory = resourceOccurrences(capture);
    const owner = (name: string) => inventory.occurrences.find((o) => o.identity.endsWith('/' + name))!;
    const capability = owner('fictional-review');
    const method = owner('fictional-review-method');
    const paths = ['references/review-guide.md', 'references/examples/note.md'];
    const pins: ResourceFilePin[] = paths.map((path) => {
      const bytes = readFileSync(join(src, path));
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
    const resources = captureResources(capture, {
      roots: [{ source: capability.source, revision: capability.revision, root: src }],
      files: pins,
      associations: [capability, method].map((o) => ({ owner: o, resources: uses })),
    });

    for (const [host, makeCatalog, expectedManifest] of [
      ['gemini', geminiProseCatalog, 'gemini-extension.json'],
      ['antigravity', antigravityProseCatalog, 'plugin.json'],
    ] as const) {
      const catalog = makeCatalog('c'.repeat(64));
      const exports: ProjectionExport[] = [
        {
          id: 'reviewer',
          outputName: 'fictional-reviewer',
          profile: catalog.profile.id,
          required: true,
          description: 'Review fictional notes using captured evidence.',
          requirements: [],
          target: owner('fictional-reviewer'),
          resources: [],
          presentation: {
            kind: 'agent',
            agent: owner('fictional-reviewer'),
            agentProfile: owner('fictional-review-profile'),
            voice: owner('fictional-concise'),
            mandate: owner('fictional-read-only'),
            model: 'inherit',
            tools: ['read', 'grep', 'glob'],
            delegates: [],
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
        inventoryDigest: 'd'.repeat(64),
      };
      const descriptor: ProjectionDescriptor = { ...body, digest: metadataDigest(body) };
      const res = compileProjection(capture, descriptor, resources, {
        reader,
        within: reader.resolveScope().token,
        allowedResources: pins.map((p) => p.key),
        expectedResourcesDigest: resources.digest,
        inventoryDigest: descriptor.inventoryDigest,
        catalog,
        name: 'fictional-review',
        version: '0.1.0',
      });
      expect(res.status, host).toBe('compiled');
      if (res.status !== 'compiled') throw new Error(host);
      expect(res.files.map((f) => f.path)).toContain(expectedManifest);
      const agentContent = res.files.find((f) => f.path === 'agents/fictional-reviewer.md')!.content;
      if (host === 'antigravity') {
        expect(agentContent).toContain('subagent: true\nmainAgent: false\ntools: [read_file]\n');
        expect(agentContent).not.toContain('model:');
      } else {
        expect(agentContent).toContain('tools: [read_file, grep_search, glob]\n');
      }
    }
  });
});

describe('Track 2B: standalone plugin manifests & zero-IA-dependency compiler', () => {
  it('emits host-native manifest schemas for gemini and strict keys only for antigravity', () => {
    expect(MANIFESTS.gemini).toBe('gemini-extension.json');
    expect(MANIFESTS.antigravity).toBe('plugin.json');

    const product = {
      name: 'demo-kit',
      displayName: 'Demo Kit',
      version: '1.2.3',
      description: 'Standalone demo kit.',
      author: 'InventArch',
      license: 'Apache-2.0',
      keywords: ['ia', 'demo'],
      shortDescription: 'Short demo',
      category: 'Developer Tools',
    };
    expect(pluginManifest(product, 'gemini')).toEqual({
      name: 'demo-kit',
      version: '1.2.3',
      description: 'Standalone demo kit.',
      contextFileName: 'GEMINI.md',
      skills: './skills/',
    });
    const agyManifest = pluginManifest(product, 'antigravity');
    expect(Object.keys(agyManifest)).toEqual(['name', 'displayName', 'version', 'description', 'author']);
    expect(agyManifest).toEqual({
      name: 'demo-kit',
      displayName: 'Demo Kit',
      version: '1.2.3',
      description: 'Standalone demo kit.',
      author: { name: 'InventArch' },
    });
  });

  it('compiles >4 capabilities into bounded router skills, OPAL references, governance rules, native agents, and working @hook guards', async () => {
    const capRecords = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
      .map((slug, idx) =>
        [
          `@playbook pb-${slug}`,
          '  meaning',
          `    says "Playbook for ${slug}."`,
          `    answers "How does ${slug} run?"`,
          '  cognition',
          '    orient',
          '      primary Memory',
          `      Memory means "Inspect ${slug} inputs first."`,
          '    plan',
          '      primary Inference',
          `      Inference means "Plan ${slug} verification steps."`,
          '    act',
          '      primary Decision',
          `      Decision means "Apply ${slug} changes carefully."`,
          '    learn',
          '      primary Learning',
          `      Learning means "Record ${slug} outcomes."`,
          '',
          `@capability cap-${slug}`,
          '  meaning',
          `    says "Capability ${slug} (${idx + 1}) for standalone compilation."`,
          `    answers "When should ${slug} run?"`,
          '  composition',
          `    playbooks [@playbook pb-${slug}]`,
          '  execution',
          `    effects [${idx % 2 === 0 ? 'read' : 'read, local-write'}]`,
          '',
        ].join('\n'),
      )
      .join('\n');

    const governanceAndHooks = [
      '#! ia 1.0',
      '',
      '@law standalone-no-secrets',
      '  meaning',
      '    says "Never commit plaintext secrets into docs or source files."',
      '    answers "What is forbidden?"',
      '  governance',
      '    severity blocking',
      '    forbids "Plaintext credentials in tracked files."',
      '',
      '@convention standalone-naming',
      '  meaning',
      '    says "Use kebab-case names for generated artifacts."',
      '    answers "How are artifacts named?"',
      '  governance',
      '    severity advisory',
      '    requires "Lowercase kebab-case identifiers."',
      '',
      '@hook protect-frozen-docs',
      '  meaning',
      '    says "Protects frozen docs from direct agent edits."',
      '    answers "Which paths are blocked?"',
      '  hook',
      '    event PreToolUse',
      '    tools [Write, Edit]',
      '    paths ["frozen/**"]',
      '    message "Frozen docs are read-only; propose a migration instead."',
      '',
      capRecords,
    ].join('\n');

    // Single-kit style (no @workspace record, >4 capabilities): emits ONE router skill.
    const kitFixture = openFixture({
      '.ia/src/workspace.ia': null,
      '.ia/src/kit-standalone.ia': governanceAndHooks,
    });

    for (const host of [
      'claude',
      'codex',
      'gemini',
      'antigravity',
    ] as const satisfies readonly StandalonePluginHost[]) {
      const files = compileStandalonePlugin(kitFixture.db, kitFixture.within, {
        host,
        fallbackName: 'mega-kit',
        fallbackVersion: '0.5.0',
      });
      const paths = files.map((f) => f.path);
      expect(paths, host).toContain(MANIFESTS[host]);

      const skillFiles = files.filter((f) => f.path.endsWith('/SKILL.md'));
      expect(skillFiles.length, `${host} skill ceiling`).toBe(1);
      expect(skillFiles[0]!.path).toBe('skills/mega/SKILL.md');

      const routerText = skillFiles[0]!.bytes.toString('utf8');
      expect(routerText).toContain(host === 'gemini' || host === 'antigravity' ? '`read_file`' : '`Read`');
      expect(routerText).not.toMatch(/\bia_method\b|\bia_session\b|\bia_catalogue\b|\bia position\b/);

      const refFiles = files.filter((f) => f.path.startsWith('skills/mega/references/'));
      expect(refFiles).toHaveLength(7);
      const alphaRef = files.find((f) => f.path === 'skills/mega/references/cap-alpha.md')!.bytes.toString('utf8');
      expect(alphaRef).toContain('## Orient');
      expect(alphaRef).toContain('Inspect alpha inputs first.');
      expect(alphaRef).toContain('## Plan');
      expect(alphaRef).toContain('## Act');
      expect(alphaRef).toContain('## Learn');
      expect(alphaRef).toContain('## Governing Rules');
      expect(alphaRef).toContain('standalone-no-secrets');

      if (host === 'gemini') {
        expect(paths).toContain('GEMINI.md');
        expect(paths).toContain('hooks/hooks.json');
        expect(paths).toContain('scripts/guard.mjs');
        const hooksJson = JSON.parse(files.find((f) => f.path === 'hooks/hooks.json')!.bytes.toString('utf8'));
        expect(hooksJson.hooks.BeforeTool[0].hooks[0]).toMatchObject({
          type: 'command',
          command: 'node "${extensionPath}/scripts/guard.mjs"',
          timeout: 10000,
        });
      } else if (host === 'antigravity') {
        expect(paths).toContain('rules/AGENTS.md');
        expect(paths).toContain('hooks.json');
        expect(paths).toContain('scripts/guard.mjs');
        const hooksJson = JSON.parse(files.find((f) => f.path === 'hooks.json')!.bytes.toString('utf8'));
        expect(hooksJson['ia-guard'].PreToolUse[0].hooks[0]).toMatchObject({
          type: 'command',
          command: 'node ./scripts/guard.mjs',
          timeout: 10,
        });
        const agentText = files.find((f) => f.path === 'agents/reviewer.md')!.bytes.toString('utf8');
        expect(agentText).toContain('subagent: true\nmainAgent: false\ntools: [read_file]\n');
      } else if (host === 'claude') {
        expect(paths).toContain('hooks/hooks.json');
        expect(paths).toContain('scripts/guard.mjs');
        const hooksJson = JSON.parse(files.find((f) => f.path === 'hooks/hooks.json')!.bytes.toString('utf8'));
        expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(10);
      }
    }

    // Execute the compiled zero-dependency scripts/guard.mjs against mock stdin payloads for Claude, Gemini, and Antigravity!
    const agyFiles = compileStandalonePlugin(kitFixture.db, kitFixture.within, {
      host: 'antigravity',
      fallbackName: 'mega-kit',
    });
    const guardPath = join(temporary, 'compiled-guard.mjs');
    writeFileSync(guardPath, agyFiles.find((f) => f.path === 'scripts/guard.mjs')!.bytes);

    const fakeWorkspace = join(temporary, 'guard-ws');
    mkdirSync(fakeWorkspace, { recursive: true });

    const runGuard = async (payload: unknown) => {
      const res = await runBounded(process.execPath, [guardPath], {
        cwd: fakeWorkspace,
        input: JSON.stringify(payload),
        timeoutMs: 10_000,
      });
      expect(res.status, res.stderr).toBe(0);
      return res.stdout.trim() ? JSON.parse(res.stdout) : {};
    };

    // Antigravity PreToolUse deny & allow
    expect(
      await runGuard({
        cwd: fakeWorkspace,
        toolCall: { name: 'write_file', args: { Path: join(fakeWorkspace, 'frozen/spec.md') } },
      }),
    ).toEqual({
      decision: 'deny',
      reason: expect.stringContaining('Frozen docs are read-only'),
    });
    expect(
      await runGuard({
        cwd: fakeWorkspace,
        toolCall: { name: 'edit_file', args: { TargetFile: join(fakeWorkspace, 'src/open.md') } },
      }),
    ).toEqual({ decision: 'allow' });

    // Gemini BeforeTool deny & allow
    expect(
      await runGuard({
        hook_event_name: 'BeforeTool',
        cwd: fakeWorkspace,
        tool_name: 'replace',
        tool_input: { file_path: join(fakeWorkspace, 'frozen/spec.md') },
      }),
    ).toEqual({
      decision: 'deny',
      reason: expect.stringContaining('Frozen docs are read-only'),
    });
    expect(
      await runGuard({
        hook_event_name: 'BeforeTool',
        cwd: fakeWorkspace,
        tool_name: 'write_file',
        tool_input: { file_path: join(fakeWorkspace, 'src/open.md') },
      }),
    ).toEqual({ decision: 'allow' });

    // Claude PreToolUse deny & allow
    expect(
      await runGuard({
        hook_event_name: 'PreToolUse',
        cwd: fakeWorkspace,
        tool_name: 'Write',
        tool_input: { file_path: join(fakeWorkspace, 'frozen/spec.md') },
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Frozen docs are read-only'),
      },
    });
    expect(
      await runGuard({
        hook_event_name: 'PreToolUse',
        cwd: fakeWorkspace,
        tool_name: 'Write',
        tool_input: { file_path: join(fakeWorkspace, 'src/open.md') },
      }),
    ).toEqual({});

    // Seated workspace with lane bindings: emits <= 4 router skills (work, knowledge, delivery + workspace-capabilities).
    const seatedFixture = openFixture({ '.ia/src/kit-standalone.ia': governanceAndHooks });
    const seatedFiles = compileStandalonePlugin(seatedFixture.db, seatedFixture.within, {
      host: 'antigravity',
      bindings: {
        'work.alpha': { kit: 'mega', capability: 'cap-alpha' },
        'knowledge.beta': { kit: 'mega', capability: 'cap-beta' },
        'delivery.gamma': { kit: 'mega', capability: 'cap-gamma' },
      },
    });
    const seatedSkills = seatedFiles.filter((f) => f.path.endsWith('/SKILL.md')).map((f) => f.path);
    expect(seatedSkills.length).toBeLessThanOrEqual(4);
    expect(seatedSkills).toEqual([
      'skills/delivery/SKILL.md',
      'skills/demo-capabilities/SKILL.md',
      'skills/knowledge/SKILL.md',
      'skills/work/SKILL.md',
    ]);
  });
});
