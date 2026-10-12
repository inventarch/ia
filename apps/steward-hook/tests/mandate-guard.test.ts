/**
 * Milestone generation-binding plan amendments C9 and C10, operator decision OD4: the guard re-keyed to `@mandate`. A
 * registration for one authored `@hook` runs `guard --root <root> --hook <identity>` for every edit tool; the hook decides
 * an edit only when its paths select the file and its tools name the tool, and the edit proceeds only when the acting
 * `@agent` holds a governing mandate that grants Synthesis there. The workspace is the conformance corpus with apps/cli's
 * composition fixture laid over it, so its `.ia/src` holds the fixture's `@hook note-edits` (PreToolUse
 * Write|Edit|MultiEdit over `docs/**` and `restricted/**`), `docs-mandate` (the demo participant, Synthesis, covers
 * `docs/`), `reviewer-docs` (the reviewer, Observation, covers `restricted/`), `demo-mandate` (the demo participant,
 * every move, scoped to the demo workspace, whose steward it is) and the `reviewer` `@agent-profile`. The corpus adds its
 * own `sample-mandate` (agent-steward; Observation, Verification; covers `docs/**`) and `agent-steward-profile`. Every
 * path a hook selects is in the demo workspace, so demo-mandate governs it (C1 with the workspace).
 */
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { open, readInputs } from '@inventarch/db';
import { Door, HOOK_CODES } from '@inventarch/runtime';
import { digestValue } from '@inventarch/runtime/authoring';
import { runBounded } from '@tools/testing/subprocess.js';
import { evaluateHook, evaluateMandateHook, printable, runHook, streamed } from '../src/main.js';
import type { HookOutput } from '../src/main.js';

// Every decision opens the disk-backed workspace.
vi.setConfig({ testTimeout: 60_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  NATIVE = resolve(repository, 'examples/conformance/native'),
  FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
  HOOKS = readFileSync(resolve(FIXTURE, 'hooks.ia'), 'utf8'),
  WORKSPACE = readFileSync(resolve(FIXTURE, 'workspace.ia'), 'utf8'),
  HOOK = 'hook-authoring-system/binding/hook/note-edits',
  DEMO = 'workspace-system/definition/workspace/demo',
  MESSAGE = "Use the participant's documentation mandate.",
  SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 20_000;
const mandate = (name: string): string => `agent-system/policy/mandate/${name}`,
  governance = (name: string): string => `ia position --seat ${mandate(name)} --shape governance`;
/** The fixture's reviewer as a subagent: OD4's subagent carries `agent_id`. */
const reviewer = { agent_id: 'subagent-1', agent_type: 'reviewer' },
  stranger = { agent_id: 'subagent-3', agent_type: 'stranger' };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-mandate-guard-') || path.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
/** The workspace, with `overlay` replacing (or, null, deleting) files under its root. */
function workspace(overlay: Readonly<Record<string, string | null>> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-'));
  roots.push(root);
  cpSync(NATIVE, resolve(root, '.ia/src'), { recursive: true });
  cpSync(FIXTURE, resolve(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(overlay))
    if (text === null) rmSync(resolve(root, path));
    else put(root, path, text);
  return root;
}
const event = (root: string, path: string, extra: Record<string, unknown> = {}, tool = 'Write') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: { file_path: resolve(root, path), content: 'x', ...(tool === 'MultiEdit' ? { edits: [] } : {}) },
  ...extra,
});
const check = (root: string, path: string, extra: Record<string, unknown> = {}, tool = 'Write', hook = HOOK) =>
  evaluateMandateHook(root, hook, event(root, path, extra, tool));
const reason = (output: HookOutput): string | undefined => output.hookSpecificOutput?.permissionDecisionReason;
const code = (output: HookOutput): string | undefined => reason(output)?.split(':')[0];
/** `text` with each `from` replaced by its `to`, every one of which must be there. */
const edited = (text: string, edits: readonly (readonly [string, string])[]): string =>
  edits.reduce((result, [from, to]) => {
    if (!result.includes(from)) throw new Error(`fixture lacks ${from}`);
    return result.replace(from, to);
  }, text);
/** The fixture's hooks.ia, and its workspace.ia, with the edits applied. */
const hooks = (...edits: readonly (readonly [string, string])[]): string => edited(HOOKS, edits);
const starter = (...edits: readonly (readonly [string, string])[]): string => edited(WORKSPACE, edits);
/** demo-mandate allowed only to observe: the demo participant then authors only where another mandate grants it. */
const OBSERVING = starter([
  'moves [Observation, Verification, Synthesis, Delegation, Execution]',
  'moves [Observation]',
]);
const authorized = (name: string, authority: readonly string[]): string =>
  `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may it do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;

it('allows the main session where its mandate grants Synthesis, a session launched with --agent included (OD4)', () => {
  const root = workspace();
  expect(check(root, 'docs/guide.md')).toEqual({});
  // A main session launched with --agent carries agent_type but no agent_id: still the main session, the demo steward.
  expect(check(root, 'docs/guide.md', { agent_type: 'reviewer' })).toEqual({});
  expect(check(root, 'docs/deep/new.md', { agent_type: 'stranger' }, 'Edit')).toEqual({});
  expect(check(root, 'docs/guide.md', {}, 'MultiEdit')).toEqual({});
  // demo-mandate is scoped to the workspace, so it governs every path the hook selects there (C1 with the workspace).
  expect(check(root, 'restricted/plan.md')).toEqual({});
});

it("denies an actor outside the governing mandates with the hook's message and the first one's governance position", () => {
  const root = workspace();
  // The reviewer subagent acts as the reviewer @agent, which neither demo-mandate nor docs-mandate binds.
  const denied = check(root, 'docs/guide.md', reviewer);
  expect(code(denied)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(denied)).toContain(MESSAGE);
  expect(reason(denied)).toContain('subagent reviewer acts as agent-system/binding/agent/reviewer');
  expect(reason(denied)).toContain(`Next: ${governance('demo-mandate')}`);
  expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  // The reviewer's own mandate under restricted/ grants Observation only.
  const observation = check(root, 'restricted/plan.md', reviewer);
  expect(code(observation)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(observation)).toContain('reviewer-docs allows Observation; author needs Synthesis');
  // With demo-mandate observing only, the main session authors under docs/ (docs-mandate) and not under restricted/.
  const observing = workspace({ '.ia/src/workspace.ia': OBSERVING });
  expect(check(observing, 'docs/guide.md')).toEqual({});
  const main = check(observing, 'restricted/plan.md');
  expect(code(main)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(main)).toContain('the main session acts as agent-system/binding/agent/demo');
  expect(reason(main)).toContain('demo-mandate allows Observation; author needs Synthesis');
  expect(reason(main)).toContain(`Next: ${governance('demo-mandate')}`);
});

it("lets a subagent act as its profile's composition.agent, and refuses an unknown subagent at every selected path", () => {
  const root = workspace({ '.ia/src/hooks.ia': hooks(['moves [Observation]', 'moves [Observation, Synthesis]']) });
  expect(check(root, 'restricted/plan.md', reviewer)).toEqual({});
  // The corpus's agent-steward-profile acts as agent-steward, which sample-mandate binds without Synthesis.
  const steward = check(root, 'docs/guide.md', { agent_id: 'subagent-2', agent_type: 'agent-steward-profile' });
  expect(code(steward)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(steward)).toContain('acts as agent-system/binding/agent/agent-steward');
  expect(reason(steward)).toContain(`Next: ${governance('sample-mandate')}`);
  // A subagent no authored profile names, one with no agent_type, and a malformed agent_id are not established.
  for (const extra of [
    stranger,
    { agent_id: 'subagent-4' },
    { agent_id: '', agent_type: 'reviewer' },
    { agent_id: 7, agent_type: 'reviewer' },
    // A profile name is matched exactly, as the generated agent file names it.
    { agent_id: 'subagent-5', agent_type: 'Reviewer' },
  ]) {
    const unknown = check(root, 'docs/guide.md', extra);
    expect(code(unknown), JSON.stringify(extra)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
    expect(reason(unknown)).toContain(MESSAGE);
    expect(reason(unknown)).toContain(`Next: ${governance('demo-mandate')}`);
  }
});

it('allows any actor where the hook selects nothing; where nothing governs, allows an established actor and refuses an unknown subagent', () => {
  // demo-mandate covers docs/ instead of being scoped to the workspace: nothing governs open/.
  const root = workspace({
    '.ia/src/hooks.ia': hooks(['"restricted/**"]', '"restricted/**", "open/**"]']),
    '.ia/src/workspace.ia': starter(['    scope [@workspace demo]\n', '    covers ["docs/"]\n']),
  });
  for (const extra of [{}, reviewer, stranger]) {
    expect(check(root, 'src/app.ts', extra), JSON.stringify(extra)).toEqual({});
    expect(check(root, 'README.md', extra, 'Edit'), JSON.stringify(extra)).toEqual({});
  }
  // open/** is selected and no mandate governs it: a mandate only adds restrictions, so an established actor may write,
  // but an unknown subagent is refused at any path the hook selects (G-R1).
  expect(check(root, 'open/notes.md')).toEqual({});
  expect(check(root, 'open/notes.md', reviewer)).toEqual({});
  const unknown = check(root, 'open/notes.md', stranger);
  expect(code(unknown)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(reason(unknown)).toContain(`Next: ia position --seat ${DEMO} --shape governance`);
});

it('refuses the main session with no default actor or an ambiguous one wherever a mandate governs (G-R5)', () => {
  // No composition.steward and no participant scoped to the workspace: the main session has no default actor, and the
  // mandates that govern docs/ name participants it cannot be.
  const none = workspace({
    '.ia/src/workspace.ia': starter(
      ['    steward @agent demo\n', ''],
      ['    scope [@workspace demo]\n', '    covers ["docs/"]\n'],
    ),
  });
  const actorless = check(none, 'docs/guide.md');
  expect(code(actorless)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(reason(actorless)).toContain('the main session has no default actor');
  expect(reason(actorless)).toContain(`Next: ${governance('demo-mandate')}`);
  // No steward and two participants scoped to the workspace: the choice is open, and the refusal names the workspace's
  // governance position, where a steward is named.
  const two = workspace({
    '.ia/src/workspace.ia':
      starter(['    steward @agent demo\n', '']) +
      authorized('reviewer-mandate', ['participant @agent reviewer', 'moves [Synthesis]', 'scope [@workspace demo]']),
  });
  const ambiguous = check(two, 'docs/guide.md');
  expect(code(ambiguous)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(reason(ambiguous)).toContain('2 participants');
  expect(reason(ambiguous)).toContain(`Next: ia position --seat ${DEMO} --shape governance`);
  // The main session's refusal also names the shell command that lifts every hook (G-N1); a subagent's does not.
  expect(reason(ambiguous)).toContain(`ia host claude --root ${JSON.stringify(two)} --remove --apply --yes`);
  expect(reason(check(none, 'docs/guide.md', stranger))).not.toContain('--remove --apply');
  // The reviewer subagent is established all the same, and reviewer-mandate grants it docs/.
  expect(check(two, 'docs/guide.md', reviewer)).toEqual({});
});

/**
 * The workspace with the conformance corpus adopted at band 90 through `.ia/workspace.json`, as an installed base is,
 * rather than copied under `.ia/src`: its agents are then installed `@agent` records, and only the fixture's sources,
 * with `overlay` applied, are authored.
 */
function installedBase(overlay: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-')),
    vendor = 'vendor/foundation';
  roots.push(root);
  cpSync(NATIVE, resolve(root, vendor, '.ia/src'), { recursive: true });
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((source) => !source.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision: digestValue(pinned) }] }),
  );
  cpSync(FIXTURE, resolve(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(overlay)) put(root, path, text);
  return root;
}

it('judges the main session as the one authored participant when the steward is an installed agent (review C2-R1)', () => {
  // The installed corpus's work-steward as composition.steward: runtime defaultActor counts only an authored steward,
  // so the choice falls to the authored participants, as the CLI's mandate profile reads it.
  const installed = 'agent-system/binding/agent/work-steward',
    INSTALLED = ['    steward @agent demo\n', '    steward @agent work-steward\n'] as const;
  // demo-mandate observes only, so the Synthesis docs/ needs is docs-mandate's: it covers the hook's path for demo.
  const root = installedBase({ '.ia/src/workspace.ia': edited(OBSERVING, [INSTALLED]) });
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(db.records().find((record) => record.identity === installed)?.band).toBe(90);
  } finally {
    db.close();
  }
  expect(check(root, 'docs/guide.md')).toEqual({});
  expect(check(root, 'docs/guide.md', {}, 'Edit')).toEqual({});
  // Under restricted/ only demo-mandate grants demo anything, and it observes only: the refusal names demo as the actor.
  const restricted = check(root, 'restricted/plan.md');
  expect(code(restricted)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(restricted)).toContain('the main session acts as agent-system/binding/agent/demo;');
  // Two authored participants and that installed steward: the choice is open, and the refusal names the workspace's
  // governance position, where a steward is named.
  const two = installedBase({
    '.ia/src/workspace.ia':
      edited(OBSERVING, [INSTALLED]) +
      authorized('reviewer-mandate', ['participant @agent reviewer', 'moves [Synthesis]', 'scope [@workspace demo]']),
  });
  const ambiguous = check(two, 'docs/guide.md');
  expect(code(ambiguous)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(reason(ambiguous)).toContain(`${DEMO}'s composition.steward ${installed} is no authored @agent`);
  expect(reason(ambiguous)).toContain('2 participants');
  expect(reason(ambiguous)).toContain(`Next: ia position --seat ${DEMO} --shape governance`);
});

it('lets every established actor author where a governing mandate naming no participant grants Synthesis (G-N6)', () => {
  // C1's `binds`: a mandate that names no participant binds every actor. demo-mandate observes only, so only the
  // participant-less mandate can grant restricted/; an unknown subagent is still not established.
  const root = workspace({
    '.ia/src/workspace.ia': OBSERVING + authorized('open-restricted', ['moves [Synthesis]', 'covers ["restricted/"]']),
  });
  expect(check(root, 'restricted/plan.md')).toEqual({});
  expect(check(root, 'restricted/plan.md', reviewer)).toEqual({});
  expect(code(check(root, 'restricted/plan.md', stranger))).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
});

it('decides each hook independently, each by its own message, its tools applying only to its paths (G-R2)', () => {
  const second =
    '\n@hook write-only\n  meaning\n    says "Guard documentation writes."\n    answers "Who may write documentation?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ["docs/**"]\n    message "Second hook: writes need the documentation mandate."\n';
  const root = workspace({ '.ia/src/hooks.ia': HOOKS + second }),
    other = 'hook-authoring-system/binding/hook/write-only';
  expect(reason(check(root, 'docs/guide.md', reviewer, 'Write'))).toContain(MESSAGE);
  expect(reason(check(root, 'docs/guide.md', reviewer, 'Write', other))).toContain(
    'Second hook: writes need the documentation mandate.',
  );
  // write-only does not select an Edit of docs/; note-edits does.
  expect(check(root, 'docs/guide.md', reviewer, 'Edit', other)).toEqual({});
  expect(code(check(root, 'docs/guide.md', reviewer, 'Edit'))).toBe('IA-HOOK-NOT-MANDATED');
  expect(check(root, 'docs/guide.md', {}, 'Write', other)).toEqual({});
  // The managed state is decided for every edit tool whatever the hook names: once the hook groups are owned, an Edit
  // of the settings that hold them is refused under the Write-only hook too.
  put(
    root,
    '.ia/distributions/hosts/claude-hooks-workspace.json',
    JSON.stringify({
      format: 'ia.hook-registration-state.v1',
      id: 'workspace',
      cache: resolve(root, '..', 'cache'),
      release: 'a'.repeat(64),
      created: true,
      groups: [],
    }),
  );
  for (const tool of ['Write', 'Edit', 'MultiEdit'])
    for (const path of ['.claude/settings.local.json', '.claude/settings.json', '.ia/distributions/hosts/x.json'])
      expect(code(check(root, path, reviewer, tool, other)), `${tool} ${path}`).toBe('IA-HOOK-PROJECTION-MANAGED');
});

it('decides only what the hook selects: governing records are guarded by selecting them, and the managed state always (C10)', () => {
  // C10 as accepted: a hook decides only the paths it selects. Without `.ia/src/**` in its paths, an edit of the hook's
  // own record is no edit it decides; a hook that selects `.ia/src/**` guards the workspace's governing records.
  const plain = workspace();
  expect(check(plain, '.ia/src/hooks.ia', reviewer, 'Edit')).toEqual({});
  const guarded = workspace({ '.ia/src/hooks.ia': hooks(['"restricted/**"]', '"restricted/**", ".ia/src/**"]']) });
  expect(check(guarded, '.ia/src/hooks.ia', {}, 'Edit')).toEqual({});
  for (const path of ['.ia/src/hooks.ia', '.ia/src/workspace.ia', '.ia/src/evil.ia']) {
    const denied = check(guarded, path, reviewer, 'Edit');
    expect(code(denied), path).toBe('IA-HOOK-NOT-MANDATED');
    expect(reason(denied), path).toContain(`Next: ${governance('demo-mandate')}`);
  }
  expect(code(check(guarded, '.ia/src/hooks.ia', stranger))).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  // The installation state is managed for every actor and tool; the settings only once a registration owns them.
  expect(code(check(plain, '.ia/distributions.lock.json'))).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(check(plain, '.claude/settings.local.json')).toEqual({});
  // The retired steward rule is not restored: a system folder is decided like any other path a hook selects.
  expect(check(plain, '.ia/src/systems/agent-system/records/new.ia', reviewer)).toEqual({});
  expect(check(guarded, '.ia/src/systems/agent-system/records/new.ia')).toEqual({});
  expect(code(check(guarded, '.ia/src/systems/agent-system/records/new.ia', reviewer))).toBe('IA-HOOK-NOT-MANDATED');
});

it('folds path case where the volume folds names, for hook.paths and authority.covers alike', () => {
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  // Authored in another case than the edit: `Docs/**` selects `DOCS/x.md` exactly where the volume opens the two as one
  // file; elsewhere `DOCS/x.md` is another path the hook does not select.
  const root = workspace({ '.ia/src/hooks.ia': hooks(['"docs/**"', '"Docs/**"']) });
  expect(code(check(root, 'DOCS/x.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  expect(check(root, 'DOCS/x.md')).toEqual({});
  expect(code(check(root, 'docs/x.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  // `Docs/` covers `docs/x.md` only where names fold: with demo-mandate observing, the demo participant authors there
  // through docs-mandate where names fold, and elsewhere only demo-mandate and sample-mandate govern it.
  const covers = workspace({
    '.ia/src/hooks.ia': hooks(['covers ["docs/"]', 'covers ["Docs/"]']),
    '.ia/src/workspace.ia': OBSERVING,
  });
  expect(code(check(covers, 'docs/x.md'))).toBe(folds ? undefined : 'IA-HOOK-NOT-MANDATED');
  expect(check(covers, 'DOCS/x.md')).toEqual({});
});

it('decides a typed path by its on-disk name: a case variant is the same path, and an 8.3 alias is refused, never matched', () => {
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  const root = workspace({
    'docs/secret.md': 'x\n',
    'restricted/plan.md': 'x\n',
    'src/longdirectory/app.ts': 'x\n',
  });
  // Where the volume folds names, another case of an existing folder resolves to it: the hook selects it and the
  // mandates of the path govern, so the reviewer is refused and the demo participant allowed, as under docs/.
  for (const path of ['Docs/secret.md', 'DOCS/secret.md', 'DOCS/new/deep.md']) {
    expect(code(check(root, path, reviewer)), path).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
    expect(check(root, path), path).toEqual({});
  }
  expect(code(check(root, 'Restricted/plan.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  // A Windows 8.3 short name spells an existing folder another way than by case: the on-disk name is selected, and the
  // typed spelling is refused as an alias rather than matched or decided. Where the volume keeps no short names, there
  // is no such spelling to test.
  const short = (name: string): boolean => process.platform === 'win32' && existsSync(resolve(root, name));
  if (short('RESTRI~1'))
    for (const extra of [{}, reviewer])
      expect(code(check(root, 'RESTRI~1/plan.md', extra)), JSON.stringify(extra)).toBe('IA-HOOK-PATH-UNSAFE');
  // A short name of a folder the hook does not select is no edit it decides.
  if (short('src/LONGDI~1')) expect(check(root, 'src/LONGDI~1/app.ts', reviewer)).toEqual({});
});

it('matches selections in the G06c dialect, where !, [ and shell metacharacters are literal', () => {
  const root = workspace({
    '.ia/src/hooks.ia': hooks(['"restricted/**"]', '"restricted/**", "[ab]/**", "!x/**", "$(id)/**"]']),
  });
  for (const path of ['[ab]/f.md', '!x/f.md', '$(id)/f.md'])
    expect(code(check(root, path, reviewer)), path).toBe('IA-HOOK-NOT-MANDATED');
  // Not a character class, not a negation, not a substitution: none of these is selected.
  for (const path of ['a/f.md', 'b/f.md', 'x/f.md', 'y/f.md', 'id/f.md'])
    expect(check(root, path, reviewer), path).toEqual({});
});

it('refuses malformed input, unsafe paths and an unreadable declaration or mandate with registered codes', () => {
  const root = workspace(),
    args = ['--root', root, '--hook', HOOK],
    valid = JSON.stringify(event(root, 'docs/guide.md', reviewer));
  const codes = new Set<string>(HOOK_CODES);
  const refused = (output: HookOutput): string => {
    const found = code(output)!;
    expect(codes.has(found), found).toBe(true);
    return found;
  };
  expect(refused(runHook(args, '{'))).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, '{}'))).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, JSON.stringify({ ...event(root, 'docs/x.md'), tool_name: 'Bash' })))).toBe(
    'IA-HOOK-INPUT-INVALID',
  );
  for (const bad of [
    ['--root', root, '--hook'],
    ['--root', root, '--hook', ''],
    ['--root', root, '--hook', 'Note Edits'],
    ['--root', root, '--hook', 'hook-authoring-system/binding/hook/note-edits/extra'],
    ['--root', root, '--hook', HOOK, '--actors', resolve(root, 'actors.json')],
    ['--hook', HOOK, '--root', root],
  ])
    expect(refused(runHook(bad, valid)), bad.join(' ')).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, ' '.repeat(1024 * 1024 + 1)))).toBe('IA-HOOK-INPUT-INVALID');
  // A relative path needs a cwd inside the fixed root; a root that is not absolute is unusable.
  expect(
    refused(evaluateMandateHook(root, HOOK, { ...event(root, 'x'), tool_input: { file_path: 'docs/guide.md' } })),
  ).toBe('IA-HOOK-PATH-UNSAFE');
  expect(refused(evaluateMandateHook('relative-root', HOOK, event(root, 'docs/guide.md')))).toBe('IA-HOOK-PATH-UNSAFE');
  // A selected path reached through a link or junction, either way round, is refused rather than decided.
  const outside = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-'));
  roots.push(outside);
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  symlinkSync(resolve(root, 'docs'), resolve(root, 'notes'), 'junction');
  symlinkSync(outside, resolve(root, 'docs/linked'), 'junction');
  expect(refused(check(root, 'notes/guide.md'))).toBe('IA-HOOK-PATH-UNSAFE');
  expect(refused(check(root, 'docs/linked/guide.md'))).toBe('IA-HOOK-PATH-UNSAFE');
  // A registration whose hook is not admitted, or not a declaration the guard can decide, cannot know what it selects:
  // it refuses every edit it receives, naming the re-registration.
  for (const path of ['docs/guide.md', 'src/app.ts']) {
    const absent = check(root, path, {}, 'Write', 'hook-authoring-system/binding/hook/absent');
    expect(refused(absent)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
    expect(reason(absent)).toContain(`ia host claude --root ${JSON.stringify(root)} --apply --yes`);
    expect(reason(absent)).toContain(`ia host claude --root ${JSON.stringify(root)} --remove --apply --yes`);
  }
  const stop = workspace({ '.ia/src/hooks.ia': hooks(['event PreToolUse', 'event Stop']) });
  expect(refused(check(stop, 'src/app.ts'))).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
  const empty = workspace({ '.ia/src/hooks.ia': hooks(['["docs/**", "restricted/**"]', '[]']) });
  expect(reason(check(empty, 'docs/guide.md'))).toContain('selects no path');
  // A governing mandate whose authority cannot be read refuses the edit it governs, and only that edit.
  const malformed = workspace({ '.ia/src/hooks.ia': hooks(['moves [Synthesis]', 'moves []']) });
  expect(refused(check(malformed, 'docs/guide.md'))).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(check(malformed, 'src/app.ts')).toEqual({});
});

it('prints the authored message without terminal escapes, controls or bidirectional overrides', () => {
  expect(printable('a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u202ec\u2066d\u0085e\u2028f\ng\u0000h')).toBe(
    'aredb c d e f g h',
  );
  const root = workspace({
    '.ia/src/hooks.ia': hooks([`"${MESSAGE}"`, '"Use \u001b[31mthe\u202e mandate\u2028 $(rm -rf ~)."']),
  });
  const denied = reason(check(root, 'docs/guide.md', reviewer))!;
  expect(denied).toContain('Use the  mandate  $(rm -rf ~).');
  expect(denied).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2028\u2066-\u2069]/);
});

it('runs from the built entry with --hook, as the launcher passes its guard arguments through', async () => {
  const root = workspace();
  const run = async (extra: Record<string, unknown>) => {
    const result = await runBounded(
      process.execPath,
      [resolve(repository, 'apps/steward-hook/dist/main.js'), '--root', root, '--hook', HOOK],
      { input: JSON.stringify(event(root, 'docs/guide.md', extra)), timeoutMs: SUBPROCESS },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as HookOutput;
  };
  expect(await run({})).toEqual({});
  expect(code(await run(reviewer))).toBe('IA-HOOK-NOT-MANDATED');
});

it('refuses a win32 path that names an alternate data stream, in both modes, before any rule or selection reads it (G-R3)', () => {
  // A `:` after the drive designator names a stream (or a drive-relative path): the write lands on the file without
  // it, which the typed spelling does not name.
  expect(streamed('C:\\w\\docs\\x.md')).toBe(false);
  expect(streamed('\\\\?\\C:\\w\\docs\\x.md')).toBe(false);
  expect(streamed('docs/x.md')).toBe(false);
  for (const path of ['C:\\w\\docs\\x.md::$DATA', 'C:\\w\\docs\\x.md:s', 'docs/x.md:s', '\\\\?\\C:\\w\\x.md::$DATA'])
    expect(streamed(path), path).toBe(true);
  if (process.platform !== 'win32') return;
  const root = workspace();
  for (const path of ['docs/guide.md::$DATA', 'docs/guide.md:hidden', '.claude/settings.json::$DATA', 'src/app.ts:s']) {
    for (const extra of [{}, reviewer])
      expect(code(check(root, path, extra)), `${path} ${JSON.stringify(extra)}`).toBe('IA-HOOK-PATH-UNSAFE');
    expect(code(evaluateHook(root, event(root, path))), path).toBe('IA-HOOK-PATH-UNSAFE');
  }
});

it('refuses no more than the last registered selection of a hook whose record is gone, naming commands that restore editing (G-N4, G-R7)', () => {
  // The record of the hook the registration names is renamed: the declaration cannot be read.
  const root = workspace({
    '.ia/src/hooks.ia': hooks(
      ['@hook note-edits', '@hook other-edits'],
      ['target @hook note-edits', 'target @hook other-edits'],
    ),
  });
  const commands = [
    `ia host claude --root ${JSON.stringify(root)} --apply --yes`,
    `ia host claude --root ${JSON.stringify(root)} --remove --apply --yes`,
  ];
  // No ownership state records a selection: every edit under the root is refused, each naming both commands.
  for (const path of ['docs/guide.md', 'src/app.ts', '.ia/src/hooks.ia']) {
    const refused = check(root, path, {}, 'Edit');
    expect(code(refused), path).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
    expect(reason(refused), path).toContain('every edit under the root is refused');
    for (const command of commands) expect(reason(refused), path).toContain(command);
  }
  // An edit outside the root is no edit this guard decides.
  expect(evaluateMandateHook(root, HOOK, event(root, resolve(root, '..', 'elsewhere.md')))).toEqual({});
  // The registration recorded the hook's selection: only an edit under it is refused, so the record can be repaired.
  put(
    root,
    '.ia/distributions/hosts/claude-hooks-workspace.json',
    JSON.stringify({
      format: 'ia.hook-registration-state.v1',
      id: 'workspace',
      cache: resolve(root, '..', 'cache'),
      release: 'a'.repeat(64),
      created: true,
      groups: [
        { hook: HOOK, group: { matcher: 'Write|Edit|MultiEdit', hooks: [] }, paths: ['docs/**', 'restricted/**'] },
      ],
    }),
  );
  for (const path of ['src/app.ts', '.ia/src/hooks.ia']) expect(check(root, path, {}, 'Edit'), path).toEqual({});
  for (const extra of [{}, reviewer]) {
    const refused = check(root, 'docs/guide.md', extra);
    expect(code(refused)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
    expect(reason(refused)).toContain('this edit is under its last registered selection');
    for (const command of commands) expect(reason(refused)).toContain(command);
  }
  // An unreadable state is no selection: refused under the root again, naming the state repair the removal itself
  // would need, then the removal (A-F3).
  put(root, '.ia/distributions/hosts/claude-hooks-workspace.json', '{ not json');
  const unreadable = check(root, 'src/app.ts');
  expect(code(unreadable)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
  expect(reason(unreadable)).toContain(
    'the hook ownership state .ia/distributions/hosts/claude-hooks-workspace.json cannot be read, so every edit under the root is refused; from a shell, delete .ia/distributions/hosts/claude-hooks-workspace.json and every IA hook group in .claude/settings.local.json',
  );
  expect(reason(unreadable)).toContain(`"ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`);
});

it('refuses a file with more than one link, whose other name a hook may select, and protects the launcher a registration runs (G-N3, G-N5)', () => {
  const root = workspace({ 'docs/guide.md': 'guarded\n', 'notes/plain.md': 'plain\n' });
  linkSync(resolve(root, 'docs/guide.md'), resolve(root, 'notes/alias.md'));
  for (const extra of [{}, reviewer]) {
    expect(code(check(root, 'notes/alias.md', extra, 'Edit')), JSON.stringify(extra)).toBe('IA-HOOK-PATH-UNSAFE');
    expect(code(check(root, 'docs/guide.md', extra, 'Edit')), JSON.stringify(extra)).toBe('IA-HOOK-PATH-UNSAFE');
  }
  expect(check(root, 'notes/plain.md', reviewer, 'Edit')).toEqual({});
  // The cache launcher the hook ownership state names is managed, wherever it lies, for every tool.
  const cache = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-'));
  roots.push(cache);
  put(cache, 'scripts/ia.mjs', '// launcher\n');
  put(
    root,
    '.ia/distributions/hosts/claude-hooks-workspace.json',
    JSON.stringify({
      format: 'ia.hook-registration-state.v1',
      id: 'workspace',
      cache,
      release: 'a'.repeat(64),
      created: true,
      groups: [{ hook: HOOK, group: { matcher: 'Write|Edit|MultiEdit', hooks: [] }, paths: ['docs/**'] }],
    }),
  );
  for (const tool of ['Write', 'Edit'])
    expect(code(evaluateMandateHook(root, HOOK, event(root, resolve(cache, 'scripts/ia.mjs'), reviewer, tool)))).toBe(
      'IA-HOOK-PROJECTION-MANAGED',
    );
});

/** A hook ownership state recording each `[hook, paths]` group's selection, in the order given. */
const ownership = (root: string, groups: readonly (readonly [string, readonly string[]])[]): void =>
  put(
    root,
    '.ia/distributions/hosts/claude-hooks-workspace.json',
    JSON.stringify({
      format: 'ia.hook-registration-state.v1',
      id: 'workspace',
      cache: resolve(root, '..', 'cache'),
      release: 'a'.repeat(64),
      created: true,
      groups: groups.map(([hook, paths]) => ({ hook, group: { matcher: 'Write|Edit|MultiEdit', hooks: [] }, paths })),
    }),
  );

it('denies every selected edit while an authored @mandate fails admission, naming it and a report that runs (lane D, D4)', () => {
  // The probe: demo-mandate states an unknown move and excludes task, so admission refuses it and it governs nothing.
  const root = workspace({
    '.ia/src/workspace.ia': starter([
      'moves [Observation, Verification, Synthesis, Delegation, Execution]',
      'moves [Bogus]\n    excluded-words [task]',
    ]),
  });
  const report = `Next: ia report --root ${JSON.stringify(root)}`,
    lift = `"ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`;
  for (const [path, extra] of [
    ['docs/guide.md', {}],
    ['restricted/plan.md', {}],
    ['docs/guide.md', reviewer],
    ['docs/guide.md', stranger],
  ] as const) {
    const denied = check(root, path, extra);
    expect(code(denied), path).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
    expect(reason(denied), path).toContain(MESSAGE);
    expect(reason(denied), path).toContain(
      `${mandate('demo-mandate')} (.ia/src/workspace.ia:19) failed admission: IA-COMP-FIELD-VALUE`,
    );
    expect(reason(denied), path).toContain(report);
    expect(reason(denied), path).not.toContain('ia validate');
    // The main session is named the shell command that lifts every hook; a subagent's denial is the main session's.
    if ('agent_id' in extra) expect(reason(denied), path).not.toContain(lift);
    else expect(reason(denied), path).toContain(lift);
  }
  // Paths the hook does not select are still not decided, broken mandate or not (C10).
  expect(check(root, 'src/app.ts')).toEqual({});
  expect(check(root, 'notes/todo.md', reviewer, 'Edit')).toEqual({});
  // A mandate in a file admission refuses whole fails closed alike; one refused in the installed base never would.
  const whole = workspace({
    '.ia/src/broken.ia': `#! ia 1.0\n${authorized('broken', ['participant @agent demo', 'moves [Observation]'])}   misindented\n`,
  });
  const denied = check(whole, 'docs/guide.md');
  expect(code(denied)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(reason(denied)).toContain(`${mandate('broken')} (.ia/src/broken.ia:3) failed admission: IA-LANG-INDENT-STEP`);
  // The report it names is the version 1 machine route, which the Door serves ungated: it shows the finding.
  const door = new Door(root, { cache: false, allowReport: true, protocol: 1 });
  try {
    const shown = door.request({ operation: 'report', params: {} });
    expect(shown.ok).toBe(true);
    expect(shown.ok && (shown.result as { findings: unknown[] }).findings).toContainEqual(
      expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', path: '.ia/src/workspace.ia', line: 27 }),
    );
  } finally {
    door.close();
  }
});

it('denies every selected edit while a record an admitted @mandate depends on fails admission (lane D, D9)', () => {
  // The D8 probes: demo-mandate observes only, and the hook also selects notes/**, which only the scoped demo-mandate
  // governs. A second participant, ops, may make every move there.
  const hooksWithNotes = hooks(['"restricted/**"]', '"restricted/**", "notes/**"]']);
  const ops = `#! ia 1.0\n${authorized('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification, Synthesis, Delegation, Execution]', 'scope [@workspace demo]'])}\n@agent ops\n  meaning\n    says "A second participant."\n    answers "Who is ops?"\n  governance\n    applies []\n`;
  const broken = (text: string, after: string): string => edited(text, [[after, `${after}  bogus\n    note x\n`]]);
  const report = (root: string): string => `Next: ia report --root ${JSON.stringify(root)}`;
  // Before: the observing default actor is refused under notes/.
  const intact = workspace({
    '.ia/src/workspace.ia': OBSERVING,
    '.ia/src/hooks.ia': hooksWithNotes,
    '.ia/src/ops.ia': ops,
  });
  expect(code(check(intact, 'notes/x.md'))).toBe('IA-HOOK-NOT-MANDATED');
  // The steward participant's @agent fails admission: the default actor would become ops, so every selected edit fails
  // closed at the agent, the mandates that name it named.
  const agent = workspace({
    '.ia/src/workspace.ia': broken(OBSERVING, '    applies []\n'),
    '.ia/src/hooks.ia': hooksWithNotes,
    '.ia/src/ops.ia': ops,
  });
  for (const [path, extra] of [
    ['notes/x.md', {}],
    ['docs/guide.md', {}],
    ['notes/x.md', reviewer],
  ] as const) {
    const denied = check(agent, path, extra);
    expect(code(denied), path).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
    expect(reason(denied), path).toContain('depends on @agent demo through');
    expect(reason(denied), path).toContain(
      'agent-system/binding/agent/demo (.ia/src/workspace.ia:12) failed admission: IA-COMP-SECTION-UNKNOWN',
    );
    expect(reason(denied), path).toContain(report(agent));
  }
  expect(check(agent, 'src/app.ts')).toEqual({});
  // A registration whose hook is not admitted names the admission report too, since ia validate refuses there.
  const absent = reason(check(agent, 'notes/x.md', {}, 'Write', 'hook-authoring-system/binding/hook/absent'));
  expect(absent).toContain(`"ia report --root ${JSON.stringify(agent)}"`);
  expect(absent).not.toContain('ia validate');
  // The workspace demo-mandate is scoped to fails admission: the mandate would govern nowhere.
  const scoped = workspace({
    '.ia/src/workspace.ia': broken(OBSERVING, '    steward @agent demo\n'),
    '.ia/src/hooks.ia': hooksWithNotes,
  });
  for (const extra of [{}, reviewer]) {
    const denied = check(scoped, 'notes/x.md', extra);
    expect(code(denied)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
    expect(reason(denied)).toContain(
      `${mandate('demo-mandate')} depends on @workspace demo through authority.scope, and ${DEMO} (.ia/src/workspace.ia:3) failed admission`,
    );
    expect(reason(denied)).toContain(report(scoped));
  }
});

it('decides as before beside an unrelated refused @agent or a never-authored participant (lane D, D9)', () => {
  const hooksWithNotes = hooks(['"restricted/**"]', '"restricted/**", "notes/**"]']);
  const stray =
    '#! ia 1.0\n\n@agent stray\n  meaning\n    says "x"\n    answers "y"\n  governance\n    applies []\n  bogus\n    note x\n';
  const ghost = `#! ia 1.0\n${authorized('ghost-mandate', ['participant @agent ghost', 'moves [Observation]', 'covers ["notes/"]'])}`;
  const root = workspace({
    '.ia/src/workspace.ia': OBSERVING,
    '.ia/src/hooks.ia': hooksWithNotes,
    '.ia/src/stray.ia': stray,
    '.ia/src/ghost.ia': ghost,
  });
  const db = open(root, { cache: false });
  try {
    expect(db.refused.map((record) => record.identity)).toContain('agent-system/binding/agent/stray');
  } finally {
    db.close();
  }
  const denied = check(root, 'notes/x.md');
  expect(code(denied)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(denied)).toContain(`${mandate('demo-mandate')} allows Observation; author needs Synthesis`);
  expect(check(root, 'docs/guide.md')).toEqual({});
});

it('keeps naming the governance position for an admitted mandate whose authority the resolver cannot read', () => {
  // A child under `authority.moves`: admission admits the record, the resolver refuses the field.
  const root = workspace({ '.ia/src/hooks.ia': hooks(['moves [Synthesis]', 'moves [Synthesis]\n      note x']) });
  const denied = check(root, 'docs/guide.md');
  expect(code(denied)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(reason(denied)).toContain(`${mandate('docs-mandate')}: authority.moves must be an unconditional inline value`);
  expect(reason(denied)).toContain(`Next: ${governance('docs-mandate')}`);
  expect(check(root, 'src/app.ts')).toEqual({});
});

it('refuses no more than the last registered selection when the records cannot open, naming only the removal (H-R8, H-N14)', () => {
  // A descriptor the db cannot read: the workspace's records do not open at all.
  const root = workspace({ '.ia/workspace.json': '{ not json' });
  const removal = `"ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`,
    validate = `"ia validate --root ${JSON.stringify(root)}"`,
    register = `"ia host claude --root ${JSON.stringify(root)} --apply --yes"`;
  // No recorded selection: every edit under the root is refused, naming the commands that work in this state.
  for (const path of ['docs/guide.md', 'src/app.ts']) {
    const refused = check(root, path);
    expect(code(refused), path).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
    expect(reason(refused), path).toContain("The workspace's records cannot be read");
    expect(reason(refused), path).toContain('every edit under the root is refused');
    expect(reason(refused), path).toContain(removal);
    expect(reason(refused), path).toContain(validate);
    expect(reason(refused), path).not.toContain(register);
  }
  // Two recorded groups, this hook's second: only its own selection is refused (mutant H4 took the first group's).
  ownership(root, [
    ['hook-authoring-system/binding/hook/aaa-edits', ['src/**']],
    [HOOK, ['docs/**', 'restricted/**']],
  ]);
  for (const path of ['src/app.ts', '.ia/workspace.json.bak', '.ia/src/hooks.ia'])
    expect(check(root, path, {}, 'Edit'), path).toEqual({});
  const refused = check(root, 'docs/guide.md', reviewer);
  expect(code(refused)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(reason(refused)).toContain('this edit is under its last registered selection');
  expect(reason(refused)).toContain(removal);
});

it('names only the removal when the hook record is gone and the workspace does not admit (H-R2)', () => {
  // A syntax error in hooks.ia: the hook is no admitted record and the workspace does not admit, so re-registering
  // would refuse; the removal and the admission report are the commands that work. The file holds docs-mandate and
  // reviewer-docs too, which admission refuses with it, so `ia validate`, mandate-gated, would refuse (lane D).
  const root = workspace({ '.ia/src/hooks.ia': hooks(['@hook note-edits', '@hook note-edits\n  bogus\nzzz']) });
  ownership(root, [[HOOK, ['docs/**', '.ia/src/**']]]);
  const refused = check(root, '.ia/src/hooks.ia', {}, 'Edit');
  expect(code(refused)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
  expect(reason(refused)).toContain(`"ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`);
  expect(reason(refused)).toContain(`"ia report --root ${JSON.stringify(root)}"`);
  expect(reason(refused)).not.toContain('ia validate');
  expect(reason(refused)).not.toContain(`"ia host claude --root ${JSON.stringify(root)} --apply --yes"`);
  expect(check(root, 'src/app.ts', {}, 'Edit')).toEqual({});
  // A broken hook record in a file with no mandate (the two moved to a file of their own) still names `ia validate`,
  // which runs there.
  const from = HOOKS.indexOf('\n@mandate docs-mandate'),
    to = HOOKS.indexOf('\n@execution-binding notes-hook');
  const plain = workspace({
    '.ia/src/hooks.ia': edited(HOOKS.slice(0, from) + HOOKS.slice(to), [
      ['@hook note-edits', '@hook note-edits\n  bogus\nzzz'],
    ]),
    '.ia/src/mandates.ia': `#! ia 1.0\n${HOOKS.slice(from, to)}`,
  });
  ownership(plain, [[HOOK, ['docs/**', '.ia/src/**']]]);
  const named = reason(check(plain, '.ia/src/hooks.ia', {}, 'Edit'));
  expect(named).toContain(`"ia validate --root ${JSON.stringify(plain)}"`);
  expect(named).not.toContain('ia report');
});
