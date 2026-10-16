/**
 * Since 2026-09-23, a workspace with a projection ownership state is a consumer workspace, where the guard protects
 * only what `ia host` owns plus the native installation state. Steward enforcement on `.ia/src/systems/<name>/**` is
 * the same in both modes. tests/hook.test.ts keeps the legacy list.
 */
import {
  chmodSync,
  cpSync,
  fstatSync,
  lstatSync,
  linkSync,
  readFileSync,
  renameSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { evaluateHook } from '../src/main.js';

const fileSeam = vi.hoisted(() => ({
  afterOpen: undefined as ((path: unknown, fd: number) => void) | undefined,
  beforeRead: undefined as ((fd: number, length: number) => void) | undefined,
  afterList: undefined as ((directory: string) => void) | undefined,
  /** Each FIFO opened to read without O_NONBLOCK, an open that would have waited for a writer. */
  waited: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // An open that reads a FIFO without O_NONBLOCK waits for a writer, which would hold this whole run: here it is
  // recorded and fails instead.
  const waits = (path: unknown, flags: unknown): boolean => {
    const { O_NONBLOCK = 0, O_RDWR, O_WRONLY } = actual.constants;
    if (
      typeof flags === 'number' ? (flags & (O_RDWR | O_WRONLY | O_NONBLOCK)) !== 0 : !/^rs?$/.test(String(flags ?? 'r'))
    )
      return false;
    try {
      return actual.statSync(path as string, { throwIfNoEntry: false })?.isFIFO() === true;
    } catch {
      return false;
    }
  };
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (waits(args[0], args[1])) {
        fileSeam.waited.push(String(args[0]));
        throw new Error('A FIFO opened to read without O_NONBLOCK would wait for a writer');
      }
      const fd = actual.openSync(...args);
      fileSeam.afterOpen?.(args[0], fd);
      return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      fileSeam.beforeRead?.(fd, length);
      return actual.readSync(fd, buffer, offset, length, position);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      const listed = actual.readdirSync(...args);
      fileSeam.afterList?.(String(args[0]));
      return listed;
    },
  };
});

// Steward cases open the disk-backed native fixture.
vi.setConfig({ testTimeout: 30_000 });

const fixture = resolve(import.meta.dirname, '../../../packages/compliance/fixtures/loop');
const roots: string[] = [];
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64);
function workspace(copy = false): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-consumer-guard-'));
  roots.push(root);
  if (copy) cpSync(fixture, root, { recursive: true });
  mkdirSync(resolve(root, '.ia/distributions/hosts'), { recursive: true });
  return root;
}
function write(root: string, name: string, value: unknown): void {
  writeFileSync(
    resolve(root, '.ia/distributions/hosts', name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function projection(host: 'claude' | 'codex', files: Record<string, unknown>) {
  return { format: 'ia.host-projection-state.v1', host, files };
}
function check(root: string, path: string, extra: Record<string, unknown> = {}) {
  return evaluateHook(root, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: resolve(root, path), content: 'x' },
    ...extra,
  });
}
function code(root: string, path: string, extra: Record<string, unknown> = {}): string | undefined {
  return check(root, path, extra).hookSpecificOutput?.permissionDecisionReason.split(':')[0];
}
afterEach(() => {
  fileSeam.afterOpen = undefined;
  fileSeam.beforeRead = undefined;
  fileSeam.afterList = undefined;
  fileSeam.waited.length = 0;
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-consumer-guard-') || path.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it("leaves the user's own instruction, skill and agent files editable and protects only the owned projection files", () => {
  const root = workspace();
  write(
    root,
    'claude-projection.json',
    projection('claude', { '.claude/agents/demo-steward.md': hash, '.claude/rules/ia-workspace.md': hash }),
  );
  for (const path of [
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/skills/my-own/SKILL.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.agents/skills/ia-authoring/SKILL.md',
    '.claude/agents/my-reviewer.md',
    '.codex/agents/owner.toml',
    '.codex/config.toml',
    'docs/ordinary.md',
  ])
    expect(check(root, path), path).toEqual({});
  for (const path of [
    '.claude/rules/ia-workspace.md',
    // A 1.x steward file stays protected while the state lists it, until the next projection apply removes it.
    '.claude/agents/demo-steward.md',
    '.ia/distributions.lock.json',
    '.ia/distributions/active.json',
    '.ia/distributions/hosts/claude-projection.json',
    // The receipt the projection apply writes beside its state.
    '.ia/distributions/hosts/claude-receipt.json',
  ])
    expect(code(root, path, { agent_type: 'demo-steward' }), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  // In a consumer workspace the state decides, so a marked steward file it does not list is the user's.
  mkdirSync(resolve(root, '.claude/agents'), { recursive: true });
  writeFileSync(
    resolve(root, '.claude/agents/stray-steward.md'),
    '---\nname: stray-steward\n---\n\n<!-- Generated by ia host; edit the cited native records. -->\n',
  );
  expect(check(root, '.claude/agents/stray-steward.md')).toEqual({});
  if (process.platform === 'win32') {
    expect(code(root, '.CLAUDE/Rules/IA-Workspace.MD')).toBe('IA-HOOK-PROJECTION-MANAGED');
    expect(check(root, 'Claude.MD')).toEqual({});
  }
});

it('keeps settings.local.json protected while a guard marker exists and .codex/config.toml while the Codex registration exists', () => {
  const root = workspace();
  write(root, 'claude-projection.json', projection('claude', { '.claude/rules/ia-workspace.md': hash }));
  expect(check(root, '.claude/settings.local.json')).toEqual({});
  write(root, 'claude-guard-workspace.json', {
    format: 'ia.guard-registration-state.v1',
    id: 'workspace',
    cache: root,
    release: hash,
    created: true,
    group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
  });
  expect(code(root, '.claude/settings.local.json')).toBe('IA-HOOK-PROJECTION-MANAGED');
  write(root, 'codex-workspace.json', '{}\n');
  expect(code(root, '.codex/config.toml')).toBe('IA-HOOK-PROJECTION-MANAGED');
});

it("reads either host's projection state, including an interrupted apply's two accepted hashes", () => {
  const root = workspace();
  write(root, 'codex-projection.json', projection('codex', { 'AGENTS.md': [hash, other] }));
  expect(code(root, 'AGENTS.md')).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(check(root, 'CLAUDE.md')).toEqual({});
  expect(check(root, '.agents/skills/ia-authoring/SKILL.md')).toEqual({});
  expect(check(root, '.claude/rules/ia-workspace.md')).toEqual({});
});

it("still refuses records under .ia/src/systems/<name>/ from anyone but that system's steward", () => {
  const root = workspace(true);
  write(root, 'claude-projection.json', projection('claude', { '.claude/rules/ia-workspace.md': hash }));
  const record = '.ia/src/systems/governance-system/records/x.ia';
  expect(code(root, record)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(code(root, record, { agent_type: 'agent-steward' })).toBe('IA-HOOK-NOT-STEWARD');
  expect(check(root, record, { agent_type: 'governance-steward' })).toEqual({});
});

it.each([
  ['unparseable bytes', 'garbage'],
  ['another format', { ...projection('claude', {}), format: 'ia.host-projection-state.v2' }],
  ['a host mismatch', projection('codex', {})],
  ['an extra member', { ...projection('claude', {}), extra: true }],
  ['a path outside the allowlist', projection('claude', { '.ia/src/systems/demo/x.ia': hash })],
  ['a malformed hash', projection('claude', { '.claude/rules/ia-workspace.md': 'nothex' })],
  ['three accepted hashes', projection('claude', { '.claude/rules/ia-workspace.md': [hash, other, 'c'.repeat(64)] })],
])('fails closed on a projection state with %s', (_label, value) => {
  const root = workspace();
  write(root, 'claude-projection.json', value);
  for (const path of ['CLAUDE.md', '.claude/rules/ia-workspace.md', '.claude/skills/my-own/SKILL.md'])
    expect(code(root, path), path).toBe('IA-HOOK-PATH-UNSAFE');
  // A path no projection rule could reach does not depend on the state.
  expect(check(root, 'docs/ordinary.md')).toEqual({});
});

it('fails closed when the projection state is not a plain file', () => {
  const root = workspace();
  mkdirSync(resolve(root, '.ia/distributions/hosts/claude-projection.json'));
  expect(code(root, 'CLAUDE.md')).toBe('IA-HOOK-PATH-UNSAFE');
});

it('protects both settings layers and the exact external launcher of an owned guard only', () => {
  const root = workspace(),
    cache = workspace();
  const marker = {
    format: 'ia.guard-registration-state.v1',
    id: 'workspace',
    cache,
    release: hash,
    created: true,
    group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
  };
  const launcher = resolve(cache, 'scripts/ia.mjs');
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', launcher])
    expect(check(root, path), path).toEqual({});
  write(root, 'claude-guard-workspace.json', marker);
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', launcher])
    expect(code(root, path, { agent_type: 'work-steward' }), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  for (const path of [
    '.claude/ordinary.json',
    '.claude/hooks/unowned.mjs',
    resolve(cache, 'scripts/unowned.mjs'),
    '.ia/src/floor/taxonomy.system.ia',
    'apps/steward-hook/src/main.ts',
  ])
    expect(check(root, path), path).toEqual({});
  const pending = workspace();
  write(pending, 'guard-pending.json', {
    format: 'ia.guard-registration-pending.v1',
    id: 'workspace',
    before: { config: '{}', state: JSON.stringify(marker) },
    after: { config: null, state: null },
  });
  expect(code(pending, launcher)).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(code(pending, '.claude/settings.json')).toBe('IA-HOOK-PROJECTION-MANAGED');
});

it('recognizes the fixed source registration without claiming unrelated user hooks or settings', () => {
  const root = workspace();
  mkdirSync(resolve(root, '.claude/hooks'), { recursive: true });
  writeFileSync(resolve(root, '.claude/hooks/steward-write.mjs'), '// Synthetic fixed-path launcher fixture.\n');
  const registered = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/steward-write.mjs`, '--root', `\${CLAUDE_PROJECT_DIR}`],
            },
          ],
        },
      ],
    },
    permissions: { allow: [] },
  };
  const paths = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/steward-write.mjs'];
  writeFileSync(
    resolve(root, '.claude/settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
    }),
  );
  for (const path of paths) expect(check(root, path), path).toEqual({});
  writeFileSync(resolve(root, '.claude/settings.json'), JSON.stringify(registered));
  for (const tool of ['Write', 'Edit', 'MultiEdit'])
    for (const path of paths) {
      const event = {
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: { file_path: resolve(root, path), edits: [] },
        agent_type: 'hook-authoring-steward',
      };
      expect(evaluateHook(root, event).hookSpecificOutput?.permissionDecisionReason, tool + ':' + path).toContain(
        'IA-HOOK-PROJECTION-MANAGED',
      );
      expect(evaluateHook(root, event).hookSpecificOutput?.permissionDecisionReason).toContain('trusted operator edit');
    }
  expect(check(root, '.claude/hooks/my-own-hook.mjs')).toEqual({});
  writeFileSync(
    resolve(root, '.claude/settings.json'),
    JSON.stringify({
      ...registered,
      hooks: {
        PreToolUse: [
          {
            ...registered.hooks.PreToolUse[0],
            hooks: [{ ...registered.hooks.PreToolUse[0]!.hooks[0], args: ['another-launcher.mjs', '--root', root] }],
          },
        ],
      },
    }),
  );
  for (const path of paths) expect(check(root, path), path).toEqual({});
});

it('refuses aliases to the owned cached launcher without extending ownership to its other code', () => {
  const root = workspace(),
    cache = workspace();
  mkdirSync(resolve(cache, 'scripts'));
  writeFileSync(resolve(cache, 'scripts/ia.mjs'), '// Fixture launcher.\n');
  write(root, 'claude-guard-workspace.json', {
    format: 'ia.guard-registration-state.v1',
    id: 'workspace',
    cache,
    release: hash,
    created: true,
    group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
  });
  symlinkSync(cache, resolve(root, 'cache-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(code(root, 'cache-alias/scripts/ia.mjs')).toBe('IA-HOOK-PATH-UNSAFE');
  expect(check(root, resolve(cache, 'code/guard.js'))).toEqual({});
  write(root, 'claude-guard-workspace.json', { format: 'malformed' });
  expect(code(root, '.claude/settings.json')).toBe('IA-HOOK-PATH-UNSAFE');
});

it.each(['replacement', 'growth', 'hardlink-write'])(
  'fails closed if a legacy steward changes by %s during its bounded handle read',
  (kind) => {
    const root = workspace(),
      path = '.claude/agents/old-steward.md',
      target = resolve(root, path);
    mkdirSync(resolve(root, '.claude/agents'), { recursive: true });
    const marker = '<!-- Generated by ia host; edit the cited native records. -->\n';
    writeFileSync(target, marker);
    if (kind === 'hardlink-write') linkSync(target, `${target}.alias`);
    let opened: number | undefined,
      requested = 0,
      changed = false;
    fileSeam.afterOpen = (name, fd) => {
      if (name !== target || opened !== undefined) return;
      opened = fd;
      if (kind === 'replacement') {
        renameSync(target, `${target}.before`);
        writeFileSync(target, 'foreign replacement');
      }
    };
    fileSeam.beforeRead = (fd, length) => {
      if (fd !== opened) return;
      requested += length;
      if (changed) return;
      changed = true;
      writeFileSync(
        kind === 'hardlink-write' ? `${target}.alias` : target,
        kind === 'growth' ? marker + 'x'.repeat(2 * 1024 * 1024) : 'changed through the alias',
      );
    };
    expect(code(root, path)).toBe('IA-HOOK-PATH-UNSAFE');
    expect(opened).toBeTypeOf('number');
    expect(() => fstatSync(opened!)).toThrow();
    if (kind === 'replacement') {
      expect(requested).toBe(0);
      expect(readFileSync(`${target}.before`, 'utf8')).toBe(marker);
    } else {
      expect(changed).toBe(true);
      expect(requested).toBeLessThanOrEqual(2 * (1024 * 1024 + 1));
    }
  },
);

it.each(['replacement', 'growth', 'hardlink'] as const)(
  'fails closed if source guard settings change by %s during their handle read',
  (kind) => {
    const root = workspace(),
      path = '.claude/settings.json',
      target = resolve(root, path);
    mkdirSync(resolve(root, '.claude/hooks'), { recursive: true });
    writeFileSync(resolve(root, '.claude/hooks/steward-write.mjs'), '// Fixture launcher.\n');
    writeFileSync(target, '{}');
    let opened: number | undefined,
      requested = 0,
      changed = false;
    fileSeam.afterOpen = (name, fd) => {
      if (name !== target || opened !== undefined) return;
      opened = fd;
      if (kind === 'replacement') {
        renameSync(target, `${target}.before`);
        writeFileSync(target, '{"permissions":{}}');
      } else if (kind === 'hardlink') linkSync(target, `${target}.alias`);
    };
    fileSeam.beforeRead = (fd, length) => {
      if (fd !== opened) return;
      requested += length;
      if (kind !== 'growth' || changed) return;
      changed = true;
      writeFileSync(target, ' '.repeat(2 * 1024 * 1024));
    };
    expect(code(root, path)).toBe('IA-HOOK-PATH-UNSAFE');
    expect(opened).toBeTypeOf('number');
    expect(() => fstatSync(opened!)).toThrow();
    if (kind === 'growth') {
      expect(changed).toBe(true);
      expect(requested).toBeLessThanOrEqual(2 * (1024 * 1024 + 1));
    } else {
      expect(requested).toBe(0);
      expect(readFileSync(`${target}.${kind === 'replacement' ? 'before' : 'alias'}`, 'utf8')).toBe('{}');
    }
  },
);

it.each(['legacy steward', 'source guard settings'] as const)(
  'refuses %s identities that collide as JavaScript numbers before reading',
  async (kind) => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = workspace(),
      path = kind === 'legacy steward' ? '.claude/agents/personal.md' : '.claude/settings.json',
      target = resolve(root, path),
      openedId = 2n ** 54n,
      namedId = openedId + 1n;
    expect(Number(openedId)).toBe(Number(namedId));
    mkdirSync(resolve(root, '.claude/agents'), { recursive: true });
    writeFileSync(target, kind === 'legacy steward' ? 'personal agent' : '{}');
    if (kind === 'source guard settings') {
      mkdirSync(resolve(root, '.claude/hooks'));
      writeFileSync(resolve(root, '.claude/hooks/steward-write.mjs'), '// Fixture launcher.\n');
    }
    let opened: number | undefined,
      reads = 0;
    fileSeam.afterOpen = (name, fd) => {
      if (name === target) opened = fd;
    };
    fileSeam.beforeRead = (fd) => {
      if (fd === opened) reads++;
    };
    vi.mocked(fstatSync).mockImplementation((...args: Parameters<typeof fstatSync>) => {
      const stat = actual.fstatSync(...args);
      return args[0] === opened
        ? Object.assign(stat, { ino: typeof stat.ino === 'bigint' ? openedId : Number(openedId) })
        : stat;
    });
    vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
      const stat = actual.lstatSync(...args);
      if (stat === undefined || String(args[0]) !== target) return stat;
      return Object.assign(stat, { ino: typeof stat.ino === 'bigint' ? namedId : Number(namedId) });
    });
    try {
      expect(code(root, path)).toBe('IA-HOOK-PATH-UNSAFE');
      expect(opened).toBeTypeOf('number');
      expect(reads).toBe(0);
      expect(() => actual.fstatSync(opened!)).toThrow();
    } finally {
      vi.mocked(fstatSync).mockImplementation(actual.fstatSync);
      vi.mocked(lstatSync).mockImplementation(actual.lstatSync);
    }
  },
);

it('preserves legacy marker decisions for stable files, including hardlinks and oversized personal files', () => {
  const root = workspace(),
    path = '.claude/agents/old-steward.md',
    target = resolve(root, path);
  mkdirSync(resolve(root, '.claude/agents'), { recursive: true });
  expect(check(root, path)).toEqual({});
  writeFileSync(target, 'personal agent');
  expect(check(root, path)).toEqual({});
  writeFileSync(target, '<!-- Generated by ia host; edit the cited native records. -->\n');
  linkSync(target, `${target}.alias`);
  expect(code(root, path)).toBe('IA-HOOK-PROJECTION-MANAGED');
  writeFileSync(target, 'x'.repeat(1024 * 1024 + 1));
  expect(check(root, path)).toEqual({});
});

it('protects the agents and skills a projection state owns as generated, and leaves every other one to the user', () => {
  // PROJECTION_OWNED admits what authored generation writes (distribution GENERATED_PATHS).
  const root = workspace();
  write(
    root,
    'claude-projection.json',
    projection('claude', {
      '.claude/rules/ia-workspace.md': hash,
      '.claude/agents/reviewer.md': hash,
      '.claude/skills/note-review/SKILL.md': hash,
    }),
  );
  write(
    root,
    'codex-projection.json',
    projection('codex', { 'AGENTS.md': hash, '.agents/skills/note-review/SKILL.md': hash }),
  );
  for (const path of [
    '.claude/agents/reviewer.md',
    '.claude/skills/note-review/SKILL.md',
    '.agents/skills/note-review/SKILL.md',
  ])
    expect(code(root, path), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  for (const path of ['.claude/agents/other.md', '.claude/skills/other/SKILL.md', '.agents/skills/other/SKILL.md'])
    expect(check(root, path), path).toEqual({});
});

/** The reasons the guard gives for the context ownership markers and the actor map it reads, as the host displays them. */
const MANAGED_REASON =
    'IA-HOOK-PROJECTION-MANAGED: Use the owning command for generated state. Guard settings require a trusted operator edit outside intercepted assistant tools, preserving the guard, followed by registration qualification',
  UNSAFE_MARKER = 'IA-HOOK-PATH-UNSAFE: Unsafe context ownership marker',
  INVALID_ACTORS = 'IA-HOOK-STEWARD-UNAVAILABLE: Invalid actor map file',
  ALIASED_ACTORS = 'IA-HOOK-STEWARD-UNAVAILABLE: Actor map must be an absolute unaliased file';
const posix = process.platform !== 'win32';
const reason = (root: string, path = '.claude/settings.local.json'): string | undefined =>
  check(root, path).hookSpecificOutput?.permissionDecisionReason;
/** A guard ownership state for the workspace at `root`: while it exists, both settings layers are managed. */
const guardState = (root: string) => ({
  format: 'ia.guard-registration-state.v1',
  id: 'workspace',
  cache: root,
  release: hash,
  created: true,
  group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
});
type Kind = 'a file link' | 'a junction' | 'a hard link' | 'a directory' | 'a FIFO' | 'a socket';
const POSIX_ONLY: readonly Kind[] = ['a file link', 'a FIFO', 'a socket'];
/**
 * Puts `kind` at `path`, beside a regular `elsewhere/valid.json` holding `content`: a link to that file, a junction to its
 * directory, another name for it, or a directory, a FIFO with no writer or a socket. A socket is bound at a short name
 * first, since socket paths are short on macOS, and moved into place.
 */
async function place(root: string, path: string, kind: Kind, content: string): Promise<void> {
  const elsewhere = resolve(root, 'elsewhere'),
    valid = resolve(elsewhere, 'valid.json');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(valid, content);
  rmSync(path, { force: true });
  if (kind === 'a file link') symlinkSync(valid, path, 'file');
  else if (kind === 'a junction') symlinkSync(elsewhere, path, 'junction');
  else if (kind === 'a hard link') linkSync(valid, path);
  else if (kind === 'a directory') mkdirSync(path);
  else if (kind === 'a FIFO') expect((await runBounded('mkfifo', [path], { timeoutMs: 10_000 })).status).toBe(0);
  else {
    const server = createServer(),
      bound = resolve(root, 's');
    await new Promise<void>((done, failed) => {
      server.once('error', failed);
      server.listen(bound, () => done());
    });
    renameSync(bound, path);
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it('admits a context ownership marker of exactly 1 MiB and a pending journal of up to 8 MiB, and refuses one byte more', () => {
  const root = workspace(),
    marker = resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json'),
    journal = resolve(root, '.ia/distributions/hosts/guard-pending.json'),
    state = JSON.stringify(guardState(root));
  writeFileSync(marker, state.padEnd(1024 * 1024, ' '));
  expect(reason(root)).toBe(MANAGED_REASON);
  writeFileSync(marker, state.padEnd(1024 * 1024 + 1, ' '));
  expect(reason(root)).toBe(UNSAFE_MARKER);
  rmSync(marker);
  const pending = JSON.stringify({
    format: 'ia.guard-registration-pending.v1',
    id: 'workspace',
    before: { config: null, state: null },
    after: { config: '{}', state },
  });
  writeFileSync(journal, pending.padEnd(2 * 1024 * 1024, ' '));
  expect(reason(root)).toBe(MANAGED_REASON);
  // At its bound a journal is read, and the 4 MiB metadata decoder refuses it; one byte more is refused before decoding.
  writeFileSync(journal, pending.padEnd(8 * 1024 * 1024, ' '));
  expect(reason(root)).toBe(
    'IA-HOOK-PATH-UNSAFE: IA-DB-SOURCE-UNAVAILABLE: Distribution contract-invalid: Metadata byte limit/encoding',
  );
  writeFileSync(journal, pending.padEnd(8 * 1024 * 1024 + 1, ' '));
  expect(reason(root)).toBe(UNSAFE_MARKER);
});

it.each(['a file link', 'a junction', 'a hard link', 'a directory', 'a FIFO', 'a socket'] as const)(
  'refuses a context ownership marker that is %s',
  async (kind) => {
    if (!posix && POSIX_ONLY.includes(kind)) return;
    const root = workspace(),
      marker = resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json');
    await place(root, marker, kind, JSON.stringify(guardState(root)));
    expect(reason(root)).toBe(UNSAFE_MARKER);
    expect(fileSeam.waited).toEqual([]);
  },
);

it('refuses the context ownership markers of a hosts directory reached through a junction', () => {
  const root = workspace(),
    hosts = resolve(root, '.ia/distributions/hosts'),
    elsewhere = resolve(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(resolve(elsewhere, 'claude-guard-workspace.json'), JSON.stringify(guardState(root)));
  rmSync(hosts, { recursive: true });
  symlinkSync(elsewhere, hosts, 'junction');
  expect(reason(root)).toBe('IA-HOOK-PATH-UNSAFE: Context ownership directory is aliased');
});

it('refuses a context ownership marker named in another case where the volume folds names, and ignores it elsewhere', () => {
  const root = workspace();
  write(root, 'Claude-Guard-workspace.json', guardState(root));
  expect(reason(root)).toBe(process.platform === 'darwin' || process.platform === 'win32' ? UNSAFE_MARKER : undefined);
});

it('passes on the error of a context ownership marker it may not open', () => {
  if (!posix || process.getuid?.() === 0) return;
  const root = workspace(),
    marker = resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json');
  write(root, 'claude-guard-workspace.json', guardState(root));
  chmodSync(marker, 0o000);
  expect(reason(root)).toBe(`IA-HOOK-PATH-UNSAFE: EACCES: permission denied, open '${marker}'`);
});

it('refuses a context ownership marker removed between the listing and its read', () => {
  const root = workspace(),
    hosts = resolve(root, '.ia/distributions/hosts'),
    marker = resolve(hosts, 'claude-guard-workspace.json');
  write(root, 'claude-guard-workspace.json', guardState(root));
  fileSeam.afterList = (directory) => {
    if (directory !== hosts) return;
    fileSeam.afterList = undefined;
    rmSync(marker);
  };
  expect(reason(root)).toBe(`IA-HOOK-PATH-UNSAFE: ENOENT: no such file or directory, lstat '${marker}'`);
});

/** A copy of the fixture, the absolute path of an actor map in it, and a map that names its governance steward. */
function actorWorkspace(): { readonly root: string; readonly map: string; readonly text: string } {
  const root = workspace(true),
    db = openDatabase(root, { cache: false });
  try {
    const identity = db
      .records()
      .find((record) => record.discriminator === 'agent' && record.name === 'governance-steward')!.identity;
    return {
      root,
      map: resolve(root, 'actors.json'),
      text: JSON.stringify({
        format: 'ia.steward-actors.v1',
        revision: db.revision,
        actors: [{ host: 'fixture-plugin:owner', identity }],
      }),
    };
  } finally {
    db.close();
  }
}
/** The guard's decision on an edit of a governance record by `fixture-plugin:owner`, with the actor map at `actors`. */
const mapped = (root: string, actors: string) =>
  evaluateHook(
    root,
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: resolve(root, '.ia/src/systems/governance-system/records/x.ia'), content: 'x' },
      agent_type: 'fixture-plugin:owner',
    },
    actors,
  );

it('admits an actor map of exactly 1 MiB and refuses one byte more', () => {
  const { root, map, text } = actorWorkspace();
  writeFileSync(map, text.padEnd(1024 * 1024, ' '));
  expect(mapped(root, map)).toEqual({});
  writeFileSync(map, text.padEnd(1024 * 1024 + 1, ' '));
  expect(mapped(root, map).hookSpecificOutput?.permissionDecisionReason).toBe(INVALID_ACTORS);
});

it('refuses a missing actor map', () => {
  const { root, map } = actorWorkspace();
  expect(mapped(root, map).hookSpecificOutput?.permissionDecisionReason).toBe(
    `IA-HOOK-STEWARD-UNAVAILABLE: ENOENT: no such file or directory, lstat '${map}'`,
  );
});

it.each(['a file link', 'a junction', 'a path through a junction', 'a relative path'] as const)(
  'refuses an actor map named by %s',
  async (kind) => {
    if (!posix && kind === 'a file link') return;
    const { root, map, text } = actorWorkspace();
    let actors = map;
    if (kind === 'a file link' || kind === 'a junction') await place(root, map, kind, text);
    else if (kind === 'a path through a junction') {
      await place(root, map, 'a junction', text);
      actors = resolve(map, 'valid.json');
    } else {
      writeFileSync(map, text);
      actors = 'actors.json';
    }
    expect(mapped(root, actors).hookSpecificOutput?.permissionDecisionReason).toBe(ALIASED_ACTORS);
  },
);

it.each(['a hard link', 'a directory', 'a FIFO', 'a socket'] as const)(
  'refuses an actor map that is %s',
  async (kind) => {
    if (!posix && POSIX_ONLY.includes(kind)) return;
    const { root, map, text } = actorWorkspace();
    await place(root, map, kind, text);
    expect(mapped(root, map).hookSpecificOutput?.permissionDecisionReason).toBe(INVALID_ACTORS);
    expect(fileSeam.waited).toEqual([]);
  },
);

it('passes on the error of an actor map it may not open', () => {
  if (!posix || process.getuid?.() === 0) return;
  const { root, map, text } = actorWorkspace();
  writeFileSync(map, text);
  chmodSync(map, 0o000);
  expect(mapped(root, map).hookSpecificOutput?.permissionDecisionReason).toBe(
    `IA-HOOK-STEWARD-UNAVAILABLE: EACCES: permission denied, open '${map}'`,
  );
});
