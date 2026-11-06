/**
 * The all-workspaces state (console/workspaces-state.ts): every tracked workspace loaded through its own copy, at most a
 * few doctor runs at once, each row classified from the statuses its checks report (never from its offers), and the
 * summary's counts. Doctor collection and the copies' runs are injected; the roots are real directories.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Extension } from '../src/consumer.js';
import type { Check, CheckStatus, DoctorView } from '../src/doctor.js';
import type { TrackedWorkspace } from '../src/tracked.js';
import type { DoctorRun } from '../src/console/state.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import {
  classify,
  loadAll,
  loadingRow,
  NOT_ITSELF,
  ownRoot,
  setAside,
  summarize,
} from '../src/console/workspaces-state.js';
import type { ConsoleState } from '../src/console/state.js';
import { trackedState } from '../src/tracked.js';
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
const unprivileged = process.platform === 'win32' || process.getuid?.() === 0;
/** Runs `check` with `directories` denied to this user, so a stat below each fails with EACCES. */
async function denied<T>(directories: readonly string[], check: () => Promise<T>): Promise<T> {
  for (const directory of directories) chmodSync(directory, 0o000);
  try {
    return await check();
  } finally {
    for (const directory of directories) chmodSync(directory, 0o755);
  }
}
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
  // A root that cannot be read must never load: discovery walks up from it, so it would read as the workspace around
  // it, or as outside any workspace, with that place's offers. A real chmod, not a stub.
  it.skipIf(unprivileged)('unreadable rows never load as another workspace', async () => {
    const parent = workspace('parent');
    const nested = { id: 'nested', root: join(parent.root, 'nested'), added: parent.added };
    mkdirSync(join(nested.root, '.ia/src'), { recursive: true });
    const lone = workspace('lone');
    const collected: string[] = [];
    const rows = await denied([nested.root, lone.root], () =>
      load({
        ...base([nested, lone]),
        collect: (request) => {
          collected.push(request.cwd);
          return view([check('records')]);
        },
        signal: new AbortController().signal,
      }),
    );
    expect(rows.map((row) => row.state)).toEqual(['unreadable', 'unreadable']);
    expect(rows.map((row) => [row.console, row.offers])).toEqual([
      [null, []],
      [null, []],
    ]);
    expect(rows.map(classify)).toEqual(['unreadable', 'unreadable']);
    expect(collected).toEqual([]);
  });
  it.skipIf(unprivileged)('a root that turns unreadable while it loads is not taken for another', async () => {
    const parent = workspace('parent-late');
    const nested = { id: 'nested', root: join(parent.root, 'nested'), added: parent.added };
    mkdirSync(join(nested.root, '.ia/src'), { recursive: true });
    const lone = workspace('lone-late');
    const locked: string[] = [];
    try {
      const rows = await load({
        ...base([nested, lone]),
        // Collected before discovery: denying the root here is the race between the check and the load.
        collect: (request) => {
          chmodSync(request.cwd, 0o000);
          locked.push(request.cwd);
          return view([check('records')]);
        },
        signal: new AbortController().signal,
      });
      expect(locked).toEqual([nested.root, lone.root]);
      expect(rows.map((row) => row.state)).toEqual(['unreadable', 'unreadable']);
      expect(rows.map((row) => [row.console, row.offers])).toEqual([
        [null, []],
        [null, []],
      ]);
    } finally {
      for (const path of locked) chmodSync(path, 0o755);
    }
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
      { ...loadingRow(tracked), state: 'unreadable' },
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
      tracked: 9,
      healthy: 2,
      attention: 2,
      failing: 1,
      warning: 1,
      missing: 1,
      unreadable: 1,
      failed: 1,
      unchecked: 1,
      loading: 1,
    });
    const { tracked: total, healthy, failing, warning, missing, unreadable, failed, unchecked, loading } = summary;
    expect(total).toBe(healthy + failing + warning + missing + unreadable + failed + unchecked + loading);
    expect(summarize([], { latest: null }, '3.5.1')).toMatchObject({ latest: null, behind: false, tracked: 0 });
    expect(summarize([], { latest: '3.5.1' }, '3.5.1').behind).toBe(false);
  });
});

describe('setAside and ownRoot', () => {
  const at = (root: string): TrackedWorkspace => ({ id: 'demo', root, added: '2026-01-01T00:00:00.000Z' });
  it('a root that reads present but did not load as itself is failed, never unreadable', () => {
    const root = join(scratch('set-aside'), 'demo');
    mkdirSync(join(root, '.ia/src'), { recursive: true });
    expect(setAside(at(root))).toMatchObject({ state: 'failed', failure: NOT_ITSELF, console: null, offers: [] });
  });
  it('a gone root, and one under a file (ENOTDIR), are missing', () => {
    const base = scratch('set-aside');
    const file = join(base, 'a-file');
    writeFileSync(file, '');
    for (const root of [join(base, 'gone'), join(file, 'demo')]) {
      expect(trackedState({ root }), root).toBe('missing');
      expect(setAside(at(root))).toMatchObject({ state: 'missing', failure: null, console: null, offers: [] });
    }
  });
  it('takes the state it is given rather than reading the root again', () => {
    const root = join(scratch('set-aside'), 'gone');
    expect(setAside(at(root), 'unreadable').state).toBe('unreadable');
    expect(setAside(at(root), 'missing').state).toBe('missing');
  });
  it('ownRoot is the tracked root itself, whichever way it is spelled, never the workspace around it', () => {
    const base = scratch('own-root');
    const root = join(base, 'demo');
    mkdirSync(join(root, '.ia/src'), { recursive: true });
    const loaded = (at: string | null) => ({ root: at }) as unknown as ConsoleState;
    expect(ownRoot(root, loaded(root))).toBe(true);
    expect(ownRoot(root, loaded(join(root, '.')))).toBe(true);
    expect(ownRoot(root, loaded(base))).toBe(false);
    expect(ownRoot(root, loaded(null))).toBe(false);
  });
  it('a volume that reports no inode never makes two folders one: it falls back to the exact real path', () => {
    const parent = join(scratch('own-ino'), 'parent'),
      child = join(parent, 'child');
    const loaded = (at: string) => ({ root: at }) as unknown as ConsoleState;
    const same = () => ({ dev: 1n, ino: 7n });
    const none = () => ({ dev: 1n, ino: 0n });
    // A stat that answers one identity for both is one root; an inode of 0 or all ones is no identity at all.
    expect(ownRoot(child, loaded(parent), same)).toBe(true);
    expect(ownRoot(child, loaded(parent), none)).toBe(false);
    expect(ownRoot(child, loaded(parent), () => ({ dev: 1n, ino: 2n ** 64n - 1n }))).toBe(false);
    expect(ownRoot(parent, loaded(parent), none)).toBe(true);
  });
});
