import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { json, sha256 } from '../src/files.js';
import { applyHost, nodeCommand, planHost } from '../src/host.js';
import {
  applyGuardRegistration,
  FAIL_CLOSED_ACCEPTED,
  guardGroup,
  planGuardRegistration,
} from '../src/guard-registration.js';
import { observeHosts } from '../src/host-observe.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-observe-'));
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
function cacheV2(tag = 'l') {
  const root = temp(),
    inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] }),
    launcher = `// ${tag}\n`;
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(
    root,
    'release.json',
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  return root;
}
const release = (cache: string) => sha256(readFileSync(join(cache, 'release.json')));
/** Sets the Node a guard handler runs: the command of the direct form, or `$0` of the POSIX `/bin/sh` form. */
const withNode = (handler: { command: string; args: string[] }, node: string) => {
  if (handler.command === '/bin/sh') handler.args[2] = node;
  else handler.command = node;
};
/** Some filesystems/CI sandboxes refuse hard links; the one test that needs one skips there instead of failing. */
const hardlinksSupported = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-observe-link-probe-'));
  try {
    writeFileSync(join(dir, 'a'), 'x');
    linkSync(join(dir, 'a'), join(dir, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
it('reports absent, registered, and stale for a different release, a missing launcher or an edited entry', () => {
  const root = temp(),
    cache = cacheV2();
  expect(observeHosts(root, release(cache))).toEqual([]);
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  expect(observeHosts(root, release(cache))).toMatchObject([
    { host: 'claude', status: 'registered', launcherExists: true, reasons: [] },
  ]);
  expect(observeHosts(root, release(cacheV2('other')))[0]).toMatchObject({ status: 'stale', reasons: ['release'] });
  const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  config.mcpServers['ia-workspace'].args.push('x');
  put(root, '.mcp.json', json(config));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
  rmSync(cache, { recursive: true, force: true });
  expect(observeHosts(root, null)[0]).toMatchObject({ status: 'stale', launcherExists: false });
});
it('never throws on a malformed .mcp.json; reports mcp-modified instead', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  // A hand-corrupted .mcp.json (invalid JSON syntax) must read as drift, never an exception.
  put(root, '.mcp.json', '{ not json');
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
});
it('never throws on a malformed settings.local.json; reports guard-modified independently of mcp', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  // A hand-corrupted .claude/settings.local.json (invalid JSON syntax) must read as drift, never an exception.
  put(root, '.claude/settings.local.json', 'not even close to json');
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  const observed = observeHosts(root, release(cache))[0]!;
  expect(observed.status).toBe('stale');
  expect(observed.reasons).toContain('guard-modified');
  expect(observed.reasons).not.toContain('mcp-modified');
});
it('matches the codex apply-time reconciliation: intact stays registered; stripped markers, a duplicated block or an out-of-block table all report mcp-modified', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'codex', cache));
  expect(observeHosts(root, release(cache))).toMatchObject([{ host: 'codex', status: 'registered', reasons: [] }]);
  const original = readFileSync(resolve(root, '.codex/config.toml'), 'utf8');
  // Markers stripped, TOML body kept: reconcileConfig can no longer locate the owned block by its exact bytes.
  const stripped = original
    .split('\n')
    .filter((line) => !line.startsWith('# BEGIN IA PROJECTION') && !line.startsWith('# END IA PROJECTION'))
    .join('\n');
  put(root, '.codex/config.toml', stripped);
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
  // The whole block duplicated: the first occurrence is no longer uniquely located.
  put(root, '.codex/config.toml', original + original);
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
  // An extra table outside the block, extending the same owned server entry with a field this authority never wrote.
  put(root, '.codex/config.toml', original + '\n[mcp_servers."ia-workspace".env]\nEXTRA = "1"\n');
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
});
it('flags guard-release when the guard is pinned to a different cache than the mcp entry, and guard-launcher once that cache disappears', () => {
  const root = temp(),
    a = cacheV2('a'),
    b = cacheV2('b');
  applyHost(planHost(root, 'claude', a));
  applyGuardRegistration(planGuardRegistration(root, { cache: b }));
  const before = observeHosts(root, release(a))[0]!;
  expect(before.status).toBe('stale');
  expect(before.reasons).toContain('guard-release');
  expect(before.reasons).not.toContain('guard-launcher');
  rmSync(b, { recursive: true, force: true });
  const after = observeHosts(root, release(a))[0]!;
  expect(after.reasons).toContain('guard-release');
  expect(after.reasons).toContain('guard-launcher');
});
it('degrades a corrupted own host-state file to a stale state-invalid row instead of throwing, leaving other hosts intact', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyHost(planHost(root, 'codex', cache));
  // Disk corruption or a truncated write, not anything any code path here produces.
  put(root, '.ia/distributions/hosts/claude-workspace.json', 'not json at all');
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  const rows = observeHosts(root, release(cache));
  expect(rows.find((row) => row.host === 'claude')).toEqual({
    host: 'claude',
    status: 'stale',
    release: null,
    cache: null,
    launcher: null,
    launcherExists: false,
    reasons: ['state-invalid'],
    elements: [],
  });
  expect(rows.find((row) => row.host === 'codex')).toMatchObject({ status: 'registered' });
});
it('degrades to state-invalid on a corrupted guard state without disturbing the mcp reading for the same host', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  put(root, '.ia/distributions/hosts/claude-guard-workspace.json', 'not json at all');
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  const observed = observeHosts(root, release(cache))[0]!;
  expect(observed.reasons).toContain('state-invalid');
  expect(observed.release).toBe(release(cache));
  expect(observed.launcherExists).toBe(true);
});
it('never throws on non-UTF-8 bytes in the host state file; the other host is still observed', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyHost(planHost(root, 'codex', cache));
  // 0xC0/0xC1 are invalid UTF-8 lead bytes under any continuation; not achievable by writing a JS string.
  writeFileSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'), Buffer.from([0xc0, 0xc1, 0xff, 0xfe]));
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  const rows = observeHosts(root, release(cache));
  expect(rows.find((row) => row.host === 'claude')).toMatchObject({ status: 'stale', reasons: ['state-invalid'] });
  expect(rows.find((row) => row.host === 'codex')).toMatchObject({ status: 'registered' });
});
it.skipIf(!hardlinksSupported)(
  'never throws on a hardlinked guard state file; the other host is still observed',
  () => {
    const root = temp(),
      cache = cacheV2();
    applyHost(planHost(root, 'claude', cache));
    applyGuardRegistration(planGuardRegistration(root, { cache }));
    applyHost(planHost(root, 'codex', cache));
    const guardPath = resolve(root, '.ia/distributions/hosts/claude-guard-workspace.json');
    const decoy = resolve(root, '.ia/distributions/hosts/decoy.json');
    writeFileSync(decoy, readFileSync(guardPath));
    rmSync(guardPath);
    linkSync(decoy, guardPath); // nlink now 2: `bytes()` refuses an aliased regular file.
    expect(() => observeHosts(root, release(cache))).not.toThrow();
    const rows = observeHosts(root, release(cache));
    expect(rows.find((row) => row.host === 'claude')?.reasons).toContain('state-invalid');
    expect(rows.find((row) => row.host === 'codex')).toMatchObject({ status: 'registered' });
  },
);
it('never throws when a projection state path is a directory instead of a file; the mcp reading for that host survives', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  mkdirSync(resolve(root, '.ia/distributions/hosts/claude-projection.json'));
  expect(() => observeHosts(root, release(cache))).not.toThrow();
  const observed = observeHosts(root, release(cache))[0]!;
  expect(observed.reasons).toContain('state-invalid');
  expect(observed.status).toBe('stale');
  expect(observed.release).toBe(release(cache));
  expect(observed.elements).not.toContain('projection');
});
it('reports launcher-unverified when the cache payload is tampered with after apply', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  // release.json is untouched, so currentRelease still matches state.release; only the launcher bytes changed.
  put(cache, 'scripts/ia.mjs', '// tampered\n');
  const observed = observeHosts(root, release(cache))[0]!;
  expect(observed.status).toBe('stale');
  expect(observed.reasons).toContain('launcher-unverified');
});
it('reports guard-modified when the owned PreToolUse group is duplicated', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.local.json'), 'utf8'));
  settings.hooks.PreToolUse.push(settings.hooks.PreToolUse[0]);
  put(root, '.claude/settings.local.json', json(settings));
  const observed = observeHosts(root, release(cache))[0]!;
  expect(observed.reasons).toContain('guard-modified');
});
it('stays registered through an unrelated reformatting edit of .mcp.json', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  const config = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
  // Different indentation, same parsed value: the comparison is by canonical value, never by bytes.
  put(root, '.mcp.json', JSON.stringify(config, null, 4) + '\n');
  expect(observeHosts(root, release(cache))).toMatchObject([{ host: 'claude', status: 'registered', reasons: [] }]);
});
/** Rewrites a recorded command in the MCP ownership state and in the file it owns, consistently, as a forger would. */
function forge(
  root: string,
  host: 'claude' | 'codex',
  edit: (server: { command: string; args: string[] }) => { command: string; args: string[] },
) {
  const statePath = `.ia/distributions/hosts/${host}-workspace.json`,
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  if (host === 'claude') {
    const server = edit(JSON.parse(state.owned)),
      config = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
    config.mcpServers['ia-workspace'] = server;
    put(root, '.mcp.json', json(config));
    put(root, statePath, json({ ...state, owned: json(server) }));
  } else {
    const found = /command = (".*")\nargs = (\[.*\])\n/.exec(state.owned)!,
      server = edit({ command: JSON.parse(found[1]!), args: JSON.parse(found[2]!) });
    const owned = `[mcp_servers."ia-workspace"]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
    put(
      root,
      '.codex/config.toml',
      readFileSync(resolve(root, '.codex/config.toml'), 'utf8').replace(state.owned, owned),
    );
    put(root, statePath, json({ ...state, owned }));
  }
}
it('reports a forged registration whose owned entry is not the derived one as mcp-modified, for Claude and Codex', () => {
  const root = temp(),
    cache = cacheV2();
  applyHost(planHost(root, 'claude', cache));
  applyHost(planHost(root, 'codex', cache));
  expect(observeHosts(root, release(cache))).toMatchObject([{ status: 'registered' }, { status: 'registered' }]);
  // A command that is not an absolute path, and Node with arbitrary arguments: both consistent in state and file. Any absolute
  // program with the derived arguments reads as IA's own, as the context groups read it (`recordedNode`).
  forge(root, 'claude', (server) => ({ ...server, command: 'node' }));
  forge(root, 'codex', (server) => ({ ...server, args: ['-e', 'process.exit(0)'] }));
  const rows = observeHosts(root, release(cache));
  expect(rows.find((row) => row.host === 'claude')).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
  expect(rows.find((row) => row.host === 'codex')).toMatchObject({ status: 'stale', reasons: ['mcp-modified'] });
  // Re-applying writes the derived entry again, because the forged one is still exactly what the state claims.
  applyHost(planHost(root, 'claude', cache));
  applyHost(planHost(root, 'codex', cache));
  expect(observeHosts(root, release(cache))).toMatchObject([{ status: 'registered' }, { status: 'registered' }]);
});
it("reads any absolute Node as the registration's own, whatever it is called, and a relative one as not IA's", () => {
  const root = temp(),
    cache = cacheV2(),
    named = join(temp(), 'node-22');
  writeFileSync(named, '');
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const statePath = '.ia/distributions/hosts/claude-guard-workspace.json',
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  const recordAs = (node: string) => {
    withNode(state.group.hooks[0], node);
    const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.local.json'), 'utf8'));
    settings.hooks.PreToolUse[0] = state.group;
    put(root, statePath, json(state));
    put(root, '.claude/settings.local.json', json(settings));
  };
  // Fedora records /usr/bin/node-22: the MCP entry and the guard both stay registered.
  recordAs(named);
  forge(root, 'claude', (server) => ({ ...server, command: named }));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'registered', reasons: [] });
  // A relative guard Node fails the ownership validator itself, which plan and remove share (`saved`).
  recordAs('node');
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['state-invalid'] });
});
it('reports a guard group in a form this release no longer writes as guard-form, and re-applying rewrites it (#323)', () => {
  const root = temp(),
    cache = cacheV2(),
    launcher = join(cache, 'scripts/ia.mjs');
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  const statePath = '.ia/distributions/hosts/claude-guard-workspace.json',
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  const registerAs = (group: unknown) => {
    state.group = group;
    const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.local.json'), 'utf8'));
    settings.hooks.PreToolUse[0] = group;
    put(root, statePath, json(state));
    put(root, '.claude/settings.local.json', json(settings));
  };
  // The previous fail-closed script, which names no remedy (a /bin/sh form win32 never writes, there).
  const previous = JSON.parse(json(guardGroup(launcher, root, 'linux')));
  previous.hooks[0].args[1] = FAIL_CLOSED_ACCEPTED[1];
  registerAs(previous);
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['guard-form'] });
  // The direct form, which fails open off win32 when its Node cannot run, and is the current form on win32.
  registerAs(guardGroup(launcher, root, 'win32'));
  expect(observeHosts(root, release(cache))[0]).toMatchObject(
    process.platform === 'win32' ? { status: 'registered', reasons: [] } : { status: 'stale', reasons: ['guard-form'] },
  );
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'registered', reasons: [] });
  expect(JSON.parse(readFileSync(resolve(root, '.claude/settings.local.json'), 'utf8')).hooks.PreToolUse).toEqual([
    guardGroup(launcher, root),
  ]);
});
it('reports a guard group with the file-tool matcher as guard-form, and re-applying rewrites it (#540)', () => {
  const root = temp(),
    cache = cacheV2(),
    launcher = join(cache, 'scripts/ia.mjs'),
    settings = '.claude/settings.local.json',
    statePath = '.ia/distributions/hosts/claude-guard-workspace.json';
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  // As registered before #540: the group a fresh apply writes on this platform, with only the file tools routed to it.
  for (const path of [settings, statePath])
    put(
      root,
      path,
      readFileSync(resolve(root, path), 'utf8').replace(
        '"Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"',
        '"Write|Edit|MultiEdit"',
      ),
    );
  const matchers = () => [
    JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse.map(
      (group: { matcher: string }) => group.matcher,
    ),
    JSON.parse(readFileSync(resolve(root, statePath), 'utf8')).group.matcher,
  ];
  expect(matchers()).toEqual([['Write|Edit|MultiEdit'], 'Write|Edit|MultiEdit']);
  const observe = () =>
    observeHosts(root, release(cache)).map(({ host, status, reasons, elements }) => ({
      host,
      status,
      reasons,
      elements,
    }));
  // Still owned and still the platform's current handler, so neither modified nor invalid: only the routing is out of date.
  expect(observe()).toEqual([{ host: 'claude', status: 'stale', reasons: ['guard-form'], elements: ['mcp', 'hooks'] }]);
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  expect(observe()).toEqual([{ host: 'claude', status: 'registered', reasons: [], elements: ['mcp', 'hooks'] }]);
  expect(matchers()).toEqual([
    ['Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'],
    'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
  ]);
  expect(JSON.parse(readFileSync(resolve(root, settings), 'utf8')).hooks.PreToolUse).toEqual([
    guardGroup(launcher, root),
  ]);
});
it('reports node-missing when the recorded Node executable is gone, and re-applying records the running one', () => {
  const root = temp(),
    cache = cacheV2(),
    gone = join(temp(), process.platform === 'win32' ? 'node.exe' : 'node');
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  // The guard's own Node alone first, so its check is pinned apart from the MCP entry's; then the MCP entry's as well.
  const statePath = '.ia/distributions/hosts/claude-guard-workspace.json',
    state = JSON.parse(readFileSync(resolve(root, statePath), 'utf8'));
  withNode(state.group.hooks[0], gone);
  const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.local.json'), 'utf8'));
  settings.hooks.PreToolUse[0] = state.group;
  put(root, statePath, json(state));
  put(root, '.claude/settings.local.json', json(settings));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['node-missing'] });
  forge(root, 'claude', (server) => ({ ...server, command: gone }));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'stale', reasons: ['node-missing'] });
  applyHost(planHost(root, 'claude', cache));
  applyGuardRegistration(planGuardRegistration(root, { cache }));
  expect(observeHosts(root, release(cache))[0]).toMatchObject({ status: 'registered', reasons: [] });
  expect(JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')).mcpServers['ia-workspace'].command).toBe(
    nodeCommand(),
  );
});
