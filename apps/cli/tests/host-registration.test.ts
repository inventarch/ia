/**
 * Host registration acceptance: plans, ownership, Claude/Codex configuration and path refusals.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  renameSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PACKET_MARKER } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { GUARD_RETIRED, GUARD_SCOPE, MACHINE_LOCAL, rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { cli, run, scratch } from './workspace-fixture.js';
import {
  put,
  read,
  initialized,
  host,
  human,
  element,
  GUARD_STATE,
  guardGroups,
  LEGACY_FILES,
  LEGACY_MARKER,
  legacyGuard,
  legacyRegistration,
  RECEIPT,
  STEWARD,
} from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

/**
 * A seam on apps/distribution's applyProjection, which writes and deletes every projection file, so a test can fail
 * the first file change of a real `ia host` apply at its `pending` stage. Every call passes through.
 */
const seams = vi.hoisted(() => ({
  failAt: undefined as string | undefined,
  afterOpen: undefined as ((path: unknown, fd: number) => void) | undefined,
  beforeOpen: undefined as ((path: unknown) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      seams.beforeOpen?.(args[0]);
      const fd = actual.openSync(...args);
      seams.afterOpen?.(args[0], fd);
      return fd;
    },
  };
});
vi.mock('@inventarch/distribution/projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/distribution/projection')>();
  return {
    ...actual,
    applyProjection: (plan: Parameters<typeof actual.applyProjection>[0], checkpoint?: (name: string) => void) =>
      actual.applyProjection(plan, (name) => {
        if (name === seams.failAt) throw new Error('file write failed');
        checkpoint?.(name);
      }),
  };
});

it('plans without writing, then registers a server that answers initialize', async () => {
  const { root, env } = await initialized();
  const planned = JSON.parse((await host(root, env, 'claude')).stdout);
  expect(planned).toMatchObject({ version: 1, command: 'host', root, host: 'claude', apply: false });
  // Milestone position-packet (B11): ia host registers no steward guard, so the plan has no hooks element.
  expect(planned.plan.elements.map((row: { id: string }) => row.id)).toEqual(['mcp', 'context', 'projection']);
  expect(planned.plan.elements.map((row: { action: string }) => row.action)).toEqual(['create', 'none', 'create']);
  expect(planned.plan.elements.map((row: { capability: string }) => row.capability)).toEqual([
    'registered',
    'not selected',
    'registered',
  ]);
  expect(element(planned, 'projection')).toMatchObject({
    guard: 'none',
    paths: ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'],
  });
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
      { id: 'context', status: 'not selected' },
      { id: 'projection', status: 'projected', guard: 'none' },
    ],
    observed: false,
  });
  expect(existsSync(resolve(env.IA_HOST_HOME, 'hosts', envelope.plan.release, 'scripts/ia.mjs'))).toBe(true);
  // The position packet's consumer files, and no per-system agent: the stewards are pointer lines (design §4).
  expect(read(root, '.claude/rules/ia-workspace.md').split('\n')).toContain(PACKET_MARKER);
  expect(read(root, '.claude/rules/ia-workspace.md')).toContain('# IA position packet: demo');
  expect(existsSync(resolve(root, '.claude/agents'))).toBe(false);
  // No guard is registered (B11), so the settings file is not written at all.
  expect(existsSync(resolve(root, '.claude/settings.local.json'))).toBe(false);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  // B12: the receipt beside the projection state names each file it wrote with the digest of its bytes.
  const receipt = JSON.parse(read(root, RECEIPT)),
    version = (JSON.parse(readFileSync(resolve(cli, 'package.json'), 'utf8')) as { version: string }).version;
  expect(receipt).toMatchObject({
    format: 'ia.packet-receipt.v1',
    host: 'claude',
    cli: `@inventarch/cli@${version}`,
    slug: 'demo',
    removed: [],
    foreign: [],
    guard: 'none',
  });
  expect(new Date(receipt.writtenAt).toISOString()).toBe(receipt.writtenAt);
  expect(receipt.files).toEqual(
    ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'].map((path) => ({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    })),
  );

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
  expect(again.plan.elements.map((row: { action: string }) => row.action)).toEqual(['unchanged', 'none', 'unchanged']);
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
  // Operator decision 2026-10-08 (B11): the guard's retirement is disclosed wherever Claude is registered, and only there.
  expect(GUARD_SCOPE).toBe(
    'ia host registers no steward guard, and applying the projection retires one an earlier release registered: with no per-system steward subagents left, it would deny every edit under .ia/src/systems/<name>/. Until a later release re-keys the guard to @mandate scope, nothing blocks those edits.',
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
  // No guard group joins the user's own (B11): the settings file is not touched.
  expect(read(root, '.claude/settings.local.json')).toBe(settings);
  expect(read(root, 'CLAUDE.md')).toBe('mine\r\n');

  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  const envelope = JSON.parse(removed.stdout);
  expect(envelope.plan.elements.map((row: { action: string }) => row.action)).toEqual(['remove', 'none', 'remove']);
  expect(envelope.applied).toEqual({
    status: 'host-removed',
    elements: [
      { id: 'projection', status: 'projection-removed', guard: 'none' },
      { id: 'context', status: 'not selected' },
      { id: 'mcp', status: 'host-removed' },
    ],
    observed: false,
  });
  expect(read(root, '.mcp.json')).toBe(mcp);
  expect(read(root, '.claude/settings.local.json')).toBe(settings);
  expect(read(root, 'CLAUDE.md')).toBe('mine\r\n');
  for (const path of ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'])
    expect(existsSync(resolve(root, path)), path).toBe(false);
  // The removal deletes the receipt too (B12), so the hosts area holds nothing but the lock file.
  expect(readdirSync(resolve(root, '.ia/distributions/hosts')).filter((name) => name !== 'lock.json')).toEqual([]);
  // §8: removal never touches the lock or the materialized payload.
  expect(readFileSync(resolve(root, '.ia/distributions.lock.json')).equals(lock)).toBe(true);
  expect(data()).toEqual(installed);
  expect(Object.keys(installed).length).toBeGreaterThan(0);
  expect(existsSync(resolve(env.IA_HOST_HOME, 'hosts', release, 'scripts/ia.mjs'))).toBe(true);

  // Removing what is not owned is a successful no-op.
  const empty = JSON.parse((await host(root, env, 'claude', '--remove', '--apply', '--yes')).stdout);
  expect(empty.plan.elements.map((row: { action: string }) => row.action)).toEqual(['none', 'none', 'none']);
  expect(empty.plan.elements.map((row: { capability: string }) => row.capability)).toEqual([
    'absent',
    'not selected',
    'absent',
  ]);
  expect(empty.applied.elements.map((row: { status: string }) => row.status)).toEqual([
    'absent',
    'not selected',
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

it('lists a steward file the state does not own as foreign, marked or not, never refusing or touching it', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const stray = `---\nname: stray-steward\n---\n\n${LEGACY_MARKER}\n\nFrom another clone.\n`,
    mine = '---\nname: x\n---\n\nMy own reviewer.\n';
  put(root, '.claude/agents/stray-steward.md', stray);
  put(root, '.claude/agents/x.md', mine);
  const planned = JSON.parse((await host(root, env, 'claude')).stdout);
  const projection = element(planned, 'projection');
  expect(projection.conflict).toBeNull();
  expect(projection.action).toBe('unchanged');
  expect(projection.files).toContainEqual({ path: '.claude/agents/stray-steward.md', action: 'foreign' });
  expect(projection.files).toContainEqual({ path: '.claude/agents/x.md', action: 'foreign' });
  expect(projection.paths).not.toContain('.claude/agents/stray-steward.md');
  const preview = await human(root, env, 'claude');
  expect(preview.stdout).toContain('.claude/agents/stray-steward.md');
  expect(preview.stdout).toContain('foreign');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, RECEIPT)).foreign).toEqual(['.claude/agents/stray-steward.md', '.claude/agents/x.md']);
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect(read(root, '.claude/agents/stray-steward.md')).toBe(stray);
  expect(read(root, '.claude/agents/x.md')).toBe(mine);
});

it('writes codex rows only and reports hooks unsupported; --context is refused', async () => {
  const { root, env } = await initialized();
  const applied = await host(root, env, 'codex', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  expect(element(envelope, 'hooks')).toBeUndefined();
  expect(element(envelope, 'context')).toMatchObject({ action: 'none', capability: 'unsupported by host' });
  expect(envelope.applied.elements).toEqual([
    { id: 'mcp', status: 'host-active' },
    { id: 'context', status: 'unsupported by host' },
    { id: 'projection', status: 'projected', guard: 'none' },
  ]);
  expect(read(root, '.codex/config.toml')).toContain('ia-workspace');
  expect(read(root, 'AGENTS.md').split('\n')).toContain(PACKET_MARKER);
  expect(JSON.parse(read(root, '.ia/distributions/hosts/codex-receipt.json'))).toMatchObject({ host: 'codex' });
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
  for (const path of [
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
    '.ia/distributions/hosts/codex-receipt.json',
  ])
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
  // The user deletes the owned entry instead: removal takes only the ownership state.
  delete modified.mcpServers['ia-workspace'];
  const kept = JSON.stringify(modified, null, 2) + '\n';
  put(root, '.mcp.json', kept);
  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).applied.elements).toEqual([
    { id: 'projection', status: 'projection-removed', guard: 'none' },
    { id: 'context', status: 'not selected' },
    { id: 'mcp', status: 'host-removed' },
  ]);
  expect(read(root, '.mcp.json')).toBe(kept);
  expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'))).toBe(false);
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

/**
 * Milestone position-packet's upgrade path (plan amendments B9, B11 and B12): a workspace a 1.x `ia host claude --apply`
 * registered — the steward guard's group in .claude/settings.local.json and its ownership state, and a projection state
 * listing demo-steward.md with that marked file — upgrades in place through `ia host claude --apply`.
 */
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
it('upgrades a registered 1.x workspace: retires the guard, deletes the steward file, keeps a foreign one, writes the receipt', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  expect(guardGroups(root)).toBe(1);
  put(root, '.claude/agents/x.md', 'my own agent\n');
  // The plan lists the retirement and each file action, and writes nothing.
  const planned = JSON.parse((await host(root, env, 'claude')).stdout);
  expect(element(planned, 'hooks')).toBeUndefined();
  expect(element(planned, 'projection')).toMatchObject({
    action: 'update',
    guard: 'retire',
    conflict: null,
    files: [
      { path: STEWARD, action: 'remove' },
      { path: '.claude/agents/x.md', action: 'foreign' },
      { path: '.claude/rules/ia-workspace.md', action: 'update' },
      { path: '.claude/skills/ia-authoring/SKILL.md', action: 'update' },
    ],
  });
  expect((await human(root, env, 'claude')).stdout.replace(/\s+/g, ' ')).toContain(
    'first retires the steward guard registered in .claude/settings.local.json',
  );
  expect(guardGroups(root)).toBe(1);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);

  const applied = await human(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stderr).toBe(0);
  // The result reports the retirement; the guard group and its state file are gone.
  expect(applied.stdout.replace(/\s+/g, ' ')).toContain(GUARD_RETIRED);
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  // The owned 1.x steward file is deleted and the receipt lists it; the unmarked one is left and listed foreign.
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(read(root, '.claude/agents/x.md')).toBe('my own agent\n');
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({
    guard: 'retired',
    removed: [{ path: STEWARD, sha256: sha(LEGACY_FILES[STEWARD]!) }],
    foreign: ['.claude/agents/x.md'],
  });
  for (const path of ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'])
    expect(read(root, path).split('\n'), path).toContain(PACKET_MARKER);
  // Converged: nothing is left to retire or delete, and the JSON report says so.
  const again = await host(root, env, 'claude', '--apply', '--yes');
  expect(JSON.parse(again.stdout).applied.elements).toContainEqual({
    id: 'projection',
    status: 'projected',
    guard: 'none',
  });
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({
    guard: 'none',
    removed: [],
    foreign: ['.claude/agents/x.md'],
  });
});

it('retires the guard before any projection file changes: a failing file write leaves it retired and the steward file in place', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  // The first file change of `ia host claude --apply` fails; the guard retirement has already run.
  seams.failAt = 'pending';
  let failed: Awaited<ReturnType<typeof host>>;
  try {
    failed = await host(root, env, 'claude', '--apply', '--yes');
  } finally {
    seams.failAt = undefined;
  }
  expect(failed.exitCode, failed.stdout).toBe(3);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    message: 'file write failed',
    next: rootedNext('Run "ia host claude --apply" to finish.', 'claude', root),
  });
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  expect(read(root, '.claude/rules/ia-workspace.md')).toBe(LEGACY_FILES['.claude/rules/ia-workspace.md']);
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
  // The rerun converges: nothing is left to retire, and the steward file goes now.
  const rerun = await host(root, env, 'claude', '--apply', '--yes');
  expect(rerun.exitCode, rerun.stdout).toBe(0);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'retired', removed: [{ path: STEWARD }] });
});

it('plans an update for a projection whose files are current when its receipt is missing or a guard is left to retire', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const projection = async () => element(JSON.parse((await host(root, env, 'claude')).stdout), 'projection');
  expect(await projection()).toMatchObject({ action: 'unchanged', guard: 'none' });
  // Every apply writes the receipt (B12), so a missing one is a change though no file is.
  rmSync(resolve(root, RECEIPT));
  const missing = await projection();
  expect(missing).toMatchObject({ action: 'update', guard: 'none' });
  expect(missing.files.map((file: { action: string }) => file.action)).toEqual(['unchanged', 'unchanged']);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'none' });
  expect(await projection()).toMatchObject({ action: 'unchanged' });
  // A retirement is a change (B11): a guard registration over current files plans an update, and the apply retires it.
  legacyGuard(root, env);
  expect(await projection()).toMatchObject({ action: 'update', guard: 'retire' });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(guardGroups(root)).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'retired', removed: [] });
  // A removal that finds only a receipt removes it.
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  put(root, RECEIPT, '{}\n');
  const removal = element(JSON.parse((await host(root, env, 'claude', '--remove')).stdout), 'projection');
  expect(removal).toMatchObject({ action: 'remove', guard: 'none', paths: [] });
});

it('retires the guard on removal too, and removes the 1.x files the state owns', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  put(root, '.claude/agents/x.md', 'my own agent\n');
  const removed = await host(root, env, 'claude', '--remove', '--apply', '--yes');
  expect(removed.exitCode, removed.stdout).toBe(0);
  const envelope = JSON.parse(removed.stdout);
  expect(element(envelope, 'projection')).toMatchObject({ action: 'remove', guard: 'retire' });
  expect(envelope.applied.elements[0]).toEqual({ id: 'projection', status: 'projection-removed', guard: 'retired' });
  expect(guardGroups(root)).toBe(0);
  for (const path of [...Object.keys(LEGACY_FILES), GUARD_STATE, RECEIPT])
    expect(existsSync(resolve(root, path)), path).toBe(false);
  expect(read(root, '.claude/agents/x.md')).toBe('my own agent\n');
});

it('refuses a retirement it cannot plan at the settings file, naming the repair for a changed group or unreadable settings', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  const settings = JSON.parse(read(root, '.claude/settings.local.json'));
  settings.hooks.PreToolUse[0].timeout = 99;
  put(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2) + '\n');
  expect(element(JSON.parse((await host(root, env, 'claude')).stdout), 'projection')).toMatchObject({
    action: 'refused',
    conflict: { code: 'IA-DIST-LOCAL-MODIFICATION', path: '.claude/settings.local.json' },
  });
  const changed = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(changed).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: '.claude/settings.local.json' },
    next: rootedNext(
      'Delete only the IA guard group in .claude/settings.local.json, then run "ia host claude --apply".',
      'claude',
      root,
    ),
  });
  put(root, '.claude/settings.local.json', '{ not json\n');
  const unreadable = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(unreadable).toMatchObject({
    where: { path: '.claude/settings.local.json' },
    next: rootedNext('Fix .claude/settings.local.json, then run "ia host claude --apply".', 'claude', root),
  });
  // Nothing changed: the steward file and the guard's state are where the 1.x registration left them.
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(true);
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
});

it.each(['.claude/settings.local.json', '.claude/settings.json'])(
  'refuses an orphan guard in %s before deleting agents and follows the exact repair',
  async (settings) => {
    const { root, env } = await initialized();
    legacyRegistration(root, env);
    const old = JSON.parse(read(root, '.claude/settings.local.json'));
    const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo safe' }] };
    old.hooks.PreToolUse.push(unrelated);
    put(root, settings, JSON.stringify(old, null, 2) + '\n');
    if (settings !== '.claude/settings.local.json') rmSync(resolve(root, '.claude/settings.local.json'));
    rmSync(resolve(root, GUARD_STATE));
    const failed = await host(root, env, 'claude', '--apply', '--yes');
    expect(failed.exitCode, failed.stdout).toBe(3);
    const refusal = JSON.parse(failed.stdout);
    expect(refusal.where).toMatchObject({ path: settings });
    expect(refusal.next).toBe(
      rootedNext(`Delete only the IA guard group in ${settings}, then run "ia host claude --apply".`, 'claude', root),
    );
    expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
    old.hooks.PreToolUse = [unrelated];
    put(root, settings, JSON.stringify(old, null, 2) + '\n');
    const repaired = read(root, settings);
    const command = refusal.next.match(/"([^"]+)"/)[1];
    expect((await run(command.split(' ').slice(1).concat('--yes', '--json'), { env })).exitCode).toBe(0);
    expect(read(root, settings)).toBe(repaired);
    expect(existsSync(resolve(root, STEWARD))).toBe(false);
  },
);

it.each(['replacement', 'hardlink', 'ancestor'])(
  'rejects receipt %s races against the opened handle without changing bytes',
  async (kind) => {
    const { preflightReceipt } = await import('../src/host-projection.js');
    const root = scratch('receipt-race'),
      target = resolve(root, RECEIPT);
    put(root, RECEIPT, 'receipt before');
    let opened: number | undefined;
    seams.beforeOpen = (path) => {
      if (path === target && kind === 'ancestor') {
        renameSync(dirname(target), `${dirname(target)}-before`);
        put(root, RECEIPT, 'replacement receipt');
      }
    };
    seams.afterOpen = (path, fd) => {
      if (path !== target || opened !== undefined) return;
      opened = fd;
      if (kind === 'hardlink') linkSync(target, resolve(root, 'second-name'));
      else if (kind === 'replacement') {
        renameSync(target, `${target}.before`);
        put(root, RECEIPT, 'replacement receipt');
      }
    };
    try {
      expect(() => preflightReceipt(root, 'claude')).toThrow('Expected an unaliased receipt');
    } finally {
      seams.afterOpen = undefined;
      seams.beforeOpen = undefined;
    }
    expect(opened).toBeTypeOf('number');
    expect(() => fstatSync(opened!)).toThrow(); // Every refusal closes the descriptor.
    expect(read(root, RECEIPT)).toBe(kind === 'hardlink' ? 'receipt before' : 'replacement receipt');
    expect(
      readFileSync(
        kind === 'ancestor'
          ? `${dirname(target)}-before/claude-receipt.json`
          : kind === 'replacement'
            ? `${target}.before`
            : resolve(root, 'second-name'),
        'utf8',
      ),
    ).toBe('receipt before');
  },
);

it('refuses a replaced receipt ancestor even when the destination does not yet exist', async () => {
  const { preflightReceipt } = await import('../src/host-projection.js');
  const root = scratch('receipt-missing-race'),
    target = resolve(root, RECEIPT);
  mkdirSync(dirname(target), { recursive: true });
  seams.beforeOpen = (path) => {
    if (path !== target) return;
    renameSync(dirname(target), `${dirname(target)}-before`);
    symlinkSync(`${dirname(target)}-before`, dirname(target), 'junction');
  };
  try {
    expect(() => preflightReceipt(root, 'claude')).toThrow('Expected an unaliased receipt');
  } finally {
    seams.beforeOpen = undefined;
  }
  expect(existsSync(target)).toBe(false);
});

it('preflights receipt files without truncation and refuses static hardlinks and linked ancestors', async () => {
  const { preflightReceipt } = await import('../src/host-projection.js');
  const root = scratch('receipt-links'),
    target = resolve(root, RECEIPT);
  put(root, RECEIPT, 'unchanged receipt');
  preflightReceipt(root, 'claude');
  expect(read(root, RECEIPT)).toBe('unchanged receipt');
  linkSync(target, `${target}.alias`);
  expect(() => preflightReceipt(root, 'claude')).toThrow('Expected an unaliased receipt');
  rmSync(`${target}.alias`);
  renameSync(dirname(target), `${dirname(target)}-real`);
  symlinkSync(`${dirname(target)}-real`, dirname(target), 'junction');
  expect(() => preflightReceipt(root, 'claude')).toThrow('Expected an unaliased receipt');
  expect(read(root, RECEIPT)).toBe('unchanged receipt');
});

it('rejects an unusable receipt destination before retiring the guard or changing a projection', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  mkdirSync(resolve(root, RECEIPT));
  const failed = await host(root, env, 'claude', '--apply', '--yes');
  expect(failed.exitCode, failed.stdout).toBe(3);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    where: { path: RECEIPT },
    next: rootedNext(`Delete ${RECEIPT}, then run "ia host claude --apply".`, 'claude', root),
  });
  expect(guardGroups(root)).toBe(1);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  rmSync(resolve(root, RECEIPT), { recursive: true });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
});

it.each([STEWARD, '.claude/rules/ia-workspace.md', 'complete'])(
  'retains interrupted upgrade evidence after %s until the successful receipt',
  async (stage) => {
    const { root, env } = await initialized();
    legacyRegistration(root, env);
    seams.failAt = stage;
    try {
      expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(3);
    } finally {
      seams.failAt = undefined;
    }
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
    expect(JSON.parse(read(root, RECEIPT))).toMatchObject({
      guard: 'retired',
      removed: [{ path: STEWARD, sha256: sha(LEGACY_FILES[STEWARD]!) }],
    });
    expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-receipt-pending.json'))).toBe(false);
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
    expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'none', removed: [] });
  },
);

it('distinguishes an interrupted intent from completed receipt publication and validates pending evidence before mutation', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  const { applyHostProjection, renderProjectionFor } = await import('../src/host-projection.js');
  const { json } = await import('@inventarch/distribution/services');
  const pendingPath = '.ia/distributions/hosts/claude-receipt-pending.json';
  expect(() =>
    applyHostProjection(root, 'claude', renderProjectionFor(root, 'claude'), (stage) => {
      if (stage === 'evidence') throw new Error('before retirement');
    }),
  ).toThrow('before retirement');
  expect(guardGroups(root)).toBe(1);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  const pending = JSON.parse(read(root, pendingPath));
  put(root, pendingPath, json({ ...pending, digest: '0'.repeat(64) }));
  const refused = await host(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode, refused.stdout).toBe(3);
  expect(JSON.parse(refused.stdout).where.path).toBe(pendingPath);
  expect(guardGroups(root)).toBe(1);
  put(root, pendingPath, json(pending));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'retired', removed: [{ path: STEWARD }] });
  const { digest: _digest, ...body } = pending;
  const committed = { ...body, receipt: sha(read(root, RECEIPT)) };
  // A kill after final receipt publication and before the pending cleanup must not repeat last-success effects.
  put(root, pendingPath, json({ ...committed, digest: sha(json(committed)) }));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'none', removed: [] });
});
