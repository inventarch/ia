import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { platformDebris } from '@inventarch/db/distribution';
import { json, sha256 } from '../src/files.js';
import { HOST_MODES } from '../src/host-modes.js';
import { RACE_PRELOAD, type Race } from './race-fixture.js';

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
type Cache = ReturnType<typeof cache>;
/** The cache path of the pinned module every fixture cache holds. */
const MODULE = 'runtime/node_modules/@inventarch/steward-hook/dist/context.js';
const POSIX = process.platform !== 'win32';
/** Mode bits do not keep the superuser from reading a file, so an unreadable fixture needs an ordinary user. */
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
/** A directory beside the cache, for the far end of a link and for entries moved out of the cache. */
function outside(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ia-context-launcher-'));
  roots.push(directory);
  return directory;
}
async function mkfifo(path: string): Promise<void> {
  expect((await runBounded('mkfifo', [path], { timeoutMs: SUBPROCESS })).status).toBe(0);
}
/** Pins exactly `files` in the cache's inventory, and its launcher to that inventory. */
function repin(root: string, files: readonly { path: string; bytes: number; sha256: string }[]): void {
  const text = json({ ...JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8')), files });
  writeFileSync(join(root, 'inventory.json'), text);
  writeFileSync(
    join(root, 'scripts/ia.mjs'),
    readFileSync(resolve(import.meta.dirname, '../assets/host-launcher.mjs'), 'utf8').replace(
      '__INVENTORY_DIGEST__',
      sha256(text),
    ),
  );
}
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
/** What `verify` answers: its exit status and the refusal it writes to stderr, or a verified marker. */
async function verdict(selected: Cache): Promise<{ status: number | null; output: unknown }> {
  const result = await selected.launch(['verify']);
  return { status: result.status, output: result.status === 0 ? 'verified' : parsed(result.stderr) };
}
const VERIFIED = { status: 0, output: 'verified' };
const refused = (message: string) => ({ status: 1, output: { status: 'refused', message } });
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
  // APFS and NTFS fold case, so there the upper-case spelling is the cache itself (crowncodes/ia#315); elsewhere it is another path.
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
it('skips the unpinned Finder and AppleDouble files a Mac writes into the cache, and still refuses any other extra file (crowncodes/ia#323)', async () => {
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
it('verifies a pinned file named like a Mac file, and refuses it once it changes (crowncodes/ia#323)', async () => {
  const selected = cache({ pinned: { '._pinned': 'pinned\n' } }),
    verified = await selected.launch(['verify']);
  expect(verified.status, verified.stderr).toBe(0);
  writeFileSync(join(selected.root, '._pinned'), 'PINNED\n');
  const refused = await selected.launch(['verify']);
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stderr)).toEqual({ status: 'refused', message: 'Plugin cache payload differs: ._pinned' });
});
it("skips exactly the names @inventarch/db's platformDebris skips, since it runs without that package (crowncodes/ia#323)", async () => {
  for (const name of ['.DS_Store', '._x', '._', '.DS_Store.bak', 'x._y', '.ds_store', '.npmrc', '.hidden.mjs']) {
    const selected = cache();
    writeFileSync(join(selected.root, 'runtime', name), 'written by the platform');
    expect([name, (await selected.launch(['verify'])).status]).toEqual([name, platformDebris(name) ? 0 : 1]);
  }
});
it('leaves no stdout when the host cancels a context slot at its outer timeout', async () => {
  // Public host lifecycle contract: process-level timeout fixture. Claude Code cancels a command hook that reaches its timeout and
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
/**
 * What the cache walk admits and refuses, entry by entry. Each arrangement changes one entry of a fresh cache and returns
 * the verdict it expects. A link count, like a link or a special file, is judged before the launcher's own files and
 * unpinned platform files are skipped, so a second link to one of those still refuses.
 */
it.each<[string, (selected: Cache) => unknown]>([
  [
    'a missing pinned file',
    (selected) => {
      unlinkSync(selected.module);
      return refused('Plugin cache payload is missing');
    },
  ],
  [
    'a directory where a pinned file belongs',
    (selected) => {
      unlinkSync(selected.module);
      mkdirSync(selected.module);
      return refused('Plugin cache payload is missing');
    },
  ],
  [
    'a pinned file one byte longer than its pin',
    (selected) => {
      appendFileSync(selected.module, ' ');
      return refused(`Plugin cache payload differs: ${MODULE}`);
    },
  ],
  [
    'a pinned file of its pinned length with other bytes',
    (selected) => {
      writeFileSync(selected.module, readFileSync(selected.module, 'utf8').replace('identity', 'IDENTITY'));
      return refused(`Plugin cache payload differs: ${MODULE}`);
    },
  ],
  [
    'a pinned file with a second link',
    (selected) => {
      linkSync(selected.module, join(outside(), 'context.js'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'inventory.json with a second link',
    (selected) => {
      linkSync(join(selected.root, 'inventory.json'), join(outside(), 'inventory.json'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'the launcher with a second link',
    (selected) => {
      linkSync(join(selected.root, 'scripts/ia.mjs'), join(outside(), 'ia.mjs'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'an unpinned release.json',
    (selected) => {
      writeFileSync(join(selected.root, 'release.json'), '{}\n');
      return VERIFIED;
    },
  ],
  [
    'an unpinned release.json with a second link',
    (selected) => {
      writeFileSync(join(selected.root, 'release.json'), '{}\n');
      linkSync(join(selected.root, 'release.json'), join(outside(), 'release.json'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'an unpinned .DS_Store with a second link',
    (selected) => {
      writeFileSync(join(selected.root, 'runtime', '.DS_Store'), 'written by the platform');
      linkSync(join(selected.root, 'runtime', '.DS_Store'), join(outside(), '.DS_Store'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'a directory link or junction on the way to a pinned file',
    (selected) => {
      const dist = dirname(selected.module),
        moved = join(outside(), 'dist');
      renameSync(dist, moved);
      symlinkSync(moved, dist, 'junction');
      return refused('Plugin cache links are unsupported');
    },
  ],
])('verify answers for %s', async (_, arrange) => {
  const selected = cache(),
    expected = arrange(selected);
  expect(await verdict(selected)).toEqual(expected);
});
it.each<[string, (selected: Cache) => Promise<unknown>]>([
  [
    'a symbolic link where a pinned file belongs',
    async (selected) => {
      const moved = join(outside(), 'context.js');
      renameSync(selected.module, moved);
      symlinkSync(moved, selected.module);
      return refused('Plugin cache links are unsupported');
    },
  ],
  [
    'a dangling symbolic link',
    async (selected) => {
      symlinkSync(join(outside(), 'nowhere'), join(selected.root, 'runtime', 'dangling'));
      return refused('Plugin cache links are unsupported');
    },
  ],
  [
    'a FIFO at an unpinned name',
    async (selected) => {
      await mkfifo(join(selected.root, 'runtime', 'fifo'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'a FIFO named .DS_Store',
    async (selected) => {
      await mkfifo(join(selected.root, 'runtime', '.DS_Store'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'a FIFO named release.json',
    async (selected) => {
      await mkfifo(join(selected.root, 'release.json'));
      return refused('Plugin cache file is aliased');
    },
  ],
  [
    'a FIFO where a pinned file belongs',
    async (selected) => {
      unlinkSync(selected.module);
      await mkfifo(selected.module);
      return refused('Plugin cache file is aliased');
    },
  ],
])('verify answers for %s (POSIX)', async (_, arrange) => {
  if (!POSIX) return;
  const selected = cache(),
    expected = await arrange(selected);
  expect(await verdict(selected)).toEqual(expected);
});
it('verify refuses a UNIX socket in the cache as an aliased file (POSIX)', async () => {
  if (!POSIX) return;
  const selected = cache(),
    server = createServer();
  server.listen(join(selected.root, 'runtime', 's'));
  await once(server, 'listening');
  try {
    expect(await verdict(selected)).toEqual(refused('Plugin cache file is aliased'));
  } finally {
    server.close();
  }
});
/** An unreadable file is judged as a readable one would be, and only the read of a pinned file it admits fails. */
it.each<[string, (selected: Cache) => unknown]>([
  [
    'an unreadable pinned file',
    (selected) => {
      chmodSync(selected.module, 0);
      return refused(`EACCES: permission denied, open '${selected.module}'`);
    },
  ],
  [
    'an unreadable pinned file one byte longer than its pin',
    (selected) => {
      appendFileSync(selected.module, ' ');
      chmodSync(selected.module, 0);
      return refused(`Plugin cache payload differs: ${MODULE}`);
    },
  ],
  [
    'an unreadable unpinned .DS_Store',
    (selected) => {
      writeFileSync(join(selected.root, 'runtime', '.DS_Store'), 'written by the platform');
      chmodSync(join(selected.root, 'runtime', '.DS_Store'), 0);
      return VERIFIED;
    },
  ],
])('verify answers for %s (POSIX, unprivileged)', async (_, arrange) => {
  if (!UNPRIVILEGED) return;
  const selected = cache(),
    expected = arrange(selected);
  expect(await verdict(selected)).toEqual(expected);
});
it('verify admits a pinned payload of exactly 256 MiB and refuses one byte more', async () => {
  const budget = 256 * 1024 * 1024,
    zeros = Buffer.alloc(1024 * 1024),
    verdicts: unknown[] = [];
  for (const bytes of [budget, budget + 1]) {
    // A sparse file of zeros, the only pinned file, so the budget alone decides.
    const selected = cache(),
      big = join(selected.root, 'big'),
      digest = createHash('sha256');
    rmSync(join(selected.root, 'runtime'), { recursive: true });
    writeFileSync(big, '');
    truncateSync(big, bytes);
    for (let left = bytes; left > 0; left -= zeros.length)
      digest.update(zeros.subarray(0, Math.min(left, zeros.length)));
    repin(selected.root, [{ path: 'big', bytes, sha256: digest.digest('hex') }]);
    verdicts.push(await verdict(selected));
  }
  expect(verdicts).toEqual([VERIFIED, refused('Plugin cache payload differs: big')]);
});
/**
 * What `verify` answers when `race` changes the pinned module between two of the launcher's own calls, run by the race
 * preload, and whether the launcher had to be stopped at the subprocess bound.
 */
async function raced(selected: Cache, race: Race) {
  const preload = join(outside(), 'race.mjs');
  writeFileSync(preload, RACE_PRELOAD);
  const result = await runBounded(
    process.execPath,
    ['--import', pathToFileURL(preload).href, join(selected.root, 'scripts/ia.mjs'), 'verify'],
    {
      timeoutMs: SUBPROCESS,
      maxBufferBytes: 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        IA_TEST_RACE: JSON.stringify({ target: selected.module, ...race }),
      },
    },
  );
  return {
    timedOut: result.timedOut,
    status: result.status,
    output: result.status === 0 ? 'verified' : parsed(result.stderr),
  };
}
/** A copy of the pinned module outside the cache: the same bytes as another file. */
function copy(selected: Cache): string {
  const path = join(outside(), 'context.js');
  writeFileSync(path, readFileSync(selected.module));
  return path;
}
/**
 * The walk judges the file it opened, not the entry it listed: whatever replaces the pinned module after the directory
 * was read is refused with the walk's own message, at once, never through a link, a FIFO or a socket, and never with a
 * system error's text. A FIFO opened without O_NONBLOCK would block until the subprocess bound stopped the launcher.
 */
it.each<[string, (selected: Cache) => Promise<Race> | Race, string]>([
  [
    'removed before the open',
    (s) => ({ at: 'open', steps: [['unlinkSync', s.module]] }),
    'Plugin cache payload is missing',
  ],
  [
    'given a second link before the open',
    (s) => ({ at: 'open', steps: [['linkSync', s.module, join(outside(), 'context.js')]] }),
    'Plugin cache file is aliased',
  ],
  [
    'grown by a byte after its first read',
    (s) => ({ at: 'read', steps: [['appendFileSync', s.module, ' ']] }),
    `Plugin cache payload differs: ${MODULE}`,
  ],
  [
    // The open fails for want of the file and the file is back before it is judged: it is gone, so missing, and the
    // open's error is never printed.
    'moved away for its open and back before it is judged',
    (s) => {
      const moved = join(outside(), 'context.js');
      return { at: 'open', steps: [['renameSync', s.module, moved]], failed: [['renameSync', moved, s.module]] };
    },
    'Plugin cache payload is missing',
  ],
])('verify refuses a pinned module %s', async (_, arrange, message) => {
  const selected = cache(),
    race = await arrange(selected);
  expect(await raced(selected, race)).toEqual({ timedOut: false, ...refused(message) });
});
it.each<[string, (selected: Cache) => Promise<Race> | Race, string]>([
  [
    'replaced by a FIFO before the open',
    async (s) => {
      const fifo = join(outside(), 'fifo');
      await mkfifo(fifo);
      return { at: 'open', steps: [['renameSync', fifo, s.module]] };
    },
    'Plugin cache file is aliased',
  ],
  [
    'replaced by a link to a FIFO before the open',
    async (s) => {
      const fifo = join(outside(), 'fifo');
      await mkfifo(fifo);
      return {
        at: 'open',
        steps: [
          ['unlinkSync', s.module],
          ['symlinkSync', fifo, s.module],
        ],
      };
    },
    'Plugin cache links are unsupported',
  ],
  [
    'replaced by a link to the same bytes after its first read',
    (s) => ({
      at: 'read',
      steps: [
        ['unlinkSync', s.module],
        ['symlinkSync', copy(s), s.module],
      ],
    }),
    'Plugin cache links are unsupported',
  ],
  [
    'replaced by another file of the same bytes after its first read',
    (s) => ({ at: 'read', steps: [['renameSync', copy(s), s.module]] }),
    `Plugin cache payload differs: ${MODULE}`,
  ],
  [
    // The file read keeps its size, times and single link; only its device and inode tell it from the copy now named.
    'whose directory is moved away after its first read and rebuilt with the same bytes',
    (s) => {
      const dist = dirname(s.module);
      return {
        at: 'read',
        steps: [
          ['renameSync', dist, join(outside(), 'dist')],
          ['mkdirSync', dist],
          ['writeFileSync', s.module, readFileSync(s.module, 'utf8')],
        ],
      };
    },
    `Plugin cache payload differs: ${MODULE}`,
  ],
  [
    'given a second link after its first read',
    (s) => ({ at: 'read', steps: [['linkSync', s.module, join(outside(), 'context.js')]] }),
    'Plugin cache file is aliased',
  ],
  [
    // The open meets the link and refuses it; the file is back before the name is judged, so only the open's ELOOP
    // tells, and it still refuses as a link rather than with the system error's text.
    'replaced by a link for its open and restored before it is judged',
    (s) => {
      const moved = join(outside(), 'context.js');
      return {
        at: 'open',
        steps: [
          ['renameSync', s.module, moved],
          ['symlinkSync', moved, s.module],
        ],
        failed: [
          ['unlinkSync', s.module],
          ['renameSync', moved, s.module],
        ],
      };
    },
    'Plugin cache links are unsupported',
  ],
])('verify refuses a pinned module %s (POSIX)', async (_, arrange, message) => {
  if (!POSIX) return;
  const selected = cache(),
    race = await arrange(selected);
  expect(await raced(selected, race)).toEqual({ timedOut: false, ...refused(message) });
});
it('verify refuses a pinned module replaced by a UNIX socket before the open (POSIX)', async () => {
  if (!POSIX) return;
  const selected = cache(),
    bound = join(outside(), 's'),
    server = createServer();
  server.listen(bound);
  await once(server, 'listening');
  try {
    expect(await raced(selected, { at: 'open', steps: [['renameSync', bound, selected.module]] })).toEqual({
      timedOut: false,
      ...refused('Plugin cache file is aliased'),
    });
  } finally {
    server.close();
  }
});
it('verify refuses a pinned module replaced by a UNIX socket for its open and restored before it is judged (POSIX)', async () => {
  if (!POSIX) return;
  const selected = cache(),
    bound = join(outside(), 's'),
    moved = join(outside(), 'context.js'),
    server = createServer();
  server.listen(bound);
  await once(server, 'listening');
  try {
    // The open fails on the socket, and the pinned file is back before it is judged: it changed between the two calls,
    // so it refuses as a changed payload, not with the socket's system error.
    const race: Race = {
      at: 'open',
      steps: [
        ['renameSync', selected.module, moved],
        ['renameSync', bound, selected.module],
      ],
      failed: [
        ['unlinkSync', selected.module],
        ['renameSync', moved, selected.module],
      ],
    };
    expect(await raced(selected, race)).toEqual({
      timedOut: false,
      ...refused(`Plugin cache payload differs: ${MODULE}`),
    });
  } finally {
    server.close();
  }
});
/**
 * An entry its listed name no longer reaches, removed once it was listed or (on Linux) listed under a name that is not
 * UTF-8, is never admitted: missing when pinned, and otherwise refused as a file the inventory does not pin, one the walk
 * would skip included.
 */
it.each<[string, (selected: Cache) => Race, unknown]>([
  [
    'an unpinned file removed before its open',
    (s) => {
      const extra = join(s.root, 'runtime', 'extra.txt');
      writeFileSync(extra, 'not pinned');
      return { target: extra, at: 'open', steps: [['unlinkSync', extra]] };
    },
    refused('Plugin cache payload differs: runtime/extra.txt'),
  ],
  [
    'an unpinned .DS_Store removed before its open',
    (s) => {
      const debris = join(s.root, 'runtime', '.DS_Store');
      writeFileSync(debris, 'written by the platform');
      return { target: debris, at: 'open', steps: [['unlinkSync', debris]] };
    },
    refused('Plugin cache payload differs: runtime/.DS_Store'),
  ],
  [
    'a directory removed before it is listed',
    (s) => {
      const dist = dirname(s.module);
      return { target: dist, at: 'list', steps: [['renameSync', dist, join(outside(), 'dist')]] };
    },
    refused(`Plugin cache payload differs: ${dirname(MODULE)}`),
  ],
])('verify answers for %s while it walks', async (_, arrange, expected) => {
  const selected = cache();
  expect(await raced(selected, arrange(selected))).toEqual({ timedOut: false, ...(expected as object) });
});
it('verify refuses an unpinned file whose name is not UTF-8 (Linux)', async () => {
  if (process.platform !== 'linux') return;
  const selected = cache(),
    raw = Buffer.concat([Buffer.from(join(selected.root, 'runtime') + sep), Buffer.from([0xff]), Buffer.from('.txt')]);
  writeFileSync(raw, 'not pinned');
  try {
    // Node lists the name lossily, so the name it gives reaches nothing.
    expect(await verdict(selected)).toEqual(
      refused(`Plugin cache payload differs: runtime/${Buffer.from([0xff]).toString('utf8')}.txt`),
    );
  } finally {
    unlinkSync(raw);
  }
});
/**
 * Windows lists every reparse point as a link, a cloud placeholder or deduplicated file included, while its lstat calls
 * only a real link one. A listed link is confirmed by its lstat, as the walk judged every entry before it opened files, so
 * a file or directory its listing calls a link is admitted, and a real link is still refused.
 */
it.each<[string, (selected: Cache) => Race]>([
  ['a pinned file', (s) => ({ linked: { directory: dirname(s.module), names: [basename(s.module)] } })],
  ['a directory on the way to a pinned file', (s) => ({ linked: { directory: s.root, names: ['runtime'] } })],
])('verify admits %s that its listing calls a link', async (_, arrange) => {
  const selected = cache();
  expect(await raced(selected, arrange(selected))).toEqual({ timedOut: false, ...VERIFIED });
});
