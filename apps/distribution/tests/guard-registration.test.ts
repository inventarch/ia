import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { json, sha256 } from '../src/files.js';
import { open } from '@inventarch/db';
import { generateHooks } from '@inventarch/workspace-runtime/internal/generate';
import {
  applyGuardRegistration,
  applyHookRegistration,
  assertRetirableGuard,
  assertRemovableHooks,
  currentGuardForm,
  FAIL_CLOSED,
  FAIL_CLOSED_ACCEPTED,
  guardGroup,
  guardNode,
  hookGroup,
  hookGroupDigest,
  observeHookRegistration,
  readHookRegistration,
  planGuardFor,
  planGuardRegistration,
  planHookRegistration,
  planHooksFor,
  recoverGuardRegistration,
} from '../src/guard-registration.js';
import type { HookRow } from '../src/guard-registration.js';
import { doorServer, expectedHostCache, nodeCommand, recoverHost } from '../src/host.js';
import { recoverLifecycleRegistration } from '../src/lifecycle-registration.js';
import { runNative } from '../src/native-command.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-guard-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
function cacheV2() {
  const root = temp(),
    inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] }),
    launcher = '// l\n';
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(
    root,
    'release.json',
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  return root;
}
const settings = '.claude/settings.local.json';
it('refuses explicit hook removal with lost, partial or shared ownership while keeping unrelated settings', () => {
  const cache = cacheV2(),
    hook: HookRow = { identity: 'hook-authoring-system/binding/hook/owned', tools: ['Write'], paths: ['docs/'] },
    foreign: HookRow = { ...hook, identity: 'hook-authoring-system/binding/hook/foreign' };
  for (const mode of ['missing', 'partial', 'shared', 'moved'] as const) {
    let root = temp();
    const unrelated = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] } };
    put(root, settings, json(unrelated));
    applyHookRegistration(planHookRegistration(root, { cache, hooks: [hook] }));
    if (mode === 'missing' || mode === 'moved')
      rmSync(resolve(root, '.ia/distributions/hosts/claude-hooks-workspace.json'));
    const path = mode === 'shared' ? '.claude/settings.json' : settings;
    if (mode === 'partial' || mode === 'shared') {
      const config =
        mode === 'shared' ? structuredClone(unrelated) : JSON.parse(readFileSync(resolve(root, path), 'utf8'));
      config.hooks.PreToolUse.push(hookGroup(join(cache, 'scripts/ia.mjs'), root, foreign));
      put(root, path, json(config));
    }
    if (mode === 'moved') {
      const copied = temp();
      cpSync(root, copied, { recursive: true });
      root = copied;
    }
    const before = readFileSync(resolve(root, path));
    for (const remove of [() => assertRemovableHooks(root), () => planHookRegistration(root, { remove: 'workspace' })])
      expect(remove).toThrow(expect.objectContaining({ code: 'IA-DIST-LOCAL-MODIFICATION', path }));
    expect(readFileSync(resolve(root, path))).toEqual(before);
    const config = JSON.parse(before.toString());
    config.hooks.PreToolUse = config.hooks.PreToolUse.filter(
      (group: { matcher: string; hooks: { args: string[] }[] }) =>
        group.matcher === 'Bash' || (mode === 'partial' && group.hooks[0]?.args.at(-1) === hook.identity),
    );
    put(root, path, json(config));
    expect(() => assertRemovableHooks(root)).not.toThrow();
    if (mode === 'partial' || mode === 'shared') {
      applyHookRegistration(planHookRegistration(root, { remove: 'workspace' }));
      expect(readFileSync(resolve(root, settings), 'utf8')).toBe(json(unrelated));
    }
  }
});
it('registers one PreToolUse group with an explicit root and removes exactly it', () => {
  const root = temp(),
    cache = cacheV2(),
    unrelated = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] },
    };
  put(root, settings, json(unrelated));
  expect(applyGuardRegistration(planGuardRegistration(root, { cache })).status).toBe('guard-registered');
  const after = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  expect(after.permissions).toEqual(unrelated.permissions);
  expect(after.hooks.PreToolUse).toHaveLength(2);
  // POSIX runs the guard through /bin/sh so that a guard that cannot run denies (#323); win32 has no /bin/sh.
  const direct = [join(cache, 'scripts/ia.mjs'), 'guard', '--root', root];
  expect(after.hooks.PreToolUse[1]).toEqual({
    matcher: 'Write|Edit|MultiEdit',
    hooks: [
      process.platform === 'win32'
        ? { type: 'command', command: nodeCommand(), args: direct, timeout: 10 }
        : { type: 'command', command: '/bin/sh', args: ['-c', FAIL_CLOSED, nodeCommand(), ...direct], timeout: 10 },
    ],
  });
  expect(applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(json(unrelated));
});
it('refuses a modified owned group, disabled hooks and recovers an interrupted apply', () => {
  const root = temp(),
    cache = cacheV2();
  put(root, '.claude/settings.json', json({ disableAllHooks: true }));
  expect(() => planGuardRegistration(root, { cache })).toThrow(/disableAllHooks/);
  rmSync(resolve(root, '.claude/settings.json'));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const edited = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  edited.hooks.PreToolUse[0].hooks[0].timeout = 99;
  put(root, settings, json(edited));
  expect(() => planGuardRegistration(root, { remove: 'workspace' })).toThrow(/changed or was duplicated/);
  const other = temp();
  expect(() =>
    applyGuardRegistration(planGuardRegistration(other, { cache }), (stage) => {
      if (stage === 'config') throw Error('interrupted');
    }),
  ).toThrow('interrupted');
  expect(() => planGuardRegistration(other, { cache })).toThrow(/recover-host/);
  expect(recoverGuardRegistration(other).status).toBe('guard-recovered');
  expect(recoverGuardRegistration(other).status).toBe('current');
});
it('serializes guard recovery with the MCP and context journals', () => {
  const root = temp(),
    cache = cacheV2();
  expect(() =>
    applyGuardRegistration(planGuardRegistration(root, { cache }), (stage) => {
      if (stage === 'pending') throw Error('interrupted');
    }),
  ).toThrow('interrupted');
  expect(() => recoverHost(root)).toThrow(/guard/);
  expect(() => recoverLifecycleRegistration(root)).toThrow(/guard/);
  expect(recoverGuardRegistration(root).status).toBe('guard-recovered');
  for (const journal of ['pending.json', 'lifecycle-pending.json']) {
    put(root, '.ia/distributions/hosts/' + journal, '{}\n');
    expect(() => recoverGuardRegistration(root)).toThrow(/recover-(?:host|lifecycle)/);
    rmSync(resolve(root, '.ia/distributions/hosts/' + journal));
  }
});
it('recovers an interrupted guard registration through the recover-guard native command', async () => {
  const root = temp(),
    cache = cacheV2();
  expect((await runNative(['recover-guard', '--root', root]))?.result).toEqual({ status: 'current' });
  expect(() =>
    applyGuardRegistration(planGuardRegistration(root, { cache }), (stage) => {
      if (stage === 'config') throw Error('interrupted');
    }),
  ).toThrow('interrupted');
  expect(() => planGuardRegistration(root, { cache })).toThrow(/recover-guard/);
  expect((await runNative(['recover-guard', '--root', root]))?.result).toEqual({ status: 'guard-recovered' });
  expect(() => readFileSync(resolve(root, settings))).toThrow();
  expect((await runNative(['recover-guard', '--root', root]))?.result).toEqual({ status: 'current' });
});
it('refuses a tampered plan with a malformed request as invalid input', () => {
  const root = temp(),
    plan = planGuardRegistration(root, { cache: cacheV2() });
  let error: unknown;
  try {
    applyGuardRegistration({ ...plan, request: null });
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string }).code).toBe('IA-DIST-INPUT-INVALID');
});
const layouts = [
  ['two-space CRLF', 2, '\r\n'],
  ['tab LF', '\t', '\n'],
] as const;
const pretty = (value: unknown, indent: number | string, eol: string): string =>
  JSON.stringify(value, null, indent).replaceAll('\n', eol) + eol;
const span = (text: string, path: (string | number)[]): number => {
  const node = findNodeAtLocation(parseTree(text)!, path)!;
  return node.offset + node.length;
};
it.each(layouts)(
  'edits a %s settings file in place and restores it byte-identically on removal',
  (_name, indent, eol) => {
    const root = temp(),
      cache = cacheV2(),
      sibling = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] };
    const original = pretty(
        {
          permissions: { deny: [], allow: ['Bash(ls)'] },
          hooks: { PreToolUse: [sibling], PostToolUse: [] },
          env: { Z: '1', A: '2' },
        },
        indent,
        eol,
      ),
      cut = span(original, ['hooks', 'PreToolUse', 0]);
    put(root, settings, original);
    applyGuardRegistration(planGuardRegistration(root, { cache }));
    const applied = readFileSync(resolve(root, settings), 'utf8'),
      inserted = applied.slice(cut, applied.length - (original.length - cut));
    expect(applied.slice(0, cut)).toBe(original.slice(0, cut));
    expect(applied.endsWith(original.slice(cut))).toBe(true);
    expect(inserted.startsWith(',' + eol + (indent === 2 ? '      ' : '\t\t\t') + '{')).toBe(true);
    expect(inserted.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
    expect(JSON.parse(applied).hooks.PreToolUse[1]).toEqual(
      JSON.parse(readFileSync(resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json'), 'utf8')).group,
    );
    applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
    expect(readFileSync(resolve(root, settings), 'utf8')).toBe(original);
  },
);
it('keeps a pre-existing empty hook array, prunes containers it created and lays out a new file with two spaces', () => {
  const root = temp(),
    cache = cacheV2(),
    original = '{\n  "hooks": {\n    "PreToolUse": []\n  }\n}\n';
  const statePath = resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json');
  put(root, settings, original);
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  expect(JSON.parse(readFileSync(statePath, 'utf8')).existing).toEqual([['hooks'], ['hooks', 'PreToolUse']]);
  applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(original);
  // A state written before `existing` existed keeps the old rule: every emptied container on the owned path is pruned.
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const { existing: _existing, ...old } = JSON.parse(readFileSync(statePath, 'utf8'));
  put(root, '.ia/distributions/hosts/claude-guard-workspace.json', json(old));
  applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe('{}\n');
  const other = '{\n  "env": {}\n}\n';
  put(root, settings, other);
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(other);
  const fresh = temp();
  applyGuardRegistration(planGuardRegistration(fresh, { cache }));
  expect(readFileSync(resolve(fresh, settings), 'utf8')).toBe(
    JSON.stringify({ hooks: { PreToolUse: [guardGroup(join(cache, 'scripts/ia.mjs'), fresh)] } }, null, 2) + '\n',
  );
});
it('plans against an expected payload as against the verified one, and removes only state for a deleted group', () => {
  const root = temp(),
    built = cacheV2(),
    home = temp(),
    release = sha256(readFileSync(resolve(built, 'release.json'), 'utf8')),
    target = resolve(home, 'hosts', release);
  const original = json({ permissions: { allow: ['Read'] } });
  put(root, settings, original);
  const expected = planGuardFor(root, expectedHostCache(target, release));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(built, target, { recursive: true });
  expect(planGuardRegistration(root, { cache: target })).toEqual(expected);
  applyGuardRegistration(planGuardRegistration(root, { cache: target }));
  put(root, settings, original);
  expect(applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(original);
  expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json'))).toBe(false);
});
it.each(['garbage\n', json({ format: 'ia.guard-registration-state.v1' })])(
  'locates an unreadable guard ownership state %# at its own file, keeping the refusal code',
  (text) => {
    const root = temp(),
      cache = cacheV2();
    put(root, '.ia/distributions/hosts/claude-guard-workspace.json', text);
    let raised: unknown;
    try {
      planGuardRegistration(root, { cache });
    } catch (error) {
      raised = error;
    }
    expect(raised).toMatchObject({
      path: '.ia/distributions/hosts/claude-guard-workspace.json',
      code: expect.stringMatching(/^IA-(DIST|DB)-/),
    });
  },
);
/**
 * Spec §10 item 8 for the guard: an interruption at every checkpoint, then the named recovery and a rerun, ends byte
 * for byte where an uninterrupted apply ends. The reference is the same workspace's, because the group embeds the root.
 */
it.each(['pending', 'config', 'state', 'complete'])(
  'recovers the %s guard checkpoint and converges byte for byte on rerun',
  (boundary) => {
    const root = temp(),
      cache = cacheV2(),
      original = json({ permissions: { allow: ['Read'] } }),
      statePath = '.ia/distributions/hosts/claude-guard-workspace.json';
    put(root, settings, original);
    const bytes = () =>
      [settings, statePath].map((path) =>
        existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null,
      );
    applyGuardRegistration(planGuardRegistration(root, { cache }));
    const reference = bytes();
    applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
    expect(() =>
      applyGuardRegistration(planGuardRegistration(root, { cache }), (stage) => {
        if (stage === boundary) throw Error('interrupted');
      }),
    ).toThrow('interrupted');
    // Every checkpoint before `complete` leaves the journal, which refuses planning until recover-guard runs.
    expect(existsSync(resolve(root, '.ia/distributions/hosts/guard-pending.json'))).toBe(boundary !== 'complete');
    if (boundary !== 'complete') expect(() => planGuardRegistration(root, { cache })).toThrow(/recover-guard/);
    expect(recoverGuardRegistration(root).status).toBe(boundary === 'complete' ? 'current' : 'guard-recovered');
    // `state` committed the ownership state, so recovery keeps the registration; earlier boundaries roll it back.
    expect(bytes()).toEqual(['state', 'complete'].includes(boundary) ? reference : [original, null]);
    applyGuardRegistration(planGuardRegistration(root, { cache }));
    expect(bytes()).toEqual(reference);
    expect(existsSync(resolve(root, '.ia/distributions/hosts/lock.json'))).toBe(false);
  },
);
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
it("runs the registered guard so that a Node that is gone denies, and passes the guard's own answer through (#323)", async () => {
  // Claude Code blocks a PreToolUse call only on exit 2 or a deny; a hook command that cannot start is a non-blocking
  // error, so a guard whose recorded Node was deleted (a Homebrew upgrade and cleanup) would let every edit through.
  const root = temp(),
    launcher = join(temp(), 'guard.mjs'),
    gone = join(temp(), process.platform === 'win32' ? 'node.exe' : 'node');
  const handler = (node: string) => {
    const recorded = guardGroup(launcher, root).hooks[0]!;
    return recorded.command === '/bin/sh'
      ? { ...recorded, args: recorded.args.map((arg, at) => (at === 2 ? node : arg)) }
      : { ...recorded, command: node };
  };
  const run = (node: string, input = '{}') => {
    const recorded = handler(node);
    return runBounded(recorded.command, recorded.args, { input, timeoutMs: SUBPROCESS });
  };
  if (process.platform === 'win32') {
    // win32 has no /bin/sh, so its direct form still cannot start: the residual the host registration design records.
    await expect(run(gone)).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  const denied = await run(gone);
  expect(denied.status).toBe(2);
  expect(denied.stderr).toContain('IA steward guard could not run: run ia doctor, then ia host claude --apply');
  const answer = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'fixture',
    },
  });
  writeFileSync(launcher, `process.stdin.pipe(process.stderr); process.stdout.write(${JSON.stringify(answer)});`);
  expect(await run(process.execPath, 'the event')).toMatchObject({ status: 0, stdout: answer, stderr: 'the event' });
  writeFileSync(launcher, 'process.exit(1);');
  expect((await run(process.execPath)).status).toBe(2);
  // Paths reach the guard as argument values, never as script text: spaces, quotes, `$(...)`, backticks and a newline.
  const odd = join(temp(), 'a b \'c\' "d" $(echo x) `id`'),
    oddRoot = join(odd, 'root\nnext'),
    oddLauncher = join(odd, 'guard $HOME.mjs');
  mkdirSync(oddRoot, { recursive: true });
  writeFileSync(oddLauncher, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const recorded = guardGroup(oddLauncher, oddRoot).hooks[0]!,
    echoed = await runBounded(recorded.command, recorded.args, { input: '{}', timeoutMs: SUBPROCESS });
  expect(echoed.status).toBe(0);
  expect(JSON.parse(echoed.stdout)).toEqual([oddLauncher, 'guard', '--root', oddRoot]);
});
it("reads the guard's Node from the direct and the /bin/sh form, and refuses any other handler (#323)", () => {
  const launcher = join(temp(), 'scripts', 'ia.mjs'),
    root = temp(),
    direct = [launcher, 'guard', '--root', root];
  expect(guardNode({ command: '/usr/local/bin/node', args: direct }, launcher, root)).toBe('/usr/local/bin/node');
  expect(
    guardNode(
      { command: '/bin/sh', args: ['-c', FAIL_CLOSED, '/opt/homebrew/opt/node@22/bin/node', ...direct] },
      launcher,
      root,
    ),
  ).toBe('/opt/homebrew/opt/node@22/bin/node');
  for (const other of [
    { command: '/bin/sh', args: ['-c', '"$0" "$@"', '/n', ...direct] },
    { command: '/bin/bash', args: ['-c', FAIL_CLOSED, '/n', ...direct] },
    { command: '/bin/sh', args: ['-c', FAIL_CLOSED, '/n', ...direct, 'extra'] },
    { command: '/usr/local/bin/node', args: [launcher, 'guard', '--root', temp()] },
    { command: '/usr/local/bin/node' },
    // The /bin/sh form with anything but the fixed derivation: another launcher, another root, another flag, another order.
    { command: '/bin/sh', args: ['-c', FAIL_CLOSED, '/n', join(temp(), 'ia.mjs'), 'guard', '--root', root] },
    { command: '/bin/sh', args: ['-c', FAIL_CLOSED, '/n', launcher, 'guard', '--root', temp()] },
    { command: '/bin/sh', args: ['-e', FAIL_CLOSED, '/n', ...direct] },
    { command: '/bin/sh', args: ['-c', FAIL_CLOSED, '/n', 'guard', launcher, '--root', root] },
    { command: '/usr/local/bin/node', args: [join(temp(), 'ia.mjs'), 'guard', '--root', root] },
  ])
    expect(guardNode(other, launcher, root)).toBeNull();
});
it('pins every guard script a release has written, and keeps a registration made with an earlier one owned (#323)', () => {
  // Literal strings, not the constants: changing the script without keeping the previous one would strand every existing
  // registration, which plan, remove and doctor would then refuse as not IA's.
  expect(FAIL_CLOSED_ACCEPTED).toEqual([
    '"$0" "$@" || { echo "IA steward guard could not run: run ia doctor, then ia host claude --apply" >&2; exit 2; }',
    '"$0" "$@" || exit 2',
  ]);
  expect(FAIL_CLOSED).toBe(FAIL_CLOSED_ACCEPTED[0]);
  const root = temp(),
    cache = cacheV2(),
    launcher = join(cache, 'scripts/ia.mjs'),
    direct = [launcher, 'guard', '--root', root];
  for (const script of FAIL_CLOSED_ACCEPTED)
    expect(guardNode({ command: '/bin/sh', args: ['-c', script, '/n', ...direct] }, launcher, root)).toBe('/n');
  // Only the form guardGroup writes now is current: the direct form on win32, the current script elsewhere.
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(currentGuardForm(guardGroup(launcher, root, platform).hooks[0]!, platform)).toBe(true);
    expect(
      currentGuardForm({ command: '/bin/sh', args: ['-c', FAIL_CLOSED_ACCEPTED[1], '/n', ...direct] }, platform),
    ).toBe(false);
  }
  expect(currentGuardForm(guardGroup(launcher, root, 'win32').hooks[0]!, 'linux')).toBe(false);
  // Registered with the previous script: re-applying rewrites it, and removal removes it.
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const statePath = '.ia/distributions/hosts/claude-guard-workspace.json',
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  const previous = JSON.parse(json(guardGroup(launcher, root, 'linux'))),
    config = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  previous.hooks[0].args[1] = FAIL_CLOSED_ACCEPTED[1];
  const registerAs = (group: unknown) => {
    state.group = group;
    config.hooks.PreToolUse[0] = group;
    put(root, statePath, json(state));
    put(root, settings, json(config));
  };
  registerAs(previous);
  expect(applyGuardRegistration(planGuardRegistration(root, { cache })).status).toBe('guard-registered');
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse).toEqual([
    guardGroup(launcher, root),
  ]);
  registerAs(previous);
  expect(applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(existsSync(resolve(root, statePath))).toBe(false);
});
it('keeps reading a guard registered in the direct form, and re-applying writes the current form (#323)', () => {
  const root = temp(),
    cache = cacheV2(),
    launcher = join(cache, 'scripts/ia.mjs');
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  // As registered before the /bin/sh form: the same group, state and settings, with Node run directly.
  const statePath = '.ia/distributions/hosts/claude-guard-workspace.json',
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  const legacy = guardGroup(launcher, root, 'win32'),
    config = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  state.group = legacy;
  config.hooks.PreToolUse[0] = legacy;
  put(root, statePath, json(state));
  put(root, settings, json(config));
  expect(applyGuardRegistration(planGuardRegistration(root, { cache })).status).toBe('guard-registered');
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse).toEqual([
    guardGroup(launcher, root),
  ]);
});
it("records a Homebrew keg's stable link in the MCP entry and the guard, whichever form it takes (#323)", () => {
  const prefix = temp(),
    keg = join(prefix, 'Cellar', 'node@22', '22.22.0', 'bin', basename(process.execPath)),
    link = join(prefix, 'opt', 'node@22'),
    running = process.execPath;
  mkdirSync(dirname(keg), { recursive: true });
  writeFileSync(keg, '');
  mkdirSync(dirname(link));
  symlinkSync(join(prefix, 'Cellar', 'node@22', '22.22.0'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const stable = join(link, 'bin', basename(keg));
  try {
    process.execPath = keg;
    expect(doorServer('/cache/scripts/ia.mjs', ['mcp']).command).toBe(stable);
    for (const platform of ['linux', 'win32'] as const) {
      const guard = guardGroup('/cache/scripts/ia.mjs', '/w', platform).hooks[0]!;
      expect(guard.command === '/bin/sh' ? guard.args[2] : guard.command).toBe(stable);
    }
  } finally {
    process.execPath = running;
  }
});
it("records a Homebrew keg's Node by its stable opt link while that link reaches the same executable (#323)", () => {
  const prefix = temp(),
    keg = join(prefix, 'Cellar', 'node@22', '22.22.0', 'bin', 'node'),
    link = join(prefix, 'opt', 'node@22');
  mkdirSync(dirname(keg), { recursive: true });
  writeFileSync(keg, '');
  expect(nodeCommand(keg)).toBe(keg);
  mkdirSync(dirname(link));
  symlinkSync(join(prefix, 'Cellar', 'node@22', '22.22.0'), link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(nodeCommand(keg)).toBe(join(link, 'bin', 'node'));
  // A keg the link no longer names keeps its own path, and so does any Node outside a Cellar.
  const older = join(prefix, 'Cellar', 'node@22', '22.21.0', 'bin', 'node');
  mkdirSync(dirname(older), { recursive: true });
  writeFileSync(older, '');
  expect(nodeCommand(older)).toBe(older);
  expect(nodeCommand(join(prefix, 'bin', 'node'))).toBe(join(prefix, 'bin', 'node'));
});

it('removes an exact recorded old-root guard after a workspace move, while registration remains strict', () => {
  const root = temp(),
    moved = temp(),
    cache = cacheV2();
  put(root, settings, json({ permissions: { allow: ['Bash(ls)'] } }));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  cpSync(root, moved, { recursive: true });
  expect(() => planGuardRegistration(moved, { cache })).toThrow('Owned guard command differs from its fixed root');
  const removal = planGuardRegistration(moved, { remove: 'workspace' });
  applyGuardRegistration(removal);
  expect(JSON.parse(readFileSync(resolve(moved, settings), 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)'] } });
  expect(existsSync(resolve(moved, '.ia/distributions/hosts/claude-guard-workspace.json'))).toBe(false);
});

/*
 * Milestone generation-binding plan amendment C9: each authored `@hook` becomes exactly one owned PreToolUse group that
 * runs `guard --root <root> --hook <identity>`. The rows come from the composition fixture's records (apps/cli's
 * fixture over the conformance corpus), rendered by workspace-runtime's hook generation as the projection will.
 */
const repository = resolve(import.meta.dirname, '../../..'),
  HOOK = 'hook-authoring-system/binding/hook/note-edits',
  hookState = '.ia/distributions/hosts/claude-hooks-workspace.json';
const FIXTURE_HOOKS = readFileSync(
  resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src/hooks.ia'),
  'utf8',
);
/** The composition fixture's authored hooks as registration rows, `hooks` replacing its hooks.ia when given. */
function fixtureRows(hooks?: string): HookRow[] {
  const root = temp();
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  cpSync(resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'), resolve(root, '.ia/src'), {
    recursive: true,
  });
  if (hooks !== undefined) put(root, '.ia/src/hooks.ia', hooks);
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    return generateHooks(db, db.resolveScope().token, 'claude').map(({ identity, tools, paths }) => ({
      identity,
      tools,
      paths,
    }));
  } finally {
    db.close();
  }
}
/** One more authored hook, appended to the fixture's. */
const extraHook = (name: string, tools = '[Write]'): string =>
  `\n@hook ${name}\n  meaning\n    says "Fixture hook ${name}."\n    answers "What does ${name} guard?"\n  hook\n    event PreToolUse\n    tools ${tools}\n    paths ["notes/**"]\n    message "Fixture hook ${name}."\n`;
const fixed = (cache: string, root: string, hook: string): string[] => [
  join(cache, 'scripts/ia.mjs'),
  'guard',
  '--root',
  root,
  '--hook',
  hook,
];
const handler = (cache: string, root: string, hook: string) =>
  process.platform === 'win32'
    ? { type: 'command', command: nodeCommand(), args: fixed(cache, root, hook), timeout: 10 }
    : {
        type: 'command',
        command: '/bin/sh',
        args: ['-c', FAIL_CLOSED, nodeCommand(), ...fixed(cache, root, hook)],
        timeout: 10,
      };
const bytesOf = (root: string, path: string): string | null =>
  existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null;

it("renders the fixture's @hook as one owned group, keeps every unrelated key and group, re-plans as a no-op and removes only its group", () => {
  const root = temp(),
    cache = cacheV2(),
    rows = fixtureRows();
  expect(rows).toEqual([
    { identity: HOOK, tools: ['Write', 'Edit', 'MultiEdit'], paths: ['docs/**', 'restricted/**'] },
  ]);
  const original = pretty(
    {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }],
      },
      env: { A: '1' },
    },
    2,
    '\n',
  );
  put(root, settings, original);
  const plan = planHookRegistration(root, { cache, hooks: rows });
  expect(plan.hooks).toEqual([{ hook: HOOK, action: 'create' }]);
  expect(applyHookRegistration(plan)).toEqual({ status: 'hooks-registered', id: 'workspace' });
  const applied = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  expect(applied.permissions).toEqual({ allow: ['Bash(ls)'] });
  expect(applied.env).toEqual({ A: '1' });
  expect(applied.hooks.PostToolUse).toEqual([{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }]);
  expect(applied.hooks.PreToolUse).toEqual([
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
    // Exactly the fixed launcher, verb, root and identity: nothing authored but the identity and tools reaches it.
    { matcher: 'Write|Edit|MultiEdit', hooks: [handler(cache, root, HOOK)] },
  ]);
  expect(JSON.parse(readFileSync(resolve(root, hookState), 'utf8'))).toEqual({
    format: 'ia.hook-registration-state.v1',
    id: 'workspace',
    cache,
    release: sha256(readFileSync(resolve(cache, 'release.json'), 'utf8')),
    created: false,
    groups: [{ hook: HOOK, group: applied.hooks.PreToolUse[1], paths: ['docs/**', 'restricted/**'] }],
    existing: [['hooks'], ['hooks', 'PreToolUse']],
  });
  // Re-planning changes nothing, and applying it writes nothing.
  const registered = [bytesOf(root, settings), bytesOf(root, hookState)];
  const again = planHookRegistration(root, { cache, hooks: fixtureRows() });
  expect(again.hooks).toEqual([{ hook: HOOK, action: 'unchanged' }]);
  expect([again.after.config, again.after.state]).toEqual(registered);
  expect(applyHookRegistration(again).status).toBe('hooks-unchanged');
  expect([bytesOf(root, settings), bytesOf(root, hookState)]).toEqual(registered);
  // A second hook appends its own group; removing the first hook's record removes only that group.
  const both = fixtureRows(FIXTURE_HOOKS + extraHook('note-writes')),
    other = 'hook-authoring-system/binding/hook/note-writes';
  expect(both.map((row) => row.identity)).toEqual([HOOK, other]);
  applyHookRegistration(planHookRegistration(root, { cache, hooks: both }));
  const second = JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse[2];
  // Every group matches every edit tool (G-R2): the hook's own tools apply to its paths, read from the record.
  expect(second).toEqual({ matcher: 'Write|Edit|MultiEdit', hooks: [handler(cache, root, other)] });
  const removal = planHookRegistration(root, { cache, hooks: both.slice(1) });
  expect(removal.hooks).toEqual([
    { hook: HOOK, action: 'remove' },
    { hook: other, action: 'unchanged' },
  ]);
  applyHookRegistration(removal);
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse).toEqual([
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
    second,
  ]);
  // No hook left: the settings come back byte for byte and the ownership state goes.
  expect(applyHookRegistration(planHookRegistration(root, { cache, hooks: [] })).status).toBe('hooks-removed');
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(original);
  expect(existsSync(resolve(root, hookState))).toBe(false);
});

it('writes nothing authored but the identity into a group, whatever the paths and message hold', () => {
  const root = temp(),
    cache = cacheV2();
  const odd = FIXTURE_HOOKS.replace(
    '["docs/**", "restricted/**"]',
    '["docs/**", "$(touch pwned)/**", "`id`/**", "!x/**", "[ab]/**", "a\'b/**"]',
  ).replace('"Use the participant\'s documentation mandate."', '"Use $(rm -rf ~) and `id` now."');
  expect(odd).toContain('$(rm -rf ~)');
  const rows = fixtureRows(odd);
  expect(rows).toEqual([
    {
      identity: HOOK,
      tools: ['Write', 'Edit', 'MultiEdit'],
      paths: ['docs/**', '$(touch pwned)/**', '`id`/**', '!x/**', '[ab]/**', "a'b/**"],
    },
  ]);
  applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
  const text = readFileSync(resolve(root, settings), 'utf8');
  for (const authored of ['$(', '`', '!x', '[ab]', "a'b", 'rm -rf', 'docs/**']) expect(text).not.toContain(authored);
  expect(JSON.parse(text).hooks.PreToolUse).toEqual([
    { matcher: 'Write|Edit|MultiEdit', hooks: [handler(cache, root, HOOK)] },
  ]);
  // The matcher is fixed, whatever tools the hook names, and never authored text.
  expect(
    hookGroup('/c/scripts/ia.mjs', '/w', { identity: HOOK, tools: ['MultiEdit'], paths: ['docs/**'] }, 'win32').matcher,
  ).toBe('Write|Edit|MultiEdit');
});

it('refuses an owned group changed by hand, an unmanaged identical group, disabled hooks and malformed rows', () => {
  const root = temp(),
    cache = cacheV2(),
    rows = fixtureRows();
  for (const hooks of [
    [{ identity: 'Not An Identity', tools: ['Write'] }],
    [{ identity: `${HOOK}/extra`, tools: ['Write'] }],
    [{ identity: HOOK, tools: ['Bash'] }],
    [{ identity: HOOK, tools: [] }],
    [{ identity: HOOK, tools: ['Write', 'Write'] }],
    [...rows, ...rows],
    [{ identity: HOOK, tools: ['Write'], paths: ['docs/**'], message: 'extra' }],
    [{ identity: HOOK, tools: ['Write'], paths: [] }],
    [{ identity: HOOK, tools: ['Write'], paths: ['/etc/**'] }],
    [{ identity: HOOK, tools: ['Write'], paths: ['docs/../x'] }],
    [{ identity: HOOK, tools: ['Write'], paths: ['docs\\x'] }],
    [{ identity: HOOK, tools: ['Write'], paths: ['docs/\u0085x'] }],
  ])
    expect(() => planHookRegistration(root, { cache, hooks } as never), JSON.stringify(hooks)).toThrow(
      expect.objectContaining({ code: 'IA-DIST-INPUT-INVALID' }),
    );
  expect(() => planHookRegistration(root, { remove: 'workspace' })).toThrow(/not owned/);
  // The group the plan would write already sits there unmanaged: it is never adopted.
  put(root, settings, json({ hooks: { PreToolUse: [hookGroup(join(cache, 'scripts/ia.mjs'), root, rows[0]!)] } }));
  expect(() => planHookRegistration(root, { cache, hooks: rows })).toThrow(/unmanaged identical hook group/);
  rmSync(resolve(root, settings));
  put(root, '.claude/settings.json', json({ disableAllHooks: true }));
  expect(() => planHookRegistration(root, { cache, hooks: rows })).toThrow(/disableAllHooks/);
  rmSync(resolve(root, '.claude/settings.json'));
  applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
  const edited = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  edited.hooks.PreToolUse[0].hooks[0].timeout = 99;
  put(root, settings, json(edited));
  for (const request of [{ cache, hooks: rows }, { cache, hooks: [] }, { remove: 'workspace' }])
    expect(() => planHookRegistration(root, request), JSON.stringify(request)).toThrow(/changed or was duplicated/);
  // A group deleted by hand: re-registering it refuses, naming the removal (G-N2); dropping the hook drops ownership.
  edited.hooks.PreToolUse = [];
  put(root, settings, json(edited));
  expect(() => planHookRegistration(root, { cache, hooks: rows })).toThrow(
    /was deleted by hand; remove the registration \("ia host claude --remove --apply"\)/,
  );
  const dropped = planHookRegistration(root, { cache, hooks: [] });
  expect(dropped.hooks).toEqual([{ hook: HOOK, action: 'remove' }]);
  expect(dropped.after).toEqual({ config: bytesOf(root, settings), state: null });
  applyHookRegistration(dropped);
  expect(existsSync(resolve(root, hookState))).toBe(false);
});

it('leaves the retired steward guard and the hook groups each to their own owner', () => {
  const root = temp(),
    cache = cacheV2(),
    rows = fixtureRows();
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
  // B11's retirement check recognizes only the guard's own group, so a hook group never blocks the projection apply.
  expect(() => assertRetirableGuard(root)).not.toThrow();
  applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }));
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse).toEqual([
    { matcher: 'Write|Edit|MultiEdit', hooks: [handler(cache, root, HOOK)] },
  ]);
  expect(planHookRegistration(root, { cache, hooks: rows }).hooks).toEqual([{ hook: HOOK, action: 'unchanged' }]);
  expect(applyHookRegistration(planHookRegistration(root, { remove: 'workspace' })).status).toBe('hooks-removed');
  // The guard created the file and the containers the hook groups joined, so they stay, emptied, as the hooks found them.
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8'))).toEqual({ hooks: { PreToolUse: [] } });
});

it("plans against an expected payload as against the verified one, and removes a moved workspace's groups", () => {
  const root = temp(),
    built = cacheV2(),
    home = temp(),
    release = sha256(readFileSync(resolve(built, 'release.json'), 'utf8')),
    target = resolve(home, 'hosts', release),
    rows = fixtureRows();
  const expected = planHooksFor(root, expectedHostCache(target, release), rows);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(built, target, { recursive: true });
  expect(planHookRegistration(root, { cache: target, hooks: rows })).toEqual(expected);
  applyHookRegistration(planHookRegistration(root, { cache: target, hooks: rows }));
  const moved = temp();
  cpSync(root, moved, { recursive: true });
  expect(() => planHookRegistration(moved, { cache: target, hooks: rows })).toThrow(/differs from its fixed root/);
  applyHookRegistration(planHookRegistration(moved, { remove: 'workspace' }));
  expect(existsSync(resolve(moved, settings))).toBe(false);
  expect(existsSync(resolve(moved, hookState))).toBe(false);
});

it.each(['pending', 'config', 'state', 'complete'])(
  'recovers the %s hook checkpoint through recover-guard and converges byte for byte on rerun',
  (boundary) => {
    const root = temp(),
      cache = cacheV2(),
      rows = fixtureRows(),
      original = json({ permissions: { allow: ['Read'] } });
    put(root, settings, original);
    const bytes = () => [bytesOf(root, settings), bytesOf(root, hookState)];
    applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
    const reference = bytes();
    applyHookRegistration(planHookRegistration(root, { remove: 'workspace' }));
    expect(() =>
      applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }), (stage) => {
        if (stage === boundary) throw Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.ia/distributions/hosts/guard-pending.json'))).toBe(boundary !== 'complete');
    if (boundary !== 'complete')
      expect(() => planHookRegistration(root, { cache, hooks: rows })).toThrow(/recover-guard/);
    expect(recoverGuardRegistration(root).status).toBe(boundary === 'complete' ? 'current' : 'guard-recovered');
    expect(bytes()).toEqual(['state', 'complete'].includes(boundary) ? reference : [original, null]);
    applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
    expect(bytes()).toEqual(reference);
    expect(existsSync(resolve(root, '.ia/distributions/hosts/lock.json'))).toBe(false);
  },
);

it("observes each owned hook group's drift read-only: missing, modified, duplicated and foreign", () => {
  const root = temp(),
    cache = cacheV2(),
    rows = fixtureRows();
  expect(observeHookRegistration(root)).toEqual([]);
  expect(readHookRegistration(root)).toBeNull();
  applyHookRegistration(planHookRegistration(root, { cache, hooks: rows }));
  const state = readHookRegistration(root)!;
  expect(state.groups.map((row) => row.hook)).toEqual([HOOK]);
  expect(hookGroupDigest(state.groups[0]!.group)).toBe(sha256(json(state.groups[0]!.group)));
  expect(observeHookRegistration(root)).toEqual([]);
  const original = readFileSync(resolve(root, settings), 'utf8'),
    config = JSON.parse(original);
  const foreign = hookGroup(join(cache, 'scripts/ia.mjs'), root, {
    identity: 'hook-authoring-system/binding/hook/stranger',
    tools: ['Write'],
    paths: ['docs/**'],
  });
  const variants: readonly [unknown[], { hook: string; drift: string }[]][] = [
    [[], [{ hook: HOOK, drift: 'missing' }]],
    [[{ ...config.hooks.PreToolUse[0], matcher: 'Write' }], [{ hook: HOOK, drift: 'modified' }]],
    [[config.hooks.PreToolUse[0], config.hooks.PreToolUse[0]], [{ hook: HOOK, drift: 'modified' }]],
    [
      [config.hooks.PreToolUse[0], foreign],
      [{ hook: 'hook-authoring-system/binding/hook/stranger', drift: 'foreign' }],
    ],
  ];
  for (const [groups, drift] of variants) {
    put(root, settings, json({ ...config, hooks: { PreToolUse: groups } }));
    const before = readFileSync(resolve(root, settings), 'utf8');
    expect(observeHookRegistration(root), JSON.stringify(drift)).toEqual(drift);
    expect(readFileSync(resolve(root, settings), 'utf8')).toBe(before);
  }
});

it('updates a group in place when its cache changes, ignores a change of tools, and removes two hooks at once (G-N5)', () => {
  const root = temp(),
    first = cacheV2(),
    second = cacheV2(),
    other = (name: string) => `hook-authoring-system/binding/hook/${name}`,
    row = (name: string, tools: HookRow['tools'] = ['Write', 'Edit', 'MultiEdit']): HookRow => ({
      identity: other(name),
      tools,
      paths: ['docs/**'],
    });
  const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] };
  put(root, settings, json({ hooks: { PreToolUse: [unrelated] } }));
  applyHookRegistration(planHookRegistration(root, { cache: first, hooks: [row('a'), row('b'), row('c')] }));
  // An unrelated group between the owned ones stays where it is.
  const config = JSON.parse(readFileSync(resolve(root, settings), 'utf8'));
  config.hooks.PreToolUse.splice(2, 0, unrelated);
  put(root, settings, json(config));
  const groups = () => JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse;
  // A change of tools changes no group: every group matches every edit tool, and the guard reads the tools from the record.
  expect(planHookRegistration(root, { cache: first, hooks: [row('a', ['Write']), row('b'), row('c')] }).hooks).toEqual([
    { hook: other('a'), action: 'unchanged' },
    { hook: other('b'), action: 'unchanged' },
    { hook: other('c'), action: 'unchanged' },
  ]);
  // Another payload: each owned group is replaced at its own index.
  const moved = planHookRegistration(root, { cache: second, hooks: [row('a'), row('b'), row('c')] });
  expect(moved.hooks.map((hook) => hook.action)).toEqual(['update', 'update', 'update']);
  applyHookRegistration(moved);
  expect(groups()).toEqual([
    unrelated,
    hookGroup(join(second, 'scripts/ia.mjs'), root, row('a')),
    unrelated,
    hookGroup(join(second, 'scripts/ia.mjs'), root, row('b')),
    hookGroup(join(second, 'scripts/ia.mjs'), root, row('c')),
  ]);
  // Removing a and c at once removes exactly those two, from the highest index down.
  applyHookRegistration(planHookRegistration(root, { cache: second, hooks: [row('b')] }));
  expect(groups()).toEqual([unrelated, unrelated, hookGroup(join(second, 'scripts/ia.mjs'), root, row('b'))]);
});

it('with disableAllHooks on, keeps and removes owned groups but refuses to create or update one (A-F1)', () => {
  const root = temp(),
    first = cacheV2(),
    second = cacheV2(),
    other = (name: string) => `hook-authoring-system/binding/hook/${name}`,
    row = (name: string): HookRow => ({ identity: other(name), tools: ['Write'], paths: ['docs/**'] });
  applyHookRegistration(planHookRegistration(root, { cache: first, hooks: [row('a'), row('b')] }));
  put(root, '.claude/settings.json', json({ disableAllHooks: true }));
  // The same groups re-planned, and one of them removed, write no group: both proceed.
  expect(planHookRegistration(root, { cache: first, hooks: [row('a'), row('b')] }).hooks).toEqual([
    { hook: other('a'), action: 'unchanged' },
    { hook: other('b'), action: 'unchanged' },
  ]);
  applyHookRegistration(planHookRegistration(root, { cache: first, hooks: [row('a')] }));
  expect(readHookRegistration(root)?.groups.map((group) => group.hook)).toEqual([other('a')]);
  // A new group, or an owned one rewritten for another payload, would be written: refused.
  expect(() => planHookRegistration(root, { cache: first, hooks: [row('a'), row('c')] })).toThrow(/disableAllHooks/);
  expect(() => planHookRegistration(root, { cache: second, hooks: [row('a')] })).toThrow(/disableAllHooks/);
});
