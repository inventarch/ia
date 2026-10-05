import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { platformDebris } from '@inventarch/db/distribution';
import { json, sha256 } from '../src/files.js';
import { HOST_MODES } from '../src/host-modes.js';

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const roots: string[] = [];
function cache(options: { v2?: boolean; pinned?: Readonly<Record<string, string>>; context?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ia-context-launcher-'));
  roots.push(root);
  const path = 'runtime/node_modules/@inventarch/steward-hook/dist/context.js';
  const files = new Map([
    ['runtime/node_modules/@inventarch/steward-hook/package.json', '{"type":"module"}'],
    [
      path,
      options.context ??
        'export async function runContextHook(args,input){return args.length===1&&args[0]==="identity"?{format:"ia.context-hook-identity.v1",implementation:"' +
          'a'.repeat(64) +
          '"}:{args,input};}',
    ],
    ...Object.entries(options.pinned ?? {}),
  ]);
  const shared = {
    name: 'fixture',
    version: '1',
    packages: [],
    files: [...files].map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) })),
  };
  const inventory = json(
    options.v2
      ? { format: 'ia.host-cache.v2', ...shared }
      : { format: 'ia.host-cache.v1', host: 'claude', native: 'b'.repeat(64), ...shared },
  );
  files.set('inventory.json', inventory);
  files.set(
    'scripts/ia.mjs',
    readFileSync(resolve(import.meta.dirname, '../assets/host-launcher.mjs'), 'utf8').replace(
      '__INVENTORY_DIGEST__',
      sha256(inventory),
    ),
  );
  for (const [path, content] of files) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return {
    root,
    module: join(root, path),
    launch: (
      args: string[],
      input?: string | Buffer,
      live: { signal?: AbortSignal; onStderr?: (chunk: string) => void } = {},
    ) =>
      runBounded(process.execPath, [join(root, 'scripts/ia.mjs'), ...args], {
        ...(input === undefined ? {} : { input }),
        ...live,
        timeoutMs: SUBPROCESS,
        maxBufferBytes: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      }),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-context-launcher-')))
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('probes context identity through the actual verified packaged launcher', async () => {
  const result = await cache().launch(['context', 'identity']);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ format: 'ia.context-hook-identity.v1', implementation: 'a'.repeat(64) });
});
it('delivers exact explicit root/binding and UTF-8 stdin through the context route', async () => {
  const selected = cache(),
    args = ['--root', resolve(tmpdir()), '--binding', join(tmpdir(), 'binding.json')],
    input = '{"prompt":"A bounded café"}';
  args.push('--part', '11');
  const result = await selected.launch(['context', ...args], input);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ args, input });
});
it('refuses malformed context selection and unbounded or invalid UTF-8 input without invoking context', async () => {
  const selected = cache(),
    good = ['context', '--root', resolve(tmpdir()), '--binding', join(tmpdir(), 'binding.json')];
  const cases: [string[], string | Buffer | undefined][] = [
    [['context', 'identity', 'extra'], undefined],
    [['context', '--root', 'relative', '--binding', '/binding'], undefined],
    [['context', '--root', selected.root, '--binding', join(selected.root, 'binding')], undefined],
    [[...good, '--part', '12'], undefined],
    [[...good, '--part', '01'], undefined],
    [good, Buffer.alloc(1024 * 1024 + 1)],
    [good, Buffer.from([0xc3, 0x28])],
  ];
  for (const [args, input] of cases) {
    const result = await selected.launch(args, input);
    expect(JSON.parse(result.stdout)).toMatchObject({
      systemMessage: expect.stringContaining('IA-LIFECYCLE-UNAVAILABLE'),
    });
  }
});
it('preserves inventory tamper refusal and rejects unknown launcher modes', async () => {
  const selected = cache(),
    unknown = await selected.launch(['unknown']);
  expect(unknown.status).toBe(1);
  expect(JSON.parse(unknown.stderr).status).toBe('refused');
  writeFileSync(selected.module, '// changed');
  const changed = await selected.launch(['context', 'identity']);
  expect(changed.status).toBe(1);
  expect(JSON.parse(changed.stdout)).toMatchObject({
    systemMessage: expect.stringContaining('IA-LIFECYCLE-UNAVAILABLE'),
  });
});
function doorCache(
  source = 'export function runCli(args){return {exitCode:args[0]==="records"?0:1,stdout:JSON.stringify({args})+"\\n"};}',
) {
  const selected = cache();
  const cli = 'runtime/node_modules/@inventarch/cli/dist/main.js',
    manifest = 'runtime/node_modules/@inventarch/cli/package.json';
  const files = new Map([
    [manifest, '{"type":"module"}'],
    [cli, source],
  ]);
  const inventory = JSON.parse(readFileSync(join(selected.root, 'inventory.json'), 'utf8'));
  for (const [path, content] of files) {
    mkdirSync(dirname(join(selected.root, path)), { recursive: true });
    writeFileSync(join(selected.root, path), content);
    inventory.files.push({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  const text = json(inventory);
  writeFileSync(join(selected.root, 'inventory.json'), text);
  writeFileSync(
    join(selected.root, 'scripts/ia.mjs'),
    readFileSync(resolve(import.meta.dirname, '../assets/host-launcher.mjs'), 'utf8').replace(
      '__INVENTORY_DIGEST__',
      sha256(text),
    ),
  );
  return selected;
}
it('passes door operations through to @inventarch/cli with its exit code', async () => {
  const selected = doorCache(),
    root = resolve(tmpdir());
  const ok = await selected.launch(['door', 'records', '--root', root]);
  expect(ok.status, ok.stderr).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual({ args: ['records', '--root', root] });
  expect((await selected.launch(['door', 'report', '--root', root])).status).toBe(1);
});
it('refuses door against a changed cache before loading @inventarch/cli', async () => {
  const selected = doorCache();
  writeFileSync(join(selected.root, 'runtime/node_modules/@inventarch/cli/dist/main.js'), 'throw new Error("loaded")');
  const result = await selected.launch(['door', 'records', '--root', resolve(tmpdir())]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/differs/);
  expect(result.stderr).not.toMatch(/loaded/);
});
it('accepts exactly the exported modes plus the private service bridge', () => {
  const launcher = readFileSync(resolve(import.meta.dirname, '../assets/host-launcher.mjs'), 'utf8');
  const listed = /\['distribution'[^\]]*\]/
    .exec(launcher)![0]
    .match(/'([a-z-]+)'/g)!
    .map((m) => m.slice(1, -1));
  expect(['verify', 'context', ...listed].filter((mode) => mode !== 'service').sort()).toEqual(
    HOST_MODES.map((row) => row.mode).sort(),
  );
});
it('refuses a --root that lies inside the cache, not only one that equals it', async () => {
  const selected = doorCache();
  const result = await selected.launch(['door', 'records', '--root', join(selected.root, 'runtime')]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({
    status: 'refused',
    message: 'Explicit absolute consumer --root required',
  });
});
it('refuses a --root inside the cache spelled in another case wherever the volume opens it as the cache', async () => {
  // APFS and NTFS fold case, so there the upper-case spelling is the cache itself (#315); elsewhere it is another path.
  const selected = doorCache(),
    other = join(dirname(selected.root), basename(selected.root).toUpperCase(), 'runtime');
  const result = await selected.launch(['door', 'records', '--root', other]);
  if (existsSync(other)) {
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      status: 'refused',
      message: 'Explicit absolute consumer --root required',
    });
  } else {
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ['records', '--root', other] });
  }
});
it('rejects malformed door argument shapes before dispatch, and still pipes --params - through stdin', async () => {
  const selected = doorCache(),
    root = resolve(tmpdir());
  const bad = await selected.launch(['door', 'records', '--params', '--root', root]);
  expect(bad.status).toBe(1);
  expect(JSON.parse(bad.stderr)).toEqual({
    status: 'refused',
    message: 'door requires <operation> --root <absolute> [--params <JSON|->]',
  });
  const stdinCli = doorCache(
    'import { readFileSync } from "node:fs"; export function runCli(args){ var i=args.indexOf("--params"); var raw = i>=0 ? args[i+1] : null; var params = raw === "-" ? readFileSync(0,"utf8") : raw; return { exitCode: 0, stdout: JSON.stringify({ args: args, params: params }) + "\\n" }; }',
  );
  const ok = await stdinCli.launch(['door', 'records', '--root', root, '--params', '-'], '{"prompt":"ok"}');
  expect(ok.status, ok.stderr).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual({
    args: ['records', '--root', root, '--params', '-'],
    params: '{"prompt":"ok"}',
  });
});
it('prints native and host identity keys from verify, real for v1 and null for an absent v2 shape', async () => {
  const v1 = await cache().launch(['verify']);
  expect(v1.status, v1.stderr).toBe(0);
  expect(JSON.parse(v1.stdout)).toMatchObject({ status: 'verified', native: 'b'.repeat(64), host: 'claude' });
  const v2 = await cache({ v2: true }).launch(['verify']);
  expect(v2.status, v2.stderr).toBe(0);
  expect(JSON.parse(v2.stdout)).toMatchObject({ status: 'verified', native: null, host: null });
});
it('skips the unpinned Finder and AppleDouble files a Mac writes into the cache, and still refuses any other extra file (#323)', async () => {
  const selected = cache();
  for (const path of [
    '.DS_Store',
    'runtime/.DS_Store',
    'runtime/node_modules/@inventarch/steward-hook/dist/._context.js',
  ])
    writeFileSync(join(selected.root, path), 'written by the platform');
  const verified = await selected.launch(['verify']);
  expect(verified.status, verified.stderr).toBe(0);
  expect(JSON.parse(verified.stdout)).toMatchObject({ status: 'verified' });
  writeFileSync(join(selected.root, 'runtime/notes.txt'), 'mine');
  const refused = await selected.launch(['verify']);
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stderr)).toEqual({
    status: 'refused',
    message: 'Plugin cache payload differs: runtime/notes.txt',
  });
});
it('verifies a pinned file named like a Mac file, and refuses it once it changes (#323)', async () => {
  const selected = cache({ pinned: { '._pinned': 'pinned\n' } }),
    verified = await selected.launch(['verify']);
  expect(verified.status, verified.stderr).toBe(0);
  writeFileSync(join(selected.root, '._pinned'), 'PINNED\n');
  const refused = await selected.launch(['verify']);
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stderr)).toEqual({ status: 'refused', message: 'Plugin cache payload differs: ._pinned' });
});
it("skips exactly the names @inventarch/db's platformDebris skips, since it runs without that package (#323)", async () => {
  for (const name of ['.DS_Store', '._x', '._', '.DS_Store.bak', 'x._y', '.ds_store', '.npmrc', '.hidden.mjs']) {
    const selected = cache();
    writeFileSync(join(selected.root, 'runtime', name), 'written by the platform');
    expect([name, (await selected.launch(['verify'])).status]).toEqual([name, platformDebris(name) ? 0 : 1]);
  }
});
it('leaves no stdout when the host cancels a context slot at its outer timeout', async () => {
  // HOST-02 (private source history) process-level timeout fixture. Claude Code cancels a command hook that reaches its timeout and
  // discards its output; the launcher writes once, after the hook settles, so a slot stopped inside synchronous work leaves no
  // partial frame. The stand-in module records on stderr that the hook was entered, then never settles, and the slot is killed on
  // that marker: no fixed clock decides the outcome, and SUBPROCESS stays the ceiling on a slow runner. The stand-in blocks the
  // event loop, so this guards only against a launcher that answers from outside the hook's thread.
  const selected = cache({
    context:
      'import { writeSync } from "node:fs"; export async function runContextHook(){ writeSync(2, "context entered\\n"); for (;;) {} }',
  });
  const entered = new AbortController();
  let seen = '';
  const result = await selected.launch(
    ['context', '--root', resolve(tmpdir()), '--binding', join(tmpdir(), 'binding.json'), '--part', '0'],
    '{}',
    {
      signal: entered.signal,
      onStderr: (chunk) => {
        seen += chunk;
        if (seen.includes('context entered')) entered.abort();
      },
    },
  );
  expect(result.stderr).toContain('context entered');
  expect(result.timedOut).toBe(false);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
});
