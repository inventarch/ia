/**
 * The IA home's owner-stamped store lock (host plugin distribution §3), as the tracked list and the update cache share
 * it: a holder releases only its own lock, and a lock another owner holds is never removed, whether that owner is
 * running or gone: the call waits, then throws naming the lock and its owner.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeLockedError, ownerGone, processStart, withHomeLock } from '../src/home-lock.js';

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const home = (): string => {
  const at = mkdtempSync(join(tmpdir(), 'ia-home-lock-'));
  made.push(at);
  return join(at, '.ia');
};
const NAME = 'state/store.json.lock';
/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}
const plantLock = (at: string, owner: Record<string, unknown>): string => {
  const lock = join(at, NAME);
  mkdirSync(dirname(lock), { recursive: true });
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
const lockedBy = (action: () => unknown): HomeLockedError => {
  try {
    action();
  } catch (error) {
    if (error instanceof HomeLockedError) return error;
    throw error;
  }
  throw new Error('Expected the lock to be held');
};
const leftovers = (at: string): readonly string[] =>
  readdirSync(join(at, 'state')).filter((name) => name.startsWith('store.json.lock') && name !== 'store.json.lock');

it('creates the home and the lock directory, runs the action and releases the lock', () => {
  const at = home();
  expect(withHomeLock(at, NAME, () => existsSync(join(at, NAME)))).toBe(true);
  expect(existsSync(join(at, NAME))).toBe(false);
  expect(leftovers(at)).toEqual([]);
});
it('never removes the lock of an owner on this host whose process is gone: it throws and says so', () => {
  const at = home(),
    pid = deadPid(),
    lock = plantLock(at, { pid }),
    before = readFileSync(lock);
  let ran = false;
  const error = lockedBy(() =>
    withHomeLock(
      at,
      NAME,
      () => {
        ran = true;
      },
      { waitMs: 150 },
    ),
  );
  expect(ran).toBe(false);
  expect(error.code).toBe('IA-DIST-HOME-LOCKED');
  expect(error.lock).toBe(lock);
  expect(error.held).toContain(`pid ${pid} on ${hostname()}`);
  expect(error.held).toContain(`pid ${pid} is not running on this host`);
  expect(error.host).toBe(hostname());
  expect(readFileSync(lock).equals(before)).toBe(true);
  expect(leftovers(at)).toEqual([]);
});
it('never removes a lock whose owner is running, however old it is, nor one another host owns or it cannot parse', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' });
  expect(lockedBy(() => withHomeLock(at, NAME, () => 'ran', { waitMs: 100 })).held).not.toContain('is not running');
  plantLock(at, { pid: deadPid(), host: `${hostname()}-elsewhere` });
  const elsewhere = lockedBy(() => withHomeLock(at, NAME, () => 'ran', { waitMs: 100 }));
  expect(elsewhere.host).toBe(`${hostname()}-elsewhere`);
  expect(elsewhere.held).not.toContain('is not running');
  writeFileSync(lock, 'not json');
  expect(lockedBy(() => withHomeLock(at, NAME, () => 'ran', { waitMs: 100 })).held).toBe('its owner could not be read');
  expect(readFileSync(lock, 'utf8')).toBe('not json');
});
it('measures the wait on a monotonic clock, so a wall clock that stands still cannot extend it', () => {
  const at = home();
  plantLock(at, { pid: process.pid });
  vi.spyOn(Date, 'now').mockReturnValue(0);
  expect(lockedBy(() => withHomeLock(at, NAME, () => 'ran', { waitMs: 100 })).code).toBe('IA-DIST-HOME-LOCKED');
}, 10_000);
it('calls onBlocked for each attempt that found the lock held', () => {
  const at = home();
  plantLock(at, { pid: process.pid });
  let blocked = 0;
  lockedBy(() => withHomeLock(at, NAME, () => 'ran', { waitMs: 60, onBlocked: () => (blocked += 1) }));
  expect(blocked).toBeGreaterThan(0);
});
it('releases the lock when the action throws', () => {
  const at = home();
  expect(() =>
    withHomeLock(at, NAME, () => {
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(existsSync(join(at, NAME))).toBe(false);
  expect(withHomeLock(at, NAME, () => 'again', { waitMs: 100 })).toBe('again');
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
it('a release Windows refuses for a moment (EBUSY, EPERM) is retried until the lock is gone', () => {
  const at = home(),
    tries: string[] = [];
  const removeLock = (path: string) => {
    tries.push(path);
    if (tries.length <= 2) throw errno(tries.length === 1 ? 'EBUSY' : 'EPERM');
    rmSync(path);
  };
  expect(withHomeLock(at, NAME, () => 'done', { removeLock })).toBe('done');
  expect(tries).toHaveLength(3);
  expect(existsSync(join(at, NAME))).toBe(false);
});
it('a release that keeps failing throws naming the lock it left, and an action error still wins', () => {
  const at = home(),
    removeLock = () => {
      throw errno('EBUSY');
    };
  expect(() => withHomeLock(at, NAME, () => 'done', { removeLock })).toThrow(
    expect.objectContaining({ code: 'IA-DIST-HOME-LOCK-LEFT', message: expect.stringContaining(join(at, NAME)) }),
  );
  expect(existsSync(join(at, NAME))).toBe(true);
  rmSync(join(at, NAME));
  expect(() =>
    withHomeLock(
      at,
      NAME,
      () => {
        throw new Error('action failed');
      },
      { removeLock },
    ),
  ).toThrow('action failed');
});
it('a lock already gone at release (ENOENT) is released', () => {
  const at = home();
  const removeLock = (path: string) => {
    rmSync(path);
    throw errno('ENOENT');
  };
  expect(withHomeLock(at, NAME, () => 'done', { removeLock })).toBe('done');
});

it('never removes a lock another owner swapped in during the action', () => {
  const at = home(),
    lock = join(at, NAME);
  const other = JSON.stringify({
    token: 'swapped-in',
    pid: process.pid,
    start: null,
    host: hostname(),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const result = withHomeLock(at, NAME, () => {
    // The lock this call published is replaced by another owner's, as after a takeover this module never makes itself.
    rmSync(lock);
    writeFileSync(lock, other);
    return 'done';
  });
  expect(result).toBe('done');
  expect(readFileSync(lock, 'utf8')).toBe(other);
  expect(leftovers(at)).toEqual([]);
});

it('ownerGone: a dead pid on this host is not running, a reused pid is another process, a running or foreign owner is none', () => {
  const owner = (extra: Record<string, unknown>) => ({
    token: 't',
    pid: process.pid,
    start: null,
    host: hostname(),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  expect(ownerGone(owner({ pid: deadPid() }))).toBe('not-running');
  expect(ownerGone(owner({}))).toBeNull();
  expect(ownerGone(owner({ start: processStart(process.pid) }))).toBeNull();
  expect(ownerGone(owner({ pid: deadPid(), host: 'some-other-host' }))).toBeNull();
  // Only Linux reports a start time, so only there can a running pid be told apart from the process that took the lock.
  expect(ownerGone(owner({ start: 'not-this-start' }))).toBe(process.platform === 'linux' ? 'reused' : null);
});
