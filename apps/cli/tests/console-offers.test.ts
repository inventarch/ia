/**
 * The console's offers (console/offers.ts): one per doctor check with a fix, the explicit set-up offers doctor has no fix
 * for, the recipes and the More entries. The command an offer runs is always a fix's argv or a package-manager argv builder,
 * never text; ids are an open set, so a row this table does not know still gets its offer.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Check, CheckStatus } from '../src/doctor.js';
import type { ExtensionConsole } from '../src/doctor-extensions.js';
import type { Fix } from '../src/fix.js';
import { confirmedArgv, iaFix, previewArgv } from '../src/fix.js';
import type { Offer, Step } from '../src/console/offers.js';
import { batchable, offersFor, runsOn, setupIds } from '../src/console/offers.js';
import type { ConsoleCheck, ConsoleFacts, ConsoleState } from '../src/console/state.js';
import { areasOf } from '../src/console/state.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const ROOT = '/srv/ws';
const row = (
  id: string,
  status: CheckStatus,
  fix: Fix | null = null,
  extra: Partial<ConsoleCheck> = {},
): ConsoleCheck => ({
  id,
  section: 'Environment',
  title: `${id} title`,
  status,
  detail: `${id} detail`,
  remedy: fix === null ? null : 'shown remedy',
  fix,
  from: 'repo',
  reported: true,
  ...extra,
});
const FACTS: ConsoleFacts = {
  home: '/srv/ia-home',
  latest: null,
  manifestDir: ROOT,
  manager: 'npm',
  managerConflict: [],
  generation: false,
  marketplace: false,
};
const state = (checks: readonly ConsoleCheck[], extra: Partial<ConsoleState> = {}): ConsoleState => ({
  root: ROOT,
  running: { packageRoot: '/srv/global/cli', version: '3.5.1' },
  repo: { packageRoot: `${ROOT}/node_modules/@inventarch/cli`, version: '3.5.0', entry: `${ROOT}/e.js` },
  checks,
  areas: areasOf(checks, new Set()),
  repoFailure: null,
  tracked: true,
  refreshNow: ['/node', '/dist/cli.js', 'refresh-updates', '--root', ROOT, '--force'],
  refreshNowWhy: null,
  facts: FACTS,
  ...extra,
});
const find = (offers: readonly Offer[], id: string): Offer | undefined => offers.find((offer) => offer.id === id);
const USER_APPLY = iaFix(['host', 'claude', '--user', '--apply'], 'user').fix!;

describe('offers from fixes', () => {
  it('a warn check with a fix is an attention offer', () => {
    const offers = offersFor(state([row('plugin-claude', 'warn', USER_APPLY, { from: 'running' })]));
    const offer = find(offers, 'fix:plugin-claude')!;
    expect(offer).toMatchObject({
      group: 'attention',
      title: 'Refresh Claude plugin',
      answers: ['plugin-claude'],
      area: 'plugin',
      steps: [USER_APPLY],
      writesTo: ['user'],
      batchable: false,
    });
    expect(offer.explain.startsWith('plugin-claude detail. ')).toBe(true);
    expect(offers[0]).toBe(offer);
  });
  it('info with a fix is setup, ok makes none', () => {
    const init = iaFix(['init'], 'repo').fix!;
    const offers = offersFor(
      state([
        row('generation', 'info', init),
        row('records', 'ok', iaFix(['validate'], 'none').fix),
        row('pending', 'unknown', init),
      ]),
    );
    expect(find(offers, 'fix:generation')?.group).toBe('setup');
    expect(find(offers, 'fix:records')).toBeUndefined();
    expect(find(offers, 'fix:pending')).toBeUndefined();
  });
  it('the title table names known ids, and a fail outranks setup in the list order', () => {
    const validate = iaFix(['validate'], 'none').fix!;
    const offers = offersFor(
      state([
        row('generation', 'info', iaFix(['init'], 'repo').fix),
        row('records', 'fail', validate),
        row('kit-update:acme/kit', 'warn', iaFix(['update', 'acme/kit', '--to', '2.0.0'], 'repo').fix),
        row('install-lock', 'warn', iaFix(['recover'], 'repo', ROOT).fix),
      ]),
    );
    expect(offers.filter((offer) => offer.id.startsWith('fix:')).map((offer) => [offer.title, offer.group])).toEqual([
      ['Fix record errors', 'attention'],
      ['Update kit acme/kit', 'attention'],
      ['Resume interrupted install', 'attention'],
      ['Re-lock', 'setup'],
    ]);
  });
  it('cli-version is Install dependencies when warn and Pin the CLI when info', () => {
    const install: Fix = { program: 'external', argv: ['npm', 'install'], flow: 'confirm', writesTo: 'repo' };
    expect(find(offersFor(state([row('cli-version', 'warn', install)])), 'fix:cli-version')?.title).toBe(
      'Install dependencies',
    );
    const pin: Fix = { ...install, argv: ['npm', 'install', '-D', '@inventarch/cli@3.5.1'] };
    expect(find(offersFor(state([row('cli-version', 'info', pin)])), 'fix:cli-version')).toMatchObject({
      title: 'Pin the CLI in this repo',
      group: 'setup',
      changes: ['this repo (package.json, lockfile)'],
    });
  });
  it('a copy that emits no fix gets its install and pin offers built here with the explicit directory', () => {
    const facts = { ...FACTS, manifestDir: '/srv/mono' };
    const at = `${'/srv/mono'}/ws`;
    const offers = offersFor(state([row('cli-version', 'warn')], { root: at, facts }));
    expect(find(offers, 'fix:cli-version')?.steps).toEqual([
      { program: 'external', argv: ['npm', 'install', '--prefix', '/srv/mono'], flow: 'confirm', writesTo: 'repo' },
    ]);
    const pin = offersFor(state([row('cli-version', 'info')], { root: at, facts, repo: null }));
    expect(find(pin, 'fix:cli-version')?.steps).toEqual([
      {
        program: 'external',
        argv: ['npm', 'install', '-D', '--prefix', '/srv/mono', '@inventarch/cli@3.5.1'],
        flow: 'confirm',
        writesTo: 'repo',
      },
    ]);
  });
  it('the root row offers Initialise a workspace here as a set-up offer', () => {
    const offers = offersFor(
      state([row('root', 'warn', iaFix(['init'], 'repo').fix, { from: 'in-process' })], { root: null, repo: null }),
    );
    expect(find(offers, 'fix:root')).toMatchObject({
      title: 'Initialise a workspace here',
      group: 'setup',
      steps: [{ program: 'ia', argv: ['init'], flow: 'preview-apply', writesTo: 'repo' }],
    });
    expect(find(offers, 'track')).toBeUndefined();
  });
  it('a check with an id the offer-title table does not know, and a fix, is an offer titled by its check', () => {
    const fix: Fix = { program: 'ia', argv: ['prepare'], flow: 'preview-apply', writesTo: 'repo' };
    const offers = offersFor(state([row('prepared', 'warn', fix, { title: 'Prepared generation' })]));
    expect(find(offers, 'fix:prepared')).toMatchObject({
      title: 'Prepared generation',
      area: 'other',
      group: 'attention',
      steps: [fix],
    });
  });
  it('two checks whose fix is the same command make one offer answering both', () => {
    const offers = offersFor(
      state([row('plugin-claude', 'info', USER_APPLY, { from: 'running' }), row('marketplace', 'info', USER_APPLY)]),
    );
    const same = offers.filter((offer) => offer.steps[0] === USER_APPLY || offer.answers.includes('marketplace'));
    expect(same).toHaveLength(1);
    expect(same[0]!.answers).toEqual(['plugin-claude', 'marketplace']);
  });
});

describe('explicit set-up offers', () => {
  it('register a host: two setup offers when the host check is info, none once a host is registered', () => {
    const offers = offersFor(state([row('host', 'info')]));
    expect(find(offers, 'register-host:claude')).toMatchObject({
      group: 'setup',
      answers: ['host'],
      area: 'host',
      steps: [{ program: 'ia', argv: ['host', 'claude'], flow: 'preview-apply', writesTo: 'repo' }],
    });
    expect(find(offers, 'register-host:codex')?.steps).toEqual([
      { program: 'ia', argv: ['host', 'codex'], flow: 'preview-apply', writesTo: 'repo' },
    ]);
    const registered = offersFor(state([row('host-claude', 'ok')]));
    expect(registered.filter((offer) => offer.id.startsWith('register-host:'))).toEqual([]);
  });
  it('add a kit: setup when the kits check is info, More otherwise', () => {
    expect(find(offersFor(state([row('kits', 'info')])), 'add-kit')?.group).toBe('setup');
    expect(find(offersFor(state([row('kits', 'ok')])), 'add-kit')?.group).toBe('more');
  });
  it('its input refuses a leading dash, a space and an empty value; accepts id and id@range; builds ia install <value>', () => {
    const input = find(offersFor(state([row('kits', 'info')])), 'add-kit')!.input!;
    expect(input.accept('--apply')).toMatch(/dash/);
    expect(input.accept('-x')).toMatch(/dash/);
    expect(input.accept('acme/kit extra')).not.toBeNull();
    expect(input.accept('')).not.toBeNull();
    expect(input.accept('kit')).not.toBeNull();
    expect(input.accept('acme/kit')).toBeNull();
    expect(input.accept('acme/kit@^1.2')).toBeNull();
    expect(input.build('acme/kit@^1.2')).toEqual([
      { program: 'ia', argv: ['install', 'acme/kit@^1.2'], flow: 'preview-apply', writesTo: 'repo' },
    ]);
  });
  it('track this workspace appears only when untracked', () => {
    expect(find(offersFor(state([])), 'track')).toBeUndefined();
    expect(find(offersFor(state([], { tracked: false })), 'track')?.group).toBe('setup');
  });
  it('its step is workspaces add <root>, flow confirm, writes user, previewArgv null, and confirmedArgv carries no --apply or --yes', () => {
    const offer = find(offersFor(state([], { tracked: false })), 'track')!;
    expect(offer.steps).toEqual([
      { program: 'ia', argv: ['workspaces', 'add', ROOT], flow: 'confirm', writesTo: 'user' },
    ]);
    expect(previewArgv(offer.steps[0]!)).toBeNull();
    expect(confirmedArgv(offer.steps[0]!)).toEqual(['workspaces', 'add', ROOT]);
    expect(offer.changes).toEqual(['your IA home (tracked-workspaces.json)']);
  });
});

describe('the upgrade recipe', () => {
  const behind = (facts: Partial<ConsoleFacts> = {}, extra: Partial<ConsoleState> = {}) =>
    offersFor(state([row('cli-version', 'ok')], { facts: { ...FACTS, latest: '3.6.0', ...facts }, ...extra }));
  it('has four steps when a generation and a marketplace record exist, two otherwise', () => {
    const full = find(behind({ generation: true, marketplace: true }), 'upgrade')!;
    expect(full.title).toBe('Upgrade CLI to 3.6.0');
    expect(full.group).toBe('attention');
    expect(full.steps).toEqual([
      {
        program: 'external',
        argv: ['npm', 'install', '-D', '@inventarch/cli@3.6.0'],
        flow: 'confirm',
        writesTo: 'repo',
      },
      { program: 'ia', argv: ['restore', '--apply'], flow: 'confirm', writesTo: 'repo', requires: 'repo-copy' },
      { program: 'ia', argv: ['validate'], flow: 'immediate', writesTo: 'none', requires: 'repo-copy' },
      { program: 'ia', argv: ['host', 'claude', '--user', '--apply'], flow: 'preview-apply', writesTo: 'user' },
    ]);
    expect(full.batchable).toBe(true);
    const short = find(behind(), 'upgrade')!;
    expect(short.steps.map((step) => step.argv[0])).toEqual(['npm', 'validate']);
  });
  it('steps 2 and 3 require the repo copy', () => {
    const steps = find(behind({ generation: true }), 'upgrade')!.steps;
    expect(steps.map((step: Step) => step.requires ?? null)).toEqual([null, 'repo-copy', 'repo-copy']);
  });
  it('its pin step carries the explicit directory when the manifest is an ancestor', () => {
    const offers = behind({ manifestDir: '/srv/mono', manager: 'pnpm' }, { root: '/srv/mono/ws' });
    expect(find(offers, 'upgrade')!.steps[0]!.argv).toEqual([
      'pnpm',
      '--dir',
      '/srv/mono',
      'add',
      '-D',
      '@inventarch/cli@3.6.0',
    ]);
  });
  it('yarn classic and yarn 2+ at an ancestor both pin with yarn --cwd <dir> add', () => {
    const classic = scratch('offers-yarn-classic'),
      berry = scratch('offers-yarn-berry');
    writeFileSync(join(classic, 'package.json'), JSON.stringify({ packageManager: 'yarn@1.22.22' }));
    writeFileSync(join(berry, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.5.0' }));
    writeFileSync(join(berry, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    for (const dir of [classic, berry]) {
      mkdirSync(join(dir, 'ws'));
      const offers = behind({ manifestDir: dir, manager: 'yarn' }, { root: join(dir, 'ws') });
      expect(find(offers, 'upgrade')!.steps[0]!.argv).toEqual([
        'yarn',
        '--cwd',
        dir,
        'add',
        '-D',
        '@inventarch/cli@3.6.0',
      ]);
    }
  });
  it('no recipe when the manager is unknown or in conflict, when nothing newer is cached or without a repo copy', () => {
    expect(find(behind({ manager: null }), 'upgrade')).toBeUndefined();
    expect(find(behind({ manager: null, managerConflict: ['npm', 'pnpm'] }), 'upgrade')).toBeUndefined();
    expect(find(behind({ latest: '3.5.0' }), 'upgrade')).toBeUndefined();
    expect(find(behind({}, { repo: null }), 'upgrade')).toBeUndefined();
    expect(find(behind({ manifestDir: null }), 'upgrade')).toBeUndefined();
  });
  it("an older repo copy's rows have no own offer but the upgrade recipe still answers them", () => {
    const offers = offersFor(
      state([row('cli-version', 'warn', null, { detail: 'old' }), row('records', 'fail'), row('kits', 'warn')], {
        facts: { ...FACTS, latest: '3.6.0', manager: null },
      }),
    );
    expect(offers.filter((offer) => offer.id.startsWith('fix:'))).toEqual([]);
    const withManager = offersFor(
      state([row('cli-version', 'ok'), row('records', 'fail'), row('kits', 'warn')], {
        facts: { ...FACTS, latest: '3.6.0' },
      }),
    );
    expect(find(withManager, 'upgrade')?.answers).toEqual(['cli-version', 'updates']);
    expect(withManager.filter((offer) => offer.id.startsWith('fix:'))).toEqual([]);
  });
});

describe('set-up ids', () => {
  it('an info row a set-up offer answers is not set up; one without an offer is not', () => {
    const ids = setupIds(
      state([row('host', 'info'), row('kits', 'info'), row('generation', 'info'), row('cache', 'info')]),
    );
    expect([...ids].sort()).toEqual(['host', 'kits']);
  });
});

describe('runs-on and batchable', () => {
  const s = state([]);
  it('runs-on: user steps on the running copy, repo steps on the repo copy, external on its program', () => {
    expect(runsOn(USER_APPLY, s)).toBe('running');
    expect(runsOn({ ...USER_APPLY, writesTo: 'machine' }, s)).toBe('running');
    expect(runsOn(iaFix(['validate'], 'none').fix!, s)).toBe('repo');
    expect(runsOn(iaFix(['install', 'acme/kit'], 'repo').fix!, s)).toBe('repo');
    expect(runsOn(iaFix(['install', 'acme/kit'], 'repo').fix!, { ...s, repo: null })).toBe('running');
    expect(runsOn({ program: 'external', argv: ['npm', 'install'], flow: 'confirm', writesTo: 'repo' }, s)).toBe(
      'external',
    );
  });
  it('batchable needs a repo write', () => {
    expect(batchable([USER_APPLY])).toBe(false);
    expect(batchable([iaFix(['validate'], 'none').fix!])).toBe(false);
    expect(batchable([iaFix(['install', 'acme/kit'], 'repo').fix!, USER_APPLY])).toBe(true);
  });
});

describe('More', () => {
  it('diagnostics is always there', () => {
    expect(find(offersFor(state([])), 'diagnostics')?.group).toBe('more');
  });
  it('check for updates now uses refreshNow (with --force), is runnable on a fresh cache, and is disabled with its reason when refreshNow is null', () => {
    const offer = find(offersFor(state([row('updates', 'ok', null, { from: 'running' })])), 'check-updates')!;
    expect(offer.steps).toEqual([
      {
        program: 'external',
        argv: ['/node', '/dist/cli.js', 'refresh-updates', '--root', ROOT, '--force'],
        flow: 'immediate',
        writesTo: 'user',
      },
    ]);
    expect(offer.disabled).toBeUndefined();
    const off = find(
      offersFor(state([], { refreshNow: null, refreshNowWhy: 'IA_NO_UPDATE_CHECK=1 is set' })),
      'check-updates',
    )!;
    expect(off.disabled).toBe('IA_NO_UPDATE_CHECK=1 is set');
    expect(off.explain).toContain('IA_NO_UPDATE_CHECK=1 is set');
    expect(off.steps).toEqual([]);
  });
  it('the groups come in order: attention, set up, more', () => {
    const offers = offersFor(state([row('kits', 'info'), row('records', 'fail', iaFix(['validate'], 'none').fix)]));
    const groups = offers.map((offer) => offer.group);
    expect(groups).toEqual([...groups].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
    expect(groups[0]).toBe('attention');
    expect(groups.at(-1)).toBe('more');
  });
});
const ORDER = ['attention', 'setup', 'more'];

describe('extension offers', () => {
  const CONSOLE: ExtensionConsole = {
    areas: [{ id: 'account', title: 'Account', checks: ['acme-account'] }],
    offers: [
      {
        id: 'acme-sign-in',
        answers: ['acme-account'],
        title: 'Connect IA account',
        explain: 'Signs this machine in.',
        steps: [{ argv: ['acme', 'login'], flow: 'preview-apply', writesTo: 'user' }],
      },
    ],
    state: 'acme/state.json',
  };
  it('extension offers keep their token', () => {
    const offers = offersFor(state([row('acme-account', 'warn', null, { from: 'running' })]), [CONSOLE]);
    const offer = find(offers, 'acme-sign-in')!;
    expect(offer).toMatchObject({ group: 'attention', area: 'account', title: 'Connect IA account' });
    expect(offer.steps).toEqual([{ program: 'ia', argv: ['acme', 'login'], flow: 'preview-apply', writesTo: 'user' }]);
    expect(confirmedArgv(offer.steps[0]!)).toEqual(['acme', 'login', '--apply']);
    expect(runsOn(offer.steps[0]!, state([]))).toBe('running');
    // An answered check that is fine makes no offer.
    expect(
      find(offersFor(state([row('acme-account', 'ok', null, { from: 'running' })]), [CONSOLE]), 'acme-sign-in'),
    ).toBe(undefined);
  });
});

// The fixture rows are typed as checks too.
const _typed: Check = row('node', 'ok');
void _typed;
