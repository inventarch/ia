import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { gitFiles } from '../docs/check.js';
import {
  discoverProjects,
  qualificationLeaves,
  readManifest,
  scriptLeaves,
  trackedTestFiles,
  validateManifest,
  validateBuildDependencies,
  workspaceGlobs,
  type Manifest,
  type ProjectDescriptor,
  type ProjectDiscovery,
  type TaskRecord,
  type VitestTask,
} from './inventory.js';
import { profileFor, SUBPROCESS_TIMEOUT_VARIABLE, vitestBounds, vitestEnvironment } from './timeouts.js';
import { taskTimeoutMs } from './run.js';
import { workflowEnvKeys } from './workflow.js';

const root = resolve(import.meta.dirname, '../..');

it('keeps a whole-suite budget independent of file count and individual case limits', () => {
  const one = task({ files: ['tests/a.test.ts'] });
  const many = task({ files: Array.from({ length: 100 }, (_, i) => `tests/${i}.test.ts`) });
  expect(taskTimeoutMs(root, one)).toBe(600_000);
  expect(taskTimeoutMs(root, many)).toBe(taskTimeoutMs(root, one));
  expect(taskTimeoutMs(root, task({ taskTimeoutMs: 900_000 }))).toBe(900_000);
  expect(() => taskTimeoutMs(root, task({ taskTimeoutMs: 0 }))).toThrow(/whole-task timeout/);
  expect(check([task({ taskTimeoutMs: 0 })]).join('\n')).toContain('taskTimeoutMs');
});

it('refuses a shard graph that omits a workspace build prerequisite', () => {
  const manifest = readManifest(root);
  expect(validateBuildDependencies(root, manifest)).toEqual([]);
  const broken = {
    ...manifest,
    tasks: manifest.tasks.map((task) => (task.id === 'graph:build' ? { ...task, dependsOn: [] } : task)),
  };
  expect(validateBuildDependencies(root, broken)).toContain(
    'graph:build: missing workspace build prerequisite language:build',
  );
});
const PROJECTS: readonly ProjectDescriptor[] = [
  { id: 'packages/thing', name: '@inventarch/thing', config: 'vitest.config.mts' },
];
const DISCOVERY: readonly ProjectDiscovery[] = [
  { project: 'packages/thing', files: ['tests/a.test.ts', 'tests/b.test.ts'] },
];
const LEAVES = ['node tools/x.ts'];
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    id: 'thing:test',
    kind: 'vitest',
    project: 'packages/thing',
    files: ['tests/a.test.ts', 'tests/b.test.ts'],
    profile: 'unit',
    platforms: ['linux', 'windows', 'macos'],
    mode: 'source',
    inputProfile: 'owner-source',
    dependsOn: [],
    outputs: ['artifacts/tests/thing-test'],
    cache: true,
    workerLimit: 1,
    resourceClass: 'pure',
    covers: LEAVES,
    ...overrides,
  }) as TaskRecord;
const manifest = (tasks: readonly TaskRecord[]): Manifest => ({
  schemaVersion: 1,
  profiles: {
    unit: {
      taskTimeoutMs: 600_000,
      hookTimeoutMs: 10_000,
      testTimeoutMs: 5_000,
      subprocessTimeoutMs: 10_000,
      workerLimit: 2,
    },
  },
  inputProfiles: { 'owner-source': 'the owning package and its dependency closure' },
  tasks,
});
const check = (
  tasks: readonly TaskRecord[],
  overrides: Partial<Parameters<typeof validateManifest>[0]> = {},
): readonly string[] =>
  validateManifest({
    manifest: manifest(tasks),
    projects: PROJECTS,
    discovery: DISCOVERY,
    leaves: LEAVES,
    tracked: [],
    ...overrides,
  });

it('accepts a manifest that assigns every discovered file once per platform', () => {
  expect(check([task()])).toEqual([]);
});

it('fails an unassigned test, a duplicate assignment and a selection Vitest never discovers', () => {
  expect(check([task({ files: ['tests/a.test.ts'] })]).join('\n')).toContain(
    'tests/b.test.ts: no task runs it on linux',
  );
  const duplicated = check([task(), task({ id: 'thing:again', outputs: ['artifacts/tests/thing-again'] })]).join('\n');
  expect(duplicated).toContain('thing:test, thing:again all claim it on linux');
  expect(check([task({ files: [...DISCOVERY[0]!.files, 'tests/ghost.test.ts'] })]).join('\n')).toContain(
    'selects tests/ghost.test.ts, which its Vitest configuration does not discover',
  );
});

it('fails an empty target, an unknown project and a project with no task at all', () => {
  expect(check([task({ files: [] })]).join('\n')).toContain('thing:test: selects no test file');
  expect(check([task({ project: 'packages/absent' })]).join('\n')).toContain('unknown Vitest project packages/absent');
  expect(check([task({ kind: 'command', command: 'echo', project: '.' } as Partial<TaskRecord>)]).join('\n')).toContain(
    'packages/thing: has a Vitest configuration but no assigned task',
  );
});

it('fails a test file that no Vitest configuration selects', () => {
  expect(
    check([task()], { tracked: ['packages/thing/tests/a.test.ts', 'packages/orphan/tests/lost.test.ts'] }).join('\n'),
  ).toContain('packages/orphan/tests/lost.test.ts: a test file no Vitest configuration selects');
});

it('fails unknown profiles, a worker limit above the profile ceiling and an unrecorded uncacheable task', () => {
  expect(check([task({ profile: 'invented' })]).join('\n')).toContain('unknown timeout profile invented');
  expect(check([task({ inputProfile: 'invented' })]).join('\n')).toContain('unknown input profile invented');
  expect(check([task({ workerLimit: 9 })]).join('\n')).toContain('9 workers exceeds what profile unit permits');
  expect(check([task({ cache: false })]).join('\n')).toContain('an uncacheable task must record why');
  expect(check([task({ cache: true, outputs: [] })]).join('\n')).toContain('a cacheable task must declare its outputs');
});

it('fails overlapping outputs, unknown and cyclic dependencies, and a duplicate identity', () => {
  const nested = check([
    task(),
    task({
      id: 'thing:build',
      kind: 'command',
      command: 'pnpm build',
      outputs: ['artifacts/tests'],
    } as Partial<TaskRecord>),
  ]).join('\n');
  expect(nested).toContain('overlapping output');
  expect(check([task({ dependsOn: ['thing:absent'] })]).join('\n')).toContain('depends on unknown task thing:absent');
  const cyclic = check([
    task({ dependsOn: ['thing:build'] }),
    task({
      id: 'thing:build',
      kind: 'command',
      command: 'pnpm build',
      files: undefined,
      dependsOn: ['thing:test'],
      outputs: ['artifacts/tests/thing-build'],
    } as Partial<TaskRecord>),
  ]).join('\n');
  expect(cyclic).toContain('Dependency cycle');
  expect(check([task(), task()]).join('\n')).toContain('duplicate task identity');
});

it('requires a named reason for every declared skip and refuses an unowned qualification leaf', () => {
  expect(check([task({ skips: [{ case: 'tests/a.test.ts > windows only', reason: '' }] })]).join('\n')).toContain(
    'an intentional skip needs a case and a named reason',
  );
  expect(check([task({ covers: [] })]).join('\n')).toContain(
    'Qualification leaf not covered by any task: node tools/x.ts',
  );
  expect(check([task({ covers: ['node tools/absent.ts'] })]).join('\n')).toContain(
    'which the qualification chain does not run',
  );
});

it('expands a script chain into the commands that actually execute', () => {
  const scripts = { a: 'pnpm b && node one.mjs', b: 'pnpm -r build && pnpm c', c: 'node two.mjs' };
  expect(scriptLeaves(scripts, 'a')).toEqual(['pnpm -r build', 'node two.mjs', 'node one.mjs']);
  expect(() => scriptLeaves(scripts, 'missing')).toThrow(/Unknown script/);
  expect(() => scriptLeaves({ a: 'pnpm b', b: 'pnpm a' }, 'a')).toThrow(/Recursive script chain/);
});

it('reads the workspace globs and refuses a form it cannot enumerate', () => {
  expect(workspaceGlobs('packages:\n  - "packages/*"\n  - apps/*\nnodeLinker: hoisted\n')).toEqual([
    'packages/*',
    'apps/*',
  ]);
  expect(() => workspaceGlobs('packages:\n  - "!excluded/**"\n')).toThrow(/Unsupported workspace glob/);
  expect(() => workspaceGlobs('catalog:\n  tsx: ^4\n')).toThrow(/no package globs/);
});

it('checks the actual repository manifest for shape, coverage and qualification ownership', () => {
  const projects = discoverProjects(root),
    manifest = readManifest(root);
  expect(projects.map((project) => project.id)).toContain('.');
  expect(projects.length).toBe(18);
  // Live discovery spawns Vitest per project and belongs to `pnpm tests:inventory`. Here the
  // manifest's own selections stand in, which still exercises identity, dependency, output,
  // profile and leaf-ownership rules against the real task set.
  const discovery = projects.map((project) => ({
    project: project.id,
    files: manifest.tasks.flatMap((task) => (task.kind === 'vitest' && task.project === project.id ? task.files : [])),
  }));
  expect(validateManifest({ manifest, projects, discovery, leaves: qualificationLeaves(root), tracked: [] })).toEqual(
    [],
  );
  expect(trackedTestFiles(root).length).toBe(251);
});

it('exposes the declared timeout profiles and refuses a worker limit above a ceiling', () => {
  const profile = profileFor(root, 'unit');
  expect(profile.testTimeoutMs).toBeGreaterThan(0);
  expect(vitestBounds(profile, 1)).toEqual({
    testTimeout: profile.testTimeoutMs,
    hookTimeout: profile.hookTimeoutMs,
    maxWorkers: 1,
  });
  expect(vitestBounds(profile).maxWorkers).toBe(profile.workerLimit);
  expect(() => vitestBounds(profile, profile.workerLimit + 1)).toThrow(/exceeds the/);
  expect(() => vitestBounds(profile, 0)).toThrow(/positive integer/);
  expect(() => profileFor(root, 'invented')).toThrow(/Unknown timeout profile/);
});

it('hands the task subprocess bound to the tests it runs without changing the caller environment', () => {
  const profile = profileFor(root, 'installed'),
    base = { PATH: 'kept', CI: 'already' };
  const env = vitestEnvironment(profile, base);
  expect(env[SUBPROCESS_TIMEOUT_VARIABLE]).toBe(String(profile.subprocessTimeoutMs));
  expect(env).toMatchObject({ PATH: 'kept', CI: 'already' });
  expect(vitestEnvironment(profile, {})['CI']).toBe('1');
  expect(base).toEqual({ PATH: 'kept', CI: 'already' });
  // Every profile a task names must exist, which is what keeps the two files from drifting.
  for (const task of readManifest(root).tasks) expect(() => profileFor(root, task.profile)).not.toThrow();
});

it("shares the task runner with every task, but not the runner's own tests", () => {
  // Every task executes through tools/testing/run.ts, so the runner's modules are shared inputs. Its tests are not:
  // a `tools/testing/*.ts` glob also matched them, and editing one invalidated every task on every platform. Nx
  // applies a negated pattern to all of a task's workspace-root file sets at once (tooling's `tools/**/*` included),
  // so `!tools/testing/*.test.ts` would drop the tests from tools:test-testing's own hash too. The modules are listed.
  const nx = JSON.parse(readFileSync(resolve(root, 'nx.json'), 'utf8')) as {
    namedInputs: { sharedGlobals: readonly unknown[] };
  };
  const shared = nx.namedInputs.sharedGlobals.filter((input): input is string => typeof input === 'string');
  expect(shared.filter((input) => input.startsWith('!'))).toEqual([]);
  const modules = gitFiles(root).filter(
    (path) => /^tools\/testing\/[^/]+\.ts$/.test(path) && !path.endsWith('.test.ts'),
  );
  expect(modules).toContain('tools/testing/run.ts');
  const runner = shared
    .filter((input) => input.startsWith('{workspaceRoot}/tools/testing/'))
    .map((input) => input.slice('{workspaceRoot}/'.length));
  expect([...runner].sort()).toEqual([...modules].sort());
});

it('hashes CI configuration only in the tools tasks that read it', () => {
  // A workflow edit used to invalidate every task on every platform, because nx.json listed the workflows in
  // sharedGlobals. The tasks that read CI configuration are tools-directory tasks, and those hash the root project's own
  // files, .github included (tools/testing/nx-plugin.mjs), so every other task keeps its result across a workflow edit.
  const nx = JSON.parse(readFileSync(resolve(root, 'nx.json'), 'utf8')) as {
    namedInputs: Readonly<Record<string, readonly unknown[]>>;
  };
  expect(
    Object.values(nx.namedInputs)
      .flat()
      .filter((input) => JSON.stringify(input).includes('.github')),
  ).toEqual([]);
  // An ignored .github would leave the readers' hashes too.
  expect(existsSync(resolve(root, '.nxignore')) ? readFileSync(resolve(root, '.nxignore'), 'utf8') : '').not.toContain(
    '.github',
  );
  // A task reads CI configuration when any source file in its own directory names .github as a path segment: a test or
  // a helper, spelled as a path or as join() segments. Its directory is its project, or each tools directory (or file
  // outside tools) a root task's files lie in.
  const naming = gitFiles(root).filter(
    (path) =>
      /\.[cm]?[jt]sx?$/.test(path) &&
      existsSync(resolve(root, path)) &&
      /(^|[^\w])\.github([/'"\\]|$)/.test(readFileSync(resolve(root, path), 'utf8')),
  );
  const directories = (task: VitestTask): readonly string[] =>
    task.project === '.'
      ? [...new Set(task.files.map((file) => /^tools\/[^/]+\//.exec(file)?.[0] ?? file))]
      : [`${task.project}/`];
  const readers = readManifest(root).tasks.filter(
    (task): task is VitestTask =>
      task.kind === 'vitest' &&
      directories(task).some((directory) => naming.some((path) => path.startsWith(directory))),
  );
  // The readers today, so the scan cannot pass by finding nothing.
  expect(readers.map((task) => task.id)).toEqual(
    expect.arrayContaining(['tools:test-testing', 'tools:test-cache', 'tools:test-review']),
  );
  // A reader outside one tools directory is owned by the root or a package, and would not hash .github.
  for (const task of readers)
    expect([task.id, directories(task)]).toEqual([task.id, [expect.stringMatching(/^tools\/[^/]+\/$/)]]);
});

/**
 * Workflow environment that cannot change a task's result. Package tasks no longer hash the workflow, so a variable a
 * task reads (a `TZ`, a `NODE_OPTIONS`, a new `IA_*` knob) must be an Nx `{ "env": … }` input, or a workflow edit would
 * silently reuse results computed without it.
 */
const RESULT_NEUTRAL_WORKFLOW_ENV: Readonly<Record<string, string>> = {
  RELEASE_SHA: 'Exact-commit publication prerequisite, outside every Nx task',
  RELEASE_VERSION: 'Requested publication version, outside every Nx task',
  REVIEWED_CHANGESET: 'Maintainer publication acknowledgement, outside every Nx task',
  IA_FULL: 'selects --full, which bypasses reuse; it never reaches a task',
  HOMEBREW_NO_AUTO_UPDATE: 'Homebrew smoke step only, outside every Nx task',
  HOMEBREW_NO_INSTALL_CLEANUP: 'Homebrew smoke step only, outside every Nx task',
  GH_TOKEN: "the Plan job's lookup of the last successful scheduled run, a gh call outside every Nx task",
  IA_REVIEW_RUN_ID: 'selects an upstream run for the uncached advisory review caller, outside every Nx task',
  IA_REVIEW_API: 'API origin for the uncached advisory review caller, outside every Nx task',
  IA_REVIEW_BINDING: 'workload binding for the uncached advisory review caller, outside every Nx task',
  IA_REVIEW_EVIDENCE: 'artifact directory read by the uncached advisory review caller, outside every Nx task',
};

it('reads every env: key of a workflow at each level, and refuses one it cannot read', () => {
  const text = [
    'env:',
    '  TOP: 1',
    'jobs:',
    '  a:',
    '    env:',
    '      JOB: "2"  # trailing',
    '    steps:',
    '      - name: s',
    '        env:',
    "          'STEP': x",
    '          NESTED:',
    '            deeper: no',
  ].join('\r\n');
  expect(workflowEnvKeys(text)).toEqual(['TOP', 'JOB', 'STEP', 'NESTED']);
  expect(() => workflowEnvKeys('jobs:\n  a:\n    env: { HIDDEN: 1 }\n')).toThrow(/not a block mapping/);
});

it('declares every workflow env key a task could read as an Nx env input', () => {
  const nx = JSON.parse(readFileSync(resolve(root, 'nx.json'), 'utf8')) as {
    namedInputs: Readonly<Record<string, readonly unknown[]>>;
  };
  const declared = new Set(
    Object.values(nx.namedInputs)
      .flat()
      .flatMap((input) =>
        typeof input === 'object' && input !== null && typeof (input as { env?: unknown }).env === 'string'
          ? [(input as { env: string }).env]
          : [],
      ),
  );
  const workflows = gitFiles(root).filter(
    (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) && existsSync(resolve(root, path)),
  );
  expect(workflows).toContain('.github/workflows/platform-quality.yml');
  const keys = new Set(workflows.flatMap((path) => workflowEnvKeys(readFileSync(resolve(root, path), 'utf8'))));
  // The epoch is read, so the scan cannot pass by finding nothing.
  expect(keys).toContain('NX_CACHE_EPOCH');
  expect([...keys].filter((key) => !declared.has(key) && !(key in RESULT_NEUTRAL_WORKFLOW_ENV))).toEqual([]);
  // A key that is both declared and allowlisted, or allowlisted but gone, is a stale reason.
  expect(Object.keys(RESULT_NEUTRAL_WORKFLOW_ENV).filter((key) => declared.has(key) || !keys.has(key))).toEqual([]);
});

it('refuses unknown capability predicates in declared skips', () => {
  const skip = {
    case: 'tests/a.test.ts > fixture',
    reason: 'Named capability.',
    platforms: ['windows'] as const,
    when: 'file-symlink-unavailable' as const,
  };
  expect(check([task({ skips: [skip] })])).toEqual([]);
  const invalid = JSON.parse(JSON.stringify({ ...skip, when: 'invented-capability' }));
  expect(check([task({ skips: [invalid] })]).join('\n')).toContain('unknown skip condition');
});
