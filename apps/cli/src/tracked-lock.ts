/**
 * The tracked list's store lock (consumer CLI contract §2.16). Every mutation reads, checks and replaces
 * `tracked-workspaces.json` as one transaction, so two `ia` processes cannot both start from the same rows and lose one
 * addition: the mutation holds `<IA home>/tracked-workspaces.json.lock` from before it loads to after it replaces.
 *
 * The lock is a file created whole with its owner in it (`{token, pid, start, host, createdAt}`), staged beside it and
 * hard-linked into place, so no reader ever sees it empty. A holder that is killed leaves it behind, so a lock is taken
 * over only when its owner is provably gone: it names this host and its pid is not running (or is running as a process
 * that started at another time, a reused pid). It is never taken over for its age, and never when it names another
 * host or cannot be read; those wait, then refuse as `IA-CLI-TRACKED-LOCKED` naming the lock path to check.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIaHome } from '@inventarch/distribution/ia-home';
import { Refusal } from './consumer.js';

export const TRACKED_LOCK_FILE = 'tracked-workspaces.json.lock';
/** How long a mutation waits for a live holder before it refuses; a hold lasts milliseconds. */
export const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

export interface LockOwner {
  readonly token: string;
  readonly pid: number;
  /** The process's start time as the platform reports it, or null where this module cannot read one. */
  readonly start: string | null;
  readonly host: string;
  readonly createdAt: string;
}

/** The process start time in clock ticks since boot on Linux (`/proc`); null where nothing cheap reports one. */
export function processStart(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
/** `process.kill(pid, 0)` throwing ESRCH is the only "not running"; EPERM and anything else count as running. */
export function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseOwner(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { token, pid, start, host, createdAt } = value;
    if (
      typeof token === 'string' &&
      typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      (start === null || typeof start === 'string') &&
      typeof host === 'string' &&
      typeof createdAt === 'string'
    )
      return { token, pid, start, host, createdAt };
  } catch {
    /* Unreadable: not provably dead. */
  }
  return null;
}
/** True only for an owner on this host whose process is gone, or is a different process under a reused pid. */
export function ownerGone(owner: LockOwner, thisHost: string = hostname()): boolean {
  if (owner.host !== thisHost) return false;
  if (!pidRunning(owner.pid)) return true;
  const now = owner.start === null ? null : processStart(owner.pid);
  return now !== null && owner.start !== null && now !== owner.start;
}

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `ensureIaHome`, again when a process creating the same home at the same moment holds its marker open: Windows then
 * refuses the rename over it (EPERM, EBUSY, EACCES) for a few milliseconds. Any other error is the caller's.
 */
function ensureHome(home: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return ensureIaHome(home);
    } catch (error) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Runs `action` holding the store lock under `home`. Creates the home as a write would. Refuses as
 * `IA-CLI-TRACKED-LOCKED` when a live (or unprovable) holder is still there after `waitMs`.
 */
export function withTrackedLock<T>(home: string, action: () => T, waitMs: number = LOCK_WAIT_MS): T {
  ensureHome(home);
  const lock = join(home, TRACKED_LOCK_FILE);
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    start: processStart(process.pid),
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const stage = `${lock}.${owner.token}.tmp`;
  writeFileSync(stage, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        linkSync(stage, lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!reclaim(lock) && Date.now() >= deadline) throw locked(lock);
      sleep(LOCK_POLL_MS);
    }
  } finally {
    rmSync(stage, { force: true });
  }
  try {
    return action();
  } finally {
    try {
      if (parseOwner(readFileSync(lock, 'utf8'))?.token === owner.token) rmSync(lock, { force: true });
    } catch {
      /* Already gone. */
    }
  }
}

/** Takes the lock file away when its owner is provably gone. True when it did, so the caller retries at once. */
function reclaim(lock: string): boolean {
  let text: string;
  try {
    text = readFileSync(lock, 'utf8');
  } catch {
    return true; // Released between the failed link and now.
  }
  const owner = parseOwner(text);
  if (owner === null || !ownerGone(owner)) return false;
  // Rename it aside first, so two reclaimers cannot both delete a lock a third has since taken: whoever moved a lock
  // that is not the dead owner's puts it back.
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return true;
  }
  try {
    if (parseOwner(readFileSync(aside, 'utf8'))?.token === owner.token) return true;
    try {
      linkSync(aside, lock);
    } catch {
      /* Another holder has already taken it. */
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

function locked(lock: string): Refusal {
  let held = 'its owner could not be read';
  try {
    const owner = parseOwner(readFileSync(lock, 'utf8'));
    if (owner !== null) held = `held since ${owner.createdAt} by pid ${owner.pid} on ${owner.host}`;
  } catch {
    /* Reported as unreadable. */
  }
  return new Refusal(
    'IA-CLI-TRACKED-LOCKED',
    `The tracked list is locked by another ia process (${held}): ${lock}`,
    3,
    { path: lock },
    `Wait for the other "ia workspaces" command to finish. If no ia process is running on that host, delete ${lock}, then run the command again.`,
  );
}
