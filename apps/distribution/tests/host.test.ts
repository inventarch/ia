import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  applyHost,
  doorServer,
  expectedHostCache,
  HOST_REGISTRATION,
  nodeCommand,
  planHost,
  planHostFor,
  recoverHost,
  verifyHostCache,
} from '../src/host.js';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { json, sha256 } from '../src/files.js';
import { runBounded } from '@tools/testing/subprocess.js';
import { runNative } from '../src/native-command.js';

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-host-plan-'));
  roots.push(root);
  return root;
}
function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), content);
}
function cache(host: 'claude' | 'codex', name = 'fixture'): string {
  const root = temp(),
    content = '// Original inert test payload\n',
    inventory = json({
      format: 'ia.host-cache.v1',
      host,
      name,
      version: '0.1.0',
      native: 'a'.repeat(64),
      packages: [],
      files: [{ path: 'payload.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
    }),
    launcher = '// Qualification fixture; never executed\n';
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
function cacheV2(): string {
  const root = temp(),
    content = '// Original inert test payload\n';
  const inventory = json({
    format: 'ia.host-cache.v2',
    version: '0.1.0',
    packages: [],
    files: [{ path: 'payload.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
  });
  const launcher = '// v2 qualification fixture\n';
  put(root, 'payload.txt', content);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(
    root,
    'release.json',
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir(), 'ia-host-plan-')))
      throw Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(['claude', 'codex'] as const)(
  'plans, activates, updates and removes %s without changing unrelated settings or native locks',
  (host) => {
    const root = temp(),
      first = cache(host),
      second = cache(host),
      path = host === 'claude' ? '.mcp.json' : '.codex/config.toml';
    const original =
      host === 'claude'
        ? json({ mcpServers: { other: { command: 'original' } }, auth: 'keep' })
        : '# Operator comment\nmodel = "original"\n[mcp_servers.other]\ncommand = "original"\n';
    put(root, path, original);
    put(root, '.ia/distributions.lock.json', 'original native lock');
    const plan = planHost(root, host, first);
    expect(readFileSync(resolve(root, path), 'utf8')).toBe(original);
    expect(applyHost(plan).status).toBe('host-active');
    const active = readFileSync(resolve(root, path), 'utf8');
    expect(active).toContain('ia-fixture');
    expect(active).toContain('original');
    expect(applyHost(planHost(root, host, second)).status).toBe('host-active');
    expect(applyHost(planHost(root, host, null, 'fixture')).status).toBe('host-removed');
    expect(readFileSync(resolve(root, path), 'utf8')).toBe(original);
    expect(readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8')).toBe('original native lock');
  },
);
it('refuses cache tampering, unsafe consumer placement, unmanaged collisions and stale settings plans', () => {
  const root = temp(),
    artifact = cache('codex');
  expect(() => planHost(artifact, 'codex', artifact)).toThrow(/inside/);
  put(root, '.codex/config.toml', '[mcp_servers.ia-fixture]\ncommand = "unmanaged"\n');
  expect(() => planHost(root, 'codex', artifact)).toThrow(/conflicts/);
  put(root, '.codex/config.toml', 'model = "initial"\n');
  const plan = planHost(root, 'codex', artifact);
  put(root, '.codex/config.toml', 'model = "changed"\n');
  expect(() => applyHost(plan)).toThrow(/no longer/);
  put(artifact, 'payload.txt', 'drift');
  expect(() => verifyHostCache(artifact)).toThrow(/payload/);
});
it.each(['pending', 'config', 'state', 'complete'])(
  'recovers the %s host transaction boundary without changing native state',
  (boundary) => {
    const root = temp(),
      artifact = cache('claude');
    put(root, '.mcp.json', json({ keep: true }));
    const plan = planHost(root, 'claude', artifact);
    expect(() =>
      applyHost(plan, (name) => {
        if (name === boundary) throw Error('interrupted');
      }),
    ).toThrow('interrupted');
    if (boundary !== 'complete') expect(() => planHost(root, 'claude', artifact)).toThrow(/recover-host/);
    recoverHost(root);
    const result = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
    expect(result.keep).toBe(true);
    expect(Boolean(result.mcpServers)).toBe(['state', 'complete'].includes(boundary));
    expect(recoverHost(root).status).toBe('current');
  },
);
it('preserves unexpected edits during recovery and rejects owned field changes', () => {
  const root = temp(),
    artifact = cache('claude'),
    plan = planHost(root, 'claude', artifact);
  expect(() =>
    applyHost(plan, (name) => {
      if (name === 'config') throw Error('interrupted');
    }),
  ).toThrow('interrupted');
  put(root, '.mcp.json', '{"operator":"changed"}\n');
  expect(() => recoverHost(root)).toThrow(/Unexpected/);
  expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toContain('changed');
  const other = temp();
  applyHost(planHost(other, 'claude', artifact));
  const cfg = JSON.parse(readFileSync(resolve(other, '.mcp.json'), 'utf8'));
  cfg.mcpServers['ia-fixture'].args.push('unowned');
  put(other, '.mcp.json', json(cfg));
  expect(() => planHost(other, 'claude', null, 'fixture')).toThrow(/changed/);
});
it('rechecks cache and native lock immediately before committing ownership', () => {
  const root = temp(),
    artifact = cache('claude'),
    plan = planHost(root, 'claude', artifact);
  expect(() =>
    applyHost(plan, (name) => {
      if (name === 'config') put(root, '.ia/distributions.lock.json', 'new lock');
    }),
  ).toThrow(/native lock changed/);
  recoverHost(root);
  expect(readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8')).toBe('new lock');
});
it('uses the public CLI plan/apply/removal/recovery dispatch and refuses a forged explicit root', async () => {
  const root = temp(),
    artifact = cache('codex');
  await runNative([
    'plan',
    'host',
    '--root',
    root,
    '--host',
    'codex',
    '--cache',
    artifact,
    '--out',
    '.ia/work/host.json',
  ]);
  expect((await runNative(['apply', '--root', root, '--plan', '.ia/work/host.json']))?.result).toMatchObject({
    status: 'host-active',
  });
  await runNative([
    'plan',
    'host-remove',
    '--root',
    root,
    '--host',
    'codex',
    '--id',
    'fixture',
    '--out',
    '.ia/work/remove.json',
  ]);
  expect((await runNative(['apply', '--root', root, '--plan', '.ia/work/remove.json']))?.result).toMatchObject({
    status: 'host-removed',
  });
  expect((await runNative(['recover-host', '--root', root]))?.result).toEqual({ status: 'current' });
  const other = temp();
  put(other, 'forged.json', readFileSync(resolve(root, '.ia/work/host.json'), 'utf8'));
  await expect(runNative(['apply', '--root', other, '--plan', 'forged.json'])).rejects.toThrow(/explicit root/);
});
it('verifies a host-neutral v2 cache and registers it for either host under the fixed id', () => {
  const artifact = cacheV2(),
    verified = verifyHostCache(artifact);
  expect(verified).toMatchObject({ host: null, name: HOST_REGISTRATION, format: 2 });
  for (const host of ['claude', 'codex'] as const) {
    const root = temp(),
      plan = planHost(root, host, artifact),
      state = resolve(root, `.ia/distributions/hosts/${host}-workspace.json`);
    expect(plan.id).toBe('workspace');
    expect(applyHost(plan).status).toBe('host-active');
    const path = host === 'claude' ? '.mcp.json' : '.codex/config.toml',
      active = readFileSync(resolve(root, path), 'utf8');
    expect(active).toContain('ia-workspace');
    if (host === 'codex') expect(active).toContain('# BEGIN IA PROJECTION host-workspace');
    expect(existsSync(state)).toBe(true);
    expect(applyHost(planHost(root, host, null, 'workspace')).status).toBe('host-removed');
    expect(existsSync(state)).toBe(false);
  }
});
it('refuses a v2 release that claims v1 inventory fields', () => {
  const artifact = cacheV2(),
    inventory = json({ format: 'ia.host-cache.v2', host: 'claude', version: '0.1.0', packages: [], files: [] });
  put(artifact, 'inventory.json', inventory);
  put(
    artifact,
    'release.json',
    json({
      format: 'ia.host-release.v2',
      inventory: sha256(inventory),
      launcher: sha256('// v2 qualification fixture\n'),
    }),
  );
  expect(() => verifyHostCache(artifact)).toThrow(/Unexpected managed object fields/);
});
it('refuses a v1 release whose inventory uses the v2 shape', () => {
  const artifact = cache('claude'),
    inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] });
  put(artifact, 'inventory.json', inventory);
  put(
    artifact,
    'release.json',
    json({
      format: 'ia.host-release.v1',
      inventory: sha256(inventory),
      launcher: sha256('// Qualification fixture; never executed\n'),
    }),
  );
  expect(() => verifyHostCache(artifact)).toThrow(/Unexpected managed object fields/);
});
it('builds durable and ephemeral server vectors from one helper', () => {
  expect(doorServer('/cache/scripts/ia.mjs', ['mcp', '--root', '/w'])).toEqual({
    command: nodeCommand(),
    args: ['/cache/scripts/ia.mjs', 'mcp', '--root', '/w'],
  });
  const artifact = cacheV2(),
    root = temp(),
    plan = planHost(root, 'claude', artifact);
  const entry = JSON.parse(plan.after.config!).mcpServers['ia-workspace'];
  expect(entry).toEqual(doorServer(verifyHostCache(artifact).launcher, ['mcp', '--root', root]));
});
it.each(['guard-workspace', 'context-fixture', 'workspace', 'projection'])(
  'refuses the v1 registration name %s that would collide with another state file',
  (name) => {
    expect(() => verifyHostCache(cache('claude', name))).toThrow(/Reserved host registration name/);
  },
);
const layouts = [
  ['two-space CRLF', 2, '\r\n'],
  ['tab LF', '\t', '\n'],
] as const;
const pretty = (value: unknown, indent: number | string, eol: string): string =>
  JSON.stringify(value, null, indent).replaceAll('\n', eol) + eol;
it.each(layouts)('edits a %s .mcp.json in place and restores it byte-identically on removal', (_name, indent, eol) => {
  const root = temp(),
    artifact = cacheV2(),
    original = pretty(
      { mcpServers: { zeta: { command: 'operator', args: ['--x'] }, alpha: { command: 'second' } }, auth: 'keep' },
      indent,
      eol,
    );
  const node = findNodeAtLocation(parseTree(original)!, ['mcpServers', 'alpha'])!.parent!,
    cut = node.offset + node.length;
  put(root, '.mcp.json', original);
  applyHost(planHost(root, 'claude', artifact));
  const applied = readFileSync(resolve(root, '.mcp.json'), 'utf8'),
    inserted = applied.slice(cut, applied.length - (original.length - cut));
  expect(applied.slice(0, cut)).toBe(original.slice(0, cut));
  expect(applied.endsWith(original.slice(cut))).toBe(true);
  expect(inserted.startsWith(',' + eol + (indent === 2 ? '    ' : '\t\t') + '"ia-workspace": {')).toBe(true);
  expect(inserted.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
  expect(applyHost(planHost(root, 'claude', cacheV2())).status).toBe('host-active');
  expect(readFileSync(resolve(root, '.mcp.json'), 'utf8').slice(0, cut)).toBe(original.slice(0, cut));
  applyHost(planHost(root, 'claude', null, 'workspace'));
  expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toBe(original);
});
it.each(['{\n  "mcpServers": {}\n}\n', '{\n  "auth": "keep"\n}\n', '{}\n'])(
  'restores %j byte-identically, keeping pre-existing empty containers',
  (original) => {
    const root = temp(),
      artifact = cacheV2();
    put(root, '.mcp.json', original);
    applyHost(planHost(root, 'claude', artifact));
    expect(JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')).mcpServers['ia-workspace']).toBeDefined();
    applyHost(planHost(root, 'claude', null, 'workspace'));
    expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toBe(original);
  },
);
it.each(['claude', 'codex'] as const)(
  'plans %s against an expected v2 payload exactly as against the verified one, without reading it',
  (host) => {
    const root = temp(),
      built = cacheV2(),
      home = temp(),
      release = sha256(readFileSync(resolve(built, 'release.json'), 'utf8')),
      target = resolve(home, 'hosts', release);
    put(
      root,
      host === 'claude' ? '.mcp.json' : '.codex/config.toml',
      host === 'claude' ? json({ keep: true }) : 'model = "keep"\n',
    );
    const expected = planHostFor(root, host, expectedHostCache(target, release));
    expect(existsSync(target)).toBe(false);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(built, target, { recursive: true });
    expect(planHost(root, host, target)).toEqual(expected);
    expect(() => expectedHostCache('relative', release)).toThrow(/absolute/);
  },
);
it.each(['claude', 'codex'] as const)(
  'removes only the %s ownership state when the user already deleted the owned entry',
  (host) => {
    const root = temp(),
      artifact = cacheV2(),
      path = host === 'claude' ? '.mcp.json' : '.codex/config.toml',
      state = resolve(root, `.ia/distributions/hosts/${host}-workspace.json`);
    const original = host === 'claude' ? json({ mcpServers: { other: { command: 'x' } } }) : 'model = "keep"\n';
    put(root, path, original);
    applyHost(planHost(root, host, artifact));
    put(root, path, original);
    expect(applyHost(planHost(root, host, null, 'workspace')).status).toBe('host-removed');
    expect(readFileSync(resolve(root, path), 'utf8')).toBe(original);
    expect(existsSync(state)).toBe(false);
    // A changed (not deleted) owned entry still refuses.
    applyHost(planHost(root, host, artifact));
    const text = readFileSync(resolve(root, path), 'utf8');
    put(
      root,
      path,
      host === 'claude' ? text.replace('"mcp"', '"mcp","--extra"') : text.replace('args = [', 'args = ["--extra", '),
    );
    expect(() => planHost(root, host, null, 'workspace')).toThrow(/changed/);
  },
);
it.each(['garbage\n', json({ format: 'ia.host-state.v1' })])(
  'locates an unreadable ownership state %# at its own file, keeping the refusal code',
  (text) => {
    const root = temp(),
      payload = cacheV2();
    put(root, `.ia/distributions/hosts/claude-${HOST_REGISTRATION}.json`, text);
    let raised: unknown;
    try {
      planHost(root, 'claude', payload);
    } catch (error) {
      raised = error;
    }
    expect(raised).toMatchObject({
      path: `.ia/distributions/hosts/claude-${HOST_REGISTRATION}.json`,
      code: expect.stringMatching(/^IA-(DIST|DB)-/),
    });
  },
);
/**
 * Spec §10 item 8 for the MCP element: an interruption at every applyHost checkpoint, the named recovery and a rerun
 * end byte for byte where an uninterrupted apply ends in the same workspace.
 */
it.each(['pending', 'config', 'state', 'complete'])(
  'converges byte for byte after recovering the %s checkpoint and rerunning',
  (boundary) => {
    const root = temp(),
      artifact = cacheV2(),
      statePath = `.ia/distributions/hosts/claude-${HOST_REGISTRATION}.json`;
    put(root, '.mcp.json', json({ keep: true }));
    const bytes = () =>
      ['.mcp.json', statePath].map((path) =>
        existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null,
      );
    applyHost(planHost(root, 'claude', artifact));
    const reference = bytes();
    applyHost(planHost(root, 'claude', null, HOST_REGISTRATION));
    expect(() =>
      applyHost(planHost(root, 'claude', artifact), (name) => {
        if (name === boundary) throw Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(recoverHost(root).status).toBe(boundary === 'complete' ? 'current' : 'host-recovered');
    applyHost(planHost(root, 'claude', artifact));
    expect(bytes()).toEqual(reference);
    expect(existsSync(resolve(root, '.ia/distributions/hosts/lock.json'))).toBe(false);
  },
);
it('skips the unpinned Finder and AppleDouble files a Mac writes into a host cache, and verifies a pinned one like any other (#323)', () => {
  const artifact = cache('claude');
  put(artifact, '.DS_Store', 'Finder');
  put(artifact, 'scripts/._ia.mjs', 'AppleDouble');
  put(artifact, '._payload.txt', 'AppleDouble');
  expect(() => verifyHostCache(artifact)).not.toThrow();
  put(artifact, 'notes.txt', 'mine');
  expect(() => verifyHostCache(artifact)).toThrow(/Unexpected host payload/);
  const pinned = temp(),
    content = 'pinned\n',
    inventory = json({
      format: 'ia.host-cache.v2',
      version: '0.1.0',
      packages: [],
      files: [{ path: '._pinned', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
    }),
    launcher = '// v2 qualification fixture\n';
  put(pinned, '._pinned', content);
  put(pinned, 'inventory.json', inventory);
  put(pinned, 'scripts/ia.mjs', launcher);
  put(
    pinned,
    'release.json',
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  expect(() => verifyHostCache(pinned)).not.toThrow();
  put(pinned, '._pinned', 'PINNED\n');
  expect(() => verifyHostCache(pinned)).toThrow(/Host payload changed/);
});
it('still refuses any other dotfile, and a link or special file named like a Mac file (#323)', async () => {
  const dotfile = cache('claude');
  put(dotfile, '.npmrc', 'registry=https://example.invalid\n');
  expect(() => verifyHostCache(dotfile)).toThrow(/Unexpected host payload/);
  if (process.platform === 'win32') return;
  const linked = cache('claude');
  symlinkSync('payload.txt', resolve(linked, '.DS_Store'));
  expect(() => verifyHostCache(linked)).toThrow(/Link\/junction is not allowed/);
  const fifo = cache('claude');
  expect((await runBounded('mkfifo', [resolve(fifo, '.DS_Store')], { timeoutMs: SUBPROCESS })).status).toBe(0);
  expect(() => verifyHostCache(fifo)).toThrow(/Unexpected host payload/);
});
/** A v2 cache whose payload also holds a file one directory down, so a link can stand in for a payload directory. */
function nestedCache(): string {
  const root = temp(),
    top = '// top payload\n',
    inner = '// inner payload\n',
    launcher = '// v2 qualification fixture\n';
  const inventory = json({
    format: 'ia.host-cache.v2',
    version: '0.1.0',
    packages: [],
    files: [
      { path: 'payload.txt', bytes: Buffer.byteLength(top), sha256: sha256(top) },
      { path: 'lib/inner.txt', bytes: Buffer.byteLength(inner), sha256: sha256(inner) },
    ],
  });
  put(root, 'payload.txt', top);
  put(root, 'lib/inner.txt', inner);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(
    root,
    'release.json',
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  return root;
}
/** The refusal `work` raises, or a verified marker, so one comparison can show every case that was let through. */
const refusal = (work: () => unknown): { code: unknown; message: string } => {
  try {
    work();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  return { code: null, message: 'verified' };
};
/** A denied Windows file-link fixture is an explicit skip; all other setup failures still fail the test. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};
/**
 * Every level of the verified path refuses a link, whatever the link reaches: identical bytes stand behind each one, so
 * only the link itself can be what is refused. A directory link is a junction on Windows (no privilege needed) and a
 * symlink elsewhere; a hard-linked payload file is an alias too (LKI-33 pins these before the walk changes).
 */
it('refuses a link or junction at the cache root, an ancestor, a payload or launcher directory, and hard-linked payload files', () => {
  const pristine = nestedCache();
  expect(verifyHostCache(pristine)).toMatchObject({ format: 2 });
  const linkRefused = /Link\/junction is not allowed/;
  const moved = (artifact: string, path: string): string => {
    const outside = resolve(temp(), basename(path));
    renameSync(resolve(artifact, path), outside);
    return outside;
  };
  const arrangements: Record<string, () => string> = {
    'the cache root': () => {
      const link = resolve(temp(), 'cache');
      symlinkSync(nestedCache(), link, 'junction');
      return link;
    },
    'an ancestor of the cache root': () => {
      const real = nestedCache(),
        link = resolve(temp(), 'parent');
      symlinkSync(dirname(real), link, 'junction');
      return resolve(link, basename(real));
    },
    'a payload directory': () => {
      const artifact = nestedCache();
      symlinkSync(moved(artifact, 'lib'), resolve(artifact, 'lib'), 'junction');
      return artifact;
    },
    'the launcher directory': () => {
      const artifact = nestedCache();
      symlinkSync(moved(artifact, 'scripts'), resolve(artifact, 'scripts'), 'junction');
      return artifact;
    },
  };
  const refused: Record<string, { code: unknown; message: string }> = {},
    expected: Record<string, unknown> = {};
  for (const [name, arrange] of Object.entries(arrangements)) {
    const artifact = arrange();
    refused[name] = refusal(() => verifyHostCache(artifact));
    expected[name] = { code: 'IA-DIST-PATH-UNSAFE', message: expect.stringMatching(linkRefused) };
  }
  for (const path of ['payload.txt', 'lib/inner.txt']) {
    const artifact = nestedCache();
    linkSync(moved(artifact, path), resolve(artifact, path));
    refused[`hard-linked ${path}`] = refusal(() => verifyHostCache(artifact));
    expected[`hard-linked ${path}`] = {
      code: 'IA-DIST-PATH-UNSAFE',
      message: `Expected unaliased regular file: ${path}`,
    };
  }
  // One comparison, so a broken guard shows every level it lets through, not only the first.
  expect(refused).toEqual(expected);
});

// Keep unsupported file-link fixtures separate from the mandatory junction and hard-link guards above.
for (const path of ['payload.txt', 'lib/inner.txt'])
  it(`refuses a file symlink at host cache payload ${path}`, (context) => {
    const artifact = nestedCache();
    expect(verifyHostCache(artifact)).toMatchObject({ format: 2 });
    const outside = resolve(temp(), basename(path));
    renameSync(resolve(artifact, path), outside);
    if (!fileLink(outside, resolve(artifact, path)))
      return context.skip('Windows denied file symlink creation (EPERM)');
    expect(refusal(() => verifyHostCache(artifact))).toEqual({
      code: 'IA-DIST-PATH-UNSAFE',
      message: expect.stringMatching(/Link\/junction is not allowed/),
    });
  });
