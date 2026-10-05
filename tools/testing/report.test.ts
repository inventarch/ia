import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { TaskRecord } from './inventory.js';
import {
  buildReport,
  currentPlatform,
  expectedTasks,
  gateFindings,
  readEvidence,
  readVitestResults,
  runtimeIdentity,
  writeEvidence,
  type GateEvidence,
} from './report.js';

const platform = currentPlatform();
const task: TaskRecord = {
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
const vitestJson = (status: string, name = 'keeps the contract') => ({
  success: status === 'passed',
  testResults: [
    {
      name: resolve('packages/thing', 'tests/a.test.ts'),
      assertionResults: [{ fullName: name, status, duration: 12.5 }],
    },
  ],
});
const evidenceFor = (
  overrides: Partial<GateEvidence> = {},
  reportOverrides: Partial<GateEvidence['report']> = {},
): GateEvidence => {
  const report = buildReport(task, {
    ...readVitestResults('.', 'packages/thing', vitestJson('passed')),
    passed: true,
    durationMs: 10,
    startedAt: '2026-09-20T00:00:00.000Z',
    commit: 'a'.repeat(40),
    run: '1',
  });
  return {
    version: 1,
    task: task.id,
    platform,
    outcome: 'executed',
    source: 'execution',
    hash: 'deadbeef',
    current: { run: '1', commit: 'a'.repeat(40) },
    provenanceAvailable: true,
    report: { ...report, ...reportOverrides },
    ...overrides,
  };
};
const expected = [{ task: 'thing:test', platform, kind: 'vitest' as const }];

it('converts Vitest results into a versioned report with per-case durations', () => {
  const parsed = readVitestResults('.', 'packages/thing', vitestJson('passed'));
  expect(parsed.cases).toEqual([
    { id: 'tests/a.test.ts > keeps the contract', file: 'tests/a.test.ts', status: 'passed', durationMs: 12.5 },
  ]);
  const report = buildReport(task, {
    ...parsed,
    passed: true,
    durationMs: 1234,
    startedAt: '2026-09-20T00:00:00.000Z',
    commit: null,
    run: null,
  });
  expect(report.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 });
  expect(report.status).toBe('passed');
  expect(report.execution.runtime).toEqual(runtimeIdentity());
  expect(() => readVitestResults('.', 'packages/thing', { testResults: [{ name: 1 }] })).toThrow(/Malformed/);
});

it('marks a report failed when Vitest reports a failed case even if the process succeeded', () => {
  const parsed = readVitestResults('.', 'packages/thing', vitestJson('failed'));
  expect(
    buildReport(task, { ...parsed, passed: true, durationMs: 1, startedAt: 'x', commit: null, run: null }).status,
  ).toBe('failed');
});

it('passes the gate only when the received set matches the expected set exactly', () => {
  expect(gateFindings(expected, [evidenceFor()])).toEqual([]);
  expect(gateFindings(expected, []).join('\n')).toContain('no result reached the gate');
  expect(gateFindings(expected, [evidenceFor(), evidenceFor()]).join('\n')).toContain(
    '2 results claim the same task variant',
  );
  expect(gateFindings([], [evidenceFor()]).join('\n')).toContain('a task the planner did not require');
  expect(gateFindings(expected, [], ['artifacts/x: broken']).join('\n')).toContain('Unreadable evidence');
});

it('refuses a failed, empty or unexpectedly skipped execution as reusable success', () => {
  expect(gateFindings(expected, [evidenceFor({}, { status: 'failed' })]).join('\n')).toContain('reported failed');
  expect(
    gateFindings(expected, [
      evidenceFor({}, { counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }, cases: [] }),
    ]).join('\n'),
  ).toContain('ran no case cannot pass');
  const skipped = readVitestResults('.', 'packages/thing', vitestJson('pending'));
  const report = buildReport(task, {
    ...skipped,
    passed: true,
    durationMs: 1,
    startedAt: 'x',
    commit: null,
    run: null,
  });
  expect(gateFindings(expected, [evidenceFor({}, report)]).join('\n')).toContain(
    'unexpected skip tests/a.test.ts > keeps the contract',
  );
});

it('requires a declared skip to actually be observed', () => {
  const declared = {
    ...task,
    skips: [{ case: 'tests/a.test.ts > windows only', reason: 'POSIX permissions have no Windows equivalent' }],
  };
  const report = buildReport(declared, {
    ...readVitestResults('.', 'packages/thing', vitestJson('passed')),
    passed: true,
    durationMs: 1,
    startedAt: 'x',
    commit: null,
    run: null,
  });
  expect(gateFindings(expected, [evidenceFor({}, report)]).join('\n')).toContain(
    'declared skip tests/a.test.ts > windows only was not observed',
  );
});

it('separates execution from restoration and refuses a mislabelled or unhashed restoration', () => {
  expect(gateFindings(expected, [evidenceFor({ outcome: 'restored', source: 'remote-cache', hash: 'abc' })])).toEqual(
    [],
  );
  expect(
    gateFindings(expected, [evidenceFor({ outcome: 'restored', source: 'remote-cache', hash: null })]).join('\n'),
  ).toContain('restored without a computation hash');
  expect(
    gateFindings(expected, [evidenceFor({ outcome: 'restored', source: 'execution', hash: 'abc' })]).join('\n'),
  ).toContain('restored result labelled as execution');
  expect(gateFindings(expected, [evidenceFor({ outcome: 'executed', source: 'local-cache' })]).join('\n')).toContain(
    'executed result labelled as local-cache',
  );
});

it('keeps a restored report pinned to its original execution, not to this run', () => {
  const restored = evidenceFor({
    outcome: 'restored',
    source: 'remote-cache',
    hash: 'abc',
    current: { run: '7', commit: 'b'.repeat(40) },
  });
  expect(gateFindings(expected, [restored])).toEqual([]);
  expect(restored.report.execution.commit).toBe('a'.repeat(40));
  expect(restored.current.commit).toBe('b'.repeat(40));
});

it('reads evidence from a tree and reports unreadable files instead of ignoring them', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-evidence-'));
  try {
    writeEvidence(resolve(directory, 'thing-test/evidence.json'), evidenceFor());
    mkdirSync(resolve(directory, 'broken'), { recursive: true });
    writeFileSync(resolve(directory, 'broken/evidence.json'), '{ not json');
    const result = readEvidence(directory);
    expect(result.evidence).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  } finally {
    if (!directory.startsWith(resolve(tmpdir(), 'ia-evidence-'))) throw new Error('Unexpected temporary cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('expands the expected set to one entry per declared platform', () => {
  const entries = expectedTasks({ schemaVersion: 1, profiles: {}, inputProfiles: {}, tasks: [task] });
  expect(entries).toEqual([
    { task: 'thing:test', platform: 'linux', kind: 'vitest' },
    { task: 'thing:test', platform: 'windows', kind: 'vitest' },
  ]);
  expect(expectedTasks({ schemaVersion: 1, profiles: {}, inputProfiles: {}, tasks: [task] }, ['linux'])).toHaveLength(
    1,
  );
});

it('maps darwin to macos and refuses a platform whose results may not substitute for another', () => {
  expect(currentPlatform('darwin')).toBe('macos');
  expect(() => currentPlatform('freebsd')).toThrow(/never substitute/);
});

it('permits a declared skip only on the platform whose reason holds', () => {
  const caseId = 'tests/a.test.ts > keeps the contract';
  const declared = {
    ...task,
    skips: [
      {
        case: caseId,
        reason: 'The refusal it asserts only exists on an unqualified platform.',
        platforms: ['windows'] as const,
      },
    ],
  };
  const skipped = buildReport(declared, {
    ...readVitestResults('.', 'packages/thing', vitestJson('pending')),
    passed: true,
    durationMs: 1,
    startedAt: 'x',
    commit: null,
    run: null,
  });
  const ran = buildReport(declared, {
    ...readVitestResults('.', 'packages/thing', vitestJson('passed')),
    passed: true,
    durationMs: 1,
    startedAt: 'x',
    commit: null,
    run: null,
  });
  const on = (value: 'linux' | 'windows', report: typeof skipped) =>
    gateFindings(
      [{ task: 'thing:test', platform: value, kind: 'vitest' }],
      [{ ...evidenceFor({ platform: value }), report: { ...report, platform: value } }],
    );
  // Where the reason holds the skip is expected, and running instead is the finding.
  expect(on('windows', skipped)).toEqual([]);
  expect(on('windows', ran).join('\n')).toContain('is declared skipped on windows but reported passed');
  // Where it does not hold the case must run, and skipping is the finding.
  expect(on('linux', ran)).toEqual([]);
  expect(on('linux', skipped).join('\n')).toContain(`unexpected skip ${caseId}`);
});

it('requires measured capability for a conditional skip and keeps capable runners obligated to pass', () => {
  const caseId = 'tests/a.test.ts > keeps the contract';
  const declared = {
    ...task,
    skips: [
      {
        case: caseId,
        reason: 'Windows may deny file-symlink creation with EPERM.',
        platforms: ['windows'] as const,
        when: 'file-symlink-unavailable' as const,
      },
    ],
  };
  const on = (status: string, capability: boolean | undefined, selected: 'windows' | 'linux' = 'windows') => {
    const report = buildReport(declared, {
      ...readVitestResults('.', 'packages/thing', vitestJson(status)),
      passed: status !== 'failed',
      durationMs: 1,
      startedAt: 'x',
      commit: null,
      run: null,
    });
    const runtime = { ...report.execution.runtime };
    delete runtime.fileSymlinks;
    if (capability !== undefined) runtime.fileSymlinks = capability;
    const recorded = { ...report, platform: selected, execution: { ...report.execution, runtime: runtime } };
    return gateFindings(
      [{ task: task.id, platform: selected, kind: 'vitest' }],
      [{ ...evidenceFor({ platform: selected }), report: recorded }],
    );
  };
  expect(on('passed', true)).toEqual([]);
  expect(on('pending', false)).toEqual([]);
  expect(on('pending', true).join('\n')).toContain('must pass when file symlinks are available');
  expect(on('passed', false).join('\n')).toContain('declared skipped on windows but reported passed');
  for (const status of ['passed', 'pending'])
    expect(on(status, undefined).join('\n')).toContain('requires file-symlink capability evidence');
  expect(on('todo', false).join('\n')).toContain('unexpected skip');
  expect(on('failed', true).join('\n')).toContain('reported failed');
  expect(on('pending', false, 'linux').join('\n')).toContain('unexpected skip');
  const missing = evidenceFor({ platform: 'windows' }, { allowedSkips: declared.skips, platform: 'windows' });
  expect(
    gateFindings(
      [{ task: task.id, platform: 'windows', kind: 'vitest' }],
      [{ ...missing, report: { ...missing.report, cases: [] } }],
    ).join('\n'),
  ).toContain('was not observed');
});
