/**
 * The console's state (console/state.ts, console/load.ts): which copy each doctor row comes from (six
 * user-state rows and every extension row from the running copy, every other row from the workspace's own copy), what
 * a repo copy's `doctor --json` run counts as a report, and how rows group into areas. Doctor collection is effectful,
 * so the tests inject fixed views and runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Extension } from '../src/consumer.js';
import type { Check, CheckStatus, DoctorView } from '../src/doctor.js';
import type { ExtensionConsole } from '../src/doctor-extensions.js';
import type { LocalCli } from '../src/local-cli.js';
import { loadState } from '../src/console/load.js';
import type { AreaRow, ConsoleCheck } from '../src/console/state.js';
import {
  AREA_TABLE,
  areaOf,
  areasOf,
  assembleRows,
  DEFAULT_AREA,
  RUNNING_ROWS,
  readDoctorReport,
  runningOwner,
} from '../src/console/state.js';
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
const SIX = ['install-channel', 'ia-home', 'plugin-claude', 'updates', 'updates-account', 'workspace-decision'];
const copy: LocalCli = { packageRoot: '/srv/ws/node_modules/@inventarch/cli', version: '3.4.0', entry: '/srv/ws/e.js' };
const report = (checks: readonly unknown[], status = 0) => ({
  status,
  stdout: JSON.stringify({ version: 1, checks, counts: {} }),
});
const json = (row: Check) => ({
  id: row.id,
  title: row.title,
  status: row.status,
  detail: row.detail,
  remedy: row.remedy,
  fix: row.fix,
});
const byId = (rows: readonly ConsoleCheck[]) => Object.fromEntries(rows.map((row) => [row.id, row]));
const ACCOUNT: ExtensionConsole = {
  areas: [{ id: 'account', title: 'Account', checks: ['acme-account', 'acme-mcp'] }],
  offers: [],
  state: 'acme/state.json',
};
const acme: Extension = {
  token: 'acme',
  summary: 'Acme',
  run: async () => ({ exitCode: 0, stdout: '' }),
  console: ACCOUNT,
};

describe('readDoctorReport', () => {
  const failing = check('records', 'fail', {
    remedy: 'ia validate',
    fix: { program: 'ia', argv: ['validate'], flow: 'immediate', writesTo: 'none' },
  });
  it('exit 0 with valid JSON is a report', () => {
    expect(readDoctorReport(report([json(check('node'))]))).toEqual({ ok: true, checks: [check('node')] });
  });
  it('exit 1 with valid JSON and a failing check is a report, its checks and fixes kept', () => {
    const read = readDoctorReport(report([json(failing)], 1));
    expect(read).toEqual({ ok: true, checks: [failing] });
  });
  it('exit 2 is a failed copy (usage)', () => {
    expect(readDoctorReport(report([json(check('node'))], 2))).toEqual({ ok: false, why: 'exit 2' });
  });
  it('exit 3 is a failed copy', () => {
    expect(readDoctorReport({ status: 3, stdout: '' })).toEqual({ ok: false, why: 'exit 3' });
  });
  it('a crash: exit 1 with non-JSON stdout is a failed copy', () => {
    expect(readDoctorReport({ status: 1, stdout: 'TypeError: boom\n' })).toEqual({ ok: false, why: 'no JSON' });
  });
  it('a timeout (status null, timedOut) is a failed copy', () => {
    expect(readDoctorReport({ status: null, stdout: '', timedOut: true })).toEqual({
      ok: false,
      why: 'timed out after 20 s',
    });
  });
  it('a signal (status null) is a failed copy', () => {
    expect(readDoctorReport({ status: null, stdout: '' })).toEqual({ ok: false, why: 'ended by a signal' });
  });
  it('empty stdout, malformed JSON, version 2, a missing checks array and a check without id are failed copies', () => {
    expect(readDoctorReport({ status: 0, stdout: '' })).toEqual({ ok: false, why: 'no JSON' });
    expect(readDoctorReport({ status: 0, stdout: '{"version":1,' })).toEqual({ ok: false, why: 'no JSON' });
    const shapes = [
      { version: 2, checks: [] },
      { version: 1 },
      { version: 1, checks: [{ status: 'ok', detail: 'x' }] },
      { version: 1, checks: [{ id: 'node', status: 'great', detail: 'x' }] },
      [],
    ];
    for (const shape of shapes)
      expect(readDoctorReport({ status: 0, stdout: JSON.stringify(shape) })).toEqual({
        ok: false,
        why: 'unrecognised output',
      });
  });
});

describe('assembleRows', () => {
  const running = SIX.map((id) => check(id, 'ok', { detail: `${id} running` }));
  const inProcess = ['cli-version', 'node', 'records', 'kits', 'marketplace'].map((id) =>
    check(id, 'ok', { detail: `${id} in-process` }),
  );
  const noCliVersion = (): Check => {
    throw new Error('not expected');
  };
  it('RUNNING_ROWS has exactly the six user-state ids', () => {
    expect([...RUNNING_ROWS].sort()).toEqual([...SIX].sort());
  });
  it('the six user-state rows come from the running copy, every other row from the repo copy', () => {
    const repo = readDoctorReport(
      report([
        json(check('cli-version', 'warn', { detail: 'repo says' })),
        json(check('records', 'ok', { detail: 'repo records' })),
        json(check('marketplace', 'info', { detail: 'repo marketplace' })),
        json(check('kits', 'ok', { detail: 'repo kits' })),
        json(check('install-channel', 'fail', { detail: 'repo channel' })),
        json(check('units', 'warn', { detail: 'a row no console knows' })),
      ]),
    );
    const { checks, repoFailure } = assembleRows({
      running,
      inProcess,
      repo,
      repoCopy: copy,
      cliVersion: noCliVersion,
    });
    const rows = byId(checks);
    expect(repoFailure).toBeNull();
    for (const id of SIX) expect(rows[id]).toMatchObject({ from: 'running', detail: `${id} running` });
    expect(rows['install-channel']?.status).toBe('ok');
    expect(rows['records']).toMatchObject({ from: 'repo', detail: 'repo records' });
    expect(rows['units']).toMatchObject({ from: 'repo', status: 'warn' });
    expect(rows['node']).toBeUndefined();
  });
  it('marketplace comes from the repo copy', () => {
    const repo = readDoctorReport(report([json(check('cli-version')), json(check('marketplace', 'warn'))]));
    const rows = byId(assembleRows({ running, inProcess, repo, repoCopy: copy, cliVersion: noCliVersion }).checks);
    expect(rows['marketplace']).toMatchObject({ from: 'repo', status: 'warn' });
  });
  it('extension-declared rows come from the running copy even when a repo copy reports an id of the same name', () => {
    const repo = readDoctorReport(
      report([json(check('cli-version')), json(check('acme-account', 'fail', { detail: 'repo' }))]),
    );
    const rows = byId(
      assembleRows({
        running: [...running, check('acme-account', 'warn', { detail: 'running' })],
        inProcess,
        repo,
        repoCopy: copy,
        cliVersion: noCliVersion,
        owned: runningOwner([acme]),
      }).checks,
    );
    expect(rows['acme-account']).toMatchObject({ from: 'running', status: 'warn', detail: 'running' });
    // A declared id the running copy did not report is still never taken from the repo copy.
    const silent = assembleRows({
      running,
      inProcess,
      repo: readDoctorReport(report([json(check('cli-version')), json(check('acme-mcp', 'fail'))])),
      repoCopy: copy,
      cliVersion: noCliVersion,
      owned: runningOwner([acme]),
    });
    expect(byId(silent.checks)['acme-mcp']).toBeUndefined();
  });
  it('an older repo copy without cli-version keeps its rows, gets only cli-version computed with that copy as packageRoot, and its unreported rows stay unreported', () => {
    const seen: LocalCli[] = [];
    const repo = readDoctorReport(report([json(check('records', 'warn')), json(check('node'))]));
    const { checks } = assembleRows({
      running,
      inProcess,
      repo,
      repoCopy: copy,
      cliVersion: (from) => {
        seen.push(from);
        return check('cli-version', 'ok', { detail: `copy at ${from.packageRoot}` });
      },
    });
    expect(seen).toEqual([copy]);
    expect(checks.map((row) => row.id).sort()).toEqual([...SIX, 'cli-version', 'node', 'records'].sort());
    expect(checks.map((row) => row.id)).not.toContain('kits');
    expect(byId(checks)['cli-version']).toMatchObject({ from: 'in-process', detail: `copy at ${copy.packageRoot}` });
    expect(byId(checks)['records']).toMatchObject({ from: 'repo', status: 'warn' });
  });
  it('a failed repo doctor marks repo rows unknown with its cause and does not fall back to in-process rows', () => {
    const { checks, repoFailure } = assembleRows({
      running,
      inProcess,
      repo: { ok: false, why: 'exit 3' },
      repoCopy: copy,
      cliVersion: noCliVersion,
    });
    expect(repoFailure).toBe('exit 3');
    for (const id of ['cli-version', 'node', 'records', 'kits', 'marketplace'])
      expect(byId(checks)[id]).toMatchObject({ status: 'unknown', detail: 'doctor failed: exit 3', from: 'repo' });
    expect(checks.some((row) => row.detail.includes('in-process'))).toBe(false);
  });
  it('no local copy computes every row in-process', () => {
    const { checks, repoFailure } = assembleRows({
      running,
      inProcess,
      repo: null,
      repoCopy: null,
      cliVersion: noCliVersion,
    });
    expect(repoFailure).toBeNull();
    for (const id of ['cli-version', 'node', 'records', 'kits', 'marketplace'])
      expect(byId(checks)[id]).toMatchObject({ from: 'in-process', detail: `${id} in-process` });
    for (const id of SIX) expect(byId(checks)[id]?.from).toBe('running');
  });
});

describe('areas', () => {
  const rows = (entries: readonly [string, CheckStatus, ConsoleCheck['from']?][]): ConsoleCheck[] =>
    entries.map(([id, status, from = 'repo']) => ({ ...check(id, status), from, reported: true }));
  const area = (areas: ReturnType<typeof areasOf>, id: string) => areas.find((entry) => entry.id === id);
  it('the core areas are in design order, then Other, then extension areas', () => {
    const areas = areasOf(
      rows([
        ['marketplace', 'ok'],
        ['node', 'ok'],
        ['units', 'warn'],
        ['records', 'ok'],
        ['acme-account', 'ok', 'running'],
      ]),
      new Set(),
      [ACCOUNT],
    );
    expect(areas.map((entry) => entry.id)).toEqual([
      'cli',
      'records',
      'kits',
      'updates',
      'lock',
      'host',
      'plugin',
      'marketplace',
      'other',
      'account',
    ]);
    expect(areas.map((entry) => entry.title)).toEqual([
      'CLI',
      'Records',
      'Kits',
      'Updates',
      'Lock',
      'Host',
      'Plugin',
      'Marketplace',
      'Other',
      'Account',
    ]);
  });
  it('an older repo copy that predates marketplace leaves the Marketplace area showing —', () => {
    const areas = areasOf(
      rows([
        ['cli-version', 'ok'],
        ['records', 'ok'],
        ['install-channel', 'ok', 'running'],
      ]),
      new Set(),
    );
    expect(area(areas, 'marketplace')).toMatchObject({ status: 'absent', checks: [] });
    expect(area(areas, 'records')?.status).toBe('ok');
  });
  it('an unreported row shows — and does not count', () => {
    const areas = areasOf(rows([['acme-account', 'ok', 'running']]), new Set(), [ACCOUNT]);
    const account = area(areas, 'account')!;
    expect(account.status).toBe('ok');
    expect(account.checks.map((row) => [row.id, row.reported])).toEqual([
      ['acme-account', true],
      ['acme-mcp', false],
    ]);
    // With nothing reported at all, the area is there and shows —.
    expect(area(areasOf([], new Set(), [ACCOUNT]), 'account')).toMatchObject({ status: 'absent' });
  });
  it('worst status wins and info with an offer is setup', () => {
    const areas = areasOf(
      rows([
        ['records', 'ok'],
        ['root', 'warn'],
        ['kits', 'info'],
        ['host', 'info'],
        ['generation', 'info'],
        ['node', 'unknown'],
        ['vocabulary', 'fail'],
      ]),
      new Set(['kits', 'host']),
    );
    expect(area(areas, 'records')).toMatchObject({ status: 'warn', summary: 'root detail' });
    expect(area(areas, 'kits')?.status).toBe('setup');
    expect(area(areas, 'host')?.status).toBe('setup');
    expect(area(areas, 'lock')?.status).toBe('ok');
    expect(area(areas, 'cli')).toMatchObject({ status: 'fail', summary: 'vocabulary detail' });
  });
  it('an absent provider leaves no area', () => {
    // No repo copy reported and nothing in-process for these areas (outside a workspace): no Kits, Lock or Host cell,
    // and no Account cell without an extension that declares it.
    const areas = areasOf(
      rows([
        ['install-channel', 'ok', 'running'],
        ['updates', 'unknown', 'running'],
      ]),
      new Set(),
    );
    expect(areas.map((entry) => entry.id)).toEqual(['cli', 'updates']);
  });
  it('an extension area maps its declared checks', () => {
    expect(areaOf('acme-account', [ACCOUNT])).toBe('account');
    expect(areaOf('acme-account')).toBe(DEFAULT_AREA);
    expect(area(areasOf(rows([['acme-account', 'warn', 'running']]), new Set(), [ACCOUNT]), 'account')?.status).toBe(
      'warn',
    );
  });
  it('an unknown id lands in the default area without throwing', () => {
    for (const id of ['units', 'prepared', 'activation', 'pin-locks', 'version-line:3.x'])
      expect(areaOf(id)).toBe('other');
    const areas = areasOf(
      rows([
        ['units', 'warn'],
        ['node', 'ok'],
      ]),
      new Set(),
    );
    expect(area(areas, 'other')).toMatchObject({ title: 'Other', status: 'warn' });
    expect(area(areasOf(rows([['node', 'ok']]), new Set()), 'other')).toBeUndefined();
  });
  it('workspace-decision maps to no area, which is not the default', () => {
    expect(areaOf('workspace-decision')).toBeNull();
    const areas = areasOf(
      rows([
        ['workspace-decision', 'warn', 'running'],
        ['node', 'ok'],
      ]),
      new Set(),
    );
    expect(areas.flatMap((entry) => entry.checks.map((row) => row.id))).not.toContain('workspace-decision');
    expect(area(areas, 'other')).toBeUndefined();
  });
  it('the table maps every listed id and prefix', () => {
    const expected: Record<string, string | null> = {
      'cli-version': 'cli',
      'support-target': 'cli',
      'source-docs': 'records',
      'source-protection': 'records',
      joins: 'records',
      'kit-update:acme/kit': 'kits',
      'registry-npm': 'kits',
      compatibility: 'updates',
      cache: 'lock',
      host: 'host',
      'host-payload': 'host',
      'host-plugin': 'other',
      'projection-claude:x': 'host',
      'join-claude': 'host',
      'ia-home': 'plugin',
      'ia-home-moved-claude': 'plugin',
      marketplace: 'marketplace',
    };
    for (const [id, owner] of Object.entries(expected)) expect([id, areaOf(id)]).toEqual([id, owner]);
  });
  it('AREA_TABLE is data', () => {
    const table: readonly AreaRow[] = [...AREA_TABLE, { area: 'units', title: 'Units', ids: ['units'], prefixes: [] }];
    const areas = areasOf(
      rows([
        ['units', 'fail'],
        ['node', 'ok'],
      ]),
      new Set(),
      [],
      table,
    );
    expect(area(areas, 'units')).toMatchObject({ title: 'Units', status: 'fail' });
    expect(area(areas, 'other')).toBeUndefined();
  });
});

describe('loadState', () => {
  const view = (checks: readonly Check[]): DoctorView => ({
    checks,
    counts: { ok: 0, warn: 0, fail: 0, unknown: 0, info: 0 },
  });
  const viewRows = [
    check('node'),
    check('root', 'warn', { detail: 'No .ia/src directory here or in any parent' }),
    check('records', 'unknown'),
    check('generation', 'unknown'),
    check('host', 'unknown'),
    ...SIX.filter((id) => id !== 'updates-account').map((id) => check(id)),
  ];
  it('outside a workspace the view keeps the running-copy areas and the root row', async () => {
    const cwd = scratch('console-state-outside');
    const state = await loadState({
      cwd,
      env: { IA_HOME: join(cwd, 'home') },
      packageRoot: cwd,
      version: '3.5.1',
      collect: () => view(viewRows),
      spawnDoctor: async () => {
        throw new Error('no copy to run');
      },
    });
    expect(state.root).toBeNull();
    expect(state.repo).toBeNull();
    expect(state.checks.map((row) => row.id)).not.toContain('records');
    expect(state.checks.map((row) => row.id)).toContain('root');
    expect(state.areas.map((entry) => entry.id)).toEqual(['cli', 'records', 'updates', 'plugin']);
  });
  it('a workspace whose own copy is another runs that copy once and splits the rows', async () => {
    const root = scratch('console-state-repo');
    mkdirSync(join(root, '.ia/src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.4.0' } }));
    const installed = join(root, 'node_modules/@inventarch/cli');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.4.0', bin: { ia: './dist/bin.js' } }),
    );
    writeFileSync(join(installed, 'dist/bin.js'), '');
    const runs: [string, string][] = [];
    const state = await loadState({
      cwd: root,
      env: { IA_HOME: join(root, 'home') },
      packageRoot: resolve(root, 'elsewhere'),
      version: '3.5.1',
      collect: () => view([...viewRows, check('cli-version'), check('kits')]),
      spawnDoctor: async (entry, at) => {
        runs.push([entry, at]);
        return report([json(check('cli-version', 'warn', { detail: 'repo cli' })), json(check('records', 'ok'))]);
      },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toMatch(/bin\.js$/);
    expect(state.repo?.version).toBe('3.4.0');
    expect(byId(state.checks)['cli-version']).toMatchObject({ from: 'repo', detail: 'repo cli' });
    expect(byId(state.checks)['kits']).toBeUndefined();
    expect(byId(state.checks)['install-channel']?.from).toBe('running');
    expect(state.repoFailure).toBeNull();
  });
});
