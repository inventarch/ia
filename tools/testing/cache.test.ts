import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as subprocess from './subprocess.js';
import { orchestrate } from './orchestrate.js';
import { artifactDirectory } from './run.js';
import { readManifest } from './inventory.js';
import { looksLikeCacheTransportFailure } from './orchestrate.js';
import { runBounded } from './subprocess.js';

/**
 * Behavioural cache probes. These mutate real inputs and observe whether Nx executed or restored
 * the task; none of them compares generated configuration text, because matching configuration is
 * not evidence that a hash changed.
 */

const sourceRoot = resolve(import.meta.dirname, '../..');
let root: string;
const PROBE = 'language:build';
const MARKER = 'probe: a changed execution contract must invalidate its results';
const evidencePath = (): string =>
  resolve(root, artifactDirectory(readManifest(root).tasks.find((task) => task.id === PROBE)!), 'evidence.json');
let cacheDirectory: string, workspaceData: string;
let previous: {
  cache: string | undefined;
  data: string | undefined;
  daemon: string | undefined;
  epoch: string | undefined;
};
// NX_WORKSPACE_ROOT_PATH belongs to the caller's checkout, not to this probe's temp workspace, and an inherited
// one makes every nested run resolve there instead — a "cold" probe then restores from that tree's cache.
const OUTER_TASK_VARIABLES = [
  'NX_TASK_HASH',
  'NX_TASK_TARGET_PROJECT',
  'NX_TASK_TARGET_TARGET',
  'NX_TASK_TARGET_CONFIGURATION',
  'NX_SKIP_NX_CACHE',
  'NX_DISABLE_NX_CACHE',
  'NX_WORKSPACE_ROOT_PATH',
] as const;
const inherited: Record<string, string | undefined> = {};

// Nx 23.2.1's persisted file-hash archive uses whole-second mtimes on Linux/macOS.
// A rapid edit/restore can otherwise reuse the edited hash after the bytes were restored.
// Give every disposable input write a distinct whole-second stamp; never sleep or clear
// the task cache, whose real mutation/restoration behavior these cases must still prove.
let inputModifiedAt = 0;
const writeInput = (path: string, bytes: string | Uint8Array): void => {
  writeFileSync(path, bytes);
  inputModifiedAt = Math.max(inputModifiedAt, Math.floor(statSync(path).mtimeMs / 1000)) + 1;
  utimesSync(path, inputModifiedAt, inputModifiedAt);
};

const outcome = async (task: string): Promise<'executed' | 'restored'> => {
  const result = await orchestrate(root, { tasks: [task], timeoutMs: 10 * 60_000 });
  expect(result.status).toBe('passed');
  return result.executed.includes(task) ? 'executed' : 'restored';
};
const run = (): Promise<'executed' | 'restored'> => outcome(PROBE);

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), 'ia-cache-probe-workspace-'));
  // Use independent packed objects rather than copying every loose Git object on Windows.\n  // Copy working inputs, never mutate the checkout that another process may commit.
  execFileSync('git', ['clone', '--no-local', '--quiet', sourceRoot, root]);
  // Clone already materializes HEAD. Overlay only current working changes and untracked inputs,
  // preserving the source view without copying every committed file a second time.
  const files = [
    ...new Set(
      [
        ...execFileSync('git', ['diff', 'HEAD', '--no-renames', '--name-only', '-z'], {
          cwd: sourceRoot,
          encoding: 'utf8',
        }).split('\0'),
        ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd: sourceRoot,
          encoding: 'utf8',
        }).split('\0'),
      ].filter(Boolean),
    ),
  ];
  for (const file of files) {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    if (existsSync(resolve(sourceRoot, file))) cpSync(resolve(sourceRoot, file), resolve(root, file));
    else rmSync(resolve(root, file), { force: true });
  }
  // The language build has no workspace dependencies; only installed tool binaries are shared.
  symlinkSync(resolve(sourceRoot, 'node_modules'), resolve(root, 'node_modules'), 'junction');
  cacheDirectory = mkdtempSync(resolve(tmpdir(), 'ia-cache-probe-'));
  workspaceData = mkdtempSync(resolve(tmpdir(), 'ia-cache-probe-data-'));
  previous = {
    cache: process.env['NX_CACHE_DIRECTORY'],
    data: process.env['NX_WORKSPACE_DATA_DIRECTORY'],
    daemon: process.env['NX_DAEMON'],
    epoch: process.env['NX_CACHE_EPOCH'],
  };
  // This probe drives Nx while Nx may already be driving it. An isolated task cache, an isolated
  // project-graph store and no daemon keep the nested run from contending with the outer one.
  process.env['NX_CACHE_DIRECTORY'] = cacheDirectory;
  process.env['NX_WORKSPACE_DATA_DIRECTORY'] = workspaceData;
  process.env['NX_DAEMON'] = 'false';
  // An outer Nx task stamps its own coordinates into the environment; a nested run must not inherit
  // them, or it reports on the task that invoked it instead of the one it started.
  for (const name of OUTER_TASK_VARIABLES) {
    inherited[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  for (const [name, value] of [
    ['NX_CACHE_DIRECTORY', previous.cache],
    ['NX_WORKSPACE_DATA_DIRECTORY', previous.data],
    ['NX_DAEMON', previous.daemon],
    ['NX_CACHE_EPOCH', previous.epoch],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const path of [cacheDirectory, workspaceData, root]) {
    if (!path.startsWith(resolve(tmpdir(), 'ia-cache-probe-'))) throw new Error('Unexpected temporary cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
});

it(
  'executes a cold task, then restores the identical one',
  async () => {
    // The parent and child wall clocks need not agree (for example, WSL clock correction).
    // A forward parent clock must not relabel executed work as restored, or vice versa.
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 86_400_000);
    try {
      expect(await run()).toBe('executed');
    } finally {
      clock.mockRestore();
    }
    const first = JSON.parse(readFileSync(evidencePath(), 'utf8')) as {
      hash: string;
      report: { execution: { startedAt: string } };
    };
    const backwards = vi.spyOn(Date, 'now').mockImplementation(() => now() - 86_400_000);
    try {
      expect(await run()).toBe('restored');
    } finally {
      backwards.mockRestore();
    }
    const second = JSON.parse(readFileSync(evidencePath(), 'utf8')) as {
      hash: string;
      outcome: string;
      report: { execution: { startedAt: string } };
    };
    expect(second.hash).toBe(first.hash);
    expect(second.outcome).toBe('restored');
    // A restored report keeps the writer's execution, not this run's.
    expect(second.report.execution.startedAt).toBe(first.report.execution.startedAt);
  },
  20 * 60_000,
);

it(
  'misses when a dynamically discovered input appears and hits again once it is gone',
  async () => {
    const added = resolve(root, 'packages/language/probe-input.txt');
    try {
      expect(await run()).toBe('restored');
      writeInput(added, 'an input this task discovers through the filesystem, not through an import\n');
      expect(await run()).toBe('executed');
    } finally {
      rmSync(added, { force: true });
    }
    expect(await run()).toBe('restored');
    expect(existsSync(added)).toBe(false);
  },
  20 * 60_000,
);

it(
  'misses when the declared test implementation changes',
  async () => {
    const path = resolve(root, 'packages/language/vitest.config.mts');
    const original = readFileSync(path, 'utf8');
    // This case edits a tracked file, so a previous interrupted run must never become the baseline:
    // restoring a leftover marker would commit it, and the probe would then assert against itself.
    expect(original).not.toContain(MARKER);
    try {
      writeInput(path, `${original}// ${MARKER}\n`);
      expect(await run()).toBe('executed');
    } finally {
      writeInput(path, original);
    }
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(await run()).toBe('restored');
  },
  20 * 60_000,
);
it(
  'misses when the temporary-directory selector every task imports changes',
  async () => {
    // Every task runs this module: tools/testing/run.ts and the Vitest configurations import it. Importers hash it
    // through the tools-temp project; nx.json keeps it in sharedGlobals for a task that reaches it only through the runner.
    const path = resolve(root, 'tools/temp/physical-temp.mjs');
    const original = readFileSync(path, 'utf8');
    expect(original).not.toContain(MARKER);
    expect(await run()).toBe('restored');
    try {
      writeInput(path, `${original}// ${MARKER}\n`);
      expect(await run()).toBe('executed');
    } finally {
      writeInput(path, original);
    }
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(await run()).toBe('restored');
  },
  20 * 60_000,
);
it.each(['examples/public-language/cache-probe.ia', 'apps/cli/assets/cache-probe.txt', 'NOTICE.cache-probe'])(
  'invalidates restored results after the public input %s changes',
  async (file) => {
    const path = resolve(root, file);
    expect(existsSync(path)).toBe(false);
    expect(await run()).toBe('restored');
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeInput(path, 'Public input mutation probe.\n');
      expect(await run()).toBe('executed');
    } finally {
      rmSync(path, { force: true });
    }
    expect(await run()).toBe('restored');
  },
  20 * 60_000,
);

it(
  'invalidates shared results when the active Biome configuration changes',
  async () => {
    const configurations = ['biome.json', 'biome.jsonc'].filter((file) => existsSync(resolve(root, file)));
    expect(configurations).toHaveLength(1);
    const path = resolve(root, configurations[0]!);
    const original = readFileSync(path, 'utf8');
    // Both accepted spellings use a real boolean setting. Keep the edited JSON/JSONC valid.
    const changed = original.replace(
      /("enabled"\s*:\s*)(true|false)/,
      (_match, key: string, value: string) => key + (value === 'true' ? 'false' : 'true'),
    );
    expect(changed).not.toBe(original);
    await run();
    expect(await run()).toBe('restored');
    try {
      writeInput(path, changed);
      expect(await run()).toBe('executed');
    } finally {
      writeInput(path, original);
    }
    expect(await run()).toBe('restored');
  },
  20 * 60_000,
);

it(
  'misses when the cache policy epoch is bumped',
  async () => {
    expect(await run()).toBe('restored');
    const epoch = process.env['NX_CACHE_EPOCH'];
    process.env['NX_CACHE_EPOCH'] = `probe-${Date.now()}`;
    try {
      expect(await run()).toBe('executed');
    } finally {
      if (epoch === undefined) delete process.env['NX_CACHE_EPOCH'];
      else process.env['NX_CACHE_EPOCH'] = epoch;
    }
    expect(await run()).toBe('restored');
  },
  20 * 60_000,
);

it('separates a cache transport failure from a failing test', () => {
  for (const output of [
    'Remote cache: connect ECONNREFUSED 10.0.0.1:443',
    'Failed to reach the remote cache server',
    'Remote cache: 401 Unauthorized',
    ' NX   Failed to unpack entry: failed to unpack `D:/a/ia/ia/.nx/cache/build/file.js.map`',
  ]) {
    expect(looksLikeCacheTransportFailure(output)).toBe(true);
  }
  for (const output of [
    'AssertionError: expected 1 to be 2',
    'Test Files  1 failed (1)',
    'spawnSync node.exe ETIMEDOUT',
    'connect ECONNREFUSED 127.0.0.1:3000',
    '401 Unauthorized',
    'Remote cache disabled: --remote was not requested',
    'NX_SELF_HOSTED_REMOTE_CACHE_SERVER is configured',
  ]) {
    expect(looksLikeCacheTransportFailure(output)).toBe(false);
  }
});

it('reexecutes after Nx reports unpack failure with success status and preserves a retry failure', async () => {
  const result = {
    command: 'npx',
    status: 0,
    signal: null,
    stdout: ' NX   Failed to unpack entry: failed to unpack `cache/file.js.map`',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
  const invoke = vi
    .spyOn(subprocess, 'runBounded')
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ ...result, status: 1, stdout: 'Test Files 1 failed' });
  try {
    const outcome = await orchestrate(root, { tasks: [PROBE] });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![1]).not.toContain('--skip-nx-cache');
    expect(invoke.mock.calls[1]![1]).toContain('--skip-nx-cache');
    expect(invoke.mock.calls[1]![2].env).not.toHaveProperty('NX_SELF_HOSTED_REMOTE_CACHE_SERVER');
    expect(invoke.mock.calls[1]![2].env).not.toHaveProperty('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN');
    expect(outcome.status).toBe('failed');
  } finally {
    invoke.mockRestore();
  }
});

let installation: Promise<void> | undefined;
/**
 * Replaces the shared root junction with a real install of the clone. Workspace packages resolve one
 * another by name through links a junction does not carry, and a real install is also necessary for
 * portable declaration generation: sharing package junctions resolves inferred types back into the
 * original checkout (TS2742). The populated store is resolved in the source checkout, because a Windows
 * temp clone can be on a different drive, where pnpm otherwise selects a different, empty store.
 */
const installWorkspace = (): Promise<void> =>
  (installation ??= (async () => {
    const storeDirectory = execFileSync('pnpm', ['store', 'path'], {
      cwd: sourceRoot,
      shell: true,
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
    if (!existsSync(storeDirectory)) throw new Error(`Source pnpm store does not exist: ${storeDirectory}`);
    rmSync(resolve(root, 'node_modules'), { recursive: true, force: true });
    const installed = await runBounded(
      'pnpm',
      ['install', '--prefer-offline', '--frozen-lockfile', '--ignore-scripts'],
      {
        cwd: root,
        shell: true,
        timeoutMs: 120_000,
        env: { ...process.env, npm_config_store_dir: storeDirectory },
      },
    );
    if (installed.status !== 0 || installed.timedOut)
      throw new Error(
        `Probe install failed (status ${installed.status}, timed out: ${installed.timedOut}, store: ${storeDirectory})\n${installed.stdout}\n${installed.stderr}`,
      );
  })());

// A tools task imports package sources by relative path, reads root documents through the filesystem, and
// shares a directory tree with unrelated tools. Its result must follow the first two and ignore the third.
const TOOL = 'kernel:check';
const probeFile = async (
  file: string,
): Promise<{ changed: 'executed' | 'restored'; after: 'executed' | 'restored' }> => {
  const path = resolve(root, file);
  expect(existsSync(path)).toBe(false);
  await installWorkspace();
  await outcome(TOOL);
  let changed: 'executed' | 'restored';
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeInput(path, 'export const cacheProbe = true;\n');
    changed = await outcome(TOOL);
  } finally {
    rmSync(path, { force: true });
  }
  return { changed, after: await outcome(TOOL) };
};

it.each([
  // The kernel generator imports packages/language/src; the import graph, not a declared list, makes it an input.
  'packages/language/src/cache-probe.ts',
  // A fixture beside a dependency's tests can be imported by a consumer's test, so it stays an input.
  'packages/language/tests/cache-probe-fixture.ts',
  // Root documents are read through the filesystem, which no import graph sees.
  'docs/cache-probe.md',
])(
  'misses a tools task when %s changes',
  async (file) => {
    expect(await probeFile(file)).toEqual({ changed: 'executed', after: 'restored' });
  },
  20 * 60_000,
);

it.each([
  // An unrelated tool's test is neither imported nor read by the kernel generator.
  'tools/docs/cache-probe.test.ts',
  // The task runner is every task's input, but its tests are not.
  'tools/testing/cache-probe.test.ts',
  // A dependency's test file is never imported by its consumers.
  'packages/language/tests/cache-probe.test.ts',
])(
  'restores a tools task when only %s changes',
  async (file) => {
    expect(await probeFile(file)).toEqual({ changed: 'restored', after: 'restored' });
  },
  20 * 60_000,
);

it(
  "invalidates a task when its own manifest entry changes, not when another project's does",
  async () => {
    await installWorkspace();
    const path = resolve(root, 'tools/testing/tasks.json');
    const original = readFileSync(path, 'utf8');
    expect(original).not.toContain('"taskTimeoutMs": 599999');
    const withTimeout = (id: string): string => {
      const manifest = JSON.parse(original) as { tasks: { id: string; taskTimeoutMs?: number }[] };
      const entry = manifest.tasks.find((task) => task.id === id);
      if (!entry) throw new Error(`Unknown task ${id}`);
      entry.taskTimeoutMs = 599_999;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    };
    // Warm the baseline here rather than relying on an earlier case having run.
    await outcome(TOOL);
    expect(await outcome(TOOL)).toBe('restored');
    try {
      writeInput(path, withTimeout('tools:test-docs'));
      expect(await outcome(TOOL)).toBe('restored');
      writeInput(path, withTimeout(TOOL));
      expect(await outcome(TOOL)).toBe('executed');
    } finally {
      writeInput(path, original);
    }
    expect(await outcome(TOOL)).toBe('restored');
  },
  20 * 60_000,
);

it(
  'hashes selected CLI tests independently while retaining helpers, production and read trees',
  async () => {
    await installWorkspace();
    // Ask the installed Nx hasher in a fresh process after each mutation. This exercises real
    // project/dependency expansion and exclusion precedence without rerunning long host journeys.
    const source = `
    const { createProjectGraphAsync } = require('nx/src/project-graph/project-graph');
    const { createTaskGraph } = require('nx/src/tasks-runner/create-task-graph');
    const { createTaskHasher } = require('nx/src/hasher/create-task-hasher');
    const { readNxJson } = require('nx/src/config/nx-json');
    (async () => {
      const graph = await createProjectGraphAsync();
      const targets = ['cli-test-unit', 'cli-test-host-registration', 'cli-test-host-doctor'];
      const taskGraph = createTaskGraph(graph, {}, ['@inventarch/cli'], targets, undefined, {}, true);
      const tasks = Object.values(taskGraph.tasks);
      const hashes = await createTaskHasher(graph, readNxJson(), {}).hashTasks(tasks, taskGraph, process.env);
      console.log(JSON.stringify(Object.fromEntries(tasks.map((task, index) => [task.target.target, hashes[index].value]))));
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `;
    const hashes = async (): Promise<Record<string, string>> => {
      const result = await runBounded(process.execPath, ['-e', source], {
        cwd: root,
        timeoutMs: 120_000,
        env: { ...process.env, NX_DAEMON: 'false' },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim()) as Record<string, string>;
    };
    const baseline = await hashes();
    const probe = async (file: string): Promise<Record<string, boolean>> => {
      const path = resolve(root, file),
        original = existsSync(path) ? readFileSync(path) : null;
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Whitespace is sufficient to change the input and preserves JSON, TS and IA syntax.
        writeInput(path, Buffer.concat([original ?? Buffer.from(''), Buffer.from('\n ')]));
        const changed = await hashes();
        return Object.fromEntries(Object.keys(baseline).map((task) => [task, changed[task] !== baseline[task]]));
      } finally {
        if (original === null) rmSync(path);
        else writeInput(path, original);
        expect(await hashes(), `Restored ${file}`).toEqual(baseline);
      }
    };
    expect(await probe('apps/cli/tests/args.test.ts')).toEqual({
      'cli-test-unit': true,
      'cli-test-host-registration': false,
      'cli-test-host-doctor': false,
    });
    expect(await probe('apps/cli/tests/host-registration.test.ts')).toEqual({
      'cli-test-unit': false,
      'cli-test-host-registration': true,
      'cli-test-host-doctor': false,
    });
    for (const file of [
      'apps/cli/tests/host-fixture.ts',
      'apps/cli/tests/cache-probe-helper.ts',
      'apps/cli/src/args.ts',
      'apps/cli/assets/cache-probe.txt',
    ]) {
      expect(await probe(file), file).toEqual({
        'cli-test-unit': true,
        'cli-test-host-registration': true,
        'cli-test-host-doctor': true,
      });
    }
    const records = await probe('.ia/authoring.resources.json');
    expect(records['cli-test-host-registration']).toBe(true);
    expect(records['cli-test-host-doctor']).toBe(true);
    expect(await hashes()).toEqual(baseline);
  },
  20 * 60_000,
);

it(
  'invalidates native corpus readers for edits and new records while preserving unrelated builds',
  async () => {
    await installWorkspace();
    const readers = [
      'graph:test',
      'compliance:test',
      'vscode:test',
      'db:test',
      'runtime:test',
      'authoring-system:test',
      'language:test',
    ];
    const source = `
    const { readFileSync } = require('node:fs');
    const { createProjectGraphAsync } = require('nx/src/project-graph/project-graph');
    const { createTaskGraph } = require('nx/src/tasks-runner/create-task-graph');
    const { createTaskHasher } = require('nx/src/hasher/create-task-hasher');
    const { readNxJson } = require('nx/src/config/nx-json');
    (async () => {
      const { nxTaskFor } = await import('./tools/testing/nx-plugin.mjs');
      const manifest = JSON.parse(readFileSync('tools/testing/tasks.json', 'utf8'));
      const ids = ${JSON.stringify([...readers, 'language:build'])};
      const references = ids.map(id => nxTaskFor(process.cwd(), manifest.tasks, id));
      const coordinates = references.map(ref => ref.split(':'));
      const graph = await createProjectGraphAsync();
      const taskGraph = createTaskGraph(graph, {}, [...new Set(coordinates.map(row => row[0]))], coordinates.map(row => row[1]), undefined, {}, true);
      const tasks = references.map(ref => taskGraph.tasks[ref]);
      if (tasks.some(task => !task)) throw new Error('Missing native-reader task');
      const hashes = await createTaskHasher(graph, readNxJson(), {}).hashTasks(tasks, taskGraph, process.env);
      console.log(JSON.stringify(Object.fromEntries(ids.map((id, index) => [id, hashes[index].value]))));
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `;
    const hashes = async (): Promise<Record<string, string>> => {
      const result = await runBounded(process.execPath, ['-e', source], {
        cwd: root,
        timeoutMs: 120_000,
        env: { ...process.env, NX_DAEMON: 'false' },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim()) as Record<string, string>;
    };
    const baseline = await hashes();
    const probe = async (file: string, affected: readonly string[]): Promise<void> => {
      const path = resolve(root, file),
        original = existsSync(path) ? readFileSync(path) : null;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeInput(
          path,
          Buffer.concat([original ?? Buffer.from('#! ia 1.0\n'), Buffer.from('\n# cache input mutation\n')]),
        );
        const changed = await hashes();
        for (const id of affected) expect(changed[id], `${id} after ${file}`).not.toBe(baseline[id]);
        // Production language builds consume the generated embed, not these authored test inputs.
        expect(changed['language:build'], file).toBe(baseline['language:build']);
      } finally {
        if (original === null) rmSync(path);
        else writeInput(path, original);
        expect(await hashes(), `Restored ${file}`).toEqual(baseline);
      }
    };
    await probe('.ia/src/floor/kind.ia', readers);
    await probe('.ia/src/floor/cache-probe.ia', readers);
    await probe('packages/compliance/fixtures/language/format/pass/token-spacing.ia', ['language:test']);
  },
  20 * 60_000,
);
