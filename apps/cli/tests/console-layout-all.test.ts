/**
 * The all-workspaces view (console/layout-all.ts) as golden frames: the plain text of every row of the cell grid, stored
 * under tests/fixtures/console/. Run with UPDATE_GOLDEN=1 to rewrite them after an intended change, then review the diff:
 *   UPDATE_GOLDEN=1 npx vitest run --config vitest.config.mts tests/console-layout-all.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckStatus } from '../src/doctor.js';
import type { Fix } from '../src/fix.js';
import { iaFix } from '../src/fix.js';
import type { Capabilities } from '../src/render.js';
import type { RepoPlan } from '../src/console/batch-plan.js';
import type { AllLayoutInput } from '../src/console/layout-all.js';
import { layoutAll, summaryText } from '../src/console/layout-all.js';
import { batchable } from '../src/console/offers.js';
import type { Offer, Step } from '../src/console/offers.js';
import type { ConsoleCheck, ConsoleState } from '../src/console/state.js';
import { areasOf } from '../src/console/state.js';
import { stringWidth } from '../src/console/width.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import { loadingRow, summarize } from '../src/console/workspaces-state.js';

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

const check = (id: string, status: CheckStatus, detail: string, fix: Fix | null = null): ConsoleCheck => ({
  id,
  section: 'Environment',
  title: id,
  status,
  detail,
  remedy: null,
  fix,
  from: 'repo',
  reported: true,
});
const offer = (id: string, title: string, steps: readonly Step[]): Offer => ({
  id,
  answers: [id],
  title,
  explain: '',
  steps,
  changes: [],
  group: 'attention',
  area: null,
  writesTo: [...new Set(steps.map((step) => step.writesTo))],
  batchable: batchable(steps),
});
const tracked = (id: string, root = `/srv/repos/${id}`) => ({ id, root, added: '2026-01-01T00:00:00.000Z' });
function ready(
  id: string,
  version: string | null,
  checks: readonly ConsoleCheck[],
  offers: readonly Offer[] = [],
): RepoRow {
  const root = `/srv/repos/${id}`;
  const state: ConsoleState = {
    root,
    running: { packageRoot: '/srv/global/cli', version: '3.4.0' },
    repo:
      version === null ? null : { packageRoot: `${root}/node_modules/@inventarch/cli`, version, entry: `${root}/e.js` },
    checks,
    areas: areasOf(checks, new Set()),
    repoFailure: null,
    tracked: true,
    refreshNow: null,
    refreshNowWhy: 'off',
    facts: {
      home: '/srv/ia-home',
      latest: '3.5.1',
      manifestDir: root,
      manager: 'npm',
      managerConflict: [],
      generation: true,
      marketplace: false,
    },
  };
  return { tracked: tracked(id), state: 'ready', console: state, offers, failure: null };
}
const upgrade = (id: string) =>
  offer('upgrade', 'Upgrade CLI to 3.5.1', [
    { program: 'external', argv: ['npm', 'install', '-D', '@inventarch/cli@3.5.1'], flow: 'confirm', writesTo: 'repo' },
    { ...iaFix(['restore', '--apply', '--root', `/srv/repos/${id}`], 'repo').fix!, requires: 'repo-copy' },
    iaFix(['host', 'claude', '--user', '--apply'], 'user').fix!,
  ]);
const relock = (id: string) =>
  offer('fix:generation', 'Re-lock', [iaFix(['restore', '--apply', '--root', `/srv/repos/${id}`], 'repo').fix!]);
function rows(): RepoRow[] {
  return [
    ready(
      'atlas',
      '3.5.0',
      [
        check('cli-version', 'warn', "running 3.4.0; this workspace's copy is 3.5.0"),
        check('records', 'ok', '257 records, 0 errors, 0 warnings at revision a1b2c3'),
        check('generation', 'warn', 'The lock and the installed generation differ'),
        check('kits', 'ok', '2 kits installed'),
        check('kit-update:acme/a', 'warn', 'acme/a 1.1.0 is available'),
        check('kit-update:acme/b', 'warn', 'acme/b 2.0.0 is available'),
        { ...check('plugin-claude', 'warn', 'ia 3.5.0 rendered the plugin'), from: 'running' },
      ],
      [upgrade('atlas'), relock('atlas')],
    ),
    ready(
      'app',
      '3.4.1',
      [
        check('cli-version', 'warn', "running 3.4.0; this workspace's copy is 3.4.1"),
        check('records', 'fail', '120 records, 3 errors, 0 warnings at revision d4e5f6'),
        check('generation', 'ok', 'Generation 4 is installed'),
        check('kits', 'ok', '4 kits installed'),
        ...['a', 'b', 'c', 'd'].map((name) => check(`kit-update:acme/${name}`, 'warn', `acme/${name} is behind`)),
      ],
      [upgrade('app')],
    ),
    ready('ia', '3.5.1', [
      check('cli-version', 'ok', "this workspace's copy 3.5.1, CLI dependency 3.5.1"),
      check('records', 'ok', '980 records, 0 errors, 0 warnings at revision 0a0b0c'),
      check('kits', 'ok', 'no updates'),
    ]),
    loadingRow(tracked('notes')),
    { ...loadingRow(tracked('gone')), state: 'missing' },
    {
      ...ready('old', '3.2.0', [check('records', 'unknown', 'doctor failed: exit 3')]),
      state: 'failed',
      failure: 'exit 3',
    },
  ];
}
const UNICODE: Capabilities = { color: false, ascii: false, width: 80 };
const ASCII: Capabilities = { color: false, ascii: true, width: 80 };
const CHOICES = [
  { offerId: 'upgrade', title: 'Upgrade CLI to 3.5.1', repos: 2 },
  { offerId: 'fix:generation', title: 'Re-lock', repos: 1 },
];
function frame(overrides: Partial<AllLayoutInput> = {}, repos: readonly RepoRow[] = rows()): string[] {
  return layoutAll({
    repos,
    summary: summarize(repos, { latest: '3.5.1' }, '3.4.0'),
    selected: new Set([0, 1]),
    cursor: 0,
    choices: CHOICES,
    preview: null,
    found: null,
    message: null,
    prompt: null,
    repoTab: false,
    caps: UNICODE,
    columns: 100,
    rows: 24,
    ...overrides,
  }).lines();
}

describe('golden frames', () => {
  it('80, 100 and 140 columns, unicode and ascii; loading rows show ?', () => {
    for (const columns of [80, 100, 140]) {
      golden(`all-${columns}`, frame({ columns }));
      const ascii = frame({ columns, caps: ASCII });
      golden(`all-${columns}-ascii`, ascii);
      for (const line of ascii) expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
    const loading = frame().find((line) => line.includes('notes'))!;
    expect(loading).toMatch(/\[ \] \? notes\s+\? \?\s+\? \?\s+\? \?\s+\? \?/);
    // The plugin column appears from 120 columns.
    expect(frame({ columns: 140 }).find((line) => line.includes('workspace'))).toContain('plugin');
    expect(frame({ columns: 100 }).find((line) => line.includes('workspace'))).not.toContain('plugin');
  });
  it('an empty list highlights find', () => {
    const lines = frame({ selected: new Set(), choices: [], cursor: 0 }, []);
    golden('all-empty', lines);
    expect(lines.join('\n')).toContain('› Find workspaces in a folder…');
    expect(lines.join('\n')).toContain('No workspaces are tracked yet.');
  });
  it('the batch preview lists worktree, branch and commands per repo', () => {
    const repos = rows();
    // Built as planning builds it, spelled with POSIX paths so the frame is the same on every platform.
    const planned = (id: string, refused: string | null = null): RepoPlan => {
      const worktree = `/srv/repos/.ia-worktrees/${id}-ia-3-5-1`;
      return {
        root: `/srv/repos/${id}`,
        top: `/srv/repos/${id}`,
        worktree,
        workspace: worktree,
        branch: 'chore/ia-3-5-1',
        steps: [
          {
            program: 'external',
            argv: ['npm', 'install', '-D', '@inventarch/cli@3.5.1'],
            flow: 'confirm',
            writesTo: 'repo',
          },
          { ...iaFix(['restore', '--apply', '--root', worktree], 'repo').fix!, requires: 'repo-copy' },
        ],
        deferred: [],
        refused,
      };
    };
    const preview = {
      choice: CHOICES[0]!,
      repos: [planned('atlas'), planned('app', 'origin has no HEAD, main or master')],
      deferred: [iaFix(['host', 'claude', '--user', '--apply'], 'user').fix!],
    };
    const lines = frame({ preview, cursor: repos.length, columns: 140, rows: 30 }, repos);
    golden('all-preview', lines);
    const text = lines.join('\n');
    expect(text).toContain('worktree /srv/repos/.ia-worktrees/atlas-ia-3-5-1');
    expect(text).toContain('branch   chore/ia-3-5-1');
    // The rebuilt command in full, wrapped under its number: --root names the worktree.
    const at = lines.findIndex((line) => line.endsWith('2. ia restore --apply --root'));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/│ +\/srv\/repos\/\.ia-worktrees\/atlas-ia-3-5-1$/);
    expect(text).toContain('refused: origin has no HEAD, main or master');
    expect(text).toContain('LEFT FOR AFTER, ONCE');
    expect(text).toContain('ia host claude --user --apply');
  });
  it('wide characters keep the divider column', () => {
    const repos = [
      {
        ...ready('wide', '3.5.0', [check('records', 'ok', '1 records, 0 errors, 0 warnings')]),
        tracked: { ...tracked('w'), label: '用户项目 workspace' },
      },
      {
        ...ready('emoji', '3.5.0', [check('records', 'ok', '1 records, 0 errors, 0 warnings')]),
        tracked: { ...tracked('e'), label: '🚀 rocket 👨‍👩‍👧 family' },
      },
    ];
    const lines = frame({ selected: new Set([0]), choices: [] }, repos);
    golden('all-wide', lines);
    const columns = lines.flatMap((line) => {
      const at = line.indexOf('│');
      return at === -1 ? [] : [stringWidth(line.slice(0, at))];
    });
    expect(columns.length).toBeGreaterThan(10);
    expect(new Set(columns).size).toBe(1);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });
});

describe('summary', () => {
  it('every non-zero count is visible at 80, 100 and 140 columns, the panel wrapping when it must', () => {
    const repos = [...rows(), { ...ready('fresh', '3.5.1', [check('kits', 'unknown', 'not checked')]) }];
    for (const columns of [80, 100, 140])
      for (const caps of [UNICODE, ASCII]) {
        const lines = frame({ columns, caps }, repos);
        const panel = lines
          .slice(
            0,
            lines.findIndex((line) => /^[─-]{10,}/.test(line)),
          )
          .join(' ');
        for (const count of [
          'Tracked 7',
          'Healthy 1',
          'Attention 2',
          'Missing 1',
          'Unreadable 1',
          'Unchecked 1',
          'Loading 1',
        ])
          expect([columns, panel]).toEqual([columns, expect.stringContaining(count)]);
        for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
        expect(lines.some((line) => line.includes('…') && /Loading|Unreadable/.test(line))).toBe(false);
      }
    // The table keeps its header and rows below a two-line panel.
    const narrow = frame({ columns: 80 }, repos);
    expect(narrow[1]).toContain('Unreadable 1');
    expect(narrow[2]).toMatch(/^─+$/);
    expect(narrow[3]).toContain('workspace');
  });
  it('the summary shows Tracked, Healthy, Attention, Missing, and Unreadable, Unchecked and Loading only when non-zero', () => {
    const base = summarize([], { latest: '3.5.1' }, '3.5.1');
    expect(summaryText(base, false)).toBe('Latest 3.5.1  Global 3.5.1  Tracked 0  Healthy 0  Attention 0  Missing 0');
    expect(summaryText({ ...base, failed: 1, unchecked: 2, loading: 3 }, false)).toBe(
      'Latest 3.5.1  Global 3.5.1  Tracked 0  Healthy 0  Attention 0  Missing 0  Unreadable 1  Unchecked 2  Loading 3',
    );
    expect(summaryText({ ...base, latest: null, global: '3.4.0', behind: true }, false)).toContain('Global 3.4.0 ▲');
    expect(summaryText({ ...base, behind: true }, true)).toContain('Global 3.5.1 !');
  });
  it('an unreadable row reads unreadable, with no cells, and counts in Unreadable', () => {
    const repos: RepoRow[] = [{ ...loadingRow(tracked('locked')), state: 'unreadable' }];
    const lines = frame({ selected: new Set(), choices: [], cursor: 0, columns: 140 }, repos);
    expect(lines.some((line) => /\[ \] \? locked\s+unreadable/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('Unreadable: the folder cannot be examined'))).toBe(true);
    expect(lines[0]).toContain('Unreadable 1');
    expect(lines[0]).toContain('Missing 0');
  });
  it('a repo whose only failure is advice-only shows ▲ and counts in Attention', () => {
    const repos = [
      ready('advice', '3.5.1', [
        check('node', 'fail', 'Node 18 is below the supported 22'),
        check('records', 'ok', '1 records, 0 errors, 0 warnings'),
      ]),
    ];
    expect(repos[0]!.offers).toEqual([]);
    const lines = frame({ selected: new Set(), choices: [] }, repos);
    expect(lines.some((line) => line.includes('[ ] ▲ advice'))).toBe(true);
    expect(lines[0]).toContain('Attention 1');
    expect(lines[0]).toContain('Healthy 0');
  });
});
