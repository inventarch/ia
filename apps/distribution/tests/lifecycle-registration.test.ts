import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lifecycleProfile, verifyLifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import { canonicalDistributionJson } from '@inventarch/db/distribution';
import { DEFAULT_CONTEXT_HOOK_BUDGETS } from '@inventarch/steward-hook/context';
import { applyHost, nodeCommand, planHost, recoverHost, verifyHostCache } from '../src/host.js';
import {
  applyLifecycleRegistration,
  planLifecycleRegistration,
  recoverLifecycleRegistration,
  probeContextHookImplementation,
} from '../src/lifecycle-registration.js';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { json, sha256 } from '../src/files.js';
import { runNative } from '../src/native-command.js';

const roots: string[] = [],
  implementation = 'a'.repeat(64),
  ports = { implementation: () => implementation };
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia-lifecycle-registration-'));
  roots.push(root);
  return root;
}
function put(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function cache(identity?: unknown): string {
  const root = temp(),
    content = 'inert fixture\n',
    launcher =
      identity === undefined
        ? '// Never executed by component tests\n'
        : `process.stdout.write(${JSON.stringify(JSON.stringify(identity))});`,
    inventory = json({
      format: 'ia.host-cache.v1',
      host: 'claude',
      name: 'fixture',
      version: '1',
      native: 'b'.repeat(64),
      packages: [],
      files: [{ path: 'payload.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
    });
  put(root, 'payload.txt', content);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(
    root,
    'release.json',
    json({ format: 'ia.host-release.v1', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  return root;
}
function request(root: string, selectedCache = cache()) {
  return {
    cache: selectedCache,
    binding: {
      format: 'ia.context-hook-binding.v1' as const,
      root,
      owner: 'local',
      actor: 'actor',
      workspace: 'workspace',
      profile: lifecycleProfile('claude-code', '2.1.278'),
      view: { id: 'project', adopted: [], manifests: [{ source: 'self', root }] },
      scope: { root: '', identities: null },
      selection: { target: 'governance-system/definition/procedure/sample-procedure', document: null, lifecycle: null },
      coordinate: { phase: 'orient', primitive: 'Decision' },
      bootstrap: 'Author native procedures',
      budgets: { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 3000 },
      policy: 'c'.repeat(64),
    },
  };
}
const settings = '.claude/settings.local.json',
  bindingPath = '.ia/distributions/hosts/claude-context-fixture.binding.json';
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-lifecycle-registration-')))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it('pins the external fanout deadline and derives a finite outer timeout for all owned slots', () => {
  const root = temp(),
    input = request(root);
  input.binding.budgets = { ...DEFAULT_CONTEXT_HOOK_BUDGETS };
  const plan = planLifecycleRegistration(root, input, ports),
    retained = JSON.parse(plan.after.binding!),
    config = JSON.parse(plan.after.config!);
  expect(retained.budgets).toEqual({ tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 30_000 });
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    expect(config.hooks[event][0].hooks).toHaveLength(12);
    expect(config.hooks[event][0].hooks.every((hook: { timeout: number }) => hook.timeout === 32)).toBe(true);
  }
  input.binding.budgets.timeoutMs = 10_000;
  const historical = planLifecycleRegistration(root, input, ports);
  expect(historical.after.binding).not.toBe(plan.after.binding);
  expect(JSON.parse(historical.after.binding!).budgets.timeoutMs).toBe(10_000);
  expect(JSON.parse(historical.after.config!).hooks.SessionStart[0].hooks[0].timeout).toBe(12);
});

it('plans, applies and removes exact context groups while preserving steward guard and unrelated hooks/settings', () => {
  const root = temp(),
    input = request(root),
    project = json({
      hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'guard' }] }] },
    }),
    local = json({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'other' }] }] },
      env: { KEEP: 'yes' },
    });
  put(root, '.claude/settings.json', project);
  put(root, settings, local);
  put(root, '.ia/retained/data.json', 'retained data');
  const plan = planLifecycleRegistration(root, input, ports);
  expect(readFileSync(join(root, settings), 'utf8')).toBe(local);
  expect(applyLifecycleRegistration(plan, ports).status).toBe('lifecycle-registered');
  const configured = JSON.parse(readFileSync(join(root, settings), 'utf8'));
  expect(configured.hooks.SessionStart).toHaveLength(2);
  expect(configured.hooks.UserPromptSubmit).toHaveLength(1);
  const handler = configured.hooks.UserPromptSubmit[0].hooks[0];
  expect(handler.command).toBe(nodeCommand());
  expect(handler.args).toEqual([
    join(input.cache, 'scripts/ia.mjs'),
    'context',
    '--root',
    root,
    '--binding',
    join(root, bindingPath),
    '--part',
    '0',
  ]);
  expect(configured.hooks.UserPromptSubmit[0].hooks).toHaveLength(12);
  expect(
    new Set(configured.hooks.UserPromptSubmit[0].hooks.map((item: { args: string[] }) => item.args.at(-1))).size,
  ).toBe(12);
  expect(handler).not.toHaveProperty('id');
  expect(readFileSync(join(root, bindingPath), 'utf8')).toContain(implementation);
  expect(applyLifecycleRegistration(planLifecycleRegistration(root, { remove: 'fixture' }, ports), ports).status).toBe(
    'lifecycle-removed',
  );
  expect(readFileSync(join(root, settings), 'utf8')).toBe(local);
  expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(project);
  expect(readFileSync(join(root, '.ia/retained/data.json'), 'utf8')).toBe('retained data');
});
it('keeps owning context groups recorded under another Node, and records a Homebrew keg by its stable link (#323)', () => {
  const root = temp(),
    input = request(root),
    statePath = '.ia/distributions/hosts/claude-context-fixture.json';
  // As a registration made under another Node records them, in the state and the settings alike: a keg's versioned path, say.
  const recordedAs = (command: string) => {
    const state = JSON.parse(readFileSync(join(root, statePath), 'utf8')),
      config = JSON.parse(readFileSync(join(root, settings), 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit'])
      for (const group of [state.groups[event], config.hooks[event][0]])
        for (const hook of group.hooks) hook.command = command;
    put(root, statePath, json(state));
    put(root, settings, json(config));
  };
  applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
  recordedAs('/opt/homebrew/Cellar/node@22/22.21.0/bin/node');
  expect(applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports).status).toBe(
    'lifecycle-registered',
  );
  expect(JSON.parse(readFileSync(join(root, settings), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command).toBe(
    nodeCommand(),
  );
  recordedAs('/opt/homebrew/Cellar/node@22/22.21.0/bin/node');
  expect(applyLifecycleRegistration(planLifecycleRegistration(root, { remove: 'fixture' }, ports), ports).status).toBe(
    'lifecycle-removed',
  );
  // Any absolute Node is owned, whatever its file is called (Fedora's is /usr/bin/node-22), and re-applying rewrites it; a
  // relative command is not an owned registration.
  applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
  recordedAs('/usr/bin/node-22');
  expect(applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports).status).toBe(
    'lifecycle-registered',
  );
  expect(JSON.parse(readFileSync(join(root, settings), 'utf8')).hooks.SessionStart[0].hooks[0].command).toBe(
    nodeCommand(),
  );
  recordedAs('node');
  expect(() => planLifecycleRegistration(root, { remove: 'fixture' }, ports)).toThrow(/differs from its fixed binding/);
  // Planned under a Homebrew keg's Node, the groups record the formula's stable opt link.
  const other = temp(),
    prefix = temp(),
    keg = join(prefix, 'Cellar', 'node@22', '22.22.0', 'bin', basename(process.execPath)),
    link = join(prefix, 'opt', 'node@22'),
    running = process.execPath;
  mkdirSync(dirname(keg), { recursive: true });
  writeFileSync(keg, '');
  mkdirSync(dirname(link));
  symlinkSync(join(prefix, 'Cellar', 'node@22', '22.22.0'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const planned = (() => {
    try {
      process.execPath = keg;
      return JSON.parse(planLifecycleRegistration(other, request(other), ports).after.config!);
    } finally {
      process.execPath = running;
    }
  })();
  for (const event of ['SessionStart', 'UserPromptSubmit'])
    expect(
      planned.hooks[event][0].hooks.every(
        (hook: { command: string }) => hook.command === join(link, 'bin', basename(keg)),
      ),
    ).toBe(true);
});
it('refuses edited groups/bindings, stale plans, disabled local hooks and changed emitted identity', () => {
  const root = temp(),
    input = request(root),
    plan = planLifecycleRegistration(root, input, ports);
  expect(() => applyLifecycleRegistration(plan, { implementation: () => 'd'.repeat(64) })).toThrow(/stale|match/i);
  put(root, settings, '{"disableAllHooks":true}');
  expect(() => planLifecycleRegistration(root, input, ports)).toThrow(/disabled/i);
  put(root, settings, '{}');
  const current = planLifecycleRegistration(root, input, ports);
  put(root, '.ia/distributions.lock.json', 'new generation');
  expect(() => applyLifecycleRegistration(current, ports)).toThrow(/stale|match/i);
  applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
  const config = JSON.parse(readFileSync(join(root, settings), 'utf8'));
  config.hooks.UserPromptSubmit[0].hooks[0].args.push('unowned');
  put(root, settings, json(config));
  expect(() => planLifecycleRegistration(root, { remove: 'fixture' }, ports)).toThrow(/changed|modified/i);
});
it.each(['pending', 'binding', 'config', 'state', 'complete'])(
  'recovers the %s boundary and serializes with MCP registration',
  (boundary) => {
    const root = temp(),
      input = request(root);
    put(root, settings, json({ keep: true }));
    const plan = planLifecycleRegistration(root, input, ports);
    expect(() =>
      applyLifecycleRegistration(plan, ports, (stage) => {
        if (stage === boundary) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    if (boundary !== 'complete') {
      expect(() => planHost(root, 'claude', input.cache)).toThrow(/recovery|recover/i);
      expect(() => recoverHost(root)).toThrow(/lifecycle|context/i);
    }
    recoverLifecycleRegistration(root);
    const config = JSON.parse(readFileSync(join(root, settings), 'utf8'));
    expect(config.keep).toBe(true);
    expect(Boolean(config.hooks)).toBe(['state', 'complete'].includes(boundary));
    expect(recoverLifecycleRegistration(root).status).toBe('current');
  },
);
it('refuses MCP pending work, live lock ownership and unexpected local recovery edits', () => {
  const root = temp(),
    input = request(root),
    mcp = planHost(root, 'claude', input.cache);
  expect(() =>
    applyHost(mcp, (stage) => {
      if (stage === 'config') throw new Error('interrupted');
    }),
  ).toThrow();
  expect(() => planLifecycleRegistration(root, input, ports)).toThrow(/recover/i);
  recoverHost(root);
  const plan = planLifecycleRegistration(root, input, ports);
  put(root, '.ia/distributions/hosts/lock.json', json({ pid: process.pid }));
  expect(() => applyLifecycleRegistration(plan, ports)).toThrow(/lock|transaction/i);
  expect(() => recoverLifecycleRegistration(root)).toThrow(/running/i);
  const other = temp(),
    alternate = request(other);
  expect(() =>
    applyLifecycleRegistration(planLifecycleRegistration(other, alternate, ports), ports, (stage) => {
      if (stage === 'config') throw new Error('interrupted');
    }),
  ).toThrow();
  put(other, settings, json({ operator: 'changed' }));
  expect(() => recoverLifecycleRegistration(other)).toThrow(/unexpected|edit/i);
  expect(readFileSync(join(other, settings), 'utf8')).toContain('changed');
});
it('has a distinct ownership commit point even for an unchanged installed binding', () => {
  const root = temp(),
    input = request(root);
  applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
  const pretty = JSON.stringify(JSON.parse(readFileSync(join(root, settings), 'utf8')), null, 2) + '\n';
  put(root, settings, pretty);
  const plan = planLifecycleRegistration(root, input, ports);
  expect(() =>
    applyLifecycleRegistration(plan, ports, (stage) => {
      if (stage === 'pending') throw new Error('interrupted');
    }),
  ).toThrow();
  recoverLifecycleRegistration(root);
  expect(readFileSync(join(root, settings), 'utf8')).toBe(pretty);
});
it('routes reviewable lifecycle removal and recovery through the public CLI', async () => {
  const root = temp(),
    input = request(root);
  applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
  const result = await runNative([
    'plan',
    'lifecycle-remove',
    '--root',
    root,
    '--id',
    'fixture',
    '--out',
    '.ia/work/context-remove.json',
  ]);
  expect(result?.result).toMatchObject({ format: 'ia.lifecycle-registration-plan.v1' });
  expect((await runNative(['apply', '--root', root, '--plan', '.ia/work/context-remove.json']))?.result).toMatchObject({
    status: 'lifecycle-removed',
  });
  expect((await runNative(['recover-lifecycle', '--root', root]))?.result).toEqual({ status: 'current' });
});
it('snapshots the reviewed binding before invoking a trusted emitted identity probe', () => {
  const root = temp(),
    input = request(root);
  const plan = planLifecycleRegistration(root, input, {
    implementation: () => {
      input.binding.scope.root = '.ia/src/systems/foreign';
      input.binding.budgets.records = 1;
      return implementation;
    },
  });
  const binding = JSON.parse(plan.after.binding!);
  expect(binding.scope.root).toBe('');
  expect(binding.budgets.records).toBe(32);
});

it('upgrades or removes exact retained v1 single-handler ownership without decoding its old profile', () => {
  for (const upgrade of [true, false]) {
    const root = temp(),
      input = request(root);
    applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
    const path = '.ia/distributions/hosts/claude-context-fixture.json';
    const state = JSON.parse(readFileSync(join(root, path), 'utf8')),
      config = JSON.parse(readFileSync(join(root, settings), 'utf8'));
    state.format = 'ia.lifecycle-registration-state.v1';
    const oldBinding = JSON.parse(readFileSync(join(root, bindingPath), 'utf8'));
    delete oldBinding.profile.maxContextCharacters;
    delete oldBinding.profile.maxContextParts;
    delete oldBinding.profile.digest;
    oldBinding.profile.digest = sha256(canonicalDistributionJson(oldBinding.profile));
    delete oldBinding.digest;
    oldBinding.digest = sha256(canonicalDistributionJson(oldBinding));
    expect(() => verifyLifecycleProfile(oldBinding.profile)).toThrow(/profile/i);
    const oldBytes = json(oldBinding);
    put(root, bindingPath, oldBytes);
    state.binding = sha256(oldBytes);
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const group = state.groups[event];
      group.hooks = [group.hooks[0]];
      group.hooks[0].args = group.hooks[0].args.slice(0, 6);
      config.hooks[event] = [group];
    }
    put(root, path, json(state));
    put(root, settings, json(config));
    const result = applyLifecycleRegistration(
      planLifecycleRegistration(root, upgrade ? input : { remove: 'fixture' }, ports),
      ports,
    );
    expect(result.status).toBe(upgrade ? 'lifecycle-registered' : 'lifecycle-removed');
    if (upgrade) {
      expect(JSON.parse(readFileSync(join(root, path), 'utf8')).format).toBe('ia.lifecycle-registration-state.v2');
      expect(JSON.parse(readFileSync(join(root, settings), 'utf8')).hooks.SessionStart[0].hooks).toHaveLength(12);
    }
  }
});

it('refuses a verified older cache lacking the installed segmented profile handshake', () => {
  const old = { format: 'ia.context-hook-identity.v1', implementation };
  expect(() => probeContextHookImplementation(verifyHostCache(cache(old)))).toThrow(
    /fields|profile|identity|context|unsupported/i,
  );
  const current = {
    format: 'ia.context-hook-identity.v2',
    implementation,
    profile: lifecycleProfile('claude-code', '2.1.278').digest,
    slots: 12,
    characters: 10_000,
  };
  expect(probeContextHookImplementation(verifyHostCache(cache(current)))).toBe(implementation);
  for (const altered of [
    { ...current, slots: 1 },
    { ...current, profile: 'b'.repeat(64) },
    { ...current, characters: 80_000 },
  ])
    expect(() => probeContextHookImplementation(verifyHostCache(cache(altered)))).toThrow();
});
const layouts = [
  ['two-space CRLF', 2, '\r\n'],
  ['tab LF', '\t', '\n'],
] as const;
const pretty = (value: unknown, indent: number | string, eol: string): string =>
  JSON.stringify(value, null, indent).replaceAll('\n', eol) + eol;
it.each(layouts)(
  'edits a %s settings file in place and restores it byte-identically on removal',
  (_name, indent, eol) => {
    const root = temp(),
      input = request(root),
      sibling = { matcher: 'startup', hooks: [{ type: 'command', command: 'other' }] };
    const original = pretty(
      {
        permissions: { allow: ['Bash(ls)'] },
        hooks: { SessionStart: [sibling], PreToolUse: [] },
        env: { Z: '1', A: '2' },
      },
      indent,
      eol,
    );
    const node = findNodeAtLocation(parseTree(original)!, ['hooks', 'SessionStart', 0])!,
      cut = node.offset + node.length,
      tail = original.slice(original.indexOf('"env"'));
    put(root, settings, original);
    applyLifecycleRegistration(planLifecycleRegistration(root, input, ports), ports);
    const applied = readFileSync(join(root, settings), 'utf8');
    expect(applied.slice(0, cut)).toBe(original.slice(0, cut));
    expect(applied.endsWith(tail)).toBe(true);
    expect(applied.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
    expect(JSON.parse(applied).hooks.UserPromptSubmit[0].hooks).toHaveLength(12);
    applyLifecycleRegistration(planLifecycleRegistration(root, { remove: 'fixture' }, ports), ports);
    expect(readFileSync(join(root, settings), 'utf8')).toBe(original);
  },
);
