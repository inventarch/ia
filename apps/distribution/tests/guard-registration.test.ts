import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { json, sha256 } from '../src/files.js';
import {
  applyGuardRegistration,
  currentGuardForm,
  FAIL_CLOSED,
  FAIL_CLOSED_ACCEPTED,
  guardGroup,
  guardNode,
  planGuardFor,
  planGuardRegistration,
  recoverGuardRegistration,
} from '../src/guard-registration.js';
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
    matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
    hooks: [
      process.platform === 'win32'
        ? { type: 'command', command: nodeCommand(), args: direct, timeout: 10 }
        : { type: 'command', command: '/bin/sh', args: ['-c', FAIL_CLOSED, nodeCommand(), ...direct], timeout: 10 },
    ],
  });
  expect(applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(readFileSync(resolve(root, settings), 'utf8')).toBe(json(unrelated));
});
it('routes Bash, PowerShell and NotebookEdit to the guard alongside the file tools (#540)', () => {
  // Letters and `|` only: Claude Code matches each listed tool by its exact name, so the list is pinned name by name.
  const launcher = join(temp(), 'scripts', 'ia.mjs'),
    root = temp();
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const { matcher } = guardGroup(launcher, root, platform);
    expect(matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell');
    expect(matcher.split('|')).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);
  }
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
it('upgrades a registration made with the file-tool matcher in place, and removal restores the prior settings exactly (#540)', () => {
  const cache = cacheV2(),
    statePath = '.ia/distributions/hosts/claude-guard-workspace.json';
  const original = pretty(
    {
      permissions: { deny: [], allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }], PostToolUse: [] },
      env: { Z: '1', A: '2' },
    },
    2,
    '\r\n',
  );
  const bytes = (root: string) =>
    [settings, statePath].map((path) =>
      existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null,
    );
  const matchers = (root: string) => [
    JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse.map(
      (group: { matcher: string }) => group.matcher,
    ),
    JSON.parse(readFileSync(resolve(root, statePath), 'utf8')).group.matcher,
  ];
  // As registered before #540: the group a fresh apply writes, with only the file tools routed to it; every other byte as written.
  const registerOld = (root: string): (string | null)[] => {
    put(root, settings, original);
    applyGuardRegistration(planGuardRegistration(root, { cache }));
    const written = bytes(root);
    for (const path of [settings, statePath])
      put(
        root,
        path,
        readFileSync(resolve(root, path), 'utf8').replace(
          '"Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"',
          '"Write|Edit|MultiEdit"',
        ),
      );
    expect(matchers(root)).toEqual([['Bash', 'Write|Edit|MultiEdit'], 'Write|Edit|MultiEdit']);
    return written;
  };
  const root = temp(),
    reference = registerOld(root);
  // The old-matcher registration is still owned: its removal plan restores the original bytes, and applying it in a second
  // workspace registered the same way does.
  expect(planGuardRegistration(root, { remove: 'workspace' }).after).toEqual({ config: original, state: null });
  const other = temp();
  registerOld(other);
  expect(applyGuardRegistration(planGuardRegistration(other, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(bytes(other)).toEqual([original, null]);
  // Re-applying rewrites the group where it stands, after the sibling: settings and state end as a fresh apply writes them.
  expect(applyGuardRegistration(planGuardRegistration(root, { cache })).status).toBe('guard-registered');
  expect(matchers(root)).toEqual([
    ['Bash', 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'],
    'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
  ]);
  expect(bytes(root)).toEqual(reference);
  // Removal then restores the original settings exactly and deletes the ownership state.
  expect(applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' })).status).toBe('guard-removed');
  expect(bytes(root)).toEqual([original, null]);
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
