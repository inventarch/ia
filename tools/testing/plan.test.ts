import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { PLATFORMS, type Manifest, type TaskRecord } from './inventory.js';
import { buildReport, currentPlatform, readVitestResults, writeEvidence, type GateEvidence } from './report.js';
import {
  BORROWED_PLATFORM,
  CONSERVATIVE_ESTIMATE_SECONDS,
  PULL_REQUEST_PLATFORMS,
  RUNNERS,
  borrowedRatio,
  ciMatrices,
  emptySchedule,
  estimateFor,
  eventPlatforms,
  gateMatrix,
  laneOf,
  planShards,
  platformCounts,
  runNeeded,
  selectedPlatforms,
  updateSchedule,
  type Schedule,
} from './plan.js';
import { GATE_JOB, qualifyNeeds, qualifyRows, workflowJobs } from './workflow.js';

const root = resolve(import.meta.dirname, '../..');
// The profile's subprocess bound, which pnpm tests:run passes to Vitest; a direct Vitest run uses the fallback.
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 120_000;
const workflow = (): string => readFileSync(resolve(root, '.github/workflows/platform-quality.yml'), 'utf8');
/** The Plan job's planner arguments, with the GitHub expressions it passes replaced by one run's values. */
function planArgs(run: { readonly event: string; readonly sha: string; readonly verified: string }): string[] {
  const command = /pnpm --silent tests:plan (.*?) >> "\$GITHUB_OUTPUT"/.exec(workflow())?.[1];
  if (command === undefined) throw new Error('The Plan job does not run tests:plan into $GITHUB_OUTPUT');
  const filled = command
    .replaceAll('${{ github.event_name }}', run.event)
    .replaceAll('${{ github.sha }}', run.sha)
    .replaceAll('${{ steps.verified.outputs.sha }}', run.verified);
  if (filled.includes('${{')) throw new Error(`Unexpected expression in the planner arguments: ${filled}`);
  return filled.split(' ').map((arg) => arg.replace(/^"(.*)"$/, '$1'));
}

const base: TaskRecord = {
  id: 'thing:test',
  kind: 'vitest',
  project: 'packages/thing',
  files: ['tests/a.test.ts'],
  profile: 'unit',
  platforms: ['linux', 'windows'],
  mode: 'source',
  inputProfile: 'owner-source',
  dependsOn: [],
  outputs: ['artifacts/tests/thing-test'],
  cache: true,
  workerLimit: 1,
  resourceClass: 'pure',
};
const test = (id: string, resourceClass: TaskRecord['resourceClass'] = 'pure'): TaskRecord => ({
  ...base,
  id,
  resourceClass,
  outputs: [`artifacts/tests/${id.replace(':', '-')}`],
});
const command = (id: string, mode: TaskRecord['mode'] = 'source'): TaskRecord =>
  ({
    ...base,
    id,
    kind: 'command',
    command: 'pnpm build',
    mode,
    outputs: [`artifacts/tests/${id.replace(':', '-')}`],
  }) as TaskRecord;
const manifest = (tasks: readonly TaskRecord[]): Manifest => ({
  schemaVersion: 1,
  profiles: {},
  inputProfiles: {},
  tasks,
});
const schedule = (seconds: Readonly<Record<string, number>>): Schedule => ({
  version: 1,
  platforms: { linux: seconds, windows: {}, macos: {} },
});

it('sorts tasks into build, static, test and emitted lanes', () => {
  expect(laneOf(command('thing:build'))).toBe('build');
  expect(laneOf(command('thing:typecheck'))).toBe('static');
  expect(laneOf(test('thing:test'))).toBe('tests');
  expect(laneOf(command('service:qualify', 'emitted'))).toBe('emitted');
});

it('puts every prerequisite in the build lane so dependants can restore it', () => {
  const producer = command('assets:generate');
  const consumers = [
    { ...command('thing:typecheck'), dependsOn: ['assets:generate'] },
    { ...test('thing:test'), dependsOn: ['assets:generate'] },
  ];
  expect(laneOf(producer, true)).toBe('build');
  expect(laneOf(command('service:qualify', 'emitted'), true)).toBe('emitted');
  const plan = planShards(manifest([producer, ...consumers]), emptySchedule(), {
    platform: 'linux',
    shards: 1,
    nativeShards: 0,
  });
  expect(plan.lanes).toMatchObject({ build: ['assets:generate'], static: ['thing:typecheck'], tests: ['thing:test'] });
});

it('places the longest task first into the least loaded compatible shard', () => {
  const tasks = [test('a:test'), test('b:test'), test('c:test'), test('d:test')];
  const plan = planShards(manifest(tasks), schedule({ 'a:test': 100, 'b:test': 60, 'c:test': 50, 'd:test': 10 }), {
    platform: 'linux',
    shards: 2,
    nativeShards: 0,
  });
  expect(plan.shards.map((shard) => shard.tasks)).toEqual([
    ['a:test', 'd:test'],
    ['b:test', 'c:test'],
  ]);
  expect(plan.estimated.longestShardSeconds).toBe(110);
});

it('breaks ties by task identity so the same inputs always produce the same plan', () => {
  const tasks = [test('b:test'), test('a:test'), test('d:test'), test('c:test')];
  const durations = { 'a:test': 10, 'b:test': 10, 'c:test': 10, 'd:test': 10 };
  const first = planShards(manifest(tasks), schedule(durations), { platform: 'linux', shards: 2, nativeShards: 0 });
  const shuffled = planShards(manifest([...tasks].reverse()), schedule(durations), {
    platform: 'linux',
    shards: 2,
    nativeShards: 0,
  });
  expect(shuffled.shards).toEqual(first.shards);
  expect(first.shards[0]!.tasks).toEqual(['a:test', 'c:test']);
});

it('keeps native-heavy work on its reserved shards', () => {
  const tasks = [
    test('heavy:test', 'native-heavy'),
    test('also:test', 'native-heavy'),
    test('light:test'),
    test('small:test'),
  ];
  const plan = planShards(manifest(tasks), schedule({}), { platform: 'linux', shards: 3, nativeShards: 1 });
  expect(plan.shards[0]!.resourceClass).toBe('native-heavy');
  expect(plan.shards[0]!.tasks).toEqual(['also:test', 'heavy:test']);
  expect(
    plan.shards
      .slice(1)
      .flatMap((shard) => shard.tasks)
      .sort(),
  ).toEqual(['light:test', 'small:test']);
});

it('gives an unknown task a conservative estimate and still schedules it', () => {
  expect(estimateFor(emptySchedule(), 'linux', 'new:test')).toEqual({
    seconds: CONSERVATIVE_ESTIMATE_SECONDS,
    known: false,
    borrowed: false,
  });
  expect(estimateFor(schedule({ 'slow:test': 5_000 }), 'linux', 'new:test').seconds).toBe(5_000);
  const plan = planShards(manifest([test('new:test')]), emptySchedule(), {
    platform: 'linux',
    shards: 2,
    nativeShards: 0,
  });
  expect(plan.shards.flatMap((shard) => shard.tasks)).toEqual(['new:test']);
  expect(plan.estimated.unknownTasks).toEqual(['new:test']);
});

it('fills spare native capacity with general work after placing constrained tasks', () => {
  const tasks = [test('heavy:test', 'native-heavy'), test('large:test'), test('medium:test'), test('small:test')];
  const durations = schedule({ 'heavy:test': 40, 'large:test': 100, 'medium:test': 60, 'small:test': 40 });
  const options = { platform: 'linux' as const, shards: 3, nativeShards: 1 };
  const plan = planShards(manifest(tasks), durations, options);
  expect(plan.shards.map((shard) => shard.tasks)).toEqual([
    ['heavy:test', 'small:test'],
    ['large:test'],
    ['medium:test'],
  ]);
  expect(plan.estimated.longestShardSeconds).toBe(100);
  expect(planShards(manifest([...tasks].reverse()), durations, options).shards).toEqual(plan.shards);
  expect(plan.shards.flatMap((shard) => shard.tasks).sort()).toEqual(tasks.map((task) => task.id).sort());
});

it('places each task a platform has not recorded by its Linux duration, scaled by the median ratio', () => {
  const recorded: Schedule = {
    version: 1,
    platforms: {
      linux: { 'a:test': 100, 'b:test': 5, 'c:test': 20 },
      windows: { 'b:test': 50, 'c:test': 100 },
      macos: {},
    },
  };
  expect(BORROWED_PLATFORM).toBe('linux');
  // With no record of its own, a platform takes Linux's durations as they are.
  expect(borrowedRatio(recorded, 'macos')).toBe(1);
  expect(estimateFor(recorded, 'macos', 'a:test')).toEqual({ seconds: 100, known: true, borrowed: true });
  expect(estimateFor(recorded, 'macos', 'new:test')).toEqual({
    seconds: CONSERVATIVE_ESTIMATE_SECONDS,
    known: false,
    borrowed: false,
  });
  // A partial record (ratios 10 and 5, median 7.5) scales Linux's duration for each task it lacks, instead of giving every
  // one of them the conservative estimate.
  expect(borrowedRatio(recorded, 'windows')).toBe(7.5);
  expect(estimateFor(recorded, 'windows', 'a:test')).toEqual({ seconds: 750, known: true, borrowed: true });
  expect(estimateFor(recorded, 'windows', 'b:test')).toEqual({ seconds: 50, known: true, borrowed: false });
  // A task neither this platform nor Linux recorded still costs at least the slowest known estimate, scaled ones included.
  expect(estimateFor(recorded, 'windows', 'new:test')).toEqual({ seconds: 750, known: false, borrowed: false });
  // Linux never borrows.
  expect(borrowedRatio(recorded, 'linux')).toBe(1);
  expect(estimateFor(recorded, 'linux', 'x:test')).toEqual({
    seconds: CONSERVATIVE_ESTIMATE_SECONDS,
    known: false,
    borrowed: false,
  });
  const unrecorded = { version: 1, platforms: { linux: { 'a:test': 100 } } } as unknown as Schedule;
  expect(estimateFor(unrecorded, 'macos', 'a:test').seconds).toBe(100);
  // Borrowed durations place the tasks exactly as on Linux; with equal estimates they would be split by identity instead.
  const tasks = [test('a:test'), test('b:test'), test('c:test'), test('d:test')].map((task) => ({
    ...task,
    platforms: [...PLATFORMS],
  }));
  const durations: Schedule = {
    version: 1,
    platforms: { linux: { 'a:test': 100, 'b:test': 60, 'c:test': 50, 'd:test': 10 }, windows: {}, macos: {} },
  };
  const linux = planShards(manifest(tasks), durations, { platform: 'linux', shards: 2, nativeShards: 0 });
  const macos = planShards(manifest(tasks), durations, { platform: 'macos', shards: 2, nativeShards: 0 });
  expect(macos.shards).toEqual(linux.shards);
  expect(macos.shards.map((shard) => shard.tasks)).toEqual([
    ['a:test', 'd:test'],
    ['b:test', 'c:test'],
  ]);
  expect(macos.estimated).toMatchObject({
    borrowedFrom: 'linux',
    borrowedTasks: ['a:test', 'b:test', 'c:test', 'd:test'],
    borrowedRatio: 1,
    unknownTasks: [],
  });
  expect(linux.estimated).toMatchObject({ borrowedFrom: null, borrowedTasks: [] });
  // Recording a borrowing platform never moves another's plan: only Linux lends, and Linux never borrows.
  const withMacos: Schedule = {
    ...durations,
    platforms: { ...durations.platforms, macos: { 'a:test': 1, 'b:test': 1_000 } },
  };
  expect(planShards(manifest(tasks), withMacos, { platform: 'windows', shards: 2, nativeShards: 0 })).toEqual(
    planShards(manifest(tasks), durations, { platform: 'windows', shards: 2, nativeShards: 0 }),
  );
});

it('scales a partial record by the median ratio, and reports only the tasks it borrowed', () => {
  // Windows ratios of 10, 5 and 1000: the median is 10, where a mean would be about 338.
  const recorded: Schedule = {
    version: 1,
    platforms: {
      linux: { 'a:test': 100, 'b:test': 5, 'c:test': 20, 'd:test': 1, 'e:test': 40 },
      windows: { 'b:test': 50, 'c:test': 100, 'd:test': 1_000 },
      macos: {},
    },
  };
  expect(borrowedRatio(recorded, 'windows')).toBe(10);
  expect(estimateFor(recorded, 'windows', 'a:test')).toEqual({ seconds: 1_000, known: true, borrowed: true });
  const tasks = ['a:test', 'b:test', 'c:test', 'd:test', 'e:test'].map((id) => ({
    ...test(id),
    platforms: [...PLATFORMS],
  }));
  const plan = planShards(manifest(tasks), recorded, { platform: 'windows', shards: 2, nativeShards: 0 });
  expect(plan.shards.map((shard) => shard.tasks)).toEqual([
    ['a:test', 'e:test'],
    ['b:test', 'c:test', 'd:test'],
  ]);
  expect(plan.estimated).toMatchObject({
    borrowedFrom: 'linux',
    borrowedTasks: ['a:test', 'e:test'],
    borrowedRatio: 10,
    unknownTasks: [],
  });
});

it('reads one shard count for every platform, or one count per platform', () => {
  expect(platformCounts('8', '--shards')).toEqual({ linux: 8, windows: 8, macos: 8 });
  expect(platformCounts('linux=8,windows=8,macos=2', '--shards')).toEqual({ linux: 8, windows: 8, macos: 2 });
  for (const value of [
    '',
    'linux=8,windows=8',
    'linux=8,windows=8,macos=2,macos=3',
    'linux=8,windows=8,solaris=2',
    'linux=8,windows=8,macos=',
    'linux=8,windows=8,macos=-1',
  ])
    expect(() => platformCounts(value, '--shards')).toThrow('--shards expects N or linux=N,windows=N,macos=N');
});

it('plans each platform with its own shard counts', () => {
  const tasks = [test('a:test'), test('b:test'), test('c:test'), test('heavy:test', 'native-heavy')].map((task) => ({
    ...task,
    platforms: [...PLATFORMS],
  }));
  const matrices = ciMatrices(manifest(tasks), emptySchedule(), {
    shards: { linux: 3, windows: 3, macos: 2 },
    nativeShards: { linux: 1, windows: 1, macos: 1 },
  });
  const shards = (platform: string) =>
    matrices.tests.include
      .filter((row) => row.platform === platform)
      .map((row) => `${row.shard} ${row.class} ${row.tasks}`);
  expect(shards('linux')).toEqual(['1 native-heavy c:test heavy:test', '2 general a:test', '3 general b:test']);
  expect(shards('macos')).toEqual(['1 native-heavy b:test heavy:test', '2 general a:test c:test']);
  // A single count still applies to every platform.
  expect(
    ciMatrices(manifest(tasks), emptySchedule(), { shards: 2, nativeShards: 1 }).tests.include.map(
      (row) => row.platform,
    ),
  ).toEqual(PLATFORMS.flatMap((platform) => [platform, platform]));
});

it('keeps a schedule section for every platform', () => {
  expect(Object.keys(emptySchedule().platforms)).toEqual([...PLATFORMS]);
});

it('changes placement but never task identity when estimates change', () => {
  const tasks = [test('a:test'), test('b:test')];
  const first = planShards(manifest(tasks), schedule({ 'a:test': 100, 'b:test': 1 }), {
    platform: 'linux',
    shards: 2,
    nativeShards: 0,
  });
  const second = planShards(manifest(tasks), schedule({ 'a:test': 1, 'b:test': 100 }), {
    platform: 'linux',
    shards: 2,
    nativeShards: 0,
  });
  expect(first.shards[0]!.tasks).toEqual(['a:test']);
  expect(second.shards[0]!.tasks).toEqual(['b:test']);
  expect(first.lanes.tests).toEqual(second.lanes.tests);
});

it('excludes a platform a task does not declare and refuses an impossible shard shape', () => {
  const windowsOnly: TaskRecord = { ...test('windows:test'), platforms: ['windows'] };
  expect(
    planShards(manifest([windowsOnly]), emptySchedule(), { platform: 'linux', shards: 2, nativeShards: 0 }).lanes.tests,
  ).toEqual([]);
  expect(() => planShards(manifest([]), emptySchedule(), { platform: 'linux', shards: 0 })).toThrow(
    /at least one test shard/,
  );
  expect(() => planShards(manifest([]), emptySchedule(), { platform: 'linux', shards: 1, nativeShards: 1 })).toThrow(
    /at least one general shard/,
  );
});

it('records executed durations and excludes restored ones from the schedule', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-schedule-'));
  // Checked before the cases run: a throw in `finally` would replace a failing assertion's error.
  if (!directory.startsWith(resolve(tmpdir(), 'ia-schedule-'))) throw new Error('Unexpected temporary cleanup path');
  try {
    const platform = currentPlatform();
    const report = (durationMs: number) =>
      buildReport(base, {
        ...readVitestResults('.', 'packages/thing', {
          success: true,
          testResults: [
            {
              name: resolve('packages/thing', 'tests/a.test.ts'),
              assertionResults: [{ fullName: 'holds', status: 'passed', duration: 1 }],
            },
          ],
        }),
        passed: true,
        durationMs,
        startedAt: 'x',
        commit: null,
        run: null,
      });
    const evidence = (task: string, outcome: GateEvidence['outcome'], durationMs: number): GateEvidence => ({
      version: 1,
      task,
      platform,
      outcome,
      source: outcome === 'executed' ? 'execution' : 'remote-cache',
      hash: 'abc',
      current: { run: null, commit: null },
      provenanceAvailable: true,
      report: { ...report(durationMs), task },
    });
    writeEvidence(resolve(directory, 'ran/evidence.json'), evidence('ran:test', 'executed', 42_000));
    writeEvidence(resolve(directory, 'hit/evidence.json'), evidence('hit:test', 'restored', 1));
    const updated = updateSchedule(emptySchedule(), directory);
    expect(updated.platforms[platform]!['ran:test']).toBe(42);
    expect(updated.platforms[platform]!['hit:test']).toBeUndefined();
    // Every platform keeps its section, including those the evidence does not mention.
    expect(Object.keys(updated.platforms)).toEqual([...PLATFORMS]);
    const original = readFileSync(resolve(root, 'tools/testing/schedule.json'), 'utf8');
    const output = resolve(directory, 'planning/schedule.json');
    const exported = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'tools/testing/plan.ts', '--record', directory, '--record-out', output],
      { cwd: root, encoding: 'utf8', timeout: SUBPROCESS },
    );
    expect(exported.status, exported.stderr).toBe(0);
    const recorded = JSON.parse(readFileSync(output, 'utf8')) as Schedule;
    expect(recorded.platforms[platform]!['ran:test']).toBe(42);
    expect(recorded.platforms[platform]!['hit:test']).toBeUndefined();
    expect(readFileSync(resolve(root, 'tools/testing/schedule.json'), 'utf8')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('reads gate rows and needs through comments, quotes, either key order and CRLF', () => {
  const text = [
    'jobs:',
    '  plan:   # the planner',
    '    runs-on: ubuntu-latest',
    '  qualify:   # the gate',
    "    name: 'Gate #1 (${{ matrix.os }})'",
    "    needs: [plan, 'smoke']",
    '    strategy:',
    '      matrix:',
    '        include:',
    '          # hosted runners',
    '          - os: ubuntu-latest   # the Linux row',
    '            platform: linux',
    '          - platform: "windows"',
    "            os: 'windows-latest'",
    '  smoke:',
    '    runs-on: macos-latest',
  ].join('\r\n');
  expect(qualifyRows(text)).toEqual([
    { os: 'ubuntu-latest', platform: 'linux' },
    { os: 'windows-latest', platform: 'windows' },
  ]);
  expect(qualifyNeeds(text)).toEqual(['plan', 'smoke']);
  expect([...workflowJobs(text).keys()]).toEqual(['plan', 'qualify', 'smoke']);
  expect(workflowJobs(text).get('qualify')).toContain("name: 'Gate #1 (${{ matrix.os }})'");
  expect(qualifyNeeds(text.replace("needs: [plan, 'smoke']", 'needs:\r\n      - plan\r\n      - smoke'))).toEqual([
    'plan',
    'smoke',
  ]);
  expect(qualifyRows('jobs:\n  build:\n    runs-on: ubuntu-latest\n')).toEqual([]);
});

it('gates every planned platform on its runner, from the plan rather than rows written by hand', () => {
  // A planned platform without a gate row runs and is never compared; a row without a planned platform waits for
  // evidence nothing produces. The gate's rows therefore come from the same selection as the lanes.
  expect(qualifyRows(workflow())).toEqual([]);
  expect(workflowJobs(workflow()).get(GATE_JOB)).toContain('matrix: ${{ fromJSON(needs.plan.outputs.gate) }}');
  expect(workflowJobs(workflow()).get('plan')).toContain('gate: ${{ steps.matrices.outputs.gate }}');
  expect(gateMatrix(PLATFORMS).include.map((row) => `${row.platform} ${row.os}`)).toEqual(
    PLATFORMS.map((platform) => `${platform} ${RUNNERS[platform]}`),
  );
  expect(gateMatrix(['linux']).include).toEqual([{ os: RUNNERS.linux, platform: 'linux' }]);
});

it('runs the Homebrew smoke on the pinned macOS label the lanes and the gate use, so a bump moves every macOS job', () => {
  // The macOS label names a versioned arm64 image and is bumped deliberately, never followed through macos-latest (#323).
  // The lanes and the gate row take it from RUNNERS; the smoke job spells it itself, in its runner and its check name.
  expect(RUNNERS.macos).toMatch(/^macos-\d+$/);
  const smoke = workflowJobs(workflow()).get('homebrew-node');
  expect(smoke).toMatch(new RegExp(`^runs-on: ${RUNNERS.macos}$`, 'm'));
  expect(smoke).toMatch(new RegExp(`^name: Homebrew Node smoke \\(${RUNNERS.macos}\\)$`, 'm'));
});

it('plans every platform for main pull requests and all other CI events', () => {
  const source = workflow().replace(/\r\n/g, '\n');
  expect(source).toMatch(
    /^  pull_request:\n    branches: \[main\]\n    types: \[opened, synchronize, reopened, edited\]$/m,
  );
  expect(source).toMatch(/^permissions:\n  contents: read$/m);
  expect(source).not.toMatch(/pull_request_target:|secrets\.|permissions:\s*write-all|^\s+[\w-]+: write$/m);
  expect(PULL_REQUEST_PLATFORMS).toEqual(PLATFORMS);
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch', 'merge_group', undefined]) {
    expect(eventPlatforms(event)).toEqual(PLATFORMS);
    expect(gateMatrix(eventPlatforms(event)).include).toEqual(
      PLATFORMS.map((platform) => ({ os: RUNNERS[platform], platform })),
    );
  }
});

it('narrows every lane to the selected platforms without moving any of their tasks', () => {
  const tasks = [
    test('a:test'),
    test('b:test'),
    test('heavy:test', 'native-heavy'),
    command('thing:build'),
    command('thing:typecheck'),
    command('service:qualify', 'emitted'),
  ].map((task) => ({ ...task, platforms: [...PLATFORMS] }));
  const options = { shards: { linux: 3, windows: 3, macos: 2 }, nativeShards: { linux: 1, windows: 1, macos: 1 } };
  const all = ciMatrices(manifest(tasks), emptySchedule(), options),
    linux = ciMatrices(manifest(tasks), emptySchedule(), { ...options, platforms: ['linux'] });
  for (const lane of ['tests', 'build', 'static', 'emitted'] as const) {
    expect(linux[lane].include.length).toBeGreaterThan(0);
    expect(linux[lane].include).toEqual(all[lane].include.filter((row) => row.platform === 'linux'));
  }
  // Selection order never matters: rows follow PLATFORMS.
  expect(
    ciMatrices(manifest(tasks), emptySchedule(), { ...options, platforms: ['macos', 'linux'] }).build.include.map(
      (row) => row.platform,
    ),
  ).toEqual(['linux', 'macos']);
  expect(selectedPlatforms(['windows', 'linux'])).toEqual(['linux', 'windows']);
  expect(() => selectedPlatforms([])).toThrow(/distinct platforms/);
  expect(() => selectedPlatforms(['linux', 'linux'])).toThrow(/distinct platforms/);
  expect(() => selectedPlatforms(['linux', 'solaris'])).toThrow(/Unknown platform solaris/);
});

it('skips a scheduled run only when main is the commit the last successful scheduled run verified', () => {
  expect(runNeeded('schedule', 'abc', 'abc')).toBe(false);
  expect(runNeeded('schedule', 'abc', 'def')).toBe(true);
  // No earlier successful scheduled run, or a lookup that failed, verifies anyway.
  expect(runNeeded('schedule', 'abc', '')).toBe(true);
  expect(runNeeded('schedule', 'abc', undefined)).toBe(true);
  expect(runNeeded('schedule', '', '')).toBe(true);
  expect(runNeeded('schedule', undefined, undefined)).toBe(true);
  // Every other event always runs, a dispatched full run included, whatever commit it names.
  for (const event of ['push', 'pull_request', 'workflow_dispatch', undefined])
    expect(runNeeded(event, 'abc', 'abc')).toBe(true);
});

it('passes the planner the shard counts it accepts, with fewer on macOS than on Linux', () => {
  // Hosted macOS minutes bill at a multiple of Linux's, and macOS is not the workflow's critical path.
  const step = /tests:plan --ci-matrix --shards (\S+) --native-shards (\S+)/.exec(workflow());
  expect(step).not.toBeNull();
  const shards = platformCounts(step![1]!, '--shards'),
    native = platformCounts(step![2]!, '--native-shards');
  for (const platform of PLATFORMS) expect(native[platform]).toBeLessThan(shards[platform]);
  expect(shards.macos).toBeLessThan(shards.linux);
});

it("plans each platform with the workflow's shard counts through the command line", () => {
  // The workflow's own arguments, so a change to the argument handling fails here rather than in the Plan job.
  const step = /tests:plan --ci-matrix --shards (\S+) --native-shards (\S+)/.exec(workflow());
  expect(step).not.toBeNull();
  const [, shards, native] = step as unknown as [string, string, string];
  const plan = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'tools/testing/plan.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: SUBPROCESS,
    });
  const outputs = (run: Parameters<typeof planArgs>[0]) => {
    const result = plan(...planArgs(run));
    expect(result).toMatchObject({ status: 0 });
    const value = (name: string): unknown =>
      JSON.parse(new RegExp(`^${name}=(.*)$`, 'm').exec(result.stdout)?.[1] ?? 'null');
    const perPlatform = (name: string) =>
      Object.fromEntries(
        PLATFORMS.map((platform) => [
          platform,
          (value(name) as { include: readonly { platform: string }[] }).include.filter(
            (row) => row.platform === platform,
          ).length,
        ]),
      );
    return { value, perPlatform };
  };
  const counts = platformCounts(shards, '--shards');
  // Pull requests and non-PR triggers qualify every supported platform with the same shard counts.
  for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) {
    const full = outputs({ event, sha: 'abc', verified: '' });
    expect(full.perPlatform('tests')).toEqual(counts);
    for (const lane of ['build', 'static', 'emitted', 'gate'])
      expect(full.perPlatform(lane)).toEqual({ linux: 1, windows: 1, macos: 1 });
    expect(full.value('platforms')).toEqual(PLATFORMS);
    expect(full.value('run')).toBe(true);
  }
  // A scheduled run on the commit the last successful scheduled run verified has nothing to do; a dispatched run always runs.
  expect(outputs({ event: 'schedule', sha: 'abc', verified: 'abc' }).value('run')).toBe(false);
  expect(outputs({ event: 'schedule', sha: 'abc', verified: 'def' }).value('run')).toBe(true);
  expect(outputs({ event: 'workflow_dispatch', sha: 'abc', verified: 'abc' }).value('run')).toBe(true);
  const macos = plan('--platform', 'macos', '--shards', shards, '--native-shards', native, '--json');
  expect(macos).toMatchObject({ status: 0 });
  expect((JSON.parse(macos.stdout) as { shards: readonly unknown[] }).shards).toHaveLength(counts.macos);
});

it('writes every matrix line before it exits, however slowly the Plan job reads them', async () => {
  // A child's piped stdout is a socket off Windows, which Node writes asynchronously: what the socket cannot take yet is
  // queued in the process, and process.exit() drops it. macOS gives such a socket an 8 KiB buffer, so a planner that
  // exits that way can lose matrix lines whenever its reader falls behind (#323). Here the reader takes nothing until the
  // planner has output queued, behind a socket a preload filled first; Windows writes pipes synchronously, so there
  // nothing is queued and the reader starts when the planner exits.
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-plan-')),
    preload = resolve(directory, 'observe.mjs');
  writeFileSync(
    preload,
    [
      "import { writeSync } from 'node:fs';",
      "const out = process.stdout, write = out.write.bind(out), filler = Buffer.from('#'.repeat(4095) + '\\n');",
      "if (process.platform !== 'win32') for (;;) { try { writeSync(1, filler); } catch (error) { if (error.code === 'EAGAIN') break; throw error; } }",
      "out.write = (...args) => { const written = write(...args); if (out.writableLength > 0) writeSync(2, 'queued\\n'); return written; };",
      "process.on('exit', () => writeSync(2, 'unwritten ' + out.writableLength + '\\n'));",
    ].join('\n'),
  );
  const server = createServer({ pauseOnConnect: true }),
    path = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(directory)}` : resolve(directory, 'out');
  try {
    server.listen(path);
    await once(server, 'listening');
    const accepted = once(server, 'connection') as Promise<[Socket]>,
      client = connect(path);
    await once(client, 'connect');
    const [reader] = await accepted,
      ended = once(reader, 'end');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        pathToFileURL(preload).href,
        'tools/testing/plan.ts',
        ...planArgs({ event: 'push', sha: 'abc', verified: '' }),
      ],
      { cwd: root, stdio: ['ignore', client, 'pipe'], windowsHide: true, timeout: SUBPROCESS },
    );
    client.destroy();
    let stdout = '',
      stderr = '',
      reading = false;
    const read = (): void => {
      if (!reading) {
        reading = true;
        reader
          .setEncoding('utf8')
          .on('data', (chunk: string) => {
            stdout += chunk;
          })
          .resume();
      }
    };
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.includes('queued\n')) read();
    });
    const [code] = (await once(child, 'close')) as [number | null];
    read();
    await ended;
    expect({ code, unwritten: /^unwritten (\d+)$/m.exec(stderr)?.[1] }).toEqual({ code: 0, unwritten: '0' });
    if (process.platform !== 'win32') expect(stderr).toContain('queued\n');
    const lines = stdout
      .replace(/^[#\n]*/, '')
      .split('\n')
      .filter(Boolean);
    expect(lines.map((line) => line.slice(0, line.indexOf('=')))).toEqual([
      'tests',
      'build',
      'static',
      'emitted',
      'gate',
      'platforms',
      'run',
    ]);
    expect(lines.at(-1)).toBe('run=true');
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('skips every job after the plan on an already verified scheduled run, and runs the full run weekly', () => {
  const text = workflow(),
    jobs = workflowJobs(text);
  expect(text).toContain("- cron: '0 3 * * 0'");
  // Only the plan reads earlier runs, so only it holds actions: read.
  expect(jobs.get('plan')).toMatch(/permissions:\ncontents: read\nactions: read\n/);
  expect(text.split(/\r?\n/).filter((line) => /^\s*actions: read\s*$/.test(line))).toHaveLength(1);
  const plan = jobs.get('plan')!;
  expect(plan).toContain("if: github.event_name == 'schedule'");
  expect(plan).toMatch(/actions\/workflows\/platform-quality\.yml\/runs\?event=schedule&status=success&branch=main/);
  expect(plan).toContain('run: ${{ steps.matrices.outputs.run }}');
  expect(plan).toContain('platforms: ${{ steps.matrices.outputs.platforms }}');
  // Each heavy job skips on run=false; the Homebrew smoke also skips when macOS is not planned.
  for (const job of ['build', 'static', 'tests', 'emitted'])
    expect(jobs.get(job)).toContain("if: needs.plan.outputs.run == 'true'");
  expect(jobs.get('homebrew-node')).toContain('needs: plan');
  expect(jobs.get('homebrew-node')).toContain(
    "if: needs.plan.outputs.run == 'true' && contains(fromJSON(needs.plan.outputs.platforms), 'macos')",
  );
  // The gate runs whatever its prerequisites did, unless the plan decided there was nothing to verify; a plan that
  // emitted nothing leaves run empty, so the gate still runs and fails.
  expect(jobs.get(GATE_JOB)).toContain("if: always() && needs.plan.outputs.run != 'false'");
  expect(jobs.get(GATE_JOB)).toContain("!contains(fromJSON(needs.plan.outputs.platforms), 'macos')) && 'not-planned'");
});

it('makes the gate wait for every other job in the workflow and refuse unless each succeeded', () => {
  // A job outside the gate's needs can fail while every Emitted platform check still passes.
  const jobs = workflowJobs(workflow());
  const others = [...jobs.keys()].filter((job) => job !== GATE_JOB).sort();
  expect(others).toEqual(expect.arrayContaining(['plan', 'homebrew-node']));
  expect([...qualifyNeeds(workflow())].sort()).toEqual(others);
  for (const job of others) expect(jobs.get(GATE_JOB)).toContain(`needs.${job}.result`);
});

it('names every platform in the planner and gate usage messages', () => {
  const cli = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', `tools/testing/${script}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: SUBPROCESS,
    });
  const choice = `--platform <${PLATFORMS.join('|')}>`;
  expect(cli('plan.ts', '--unknown')).toMatchObject({ status: 2, stderr: expect.stringContaining(`[${choice}]`) });
  expect(cli('plan.ts', '--platform', 'solaris')).toMatchObject({ status: 1, stderr: expect.stringContaining(choice) });
  expect(cli('report.ts', '--unknown')).toMatchObject({ status: 2, stderr: expect.stringContaining(`[${choice}]`) });
});
