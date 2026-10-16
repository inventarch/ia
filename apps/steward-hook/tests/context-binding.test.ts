import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lifecycleProfile } from '@inventarch/workspace-runtime/lifecycle-profile';
import { runBounded } from '@tools/testing/subprocess.js';
import { createContextHookBinding, readContextHookBinding } from '../src/context.js';

const gate = vi.hoisted(() => ({
  path: '',
  afterStat: null as (() => void) | null,
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
    // The gate passes each call's options on, so a caller that asks for bigint stats gets them.
    lstatSync: (path: string, options?: Parameters<typeof actual.lstatSync>[1]) => {
      const stat = actual.lstatSync(path, options);
      if (resolve(path) === gate.path && gate.afterStat) {
        const run = gate.afterStat;
        gate.afterStat = null;
        run();
      }
      return stat;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (waits(args[0], args[1])) {
        gate.waited.push(String(args[0]));
        throw new Error('A FIFO opened to read without O_NONBLOCK would wait for a writer');
      }
      return actual.openSync(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  gate.path = '';
  gate.afterStat = null;
  gate.waited.length = 0;
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-context-binding-')))
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ia-context-binding-'));
  roots.push(root);
  const path = join(root, '.ia/distributions/hosts/claude-context-fixture.binding.json');
  mkdirSync(dirname(path), { recursive: true });
  const input = {
    format: 'ia.context-hook-binding.v1' as const,
    root,
    owner: 'owner-one',
    actor: 'actor',
    workspace: 'workspace',
    profile: lifecycleProfile('claude-code', '2.1.278'),
    scope: { root: '', identities: null },
    view: { id: 'project', adopted: [], manifests: [{ source: 'self', root }] },
    selection: { target: 'governance-system/definition/procedure/sample-procedure', document: null, lifecycle: null },
    coordinate: { phase: 'orient', primitive: 'Decision' },
    bootstrap: 'Author native procedures',
    budgets: { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 3000 },
    policy: 'a'.repeat(64),
    implementation: 'b'.repeat(64),
  };
  const binding = createContextHookBinding(input);
  writeFileSync(path, JSON.stringify(binding));
  return { root, path, input, binding };
}
it('refuses an independently valid binding replaced between metadata validation and read', () => {
  const { root, path, input, binding } = fixture(),
    replacement = createContextHookBinding({ ...input, owner: 'owner-two' });
  expect(JSON.stringify(replacement).length).toBe(JSON.stringify(binding).length);
  gate.path = resolve(path);
  gate.afterStat = () => {
    renameSync(path, path + '.retained');
    writeFileSync(path, JSON.stringify(replacement));
  };
  expect(() => readContextHookBinding(root, path)).toThrow(/changed|identity|replaced/i);
  expect(readContextHookBinding(root, path).owner).toBe('owner-two');
});
it('reads a retained bounded binding and refuses an oversized replacement', () => {
  const { root, path, binding } = fixture();
  expect(readContextHookBinding(root, path)).toEqual(binding);
  writeFileSync(path, ' '.repeat(64 * 1024 + 1));
  expect(() => readContextHookBinding(root, path)).toThrow(/bounded|changed/i);
});

const posix = process.platform !== 'win32';
const NOT_REGULAR = { code: 'IA-LIFECYCLE-BINDING', message: 'Context binding is not a bounded regular file' },
  OUTSIDE = { code: 'IA-LIFECYCLE-BINDING', message: 'Context binding path is outside its fixed managed location' };
/** The code and message of what `run` throws. */
function refusal(run: () => unknown): { readonly code: unknown; readonly message: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  throw new Error('Expected the binding read to refuse');
}
it('reads a binding of exactly 64 KiB and refuses one byte more', () => {
  const { root, path, binding } = fixture();
  writeFileSync(path, JSON.stringify(binding).padEnd(64 * 1024, ' '));
  expect(readContextHookBinding(root, path)).toEqual(binding);
  writeFileSync(path, JSON.stringify(binding).padEnd(64 * 1024 + 1, ' '));
  expect(refusal(() => readContextHookBinding(root, path))).toEqual(NOT_REGULAR);
});
it('passes on the realpath error of a missing binding', () => {
  const { root, path } = fixture();
  rmSync(path);
  expect(refusal(() => readContextHookBinding(root, path))).toEqual({
    code: 'ENOENT',
    message: `ENOENT: no such file or directory, realpath '${path}'`,
  });
});
it.each(['a file link', 'a junction', 'a hosts directory junction'] as const)(
  'refuses a binding reached through %s',
  (kind) => {
    if (!posix && kind === 'a file link') return;
    const { root, path } = fixture(),
      elsewhere = join(root, 'elsewhere');
    if (kind === 'a hosts directory junction') {
      renameSync(dirname(path), elsewhere);
      symlinkSync(elsewhere, dirname(path), 'junction');
    } else {
      mkdirSync(elsewhere);
      renameSync(path, join(elsewhere, 'binding.json'));
      if (kind === 'a file link') symlinkSync(join(elsewhere, 'binding.json'), path, 'file');
      else symlinkSync(elsewhere, path, 'junction');
    }
    expect(refusal(() => readContextHookBinding(root, path))).toEqual(OUTSIDE);
  },
);
it.each(['a hard link', 'a directory', 'a FIFO', 'a socket'] as const)('refuses a binding that is %s', async (kind) => {
  if (!posix && kind !== 'a hard link' && kind !== 'a directory') return;
  const { root, path } = fixture();
  if (kind === 'a hard link') linkSync(path, join(root, 'another.json'));
  else {
    rmSync(path);
    if (kind === 'a directory') mkdirSync(path);
    // No process writes to this FIFO.
    else if (kind === 'a FIFO') expect((await runBounded('mkfifo', [path], { timeoutMs: 10_000 })).status).toBe(0);
    else {
      // Bound at a short name first, since socket paths are short on macOS, and moved into place.
      const server = createServer(),
        bound = join(root, 's');
      await new Promise<void>((done, failed) => {
        server.once('error', failed);
        server.listen(bound, () => done());
      });
      renameSync(bound, path);
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
  expect(refusal(() => readContextHookBinding(root, path))).toEqual(NOT_REGULAR);
  expect(gate.waited).toEqual([]);
});
it('passes on the error of a binding it may not open', () => {
  if (!posix || process.getuid?.() === 0) return;
  const { root, path } = fixture();
  chmodSync(path, 0o000);
  expect(refusal(() => readContextHookBinding(root, path))).toEqual({
    code: 'EACCES',
    message: `EACCES: permission denied, open '${path}'`,
  });
});
