import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileHarness, compiledStamp, executionManifest } from '@inventarch/agent-composition-system';
import { replayCompiledHarness } from '@inventarch/agent-composition-system/internal/compile';
import { digest } from '@inventarch/session-system';
import { open } from '@inventarch/db';
import {
  applyHookRegistration,
  observeHookRegistration,
  planHookRegistration,
} from '@inventarch/distribution/guard-registration';
import { applyHost, planHost } from '@inventarch/distribution/host';
import { applyLifecycleRegistration, planLifecycleRegistration } from '@inventarch/distribution/lifecycle-registration';
import { applyProjection, observeProjection } from '@inventarch/distribution/projection';
import {
  KB_FORMAT,
  captureKnowledge,
  foundationFromWorkspace,
  openKnowledgeView,
  packageFromCommit,
  validatePackage,
  verifyPackage,
} from '@inventarch/kb';
import { packageFromCommit as legacyPackageFromCommit, verifyPortable } from '@inventarch/kb/legacy';
import { KB_OPERATIONS, KB_PROTOCOL_VERSION } from '@inventarch/kb/protocol';
import { MACHINE_PROTOCOL, PACKET_MARKER } from '@inventarch/runtime';
import { folderKits, retainKit, retainedKit } from '@inventarch/runtime/method';
import { createContextHookBinding } from '@inventarch/steward-hook/context';
import type { ContextHookBindingInput } from '@inventarch/steward-hook/context';
import { verifyStructuredTemplate } from '@inventarch/template-system';
import {
  CANDIDATE_VALIDATE_HANDLER,
  CORPUS_INSPECT_HANDLER,
  DRAFT_PUBLISH_HANDLER,
  captureWorkspace,
} from '@inventarch/workspace-runtime';
import { createAuthoringIndex, verifyAuthoringIndex } from '@inventarch/workspace-runtime/authoring';
import { assembleLifecycleContextSegments, lifecycleInputIdentity } from '@inventarch/workspace-runtime/lifecycle';
import {
  SELECTED_CLAUDE_CODE_VERSION,
  createNativeLifecycleEvent,
  decodeLifecycleEvent,
  lifecycleProfile,
  verifyLifecycleProfile,
} from '@inventarch/workspace-runtime/lifecycle-profile';
import { fragmentLifecycleContext } from '@inventarch/workspace-runtime/internal/lifecycle-transport';
import {
  CLAUDE_PROSE_PROFILE,
  CODEX_PROSE_PROFILE,
  claudeProseCatalog,
  codexProseCatalog,
  compileProjection,
  verifyProjectionDescriptor,
} from '@inventarch/workspace-runtime/projections';
import { verifyCatalog } from '@inventarch/workspace-runtime/internal/projection-host';
import { metadataDigest, sha256 } from '@inventarch/workspace-runtime/resource-format';
import { captureResources, resourceOccurrences, verifyResources } from '@inventarch/workspace-runtime/resources';
import { checkProjection } from '../../apps/distribution/src/publication.js';
import { readReceipt } from '../../apps/cli/src/host-projection.js';
import {
  compilerCapture,
  compilerCatalog,
} from '../../.ia/src/systems/agent-composition-system/tests/compiler-fixture.js';

const V381_TAG = 'v3.8.1';
const V381_COMMIT = 'd3071c3ecc7c278101231ecc6f2628d28250eeee';

const repository = resolve(import.meta.dirname, '../..'),
  temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'ia-v381-compat-'))),
  v381Root = resolve(temporary, 'v381'),
  tsxLoader = pathToFileURL(resolve(repository, 'node_modules/tsx/dist/loader.mjs')).href;

function rewriteExportsToSource(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/') && value.endsWith('.js')) return `./src/${value.slice('./dist/'.length, -3)}.ts`;
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteExportsToSource);
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (typeof row['development'] === 'string') return row['development'];
    if (typeof row['default'] === 'string') return rewriteExportsToSource(row['default']);
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rewriteExportsToSource(v)]));
  }
  return value;
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    IA_HOME: resolve(home, 'ia'),
    IA_HOST_HOME: resolve(home, 'ia'),
    IA_CONFIG_HOME: resolve(home, 'config/ia'),
    IA_REGISTRY: '',
    IA_NO_UPDATE_CHECK: '1',
    APPDATA: resolve(home, 'AppData/Roaming'),
    LOCALAPPDATA: resolve(home, 'AppData/Local'),
    XDG_CONFIG_HOME: resolve(home, 'config'),
    XDG_CACHE_HOME: resolve(home, 'cache'),
    XDG_DATA_HOME: resolve(home, 'data'),
    CODEX_HOME: resolve(home, '.codex'),
    CLAUDE_CONFIG_DIR: resolve(home, '.claude'),
    NODE_OPTIONS: '',
    NO_COLOR: '1',
  };
}

function runV381Script(
  scriptName: string,
  source: string,
  args: readonly string[] = [],
  envHome: string = resolve(temporary, 'v381-home'),
): unknown {
  const scriptPath = resolve(v381Root, scriptName);
  writeFileSync(scriptPath, source);
  const output = execFileSync(
    process.execPath,
    ['--conditions=development', '--import', tsxLoader, scriptPath, ...args],
    {
      cwd: v381Root,
      env: isolatedEnv(envHome),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const lines = output
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('V381_JSON:'));
  if (lines.length !== 1) throw new Error(`Expected one V381_JSON line, got:\n${output}`);
  return JSON.parse(lines[0]!.slice('V381_JSON:'.length));
}

beforeAll(() => {
  const tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${V381_TAG}^{commit}`], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  expect(tagCommit).toBe(V381_COMMIT);

  mkdirSync(v381Root, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', V381_TAG], {
    cwd: repository,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const untar = spawnSync('tar', ['-xf', '-', '-C', v381Root], {
    input: archive,
    windowsHide: true,
    timeout: 60_000,
  });
  if (untar.status !== 0) throw new Error(`tar extraction failed: ${untar.stderr?.toString('utf8') ?? ''}`);

  // Copy built CLI runtime assets (identical native archives to v3.8.1) so v3.8.1 CLI commands run offline.
  cpSync(resolve(repository, 'apps/cli/assets'), resolve(v381Root, 'apps/cli/assets'), { recursive: true });

  // Populate regular-directory node_modules (no symlinks, Windows sandbox safe) with v3.8.1 sources and runtime deps.
  const nmScope = resolve(v381Root, 'node_modules/@inventarch');
  mkdirSync(nmScope, { recursive: true });
  const externalDeps = new Set<string>(['@modelcontextprotocol', 'smol-toml', 'jsonc-parser', 'zod']);
  for (const group of ['packages', 'apps', '.ia/src/systems']) {
    const groupDir = resolve(v381Root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const pkgDir = resolve(groupDir, entry),
        manifestPath = resolve(pkgDir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        exports?: unknown;
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!dep.startsWith('@inventarch/')) externalDeps.add(dep.startsWith('@') ? dep.split('/')[0]! : dep);
      }
      if (!manifest.name?.startsWith('@inventarch/')) continue;
      const short = manifest.name.slice('@inventarch/'.length),
        targetDir = resolve(nmScope, short);
      mkdirSync(targetDir, { recursive: true });
      for (const sub of ['src', 'assets']) {
        if (existsSync(resolve(pkgDir, sub)))
          cpSync(resolve(pkgDir, sub), resolve(targetDir, sub), { recursive: true });
      }
      writeFileSync(
        resolve(targetDir, 'package.json'),
        JSON.stringify(
          {
            ...manifest,
            main: './src/index.ts',
            exports: manifest.exports ? rewriteExportsToSource(manifest.exports) : './src/index.ts',
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  for (const ext of externalDeps) {
    const src = resolve(repository, 'node_modules', ext);
    if (existsSync(src)) {
      cpSync(src, resolve(v381Root, 'node_modules', ext), { recursive: true, dereference: true });
    }
  }
}, 180_000);

afterAll(() => {
  if (!relative(realpathSync(tmpdir()), temporary).startsWith('ia-v381-compat-'))
    throw new Error('Unsafe test cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it('preserves every v3.8.1 package export map, runtime symbol and public constant value', async () => {
  for (const group of ['packages', 'apps', '.ia/src/systems']) {
    for (const entry of readdirSync(resolve(repository, group))) {
      const rel = `${group}/${entry}/package.json`,
        headPath = resolve(repository, rel),
        oldPath = resolve(v381Root, rel);
      if (!existsSync(headPath) || !existsSync(oldPath)) continue;
      const headPkg = JSON.parse(readFileSync(headPath, 'utf8')) as Record<string, unknown>,
        oldPkg = JSON.parse(readFileSync(oldPath, 'utf8')) as Record<string, unknown>;
      expect(headPkg['exports'], rel).toEqual(oldPkg['exports']);
      expect(headPkg['publishConfig'], rel).toEqual(oldPkg['publishConfig']);
    }
  }

  const checkedPackages = [
    '@inventarch/agent-composition-system',
    '@inventarch/template-system',
    '@inventarch/kb',
    '@inventarch/runtime',
    '@inventarch/workspace-runtime',
    '@inventarch/distribution',
    '@inventarch/cli',
    '@inventarch/mcp-door',
    '@inventarch/runner',
    '@inventarch/steward-hook',
  ];

  const v381Surface = runV381Script(
    'inspect-exports.mjs',
    `
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = ${JSON.stringify(checkedPackages)};
const manifests = new Map();
for (const group of ['packages', 'apps', '.ia/src/systems']) {
  for (const entry of readdirSync(group)) {
    const p = resolve(group, entry, 'package.json');
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    if (targets.includes(pkg.name)) manifests.set(pkg.name, pkg);
  }
}
const symbols = {};
for (const [name, pkg] of manifests) {
  const exp = pkg.publishConfig?.exports ?? pkg.exports ?? {};
  symbols[name] = {};
  for (const subpath of Object.keys(exp)) {
    const spec = subpath === '.' ? name : name + subpath.slice(1);
    const mod = await import(spec);
    symbols[name][subpath] = Object.keys(mod).sort();
  }
}
const kb = await import('@inventarch/kb');
const kbProto = await import('@inventarch/kb/protocol');
const rt = await import('@inventarch/runtime');
const wrCodex = await import('@inventarch/workspace-runtime/internal/projection-codex');
const wrLife = await import('@inventarch/workspace-runtime/lifecycle');
const wrProf = await import('@inventarch/workspace-runtime/lifecycle-profile');
const wrProj = await import('@inventarch/workspace-runtime/projections');
const wrRes = await import('@inventarch/workspace-runtime/resources');
const wrAuth = await import('@inventarch/workspace-runtime/authoring');
const wrStore = await import('@inventarch/workspace-runtime/local-store');
const wrAdapt = await import('@inventarch/workspace-runtime/adapters');
const wrTask = await import('@inventarch/workspace-runtime/task-capture-format');
console.log('V381_JSON:' + JSON.stringify({
  symbols,
  constants: {
    KB_FORMAT: kb.KB_FORMAT,
    LIMITS: kb.LIMITS,
    KB_PROTOCOL_VERSION: kbProto.KB_PROTOCOL_VERSION,
    KB_OPERATIONS: kbProto.KB_OPERATIONS,
    MACHINE_PROTOCOL: rt.MACHINE_PROTOCOL,
    PACKET_MARKER: rt.PACKET_MARKER,
    K0: rt.K0,
    SCOPE_KEY_CAPS: rt.SCOPE_KEY_CAPS,
    RUNTIME_CODES: rt.RUNTIME_CODES,
    NEXT_CODES: rt.NEXT_CODES,
    READ_CODES: rt.READ_CODES,
    CODEX_PROSE_PROFILE: wrCodex.CODEX_PROSE_PROFILE,
    SELECTED_CLAUDE_CODE_VERSION: wrProf.SELECTED_CLAUDE_CODE_VERSION,
    LIFECYCLE_CONTEXT_SLOTS: wrLife.LIFECYCLE_CONTEXT_SLOTS,
    PROJECTION_LIMITS: wrProj.PROJECTION_LIMITS,
    RESOURCE_LIMITS: wrRes.RESOURCE_LIMITS,
    AUTHORING_LIMITS: wrAuth.AUTHORING_LIMITS,
    RETAINED_STORE_LIMITS: wrStore.RETAINED_STORE_LIMITS,
    ADAPTER_LIMITS: wrAdapt.ADAPTER_LIMITS,
    TASK_CAPTURE_BYTES: wrTask.TASK_CAPTURE_BYTES,
    TASK_CAPTURE_POLICY: wrTask.TASK_CAPTURE_POLICY,
  },
}));
`,
  ) as {
    symbols: Record<string, Record<string, string[]>>;
    constants: Record<string, unknown>;
  };

  for (const [pkgName, subpaths] of Object.entries(v381Surface.symbols)) {
    for (const [subpath, oldKeys] of Object.entries(subpaths)) {
      const spec = subpath === '.' ? pkgName : pkgName + subpath.slice(1);
      const headMod = (await import(spec)) as Record<string, unknown>;
      const headKeys = new Set(Object.keys(headMod));
      const missing = oldKeys.filter((key) => !headKeys.has(key));
      expect(missing, `${spec} missing v3.8.1 exports`).toEqual([]);
    }
  }

  const wrLife = await import('@inventarch/workspace-runtime/lifecycle');
  const wrProj = await import('@inventarch/workspace-runtime/projections');
  const wrRes = await import('@inventarch/workspace-runtime/resources');
  const wrAuth = await import('@inventarch/workspace-runtime/authoring');
  const wrStore = await import('@inventarch/workspace-runtime/local-store');
  const wrAdapt = await import('@inventarch/workspace-runtime/adapters');
  const wrTask = await import('@inventarch/workspace-runtime/task-capture-format');
  const rt = await import('@inventarch/runtime');
  const kbMod = await import('@inventarch/kb');

  expect(KB_FORMAT).toBe('ia.kb.package.v1');
  expect(CORPUS_INSPECT_HANDLER).toBe('ia.corpus.inspect.v1');
  expect(CANDIDATE_VALIDATE_HANDLER).toBe('ia.candidate.validate.v1');
  expect(DRAFT_PUBLISH_HANDLER).toBe('ia.draft.publish.v1');
  expect(CLAUDE_PROSE_PROFILE).toBe('ia.host.claude-prose.v1');
  expect(CODEX_PROSE_PROFILE).toBe('ia.host.codex-prose.v1');

  expect({
    KB_FORMAT,
    LIMITS: kbMod.LIMITS,
    KB_PROTOCOL_VERSION,
    KB_OPERATIONS,
    MACHINE_PROTOCOL,
    PACKET_MARKER: rt.PACKET_MARKER,
    K0: rt.K0,
    SCOPE_KEY_CAPS: rt.SCOPE_KEY_CAPS,
    RUNTIME_CODES: rt.RUNTIME_CODES,
    NEXT_CODES: rt.NEXT_CODES,
    READ_CODES: rt.READ_CODES,
    CODEX_PROSE_PROFILE,
    SELECTED_CLAUDE_CODE_VERSION,
    LIFECYCLE_CONTEXT_SLOTS: wrLife.LIFECYCLE_CONTEXT_SLOTS,
    PROJECTION_LIMITS: wrProj.PROJECTION_LIMITS,
    RESOURCE_LIMITS: wrRes.RESOURCE_LIMITS,
    AUTHORING_LIMITS: wrAuth.AUTHORING_LIMITS,
    RETAINED_STORE_LIMITS: wrStore.RETAINED_STORE_LIMITS,
    ADAPTER_LIMITS: wrAdapt.ADAPTER_LIMITS,
    TASK_CAPTURE_BYTES: wrTask.TASK_CAPTURE_BYTES,
    TASK_CAPTURE_POLICY: wrTask.TASK_CAPTURE_POLICY,
  }).toEqual(v381Surface.constants);
}, 180_000);

it('feeds fresh 3.9.0 default outputs to a 3.8.1 consumer and verifies 3.9.0 readers accept both shapes', () => {
  const stage = resolve(temporary, 'stage-390-to-381'),
    cliMain = resolve(repository, 'apps/cli/dist/main.js'),
    env = isolatedEnv(resolve(stage, 'home')),
    workspace = resolve(stage, 'workspace');
  mkdirSync(stage, { recursive: true });

  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cliMain, ...args, '--json'], {
        cwd: stage,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      }),
    ) as Record<string, unknown>;

  cli('init', workspace, '--apply', '--yes');
  mkdirSync(resolve(workspace, 'docs'), { recursive: true });
  writeFileSync(resolve(workspace, 'docs/architecture.md'), '# Architecture\n\nCross-version compatibility proof.\n');
  writeFileSync(
    resolve(workspace, '.ia/src/knowledge.ia'),
    [
      '#! ia 1.0',
      '@spec compat-spec',
      '  meaning',
      '    says "Portable spec for 3.8.1 consumer verification."',
      '  work',
      '    title "Compatibility spec"',
      '    status draft',
      '    source "docs/architecture.md"',
      '',
    ].join('\n'),
  );
  writeFileSync(
    resolve(workspace, '.ia/src/plan.ia'),
    [
      '#! ia 1.0',
      '@plan compat-plan',
      '  meaning',
      '    says "Release compatibility plan."',
      '  work',
      '    title "Compatibility plan"',
      '    status open',
      '@milestone compat-milestone',
      '  meaning',
      '    says "Compatibility milestone."',
      '  work',
      '    title "Milestone 1"',
      '    plan @plan compat-plan',
      '    status open',
      '    exit "Compatibility verified."',
      '@task compat-task',
      '  meaning',
      '    says "Verify 3.8.1 compatibility."',
      '  work',
      '    title "Compatibility task"',
      '    milestone @milestone compat-milestone',
      '    status open',
      '@playbook compat-method',
      '  meaning',
      '    says "Review compatibility notes."',
      '    answers "How are compatibility notes reviewed?"',
      '  cognition',
      '    orient',
      '      primary Memory',
      '      Memory means "Inspect compatibility evidence."',
      '',
    ].join('\n'),
  );
  const specId = 'work-system/contract/spec/compat-spec';
  writeFileSync(
    resolve(workspace, '.ia/knowledge.json'),
    JSON.stringify({
      format: 'ia.kb.selection.v1',
      sourceId: 'compat',
      records: [specId],
      resources: ['docs/architecture.md'],
    }) + '\n',
  );

  const posOut = cli('position', '--root', workspace) as { body: Record<string, unknown> },
    nextOut = cli('next', '--root', workspace) as { view: Record<string, unknown> },
    projOut = cli('project', 'claude', '--root', workspace, '--apply', '--yes') as {
      applied: Record<string, unknown>;
    };
  expect(posOut.body['format']).toBe('ia.position-body.v1');
  expect(Object.hasOwn(posOut.body, 'formatVersion')).toBe(false);
  expect(nextOut.view['format']).toBe('ia.delivery-view.v1');
  expect(Object.hasOwn(nextOut.view, 'formatVersion')).toBe(false);
  expect(projOut.applied['format']).toBe('ia.packet-receipt.v1');
  expect(Object.hasOwn(projOut.applied, 'formatVersion')).toBe(false);

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${resolve(stage, 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-C', workspace, ...args],
      { env, encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', '--', '.ia/src', '.ia/knowledge.json', 'docs/architecture.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'init');
  const commit = git('rev-parse', 'HEAD');

  const foundation = foundationFromWorkspace(workspace),
    kbPkg = packageFromCommit({ repository: workspace, commit, selection: '.ia/knowledge.json', foundation }),
    kbPortable = legacyPackageFromCommit({
      repository: workspace,
      commit,
      paths: ['.ia/src/knowledge.ia', 'docs/architecture.md'],
      sourceId: 'compat',
    }),
    pkgView = openKnowledgeView(validatePackage(kbPkg, foundation)),
    kbCitation = pkgView.read(specId).citation,
    localSnapshot = captureKnowledge(workspace);
  pkgView.close();

  expect(kbPkg.format).toBe('ia.kb.package.v1');
  expect(kbPortable.format).toBe('iakb.portable.v1');
  expect(kbCitation.format).toBe('ia.kb.citation.v1');
  expect(localSnapshot.format).toBe('ia.kb.snapshot.v1');

  const implDigest = 'a'.repeat(64),
    compCapture = compilerCapture(repository),
    compCatalog = compilerCatalog('ide', implDigest),
    compiledRes = compileHarness(compCapture, {
      harness: 'native-sample',
      entry: 'sample-entry',
      catalog: compCatalog,
    });
  if (!compiledRes.ok) throw new Error(JSON.stringify(compiledRes));
  const compiledHarness = compiledRes.manifest;
  expect(compiledHarness.format).toBe('ia.compiled-harness.v1');

  const kitDir = resolve(stage, 'kits/ia-kb'),
    closureStore = resolve(stage, 'closures');
  mkdirSync(resolve(kitDir, '.ia'), { recursive: true });
  writeFileSync(
    resolve(kitDir, '.ia/release.json'),
    JSON.stringify({ id: 'inventarch/ia-kb-kit', version: '0.1.0' }) + '\n',
  );
  writeFileSync(
    resolve(kitDir, 'releases.json'),
    JSON.stringify({
      kit: 'inventarch/ia-kb-kit',
      releases: [{ version: '0.1.0', archive: 'e'.repeat(64), records: [] }],
    }) + '\n',
  );
  const keptKit = retainKit(folderKits(resolve(stage, 'kits'), 'bundled')[0]!, closureStore);

  const docBytes = readFileSync(resolve(workspace, 'docs/architecture.md')),
    wsCapture = captureWorkspace(workspace),
    wsOccurrences = resourceOccurrences(wsCapture),
    selfSource = wsCapture.id,
    selfRevision = wsOccurrences.sourceRevisions.find((s) => s.source === selfSource)!.revision,
    docKey = { source: selfSource, revision: selfRevision, path: 'docs/architecture.md' },
    wsResources = captureResources(wsCapture, {
      roots: [{ source: selfSource, revision: selfRevision, root: workspace }],
      files: [
        {
          key: docKey,
          bytes: docBytes.byteLength,
          sha256: sha256(docBytes),
          mediaType: 'text/markdown',
          encoding: 'utf8',
        },
      ],
      associations: [
        {
          owner: wsOccurrences.occurrences.find((r) => r.identity === specId)!,
          resources: [
            {
              key: docKey,
              role: 'guide',
              order: 0,
              required: true,
              delivery: 'inline',
            },
          ],
        },
      ],
    }),
    wsAuthoringIndex = createAuthoringIndex(wsCapture, wsResources, {
      systems: [],
      artifacts: [],
      profiles: [],
      documents: [],
      lifecycles: [],
    }),
    claudeCat = claudeProseCatalog(implDigest),
    codexCat = codexProseCatalog(implDigest);

  const methodOwner = wsOccurrences.occurrences.find((r) => r.identity.endsWith('/compat-method'))!,
    descBody = {
      format: 'ia.projection-descriptor.v1' as const,
      sourceRevisions: wsOccurrences.sourceRevisions,
      product: 'workspace' as const,
      profiles: [claudeCat.profile],
      exports: [
        {
          id: 'compat-cmd',
          target: methodOwner,
          profile: claudeCat.profile.id,
          outputName: 'compat-cmd',
          required: true,
          description: 'Compatibility command.',
          resources: [],
          requirements: [],
          presentation: {
            kind: 'command' as const,
            invocation: 'explicit' as const,
            arguments: [],
            body: [methodOwner],
          },
        },
      ],
      resourcesDigest: wsResources.digest,
      inventoryDigest: 'b'.repeat(64),
    },
    descriptor = verifyProjectionDescriptor({ ...descBody, digest: metadataDigest(descBody) }),
    dbHandle = open(workspace);
  let compiledProj: ReturnType<typeof compileProjection>;
  try {
    compiledProj = compileProjection(wsCapture, descriptor, wsResources, {
      reader: dbHandle,
      within: dbHandle.resolveScope().token,
      allowedResources: [docKey],
      expectedResourcesDigest: wsResources.digest,
      inventoryDigest: descriptor.inventoryDigest,
      catalog: claudeCat,
      name: 'compat-proj',
      version: '0.1.0',
    });
  } finally {
    dbHandle.close();
  }
  expect(compiledProj.status, JSON.stringify(compiledProj)).toBe('compiled');
  expect(compiledProj.format).toBe('ia.projection-result.v1');

  const profile390 = lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION),
    ctxBody = {
      format: 'ia.lifecycle-context.v1' as const,
      pins: {
        binding: '1'.repeat(64),
        source: wsCapture.revision,
        view: '2'.repeat(64),
        resources: wsResources.digest,
        installation: null,
        profile: profile390.digest,
        policy: '3'.repeat(64),
        implementation: implDigest,
      },
      event: { kind: 'prompt' as const, source: null, key: '4'.repeat(64), inputDigest: '5'.repeat(64) },
      required: { proof: '6'.repeat(64), parts: [{ id: 'p1', text: '3.9.0 context', citations: [] }] },
      delivery: 'unconfirmed' as const,
    },
    ctxPayload = JSON.stringify({ ...ctxBody, id: metadataDigest(ctxBody) }),
    segments390 = fragmentLifecycleContext(ctxPayload).outputs.map((o) => o.hookSpecificOutput.additionalContext);

  const pubWorkspace = resolve(stage, 'pub-workspace');
  mkdirSync(pubWorkspace, { recursive: true });
  const artifactsPath = resolve(stage, 'artifacts-390.json');
  writeFileSync(
    artifactsPath,
    JSON.stringify({
      workspace,
      pubWorkspace,
      specId,
      kbPkg,
      kbPortable,
      kbCitation,
      compiledHarness,
      compCatalog,
      closureStore,
      keptDigest: keptKit.retained,
      wsCapture,
      wsResources,
      wsAuthoringIndex,
      claudeCat,
      codexCat,
      compiledProj,
      ctxPayload,
      segments390,
    }),
  );

  const v381Report = runV381Script(
    'consume-390.mjs',
    `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executionManifest } from '@inventarch/agent-composition-system';
import { foundationFromWorkspace, openKnowledgeView, validatePackage, verifyPackage } from '@inventarch/kb';
import { verifyPortable } from '@inventarch/kb/legacy';
import { parseKnowledgeRequest } from '@inventarch/kb/protocol';
import { retainedKit } from '@inventarch/runtime/method';
import { verifyAuthoringIndex } from '@inventarch/workspace-runtime/authoring';
import { assembleLifecycleContextSegments } from '@inventarch/workspace-runtime/lifecycle';
import { verifyCatalog } from '@inventarch/workspace-runtime/internal/projection-host';
import { verifyResources } from '@inventarch/workspace-runtime/resources';
import { publishProjection } from './apps/distribution/src/publication.ts';
import { readReceipt } from './apps/cli/src/host-projection.ts';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const foundation = foundationFromWorkspace(input.workspace);
const verifiedPkg = verifyPackage(input.kbPkg);
const validatedPkg = validatePackage(input.kbPkg, foundation);
const view = openKnowledgeView(validatedPkg);
let resolvedId;
try {
  parseKnowledgeRequest('resolve', { citation: input.kbCitation });
  resolvedId = view.resolveCitation(input.kbCitation).identity;
} finally {
  view.close();
}
const verifiedPortable = verifyPortable(input.kbPortable);
const execManifest = executionManifest(input.compiledHarness, input.compCatalog);
const loadedKit = retainedKit(input.keptDigest, input.closureStore);
const verifiedRes = verifyResources(input.wsResources, input.wsCapture);
const verifiedIdx = verifyAuthoringIndex(input.wsAuthoringIndex, input.wsCapture, verifiedRes);
const verifiedClaude = verifyCatalog(input.claudeCat);
const verifiedCodex = verifyCatalog(input.codexCat);
const pubReport = publishProjection(input.pubWorkspace, 'compat-pub', input.compiledProj);
const assembled = assembleLifecycleContextSegments(input.segments390);
const receipt = readReceipt(input.workspace, 'claude');

const doctorRaw = execFileSync(
  process.execPath,
  ['--conditions=development', '--import', ${JSON.stringify(tsxLoader)}, resolve('apps/cli/src/main.ts'), 'doctor', '--root', input.workspace, '--json'],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 },
);
const doctor = JSON.parse(doctorRaw);

console.log('V381_JSON:' + JSON.stringify({
  verifiedPkgDigest: verifiedPkg.digest,
  resolvedId,
  portableDigest: verifiedPortable.digest,
  execCompiledDigest: execManifest.provenance.compiled.digest,
  loadedKitId: loadedKit.id,
  verifiedResDigest: verifiedRes.digest,
  verifiedIdxDigest: verifiedIdx.digest,
  claudeProfile: verifiedClaude.profile.id,
  codexProfile: verifiedCodex.profile.id,
  pubStatus: pubReport.status,
  assembledPayload: assembled.payload,
  receiptPacketDigest: receipt?.packetDigest ?? null,
  doctorProjection: doctor.checks.find((c) => c.id === 'projection-claude'),
}));
`,
    [artifactsPath],
  ) as Record<string, unknown>;

  expect(v381Report).toMatchObject({
    verifiedPkgDigest: kbPkg.digest,
    resolvedId: specId,
    portableDigest: kbPortable.digest,
    execCompiledDigest: compiledHarness.digest,
    loadedKitId: 'inventarch/ia-kb-kit',
    verifiedResDigest: wsResources.digest,
    verifiedIdxDigest: wsAuthoringIndex.digest,
    claudeProfile: 'ia.host.claude-prose.v1',
    codexProfile: 'ia.host.codex-prose.v1',
    pubStatus: 'published',
    assembledPayload: ctxPayload,
    receiptPacketDigest: projOut.applied['packetDigest'],
    doctorProjection: { id: 'projection-claude', status: 'ok' },
  });

  // Verify 3.9.0 permissive readers accept BOTH 3.8.1 shapes AND plain (formatVersion: 1) shapes with original digests.
  const { digest: _releasedDigest, ...harnessBody } = compiledHarness,
    retainedPlainBody = { ...harnessBody, format: 'compiled-harness' as const, formatVersion: 1 as const },
    retainedPlain = { ...retainedPlainBody, digest: digest(retainedPlainBody) };
  expect(compiledStamp(compiledHarness)).toEqual({ format: 'ia.compiled-harness.v1' });
  expect(compiledStamp(retainedPlain)).toEqual({ format: 'compiled-harness', formatVersion: 1 });
  for (const retained of [compiledHarness, retainedPlain]) {
    expect(replayCompiledHarness(compCapture, retained, compCatalog)).toEqual({ ok: true, manifest: retained });
    expect(executionManifest(retained, compCatalog).provenance).toMatchObject({
      compiled: { digest: retained.digest },
    });
  }

  const { digest: _pkgDigest, selection: oldSel, ...pkgRest } = kbPkg,
    plainSelection = {
      format: 'kb-selection' as const,
      formatVersion: 1 as const,
      sourceId: oldSel.sourceId,
      records: oldSel.records,
      resources: oldSel.resources,
    },
    plainPkgBody = { ...pkgRest, format: 'kb-package' as const, formatVersion: 1 as const, selection: plainSelection },
    plainPkg = { ...plainPkgBody, digest: metadataDigest(plainPkgBody) };
  expect(verifyPackage(kbPkg).digest).toBe(kbPkg.digest);
  expect(verifyPackage(plainPkg).digest).toBe(plainPkg.digest);
  expect(validatePackage(kbPkg, foundation).portable.digest).toBe(kbPkg.digest);
  expect(validatePackage(plainPkg, foundation).portable.digest).toBe(plainPkg.digest);

  const { digest: _portDigest, ...portRest } = kbPortable,
    plainPortBody = { ...portRest, format: 'kb-portable' as const, formatVersion: 1 as const },
    plainPortable = { ...plainPortBody, digest: metadataDigest(plainPortBody) };
  expect(verifyPortable(kbPortable).digest).toBe(kbPortable.digest);
  expect(verifyPortable(plainPortable).digest).toBe(plainPortable.digest);

  const tmplBody = {
    inputs: { title: { type: 'text' as const, required: true } },
    nodes: [{ kind: 'value' as const, input: 'title' }],
  };
  expect(verifyStructuredTemplate({ format: 'ia.structured-template.v1', ...tmplBody }).format).toBe(
    'ia.structured-template.v1',
  );
  expect(verifyStructuredTemplate({ format: 'structured-template', formatVersion: 1, ...tmplBody })).toMatchObject({
    format: 'structured-template',
    formatVersion: 1,
  });

  expect(retainedKit(keptKit.retained!, closureStore).retained).toBe(keptKit.retained);
  expect(readReceipt(workspace, 'claude')?.packetDigest).toBe(projOut.applied['packetDigest']);
  expect(verifyResources(wsResources, wsCapture).digest).toBe(wsResources.digest);
  expect(verifyAuthoringIndex(wsAuthoringIndex, wsCapture, wsResources).digest).toBe(wsAuthoringIndex.digest);
  expect(
    verifyCatalog({
      ...claudeCat,
      format: 'projection-catalog',
      formatVersion: 1,
      profile: { ...claudeCat.profile, id: 'claude-prose' },
    }).profile.id,
  ).toBe('claude-prose');

  const plainSegments = fragmentLifecycleContext(ctxPayload, {
    format: 'lifecycle-context-segment',
    formatVersion: 1,
  }).outputs.map((o) => o.hookSpecificOutput.additionalContext);
  expect(assembleLifecycleContextSegments(segments390).payload).toBe(ctxPayload);
  expect(assembleLifecycleContextSegments(plainSegments).payload).toBe(ctxPayload);

  if (compiledProj.status === 'compiled') {
    expect(checkProjection(pubWorkspace, 'compat-pub', compiledProj)).toMatchObject({
      status: 'current',
      manifestDigest: compiledProj.manifest.digest,
    });
  }
}, 240_000);

it('preserves saved plans, existing host bindings and lifecycle retry identity across the 3.8.1 -> 3.9.0 upgrade', () => {
  const stage = resolve(temporary, 'stage-upgrade'),
    wsHostPlan = resolve(stage, 'ws-host-plan'),
    wsLifePlan = resolve(stage, 'ws-life-plan'),
    wsHookPlan = resolve(stage, 'ws-hook-plan'),
    wsProjPlan = resolve(stage, 'ws-proj-plan'),
    wsBound = resolve(stage, 'ws-bound'),
    home = resolve(stage, 'home'),
    implDigest = 'c'.repeat(64),
    bindingDigestSeed = 'd'.repeat(64);
  mkdirSync(home, { recursive: true });

  const promptPayload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-upgrade-1',
    prompt_id: 'prompt-upgrade-42',
    cwd: wsBound,
    prompt: 'Verify retry identity across 3.8.1 -> 3.9.0',
  });
  const nativeInput = {
    session: 'session-upgrade-1',
    profile: 'author',
    invocation: 'native-upgrade-7',
    text: 'Verify native retry identity across 3.8.1 -> 3.9.0',
  };

  const bindingBase: Omit<ContextHookBindingInput, 'profile' | 'implementation'> = {
    format: 'ia.context-hook-binding.v1',
    root: wsBound,
    owner: 'workspace',
    actor: 'agent-system/binding/agent/ws-bound',
    workspace: 'workspace-system/definition/workspace/ws-bound',
    scope: { root: '', identities: null },
    view: { id: 'project', adopted: [], manifests: [{ source: 'self', root: wsBound }] },
    selection: {
      target: 'workspace-system/definition/workspace/ws-bound',
      document: null,
      lifecycle: null,
    },
    coordinate: { phase: 'orient', primitive: 'Attention' },
    bootstrap: 'Orient on workspace.',
    budgets: { tokens: 4096, records: 32, bytes: 32768, timeoutMs: 5000 },
    policy: 'e'.repeat(64),
  };

  const hookRow = {
    identity: 'hook-authoring-system/governance/hook/protect-sources',
    tools: ['Write', 'Edit'] as const,
    paths: ['.ia/src/**'],
  };

  const from381 = runV381Script(
    'produce-381-upgrade-state.mjs',
    `
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyHookRegistration, planHookRegistration } from '@inventarch/distribution/guard-registration';
import { planHost } from '@inventarch/distribution/host';
import { applyLifecycleRegistration, planLifecycleRegistration } from '@inventarch/distribution/lifecycle-registration';
import { planProjection } from '@inventarch/distribution/projection';
import { PACKET_MARKER } from '@inventarch/runtime';
import { createContextHookBinding } from '@inventarch/steward-hook/context';
import { lifecycleInputIdentity } from '@inventarch/workspace-runtime/lifecycle';
import {
  SELECTED_CLAUDE_CODE_VERSION,
  createNativeLifecycleEvent,
  decodeLifecycleEvent,
  lifecycleProfile,
} from '@inventarch/workspace-runtime/lifecycle-profile';

const [wsHostPlan, wsLifePlan, wsHookPlan, wsProjPlan, wsBound, implDigest, bindingDigestSeed, promptPayload, nativeJson, bindingBaseJson, hookRowJson] = process.argv.slice(2);
const cliArgs = ['--conditions=development', '--import', ${JSON.stringify(tsxLoader)}, resolve('apps/cli/src/main.ts')];

// Initialize one workspace, copy to the four saved-plan workspaces, and register Claude host on wsBound in v3.8.1.
execFileSync(process.execPath, [...cliArgs, 'init', wsBound, '--apply', '--yes', '--json'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120000,
});
for (const dst of [wsHostPlan, wsLifePlan, wsHookPlan, wsProjPlan]) {
  cpSync(wsBound, dst, { recursive: true });
}
execFileSync(process.execPath, [...cliArgs, 'host', 'claude', '--root', wsBound, '--apply', '--yes', '--json'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120000,
});

const hostState = JSON.parse(readFileSync(resolve(wsBound, '.ia/distributions/hosts/claude-workspace.json'), 'utf8'));
const cacheDir = hostState.cache;

const profile = lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION);
const nativeProfile = lifecycleProfile('ia-native', '1');
const bindingBase = JSON.parse(bindingBaseJson);
const hookRow = JSON.parse(hookRowJson);
const ports = { implementation: () => implDigest };

const binding381 = createContextHookBinding({
  ...bindingBase,
  profile,
  implementation: implDigest,
});

// Register lifecycle + hook bindings on wsBound in v3.8.1.
const boundLifePlan = planLifecycleRegistration(
  wsBound,
  { cache: cacheDir, binding: { ...bindingBase, profile } },
  ports,
);
applyLifecycleRegistration(boundLifePlan, ports);
const boundHookPlan = planHookRegistration(wsBound, { cache: cacheDir, hooks: [hookRow] });
applyHookRegistration(boundHookPlan);

// Build saved 3.8.1 plans on clean workspaces (not yet applied!).
const lifeBindingBase = {
  ...bindingBase,
  root: wsLifePlan,
  view: { ...bindingBase.view, manifests: [{ source: 'self', root: wsLifePlan }] },
};
const savedHostPlan = planHost(wsHostPlan, 'claude', cacheDir);
const savedLifecyclePlan = planLifecycleRegistration(
  wsLifePlan,
  { cache: cacheDir, binding: { ...lifeBindingBase, profile } },
  ports,
);
const savedHookPlan = planHookRegistration(wsHookPlan, { cache: cacheDir, hooks: [hookRow] });
const savedProjectionPlan = planProjection({
  root: wsProjPlan,
  host: 'claude',
  marker: PACKET_MARKER,
  artifacts: [{ path: '.claude/rules/ia-workspace.md', text: PACKET_MARKER + '\\n# Saved Plan\\n' }],
});

const decodedPrompt = decodeLifecycleEvent(profile, promptPayload);
const boundPromptRetry = lifecycleInputIdentity(bindingDigestSeed, decodedPrompt);
const decodedNative = createNativeLifecycleEvent(JSON.parse(nativeJson));
const boundNativeRetry = lifecycleInputIdentity(bindingDigestSeed, decodedNative);

console.log('V381_JSON:' + JSON.stringify({
  cacheDir,
  profile,
  nativeProfile,
  binding381,
  savedHostPlan,
  savedLifecyclePlan,
  savedHookPlan,
  savedProjectionPlan,
  decodedPrompt,
  boundPromptRetry,
  decodedNative,
  boundNativeRetry,
}));
`,
    [
      wsHostPlan,
      wsLifePlan,
      wsHookPlan,
      wsProjPlan,
      wsBound,
      implDigest,
      bindingDigestSeed,
      promptPayload,
      JSON.stringify(nativeInput),
      JSON.stringify(bindingBase),
      JSON.stringify(hookRow),
    ],
    home,
  ) as {
    cacheDir: string;
    profile: ReturnType<typeof lifecycleProfile>;
    nativeProfile: ReturnType<typeof lifecycleProfile>;
    binding381: ReturnType<typeof createContextHookBinding>;
    savedHostPlan: ReturnType<typeof planHost>;
    savedLifecyclePlan: ReturnType<typeof planLifecycleRegistration>;
    savedHookPlan: ReturnType<typeof planHookRegistration>;
    savedProjectionPlan: Parameters<typeof applyProjection>[0];
    decodedPrompt: ReturnType<typeof decodeLifecycleEvent>;
    boundPromptRetry: ReturnType<typeof lifecycleInputIdentity>;
    decodedNative: ReturnType<typeof createNativeLifecycleEvent>;
    boundNativeRetry: ReturnType<typeof lifecycleInputIdentity>;
  };

  const profile390 = lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION),
    nativeProfile390 = lifecycleProfile('ia-native', '1');

  // 1. Saved 3.8.1 plans apply cleanly in 3.9.0 and immediately converge to idempotent no-ops!
  const ports390 = { implementation: () => implDigest };
  applyHost(from381.savedHostPlan);
  const replannedHost = planHost(wsHostPlan, 'claude', from381.cacheDir);
  expect(sha256(replannedHost.after.config!)).toBe(replannedHost.before.config);
  expect(sha256(replannedHost.after.state!)).toBe(replannedHost.before.state);

  applyLifecycleRegistration(from381.savedLifecyclePlan, ports390);
  const replannedLife = planLifecycleRegistration(
    wsLifePlan,
    {
      cache: from381.cacheDir,
      binding: {
        ...bindingBase,
        root: wsLifePlan,
        view: { ...bindingBase.view, manifests: [{ source: 'self', root: wsLifePlan }] },
        profile: profile390,
      },
    },
    ports390,
  );
  expect(replannedLife.after.config).toBe(readFileSync(resolve(wsLifePlan, '.claude/settings.local.json'), 'utf8'));
  expect(replannedLife.after.binding).toBe(
    readFileSync(resolve(wsLifePlan, '.ia/distributions/hosts/claude-context-workspace.binding.json'), 'utf8'),
  );
  expect({ ...(JSON.parse(replannedLife.after.state!) as Record<string, unknown>), revision: 1 }).toEqual(
    JSON.parse(readFileSync(resolve(wsLifePlan, '.ia/distributions/hosts/claude-context-workspace.json'), 'utf8')),
  );

  applyHookRegistration(from381.savedHookPlan);
  expect(observeHookRegistration(wsHookPlan)).toEqual([]);

  applyProjection(from381.savedProjectionPlan);
  expect(
    observeProjection({
      root: wsProjPlan,
      host: 'claude',
      marker: PACKET_MARKER,
      artifacts: [{ path: '.claude/rules/ia-workspace.md', text: `${PACKET_MARKER}\n# Saved Plan\n` }],
    }),
  ).toEqual([]);

  // 2. Existing 3.8.1 host bindings keep exact digests in 3.9.0 without requiring host re-registration!
  expect(profile390).toEqual(from381.profile);
  expect(profile390.digest).toBe('b25a5786a27e21e6b81449739d114d66be7c77ac9339c058919402111c8525b2');
  expect(verifyLifecycleProfile(from381.profile)).toEqual(profile390);
  expect(nativeProfile390).toEqual(from381.nativeProfile);

  const binding390 = createContextHookBinding({
    ...bindingBase,
    profile: profile390,
    implementation: implDigest,
  });
  expect(binding390).toEqual(from381.binding381);

  const checkBoundLife = planLifecycleRegistration(
    wsBound,
    { cache: from381.cacheDir, binding: { ...bindingBase, profile: profile390 } },
    ports390,
  );
  expect(checkBoundLife.after.config).toBe(readFileSync(resolve(wsBound, '.claude/settings.local.json'), 'utf8'));
  expect(checkBoundLife.after.binding).toBe(
    readFileSync(resolve(wsBound, '.ia/distributions/hosts/claude-context-workspace.binding.json'), 'utf8'),
  );
  expect({ ...(JSON.parse(checkBoundLife.after.state!) as Record<string, unknown>), revision: 1 }).toEqual(
    JSON.parse(readFileSync(resolve(wsBound, '.ia/distributions/hosts/claude-context-workspace.json'), 'utf8')),
  );
  expect(observeHookRegistration(wsBound)).toEqual([]);

  const doctor390 = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(repository, 'apps/cli/dist/main.js'), 'doctor', '--root', wsBound, '--json'],
      { env: isolatedEnv(home), encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    ),
  ) as { checks: { id: string; status: string }[] };
  expect(doctor390.checks.find((c) => c.id === 'projection-claude')).toMatchObject({
    id: 'projection-claude',
    status: 'ok',
  });

  // 3. Retry identity across 3.8.1 -> 3.9.0 upgrade: identical SHA-256 keys, zero missed retry keys!
  const decodedPrompt390 = decodeLifecycleEvent(profile390, promptPayload),
    boundPromptRetry390 = lifecycleInputIdentity(bindingDigestSeed, decodedPrompt390),
    decodedNative390 = createNativeLifecycleEvent(nativeInput),
    boundNativeRetry390 = lifecycleInputIdentity(bindingDigestSeed, decodedNative390);

  expect(decodedPrompt390).toEqual(from381.decodedPrompt);
  expect(boundPromptRetry390).toEqual(from381.boundPromptRetry);
  expect(decodedNative390).toEqual(from381.decodedNative);
  expect(boundNativeRetry390).toEqual(from381.boundNativeRetry);
  expect(boundPromptRetry390.key).toMatch(/^[a-f0-9]{64}$/);
  expect(boundNativeRetry390.key).toMatch(/^[a-f0-9]{64}$/);
}, 240_000);
