/**
 * `Extension.console` (consumer CLI contract §2.12, host-plugin-distribution §7.3): an extension contributes console
 * areas, offers and doctor checks as data. Its checks come from a state file in the IA home, are confined to ids under
 * its own token, and never replace a core row; a fix outside its token is dropped.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { Extension } from '../src/consumer.js';
import { collectDoctor } from '../src/doctor.js';
import { extensionChecks } from '../src/doctor-extensions.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const acme = (console?: Extension['console']): Extension => ({
  token: 'acme',
  summary: 'Acme services',
  run: async () => ({ exitCode: 0, stdout: '' }),
  ...(console === undefined ? {} : { console }),
});
const CONSOLE = {
  areas: [{ id: 'acme', title: 'Acme', checks: ['acme-account'] }],
  offers: [
    {
      id: 'acme-sign-in',
      answers: ['acme-account'],
      title: 'Sign in to Acme',
      explain: 'Signs this machine in.',
      steps: [{ argv: ['acme', 'login'], flow: 'confirm' as const, writesTo: 'user' as const }],
    },
  ],
  state: 'acme/state.json',
};
const home = (state?: unknown): string => {
  const at = resolve(scratch('doctor-extensions'), '.ia');
  if (state !== undefined) {
    mkdirSync(join(at, 'acme'), { recursive: true });
    writeFileSync(join(at, 'acme/state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  }
  return at;
};
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: 'Acme account',
  status: 'warn',
  detail: 'Not signed in',
  remedy: 'ia acme login',
  ...extra,
});

it('no console, no rows', () => {
  expect(extensionChecks([acme()], home({ format: 'ia-extension-checks-1', checks: [row('acme-account')] }))).toEqual(
    [],
  );
});
it('absent state, no rows', () => {
  expect(extensionChecks([acme(CONSOLE)], home())).toEqual([]);
  expect(extensionChecks([acme(CONSOLE)], null)).toEqual([]);
});
it('valid state adds rows with their fixes', () => {
  const fix = { program: 'ia', argv: ['acme', 'login'], flow: 'confirm', writesTo: 'user' };
  expect(
    extensionChecks(
      [acme(CONSOLE)],
      home({
        format: 'ia-extension-checks-1',
        checks: [row('acme-account', { fix }), row('acme-quota', { status: 'ok', remedy: null })],
      }),
    ),
  ).toEqual([
    {
      id: 'acme-account',
      section: 'Environment',
      title: 'Acme account',
      status: 'warn',
      detail: 'Not signed in',
      remedy: 'ia acme login',
      fix,
    },
    {
      id: 'acme-quota',
      section: 'Environment',
      title: 'Acme account',
      status: 'ok',
      detail: 'Not signed in',
      remedy: null,
      fix: null,
    },
  ]);
});
it('a row outside the token is dropped and reported, and so is one that names a core check id', () => {
  const checks = extensionChecks(
    [acme(CONSOLE)],
    home({ format: 'ia-extension-checks-1', checks: [row('acme-account'), row('records'), row('acme-root')] }),
    new Set(['records', 'acme-root']),
  );
  expect(checks.map((check) => [check.id, check.status])).toEqual([
    ['acme-account', 'warn'],
    ['acme-state', 'unknown'],
  ]);
  expect(checks[1]!.detail).toContain('records');
  expect(checks[1]!.detail).toContain('acme-root');
});
it('malformed state is one unknown row', () => {
  for (const state of [
    '{not json',
    { format: 'other', checks: [] },
    { format: 'ia-extension-checks-1', checks: [{ id: 'acme-x' }] },
  ])
    expect(extensionChecks([acme(CONSOLE)], home(state))).toEqual([
      expect.objectContaining({
        id: 'acme-state',
        section: 'Environment',
        status: 'unknown',
        detail: expect.stringContaining('state unreadable'),
        fix: null,
      }),
    ]);
});
it('a fix outside the token is nulled', () => {
  for (const fix of [
    { program: 'ia', argv: ['host', 'claude', '--user', '--apply'], flow: 'preview-apply', writesTo: 'user' },
    { program: 'external', argv: ['acme', 'login'], flow: 'confirm', writesTo: 'user' },
    { program: 'ia', argv: ['acme', 'login'], flow: 'sometimes', writesTo: 'user' },
  ])
    expect(
      extensionChecks(
        [acme(CONSOLE)],
        home({ format: 'ia-extension-checks-1', checks: [row('acme-account', { fix })] }),
      )[0],
    ).toMatchObject({ id: 'acme-account', remedy: 'ia acme login', fix: null });
});
it('a fix no declared step names asks first and targets the machine, whatever the state file claims', () => {
  const fix = { program: 'ia', argv: ['acme', 'wipe'], flow: 'immediate', writesTo: 'none' };
  expect(
    extensionChecks(
      [acme(CONSOLE)],
      home({ format: 'ia-extension-checks-1', checks: [row('acme-account', { fix })] }),
    )[0]?.fix,
  ).toEqual({ program: 'ia', argv: ['acme', 'wipe'], flow: 'confirm', writesTo: 'machine' });
});
it("a fix a declared step names takes that step's flow and target, not the state file's", () => {
  const fix = { program: 'ia', argv: ['acme', 'login'], flow: 'immediate', writesTo: 'none' };
  expect(
    extensionChecks(
      [acme(CONSOLE)],
      home({ format: 'ia-extension-checks-1', checks: [row('acme-account', { fix })] }),
    )[0]?.fix,
  ).toEqual({ program: 'ia', argv: ['acme', 'login'], flow: 'confirm', writesTo: 'user' });
});
it("a declared step's flow and target win over the state file's for that argv", () => {
  const sync = { argv: ['acme', 'sync'], flow: 'immediate' as const, writesTo: 'repo' as const };
  const declared = { ...CONSOLE, offers: [{ ...CONSOLE.offers[0]!, steps: [...CONSOLE.offers[0]!.steps, sync] }] };
  const fix = { program: 'ia', argv: ['acme', 'sync'], flow: 'confirm', writesTo: 'machine' };
  expect(
    extensionChecks(
      [acme(declared)],
      home({ format: 'ia-extension-checks-1', checks: [row('acme-account', { fix })] }),
    )[0]?.fix,
  ).toEqual({ program: 'ia', argv: ['acme', 'sync'], flow: 'immediate', writesTo: 'repo' });
});
it('doctor appends extension rows after the user rows, in Environment', () => {
  const at = home({ format: 'ia-extension-checks-1', checks: [row('acme-account')] });
  const view = collectDoctor({
    cwd: scratch('doctor-extensions-cwd'),
    packageRoot: scratch('doctor-extensions-package'),
    runtime: { version: 'v22.22.0', platform: 'linux', arch: 'x64' },
    env: { IA_HOME: at },
    home: scratch('doctor-extensions-user'),
    version: '3.5.1',
    now: new Date('2026-11-03T12:00:00Z'),
    channel: { kind: 'npm', name: '@inventarch/cli', version: '3.5.1' },
    extensions: [acme(CONSOLE)],
  });
  const ids = view.checks.map((check) => check.id);
  expect(ids.at(-1)).toBe('acme-account');
  expect(ids.indexOf('acme-account')).toBeGreaterThan(ids.indexOf('workspace-decision'));
  expect(view.counts.warn).toBeGreaterThan(0);
});
