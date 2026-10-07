/**
 * Host registration acceptance: plans, ownership, Claude/Codex configuration and path refusals.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WORKSPACE_PROJECTION_MARKER } from '@inventarch/compliance';
import { runBounded } from '@tools/testing/subprocess.js';
import { GUARD_SCOPE, MACHINE_LOCAL, rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { cli, run, scratch } from './workspace-fixture.js';
import { put, read, initialized, host, human, element } from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

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
    expect(body.next).toBe(
      `Move the workspace, or set IA_HOME to an absolute directory outside it; then run "ia host claude --root ${quote(root)}".`,
    );
  }
  expect(existsSync(resolve(dirname(root), 'hosts'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/host-home'))).toBe(false);
  const relative = JSON.parse((await host(root, { IA_HOST_HOME: 'relative/home' }, 'claude')).stdout);
  expect(relative).toMatchObject({ ok: false, code: 'IA-DIST-INPUT-INVALID', exit: 3 });
  expect(relative.next).toBe(
    `Set IA_HOME to an absolute directory, or unset it to use ~/.ia; then run "ia host claude --root ${quote(root)}".`,
  );
});

it('refuses at plan time when the IA home contains src/, in plan and apply alike', async () => {
  const { root, env } = await initialized();
  mkdirSync(resolve(env.IA_HOST_HOME, 'src'), { recursive: true });
  const remedy = `Move ${join(env.IA_HOST_HOME, 'src')} out of the IA home, or set IA_HOME to another absolute directory; then run "ia host claude --root ${quote(root)}".`;
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
      next: `Set IA_HOME to a directory path with no links, or unset it; then run "ia host claude --root ${quote(root)}".`,
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
      'Delete the ia-workspace entry in .mcp.json, then run "ia host claude --remove --apply" and register again.',
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
    // The root the refused invocation named, so the init it names targets the same directory.
    next: `Run "ia init ${quote(realpathSync(root))}" first.`,
  });
});
