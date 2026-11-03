/**
 * The tracked list's store lock (consumer CLI contract §2.16): concurrent `ia` processes never lose a row, and a lock
 * another owner holds is never removed by `ia`, whether that owner is running or not: the call waits, then refuses
 * naming the lock and its owner. The multi-process case runs the built `dist/tracked.js` in real `node` children, so it
 * belongs to the installed profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Refusal } from '../src/consumer.js';
import { readTracked, TRACKED_FILE } from '../src/tracked.js';
import { TRACKED_LOCK_FILE, withTrackedLock } from '../src/tracked-lock.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
afterEach(() => void vi.restoreAllMocks());

const home = (): string => resolve(scratch('tracked-lock-home'), '.ia');
function workspaceAt(root: string, name: string): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/workspace.ia'), `@workspace ${name}\n`);
  return root;
}
/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}
const plantLock = (at: string, owner: Record<string, unknown>): string => {
  mkdirSync(at, { recursive: true });
  const lock = resolve(at, TRACKED_LOCK_FILE);
  writeFileSync(
    lock,
    JSON.stringify({
      token: 'planted',
      start: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      host: hostname(),
      ...owner,
    }),
  );
  return lock;
};
const refusalOf = (action: () => unknown): Refusal => {
  try {
    action();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('Expected a refusal');
};
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
/** What the lock left in the home besides the lock itself: a staging or set-aside file would show here. */
const leftovers = (at: string): readonly string[] =>
  readdirSync(at).filter((name) => name.startsWith(TRACKED_LOCK_FILE) && name !== TRACKED_LOCK_FILE);

it('real processes adding at once lose no row', async () => {
  const at = home(),
    dist = pathToFileURL(resolve(import.meta.dirname, '../dist/tracked.js')).href,
    gate = scratch('tracked-gate'),
    children = 6,
    each = 4;
  // Every child imports, says it is ready, and waits for one "go", so the adds contend instead of running in turn.
  const script = `
    const { trackWorkspace } = await import(${JSON.stringify(dist)});
    const { existsSync, writeFileSync } = await import('node:fs');
    const [home, base, child, each, gate] = process.argv.slice(1);
    writeFileSync(gate + '/ready-' + child, '');
    while (!existsSync(gate + '/go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    for (let n = 0; n < Number(each); n += 1) trackWorkspace(home, { root: base + '/c' + child + 'w' + n, id: 'c' + child + 'w' + n });
  `;
  const base = scratch('tracked-roots');
  for (let c = 0; c < children; c += 1)
    for (let n = 0; n < each; n += 1) workspaceAt(resolve(base, `c${c}w${n}`), `c${c}w${n}`);
  const exits = Promise.all(
    Array.from(
      { length: children },
      (_, c) =>
        new Promise<{ code: number | null; stderr: string }>((done) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', script, at, base, String(c), String(each), gate],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.on('close', (code) => done({ code, stderr }));
        }),
    ),
  );
  const until = Date.now() + 90_000;
  while (readdirSync(gate).filter((name) => name.startsWith('ready-')).length < children && Date.now() < until)
    await new Promise((wake) => setTimeout(wake, 10));
  writeFileSync(resolve(gate, 'go'), '');
  for (const exit of await exits) expect(exit, exit.stderr).toMatchObject({ code: 0 });
  const ids = readTracked(at).map((row) => row.id);
  expect(ids).toHaveLength(children * each);
  expect(new Set(ids).size).toBe(children * each);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
}, 120_000);

it('never removes the lock of an owner on this host whose process is gone: it refuses and says so', () => {
  const at = home(),
    pid = deadPid(),
    lock = plantLock(at, { pid }),
    before = readFileSync(lock);
  let ran = false;
  const started = performance.now();
  const refusal = refusalOf(() =>
    withTrackedLock(
      at,
      () => {
        ran = true;
      },
      { waitMs: 150 },
    ),
  );
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(ran).toBe(false);
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain(lock);
  expect(refusal.message).toContain(`pid ${pid} on ${hostname()}`);
  expect(refusal.message).toContain(`pid ${pid} is not running on this host`);
  expect(refusal.next).toContain(`delete ${lock}`);
  expect(readFileSync(lock).equals(before)).toBe(true);
  expect(leftovers(at)).toEqual([]);
  expect(existsSync(resolve(at, TRACKED_FILE))).toBe(false);
});

it('never removes a lock whose owner is running, however old it is', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' }),
    before = readFileSync(lock);
  const refusal = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 150 }));
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain(lock);
  expect(refusal.message).not.toContain('is not running');
  expect(readFileSync(lock).equals(before)).toBe(true);
});

it('never removes a lock another host owns, nor one it cannot parse', () => {
  const at = home(),
    lock = plantLock(at, { pid: deadPid(), host: `${hostname()}-elsewhere` });
  const elsewhere = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 }));
  expect(elsewhere.message).toContain(`on ${hostname()}-elsewhere`);
  expect(elsewhere.message).not.toContain('is not running');
  writeFileSync(lock, 'not json');
  expect(refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 })).message).toMatch(/could not be read/);
  expect(readFileSync(lock, 'utf8')).toBe('not json');
  expect(existsSync(resolve(at, TRACKED_FILE))).toBe(false);
});

it('a lock it cannot read still reaches the refusal within the wait', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid });
  const read = (path: string): string => {
    if (path === lock) throw errno('EACCES');
    return readFileSync(path, 'utf8');
  };
  const started = performance.now();
  const refusal = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100, read }));
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain('its owner could not be read (EACCES)');
  expect(refusal.message).toContain(lock);
  expect(existsSync(lock)).toBe(true);
}, 10_000);

it('measures the wait on a monotonic clock, so a wall clock that stands still cannot extend it', () => {
  const at = home();
  plantLock(at, { pid: process.pid });
  vi.spyOn(Date, 'now').mockReturnValue(0);
  expect(refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 })).code).toBe('IA-CLI-TRACKED-LOCKED');
}, 10_000);

it('releases the lock when the action throws', () => {
  const at = home();
  expect(() =>
    withTrackedLock(at, () => {
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
});

it('releases the lock when removing its staging file fails after the lock is published', () => {
  const at = home();
  let ran = false;
  const removeStage = (): void => {
    throw errno('EPERM');
  };
  expect(() =>
    withTrackedLock(
      at,
      () => {
        ran = true;
      },
      { removeStage },
    ),
  ).toThrow(/EPERM/);
  expect(ran).toBe(false);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
  // The next call in the same process takes the lock at once.
  expect(withTrackedLock(at, () => 'ran', { waitMs: 100 })).toBe('ran');
});
