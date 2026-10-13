/**
 * Milestone generation-binding task host-consumes-generated-set (plan amendments C4, C5, C9, C10 and C12), end to end:
 * an `ia init` workspace with the composition fixture laid over it (C7) gets its packet, its generated agent and skill
 * and its `@hook`'s group through `ia host`, the one projection writer; the group is run through the materialized
 * launcher exactly as Claude Code runs it; and renames and removals of the records take the obsolete agent, skill and
 * group away again, leaving unrelated settings and unmarked files alone.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { PACKET_MARKER, admissionReport } from '@inventarch/runtime';
import { hookGroupDigest } from '@inventarch/distribution/guard-registration';
import { sha256 } from '@inventarch/distribution/services';
import { runBounded } from '@tools/testing/subprocess.js';
import { ProjectionError } from '@inventarch/workspace-runtime/projections';
import { applyHostProjection, HOOK_KEPT, renderProjectionFor } from '../src/host-projection.js';
import { quote } from '../src/render.js';
import { cleanup, cli, nextArgv, run } from './workspace-fixture.js';
import {
  doctor,
  GUARD_STATE,
  host,
  initialized,
  legacyRegistration,
  noDrift,
  put,
  read,
  STEWARD,
} from './host-fixture.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

/** A seam on the host set's generation, so a test can make it refuse as workspace-runtime refuses; it passes through. */
const seams = vi.hoisted(() => ({ refuse: undefined as Error | undefined }));
vi.mock('@inventarch/workspace-runtime/internal/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/workspace-runtime/internal/generate')>();
  return {
    ...actual,
    generateHostSet: (...args: Parameters<typeof actual.generateHostSet>) => {
      if (seams.refuse !== undefined) throw seams.refuse;
      return actual.generateHostSet(...args);
    },
  };
});
afterAll(cleanup);

const FIXTURE = resolve(cli, 'tests/fixtures/composition-workspace');
const PROFILE = 'agent-composition-system/binding/agent-profile/reviewer',
  PLAYBOOK = 'governance-system/definition/procedure/note-review',
  HOOK = 'hook-authoring-system/binding/hook/note-edits',
  RENAMED = 'hook-authoring-system/binding/hook/doc-edits';
const RECEIPT_PATH = '.ia/distributions/hosts/claude-receipt.json';
const SETTINGS = '.claude/settings.local.json',
  HOOK_STATE = '.ia/distributions/hosts/claude-hooks-workspace.json',
  PROJECTION = '.ia/distributions/hosts/claude-projection.json',
  AGENT = '.claude/agents/reviewer.md',
  SKILL = '.claude/skills/note-review/SKILL.md',
  PACKET = ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'];
const reviewer = { agent_id: 'subagent-1', agent_type: 'reviewer' };

/** An `ia init` workspace with the composition fixture laid over it, by its physical path, and its IA home. */
async function composed(legacy = false): Promise<{ root: string; env: { IA_HOST_HOME: string } }> {
  const { root, env } = await initialized();
  if (legacy) legacyRegistration(root, env);
  cpSync(FIXTURE, root, { recursive: true });
  return { root: realpathSync(root), env };
}
/** `text` with each `from` replaced by its `to`, every one of which must be there. */
const edited = (text: string, ...edits: readonly (readonly [string, string])[]): string =>
  edits.reduce((result, [from, to]) => {
    if (!result.includes(from)) throw new Error(`fixture lacks ${from}`);
    return result.replaceAll(from, to);
  }, text);
/** `text` without the span from `from` up to, not including, `to`. */
const without = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from),
    end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`fixture lacks ${from} ... ${to}`);
  return text.slice(0, start) + text.slice(end);
};
const edit = (root: string, path: string, ...edits: readonly (readonly [string, string])[]): void =>
  writeFileSync(resolve(root, path), edited(read(root, path), ...edits));

interface Handler {
  readonly command: string;
  readonly args: readonly string[];
}
interface Group {
  readonly matcher: string;
  readonly hooks: readonly Handler[];
}
const settings = (root: string): Record<string, unknown> & { hooks?: { PreToolUse?: Group[] } } =>
  JSON.parse(read(root, SETTINGS));
/** The `@hook` groups in the local settings, by the identity each runs the guard for. */
const hookGroups = (root: string): ReadonlyMap<string, Group> =>
  new Map(
    (settings(root).hooks?.PreToolUse ?? [])
      .filter((group) => group.hooks.some((handler) => handler.args?.includes('--hook')))
      .map((group) => [group.hooks[0]!.args.at(-1)!, group]),
  );
/** Every file `paths` names, with its bytes, or null where none is. */
const snapshot = (root: string, paths: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(paths.map((path) => [path, existsSync(resolve(root, path)) ? read(root, path) : null]));
interface ProjectionElement {
  readonly id: string;
  readonly action: string;
  readonly guard: string;
  readonly files: { path: string; action: string }[];
  readonly hooks?: { hook: string; action: string }[];
  readonly unsupported: { identity: string; word: string; reason: string }[];
}
/** The projection element of an `ia host --json` envelope. */
const projection = (stdout: string): ProjectionElement =>
  (JSON.parse(stdout) as { plan: { elements: ProjectionElement[] } }).plan.elements.find(
    (element) => element.id === 'projection',
  )!;
const actions = (element: ReturnType<typeof projection>): Record<string, string> =>
  Object.fromEntries(element.files.map((file) => [file.path, file.action]));
const receipt = (root: string, name = 'claude') =>
  JSON.parse(read(root, `.ia/distributions/hosts/${name}-receipt.json`)) as {
    files: { path: string; sha256: string }[];
    generated: { identity: string; word: string; path: string; sha256: string }[];
    hooks?: { identity: string; tools: string[]; sha256: string }[];
    definitions: { identity: string; word: string; definition: Record<string, unknown> }[];
    unsupported: { identity: string; word: string; reason: string }[];
    removed: { path: string; sha256: string }[];
    removedHooks?: { identity: string; sha256: string }[];
    guard: string;
    writtenAt: string;
  };
/** A receipt's rows: everything but the time and the retirement, which describe the apply that wrote it. */
const rows = (root: string, name = 'claude') => {
  const { writtenAt: _writtenAt, guard: _guard, ...rest } = receipt(root, name);
  return rest;
};
async function apply(root: string, env: Record<string, string>, ...extra: string[]) {
  const result = await host(root, env, 'claude', '--apply', '--yes', ...extra);
  expect(result.exitCode, result.stdout).toBe(0);
  return result;
}
/**
 * Run a registered group's one handler on a file edit event, exactly as Claude Code runs it (the command and its
 * arguments, the event on stdin): undefined when the guard allows the edit, else its refusal reason.
 */
async function guarded(
  root: string,
  group: Group | undefined,
  path: string,
  extra: Record<string, unknown> = {},
  tool = 'Write',
): Promise<string | undefined> {
  expect(group, 'a registered hook group').toBeDefined();
  const [handler] = group!.hooks;
  const result = await runBounded(handler!.command, [...handler!.args], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: { file_path: resolve(root, path), content: 'x', ...(tool === 'MultiEdit' ? { edits: [] } : {}) },
      ...extra,
    }),
    timeoutMs: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  return output.hookSpecificOutput?.permissionDecisionReason;
}
const codeOf = (reason: string | undefined): string | undefined => reason?.split(':')[0];

it('refuses removal when hook ownership is lost and preserves the active group until manual recovery', async () => {
  const { root, env } = await composed();
  const unrelated = { permissions: { allow: ['Bash(ls)'] } };
  put(root, SETTINGS, JSON.stringify(unrelated) + '\n');
  await apply(root, env);
  rmSync(resolve(root, HOOK_STATE));
  const group = hookGroups(root).get(HOOK);
  expect(codeOf(await guarded(root, group, 'docs/guide.md', reviewer))).toBe('IA-HOOK-NOT-MANDATED');
  expect((await doctor(root, env)).checks.find((row) => row.id === `projection-claude-hook:${HOOK}`)).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('delete only this unowned group manually'),
    remedy: null,
  });
  const paths = [
      SETTINGS,
      HOOK_STATE,
      PROJECTION,
      RECEIPT_PATH,
      '.ia/distributions/hosts/joins.json',
      '.ia/distributions/hosts/guard-pending.json',
      '.mcp.json',
      AGENT,
      SKILL,
      ...PACKET,
    ],
    before = snapshot(root, paths);
  for (const flags of [[], ['--apply', '--yes']]) {
    const result = await host(root, env, 'claude', '--remove', ...flags);
    if (flags.length === 0) {
      expect(result.exitCode, result.stdout).toBe(0);
      expect(projection(result.stdout)).toMatchObject({
        action: 'refused',
        conflict: { code: 'IA-DIST-LOCAL-MODIFICATION', path: SETTINGS },
      });
    } else {
      expect(result.exitCode, result.stdout).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: 'IA-DIST-LOCAL-MODIFICATION',
        where: { path: SETTINGS },
        next: expect.stringContaining(`Delete only the unowned IA hook group for ${HOOK}`),
      });
    }
    expect(snapshot(root, paths)).toEqual(before);
  }
  expect(codeOf(await guarded(root, hookGroups(root).get(HOOK), 'docs/guide.md', reviewer))).toBe(
    'IA-HOOK-NOT-MANDATED',
  );
  // The refusal does not authorize adopting or deleting the whole settings file. Remove just the identified group.
  const repaired = settings(root);
  repaired.hooks!.PreToolUse = repaired.hooks!.PreToolUse!.filter(
    (entry) => entry !== undefined && !entry.hooks.some((handler) => handler.args?.includes(HOOK)),
  );
  put(root, SETTINGS, JSON.stringify(repaired) + '\n');
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect(settings(root)['permissions']).toEqual(unrelated.permissions);
  expect(hookGroups(root).size).toBe(0);
});

it('applies the packet, one agent, one skill and one hook group through the one writer, and a second apply writes nothing', async () => {
  const { root, env } = await composed();
  const first = projection((await apply(root, env)).stdout);
  expect(actions(first)).toEqual({
    [PACKET[0]!]: 'create',
    [PACKET[1]!]: 'create',
    [AGENT]: 'create',
    [SKILL]: 'create',
  });
  expect(first.hooks).toEqual([{ hook: HOOK, action: 'create' }]);
  expect(first.unsupported).toEqual([]);
  for (const path of [...PACKET, AGENT, SKILL]) expect(read(root, path).split('\n'), path).toContain(PACKET_MARKER);
  // One group, for every edit tool, running the guard for the hook (C9, G-R2); the ownership state records its paths.
  const group = hookGroups(root).get(HOOK)!;
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(settings(root).hooks?.PreToolUse).toHaveLength(1);
  expect(group.matcher).toBe('Write|Edit|MultiEdit');
  expect(group.hooks[0]!.args.slice(-5)).toEqual(['guard', '--root', root, '--hook', HOOK]);
  expect(JSON.parse(read(root, HOOK_STATE)).groups).toEqual([
    { hook: HOOK, group, paths: ['docs/**', 'restricted/**'] },
  ]);
  // Ownership is the projection state's: the generated files are owned there, beside the packet's.
  expect(Object.keys(JSON.parse(read(root, PROJECTION)).files).sort()).toEqual([...PACKET, AGENT, SKILL].sort());
  // The receipt lists each generated file with its record, the hook group by identity and digest, and the definitions.
  const written = receipt(root);
  expect(written.files.map((file) => file.path).sort()).toEqual([...PACKET, AGENT, SKILL].sort());
  expect(written.generated).toEqual([
    { identity: PROFILE, word: 'agent-profile', path: AGENT, sha256: sha256(read(root, AGENT)) },
    { identity: PLAYBOOK, word: 'playbook', path: SKILL, sha256: sha256(read(root, SKILL)) },
  ]);
  expect(written.hooks).toEqual([
    { identity: HOOK, tools: ['Write', 'Edit', 'MultiEdit'], sha256: hookGroupDigest(group) },
  ]);
  expect(written.unsupported).toEqual([]);
  expect(written.definitions.map((row) => [row.word, row.identity])).toEqual([
    ['operation', 'authoring-system/binding/operation/read-note'],
    ['harness', 'agent-composition-system/definition/harness/note-workspace'],
  ]);
  // The handler and validator ids are catalog keys copied as authored; nothing resolves or runs them.
  expect(written.definitions[0]!.definition).toMatchObject({
    handler: 'read-note-v1',
    input: 'read-note-input-v1',
    output: 'read-note-output-v1',
  });
  expect(written.definitions[1]!.definition['registrations']).toEqual({
    agents: [{ identity: PROFILE, path: AGENT }],
    skills: [{ identity: PLAYBOOK, path: SKILL }],
    hooks: [expect.objectContaining({ identity: HOOK, paths: ['docs/**', 'restricted/**'] })],
  });

  // A second apply is a no-op: no file, setting or state changes, and the receipt every apply writes (B12) holds the
  // same rows, only its time differing.
  const watched = [...PACKET, AGENT, SKILL, SETTINGS, HOOK_STATE, PROJECTION],
    before = snapshot(root, watched),
    rowsBefore = rows(root);
  const second = projection((await apply(root, env)).stdout);
  expect(second.action).toBe('unchanged');
  expect(new Set(Object.values(actions(second)))).toEqual(new Set(['unchanged']));
  expect(second.hooks).toEqual([{ hook: HOOK, action: 'unchanged' }]);
  expect(snapshot(root, watched)).toEqual(before);
  expect(rows(root)).toEqual(rowsBefore);

  // Doctor finds nothing after a clean apply.
  const clean = await doctor(root, env);
  expect(clean.checks).toContainEqual(noDrift());
  expect(clean.checks.filter((check) => check.id.startsWith('projection-claude') && check.status !== 'ok')).toEqual([]);
});

it('runs the registered group through the launcher: the hook decides what it selects, and IA state is managed', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const group = hookGroups(root).get(HOOK);
  // The main session acts as the workspace's steward, whom docs-mandate grants Synthesis under docs/.
  expect(await guarded(root, group, 'docs/guide.md')).toBeUndefined();
  // The reviewer subagent acts as @agent reviewer, whom no mandate governing docs/ binds.
  const refused = await guarded(root, group, 'docs/guide.md', reviewer);
  expect(codeOf(refused)).toBe('IA-HOOK-NOT-MANDATED');
  expect(refused).toContain(`Use the participant's documentation mandate. (${HOOK}: subagent reviewer acts as`);
  expect(codeOf(await guarded(root, group, 'restricted/plan.md', reviewer, 'Edit'))).toBe('IA-HOOK-NOT-MANDATED');
  // What the hook does not select is not decided (C10), the records under .ia/src included.
  expect(await guarded(root, group, 'src/app.ts', reviewer)).toBeUndefined();
  expect(await guarded(root, group, '.ia/src/hooks.ia', reviewer)).toBeUndefined();
  // A subagent no authored profile names is refused wherever the hook selects.
  expect(codeOf(await guarded(root, group, 'docs/guide.md', { agent_id: 'subagent-2', agent_type: 'stranger' }))).toBe(
    'IA-HOOK-IDENTITY-UNAVAILABLE',
  );
  // The generated files, the settings and the hook ownership state are managed for every edit tool and every actor.
  for (const path of [AGENT, SKILL, SETTINGS, HOOK_STATE])
    for (const tool of ['Write', 'Edit', 'MultiEdit'])
      expect(codeOf(await guarded(root, group, path, {}, tool)), `${path} ${tool}`).toBe('IA-HOOK-PROJECTION-MANAGED');
});

it('reports drift in a generated file and in a hook group, and names the way back from a group deleted by hand', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const original = read(root, SKILL);
  writeFileSync(resolve(root, SKILL), `${original}Edited by hand.\n`);
  // The hand-edited skill is the one drift row, a fail naming its repair (H-N5).
  const drifted = await doctor(root, env);
  expect(drifted.checks.filter((check) => check.id.startsWith('projection-claude') && check.status !== 'ok')).toEqual([
    {
      id: `projection-claude:${SKILL}`,
      title: 'Projection claude',
      status: 'fail',
      detail: `${SKILL} changed since the projection apply wrote it; move or delete it, then run the remedy`,
      remedy: `ia host claude --root ${quote(root)} --apply`,
    },
  ]);
  writeFileSync(resolve(root, SKILL), original);
  expect((await doctor(root, env)).checks).toContainEqual(noDrift());

  // The group deleted by hand: doctor reports it missing, apply refuses to put it back silently, and the removal it
  // names, then a new registration, restores it.
  const kept = settings(root);
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify({ ...kept, hooks: { PreToolUse: [] } }, null, 2)}\n`);
  const missing = (await doctor(root, env)).checks.find((check) => check.id === `projection-claude-hook:${HOOK}`);
  expect(missing).toMatchObject({
    status: 'fail',
    remedy: `ia host claude --root ${quote(root)} --remove --apply`,
  });
  expect(missing!.detail).toContain(
    `the remedy removes the registration, and "ia host claude --root ${quote(root)} --apply" then registers`,
  );
  // The remedy doctor names, then the apply it names, run as given.
  await follow(missing!.remedy!, env);
  expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
  await apply(root, env);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect((await doctor(root, env)).checks).toContainEqual(noDrift());
});

/** Run a command a refusal or remedy names, as named, confirmed non-interactively; it must succeed. */
async function follow(command: string, env: Record<string, string>): Promise<void> {
  const argv = command.startsWith('ia ') ? command.slice(3).split(' ') : nextArgv(command);
  const result = await run([...argv, '--yes', '--json'], { env });
  expect(result.exitCode, `${argv.join(' ')}: ${result.stdout}`).toBe(0);
}
const withoutHookGroups = (root: string): void => {
  const kept = settings(root);
  writeFileSync(
    resolve(root, SETTINGS),
    `${JSON.stringify({ ...kept, hooks: { PreToolUse: (kept.hooks?.PreToolUse ?? []).filter((group) => !group.hooks.some((handler) => handler.args?.includes('--hook'))) } }, null, 2)}
`,
  );
};

it('names the recovery for a hook group deleted or changed by hand, for ia host and ia project, and it works (H-R1, H-N3)', async () => {
  // Deleted by hand: both verbs refuse naming the removal, which drops the registration; ia host registers again.
  const { root, env } = await composed();
  await apply(root, env);
  withoutHookGroups(root);
  const removal = `Run "ia host claude --root ${quote(root)} --remove --apply", which drops the registration of the hook group deleted by hand, then register again with ia host.`;
  for (const verb of [
    ['host', 'claude'],
    ['project', 'claude'],
  ]) {
    const refused = await run([...verb, '--root', root, '--apply', '--yes', '--json'], { env });
    expect(refused.exitCode, refused.stdout).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'IA-DIST-LOCAL-MODIFICATION', next: removal });
  }
  await follow(removal, env);
  await apply(root, env);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);

  // Changed by hand: the group goes first, then the removal, then ia host.
  const changed = settings(root);
  (changed.hooks!.PreToolUse![0]!.hooks[0] as unknown as Record<string, unknown>)['timeout'] = 99;
  writeFileSync(
    resolve(root, SETTINGS),
    `${JSON.stringify(changed, null, 2)}
`,
  );
  const refused = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(refused).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: `Delete every IA hook group for ${HOOK} in ${SETTINGS}, then run "ia host claude --root ${quote(root)} --remove --apply" and register again with ia host.`,
  });
  withoutHookGroups(root);
  await follow(refused.next, env);
  await apply(root, env);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);

  // An unreadable hook ownership state names itself and the groups it owns, then the rerun.
  writeFileSync(resolve(root, HOOK_STATE), '{ not json');
  const unreadable = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(unreadable.next).toBe(
    `Delete ${HOOK_STATE} and every IA hook group in ${SETTINGS} (each runs the guard for one authored @hook), then run "ia host claude --root ${quote(root)} --apply".`,
  );
  rmSync(resolve(root, HOOK_STATE));
  withoutHookGroups(root);
  await follow(unreadable.next, env);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
});

it('removes the obsolete agent, skill and hook group when their records are renamed or deleted, leaving unrelated settings and unmarked files', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  // Unrelated settings and files the user keeps beside IA's.
  const kept = settings(root),
    bash = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo kept' }] };
  writeFileSync(
    resolve(root, SETTINGS),
    `${JSON.stringify({ ...kept, env: { KEPT: '1' }, hooks: { PreToolUse: [...kept.hooks!.PreToolUse!, bash] } }, null, 2)}\n`,
  );
  const unmarked = { '.claude/agents/notes.md': '# My notes\n', '.claude/skills/custom/SKILL.md': 'My own skill.\n' };
  for (const [path, text] of Object.entries(unmarked)) put(root, path, text);
  const old = hookGroups(root).get(HOOK);

  // The record edit itself is not selected by the hook, so the main session may make it.
  expect(await guarded(root, old, '.ia/src/hooks.ia')).toBeUndefined();
  // The renamed hook also narrows its tools to Write.
  edit(
    root,
    '.ia/src/hooks.ia',
    ['note-edits', 'doc-edits'],
    ['@agent-profile reviewer', '@agent-profile auditor'],
    ['tools [Write, Edit, MultiEdit]', 'tools [Write]'],
  );
  edit(
    root,
    '.ia/src/composition.ia',
    ['@agent-profile reviewer', '@agent-profile auditor'],
    ['note-review', 'doc-review'],
  );
  edit(root, '.ia/src/playbook.ia', ['@playbook note-review', '@playbook doc-review']);
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  // Until the next apply, the group whose hook is gone refuses no more than its last registered selection, naming the
  // shell commands that bring the registration back in step (G-N4).
  const stale = await guarded(root, old, 'docs/guide.md');
  expect(codeOf(stale)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
  expect(stale).toContain('this edit is under its last registered selection');
  expect(stale).toContain(`ia host claude --root ${JSON.stringify(root)} --apply --yes`);
  expect(stale).toContain(`ia host claude --root ${JSON.stringify(root)} --remove --apply --yes`);
  expect(await guarded(root, old, 'src/app.ts')).toBeUndefined();

  const renamed = projection((await apply(root, env)).stdout);
  expect(actions(renamed)).toMatchObject({
    [AGENT]: 'remove',
    [SKILL]: 'remove',
    '.claude/agents/auditor.md': 'create',
    '.claude/skills/doc-review/SKILL.md': 'create',
  });
  expect(renamed.hooks).toEqual([
    { hook: RENAMED, action: 'create' },
    { hook: HOOK, action: 'remove' },
  ]);
  for (const path of [AGENT, SKILL]) expect(existsSync(resolve(root, path)), path).toBe(false);
  const written = receipt(root);
  expect(written.removed.map((file) => file.path).sort()).toEqual([AGENT, SKILL].sort());
  // The removed group is listed by its hook and the digest it was registered with (H-R5).
  expect(written.removedHooks).toEqual([{ identity: HOOK, sha256: hookGroupDigest(old) }]);
  expect(written.generated.map((row) => row.path)).toEqual([
    '.claude/agents/auditor.md',
    '.claude/skills/doc-review/SKILL.md',
  ]);
  // The receipt names the tools the hook declares, which the group's matcher, every edit tool, does not say.
  expect(written.hooks).toEqual([
    { identity: RENAMED, tools: ['Write'], sha256: hookGroupDigest(hookGroups(root).get(RENAMED)) },
  ]);
  // Unrelated settings keys and groups and unmarked files are intact.
  expect(settings(root)['env']).toEqual({ KEPT: '1' });
  expect(settings(root).hooks?.PreToolUse?.filter((group) => group.matcher === 'Bash')).toEqual([bash]);
  expect([...hookGroups(root).keys()]).toEqual([RENAMED]);
  for (const [path, text] of Object.entries(unmarked)) expect(read(root, path), path).toBe(text);
  // The renamed hook decides through its own group; the subagent named after the renamed profile acts as the reviewer.
  const group = hookGroups(root).get(RENAMED);
  expect(await guarded(root, group, 'docs/guide.md')).toBeUndefined();
  expect(codeOf(await guarded(root, group, 'docs/guide.md', { agent_id: 'subagent-1', agent_type: 'auditor' }))).toBe(
    'IA-HOOK-NOT-MANDATED',
  );
  expect(codeOf(await guarded(root, group, 'docs/guide.md', reviewer))).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  // Its tools apply to its paths only: an Edit there is not decided, and IA state stays managed for every tool.
  expect(
    await guarded(root, group, 'docs/guide.md', { agent_id: 'subagent-1', agent_type: 'auditor' }, 'Edit'),
  ).toBeUndefined();
  expect(codeOf(await guarded(root, group, '.claude/agents/auditor.md', {}, 'Edit'))).toBe(
    'IA-HOOK-PROJECTION-MANAGED',
  );

  // The hook deleted outright: the next apply removes its group and the ownership state, and nothing else.
  writeFileSync(
    resolve(root, '.ia/src/hooks.ia'),
    edited(
      without(
        without(read(root, '.ia/src/hooks.ia'), '@hook doc-edits', '@mandate docs-mandate'),
        '@execution-binding notes-hook',
        '@harness note-workspace',
      ),
      ['bindings [@execution-binding notes-hook]', 'bindings []'],
    ),
  );
  const removed = projection((await apply(root, env)).stdout);
  expect(removed.hooks).toEqual([{ hook: RENAMED, action: 'remove' }]);
  expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
  expect(settings(root)['env']).toEqual({ KEPT: '1' });
  expect(settings(root).hooks?.PreToolUse).toEqual([bash]);
  expect(receipt(root).hooks).toEqual([]);
  expect(receipt(root).removedHooks).toEqual([{ identity: RENAMED, sha256: hookGroupDigest(group) }]);

  // Removing the registration takes the generated files and leaves the user's own.
  await apply(root, env, '--remove');
  for (const path of ['.claude/agents/auditor.md', '.claude/skills/doc-review/SKILL.md', ...PACKET])
    expect(existsSync(resolve(root, path)), path).toBe(false);
  for (const [path, text] of Object.entries(unmarked)) expect(read(root, path), path).toBe(text);
  expect(settings(root)['env']).toEqual({ KEPT: '1' });
  expect(settings(root).hooks?.PreToolUse).toEqual([bash]);
});

it('retires a 1.x steward guard and registers the hook group in one apply, and a profile named after a 1.x steward file is one update', async () => {
  const { root, env } = await composed(true);
  // The fixture profile renamed after the 1.x steward file the projection state still owns.
  edit(root, '.ia/src/composition.ia', ['@agent-profile reviewer', '@agent-profile demo-steward']);
  edit(root, '.ia/src/hooks.ia', ['@agent-profile reviewer', '@agent-profile demo-steward']);
  const element = projection((await apply(root, env)).stdout);
  expect(element.guard).toBe('retire');
  expect(element.files.filter((file) => file.path === STEWARD)).toEqual([{ path: STEWARD, action: 'update' }]);
  expect(element.hooks).toEqual([{ hook: HOOK, action: 'create' }]);
  // The steward guard's group and state are gone, and the one group left is the hook's.
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(settings(root).hooks?.PreToolUse).toHaveLength(1);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  const written = receipt(root);
  expect(written.guard).toBe('retired');
  expect(written.hooks?.map((row) => row.identity)).toEqual([HOOK]);
  expect(written.generated.find((row) => row.word === 'agent-profile')).toMatchObject({ path: STEWARD });
  expect(read(root, STEWARD).split('\n')).toContain(PACKET_MARKER);
  expect(read(root, STEWARD)).toContain('name: "demo-steward"');
  // And the next apply changes nothing; its receipt holds the same rows, and no retirement, which was the first's.
  const before = snapshot(root, [STEWARD, SETTINGS, HOOK_STATE, PROJECTION]),
    rowsBefore = rows(root);
  expect(projection((await apply(root, env)).stdout).action).toBe('unchanged');
  expect(snapshot(root, [STEWARD, SETTINGS, HOOK_STATE, PROJECTION])).toEqual(before);
  expect(rows(root)).toEqual(rowsBefore);
  expect(receipt(root).guard).toBe('none');
});

it('applies the packet and the skill for codex, and reports the agent and the hook as not taken (C12)', async () => {
  const { root, env } = await composed();
  const result = await host(root, env, 'codex', '--apply', '--yes');
  expect(result.exitCode, result.stdout).toBe(0);
  const element = projection(result.stdout);
  expect(actions(element)).toEqual({
    'AGENTS.md': 'create',
    '.agents/skills/ia-authoring/SKILL.md': 'create',
    '.agents/skills/note-review/SKILL.md': 'create',
  });
  expect(element.hooks).toBeUndefined();
  const written = receipt(root, 'codex');
  expect(written.unsupported.map((row) => [row.word, row.identity])).toEqual([
    ['agent-profile', PROFILE],
    ['hook', HOOK],
  ]);
  expect(written.generated.map((row) => [row.word, row.path])).toEqual([
    ['playbook', '.agents/skills/note-review/SKILL.md'],
  ]);
  expect(written.hooks).toBeUndefined();
  expect(written.definitions[0]!.definition).toMatchObject({ handler: 'read-note-v1' });
  for (const path of [AGENT, SETTINGS, '.codex/agents']) expect(existsSync(resolve(root, path)), path).toBe(false);
});

it("falls back to the mandates that bind the fixture profile's agent when the profile names none (C1)", async () => {
  const { root } = await composed();
  edit(root, '.ia/src/composition.ia', ['    mandate @mandate demo-mandate\n', '']);
  const agent = renderProjectionFor(root, 'claude').files.find((file) => file.path === AGENT)!.text;
  expect(agent.split('\n## Mandate\n\n')[1]!.split('\n\n## ')[0]).toBe(
    [
      "This profile names no mandate. Fallback: the authored mandates that bind its agent `agent-system/binding/agent/reviewer`, each with where it governs; the edit guard and the CLI's mandate profile judge the agent by these, and refuse it where a mandate that binds another participant governs and none of these grants the move.",
      '',
      '- `agent-system/policy/mandate/reviewer-docs`',
      '  - participant `agent-system/binding/agent/reviewer`',
      '  - moves Observation',
      '  - covers `restricted/`',
    ].join('\n'),
  );
});

// Kept with its seam (review finding H-N5): generation reports every record it cannot render as an unsupported row, so
// no workspace's records make generateHostSet itself refuse; the seam is the only way to pin the refusal's mapping.
it('reports a generation refusal with its own code, naming ia validate, and writes nothing', async () => {
  const { root, env } = await composed();
  seams.refuse = new ProjectionError({ code: 'IA-PROJECTION-INPUT-INVALID', message: 'forced generation refusal' });
  try {
    for (const extra of [[], ['--apply', '--yes']]) {
      const refused = await host(root, env, 'claude', ...extra);
      expect(refused.exitCode, refused.stdout).toBe(3);
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        code: 'IA-PROJECTION-INPUT-INVALID',
        message: 'forced generation refusal',
        next: `Correct the record the message names, then run "ia validate --root ${quote(root)}".`,
      });
    }
  } finally {
    seams.refuse = undefined;
  }
  for (const path of [AGENT, SKILL, HOOK_STATE]) expect(existsSync(resolve(root, path)), path).toBe(false);
});

it('applies the rest when a hook exceeds the bounds a registration holds, reporting that hook (H-N2)', async () => {
  const { root, env } = await composed();
  const hook = (name: string, paths: string) =>
    `\n@hook ${name}\n  meaning\n    says "Hook ${name}."\n    answers "Which hook is ${name}?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ${paths}\n    message "Use the ${name} mandate."\n`;
  put(
    root,
    '.ia/src/extra-hooks.ia',
    '#! ia 1.0\n' +
      hook('many-paths', `[${Array.from({ length: 65 }, (_, at) => `"notes/n${at}/**"`).join(', ')}]`) +
      hook('long-path', `["${'a'.repeat(600)}/**"]`),
  );
  const element = projection((await apply(root, env)).stdout);
  expect(element.hooks).toEqual([{ hook: HOOK, action: 'create' }]);
  expect(element.unsupported.map((row) => [row.word, row.identity])).toEqual([
    ['hook', 'hook-authoring-system/binding/hook/long-path'],
    ['hook', 'hook-authoring-system/binding/hook/many-paths'],
  ]);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(receipt(root).unsupported.map((row) => row.identity)).toEqual([
    'hook-authoring-system/binding/hook/long-path',
    'hook-authoring-system/binding/hook/many-paths',
  ]);
  for (const path of [AGENT, SKILL]) expect(existsSync(resolve(root, path)), path).toBe(true);
});

/** The removal a guard refusal names, as it names it, and the hook groups left once it ran. */
async function lifted(root: string, env: Record<string, string>, reason: string | undefined): Promise<number> {
  expect(reason).toContain(`"ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`);
  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
  return existsSync(resolve(root, SETTINGS)) ? hookGroups(root).size : 0;
}

it('restores editing with the removal the guard names when a broken record keeps the workspace from admitting (H-R2)', async () => {
  const { root, env } = await composed();
  edit(root, '.ia/src/hooks.ia', ['"restricted/**"]', '"restricted/**", ".ia/src/**"]']);
  await apply(root, env);
  const group = hookGroups(root).get(HOOK);
  // A syntax error in the hook's own record: it is no admitted @hook, and the workspace no longer admits.
  edit(root, '.ia/src/hooks.ia', ['@hook note-edits', '@hook note-edits\n  bogus-section\nzzz']);
  const refused = await guarded(root, group, '.ia/src/hooks.ia', {}, 'Edit');
  // hooks.ia holds docs-mandate and reviewer-docs too, which admission refuses with it, so the edit fails closed at the
  // first of them (review D-N1), and `ia validate`, mandate-gated, refuses there (lane D). Re-registering would refuse
  // too, so it is not named: the admission report, which shows why, is named instead, and runs.
  expect(codeOf(refused)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(refused).toContain('agent-system/policy/mandate/docs-mandate (.ia/src/hooks.ia:15) failed admission');
  expect(refused).not.toContain(`"ia host claude --root ${JSON.stringify(root)} --apply --yes"`);
  expect(refused).not.toContain('ia validate');
  expect(refused).toContain(`"${admissionReport(root).command}"`);
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode).toBe(1);
  expect(JSON.parse(validated.stdout)).toMatchObject({
    code: 'IA-RUNTIME-REQUEST-INVALID',
    where: { path: '.ia/src/hooks.ia' },
  });
  const report = await run(['report', '--root', root]);
  expect(report.stderr).toBe('');
  expect(report.stdout).toContain('hooks.ia');
  expect(await lifted(root, env, refused)).toBe(0);

  // The lift a main-session refusal names works whatever the records say: an ambiguous default actor and a source error.
  const second = await composed();
  edit(second.root, '.ia/src/workspace.ia', ['    steward @agent demo\n', '']);
  put(
    second.root,
    '.ia/src/reviewer-scoped.ia',
    '#! ia 1.0\n\n@mandate reviewer-scoped\n  meaning\n    says "x"\n    answers "x?"\n  governance\n    requires "x"\n  authority\n    participant @agent reviewer\n    moves [Observation]\n    scope [@workspace demo]\n',
  );
  // With no steward and two participants the default actor is open, and a workspace `ia host --apply` is gated as an
  // effect (review C2-R7), so the registration names its actor; the guarded edits below are judged as before.
  await apply(second.root, second.env, '--actor', 'agent-system/binding/agent/demo');
  const ambiguous = hookGroups(second.root).get(HOOK);
  // The source error is inside a record db identifies: a stray top-level line would be a record it cannot identify,
  // possibly a @mandate, which fails the edit closed at it instead (review D2-R2), and the lift works then too.
  put(second.root, '.ia/src/broken.ia', '#! ia 1.0\n\n@playbook broken\n  meaning\n    says "x"\n   not ia\n');
  const lift = await guarded(second.root, ambiguous, 'docs/guide.md');
  expect(codeOf(lift)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  put(second.root, '.ia/src/broken.ia', '#! ia 1.0\n\n@playbook broken\n  meaning\n    says "x"\nzzz not ia\n');
  const closed = await guarded(second.root, ambiguous, 'docs/guide.md');
  expect(codeOf(closed)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(closed).toContain('an unidentified record at .ia/src/broken.ia:6, possibly a @mandate, failed admission');
  expect(await lifted(second.root, second.env, closed)).toBe(0);
});

it('refuses no more than the last registered selection when the records cannot open, and the removal it names works (H-R8)', async () => {
  for (const breaking of [
    (root: string) => put(root, '.ia/workspace.json', '{ not json'),
    // A Windows checkout's autocrlf rewrites the lock with CRLF line ends: the db refuses it as drift.
    (root: string) =>
      writeFileSync(
        resolve(root, '.ia/distributions.lock.json'),
        read(root, '.ia/distributions.lock.json').replace(/\r?\n/g, '\r\n'),
      ),
  ]) {
    const { root, env } = await composed();
    await apply(root, env);
    const group = hookGroups(root).get(HOOK);
    breaking(root);
    expect(await guarded(root, group, 'src/app.ts')).toBeUndefined();
    const refused = await guarded(root, group, 'docs/guide.md');
    expect(codeOf(refused)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
    expect(refused).toContain('this edit is under its last registered selection');
    expect(await lifted(root, env, refused)).toBe(0);
  }
});

it('keeps unchanged hook groups without the payload their registration recorded, and names ia host when a change needs it (H-R4)', async () => {
  const { root, env } = await composed();
  const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release,
    payload = resolve(env.IA_HOST_HOME, 'hosts', release);
  rmSync(payload, { recursive: true, force: true });
  // Nothing about the hooks changed: ia project writes no group and never reads the missing payload.
  const unchanged = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(unchanged.exitCode, unchanged.stdout).toBe(0);
  // A narrowed selection needs the payload: refused at it, naming ia host, which materializes it and registers.
  edit(root, '.ia/src/hooks.ia', ['paths ["docs/**", "restricted/**"]', 'paths ["docs/**"]']);
  const refused = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { where: { path: string }; next: string };
  expect(body.where.path).toBe(payload);
  expect(body.next).toBe(
    `Run "ia host claude --root ${quote(root)} --apply" to materialize this release's payload and register the workspace's hooks against it.`,
  );
  await follow(body.next, env);
  expect(JSON.parse(read(root, HOOK_STATE)).groups.map((group: { paths: string[] }) => group.paths)).toEqual([
    ['docs/**'],
  ]);
});

it('lists a removed hook group in the receipt even when the apply that removed it was interrupted (H-R5)', async () => {
  const { root, env } = await composed();
  const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release,
    old = hookGroups(root).get(HOOK)!;
  edit(root, '.ia/src/hooks.ia', ['note-edits', 'doc-edits']);
  // Cut the apply right after the hook groups changed: the old group is gone, the receipt not yet written.
  expect(() =>
    applyHostProjection(
      root,
      'claude',
      renderProjectionFor(root, 'claude'),
      (stage) => {
        if (stage === 'hooks') throw new Error('cut at hooks');
      },
      undefined,
      { verified: resolve(env.IA_HOST_HOME, 'hosts', release) },
    ),
  ).toThrow('cut at hooks');
  expect([...hookGroups(root).keys()]).toEqual([RENAMED]);
  // The rerun finds no group to remove, yet its receipt lists the one the cut apply removed, with its digest.
  await apply(root, env);
  expect(receipt(root).removedHooks).toEqual([{ identity: HOOK, sha256: hookGroupDigest(old) }]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([RENAMED]);
});

/** A catalog and request set that reinstall the bundled base, so an install commits and refreshes the projections. */
function baseInstall(root: string): string[] {
  const pin = JSON.parse(readFileSync(resolve(cli, 'assets/base.json'), 'utf8')) as {
    id: string;
    version: string;
    archive: string;
  };
  mkdirSync(resolve(root, '.ia/work/dist'), { recursive: true });
  copyFileSync(resolve(cli, `assets/base/${pin.archive}.ia.tgz`), resolve(root, '.ia/work/dist/base.ia.tgz'));
  put(root, '.ia/work/catalog.json', `${JSON.stringify([{ path: '.ia/work/dist/base.ia.tgz', withdrawn: false }])}\n`);
  put(root, '.ia/work/requests.json', `${JSON.stringify([{ id: pin.id, range: pin.version }])}\n`);
  return ['install', '--requests', '.ia/work/requests.json', '--catalog', '.ia/work/catalog.json', '--root', root];
}
/** The fixture's hook narrowed to docs/** and its profile renamed auditor, as a record change between applies. */
function narrowedAndRenamed(root: string): void {
  edit(
    root,
    '.ia/src/hooks.ia',
    ['paths ["docs/**", "restricted/**"]', 'paths ["docs/**"]'],
    ['@agent-profile reviewer', '@agent-profile auditor'],
  );
  edit(root, '.ia/src/composition.ia', ['@agent-profile reviewer', '@agent-profile auditor']);
}
const harnessRegistrations = (root: string): unknown =>
  receipt(root).definitions.find((row) => row.word === 'harness')!.definition['registrations'];
const recordedPaths = (root: string): unknown =>
  JSON.parse(read(root, HOOK_STATE)).groups.map((group: { paths: string[] }) => group.paths);

it('applies the generated set through ia project: hooks unregistered without ia host, kept in step after it (H-R6, H-R7)', async () => {
  const { root, env } = await composed();
  const projected = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(projected.exitCode, projected.stdout).toBe(0);
  const envelope = JSON.parse(projected.stdout) as {
    plan: {
      files: { path: string; action: string }[];
      hooks: unknown[];
      unsupported: { identity: string; reason: string }[];
    };
  };
  expect(envelope.plan.files.filter((file) => [AGENT, SKILL].includes(file.path))).toEqual([
    { path: AGENT, action: 'create' },
    { path: SKILL, action: 'create' },
  ]);
  expect(envelope.plan.hooks).toEqual([]);
  expect(envelope.plan.unsupported).toEqual([
    expect.objectContaining({ identity: HOOK, reason: expect.stringContaining('Not registered') }),
  ]);
  for (const path of [AGENT, SKILL]) expect(read(root, path).split('\n'), path).toContain(PACKET_MARKER);
  expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
  // The harness lists what this apply applied: the agent and the skill, and no hook, since none was registered (H-R7).
  expect(receipt(root).hooks).toEqual([]);
  expect(receipt(root).unsupported.map((row) => row.identity)).toEqual([HOOK]);
  expect(harnessRegistrations(root)).toEqual({
    agents: [{ identity: PROFILE, path: AGENT }],
    skills: [{ identity: PLAYBOOK, path: SKILL }],
    hooks: [],
  });
  // After ia host registers the hook, ia project keeps its group in step with the records and renames the agent.
  await apply(root, env);
  expect(harnessRegistrations(root)).toMatchObject({ hooks: [expect.objectContaining({ identity: HOOK })] });
  narrowedAndRenamed(root);
  const kept = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(kept.exitCode, kept.stdout).toBe(0);
  expect((JSON.parse(kept.stdout) as { plan: { hooks: unknown[] } }).plan.hooks).toEqual([
    { hook: HOOK, action: 'update' },
  ]);
  expect(recordedPaths(root)).toEqual([['docs/**']]);
  expect(existsSync(resolve(root, AGENT))).toBe(false);
  expect(read(root, '.claude/agents/auditor.md').split('\n')).toContain(PACKET_MARKER);
});

it('refreshes the generated set and the hook group after an install, and previews a generated agent as written (H-R6, H-N7)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const install = baseInstall(root);
  // The preview lists no 1.x removal: the generated agent is the refresh's to write.
  const planned = await run([...install, '--json'], { env });
  expect(planned.exitCode, planned.stdout).toBe(0);
  expect(JSON.parse(planned.stdout)).toMatchObject({
    refresh: ['claude'],
    projectionFiles: [{ host: 'claude', files: [] }],
  });
  // A record change, then the install: its refresh rewrites the agent and keeps the group in step.
  narrowedAndRenamed(root);
  const installed = await run([...install, '--apply', '--yes', '--json'], { env });
  expect(installed.exitCode, installed.stdout).toBe(0);
  expect(JSON.parse(installed.stdout)).toMatchObject({ applied: { status: 'installed' }, refresh: ['claude'] });
  expect(recordedPaths(root)).toEqual([['docs/**']]);
  expect(existsSync(resolve(root, AGENT))).toBe(false);
  expect(receipt(root).generated.map((row) => row.path)).toEqual(['.claude/agents/auditor.md', SKILL]);
  expect((await doctor(root, env)).checks).toContainEqual(noDrift());
});

it('refuses an install before any install write when its refresh would refuse the hook step, naming the repair (H-R3)', async () => {
  const { root, env } = await composed();
  const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release;
  const install = baseInstall(root),
    lock = read(root, '.ia/distributions.lock.json');
  // A group deleted by hand: refused before the lock is touched, naming the removal, which works.
  withoutHookGroups(root);
  const refused = await run([...install, '--apply', '--yes', '--json'], { env });
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; next: string };
  expect(body).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: `Run "ia host claude --root ${quote(root)} --remove --apply", which drops the registration of the hook group deleted by hand, then register again with ia host.`,
  });
  expect(read(root, '.ia/distributions.lock.json')).toBe(lock);
  await follow(body.next, env);
  await apply(root, env);
  // A changed selection with the recorded payload gone: refused at the payload, naming ia host.
  rmSync(resolve(env.IA_HOST_HOME, 'hosts', release), { recursive: true, force: true });
  edit(root, '.ia/src/hooks.ia', ['paths ["docs/**", "restricted/**"]', 'paths ["docs/**"]']);
  const gone = await run([...install, '--apply', '--yes', '--json'], { env });
  expect(gone.exitCode, gone.stdout).toBe(3);
  expect(JSON.parse(gone.stdout).next).toBe(
    `Run "ia host claude --root ${quote(root)} --apply" to materialize this release's payload and register the workspace's hooks against it.`,
  );
  expect(read(root, '.ia/distributions.lock.json')).toBe(lock);
});

it('applies the host without registering hooks where disableAllHooks turns them off, naming the file (H-N12)', async () => {
  for (const file of ['.claude/settings.json', SETTINGS]) {
    const { root, env } = await composed();
    put(root, file, `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
    const element = projection((await apply(root, env)).stdout);
    expect(element.hooks).toEqual([]);
    expect(element.unsupported).toEqual([
      { identity: HOOK, word: 'hook', reason: `Not registered: hooks are disabled by disableAllHooks in ${file}` },
    ]);
    // The packet, the agent, the skill and the MCP entry apply as they do without hooks.
    for (const path of [...PACKET, AGENT, SKILL, '.mcp.json']) expect(existsSync(resolve(root, path)), path).toBe(true);
    expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
    expect(existsSync(resolve(root, SETTINGS)) ? hookGroups(root).size : 0).toBe(0);
    expect(receipt(root).unsupported.map((row) => row.reason)).toEqual([
      `Not registered: hooks are disabled by disableAllHooks in ${file}`,
    ]);
  }
});

it('reports a changed and a foreign hook group, an unregistered hook and a receipt from before generation (H-N4, H-N5)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const row = async (id: string) => (await doctor(root, env)).checks.find((check) => check.id === id);
  // A group changed by hand: a fail naming the removal, after the group itself is deleted.
  const kept = settings(root),
    changed = structuredClone(kept);
  (changed.hooks!.PreToolUse![0]!.hooks[0] as unknown as Record<string, unknown>)['timeout'] = 99;
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(changed, null, 2)}\n`);
  expect(await row(`projection-claude-hook:${HOOK}`)).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('changed since it was registered, or appears twice; delete only that group'),
    remedy: `ia host claude --root ${quote(root)} --remove --apply`,
  });
  // A group naming another hook for this root, which no registration owns: a warning, left in place.
  const foreign = structuredClone(kept),
    other = 'hook-authoring-system/binding/hook/other-edits',
    copy = structuredClone(foreign.hooks!.PreToolUse![0]!);
  (copy.hooks[0] as unknown as { args: string[] }).args = [...copy.hooks[0]!.args.slice(0, -1), other];
  foreign.hooks!.PreToolUse!.push(copy);
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(foreign, null, 2)}\n`);
  expect(await row(`projection-claude-hook:${other}`)).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining("which this workspace's registration does not own; it is left in place"),
  });
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(kept, null, 2)}\n`);
  // A receipt from before authored generation: outdated, never an error.
  const written = JSON.parse(read(root, RECEIPT_PATH)) as Record<string, unknown>;
  delete written['generated'];
  writeFileSync(resolve(root, RECEIPT_PATH), `${JSON.stringify(written)}\n`);
  expect(await row('projection-claude-generated')).toMatchObject({
    status: 'warn',
    detail: 'outdated: the receipt predates authored generation, and the records render 2 generated files',
  });
  await apply(root, env);
  expect((await doctor(root, env)).checks).toContainEqual(noDrift());

  // An authored hook ia project could not register: a warning whose remedy, run as named, registers it.
  const unregistered = await composed();
  const projected = await run(['project', 'claude', '--root', unregistered.root, '--apply', '--yes', '--json'], {
    env: unregistered.env,
  });
  expect(projected.exitCode, projected.stdout).toBe(0);
  const warning = (await doctor(unregistered.root, unregistered.env)).checks.find(
    (check) => check.id === `projection-claude-hook:${HOOK}`,
  );
  expect(warning).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining(`the authored @hook ${HOOK} guards nothing: Not registered`),
    remedy: `ia host claude --root ${quote(unregistered.root)} --apply`,
  });
  await follow(warning!.remedy!, unregistered.env);
  expect([...hookGroups(unregistered.root).keys()]).toEqual([HOOK]);
  expect((await doctor(unregistered.root, unregistered.env)).checks).toContainEqual(noDrift());
});

it('converges after a generated-set rename apply interrupted at any of its checkpoints (H-N1)', async () => {
  /** A workspace whose fixture records were applied and then renamed, and the payload its groups run from. */
  const renamedWorkspace = async () => {
    const { root, env } = await composed();
    const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release;
    edit(root, '.ia/src/hooks.ia', ['note-edits', 'doc-edits'], ['@agent-profile reviewer', '@agent-profile auditor']);
    edit(
      root,
      '.ia/src/composition.ia',
      ['@agent-profile reviewer', '@agent-profile auditor'],
      ['note-review', 'doc-review'],
    );
    edit(root, '.ia/src/playbook.ia', ['@playbook note-review', '@playbook doc-review']);
    return { root, env, cache: { verified: resolve(env.IA_HOST_HOME, 'hosts', release) } };
  };
  // Every checkpoint one uninterrupted apply passes, in order.
  const probe = await renamedWorkspace(),
    stages: string[] = [];
  applyHostProjection(
    probe.root,
    'claude',
    renderProjectionFor(probe.root, 'claude'),
    (stage) => stages.push(stage),
    undefined,
    probe.cache,
  );
  expect(stages).toEqual(expect.arrayContaining(['evidence', 'guard', 'hooks', 'pending', 'complete', 'receipt']));
  for (const stage of stages) {
    const { root, env, cache } = await renamedWorkspace();
    expect(
      () =>
        applyHostProjection(
          root,
          'claude',
          renderProjectionFor(root, 'claude'),
          (at) => {
            if (at === stage) throw new Error(`cut at ${stage}`);
          },
          undefined,
          cache,
        ),
      stage,
    ).toThrow(`cut at ${stage}`);
    // The rerun converges: the renamed agent, skill and group in place, the obsolete ones gone and listed, no drift.
    await apply(root, env);
    for (const path of [AGENT, SKILL]) expect(existsSync(resolve(root, path)), `${stage} ${path}`).toBe(false);
    for (const path of ['.claude/agents/auditor.md', '.claude/skills/doc-review/SKILL.md'])
      expect(read(root, path).split('\n'), `${stage} ${path}`).toContain(PACKET_MARKER);
    expect([...hookGroups(root).keys()], stage).toEqual([RENAMED]);
    const written = receipt(root);
    // A cut after the receipt was written leaves a completed apply: the rerun is a second apply, which removed nothing.
    if (stage === 'receipt') expect([written.removedHooks, written.removed], stage).toEqual([[], []]);
    else {
      expect(written.removedHooks, stage).toEqual([
        { identity: HOOK, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ]);
      expect(written.removed.map((file) => file.path).sort(), stage).toEqual([AGENT, SKILL].sort());
    }
    expect((await doctor(root, env)).checks, stage).toContainEqual(noDrift());
  }
});

it('refuses a generated skill at a populated folder it does not own, naming the files to move, and the next works (A-F2)', async () => {
  // A folder the user holds under the skill's own name, and, where the volume folds names, under a case variant of it.
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  for (const folder of ['.claude/skills/note-review', '.claude/skills/Note-Review']) {
    const { root, env } = await composed();
    put(root, `${folder}/reference.md`, 'my own skill notes\n');
    const result = await host(root, env, 'claude', '--apply', '--yes');
    if (folder !== '.claude/skills/note-review' && !folds) {
      // A case variant is another folder where names do not fold: nothing collides.
      expect(result.exitCode, result.stdout).toBe(0);
      continue;
    }
    expect(result.exitCode, result.stdout).toBe(3);
    const body = JSON.parse(result.stdout) as { code: string; where: { path: string }; next: string };
    expect(body.code).toBe('IA-DIST-LOCAL-MODIFICATION');
    expect(body.where.path).toBe('.claude/skills/note-review');
    expect(body.next).toBe(
      `Move the files out of .claude/skills/note-review, or rename the @playbook that renders it, then run "ia host claude --root ${quote(root)} --apply".`,
    );
    // The plans print the conflict as code, path and reason only (A-F4).
    const conflict = {
      code: 'IA-DIST-LOCAL-MODIFICATION',
      path: '.claude/skills/note-review',
      reason: expect.stringContaining('a folder this projection does not own that already holds files'),
    };
    const element = projection((await host(root, env, 'claude')).stdout) as unknown as { conflict: object };
    expect(element.conflict).toMatchObject(conflict);
    expect(Object.keys(element.conflict).sort()).toEqual(['code', 'path', 'reason']);
    const planned = JSON.parse((await run(['project', 'claude', '--root', root, '--json'], { env })).stdout) as {
      plan: { conflict: object };
    };
    expect(Object.keys(planned.plan.conflict).sort()).toEqual(['code', 'path', 'reason']);
    expect(planned.plan.conflict).toMatchObject(conflict);
    // ia project names the same files to move.
    const project = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
    expect(JSON.parse(project.stdout).next).toBe(
      `Move the files out of .claude/skills/note-review, or rename the @playbook that renders it, then run "ia project claude --root ${quote(root)}".`,
    );
    // Follow it: the files go elsewhere, and the rerun it names writes the skill.
    const moved = resolve(root, '..', `kept-${folder.endsWith('Review') ? 'variant' : 'lower'}.md`);
    writeFileSync(moved, read(root, '.claude/skills/note-review/reference.md'));
    rmSync(resolve(root, '.claude/skills/note-review/reference.md'));
    await follow(body.next, env);
    expect(read(root, SKILL).split('\n')).toContain(PACKET_MARKER);
  }
});

it('keeps an owned group as registered while disableAllHooks is on, and still removes an obsolete one (A-F1)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const owned = hookGroups(root).get(HOOK)!;
  put(root, '.claude/settings.json', `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  // The hook still declared keeps its group: listed as registered, never also as not taken.
  const kept = projection((await apply(root, env)).stdout);
  expect(kept.hooks).toEqual([]);
  expect(kept.unsupported).toEqual([]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
  // Renamed: the obsolete group goes now, and the new hook, which has no group, is reported naming the file.
  edit(root, '.ia/src/hooks.ia', ['note-edits', 'doc-edits']);
  const renamed = projection((await apply(root, env)).stdout);
  expect(renamed.hooks).toEqual([{ hook: HOOK, action: 'remove' }]);
  expect(renamed.unsupported).toEqual([
    {
      identity: RENAMED,
      word: 'hook',
      reason: 'Not registered: hooks are disabled by disableAllHooks in .claude/settings.json',
    },
  ]);
  expect(existsSync(resolve(root, SETTINGS)) ? hookGroups(root).size : 0).toBe(0);
  expect(receipt(root)).toMatchObject({
    hooks: [],
    removedHooks: [{ identity: HOOK, sha256: hookGroupDigest(owned) }],
  });
});

it('names the state repair when the hook ownership state cannot be read and the hook record is broken, and it works (A-F3)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  const group = hookGroups(root).get(HOOK);
  writeFileSync(resolve(root, HOOK_STATE), '{ not json');
  edit(root, '.ia/src/hooks.ia', ['@hook note-edits', '@hook note-edits\n  bogus-section\nzzz']);
  const refused = await guarded(root, group, 'src/app.ts');
  // hooks.ia holds docs-mandate and reviewer-docs too, so the edit fails closed at the first of them (review D-N1).
  expect(codeOf(refused)).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(refused).toContain('agent-system/policy/mandate/docs-mandate (.ia/src/hooks.ia:15) failed admission');
  expect(refused).toContain(
    `from a shell, delete ${HOOK_STATE} and every IA hook group in ${SETTINGS} (each runs the guard for one authored @hook) to restore editing, then run "ia host claude --root ${JSON.stringify(root)} --remove --apply --yes"`,
  );
  // Follow it: the state and the groups go, which restores editing, and the removal it names then succeeds.
  rmSync(resolve(root, HOOK_STATE));
  withoutHookGroups(root);
  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(existsSync(resolve(root, SETTINGS)) ? hookGroups(root).size : 0).toBe(0);
});

/** A second authored hook beside the fixture's, over specs/**, named `name`. */
const secondHook = (name: string): string =>
  `#! ia 1.0\n\n@hook ${name}\n  meaning\n    says "Hook ${name}."\n    answers "Which hook is ${name}?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ["specs/**"]\n    message "Use the ${name} mandate."\n`;
const SPEC_HOOK = 'hook-authoring-system/binding/hook/spec-edits',
  PLAN_HOOK = 'hook-authoring-system/binding/hook/plan-edits';
/** The local settings with `disableAllHooks` set or cleared, every other key and group kept. */
const localHooksOff = (root: string, off: boolean): void => {
  const local = settings(root);
  if (off) local['disableAllHooks'] = true;
  else delete local['disableAllHooks'];
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(local, null, 2)}\n`);
};

it('reports an obsolete group kept while hooks are off and its payload is gone, never as registered, and removes it once hooks are on (F1)', async () => {
  const { root, env } = await composed();
  put(root, '.ia/src/extra-hooks.ia', secondHook('spec-edits'));
  const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release;
  expect([...hookGroups(root).keys()].sort()).toEqual([HOOK, SPEC_HOOK]);
  rmSync(resolve(env.IA_HOST_HOME, 'hosts', release), { recursive: true, force: true });
  put(root, '.claude/settings.json', `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
  const projected = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(projected.exitCode, projected.stdout).toBe(0);
  // The group stays, reported as kept; only the declared hook's group is listed as registered.
  expect([...hookGroups(root).keys()].sort()).toEqual([HOOK, SPEC_HOOK]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([HOOK]);
  expect(receipt(root).unsupported).toEqual([{ identity: SPEC_HOOK, word: 'hook', reason: HOOK_KEPT }]);
  // Hooks back on: ia host materializes a payload and removes the obsolete group.
  rmSync(resolve(root, '.claude/settings.json'));
  const restored = projection((await apply(root, env)).stdout);
  expect(restored.hooks).toEqual([
    { hook: HOOK, action: 'unchanged' },
    { hook: SPEC_HOOK, action: 'remove' },
  ]);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(receipt(root).removedHooks?.map((row) => row.identity)).toEqual([SPEC_HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
});

it('refuses a group deleted by hand while hooks are off as it does with hooks on, and the named removal works (F2)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  put(root, '.claude/settings.json', `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  withoutHookGroups(root);
  const refused = await host(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; next: string };
  expect(body).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: `Run "ia host claude --root ${quote(root)} --remove --apply", which drops the registration of the hook group deleted by hand, then register again with ia host.`,
  });
  await follow(body.next, env);
  // Registered again while hooks are off: no group, the hook reported naming the file.
  const element = projection((await apply(root, env)).stdout);
  expect(element.unsupported).toEqual([
    {
      identity: HOOK,
      word: 'hook',
      reason: 'Not registered: hooks are disabled by disableAllHooks in .claude/settings.json',
    },
  ]);
});

it('renames one of two hooks while disableAllHooks is on in the local settings, then registers both once hooks are on (F3)', async () => {
  const { root, env } = await composed();
  put(root, '.ia/src/extra-hooks.ia', secondHook('spec-edits'));
  await apply(root, env);
  localHooksOff(root, true);
  put(root, '.ia/src/extra-hooks.ia', secondHook('plan-edits'));
  const renamed = projection((await apply(root, env)).stdout);
  expect(renamed.hooks).toEqual([
    { hook: HOOK, action: 'unchanged' },
    { hook: SPEC_HOOK, action: 'remove' },
  ]);
  expect(renamed.unsupported).toEqual([
    {
      identity: PLAN_HOOK,
      word: 'hook',
      reason: 'Not registered: hooks are disabled by disableAllHooks in .claude/settings.local.json',
    },
  ]);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(settings(root)['disableAllHooks']).toBe(true);
  // Hooks on again: both declared hooks register.
  localHooksOff(root, false);
  const restored = projection((await apply(root, env)).stdout);
  expect(restored.hooks).toEqual([
    { hook: HOOK, action: 'unchanged' },
    { hook: PLAN_HOOK, action: 'create' },
  ]);
  expect([...hookGroups(root).keys()].sort()).toEqual([HOOK, PLAN_HOOK]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([HOOK, PLAN_HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
});

it("converges in one hop when the user's skill folder holds its own SKILL.md and other files (F6)", async () => {
  const { root, env } = await composed();
  put(root, SKILL, '---\nname: note-review\n---\n\nMy own skill.\n');
  put(root, '.claude/skills/note-review/reference.md', 'notes\n');
  const refused = await host(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { where: { path: string }; next: string };
  expect(body.where.path).toBe('.claude/skills/note-review');
  // Follow it once: the folder's files go elsewhere, and the rerun writes the skill.
  for (const name of ['SKILL.md', 'reference.md']) rmSync(resolve(root, '.claude/skills/note-review', name));
  await follow(body.next, env);
  expect(read(root, SKILL).split('\n')).toContain(PACKET_MARKER);
});

it('refuses an install before any install write when its refresh would refuse a generated skill at a populated folder (F4)', async () => {
  const { root, env } = await composed();
  await apply(root, env);
  // A new playbook whose skill folder already holds the user's files.
  put(
    root,
    '.ia/src/other-playbook.ia',
    read(root, '.ia/src/playbook.ia').replace('@playbook note-review', '@playbook other-review'),
  );
  put(root, '.claude/skills/other-review/reference.md', 'my own notes\n');
  const install = baseInstall(root),
    lock = read(root, '.ia/distributions.lock.json');
  const refused = await run([...install, '--apply', '--yes', '--json'], { env });
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; where: { path: string }; next: string };
  expect(body).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: '.claude/skills/other-review' },
    next: `Move the files out of .claude/skills/other-review, or rename the @playbook that renders it, then run "ia host claude --root ${quote(root)} --apply".`,
  });
  expect(read(root, '.ia/distributions.lock.json')).toBe(lock);
  rmSync(resolve(root, '.claude/skills/other-review/reference.md'));
  await follow(body.next, env);
  expect(read(root, '.claude/skills/other-review/SKILL.md').split('\n')).toContain(PACKET_MARKER);
});

/** Two hooks owned (the fixture's and spec-edits), then hooks off in the shared settings and the payload deleted. */
async function offWithoutPayload(): Promise<{ root: string; env: { IA_HOST_HOME: string } }> {
  const { root, env } = await composed();
  put(root, '.ia/src/extra-hooks.ia', secondHook('spec-edits'));
  const release = (JSON.parse((await apply(root, env)).stdout) as { plan: { release: string } }).plan.release;
  rmSync(resolve(env.IA_HOST_HOME, 'hosts', release), { recursive: true, force: true });
  put(root, '.claude/settings.json', `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  return { root, env };
}

it("plans the obsolete group's removal against the payload ia host materializes, so its preview and apply agree (N1)", async () => {
  const { root, env } = await offWithoutPayload();
  rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
  const expected = [
    { hook: HOOK, action: 'unchanged' },
    { hook: SPEC_HOOK, action: 'remove' },
  ];
  // The dry run plans the removal, as the apply that materializes the payload makes it.
  const preview = projection((await host(root, env, 'claude')).stdout);
  expect(preview.hooks).toEqual(expected);
  expect(preview.unsupported).toEqual([]);
  const applied = projection((await apply(root, env)).stdout);
  expect(applied.hooks).toEqual(expected);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(receipt(root).removedHooks?.map((row) => row.identity)).toEqual([SPEC_HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
});

it('words a kept group as one that still guards, and reports an unsupported authored hook whose group is kept once (N2, N3)', async () => {
  const { root, env } = await offWithoutPayload();
  // spec-edits stops being registrable (another event): generation reports it, and its owned group is kept.
  put(root, '.ia/src/extra-hooks.ia', secondHook('spec-edits').replace('event PreToolUse', 'event PostToolUse'));
  const projected = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(projected.exitCode, projected.stdout).toBe(0);
  const rows = receipt(root).unsupported.filter((row) => row.identity === SPEC_HOOK);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.reason).toContain('event PostToolUse is not PreToolUse');
  expect(rows[0]!.reason).toContain(HOOK_KEPT);
  const checks = (await doctor(root, env)).checks.filter((check) => check.id === `projection-claude-hook:${SPEC_HOOK}`);
  expect(checks).toEqual([
    expect.objectContaining({
      status: 'warn',
      // The apply that removes it, and generation's own reason beside it (F3, F4).
      detail: `the hook group for ${SPEC_HOOK} stays in ${SETTINGS} though no registrable hook claims it any more: the next "ia host claude --root ${quote(root)} --apply" removes it once hooks are back on, or while they are off once it materializes the payload the group was registered against (${rows[0]!.reason.replace(`; ${HOOK_KEPT}`, '')})`,
      remedy: null,
    }),
  ]);
});

it('drops the ownership of a hand-deleted group whose hook is no longer declared while hooks are off, as with hooks on (N4)', async () => {
  const { root, env } = await composed();
  put(root, '.ia/src/extra-hooks.ia', secondHook('spec-edits'));
  await apply(root, env);
  put(root, '.claude/settings.json', `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  // spec-edits's record and, by hand, its group are gone; the fixture's hook and group stay.
  rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
  const local = settings(root);
  local.hooks!.PreToolUse = local.hooks!.PreToolUse!.filter((group) => group.hooks[0]!.args.at(-1) !== SPEC_HOOK);
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(local, null, 2)}\n`);
  const element = projection((await apply(root, env)).stdout);
  expect(element.hooks).toEqual([
    { hook: HOOK, action: 'unchanged' },
    { hook: SPEC_HOOK, action: 'remove' },
  ]);
  expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  expect(JSON.parse(read(root, HOOK_STATE)).groups.map((group: { hook: string }) => group.hook)).toEqual([HOOK]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
});

it('keeps the ownership of a hand-deleted obsolete group until a plan can run, and doctor names the removal (F1)', async () => {
  // n4x's E1: hooks off, the recorded payload gone, spec-edits's record deleted and its group deleted by hand.
  const { root, env } = await offWithoutPayload();
  rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
  const local = settings(root);
  local.hooks!.PreToolUse = local.hooks!.PreToolUse!.filter((group) => group.hooks[0]!.args.at(-1) !== SPEC_HOOK);
  writeFileSync(resolve(root, SETTINGS), `${JSON.stringify(local, null, 2)}\n`);
  const projected = await run(['project', 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(projected.exitCode, projected.stdout).toBe(0);
  // Nothing could be planned: the ownership stays, the group is no kept row, and only the declared group is registered.
  expect(JSON.parse(read(root, HOOK_STATE)).groups.map((group: { hook: string }) => group.hook)).toEqual([
    HOOK,
    SPEC_HOOK,
  ]);
  expect(receipt(root).hooks?.map((row) => row.identity)).toEqual([HOOK]);
  expect(receipt(root).unsupported).toEqual([]);
  // Doctor reports the group missing, naming the removal, which works whatever the payload.
  const missing = (await doctor(root, env)).checks.find((check) => check.id === `projection-claude-hook:${SPEC_HOOK}`);
  expect(missing).toMatchObject({ status: 'fail', remedy: `ia host claude --root ${quote(root)} --remove --apply` });
  await follow(missing!.remedy!, env);
  expect(existsSync(resolve(root, HOOK_STATE))).toBe(false);
});

it('agrees with its apply for a home spelled in another case, and keeps the group for another payload, in both (F2)', async () => {
  // Another letter case names the same home only where the volume folds names.
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  if (folds) {
    const { root, env } = await offWithoutPayload();
    rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
    const variant = { IA_HOST_HOME: env.IA_HOST_HOME.replace(/[^\\/]+$/, (name) => name.toUpperCase()) };
    expect(variant.IA_HOST_HOME).not.toBe(env.IA_HOST_HOME);
    const expected = [
      { hook: HOOK, action: 'unchanged' },
      { hook: SPEC_HOOK, action: 'remove' },
    ];
    expect(projection((await host(root, variant, 'claude')).stdout).hooks).toEqual(expected);
    expect(projection((await apply(root, variant)).stdout).hooks).toEqual(expected);
    expect([...hookGroups(root).keys()]).toEqual([HOOK]);
  }
  // Another payload directory, with the recorded one gone: neither the dry run nor the apply can keep the groups as
  // registered, so both report the obsolete group as kept and leave it and the state's cache as they are.
  const { root, env } = await offWithoutPayload();
  rmSync(resolve(root, '.ia/src/extra-hooks.ia'));
  const other = { IA_HOST_HOME: resolve(env.IA_HOST_HOME, '..', 'other-home') },
    state = read(root, HOOK_STATE),
    groups = settings(root).hooks?.PreToolUse;
  const kept = [{ identity: SPEC_HOOK, word: 'hook', reason: HOOK_KEPT }];
  const preview = projection((await host(root, other, 'claude')).stdout);
  expect([preview.hooks, preview.unsupported]).toEqual([[], kept]);
  const applied = projection((await apply(root, other)).stdout);
  expect([applied.hooks, applied.unsupported]).toEqual([[], kept]);
  expect(read(root, HOOK_STATE)).toBe(state);
  expect(settings(root).hooks?.PreToolUse).toEqual(groups);
  expect(receipt(root).unsupported).toEqual(kept);
});
