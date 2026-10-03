/**
 * `ia host`: the acceptance of docs/specs/host-registration/README.md §10 that this verb alone can show —
 * items 1, 4, 5, 7 and 9, plus §3.3's home rule, §4's plan/apply and refusal shapes and §5.3's collision rule.
 * The last cases are §4's "install, update, remove": the refusal before any install write, the refresh after it,
 * and a refresh refused after the install committed.
 *
 * Every case sets IA_HOST_HOME (the alias for IA_HOME) to a scratch directory, so no test writes the real IA home. The one
 * case that starts the registered server clears NODE_OPTIONS, as tests/context-launcher.test.ts does: an inherited
 * --conditions=development would point the payload's packages at src/*.ts files the payload does not carry.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { WORKSPACE_PROJECTION_MARKER } from '@inventarch/compliance';
import { json } from '@inventarch/distribution/services';
import { runBounded } from '@tools/testing/subprocess.js';
import { GUARD_SCOPE, MACHINE_LOCAL, rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { cleanup, cli, DESCRIPTOR, packable, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
const read = (root: string, path: string): string => readFileSync(resolve(root, path), 'utf8');
async function initialized(): Promise<{ root: string; env: { IA_HOST_HOME: string } }> {
  const root = resolve(scratch('host'), 'demo'),
    env = { IA_HOST_HOME: scratch('host-home') };
  const result = await run(['init', root, '--apply', '--yes', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return { root, env };
}
const host = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['host', ...extra, '--root', root, '--json'], { env });
const human = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['host', ...extra, '--root', root], { env });
const element = (envelope: any, id: string): any => envelope.plan.elements.find((row: { id: string }) => row.id === id);

it('plans without writing, then registers a server that answers initialize', async () => {
  const { root, env } = await initialized();
  const planned = JSON.parse((await host(root, env, 'claude')).stdout);
  expect(planned).toMatchObject({ version: 1, command: 'host', root, host: 'claude', apply: false });
  expect(planned.plan.elements.map((row: { id: string }) => row.id)).toEqual(['mcp', 'hooks', 'context', 'projection']);
  expect(planned.plan.elements.map((row: { action: string }) => row.action)).toEqual([
    'create',
    'create',
    'none',
    'create',
  ]);
  expect(planned.plan.elements.map((row: { capability: string }) => row.capability)).toEqual([
    'registered',
    'registered',
    'not selected',
    'registered',
  ]);
  expect(planned.plan.elements.every((row: { conflict: unknown }) => row.conflict === null)).toBe(true);
  expect(planned.plan.undo).toBe('ia host claude --remove --apply');
  expect(planned.plan.release).toMatch(/^[a-f0-9]{64}$/);
  // A plan writes nothing: not the workspace, and not the payload either.
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
  expect(existsSync(resolve(root, '.claude'))).toBe(false);
  expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);

  const applied = await host(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  expect(envelope.applied).toEqual({
    status: 'host-registered',
    elements: [
      { id: 'mcp', status: 'host-active' },
      { id: 'hooks', status: 'guard-registered' },
      { id: 'context', status: 'not selected' },
      { id: 'projection', status: 'projected' },
    ],
    observed: false,
  });
  expect(existsSync(resolve(env.IA_HOST_HOME, 'hosts', envelope.plan.release, 'scripts/ia.mjs'))).toBe(true);
  expect(read(root, '.claude/rules/ia-workspace.md').split('\n')).toContain(WORKSPACE_PROJECTION_MARKER);
  expect(existsSync(resolve(root, '.claude/agents/demo-steward.md'))).toBe(true);
  // Host plugin distribution spec §10 (amends M5.3 §6.2): a steward is now projected for every admitted non-floor
  // system, authored or installed. The language base installs eleven systems (M5.3 §2.2, plus work-system since
  // docs/specs/work-system/README.md §9.2) plus this workspace's own starter system ("demo"), so a fresh
  // init yields 12 subagent files. Measured 2026-09-24 (11) and 2026-09-25 (12) with this test.
  expect(readdirSync(resolve(root, '.claude/agents')).sort()).toEqual([
    'demo-steward.md',
    'public-agent-composition-system-steward.md',
    'public-agent-system-steward.md',
    'public-authoring-system-steward.md',
    'public-compliance-system-steward.md',
    'public-governance-system-steward.md',
    'public-hook-authoring-system-steward.md',
    'public-learning-system-steward.md',
    'public-session-system-steward.md',
    'public-template-system-steward.md',
    'public-work-system-steward.md',
    'public-workspace-system-steward.md',
  ]);
  const guard = JSON.parse(read(root, '.claude/settings.local.json')).hooks.PreToolUse;
  expect(guard).toHaveLength(1);
  // Spec §5.1: guard mode with the explicit root, never claude-guard's CLAUDE_PROJECT_DIR. POSIX runs it through /bin/sh,
  // so that a guard that cannot run denies (#323); the launcher and its arguments close the argument vector either way.
  const guardArgs = guard[0].hooks[0].args.slice(-4);
  expect(guard[0].hooks[0].command).toBe(process.platform === 'win32' ? process.execPath : '/bin/sh');
  expect(guardArgs.slice(1, 3)).toEqual(['guard', '--root']);
  expect(realpathSync(guardArgs[3])).toBe(realpathSync(root));

  // §10 item 1: the exact recorded argument vector answers MCP initialize. This is test evidence; ia host never
  // claims it, which is why `observed` above is false.
  const entry = JSON.parse(read(root, '.mcp.json')).mcpServers['ia-workspace'];
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'host-test', version: '1' } },
  };
  const got = await runBounded(entry.command, entry.args, {
    input: JSON.stringify(initialize) + '\n',
    timeoutMs: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(got.status, got.stderr).toBe(0);
  const answer = JSON.parse(got.stdout.split('\n')[0]!);
  expect(answer.id).toBe(1);
  expect(answer.result.protocolVersion).toBe('2025-11-25');

  // A second apply converges: every element is unchanged and the payload is reused.
  const again = JSON.parse((await host(root, env, 'claude')).stdout);
  expect(again.plan.elements.map((row: { action: string }) => row.action)).toEqual([
    'unchanged',
    'unchanged',
    'none',
    'unchanged',
  ]);
});

it('answers door records through the materialized launcher with the bytes ia records prints (§10 item 2)', async () => {
  const { root, env } = await initialized();
  const applied = await host(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const launcher = resolve(env.IA_HOST_HOME, 'hosts', JSON.parse(applied.stdout).plan.release, 'scripts/ia.mjs');
  const door = await runBounded(process.execPath, [launcher, 'door', 'records', '--root', root], {
    timeoutMs: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(door.status, door.stderr).toBe(0);
  // `ia records` is the legacy route `dispatch` hands to `runCli` (apps/cli/src/main.ts).
  const { runCli } = await import('../src/main.js');
  const direct = runCli(['records', '--root', root]);
  expect(direct.exitCode).toBe(0);
  expect(JSON.parse(direct.stdout)).toMatchObject({ ok: true });
  expect(door.stdout).toBe(direct.stdout);
});

it('prints the machine-local sentence and never claims an observation', async () => {
  const { root, env } = await initialized();
  const preview = await human(root, env, 'claude');
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.replace(/\s+/g, ' ')).toContain(MACHINE_LOCAL.claude);
  expect(preview.stdout).toContain('This is a preview. Nothing has been written.');
  expect(preview.stdout.replace(/\s+/g, ' ')).toContain(
    'Claude Code asks for approval before starting a project MCP server.',
  );
  const applied = await human(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(applied.stdout).toContain('written; not observed answering');
  expect(applied.stdout.replace(/\s+/g, ' ')).toContain(MACHINE_LOCAL.claude);
  // Operator decision 2026-09-23: the guard's scope is disclosed wherever the hooks element is registered, and only there.
  expect(GUARD_SCOPE).toBe(
    "The steward guard denies file-tool edits to the files ia host owns and to records under .ia/src/systems/<name>/ unless the edit comes from that system's steward subagent (<name>-steward).",
  );
  expect(preview.stdout.replace(/\s+/g, ' ')).toContain(GUARD_SCOPE);
  expect(applied.stdout.replace(/\s+/g, ' ')).toContain(GUARD_SCOPE);
  expect(JSON.stringify(JSON.parse((await host(root, env, 'claude')).stdout))).not.toContain('steward guard');
  const codex = await human(root, env, 'codex');
  expect(codex.stdout.replace(/\s+/g, ' ')).toContain(MACHINE_LOCAL.codex);
  expect(codex.stdout.replace(/\s+/g, ' ')).not.toContain(GUARD_SCOPE);
  const removal = await human(root, env, 'claude', '--remove');
  expect(removal.exitCode, removal.stderr).toBe(0);
  expect(removal.stdout.replace(/\s+/g, ' ')).not.toContain(GUARD_SCOPE);
});

it('preserves unrelated settings and CLAUDE.md byte for byte, then removes exactly the owned set', async () => {
  const { root, env } = await initialized();
  // Two-space indentation and CRLF, so format preservation is exercised end to end rather than by value equality.
  const mcp =
    '{\r\n  "mcpServers": {\r\n    "other": {\r\n      "command": "x"\r\n    }\r\n  },\r\n  "note": 1\r\n}\r\n';
  // An unrelated hook group shares the PreToolUse array the guard group joins (§10 item 4).
  const settings =
    '{\r\n  "permissions": {\r\n    "allow": [\r\n      "Read"\r\n    ]\r\n  },\r\n  "hooks": {\r\n    "PreToolUse": [\r\n      {\r\n        "matcher": "Bash",\r\n        "hooks": [\r\n          {\r\n            "type": "command",\r\n            "command": "echo"\r\n          }\r\n        ]\r\n      }\r\n    ]\r\n  }\r\n}\r\n';
  put(root, '.mcp.json', mcp);
  put(root, '.claude/settings.local.json', settings);
  put(root, 'CLAUDE.md', 'mine\r\n');
  const lock = readFileSync(resolve(root, '.ia/distributions.lock.json'));
  // Installation data under .ia/distributions/, every file but the host area's, by content (§10 item 7).
  const data = (): Record<string, string> =>
    Object.fromEntries(
      (readdirSync(resolve(root, '.ia/distributions'), { recursive: true }) as string[])
        .map((path) => path.replaceAll('\\', '/'))
        .filter((path) => !path.startsWith('hosts') && statSync(resolve(root, '.ia/distributions', path)).isFile())
        .map((path) => [path, readFileSync(resolve(root, '.ia/distributions', path)).toString('base64')]),
    );
  const installed = data();
  const applied = await host(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const release = JSON.parse(applied.stdout).plan.release;
  expect(read(root, '.mcp.json')).toContain('"other": {\r\n      "command": "x"\r\n    }');
  expect(read(root, '.mcp.json')).toContain('ia-workspace');
  expect(read(root, '.claude/settings.local.json')).toContain('"allow": [\r\n      "Read"\r\n    ]');
  expect(
    JSON.parse(read(root, '.claude/settings.local.json')).hooks.PreToolUse.map(
      (group: { matcher: string }) => group.matcher,
    ),
  ).toEqual(['Bash', 'Write|Edit|MultiEdit']);
  expect(read(root, 'CLAUDE.md')).toBe('mine\r\n');

  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  const envelope = JSON.parse(removed.stdout);
  expect(envelope.plan.elements.map((row: { action: string }) => row.action)).toEqual([
    'remove',
    'remove',
    'none',
    'remove',
  ]);
  expect(envelope.applied).toEqual({
    status: 'host-removed',
    elements: [
      { id: 'projection', status: 'projection-removed' },
      { id: 'context', status: 'not selected' },
      { id: 'hooks', status: 'guard-removed' },
      { id: 'mcp', status: 'host-removed' },
    ],
    observed: false,
  });
  expect(read(root, '.mcp.json')).toBe(mcp);
  expect(read(root, '.claude/settings.local.json')).toBe(settings);
  expect(read(root, 'CLAUDE.md')).toBe('mine\r\n');
  for (const path of [
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.claude/agents/demo-steward.md',
  ])
    expect(existsSync(resolve(root, path)), path).toBe(false);
  expect(readdirSync(resolve(root, '.ia/distributions/hosts')).filter((name) => name !== 'lock.json')).toEqual([]);
  // §8: removal never touches the lock or the materialized payload.
  expect(readFileSync(resolve(root, '.ia/distributions.lock.json')).equals(lock)).toBe(true);
  expect(data()).toEqual(installed);
  expect(Object.keys(installed).length).toBeGreaterThan(0);
  expect(existsSync(resolve(env.IA_HOST_HOME, 'hosts', release, 'scripts/ia.mjs'))).toBe(true);

  // Removing what is not owned is a successful no-op.
  const empty = JSON.parse((await host(root, env, 'claude', '--remove', '--apply', '--yes')).stdout);
  expect(empty.plan.elements.map((row: { action: string }) => row.action)).toEqual(['none', 'none', 'none', 'none']);
  expect(empty.plan.elements.map((row: { capability: string }) => row.capability)).toEqual([
    'absent',
    'absent',
    'not selected',
    'absent',
  ]);
  expect(empty.applied.elements.map((row: { status: string }) => row.status)).toEqual([
    'absent',
    'not selected',
    'absent',
    'absent',
  ]);
});

it('refuses an unmanaged ia-workspace entry and an unmanaged rules file by name, and leaves both unchanged', async () => {
  const { root, env } = await initialized();
  const teammate = JSON.stringify({ mcpServers: { 'ia-workspace': { command: 'teammate' } } }) + '\n';
  put(root, '.mcp.json', teammate);
  const planned = await host(root, env, 'claude');
  expect(planned.exitCode).toBe(0);
  expect(element(JSON.parse(planned.stdout), 'mcp')).toMatchObject({
    action: 'refused',
    capability: 'refused',
    conflict: { code: 'IA-DIST-LOCAL-MODIFICATION', path: '.mcp.json' },
  });
  const refused = await host(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    exit: 3,
    where: { path: '.mcp.json' },
    next: rootedNext('Remove that entry, then run "ia host claude --apply".', 'claude', root),
  });
  expect(read(root, '.mcp.json')).toBe(teammate);
  // The refusal came before any write: no payload, no hook, no projection.
  expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);
  expect(existsSync(resolve(root, '.claude'))).toBe(false);

  const other = await initialized();
  put(other.root, '.claude/rules/ia-workspace.md', 'user\n');
  const rules = JSON.parse((await host(other.root, other.env, 'claude')).stdout);
  expect(element(rules, 'projection').conflict).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    path: '.claude/rules/ia-workspace.md',
  });
  const refusedRules = await host(other.root, other.env, 'claude', '--apply', '--yes');
  expect(JSON.parse(refusedRules.stdout)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: '.claude/rules/ia-workspace.md' },
  });
  expect(read(other.root, '.claude/rules/ia-workspace.md')).toBe('user\n');
  expect(existsSync(resolve(other.root, '.mcp.json'))).toBe(false);
});

it('reports a malformed .mcp.json as a conflict naming the file, not a crash', async () => {
  const { root, env } = await initialized();
  put(root, '.mcp.json', '{ "mcpServers": ');
  const planned = await host(root, env, 'claude');
  expect(planned.exitCode).toBe(0);
  expect(element(JSON.parse(planned.stdout), 'mcp')).toMatchObject({
    action: 'refused',
    conflict: { path: '.mcp.json' },
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(3);
  expect(read(root, '.mcp.json')).toBe('{ "mcpServers": ');
});

it('shows an unowned marked steward file in the plan without refusing it, and never touches it', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const stray = `---\nname: stray-steward\n---\n\n${WORKSPACE_PROJECTION_MARKER}\n\nFrom another clone.\n`;
  put(root, '.claude/agents/stray-steward.md', stray);
  const planned = JSON.parse((await host(root, env, 'claude')).stdout);
  const projection = element(planned, 'projection');
  expect(projection.conflict).toBeNull();
  expect(projection.action).toBe('unchanged');
  expect(projection.files).toContainEqual({ path: '.claude/agents/stray-steward.md', action: 'unowned' });
  expect(projection.paths).not.toContain('.claude/agents/stray-steward.md');
  const preview = await human(root, env, 'claude');
  expect(preview.stdout).toContain('.claude/agents/stray-steward.md');
  expect(preview.stdout).toContain('unowned');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect(read(root, '.claude/agents/stray-steward.md')).toBe(stray);
});

it('writes codex rows only and reports hooks unsupported; --context is refused', async () => {
  const { root, env } = await initialized();
  const applied = await host(root, env, 'codex', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  expect(element(envelope, 'hooks')).toMatchObject({ action: 'none', capability: 'unsupported by host', paths: [] });
  expect(element(envelope, 'context')).toMatchObject({ action: 'none', capability: 'unsupported by host' });
  expect(envelope.applied.elements).toEqual([
    { id: 'mcp', status: 'host-active' },
    { id: 'hooks', status: 'unsupported by host' },
    { id: 'context', status: 'unsupported by host' },
    { id: 'projection', status: 'projected' },
  ]);
  expect(read(root, '.codex/config.toml')).toContain('ia-workspace');
  expect(read(root, 'AGENTS.md').split('\n')).toContain(WORKSPACE_PROJECTION_MARKER);
  expect(existsSync(resolve(root, '.agents/skills/ia-authoring/SKILL.md'))).toBe(true);
  for (const path of ['.mcp.json', '.claude']) expect(existsSync(resolve(root, path)), path).toBe(false);
  expect((await host(root, env, 'codex', '--context', 'x/y')).exitCode).toBe(2);
  const context = await host(root, env, 'claude', '--context', 'x/y');
  expect(context.exitCode).toBe(3);
  expect(JSON.parse(context.stdout)).toMatchObject({ ok: false, code: 'IA-DIST-HOST-UNSUPPORTED' });
  expect((await host(root, env, 'claude', '--context', 'x/y', '--remove')).exitCode).toBe(2);
  expect((await host(root, env, 'emacs')).exitCode).toBe(2);
  const removed = await host(root, env, 'codex', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  for (const path of ['AGENTS.md', '.agents/skills/ia-authoring/SKILL.md'])
    expect(existsSync(resolve(root, path)), path).toBe(false);
});

it('refuses an unmanaged Codex ia-workspace table by name and leaves the file unchanged', async () => {
  const { root, env } = await initialized();
  const teammate = '[mcp_servers."ia-workspace"]\ncommand = "teammate"\n';
  put(root, '.codex/config.toml', teammate);
  expect(element(JSON.parse((await host(root, env, 'codex')).stdout), 'mcp')).toMatchObject({
    action: 'refused',
    conflict: { code: 'IA-DIST-LOCAL-MODIFICATION', path: '.codex/config.toml' },
  });
  const refused = await host(root, env, 'codex', '--apply', '--yes');
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: rootedNext(
      'Remove any ia-workspace server outside the IA block from .codex/config.toml and make sure the file parses as TOML, then run "ia host codex --apply".',
      'codex',
      root,
    ),
  });
  expect(read(root, '.codex/config.toml')).toBe(teammate);
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
});

it('refuses a workspace inside the host home, a host home inside the workspace and a relative home', async () => {
  const { root } = await initialized();
  for (const home of [dirname(root), resolve(root, '.ia/host-home')]) {
    const refused = await host(root, { IA_HOST_HOME: home }, 'claude');
    expect(refused.exitCode, home).toBe(3);
    const body = JSON.parse(refused.stdout);
    expect(body).toMatchObject({ ok: false, code: 'IA-DIST-PATH-UNSAFE', exit: 3 });
    expect(body.next).toMatch(/IA_HOME/);
  }
  expect(existsSync(resolve(dirname(root), 'hosts'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/host-home'))).toBe(false);
  const relative = JSON.parse((await host(root, { IA_HOST_HOME: 'relative/home' }, 'claude')).stdout);
  expect(relative).toMatchObject({ ok: false, code: 'IA-DIST-INPUT-INVALID', exit: 3 });
  expect(relative.next).toMatch(/absolute directory/);
});

it('refuses at plan time when the IA home contains src/, in plan and apply alike', async () => {
  const { root, env } = await initialized();
  mkdirSync(resolve(env.IA_HOST_HOME, 'src'), { recursive: true });
  const remedy = `Move ${join(env.IA_HOST_HOME, 'src')} out of the IA home, or set IA_HOME to another absolute directory.`;
  for (const extra of [[], ['--apply', '--yes']]) {
    const refused = JSON.parse((await host(root, env, 'claude', ...extra)).stdout);
    expect(refused, extra.join(' ')).toMatchObject({ ok: false, code: 'IA-DIST-PATH-UNSAFE', exit: 3 });
    expect(refused.next).toBe(remedy);
  }
  expect(existsSync(resolve(env.IA_HOST_HOME, 'hosts'))).toBe(false);
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
});

it('refuses a host home reached through a link or junction, naming a remedy, and writes nothing', async () => {
  const { root } = await initialized();
  const real = scratch('host-home-real'),
    linked = resolve(scratch('host-home-link'), 'home');
  // A junction needs no privilege on Windows; elsewhere the type is ignored and a directory symlink is made.
  symlinkSync(real, linked, 'junction');
  for (const extra of [[], ['--apply', '--yes']]) {
    const refused = await host(root, { IA_HOST_HOME: linked }, 'claude', ...extra);
    expect(refused.exitCode, extra.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'IA-DIST-PATH-UNSAFE',
      exit: 3,
      next: 'Set IA_HOME to a directory path with no links, or unset it.',
    });
  }
  expect(readdirSync(real)).toEqual([]);
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
});

/**
 * Plan/apply parity: the preview's conflict is the verifying planner's own refusal. The payload is materialized here
 * through the service, so `planHost` against the real cache can be asked what it refuses, and the preview — which
 * never materializes — must report exactly that code and message, as must `--apply`.
 */
async function parity(
  root: string,
  env: { IA_HOST_HOME: string },
  name: 'claude' | 'codex',
  path: string,
): Promise<void> {
  const planned = await host(root, env, name);
  expect(planned.exitCode).toBe(0);
  const conflict = element(JSON.parse(planned.stdout), 'mcp').conflict;
  expect(conflict).toMatchObject({ path });
  const { readHostPin, materializeHostPayload } = await import('@inventarch/distribution/host-home');
  const { planHost } = await import('@inventarch/distribution/host');
  const bundled = readHostPin(cli);
  const cache = materializeHostPayload({
    home: env.IA_HOST_HOME,
    archive: bundled.archive(),
    pin: bundled.pin,
  }).directory;
  let raised: { code?: string; message?: string } = {};
  try {
    planHost(realpathSync(root), name, cache);
  } catch (error) {
    raised = error as typeof raised;
  }
  expect({ code: conflict.code, message: conflict.reason }).toEqual({ code: raised.code, message: raised.message });
  const applied = await host(root, env, name, '--apply', '--yes');
  expect(applied.exitCode).toBe(3);
  expect(JSON.parse(applied.stdout)).toMatchObject({
    ok: false,
    exit: 3,
    code: raised.code,
    message: raised.message,
    where: { path },
  });
}
it.each([
  ['an array of mcp_servers tables', '[[mcp_servers]]\ncommand = "x"\n'],
  ['invalid TOML', 'model = \n'],
])('reports %s in .codex/config.toml as the conflict apply raises', async (_name, text) => {
  const { root, env } = await initialized();
  put(root, '.codex/config.toml', text);
  await parity(root, env, 'codex', '.codex/config.toml');
  expect(read(root, '.codex/config.toml')).toBe(text);
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
});
it('reports a hardlinked or oversized .mcp.json as the conflict apply raises', async () => {
  const linked = await initialized();
  put(linked.root, 'mine.json', '{}\n');
  linkSync(resolve(linked.root, 'mine.json'), resolve(linked.root, '.mcp.json'));
  await parity(linked.root, linked.env, 'claude', '.mcp.json');
  const large = await initialized();
  const oversized = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) + '\n';
  put(large.root, '.mcp.json', oversized);
  await parity(large.root, large.env, 'claude', '.mcp.json');
  expect(read(large.root, '.mcp.json')).toBe(oversized);
});

it('names the restore remedy for a modified owned entry and removes one the user deleted', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const modified = JSON.parse(read(root, '.mcp.json'));
  modified.mcpServers['ia-workspace'].args.push('--extra');
  put(root, '.mcp.json', JSON.stringify(modified, null, 2) + '\n');
  const planned = element(JSON.parse((await host(root, env, 'claude')).stdout), 'mcp');
  expect(planned.conflict).toMatchObject({ code: 'IA-DIST-LOCAL-MODIFICATION', path: '.mcp.json' });
  const refused = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(refused.next).toBe(
    rootedNext(
      'Delete the ia-workspace entry in .mcp.json, then run "ia host claude --remove --apply" and "ia host claude --apply".',
      'claude',
      root,
    ),
  );
  // The user deletes the owned entry and the owned guard group instead: removal takes only the ownership state.
  delete modified.mcpServers['ia-workspace'];
  const kept = JSON.stringify(modified, null, 2) + '\n';
  put(root, '.mcp.json', kept);
  put(root, '.claude/settings.local.json', '{}\n');
  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).applied.elements).toEqual([
    { id: 'projection', status: 'projection-removed' },
    { id: 'context', status: 'not selected' },
    { id: 'hooks', status: 'guard-removed' },
    { id: 'mcp', status: 'host-removed' },
  ]);
  expect(read(root, '.mcp.json')).toBe(kept);
  expect(read(root, '.claude/settings.local.json')).toBe('{}\n');
  expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json'))).toBe(false);
});

async function hostContext(root: string, env: { IA_HOST_HOME: string }, ...extra: string[]) {
  const { parseArguments } = await import('../src/args.js');
  const { findCommand } = await import('../src/commands.js');
  const { makeHost } = await import('./workspace-fixture.js');
  const { resolveCapabilities } = await import('../src/render.js');
  const command = findCommand('host')!;
  return {
    host: makeHost({ env }),
    command,
    args: parseArguments(['claude', ...extra, '--root', root, '--apply', '--yes'], command.grammar),
    caps: resolveCapabilities({ env: {}, isTTY: false }),
    json: true,
  };
}
type Raised = { code?: string; next?: string | null; where?: { path?: string } | null };
async function cutAfterMcp(root: string, env: { IA_HOST_HOME: string }, cut: () => void): Promise<Raised> {
  const { collectHost, applyHostSet } = await import('../src/host.js');
  const context = await hostContext(root, env);
  try {
    applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
      if (id === 'mcp') cut();
    });
  } catch (error) {
    return error as Raised;
  }
  return {};
}
it('names the rerun after a failure past the first element, the lock recovery, or the recovery a pending journal needs', async () => {
  // The settings file changes once mcp is written, so the guard's plan is stale: the rerun finishes the set.
  const { root, env } = await initialized();
  const stale = await cutAfterMcp(root, env, () =>
    put(root, '.claude/settings.local.json', '{\n  "permissions": {}\n}\n'),
  );
  expect(stale).toMatchObject({
    code: 'IA-DIST-PLAN-STALE',
    next: rootedNext('Run "ia host claude --apply" to finish.', 'claude', root),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, '.claude/settings.local.json')).permissions).toEqual({});
  // Another transaction takes the host lock once mcp is written: the lock's recovery decides whether it is live.
  const lock = resolve(root, '.ia/distributions/hosts/lock.json');
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  const busy = await cutAfterMcp(root, env, () => writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n'));
  expect(busy).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    where: { path: '.ia/distributions/hosts/lock.json' },
    next: lockNext(root),
  });
  rmSync(lock);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // A journal left pending names its recovery instead.
  const other = await initialized();
  const pending = await cutAfterMcp(other.root, other.env, () =>
    writeFileSync(resolve(other.root, '.ia/distributions/hosts/guard-pending.json'), '{}\n'),
  );
  expect(pending).toMatchObject({
    code: 'IA-DIST-RECOVERY-REQUIRED',
    where: { path: '.ia/distributions/hosts/guard-pending.json' },
  });
  expect(pending.next).toBe(
    rootedNext(
      `Run "ia-distribution recover-guard --root ${quote(other.root)}", then rerun "ia host claude".`,
      'claude',
      other.root,
    ),
  );
});

/** A pid no process holds: a child that has already exited. The lock a killed run leaves names one like it. */
const deadPid = (): number =>
  spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '' } }).pid!;
const HOST_LOCK = '.ia/distributions/hosts/lock.json';
const lockNext = (root: string): string =>
  `Another ia host run holds the host lock, or a killed run left it: run "ia-distribution recover-host --root ${quote(root)}" (it clears a dead holder's lock and refuses a live one), then rerun.`;
it('names recover-host for a leftover host lock in apply, removal and doctor, and the named recovery converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, HOST_LOCK, JSON.stringify({ pid: deadPid() }) + '\n');
  for (const extra of [[], ['--remove']]) {
    const refused = await host(root, env, 'claude', ...extra, '--apply', '--yes');
    expect(refused.exitCode, extra.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'IA-DIST-INSTALL-BUSY',
      exit: 3,
      where: { path: HOST_LOCK },
      next: lockNext(root),
    });
  }
  const held = await doctor(root, env);
  expect(row(held.checks, 'host-lock')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining(`${HOST_LOCK} is held by another ia host run or was left by a killed one`),
    remedy: `ia-distribution recover-host --root ${quote(root)}`,
  });
  // A held lock is a warning, not a failure: a live run holds it too.
  expect(held.exitCode).toBe(0);
  // Followed literally: the recovery clears a dead holder's lock, and the rerun converges.
  const { recoverHost } = await import('@inventarch/distribution/host');
  expect(recoverHost(root).status).toBe('current');
  expect(existsSync(resolve(root, HOST_LOCK))).toBe(false);
  expect(row((await doctor(root, env)).checks, 'host-lock')).toMatchObject({
    status: 'info',
    detail: 'Not held',
    remedy: null,
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // A live holder is refused by the same recovery, so the next action is right either way.
  put(root, HOST_LOCK, JSON.stringify({ pid: process.pid }) + '\n');
  expect(() => recoverHost(root)).toThrow(/still running/);
  rmSync(resolve(root, HOST_LOCK));
});

it('names the host lock recovery when an install refresh finds the lock held', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, HOST_LOCK, JSON.stringify({ pid: deadPid() }) + '\n');
  const refused = await install('--apply', '--yes', '--json');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    where: { path: HOST_LOCK },
    next: `The installation is applied. ${lockNext(root)}`,
  });
  const { recoverHost } = await import('@inventarch/distribution/host');
  expect(recoverHost(root).status).toBe('current');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
});

it('reports each pending host journal as a failure naming its own recovery', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const journals = [
    ['pending.json', 'recover-host'],
    ['guard-pending.json', 'recover-guard'],
    ['lifecycle-pending.json', 'recover-lifecycle'],
  ] as const;
  for (const [file, command] of journals) {
    const path = `.ia/distributions/hosts/${file}`;
    put(root, path, '{}\n');
    const report = await doctor(root, env);
    expect(report.exitCode, file).toBe(1);
    expect(row(report.checks, `host-journal:${path}`)).toMatchObject({
      status: 'fail',
      detail: `${path} exists; an ia host transaction was interrupted`,
      remedy: `ia-distribution ${command} --root ${quote(root)}`,
    });
    // ia host names the same recovery.
    expect(JSON.parse((await host(root, env, 'claude')).stdout)).toMatchObject({
      code: 'IA-DIST-RECOVERY-REQUIRED',
      where: { path },
    });
    rmSync(resolve(root, path));
  }
  expect((await doctor(root, env)).checks.filter((check) => check.id.startsWith('host-journal:'))).toEqual([]);
});

/**
 * §10 item 8 at the CLI: an interruption at each sub-transaction boundary, then the rerun, ends byte for byte where an
 * uninterrupted apply ends. The reference is taken in the same workspace, because every owned entry embeds the root.
 */
it('converges byte for byte after an interruption at each apply and removal boundary', async () => {
  const { root, env } = await initialized();
  const { collectHost, applyHostSet } = await import('../src/host.js');
  const managed = [
    '.mcp.json',
    '.claude/settings.local.json',
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.claude/agents/demo-steward.md',
    '.ia/distributions/hosts/claude-workspace.json',
    '.ia/distributions/hosts/claude-guard-workspace.json',
    '.ia/distributions/hosts/claude-projection.json',
  ];
  const snapshot = (): (string | null)[] =>
    managed.map((path) => (existsSync(resolve(root, path)) ? read(root, path) : null));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const reference = snapshot();
  expect(reference.every((bytes) => bytes !== null)).toBe(true);
  for (const cut of ['mcp', 'hooks'] as const) {
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
    const context = await hostContext(root, env);
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect(existsSync(resolve(root, '.claude/settings.local.json')), cut).toBe(cut === 'hooks');
    expect(existsSync(resolve(root, '.claude/rules/ia-workspace.md')), cut).toBe(false);
    // No journal is left at a boundary, so the rerun alone finishes the set.
    expect(
      readdirSync(resolve(root, '.ia/distributions/hosts')).filter(
        (name) => name.endsWith('pending.json') || name === 'lock.json',
      ),
      cut,
    ).toEqual([]);
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
    const report = await doctor(root, env);
    expect(row(report.checks, 'host-claude')?.status, cut).toBe('ok');
    expect(
      report.checks.filter((check) => check.id.startsWith('projection-claude:')),
      cut,
    ).toEqual([]);
  }
  // Removal runs projection, hooks, mcp; cut after either of the first two, the rerun removes exactly the rest.
  for (const cut of ['projection', 'hooks'] as const) {
    const context = await hostContext(root, env, '--remove');
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(managed.map(() => null));
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
  }
});

type Row = { id: string; status: string; detail: string; remedy: string | null };
const doctor = async (root: string, env: Record<string, string>) => {
  const result = await run(['doctor', '--root', root, '--json'], { env });
  return { exitCode: result.exitCode, checks: JSON.parse(result.stdout).checks as Row[] };
};
const row = (checks: readonly Row[], id: string): Row | undefined => checks.find((check) => check.id === id);
/** Doctor was given --root, so each command it prints carries it, in the form `ia init --host` uses (rootedNext). */
const rootedApply = (root: string, name = 'claude'): string => `ia host ${name} --root ${quote(root)} --apply`;

it('doctor reports registered, then stale after a simulated upgrade, and projection drift', async () => {
  const { root, env } = await initialized();
  // No host state at all is a note, never a verdict (spec §7 `absent`).
  const none = await doctor(root, env);
  expect(none.exitCode).toBe(0);
  // Given --root, each command it names carries it; discovered from the cwd, neither does.
  expect(row(none.checks, 'host')).toMatchObject({
    status: 'info',
    detail: `No host registered; run "ia host claude --root ${quote(root)}" or "ia host codex --root ${quote(root)}" to plan one`,
  });
  const unrooted = JSON.parse((await run(['doctor', '--json'], { env, cwd: root })).stdout).checks as Row[];
  expect(row(unrooted, 'host')).toMatchObject({
    status: 'info',
    detail: 'No host registered; run "ia host claude" or "ia host codex" to plan one',
  });
  expect(row(none.checks, 'host-lock')).toMatchObject({ status: 'info', detail: 'Not held', remedy: null });
  expect(row(none.checks, 'host-payload')).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('not materialized'),
  });

  const release = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).plan.release as string;
  const registered = await doctor(root, env);
  expect(registered.exitCode).toBe(0);
  expect(row(registered.checks, 'host-claude')).toMatchObject({
    status: 'ok',
    remedy: null,
    detail: expect.stringContaining('registered (mcp, hooks, projection); written; not observed answering; cache '),
  });
  expect(row(registered.checks, 'host')).toBeUndefined();
  expect(row(registered.checks, 'host-payload')!.detail).toBe(
    `Release ${release.slice(0, 12)}, present in ${resolve(env.IA_HOST_HOME, 'hosts')}`,
  );
  expect(registered.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([]);
  // §3.3: an unfinished `.stage-*` materialization is never listed as a payload; another release's directory is.
  mkdirSync(resolve(env.IA_HOST_HOME, 'hosts', '.stage-interrupted'));
  mkdirSync(resolve(env.IA_HOST_HOME, 'hosts', 'a'.repeat(64)));
  expect(row((await doctor(root, env)).checks, 'host-payload')!.detail).toBe(
    `Release ${release.slice(0, 12)}, present in ${resolve(env.IA_HOST_HOME, 'hosts')}; 1 other payload there: ${'a'.repeat(12)}`,
  );

  // A simulated upgrade: the state pins another release, in the encoding the mechanisms write (§7 `stale`, REQ-HRC-5).
  const state = resolve(root, '.ia/distributions/hosts/claude-workspace.json'),
    kept = read(root, '.ia/distributions/hosts/claude-workspace.json');
  writeFileSync(state, json({ ...JSON.parse(kept), release: '0'.repeat(64) }));
  const stale = await doctor(root, env);
  expect(stale.exitCode).toBe(1);
  expect(row(stale.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (release'),
  });
  expect(row(stale.checks, 'host-claude')!.detail).toContain(`this installation pins ${release.slice(0, 12)}`);
  // Discovered from the cwd rather than given, the root is not repeated in the remedy.
  const discovered = JSON.parse((await run(['doctor', '--json'], { env, cwd: root })).stdout).checks as Row[];
  expect(row(discovered, 'host-claude')!.remedy).toBe('ia host claude --apply');
  // §10 item 3's second half: the remedy alone, re-applying, restores `registered` and the bytes a fresh apply wrote.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const restored = await doctor(root, env);
  expect(restored.exitCode).toBe(0);
  expect(row(restored.checks, 'host-claude')!.status).toBe('ok');
  expect(read(root, '.ia/distributions/hosts/claude-workspace.json')).toBe(kept);

  // A payload that no longer verifies is named as such, not as a release mismatch.
  const launcher = resolve(env.IA_HOST_HOME, 'hosts', release, 'scripts/ia.mjs'),
    original = readFileSync(launcher);
  writeFileSync(launcher, Buffer.concat([original, Buffer.from('\n// edited\n')]));
  const unverified = row((await doctor(root, env)).checks, 'host-claude')!;
  expect(unverified.detail).toContain('stale (launcher-unverified');
  expect(unverified.detail).toContain(
    `the payload at ${resolve(env.IA_HOST_HOME, 'hosts', release)} fails verification`,
  );
  writeFileSync(launcher, original);

  // A hand edit to a projected file is `changed`, which apply refuses; the row names the same repair `ia host` does.
  put(root, '.claude/rules/ia-workspace.md', read(root, '.claude/rules/ia-workspace.md') + 'edit\n');
  const drifted = await doctor(root, env);
  expect(drifted.exitCode).toBe(1);
  expect(row(drifted.checks, 'host-claude')!.status).toBe('ok');
  expect(row(drifted.checks, 'projection-claude:.claude/rules/ia-workspace.md')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('changed'),
    remedy: rootedApply(root),
  });
  expect(row(drifted.checks, 'projection-claude:.claude/rules/ia-workspace.md')!.detail).toContain(
    'move or delete it, then run the remedy',
  );
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).next).toBe(
    `Move or delete .claude/rules/ia-workspace.md, then run "${rootedApply(root)}".`,
  );
  rmSync(resolve(root, '.claude/rules/ia-workspace.md'));
  expect(row((await doctor(root, env)).checks, 'projection-claude:.claude/rules/ia-workspace.md')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('missing'),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // Doctor never writes: a clean report leaves every managed file as the apply left it.
  const managed = [
    '.mcp.json',
    '.claude/settings.local.json',
    '.claude/rules/ia-workspace.md',
    '.ia/distributions/hosts/claude-workspace.json',
  ];
  const before = managed.map((path) => read(root, path));
  expect((await doctor(root, env)).exitCode).toBe(0);
  expect(managed.map((path) => read(root, path))).toEqual(before);
});

it('reports a newly authored local system as outdated and missing projection files, and the rerun clears both (§10 item 6)', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // The starter's own declaration shape under a new name and steward, as a user authoring a second system writes it.
  const { starterSystem } = await import('../src/init.js');
  put(root, '.ia/src/systems/extra/system.ia', starterSystem('extra'));
  const authored = await doctor(root, env);
  // The workspace still admits: the drift is the projection's, not the records'.
  expect(row(authored.checks, 'records')).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining(', 0 errors,'),
  });
  // Every projected file embeds the source revision, so each existing one is outdated; the new steward's is missing.
  const drifted = authored.checks.filter((check) => check.id.startsWith('projection-claude:'));
  expect(drifted).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'projection-claude:.claude/rules/ia-workspace.md',
        status: 'warn',
        detail: expect.stringContaining('outdated'),
      }),
      expect.objectContaining({
        id: 'projection-claude:.claude/agents/extra-steward.md',
        status: 'warn',
        detail: expect.stringContaining('missing'),
      }),
    ]),
  );
  expect(drifted.every((check) => check.status === 'warn' && /\b(outdated|missing)\b/.test(check.detail))).toBe(true);
  expect(authored.exitCode).toBe(0);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(read(root, '.claude/rules/ia-workspace.md')).toContain('extra-steward');
  expect(existsSync(resolve(root, '.claude/agents/extra-steward.md'))).toBe(true);
  const cleared = await doctor(root, env);
  expect(cleared.exitCode).toBe(0);
  expect(cleared.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([]);
});

it('names the unreadable ownership file and a repair that converges, in ia host and doctor alike', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);

  // The MCP ownership state: ia host refuses at that file, and doctor reports it stale without throwing.
  const state = '.ia/distributions/hosts/claude-workspace.json';
  put(root, state, 'garbage\n');
  const repair = `Delete ${state} and the ia-workspace entry in .mcp.json, then run "ia host claude --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout)).toMatchObject({
    ok: false,
    where: { path: state },
    next: rootedNext(repair, 'claude', root),
  });
  const broken = await doctor(root, env);
  expect(broken.exitCode).toBe(1);
  const claude = row(broken.checks, 'host-claude')!;
  expect(claude).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (state-invalid)'),
  });
  expect(claude.detail).toContain(rootedNext(repair, 'claude', root));
  // The named repair, followed literally, converges.
  rmSync(resolve(root, state));
  const mcp = JSON.parse(read(root, '.mcp.json'));
  delete mcp.mcpServers['ia-workspace'];
  put(root, '.mcp.json', JSON.stringify(mcp, null, 2) + '\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // The guard's ownership state: the same shape of repair, naming the guard group.
  const guard = '.ia/distributions/hosts/claude-guard-workspace.json';
  put(root, guard, 'garbage\n');
  const guardRepair = `Delete ${guard} and the IA guard group in .claude/settings.local.json, then run "ia host claude --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout)).toMatchObject({
    ok: false,
    where: { path: guard },
    next: rootedNext(guardRepair, 'claude', root),
  });
  expect(row((await doctor(root, env)).checks, 'host-claude')!.detail).toContain(
    rootedNext(guardRepair, 'claude', root),
  );
  rmSync(resolve(root, guard));
  const settings = JSON.parse(read(root, '.claude/settings.local.json'));
  settings.hooks.PreToolUse = [];
  put(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2) + '\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // An unreadable projection state is a fail row of its own, never an exception; deleting it is the repair.
  put(root, '.ia/distributions/hosts/claude-projection.json', 'garbage\n');
  const projection = await doctor(root, env);
  expect(projection.exitCode).toBe(1);
  expect(row(projection.checks, 'projection-claude')).toMatchObject({ status: 'fail', remedy: rootedApply(root) });
  rmSync(resolve(root, '.ia/distributions/hosts/claude-projection.json'));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // A .mcp.json that no longer parses asks for valid JSON first, as ia host does; deleting an entry is not the repair.
  const kept = read(root, '.mcp.json');
  put(root, '.mcp.json', '{ not json\n');
  expect(row((await doctor(root, env)).checks, 'host-claude')!.detail).toContain(
    `Make .mcp.json parse as JSON, then run "${rootedApply(root)}".`,
  );
  put(root, '.mcp.json', kept);
  expect((await doctor(root, env)).exitCode).toBe(0);
});

it('doctor warns when a registration pins its payload outside the IA home, and re-applying clears it', async () => {
  // Host plugin distribution spec §3: registered before the move, under what stands in for M5.3's per-OS directory.
  const { root } = await initialized();
  const data = scratch('legacy-data'),
    before = { IA_HOST_HOME: join(data, 'ia') };
  expect((await host(root, before, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const moved = { IA_HOME: resolve(scratch('moved-home'), '.ia'), LOCALAPPDATA: data, XDG_DATA_HOME: data };
  const report = JSON.parse((await run(['doctor', '--json'], { env: moved, cwd: root })).stdout);
  const warning = row(report.checks, 'ia-home-moved-claude')!;
  expect(warning).toMatchObject({ status: 'warn', remedy: 'ia host claude --apply' });
  expect(warning.detail).toMatch(/^Host claude pins its payload under .+, outside the IA home /);
  expect(warning.detail).toContain(`outside the IA home ${moved.IA_HOME}`);
  // legacyHostHome reads LOCALAPPDATA on win32 and XDG_DATA_HOME on Linux; macOS derives it from the user's home.
  if (process.platform !== 'darwin') expect(warning.detail).toMatch(/ \(the M5\.3 per-OS location\)$/);
  // The registration still works, so doctor warns rather than fails; the briefing names the same remedy.
  expect(row(report.checks, 'host-claude')!.status).toBe('ok');
  expect(report.counts.fail).toBe(0);
  const briefed = JSON.parse((await run(['doctor', '--host', 'claude', '--json'], { env: moved, cwd: root })).stdout);
  expect(briefed.session.notice).toBe(
    'IA: the Claude host registration for this workspace is stale; run ia host claude --apply',
  );
  // Given --root, the remedy carries it, as every other ia host remedy doctor prints does.
  expect(row((await doctor(root, moved)).checks, 'ia-home-moved-claude')!.remedy).toBe(rootedApply(root));

  expect((await host(root, moved, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const after = JSON.parse((await run(['doctor', '--json'], { env: moved, cwd: root })).stdout);
  expect(row(after.checks, 'ia-home-moved-claude')).toBeUndefined();
  expect(row(after.checks, 'host-claude')!.status).toBe('ok');
});

it('doctor fails a forged registration and a vanished Node executable, and each named repair converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const state = '.ia/distributions/hosts/claude-workspace.json';
  // Rewrites the recorded server in the ownership state and in .mcp.json alike, so the file matches what the state claims.
  const rewrite = (server: { command: string; args: string[] }): void => {
    const config = JSON.parse(read(root, '.mcp.json'));
    config.mcpServers['ia-workspace'] = server;
    put(root, '.mcp.json', JSON.stringify(config, null, 2) + '\n');
    put(root, state, json({ ...JSON.parse(read(root, state)), owned: json(server) }));
  };
  const recorded = JSON.parse(read(root, '.mcp.json')).mcpServers['ia-workspace'] as {
    command: string;
    args: string[];
  };
  rewrite({ command: resolve(root, 'tools/run.cmd'), args: ['--anything'] });
  const forged = await doctor(root, env);
  expect(forged.exitCode).toBe(1);
  expect(row(forged.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('stale (mcp-modified)'),
  });
  expect(row(forged.checks, 'host-claude')!.detail).toContain(
    rootedNext(
      'Delete the ia-workspace entry in .mcp.json, then run "ia host claude --remove --apply" and "ia host claude --apply".',
      'claude',
      root,
    ),
  );
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // A Node executable that is gone (an upgrade moved it): the remedy alone records the running one.
  rewrite({ ...recorded, command: resolve(scratch('gone-node'), basename(process.execPath)) });
  const moved = await doctor(root, env);
  expect(moved.exitCode).toBe(1);
  expect(row(moved.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (node-missing)'),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);
  expect(JSON.parse(read(root, '.mcp.json')).mcpServers['ia-workspace']).toEqual(recorded);
});

it('names the whole Codex IA block as the repair for an edit inside it, and the repair converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  const config = read(root, '.codex/config.toml');
  put(
    root,
    '.codex/config.toml',
    config.replace('[mcp_servers."ia-workspace"]\n', '[mcp_servers."ia-workspace"]\nstartup_timeout_sec = 30\n'),
  );
  const block =
    'Delete the IA block in .codex/config.toml, from "# BEGIN IA PROJECTION host-workspace" through "# END IA PROJECTION host-workspace", markers included';
  const next = `${block}, then run "ia host codex --remove --apply" and "ia host codex --apply".`;
  expect(JSON.parse((await host(root, env, 'codex', '--apply', '--yes')).stdout)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: rootedNext(next, 'codex', root),
  });
  const stale = await doctor(root, env);
  expect(stale.exitCode).toBe(1);
  const codex = row(stale.checks, 'host-codex')!;
  expect(codex).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root, 'codex'),
    detail: expect.stringContaining('stale (mcp-modified)'),
  });
  expect(codex.detail).toContain(rootedNext(next, 'codex', root));
  expect(codex.detail).not.toMatch(
    /claude-guard|claude-workspace|claude-projection|\.mcp\.json|settings\.local|ia host claude/,
  );
  // Followed literally: the markers and everything between them go, then removal and registration.
  const edited = read(root, '.codex/config.toml');
  const from = edited.indexOf('# BEGIN IA PROJECTION host-workspace'),
    through = edited.indexOf('# END IA PROJECTION host-workspace\n') + '# END IA PROJECTION host-workspace\n'.length;
  put(root, '.codex/config.toml', edited.slice(0, from) + edited.slice(through));
  expect((await host(root, env, 'codex', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  const healed = await doctor(root, env);
  expect(row(healed.checks, 'host-codex')!.status).toBe('ok');
  expect(healed.exitCode).toBe(0);

  // Codex's unreadable ownership state names Codex's own files only.
  put(root, '.ia/distributions/hosts/codex-workspace.json', 'garbage\n');
  const invalid = row((await doctor(root, env)).checks, 'host-codex')!;
  expect(invalid.detail).toContain(
    'Delete .ia/distributions/hosts/codex-workspace.json and the IA block in .codex/config.toml',
  );
  expect(invalid.detail).not.toMatch(
    /claude-guard|claude-workspace|claude-projection|\.mcp\.json|settings\.local|ia host claude/,
  );
});

it('doctor notes an installation without a host payload and still observes the host', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const { dispatch } = await import('../src/consumer.js');
  const { makeHost } = await import('./workspace-fixture.js');
  const result = await dispatch(
    ['doctor', '--root', root, '--json'],
    { ...makeHost({ env }), packageRoot: scratch('bare-package') },
    () => ({ exitCode: 2, stdout: '' }),
    [],
  );
  const checks = JSON.parse(result.stdout).checks as Row[];
  expect(row(checks, 'host-payload')).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('carries no host payload (IA-DIST-ARTIFACT-UNAVAILABLE)'),
  });
  // Without a pin the release comparison is skipped, so the registration is still `ok`.
  expect(row(checks, 'host-claude')!.status).toBe('ok');
  expect(result.exitCode).toBe(0);
});

it('names --root in every ia host next action only when the invocation gave it, in JSON and human output alike', async () => {
  const { root, env } = await initialized();
  put(root, '.claude/rules/ia-workspace.md', 'user\n');
  const bare = 'Move or delete .claude/rules/ia-workspace.md, then run "ia host claude --apply".';
  const rooted = `Move or delete .claude/rules/ia-workspace.md, then run "ia host claude --root ${quote(root)} --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).next).toBe(rooted);
  const humanRefusal = await human(root, env, 'claude', '--apply', '--yes');
  expect(humanRefusal.exitCode).toBe(3);
  expect(humanRefusal.stderr.replace(/\s+/g, ' ')).toContain(rooted);
  // The preview's conflict row prints the same next action the refusal carries, and its undo line carries the root;
  // the JSON plan's `undo` stays the unrooted command (§4 `--json`).
  // A command too long for the line is broken with a trailing `\` (§6.4), which a reader's shell joins back.
  const joined = (text: string): string => text.replace(/ \\\r?\n\s*/g, ' ').replace(/\s+/g, ' ');
  const preview = joined((await human(root, env, 'claude')).stdout);
  expect(preview).toContain(rooted);
  expect(preview).toContain(`Undo with "ia host claude --root ${quote(root)} --remove --apply".`);
  expect(JSON.parse((await host(root, env, 'claude')).stdout).plan.undo).toBe('ia host claude --remove --apply');
  expect(joined((await run(['host', 'claude'], { env, cwd: root })).stdout)).toContain(
    'Undo with "ia host claude --remove --apply".',
  );
  // A discovered root prints the bare command: it runs from the same cwd.
  const discovered = await run(['host', 'claude', '--apply', '--yes', '--json'], { env, cwd: root });
  expect(JSON.parse(discovered.stdout).next).toBe(bare);
  // Refusals raised before a plan exists carry the root too.
  const gated = await host(root, env, 'claude', '--context', 'x');
  expect(JSON.parse(gated.stdout).next).toBe(`Run "ia host claude --root ${quote(root)}" without --context.`);
});

it('refuses an uninitialized root', async () => {
  const root = scratch('host-empty');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  const refused = await run(['host', 'claude', '--root', root, '--json'], {
    env: { IA_HOST_HOME: scratch('host-home') },
  });
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-CLI-CONFLICT',
    next: 'Run "ia init" first.',
  });
});

/**
 * Spec §4 "install, update, remove": a workspace offered fixture/foundation, packed from the loop fixture, and a
 * request set naming only it. Applying the set replaces the bundled base, so the projection's "Installed
 * distributions" section must change. The two cannot be installed side by side: both ship agent-system. A second
 * package, fixture/extra, is the same distribution under another id, so it installs beside fixture/foundation and can
 * be removed from it. Both archives are packed once for the file and copied into each workspace.
 */
const CATALOG = '.ia/work/catalog.json',
  REQUESTS = '.ia/work/requests.json',
  LOCK = '.ia/distributions.lock.json',
  RULES = '.claude/rules/ia-workspace.md',
  PROJECTION_STATE = '.ia/distributions/hosts/claude-projection.json';
async function packAs(id: string): Promise<string> {
  const source = packable();
  put(source, '.ia/work/descriptor.json', JSON.stringify({ ...DESCRIPTOR, id }) + '\n');
  const packed = await run(['pack', '--root', source, '--descriptor', '.ia/work/descriptor.json', '--json']);
  expect(packed.exitCode, packed.stderr).toBe(0);
  return resolve(source, '.ia/work/dist', (JSON.parse(packed.stdout) as { path: string }).path);
}
let packedArchives: Promise<readonly string[]> | undefined;
const fixtureArchives = (): Promise<readonly string[]> =>
  (packedArchives ??= Promise.all([packAs('fixture/foundation'), packAs('fixture/extra')]));
async function offered(): Promise<{
  root: string;
  env: { IA_HOST_HOME: string };
  install: (...extra: string[]) => ReturnType<typeof run>;
}> {
  const { root, env } = await initialized();
  // The starter requires work-system, which fixture/foundation (the loop fixture) does not ship. A consumer who
  // replaces the bundled base with a foundation lacking it must drop the requirement first, or admission refuses.
  const starter = '.ia/src/systems/demo/system.ia',
    text = read(root, starter);
  expect(text).toContain('    - work-system\n');
  put(root, starter, text.replace('    - work-system\n', ''));
  mkdirSync(resolve(root, '.ia/work/dist'), { recursive: true });
  const entries = (await fixtureArchives()).map((archive) => {
    copyFileSync(archive, resolve(root, '.ia/work/dist', basename(archive)));
    return { path: `.ia/work/dist/${basename(archive)}`, withdrawn: false };
  });
  put(root, CATALOG, JSON.stringify(entries) + '\n');
  put(root, REQUESTS, JSON.stringify([{ id: 'fixture/foundation', range: '^0.1.0' }]) + '\n');
  const install = (...extra: string[]) =>
    run(['install', '--requests', REQUESTS, '--catalog', CATALOG, '--root', root, ...extra], { env });
  return { root, env, install };
}
const installedSection = (root: string): string =>
  read(root, RULES).split('## Installed distributions')[1]!.split('##')[0]!.trim();
const lockedIds = (root: string): string[] =>
  JSON.parse(read(root, LOCK)).packages.map((pkg: { id: string }) => pkg.id);
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const projectionRows = async (root: string, env: Record<string, string>) => {
  const doctor = await run(['doctor', '--root', root, '--json'], { env });
  return {
    exitCode: doctor.exitCode,
    rows: (JSON.parse(doctor.stdout).checks as { id: string; status: string; detail: string }[]).filter((check) =>
      check.id.startsWith('projection-'),
    ),
  };
};

it('names registered projections in the plan only when one is registered, and refreshes them after apply', async () => {
  const { root, env, install } = await offered();
  // Nothing registered: the plan says nothing about a refresh, in either form.
  expect(JSON.parse((await install('--json')).stdout).refresh).toBeUndefined();
  expect((await install()).stdout).not.toContain('Registered host projections');

  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // The bundled base, named from the lock: the pin is its id's only authority (apps/cli/SPEC.md C08).
  const [base] = JSON.parse(read(root, LOCK)).packages as { id: string; version: string }[];
  expect(installedSection(root)).toBe(`- ${base!.id} ${base!.version}`);
  expect(JSON.parse((await install('--json')).stdout).refresh).toEqual(['claude']);
  expect(flat((await install()).stdout)).toContain('Registered host projections (claude) are refreshed after apply.');

  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  // `applied` is exactly applyInstallation's return, its host literal included (contract §2.8).
  expect(Object.keys(envelope.applied).sort()).toEqual(['counter', 'generation', 'host', 'status']);
  expect(envelope.applied).toMatchObject({ status: 'installed', host: 'pending' });
  expect(envelope.refresh).toEqual(['claude']);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });

  // Human output of an applied update: what was refreshed, never "configured".
  const updated = await run(
    ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
    { env },
  );
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(flat(updated.stdout)).toContain(
    'Registered host projections (claude) were refreshed; run "ia doctor" for host state.',
  );
  expect(updated.stdout).not.toContain('configured');

  // An applied removal refreshes too: install the second package beside the first, then remove it.
  expect(
    (await run(['install', 'fixture/extra@^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'], { env }))
      .exitCode,
  ).toBe(0);
  expect(installedSection(root)).toBe('- fixture/extra 0.1.0\n- fixture/foundation 0.1.0');
  const removed = await run(['remove', 'fixture/extra', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).refresh).toEqual(['claude']);
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });
});

it('refuses an install before touching the lock when a registered projection was edited by hand', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, RULES, read(root, RULES) + 'hand\n');
  const lock = readFileSync(resolve(root, LOCK));
  const cache = readdirSync(resolve(root, '.ia/distributions/cache'));
  const next = rootedNext(`Move or delete ${RULES}, then run "ia host claude --apply".`, 'claude', root);
  for (const refused of [
    await install('--apply', '--yes', '--json'),
    await run(['remove', lockedIds(root)[0]!, '--root', root, '--apply', '--yes', '--json'], { env }),
  ]) {
    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'IA-DIST-LOCAL-MODIFICATION',
      exit: 3,
      where: { path: RULES },
      next,
    });
  }
  // Nothing was acquired or written: the lock is byte for byte, the cache holds no new archive.
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  expect(readdirSync(resolve(root, '.ia/distributions/cache'))).toEqual(cache);
  expect(read(root, RULES).endsWith('hand\n')).toBe(true);
  // A preview is a report, not an apply: it still plans.
  expect((await install()).exitCode).toBe(0);
  // Without --root, the remedy is the bare command, as from the cwd it runs in.
  const discovered = await run(
    ['install', '--requests', REQUESTS, '--catalog', CATALOG, '--apply', '--yes', '--json'],
    { env, cwd: root },
  );
  expect(JSON.parse(discovered.stdout).next).toBe(`Move or delete ${RULES}, then run "ia host claude --apply".`);
});

it('locates an unreadable managed file or ownership state at that file, and each named repair converges', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const lock = readFileSync(resolve(root, LOCK));

  // A hardlinked rules file: the refusal names it, not the ownership state, and so does doctor.
  linkSync(resolve(root, RULES), resolve(scratch('host-alias'), 'alias.md'));
  const aliased = await install('--apply', '--yes', '--json');
  expect(aliased.exitCode).toBe(3);
  expect(JSON.parse(aliased.stdout)).toMatchObject({
    code: 'IA-DIST-PATH-UNSAFE',
    where: { path: RULES },
    next: rootedNext(`Move or delete ${RULES}, then run "ia host claude --apply".`, 'claude', root),
  });
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  const doctor = await projectionRows(root, env);
  expect(doctor.exitCode).toBe(1);
  expect(doctor.rows).toEqual([
    expect.objectContaining({
      id: `projection-claude:${RULES}`,
      status: 'fail',
      detail: expect.stringContaining(`${RULES} cannot be read (IA-DIST-PATH-UNSAFE)`),
    }),
  ]);
  // Followed literally: with the file deleted, the install applies and its refresh writes the file again.
  rmSync(resolve(root, RULES));
  expect((await install('--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');

  // An ownership state that cannot be read: its own repair, located at it.
  put(root, PROJECTION_STATE, 'garbage\n');
  const garbage = await run(
    [
      'update',
      'fixture/foundation',
      '--to',
      '^0.1.0',
      '--catalog',
      CATALOG,
      '--root',
      root,
      '--apply',
      '--yes',
      '--json',
    ],
    { env },
  );
  expect(garbage.exitCode).toBe(3);
  expect(JSON.parse(garbage.stdout)).toMatchObject({
    where: { path: PROJECTION_STATE },
    next: rootedNext(`Delete ${PROJECTION_STATE}, then run "ia host claude --apply".`, 'claude', root),
  });
  rmSync(resolve(root, PROJECTION_STATE));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(
    (
      await run(
        ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
        { env },
      )
    ).exitCode,
  ).toBe(0);
});

it('refuses at class 3 naming the applied install when its projection refresh is refused, and the repair converges', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // An authored system the projection has not rendered yet, and the user's own file where its steward would go.
  // The pre-check sees no hand edit — the file is not one this workspace's projection owns — so the install applies,
  // and the refresh then refuses the unmanaged file rather than replace it (§6.3).
  put(
    root,
    '.ia/src/systems/extra/system.ia',
    [
      '#! ia 1.0',
      '',
      '@system extra',
      '  provider "local"',
      '  version "0.1.0"',
      '  describes "An extra authored system."',
      '  steward @agent extra-steward',
      '  requires',
      '    - agent-system',
      '',
      '@agent extra-steward',
      '  meaning',
      '    says "Owns the extra system."',
      '    answers "Who owns this system?"',
      '  governance',
      '    applies []',
      '',
    ].join('\n'),
  );
  const mine = '.claude/agents/extra-steward.md';
  put(root, mine, 'mine\n');
  const rules = read(root, RULES),
    active = read(root, '.ia/distributions/active.json');
  const next = rootedNext(
    `The installation is applied. Move or delete ${mine}, then run "ia host claude --apply".`,
    'claude',
    root,
  );
  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(3);
  expect(JSON.parse(applied.stdout)).toEqual({
    version: 1,
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    message: expect.stringContaining('Refusing unmanaged file at a managed path'),
    exit: 3,
    where: { path: mine, line: null, identity: null },
    next,
  });
  // The install is committed; the projection is exactly as it was, and the user's file untouched.
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(read(root, '.ia/distributions/active.json')).not.toBe(active);
  expect(read(root, RULES)).toBe(rules);
  expect(read(root, mine)).toBe('mine\n');
  // Doctor reports the drift the refusal left behind.
  expect((await projectionRows(root, env)).rows).toContainEqual(
    expect.objectContaining({ id: `projection-claude:${RULES}`, status: 'warn' }),
  );

  // The human form: the error block on stderr names the file and says the installation is applied.
  const human = await run(
    ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
    { env },
  );
  expect(human.exitCode).toBe(3);
  expect(human.stdout).toBe('');
  expect(flat(human.stderr)).toContain('IA-DIST-LOCAL-MODIFICATION');
  expect(flat(human.stderr)).toContain(next);

  // The named repair, followed literally, finishes the refresh.
  rmSync(resolve(root, mine));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(existsSync(resolve(root, mine))).toBe(true);
  expect((await projectionRows(root, env)).rows).toEqual([]);
});
