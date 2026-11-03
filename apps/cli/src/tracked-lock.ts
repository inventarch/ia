/**
 * The tracked list's store lock (consumer CLI contract §2.16). Every mutation reads, checks and replaces
 * `tracked-workspaces.json` as one transaction, so two `ia` processes cannot both start from the same rows and lose one
 * addition: the mutation holds `<IA home>/tracked-workspaces.json.lock` from before it loads to after it replaces.
 *
 * The lock is a file created whole with its owner in it (`{token, pid, start, host, createdAt}`), staged beside it and
 * hard-linked into place, so no reader ever sees it empty. `ia` removes only the lock it published itself. A lock some
 * other owner holds is never renamed or deleted, whether that owner is running or gone and however old the lock is:
 * two processes taking over one dead owner's lock at once can each remove the other's, so no takeover is safe with
 * these file operations alone. A holder that is killed therefore leaves a lock that blocks every mutation until a
 * person deletes it: the call waits, then refuses as `IA-CLI-TRACKED-LOCKED` naming the lock path and its owner, and
 * says so when that owner is on this host and its pid is no longer running.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ensureIaHome } from '@inventarch/distribution/ia-home';
import { Refusal } from './consumer.js';

export const TRACKED_LOCK_FILE = 'tracked-workspaces.json.lock';
/** How long a mutation waits for another holder before it refuses; a hold lasts milliseconds. */
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
    /* Reported as unreadable. */
  }
  return null;
}

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? '';

/**
 * `ensureIaHome`, again when a process creating the same home at the same moment holds its marker open: Windows then
 * refuses the rename over it (EPERM, EBUSY, EACCES) for a few milliseconds. Any other error is the caller's.
 */
function ensureHome(home: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return ensureIaHome(home);
    } catch (error) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(codeOf(error))) throw error;
      sleep(LOCK_POLL_MS);
    }
  }
}

export interface LockOptions {
  /** How long to wait for another holder before refusing; `LOCK_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number;
  /** Reads the lock file to name its holder in the refusal. */
  readonly read?: (path: string) => string;
  /** Removes this call's staging file. */
  readonly removeStage?: (path: string) => void;
}

/** Who holds the lock, as the refusal describes them; `gone` when the lock vanished since the link failed. */
type Holder = { readonly owner: LockOwner } | { readonly unreadable: string } | 'gone';
function holderOf(lock: string, read: (path: string) => string): Holder {
  let text: string;
  try {
    text = read(lock);
  } catch (error) {
    // Only a lock that is no longer there counts as released; any other failure is a lock nobody can describe.
    return codeOf(error) === 'ENOENT' ? 'gone' : { unreadable: codeOf(error) || (error as Error).message };
  }
  const owner = parseOwner(text);
  return owner === null ? { unreadable: '' } : { owner };
}

/**
 * Runs `action` holding the store lock under `home`. Creates the home as a write would. Refuses as
 * `IA-CLI-TRACKED-LOCKED` when another holder is still there after `waitMs`, measured on a monotonic clock; it never
 * removes another holder's lock. Once this call's lock is published, everything that follows (removing the staging
 * file, the action) runs inside the `finally` that releases it.
 */
export function withTrackedLock<T>(home: string, action: () => T, options: LockOptions = {}): T {
  const {
    waitMs = LOCK_WAIT_MS,
    read = (path: string) => readFileSync(path, 'utf8'),
    removeStage = (path: string) => rmSync(path, { force: true }),
  } = options;
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
    acquire(stage, lock, waitMs, read);
  } catch (error) {
    try {
      removeStage(stage);
    } catch {
      /* A stray staging file holds no lock; the refusal is what the caller needs. */
    }
    throw error;
  }
  try {
    removeStage(stage);
    return action();
  } finally {
    try {
      if (parseOwner(readFileSync(lock, 'utf8'))?.token === owner.token) rmSync(lock, { force: true });
    } catch {
      /* Already gone. */
    }
  }
}

/** Publishes `stage` as `lock`, polling while another holder has it; refuses once `waitMs` has passed after a failure. */
function acquire(stage: string, lock: string, waitMs: number, read: (path: string) => string): void {
  const started = performance.now();
  for (let lastLook = false; ; ) {
    try {
      linkSync(stage, lock);
      return;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
    if (performance.now() - started < waitMs) {
      sleep(LOCK_POLL_MS);
      continue;
    }
    const holder = holderOf(lock, read);
    // A lock released between the failed link and the read earns one more link, never another wait.
    if (holder === 'gone' && !lastLook) {
      lastLook = true;
      continue;
    }
    throw locked(lock, holder);
  }
}

function locked(lock: string, holder: Holder): Refusal {
  let held: string,
    host = 'its host';
  if (holder === 'gone') held = 'its owner could not be read (ENOENT)';
  else if ('unreadable' in holder)
    held =
      holder.unreadable === '' ? 'its owner could not be read' : `its owner could not be read (${holder.unreadable})`;
  else {
    const { owner } = holder;
    host = owner.host;
    held = `held since ${owner.createdAt} by pid ${owner.pid} on ${owner.host}`;
    if (owner.host === hostname()) {
      const now = owner.start === null ? null : processStart(owner.pid);
      if (!pidRunning(owner.pid)) held += `; pid ${owner.pid} is not running on this host`;
      else if (now !== null && now !== owner.start) held += `; pid ${owner.pid} is now another process`;
    }
  }
  return new Refusal(
    'IA-CLI-TRACKED-LOCKED',
    `The tracked list is locked by another ia process (${held}): ${lock}`,
    3,
    { path: lock },
    `Wait for the other "ia workspaces" command to finish. ia never removes this lock itself: if no ia process is running on ${host}, delete ${lock} by hand, then run the command again.`,
  );
}
