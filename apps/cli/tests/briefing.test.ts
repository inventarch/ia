/**
 * docs/specs/host-plugin-distribution/README.md §8.2: every state of the session briefing, through the
 * pure function `ia doctor --host` calls, so no case needs a workspace, an IA home or a spawned process.
 */
import { expect, it } from 'vitest';
import { brief } from '../src/briefing.js';
import type { BriefInput } from '../src/briefing.js';

const npm = { kind: 'npm', name: '@inventarch/cli', version: '0.2.0' } as const;
const base: BriefInput = {
  host: 'claude',
  version: '0.2.0',
  channel: npm,
  plugin: { cli: '0.2.0' },
  root: undefined,
  supplied: undefined,
  enclosing: null,
  frameworkSource: false,
  decision: null,
  records: null,
  hostStatus: 'absent',
  hostDetail: null,
  recovery: null,
  updates: null,
  refresh: null,
};

it('not a workspace, no decision: silent to the user, init offered only when relevant', () => {
  const { session, nextActions } = brief(base);
  expect(session.notice).toBeNull();
  expect(session.nudge).toBeNull();
  expect(session.context.join('\n')).toMatch(/not an InventArch workspace.*Do not search/s);
  expect(nextActions).toEqual([{ intent: 'init', argv: ['ia', 'init', '.'], host: '/ia:init' }]);
});
it('declined today: silent, and the model is told not to offer', () => {
  const { session, nextActions } = brief({
    ...base,
    decision: {
      decision: 'declined-today',
      at: '2026-09-23T10:00:00.000Z',
      until: '2026-09-24T00:00:00.000Z',
      host: 'claude',
      path: '/r',
    },
  });
  expect(session.notice).toBeNull();
  expect(session.context.join('\n')).toContain('declined initialization here today');
  expect(nextActions).toEqual([]);
});
it('declined forever: the one-line reminder, dated in the local calendar', () => {
  const { session, nextActions } = brief({
    ...base,
    decision: {
      decision: 'declined-forever',
      at: new Date(2026, 8, 20, 10, 0).toISOString(),
      host: 'claude',
      path: '/r',
    },
  });
  expect(session.notice).toBe('IA not installed in /r; declined by user 2026-09-20');
  expect(session.context.join('\n')).toContain('"ia init" still works if the user asks for it explicitly');
  expect(nextActions).toEqual([]);
  // 23:30 local on the 20th is the 21st in UTC west of Greenwich; the reminder names the user's own date.
  const late = new Date(2026, 8, 20, 23, 30).toISOString();
  expect(
    brief({ ...base, decision: { decision: 'declined-forever', at: late, host: 'claude', path: '/r' } }).session.notice,
  ).toBe('IA not installed in /r; declined by user 2026-09-20');
});
it('plugin and CLI versions differ: one line naming the refresh', () => {
  const { session, nextActions } = brief({ ...base, plugin: { cli: '0.1.0' } });
  expect(session.notice).toBe(
    'IA: the plugin was installed by ia 0.1.0 but ia is 0.2.0; run ia host claude --user --apply',
  );
  expect(nextActions[0]).toEqual({
    intent: 'host-user',
    argv: ['ia', 'host', 'claude', '--user', '--apply'],
    host: 'ia host claude --user --apply',
  });
});
it('framework source: no consumer advice', () => {
  const { session, nextActions } = brief({ ...base, root: '/z/ia-open-source', frameworkSource: true });
  expect(session.notice).toBeNull();
  expect(session.context.join('\n')).toContain('InventArch framework source');
  expect(nextActions).toEqual([]);
});
it('workspace: stale and missing hosts get one line; healthy is silent', () => {
  const ws = { ...base, root: '/w', records: '12 records, 0 errors, 0 warnings at revision abc' };
  expect(brief({ ...ws, hostStatus: 'stale' }).session.notice).toBe(
    'IA: the Claude host registration for this workspace is stale; run ia host claude --apply',
  );
  const absent = brief({ ...ws, hostStatus: 'absent' });
  expect(absent.session.notice).toBe('IA: this workspace has no Claude host registration; run ia host claude --apply');
  expect(absent.nextActions).toEqual([
    { intent: 'host', argv: ['ia', 'host', 'claude', '--apply'], host: 'ia host claude --apply' },
  ]);
  const healthy = brief({ ...ws, hostStatus: 'registered' }).session;
  expect(healthy.notice).toBeNull();
  expect(healthy.context.join('\n')).toContain('12 records, 0 errors');
  expect(healthy.context).toContain('Host Claude: registered.');
});
it('stale: the model is told the reasons doctor found', () => {
  const { session } = brief({
    ...base,
    root: '/w',
    records: 'x',
    hostStatus: 'stale',
    hostDetail: 'stale (release): registered for release 000000000000',
  });
  expect(session.context).toContain(
    'Host Claude: stale — stale (release): registered for release 000000000000. Run ia host claude --apply.',
  );
});
it('an interrupted installation names recovery, never ia host', () => {
  const recover = 'ia-distribution recover --root /w';
  const { session, nextActions } = brief({
    ...base,
    root: '/w',
    records: null,
    hostStatus: 'unknown',
    hostDetail: 'installation recovery is required first',
    recovery: recover,
  });
  expect(session.notice).toBe(`IA: an interrupted installation needs recovery; run ${recover}`);
  expect(session.context.join('\n')).toContain('Host Claude: not checked (installation recovery is required first).');
  expect(session.context.join('\n')).not.toContain('ia host claude --apply');
  expect(nextActions).toEqual([]);
  // Unobserved without a pending transaction (installed state unreadable): nothing for the user, and still no ia host.
  const unread = brief({
    ...base,
    root: '/w',
    records: null,
    hostStatus: 'unknown',
    hostDetail: 'IA-DB-SOURCE-UNAVAILABLE',
    recovery: null,
  });
  expect(unread.session.notice).toBeNull();
  expect(unread.nextActions).toEqual([]);
  expect(unread.session.context.join('\n')).not.toContain('ia host claude --apply');
});
it('version skew outranks every other notice', () => {
  const { session } = brief({
    ...base,
    plugin: { cli: '0.1.0' },
    root: '/w',
    records: 'x',
    hostStatus: 'stale',
    updates: { latest: '0.3.0', behind: null },
  });
  expect(session.notice).toMatch(/^IA: the plugin was installed by ia 0\.1\.0/);
  expect(session.nudge).toBeNull();
});
it('an available update is a nudge the hook limits to once a day', () => {
  const { session } = brief({ ...base, updates: { latest: '0.3.0', behind: null } });
  expect(session).toMatchObject({
    nudge: 'update',
    notice:
      'IA: ia 0.3.0 is available (you have 0.2.0). npm i -g @inventarch/cli@latest, then ia host claude --user --apply',
  });
});
it('the refresh vector passes through unchanged', () => {
  expect(brief({ ...base, refresh: ['ia-distribution', 'refresh-updates'] }).session.refresh).toEqual([
    'ia-distribution',
    'refresh-updates',
  ]);
});
it('codex has no native invocation, so next actions carry the plain command', () => {
  const { nextActions } = brief({ ...base, host: 'codex' });
  expect(nextActions).toEqual([{ intent: 'init', argv: ['ia', 'init', '.'], host: 'ia init .' }]);
  const workspace = brief({ ...base, host: 'codex', root: '/w', records: 'x', hostStatus: 'absent' });
  expect(workspace.session.notice).toBe('IA: this workspace has no Codex host registration; run ia host codex --apply');
});
it('the Claude plugin is not a Codex concern', () => {
  const { session, nextActions } = brief({ ...base, host: 'codex', plugin: { cli: '0.1.0' } });
  expect(session.notice).toBeNull();
  expect(nextActions.map((action) => action.intent)).toEqual(['init']);
});
it('cursor has no workspace registration to report as missing', () => {
  const { session, nextActions } = brief({ ...base, host: 'cursor', root: '/w', records: 'x', hostStatus: 'absent' });
  expect(session.notice).toBeNull();
  expect(nextActions).toEqual([]);
  expect(session.context.join('\n')).toContain('Cursor has no workspace registration');
});
it('an interrupted installation is reported for every host, Cursor included', () => {
  const { session } = brief({
    ...base,
    host: 'cursor',
    root: '/w',
    records: null,
    hostStatus: 'unknown',
    hostDetail: 'installation recovery is required first',
    recovery: 'ia-distribution recover --root /w',
  });
  expect(session.notice).toBe('IA: an interrupted installation needs recovery; run ia-distribution recover --root /w');
});
it('with --root, every command carries the root the way its verb takes a directory', () => {
  const ws = {
    ...base,
    root: '/my ws',
    supplied: '/my ws',
    records: 'x',
    hostStatus: 'absent' as const,
    plugin: { cli: '0.1.0' },
  };
  const { session, nextActions } = brief(ws);
  // --user belongs to no workspace and refuses --root, so the skew remedy stays bare.
  expect(nextActions).toEqual([
    { intent: 'host-user', argv: ['ia', 'host', 'claude', '--user', '--apply'], host: 'ia host claude --user --apply' },
    {
      intent: 'host',
      argv: ['ia', 'host', 'claude', '--root', '/my ws', '--apply'],
      host: 'ia host claude --root "/my ws" --apply',
    },
  ]);
  expect(session.context).toContain('Host Claude: not registered. Run ia host claude --root "/my ws" --apply.');
  expect(brief({ ...ws, plugin: null }).session.notice).toBe(
    'IA: this workspace has no Claude host registration; run ia host claude --root "/my ws" --apply',
  );
  // init takes its target as a positional and refuses --root; the host's own /ia:init runs in the project directory, so it is not used.
  const plain = brief({ ...base, supplied: '/d' });
  expect(plain.nextActions).toEqual([{ intent: 'init', argv: ['ia', 'init', '/d'], host: 'ia init /d' }]);
  expect(plain.session.context.join('\n')).toContain('/d is not an InventArch workspace');
});
it('with --root inside a workspace, the briefing names that workspace and neither describes it nor offers init', () => {
  const { session, nextActions } = brief({ ...base, supplied: '/w/apps/cli', enclosing: '/w' });
  expect(session.notice).toBeNull();
  expect(nextActions).toEqual([]);
  expect(session.context).toContain(
    '/w/apps/cli is inside InventArch workspace /w; run ia doctor --root /w for its state.',
  );
  expect(session.context.join('\n')).not.toContain('not an InventArch workspace');
});
