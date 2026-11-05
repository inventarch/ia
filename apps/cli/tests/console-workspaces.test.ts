/**
 * The all-workspaces state (console/workspaces-state.ts): every tracked workspace loaded through its own copy, at most a
 * few doctor runs at once, each row classified from the statuses its checks report (never from its offers), and the
 * summary's counts. Doctor collection and the copies' runs are injected; the roots are real directories.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Extension } from '../src/consumer.js';
import type { Check, CheckStatus, DoctorView } from '../src/doctor.js';
import type { TrackedWorkspace } from '../src/tracked.js';
import type { DoctorRun } from '../src/console/state.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import { doctorProcess } from '../src/console/load.js';
import { classify, loadAll, loadingRow, summarize } from '../src/console/workspaces-state.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const check = (id: string, status: CheckStatus = 'ok', extra: Partial<Check> = {}): Check => ({
  id,
  section: 'Environment',
  title: id,
  status,
  detail: `${id} detail`,
  remedy: null,
  fix: null,
  ...extra,
});
const json = (row: Check) => ({
  id: row.id,
  title: row.title,
  status: row.status,
  detail: row.detail,
  remedy: row.remedy,
  fix: row.fix,
});
const report = (checks: readonly Check[], status = 0): DoctorRun => ({
  status,
  stdout: JSON.stringify({ version: 1, checks: checks.map(json), counts: {} }),
});
const view = (checks: readonly Check[]): DoctorView => ({
  checks,
  counts: { ok: 0, warn: 0, fail: 0, unknown: 0, info: 0 },
});
const RUNNING = ['install-channel', 'ia-home', 'plugin-claude', 'updates', 'workspace-decision'].map((id) =>
  check(id, 'ok', { detail: `${id} running` }),
);
/** A workspace root, with its own installed copy of `version` when given. */
function workspace(name: string, version?: string): TrackedWorkspace {
  const root = join(scratch(`console-workspaces-${name}`), name);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  if (version !== undefined) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': version } }));
    const installed = join(root, 'node_modules/@inventarch/cli');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version, bin: { ia: './dist/bin.js' } }),
    );
    writeFileSync(join(installed, 'dist/bin.js'), '');
  }
  return { id: name, root, added: '2026-01-01T00:00:00.000Z' };
}
const base = (tracked: readonly TrackedWorkspace[]) => ({
  tracked,
  env: { IA_HOME: join(scratch('console-workspaces-home'), 'home') },
  packageRoot: join(scratch('console-workspaces-running'), 'cli'),
  version: '3.5.1',
  collect: () => view([...RUNNING, check('node'), check('records'), check('cli-version'), check('kits', 'unknown')]),
});
async function load(input: Omit<Parameters<typeof loadAll>[0], 'onRow'>): Promise<RepoRow[]> {
  const rows: RepoRow[] = input.tracked.map(loadingRow);
  await loadAll({ ...input, onRow: (index, row) => (rows[index] = row) });
  return rows;
}
const ready = (checks: readonly { id: string; status: CheckStatus; from?: 'repo' | 'running' }[]): RepoRow => ({
  tracked: { id: 'x', root: '/srv/x', added: '2026-01-01T00:00:00.000Z' },
  state: 'ready',
  console: {
    root: '/srv/x',
    running: { packageRoot: '/srv/cli', version: '3.5.1' },
    repo: null,
    checks: checks.map((row) => ({ ...check(row.id, row.status), from: row.from ?? 'repo', reported: true })),
    areas: [],
    repoFailure: null,
    tracked: true,
    refreshNow: null,
    refreshNowWhy: 'off',
    facts: {
      home: null,
      latest: null,
      manifestDir: null,
      manager: null,
      managerConflict: [],
      generation: false,
      marketplace: false,
    },
  },
  offers: [],
  failure: null,
});

describe('loadAll', () => {
  it('missing rows never load', async () => {
    const present = workspace('present');
    const gone = workspace('gone');
    rmSync(gone.root, { recursive: true, force: true });
    const hollow = workspace('hollow');
    rmSync(join(hollow.root, '.ia'), { recursive: true, force: true });
    const collected: string[] = [];
    const rows = await load({
      ...base([present, gone, hollow]),
      collect: (request) => {
        collected.push(request.cwd);
        return view([check('records')]);
      },
      signal: new AbortController().signal,
    });
    expect(rows.map((row) => row.state)).toEqual(['ready', 'missing', 'missing']);
    expect(collected).toEqual([present.root]);
    expect(rows.map(classify)).toEqual(['healthy', 'missing', 'missing']);
  });
  it('at most limit doctor runs at once', async () => {
    const tracked = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => workspace(name, '3.5.0'));
    let running = 0,
      most = 0,
      runs = 0;
    const rows = await load({
      ...base(tracked),
      limit: 2,
      signal: new AbortController().signal,
      spawnDoctor: async () => {
        runs += 1;
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        running -= 1;
        return report([check('cli-version'), check('records')]);
      },
    });
    expect(runs).toBe(6);
    expect(most).toBe(2);
    expect(rows.every((row) => row.state === 'ready')).toBe(true);
  });
  it('the default limit is 4', async () => {
    const tracked = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => workspace(name, '3.5.0'));
    let running = 0,
      most = 0;
    await load({
      ...base(tracked),
      signal: new AbortController().signal,
      spawnDoctor: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        running -= 1;
        return report([check('cli-version')]);
      },
    });
    expect(most).toBe(4);
  });
  it('exit 1 with a valid report is ready, not failed', async () => {
    const fix = { program: 'ia' as const, argv: ['validate'], flow: 'immediate' as const, writesTo: 'none' as const };
    const [row] = await load({
      ...base([workspace('one', '3.5.0')]),
      signal: new AbortController().signal,
      spawnDoctor: async () =>
        report([check('cli-version'), check('records', 'fail', { fix, remedy: 'ia validate' })], 1),
    });
    expect(row!.state).toBe('ready');
    expect(row!.failure).toBeNull();
    expect(row!.console?.checks.find((entry) => entry.id === 'records')).toMatchObject({ status: 'fail', fix });
    expect(row!.offers.some((offer) => offer.answers.includes('records'))).toBe(true);
    expect(classify(row!)).toBe('failing');
  });
  it('exit 2, another exit, a timeout, a signal and malformed output are failed with their cause', async () => {
    const runs: DoctorRun[] = [
      report([check('cli-version')], 2),
      { status: 7, stdout: '' },
      { status: null, stdout: '', timedOut: true },
      { status: null, stdout: '' },
      { status: 0, stdout: 'not json' },
    ];
    const tracked = runs.map((_, index) => workspace(`f${index}`, '3.5.0'));
    const byRoot = new Map(tracked.map((row, index) => [row.root, runs[index]!]));
    const rows = await load({
      ...base(tracked),
      signal: new AbortController().signal,
      spawnDoctor: async (_entry, root) => byRoot.get(root)!,
    });
    expect(rows.map((row) => row.state)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
    expect(rows.map((row) => row.failure)).toEqual([
      'exit 2',
      'exit 7',
      'timed out after 30 s',
      'ended by a signal',
      'no JSON',
    ]);
    expect(rows.map(classify)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
  });
  it('a copy without cli-version keeps its rows and gains only cli-version', async () => {
    const [row] = await load({
      ...base([workspace('old', '3.3.0')]),
      signal: new AbortController().signal,
      spawnDoctor: async () => report([check('records', 'warn'), check('node')]),
    });
    const repoRows = row!.console!.checks.filter((entry) => entry.from !== 'running').map((entry) => entry.id);
    expect(repoRows.sort()).toEqual(['cli-version', 'node', 'records']);
    expect(row!.console!.checks.find((entry) => entry.id === 'cli-version')?.from).toBe('in-process');
    expect(row!.console!.checks.find((entry) => entry.id === 'kits')).toBeUndefined();
  });
  it('extension rows come from the running copy in every repo row', async () => {
    const acme: Extension = {
      token: 'acme',
      summary: 'Acme',
      run: async () => ({ exitCode: 0, stdout: '' }),
      console: { areas: [{ id: 'account', title: 'Account', checks: ['acme-account'] }], offers: [], state: 'a.json' },
    };
    const silent = workspace('silent', '3.5.0');
    const conflicting = workspace('conflicting', '3.5.0');
    const reports = new Map<string, DoctorRun>([
      [silent.root, report([check('cli-version'), check('marketplace', 'warn', { detail: 'silent marketplace' })])],
      [
        conflicting.root,
        report([
          check('cli-version'),
          check('acme-account', 'fail', { detail: 'repo says' }),
          check('marketplace', 'info', { detail: 'conflicting marketplace' }),
        ]),
      ],
    ]);
    const rows = await load({
      ...base([silent, conflicting]),
      extensions: [acme],
      collect: () =>
        view([...RUNNING, check('acme-account', 'ok', { detail: 'running account' }), check('marketplace', 'ok')]),
      signal: new AbortController().signal,
      spawnDoctor: async (_entry, root) => reports.get(root)!,
    });
    for (const row of rows) {
      const accounts = row.console!.checks.filter((entry) => entry.id === 'acme-account');
      expect(accounts).toEqual([expect.objectContaining({ from: 'running', status: 'ok', detail: 'running account' })]);
    }
    expect(rows[0]!.console!.checks.find((entry) => entry.id === 'marketplace')).toMatchObject({
      from: 'repo',
      detail: 'silent marketplace',
    });
    expect(rows[1]!.console!.checks.find((entry) => entry.id === 'marketplace')).toMatchObject({
      from: 'repo',
      detail: 'conflicting marketplace',
    });
  });
  it('quit aborts pending doctor runs', async () => {
    const tracked = ['a', 'b', 'c', 'd'].map((name) => workspace(name, '3.5.0'));
    const quit = new AbortController();
    const signals: AbortSignal[] = [];
    const settled: number[] = [];
    let started = 0;
    const done = loadAll({
      ...base(tracked),
      limit: 2,
      signal: quit.signal,
      onRow: (index) => settled.push(index),
      spawnDoctor: (_entry, _root, signal) =>
        new Promise((resolve) => {
          started += 1;
          signals.push(signal!);
          signal!.addEventListener('abort', () => resolve({ status: null, stdout: '' }));
        }),
    });
    for (let tries = 0; started < 2 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(2);
    quit.abort();
    await done;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // The queued runs never start, and nothing is reported after the quit.
    expect(started).toBe(2);
    expect(settled).toEqual([]);
  });
});

describe('classify', () => {
  it('an advice-only failure (node, no fix) is failing, not healthy', () => {
    const row = ready([
      { id: 'node', status: 'fail' },
      { id: 'records', status: 'ok' },
    ]);
    expect(row.offers).toEqual([]);
    expect(classify(row)).toBe('failing');
  });
  it('a warn with no offer is warning', () => {
    expect(
      classify(
        ready([
          { id: 'support-target', status: 'warn' },
          { id: 'kits', status: 'unknown' },
        ]),
      ),
    ).toBe('warning');
  });
  it('unknown-only is unchecked', () => {
    expect(
      classify(
        ready([
          { id: 'kits', status: 'unknown' },
          { id: 'records', status: 'ok' },
        ]),
      ),
    ).toBe('unchecked');
  });
  it('ok and info only is healthy', () => {
    expect(
      classify(
        ready([
          { id: 'records', status: 'ok' },
          { id: 'kits', status: 'info' },
        ]),
      ),
    ).toBe('healthy');
  });
  it('unreported rows do not count', () => {
    const row = ready([{ id: 'records', status: 'ok' }]);
    const unreported = {
      ...row,
      console: {
        ...row.console!,
        checks: [
          ...row.console!.checks,
          { ...check('acme-account', 'unknown'), from: 'running' as const, reported: false },
        ],
      },
    };
    expect(classify(unreported)).toBe('healthy');
  });
  it("the running copy's user-state rows are the same for every repo and do not classify it", () => {
    expect(
      classify(
        ready([
          { id: 'records', status: 'ok' },
          { id: 'updates', status: 'warn', from: 'running' },
        ]),
      ),
    ).toBe('healthy');
  });
  it('loading, missing and failed rows are their own classes', () => {
    const tracked = { id: 'x', root: '/srv/x', added: '2026-01-01T00:00:00.000Z' };
    expect(classify(loadingRow(tracked))).toBe('loading');
    expect(classify({ ...loadingRow(tracked), state: 'missing' })).toBe('missing');
    expect(classify({ ...ready([{ id: 'records', status: 'unknown' }]), state: 'failed', failure: 'exit 3' })).toBe(
      'failed',
    );
  });
});

describe('summarize', () => {
  it('summary counts, and tracked equals the sum of the classes', () => {
    const tracked = { id: 'x', root: '/srv/x', added: '2026-01-01T00:00:00.000Z' };
    const rows: RepoRow[] = [
      loadingRow(tracked),
      { ...loadingRow(tracked), state: 'missing' },
      { ...ready([{ id: 'records', status: 'unknown' }]), state: 'failed', failure: 'exit 3' },
      ready([{ id: 'node', status: 'fail' }]),
      ready([{ id: 'records', status: 'warn' }]),
      ready([{ id: 'kits', status: 'unknown' }]),
      ready([{ id: 'records', status: 'ok' }]),
      ready([{ id: 'records', status: 'ok' }]),
    ];
    const summary = summarize(rows, { latest: '3.5.2' }, '3.5.1');
    expect(summary).toEqual({
      latest: '3.5.2',
      global: '3.5.1',
      behind: true,
      tracked: 8,
      healthy: 2,
      attention: 2,
      failing: 1,
      warning: 1,
      missing: 1,
      failed: 1,
      unchecked: 1,
      loading: 1,
    });
    const { tracked: total, healthy, failing, warning, missing, failed, unchecked, loading } = summary;
    expect(total).toBe(healthy + failing + warning + missing + failed + unchecked + loading);
    expect(summarize([], { latest: null }, '3.5.1')).toMatchObject({ latest: null, behind: false, tracked: 0 });
    expect(summarize([], { latest: '3.5.1' }, '3.5.1').behind).toBe(false);
  });
});

describe("the bound on a workspace copy's doctor", () => {
  /** A doctor that treats SIGTERM as the consumer route does, as no reason to end, and would run on for `ms`. */
  const stubborn = (ms: number) => {
    const dir = scratch('console-doctor-bound');
    const entry = join(dir, 'doctor.mjs');
    const pidFile = join(dir, 'pid');
    writeFileSync(
      entry,
      [
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `setTimeout(() => process.exit(0), ${ms});`,
        '',
      ].join('\n'),
    );
    return { dir, entry, pidFile };
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidOf = async (file: string): Promise<number> => {
    for (let tries = 0; tries < 400; tries += 1) {
      if (existsSync(file) && readFileSync(file, 'utf8') !== '') return Number(readFileSync(file, 'utf8'));
      await new Promise((settle) => setTimeout(settle, 10));
    }
    throw new Error('the doctor never started');
  };
  it('a doctor that outlasts its SIGTERM is killed and reported as timed out, well before its own end', async () => {
    const { dir, entry, pidFile } = stubborn(60_000);
    const started = Date.now();
    const run = await doctorProcess({ ...process.env }, 1_000)(entry, dir);
    expect(run).toMatchObject({ status: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(alive(await pidOf(pidFile))).toBe(false);
  });
  it('a doctor that ends cleanly after its timeout still reads as timed out, not as no JSON', async () => {
    const { dir, entry } = stubborn(1_500);
    const run = await doctorProcess({ ...process.env }, 500)(entry, dir);
    expect(run).toMatchObject({ status: null, timedOut: true });
  });
  it.skipIf(process.platform === 'win32')(
    'an abort settles only once the doctor has ended, so its slot stays held',
    async () => {
      const { dir, entry, pidFile } = stubborn(60_000);
      const controller = new AbortController();
      const running = doctorProcess({ ...process.env }, 30_000)(entry, dir, controller.signal);
      const pid = await pidOf(pidFile);
      controller.abort();
      await running;
      expect(alive(pid)).toBe(false);
    },
  );
  it('a doctor that answers in time answers as before', async () => {
    const dir = scratch('console-doctor-answer');
    const entry = join(dir, 'doctor.mjs');
    writeFileSync(entry, "process.stdout.write('{}'); process.exitCode = 1;\n");
    expect(await doctorProcess({ ...process.env }, 20_000)(entry, dir)).toEqual({ status: 1, stdout: '{}' });
  });
});
