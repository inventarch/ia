/**
 * The single-repo view (console/layout-repo.ts) as golden frames: the plain text of every row of the cell grid, stored
 * under tests/fixtures/console/. Run with UPDATE_GOLDEN=1 to rewrite them after an intended change, then review the diff:
 *   UPDATE_GOLDEN=1 npx vitest run --config vitest.config.mts tests/console-layout.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckStatus } from '../src/doctor.js';
import type { ExtensionConsole } from '../src/doctor-extensions.js';
import type { Fix } from '../src/fix.js';
import { iaFix } from '../src/fix.js';
import type { Capabilities } from '../src/render.js';
import type { LayoutInput } from '../src/console/layout-repo.js';
import { layoutRepo } from '../src/console/layout-repo.js';
import { offersFor, setupIds } from '../src/console/offers.js';
import type { ConsoleCheck, ConsoleState } from '../src/console/state.js';
import { areasOf } from '../src/console/state.js';
import { stringWidth } from '../src/console/width.js';

const GOLDEN = resolve(import.meta.dirname, 'fixtures/console');
function golden(name: string, lines: readonly string[]): void {
  const file = join(GOLDEN, `${name}.txt`);
  const text = `${lines.join('\n')}\n`;
  if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(file)) {
    if (process.env['UPDATE_GOLDEN'] !== '1') throw new Error(`no golden frame ${name}.txt; run with UPDATE_GOLDEN=1`);
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text).toBe(readFileSync(file, 'utf8'));
}

const row = (
  id: string,
  status: CheckStatus,
  detail: string,
  from: ConsoleCheck['from'] = 'repo',
  fix: Fix | null = null,
): ConsoleCheck => ({
  id,
  section: 'Environment',
  title: id,
  status,
  detail,
  remedy: null,
  fix,
  from,
  reported: true,
});
const USER_APPLY = iaFix(['host', 'claude', '--user', '--apply'], 'user').fix;
function fixture(root = '/srv/ws/notes', extra: { wide?: boolean; extensions?: readonly ExtensionConsole[] } = {}) {
  const wide = extra.wide === true;
  const checks: ConsoleCheck[] = [
    row('install-channel', 'ok', 'npm @inventarch/cli 3.5.1', 'running'),
    row('cli-version', 'warn', "running 3.5.1; this workspace's copy is 3.5.0"),
    row('node', 'ok', 'v22.23.4 on win32 x64'),
    row(
      'records',
      'ok',
      wide
        ? '257 records, 0 errors, 2 warnings at revision 用户项目🚀'
        : '257 records, 0 errors, 2 warnings at revision a1b2c3d4e5f6',
    ),
    row('kits', 'info', 'no kits installed'),
    row('updates', 'warn', 'ia 3.5.2 is available; this is 3.5.1 (checked 2026-11-03)', 'running'),
    row('generation', 'info', 'None installed'),
    row('host', 'info', wide ? 'No host registered in 用户的项目 👨‍👩‍👧' : 'No host registered'),
    row('plugin-claude', 'warn', 'ia 3.5.0 rendered the plugin; this is ia 3.5.1', 'running', USER_APPLY),
    row('marketplace', 'ok', 'inventarch · ia · installed by ia 3.5.0'),
  ];
  const base: Omit<ConsoleState, 'areas'> = {
    root,
    running: { packageRoot: '/srv/global/cli', version: '3.5.1' },
    repo: { packageRoot: `${root}/node_modules/@inventarch/cli`, version: '3.5.0', entry: `${root}/e.js` },
    checks,
    repoFailure: null,
    tracked: false,
    refreshNow: ['/node', '/cli.js', 'refresh-updates', '--force'],
    refreshNowWhy: null,
    facts: {
      home: '/srv/ia-home',
      latest: '3.5.2',
      manifestDir: root,
      manager: 'npm',
      managerConflict: [],
      generation: false,
      marketplace: true,
    },
  };
  const extensions = extra.extensions ?? [];
  const state: ConsoleState = { ...base, areas: areasOf(checks, setupIds(base, extensions), extensions) };
  return { state, offers: offersFor(state, extensions) };
}
const UNICODE: Capabilities = { color: false, ascii: false, width: 80 };
const ASCII: Capabilities = { color: false, ascii: true, width: 80 };
const frame = (overrides: Partial<LayoutInput> = {}, made = fixture()): string[] =>
  layoutRepo({
    state: made.state,
    offers: made.offers,
    selected: 0,
    scroll: { list: 0, pane: 0 },
    view: 'offers',
    message: null,
    prompt: null,
    caps: UNICODE,
    columns: 100,
    rows: 24,
    ...overrides,
  }).lines();

describe('golden frames', () => {
  it('80, 100 and 140 columns, unicode', () => {
    golden('repo-80', frame({ columns: 80 }));
    golden('repo-100', frame({ columns: 100 }));
    golden('repo-140', frame({ columns: 140 }));
  });
  it('ascii at 100', () => {
    const lines = frame({ caps: ASCII });
    golden('repo-100-ascii', lines);
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(lines.join('\n')).toContain('Add a kit...');
  });
  it('wide characters keep the divider column', () => {
    const made = fixture('/srv/用户/项目/🚀/notes', { wide: true });
    const lines = frame({ selected: 5 }, made);
    golden('repo-wide', lines);
    const columns = lines
      .map((line) => {
        const at = line.indexOf('│');
        return at === -1 ? null : stringWidth(line.slice(0, at));
      })
      .filter((column) => column !== null);
    expect(columns.length).toBeGreaterThan(10);
    expect(new Set(columns).size).toBe(1);
    // The dividers' junctions sit in the same column.
    const junctions = lines
      .filter((line) => /[┬┴]/.test(line))
      .map((line) => stringWidth(line.slice(0, line.search(/[┬┴]/))));
    expect(junctions).toEqual([columns[0], columns[0]]);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });
  it('too small', () => {
    golden('repo-too-small', frame({ columns: 79, rows: 24 }));
    expect(frame({ columns: 120, rows: 19 })[0]).toBe('Terminal too small (need 80×20)');
    expect(frame({ columns: 120, rows: 19, caps: ASCII })[0]).toBe('Terminal too small (need 80x20)');
  });
  it('list scrolls inside its viewport and the panel never moves', () => {
    const made = fixture();
    const last = made.offers.length - 1;
    // At 80 columns the pane sits below the list, so the list's viewport is short and has to scroll.
    const top = frame({ rows: 20, columns: 80 }, made);
    const scrolled = frame({ rows: 20, columns: 80, selected: last, scroll: { list: 0, pane: 0 } }, made);
    golden('repo-scrolled', scrolled);
    const panel = top.findIndex((line) => line.startsWith('─'));
    expect(scrolled.slice(0, panel + 1)).toEqual(top.slice(0, panel + 1));
    expect(scrolled.slice(-2)).toEqual(top.slice(-2));
    expect(scrolled.some((line) => line.includes(`› · ${made.offers[last]!.title}`))).toBe(true);
    expect(scrolled.some((line) => line.includes('NEEDS ATTENTION'))).toBe(false);
  });
  it('the diagnostics view lists every check', () => {
    const made = fixture();
    const lines = frame({ view: 'diagnostics', rows: 30 }, made);
    golden('repo-diagnostics', lines);
    for (const check of made.state.checks) expect(lines.some((line) => line.includes(check.id))).toBe(true);
  });
  it('an absent provider leaves no cell', () => {
    const account: ExtensionConsole = {
      areas: [{ id: 'account', title: 'Account', checks: ['acme-account'] }],
      offers: [],
      state: 'acme/state.json',
    };
    const without = frame();
    expect(without.slice(0, 3).join('\n')).not.toContain('Account');
    const withAccount = frame({}, fixture('/srv/ws/notes', { extensions: [account] }));
    golden('repo-account', withAccount.slice(0, 4));
    expect(withAccount.slice(0, 4).join('\n')).toContain('Account — not reported');
  });
  it('a prompt replaces the key bar', () => {
    const lines = frame({ prompt: { label: 'Kit id', value: 'acme/k', error: null } });
    expect(lines.at(-1)).toBe(' Kit id: acme/k▌  enter accept · esc cancel');
    const refused = frame({ prompt: { label: 'Kit id', value: '-x', error: 'A kit id cannot start with a dash.' } });
    expect(refused.at(-1)).toBe(' Kit id: -x▌  A kit id cannot start with a dash.');
    expect(frame().at(-1)).toBe(' ↑↓ move · enter run · tab diagnostics · r refresh · ? help · q quit');
  });
  it('a message shows on the lower divider', () => {
    const lines = frame({ message: 'ia validate exited 1' });
    expect(lines.at(-2)?.startsWith('── ia validate exited 1 ─')).toBe(true);
  });
});
