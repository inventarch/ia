/**
 * Every doctor check carries a structured `fix` beside its `remedy` (consumer CLI contract §2.12, host plugin
 * distribution §7.3): runnable remedies get one whose display is the remedy, advice gets none, and `--json` is
 * otherwise exactly what it was before the field existed.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DoctorView } from '../src/doctor.js';
import { collectDoctor, doctorEnvelope } from '../src/doctor.js';
import type { Fix } from '../src/fix.js';
import { displayFix } from '../src/fix.js';
import { quote } from '../src/render.js';
import type { Fixture, FixtureName } from './doctor-fix-fixture.js';
import { fixture, normalized, report, VERSION, withoutFix } from './doctor-fix-fixture.js';
import { cleanup, commandRoot, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });
afterAll(cleanup, 120_000);

const NAMES: readonly FixtureName[] = [
  'none',
  'declined',
  'clean',
  'foreign',
  'pending',
  'generation',
  'ancestor',
  'shell-root',
  'projected',
  'registered',
];
const fixtures = new Map<FixtureName, Fixture>(),
  views = new Map<FixtureName, DoctorView>();
beforeAll(async () => {
  for (const name of NAMES) {
    const at = await fixture(name);
    fixtures.set(name, at);
    views.set(name, report(at));
  }
});
const checkOf = (name: FixtureName, id: string) => views.get(name)!.checks.find((check) => check.id === id);
/** The root as a printed command spells it: the real path, with forward slashes on Windows. */
const rooted = (name: FixtureName): string => commandRoot(realpathSync(fixtures.get(name)!.root));

interface Expected {
  readonly fixture: FixtureName;
  readonly id: string;
  /** Null for a row whose remedy is advice. */
  readonly fix: null | {
    readonly program: Fix['program'];
    readonly argv: (name: FixtureName) => readonly string[];
    readonly flow: Fix['flow'];
    readonly writesTo: Fix['writesTo'];
    /** `remedy`: the remedy is one runnable command, and the fix displays as it; `own`: the fix shows this text. */
    readonly display: 'remedy' | ((name: FixtureName) => string);
  };
}
const ia = (
  argv: (name: FixtureName) => readonly string[],
  flow: Fix['flow'],
  writesTo: Fix['writesTo'],
  display: 'remedy' | ((name: FixtureName) => string) = 'remedy',
) => ({ program: 'ia' as const, argv, flow, writesTo, display });
const recover = (name: FixtureName) => ['recover', 'installation', '--root', rooted(name)];
const EXPECTED: readonly Expected[] = [
  { fixture: 'none', id: 'root', fix: ia(() => ['init'], 'preview-apply', 'repo') },
  { fixture: 'declined', id: 'workspace-decision', fix: ia(() => ['init', '--forget-decline'], 'confirm', 'user') },
  { fixture: 'foreign', id: 'records', fix: ia(() => ['validate'], 'immediate', 'none') },
  { fixture: 'pending', id: 'pending', fix: ia(recover, 'confirm', 'repo') },
  { fixture: 'pending', id: 'install-lock', fix: ia(recover, 'confirm', 'repo') },
  { fixture: 'generation', id: 'generation', fix: ia(recover, 'confirm', 'repo') },
  {
    fixture: 'generation',
    id: 'source-protection',
    fix: ia((name) => ['position', '--shape', 'governance', '--root', rooted(name)], 'immediate', 'none'),
  },
  // A root that holds shell syntax is printed as `.`, with a sentence saying where to run it, so the remedy is advice
  // around one command: the fix carries that command, and shows it.
  {
    fixture: 'shell-root',
    id: 'pending',
    fix: ia(
      () => ['recover', 'installation', '--root', '.'],
      'confirm',
      'repo',
      () => 'ia recover installation --root .',
    ),
  },
  {
    fixture: 'projected',
    id: 'projection-claude:.claude/rules/ia-workspace.md',
    fix: ia((name) => ['project', 'claude', '--root', rooted(name), '--apply'], 'preview-apply', 'repo'),
  },
  {
    fixture: 'registered',
    id: 'projection-claude:.claude/rules/ia-workspace.md',
    fix: ia((name) => ['host', 'claude', '--root', rooted(name), '--apply'], 'preview-apply', 'repo'),
  },
  {
    fixture: 'none',
    id: 'plugin-claude',
    fix: ia(() => ['host', 'claude', '--user', '--apply'], 'preview-apply', 'user'),
  },
  {
    fixture: 'clean',
    id: 'cli-version',
    fix: {
      program: 'external',
      argv: () => ['npm', 'install', '-D', `@inventarch/cli@${VERSION}`],
      flow: 'confirm',
      writesTo: 'repo',
      display: 'remedy',
    },
  },
  // The manifest is the workspace's ancestor: the remedy keeps its text, and the fix names that directory.
  {
    fixture: 'ancestor',
    id: 'cli-version',
    fix: {
      program: 'external',
      argv: (name) => ['npm', 'install', '--prefix', fixtures.get(name)!.repo!],
      flow: 'confirm',
      writesTo: 'repo',
      display: (name) => `npm install --prefix ${quote(fixtures.get(name)!.repo!)}`,
    },
  },
  // No host registered: the detail offers two commands, so the row is advice.
  { fixture: 'clean', id: 'host', fix: null },
];

it('each listed row carries the expected fix, and displays as its remedy or as its own text', () => {
  for (const row of EXPECTED) {
    const check = checkOf(row.fixture, row.id);
    expect(check, `${row.fixture} ${row.id}`).toBeDefined();
    if (row.fix === null) {
      expect(check!.fix, `${row.fixture} ${row.id}`).toBeNull();
      continue;
    }
    expect(check!.fix ?? null, `${row.fixture} ${row.id}`).not.toBeNull();
    const fix = check!.fix!;
    expect(fix, `${row.fixture} ${row.id}`).toEqual({
      program: row.fix.program,
      argv: row.fix.argv(row.fixture),
      flow: row.fix.flow,
      writesTo: row.fix.writesTo,
    });
    if (row.fix.display === 'remedy') expect(displayFix(fix), `${row.fixture} ${row.id}`).toBe(check!.remedy);
    else expect(displayFix(fix), `${row.fixture} ${row.id}`).toBe(row.fix.display(row.fixture));
  }
  // The ancestor's remedy is today's text exactly.
  expect(checkOf('ancestor', 'cli-version')!.remedy).toBe('npm install');
});

it('every runnable remedy has a fix, whatever its check id', () => {
  const runnable = /^(?:ia|npm|pnpm|yarn|bun) |^In [^:]+: (?:npm|pnpm|yarn|bun) /;
  let seen = 0;
  for (const name of NAMES)
    for (const check of views.get(name)!.checks)
      if (check.remedy !== null && runnable.test(check.remedy) && !check.remedy.includes(', then')) {
        seen += 1;
        expect(check.fix ?? null, `${name} ${check.id}: ${check.remedy}`).not.toBeNull();
      }
  expect(seen).toBeGreaterThan(10);
});

it('advice remedies have no fix', () => {
  const view = collectDoctor({
    cwd: scratch('df-advice'),
    packageRoot: scratch('df-advice-package'),
    runtime: { version: 'v20.0.0', platform: 'linux', arch: 'x64' },
    env: { IA_HOME: resolve(scratch('df-advice-home'), '.ia') },
    home: scratch('df-advice-user'),
    version: VERSION,
    now: new Date('2026-11-03T12:00:00Z'),
    channel: { kind: 'npm', name: '@inventarch/cli', version: VERSION },
  });
  for (const id of ['node', 'vocabulary']) {
    const check = view.checks.find((row) => row.id === id)!;
    expect(check.remedy, id).not.toBeNull();
    expect(check.fix, id).toBeNull();
  }
});

it('a supplied --root reaches both remedy and fix', () => {
  const check = checkOf('pending', 'pending')!;
  expect(check.remedy).toBe(`ia recover installation --root ${quote(rooted('pending'))}`);
  expect(check.fix!.argv).toEqual(['recover', 'installation', '--root', rooted('pending')]);
  // Shell syntax in the root reaches neither.
  const shell = checkOf('shell-root', 'pending')!;
  expect(shell.remedy).toMatch(/^ia recover installation --root \. Run the suggested commands from the workspace root/);
  expect(shell.fix!.argv).not.toContain(realpathSync(fixtures.get('shell-root')!.root));
});

it('--json carries fix on every check and nothing else changes', () => {
  for (const name of NAMES) {
    const view = views.get(name)!;
    const envelope = doctorEnvelope(view) as { checks: Record<string, unknown>[] };
    for (const [index, check] of envelope.checks.entries()) {
      expect(Object.keys(check), `${name} ${String(check['id'])}`).toEqual([
        'id',
        'title',
        'status',
        'detail',
        'remedy',
        'fix',
      ]);
      expect(check['fix']).toEqual(view.checks[index]!.fix);
    }
    // Rows are an open set, so a row added since (kits, marketplace) is checked by its own tests; every row that was
    // there keeps its place, keys and values, and the counts change only by the added rows.
    const before = BEFORE[name] as { checks: { id: string }[]; counts: Record<string, number> };
    const known = new Set(before.checks.map((check) => check.id));
    const now = normalized(withoutFix(view), fixtures.get(name)!) as {
      checks: { id: string; status: string }[];
      counts: Record<string, number>;
    };
    expect({ ...now, checks: now.checks.filter((check) => known.has(check.id)) }, name).toEqual({
      ...before,
      counts: now.counts,
    });
    const added = { ...before.counts };
    for (const check of now.checks) if (!known.has(check.id)) added[check.status] = (added[check.status] ?? 0) + 1;
    expect(now.counts, name).toEqual(added);
  }
});

it("recover's fix is confirm, plugin-claude's is preview-apply writing to user, validate's is immediate writing to none", () => {
  expect(checkOf('pending', 'pending')!.fix).toMatchObject({ flow: 'confirm', writesTo: 'repo' });
  expect(checkOf('none', 'plugin-claude')!.fix).toMatchObject({ flow: 'preview-apply', writesTo: 'user' });
  expect(checkOf('foreign', 'records')!.fix).toMatchObject({ flow: 'immediate', writesTo: 'none' });
});

it('the check with id "host" appears only when no host is registered', () => {
  expect(checkOf('clean', 'host')).toMatchObject({ status: 'info', remedy: null, fix: null });
  expect(checkOf('registered', 'host')).toBeUndefined();
  expect(checkOf('registered', 'host-claude')).toBeDefined();
});

it('the declined row reads the same whatever day the decline is made on', async () => {
  // Made on another day entirely: the fixture still records DECLINED_AT, so the row matches the captured envelope.
  const elsewhere = await fixture('declined', { declineClock: new Date('2027-01-15T09:00:00Z') });
  const row = report(elsewhere).checks.find((check) => check.id === 'workspace-decision')!;
  expect(row).toMatchObject({ detail: 'Declined permanently on 2026-11-03', remedy: 'ia init --forget-decline' });
  expect(row).toEqual(checkOf('declined', 'workspace-decision'));
});

/**
 * Each fixture's `--json` envelope as the code before `fix` produced it, normalized (doctor-fix-fixture.ts): captured
 * once by value, so a change to any existing key or value, a remedy above all, fails here.
 */
const BEFORE: Readonly<Record<FixtureName, unknown>> = {
  none: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'warn',
        detail: 'No .ia/src directory here or in any parent',
        remedy: 'ia init',
      },
      {
        id: 'records',
        title: 'Records',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'workspace-decision',
        title: 'Initialization decision',
        status: 'info',
        detail: 'None recorded',
        remedy: null,
      },
    ],
    counts: {
      ok: 4,
      warn: 1,
      fail: 0,
      unknown: 8,
      info: 4,
    },
  },
  declined: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'warn',
        detail: 'No .ia/src directory here or in any parent',
        remedy: 'ia init',
      },
      {
        id: 'records',
        title: 'Records',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'unknown',
        detail: 'Not checked; no workspace',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'ok',
        detail: '<home>',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'workspace-decision',
        title: 'Initialization decision',
        status: 'info',
        detail: 'Declined permanently on 2026-11-03',
        remedy: 'ia init --forget-decline',
      },
    ],
    counts: {
      ok: 5,
      warn: 1,
      fail: 0,
      unknown: 8,
      info: 3,
    },
  },
  clean: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'ok',
        detail: '<n> records, <n> errors, <n> warnings at revision <hex>',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'info',
        detail: 'No authored mandate declares a move, word or execution-limit restriction.',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'info',
        detail: 'None installed',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host-payload',
        title: 'Host payload',
        status: 'info',
        detail: 'Release <hex>, not materialized; ia host materializes it on apply in <home>/hosts',
        remedy: null,
      },
      {
        id: 'implementations',
        title: 'Implementations',
        status: 'info',
        detail:
          'Release <hex> is not materialized; ia host materializes it, with its installed-implementation catalog, on apply',
        remedy: null,
      },
      {
        id: 'host-lock',
        title: 'Host lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'info',
        detail: 'No host registered; run "ia host claude --root <root>" or "ia host codex --root <root>" to plan one',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 7,
      warn: 0,
      fail: 0,
      unknown: 2,
      info: 12,
    },
  },
  foreign: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'fail',
        detail: '<n> records, <n> errors, <n> warnings at revision <hex>',
        remedy: 'ia validate',
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'info',
        detail: 'No authored mandate declares a move, word or execution-limit restriction.',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'info',
        detail: 'None installed',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host-payload',
        title: 'Host payload',
        status: 'info',
        detail: 'Release <hex>, not materialized; ia host materializes it on apply in <home>/hosts',
        remedy: null,
      },
      {
        id: 'implementations',
        title: 'Implementations',
        status: 'info',
        detail:
          'Release <hex> is not materialized; ia host materializes it, with its installed-implementation catalog, on apply',
        remedy: null,
      },
      {
        id: 'host-lock',
        title: 'Host lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'info',
        detail: 'No host registered; run "ia host claude --root <root>" or "ia host codex --root <root>" to plan one',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 6,
      warn: 0,
      fail: 1,
      unknown: 2,
      info: 12,
    },
  },
  pending: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'fail',
        detail: '.ia/distributions/pending.json exists; an apply was interrupted',
        remedy: 'ia recover installation --root <root>',
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'warn',
        detail: '.ia/distributions/install-lock.json is held by another installer or was left behind',
        remedy: 'ia recover installation --root <root>',
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 5,
      warn: 1,
      fail: 1,
      unknown: 6,
      info: 5,
    },
  },
  generation: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'unknown',
        detail: 'Not checked; IA-DB-SOURCE-UNAVAILABLE',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'unknown',
        detail: 'Not checked; IA-DB-SOURCE-UNAVAILABLE',
        remedy: 'ia position --shape governance --root <root>',
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'unknown',
        detail: 'Not checked; IA-DB-SOURCE-UNAVAILABLE',
        remedy: 'ia recover installation --root <root>',
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'unknown',
        detail: 'Not checked; IA-DB-SOURCE-UNAVAILABLE',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 6,
      warn: 0,
      fail: 0,
      unknown: 6,
      info: 6,
    },
  },
  ancestor: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'ok',
        detail: '<n> records, <n> errors, <n> warnings at revision <hex>',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'info',
        detail: 'No authored mandate declares a move, word or execution-limit restriction.',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'info',
        detail: 'None installed',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host-payload',
        title: 'Host payload',
        status: 'info',
        detail: 'Release <hex>, not materialized; ia host materializes it on apply in <home>/hosts',
        remedy: null,
      },
      {
        id: 'implementations',
        title: 'Implementations',
        status: 'info',
        detail:
          'Release <hex> is not materialized; ia host materializes it, with its installed-implementation catalog, on apply',
        remedy: null,
      },
      {
        id: 'host-lock',
        title: 'Host lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'info',
        detail: 'No host registered; run "ia host claude --root <root>" or "ia host codex --root <root>" to plan one',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'warn',
        detail:
          '<repo>/package.json lists @inventarch/cli <version>, which is not installed between the workspace and it; running <version>',
        remedy: 'npm install',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 7,
      warn: 1,
      fail: 0,
      unknown: 2,
      info: 11,
    },
  },
  'shell-root': {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'fail',
        detail: '.ia/distributions/pending.json exists; an apply was interrupted',
        remedy:
          'ia recover installation --root . Run the suggested commands from the workspace root; its path is omitted because it contains shell syntax.',
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'warn',
        detail: '.ia/distributions/install-lock.json is held by another installer or was left behind',
        remedy:
          'ia recover installation --root . Run the suggested commands from the workspace root; its path is omitted because it contains shell syntax.',
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '0 archives in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'unknown',
        detail: 'Not checked; installation recovery is required first',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'unknown',
        detail: 'Not checked; .ia/release.json is absent',
        remedy: null,
      },
    ],
    counts: {
      ok: 5,
      warn: 1,
      fail: 1,
      unknown: 6,
      info: 5,
    },
  },
  projected: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'ok',
        detail: '<n> records, <n> errors, <n> warnings at revision <hex>',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'info',
        detail: 'No authored mandate declares a move, word or execution-limit restriction.',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'info',
        detail: '<hex>, counter 1',
        remedy: null,
      },
      {
        id: 'registry-inventarch',
        title: 'Registry inventarch',
        status: 'info',
        detail: 'https://api.inventarch.dev/registry/ (from default: built-in default)',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '1 archive in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host-payload',
        title: 'Host payload',
        status: 'info',
        detail: 'Release <hex>, not materialized; ia host materializes it on apply in <home>/hosts',
        remedy: null,
      },
      {
        id: 'implementations',
        title: 'Implementations',
        status: 'info',
        detail:
          'Release <hex> is not materialized; ia host materializes it, with its installed-implementation catalog, on apply',
        remedy: null,
      },
      {
        id: 'host-lock',
        title: 'Host lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'host',
        title: 'Host',
        status: 'info',
        detail: 'No host registered; run "ia host claude --root <root>" or "ia host codex --root <root>" to plan one',
        remedy: null,
      },
      {
        id: 'projection-claude:.claude/rules/ia-workspace.md',
        title: 'Projection claude',
        status: 'warn',
        detail: '.claude/rules/ia-workspace.md missing; the remedy writes it again',
        remedy: 'ia project claude --root <root> --apply',
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'info',
        detail: '<home> (not created yet)',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'ok',
        detail: 'Workspace language <version>; this ia reads <version>',
        remedy: null,
      },
    ],
    counts: {
      ok: 8,
      warn: 1,
      fail: 0,
      unknown: 1,
      info: 13,
    },
  },
  registered: {
    version: 1,
    checks: [
      {
        id: 'node',
        title: 'Node',
        status: 'ok',
        detail: 'v22.<version> on linux x64',
        remedy: null,
      },
      {
        id: 'support-target',
        title: 'Support target',
        status: 'ok',
        detail: 'linux x64 on Node 22 matches the declared target',
        remedy: null,
      },
      {
        id: 'vocabulary',
        title: 'Vocabulary',
        status: 'ok',
        detail: '<n> words, source digest <hex>',
        remedy: null,
      },
      {
        id: 'package-manager',
        title: 'Package manager',
        status: 'info',
        detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
        remedy: null,
      },
      {
        id: 'root',
        title: 'Root',
        status: 'ok',
        detail: '<root>',
        remedy: null,
      },
      {
        id: 'records',
        title: 'Records',
        status: 'ok',
        detail: '<n> records, <n> errors, <n> warnings at revision <hex>',
        remedy: null,
      },
      {
        id: 'source-protection',
        title: 'Source protection',
        status: 'info',
        detail: 'No authored mandate declares a move, word or execution-limit restriction.',
        remedy: null,
      },
      {
        id: 'generation',
        title: 'Generation',
        status: 'info',
        detail: '<hex>, counter 1',
        remedy: null,
      },
      {
        id: 'registry-inventarch',
        title: 'Registry inventarch',
        status: 'info',
        detail: 'https://api.inventarch.dev/registry/ (from default: built-in default)',
        remedy: null,
      },
      {
        id: 'pending',
        title: 'Pending state',
        status: 'ok',
        detail: 'No interrupted transaction',
        remedy: null,
      },
      {
        id: 'install-lock',
        title: 'Install lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'cache',
        title: 'Cache',
        status: 'info',
        detail: '1 archive in .ia/distributions/cache',
        remedy: null,
      },
      {
        id: 'host-payload',
        title: 'Host payload',
        status: 'info',
        detail: 'Release <hex>, present in <home>/hosts',
        remedy: null,
      },
      {
        id: 'implementations',
        title: 'Implementations',
        status: 'ok',
        detail:
          'Catalog <hex> in release <hex> (<version>): captured-source-read-v1 available (handler ia.captured-source.read.v1, shipped bytes <hex>); 0 installed evaluators beside the built-ins; listed, nothing run',
        remedy: null,
      },
      {
        id: 'host-lock',
        title: 'Host lock',
        status: 'info',
        detail: 'Not held',
        remedy: null,
      },
      {
        id: 'host-claude',
        title: 'Host claude',
        status: 'ok',
        detail: 'registered (mcp, projection); written; not observed answering; cache <home>/hosts/<hex>',
        remedy: null,
      },
      {
        id: 'projection-claude:.claude/rules/ia-workspace.md',
        title: 'Projection claude',
        status: 'warn',
        detail: '.claude/rules/ia-workspace.md missing; the remedy writes it again',
        remedy: 'ia host claude --root <root> --apply',
      },
      {
        id: 'join-claude',
        title: 'Join claude',
        status: 'ok',
        detail:
          'present: joined installed-implementations <version> (catalog <hex>, release <hex>) at consumer revision <hex>, the catalog the registered payload carries',
        remedy: null,
      },
      {
        id: 'install-channel',
        title: 'Install channel',
        status: 'ok',
        detail: 'npm package @inventarch/cli <version>',
        remedy: null,
      },
      {
        id: 'cli-version',
        title: 'CLI version',
        status: 'info',
        detail: 'no @inventarch/cli dependency; running <version>',
        remedy: 'npm install -D @inventarch/cli@3.5.1',
      },
      {
        id: 'ia-home',
        title: 'IA home',
        status: 'ok',
        detail: '<home>',
        remedy: null,
      },
      {
        id: 'plugin-claude',
        title: 'Claude plugin',
        status: 'info',
        detail: 'Not installed',
        remedy: 'ia host claude --user --apply',
      },
      {
        id: 'updates',
        title: 'Updates',
        status: 'unknown',
        detail: 'Not checked yet; a check runs in the background',
        remedy: null,
      },
      {
        id: 'compatibility',
        title: 'Compatibility',
        status: 'ok',
        detail: 'Workspace language <version>; this ia reads <version>',
        remedy: null,
      },
    ],
    counts: {
      ok: 12,
      warn: 1,
      fail: 0,
      unknown: 1,
      info: 10,
    },
  },
};
