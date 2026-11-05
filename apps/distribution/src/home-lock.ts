/**
 * An owner-stamped lock on one store in the IA home (host plugin distribution §3): every read-modify-write of such a
 * store (`tracked-workspaces.json`, `state/update-check.json`) holds `<IA home>/<name>` from before it reads to after it
 * replaces, so two processes cannot both start from the same contents and lose one change.
 *
 * The lock is a file created whole with its owner in it (`{token, pid, start, host, createdAt}`), staged beside it and
 * hard-linked into place, so no reader ever sees it empty. A holder removes only the lock it published itself. A lock
 * some other owner holds is never renamed or deleted, whether that owner is running or gone and however old the lock
 * is: two processes taking over one dead owner's lock at once can each remove the other's, so no takeover is safe with
 * these file operations alone. A holder that is killed therefore leaves a lock that blocks every change until a person
 * deletes it: the call waits, then throws `HomeLockedError` naming the lock path and its owner, and says when that
 * owner is on this host and its pid is no longer running. The wait runs on a timer, so a signal handler gets to run during
 * it: a call given an `AbortSignal` stops waiting as soon as that signal fires, removing only its own staging file.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DistributionError } from './files.js';
import { ensureIaHome } from './ia-home.js';

/** How long a change waits for another holder before it refuses; a hold lasts milliseconds. */
export const HOME_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;
/** What Windows reports for a moment while another process (an indexer, antivirus) holds a file open. */
const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES'];
/** How many times a release is tried, `LOCK_POLL_MS` apart, before the lock is reported left behind. */
const RELEASE_ATTEMPTS = 40;

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

/** Blocks the thread: only for the retries of a refusal Windows gives for a moment, never the wait for a holder. */
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
      if (attempt >= 40 || !TRANSIENT.includes(codeOf(error))) throw error;
      sleep(LOCK_POLL_MS);
    }
  }
}

export interface HomeLockOptions {
  /** How long to wait for another holder before refusing; `HOME_LOCK_WAIT_MS` unless a caller shortens it. */
  readonly waitMs?: number;
  /** Reads the lock file to name its holder in the refusal. */
  readonly read?: (path: string) => string;
  /** Removes this call's staging file. */
  readonly removeStage?: (path: string) => void;
  /** Called after each attempt that found the lock held, before the wait; tests use it to observe real contention. */
  readonly onBlocked?: () => void;
  /** Removes this call's own lock at release. */
  readonly removeLock?: (path: string) => void;
  /** Stops the wait for another holder: the call then rejects with the signal's reason, having published no lock. */
  readonly signal?: AbortSignal | undefined;
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
 * Another owner still held the lock after the wait. `held` describes that owner (or why it could not be read) and
 * `host` names its host, or "its host" when unknown; a caller words its own refusal around them.
 */
export class HomeLockedError extends Error {
  readonly code = 'IA-DIST-HOME-LOCKED';
  constructor(
    readonly lock: string,
    readonly held: string,
    readonly host: string,
  ) {
    super(`${lock} is locked by another ia process (${held})`);
    this.name = 'HomeLockedError';
  }
}

/**
 * This call's own lock could not be removed after its action completed: the action's change was made, and the lock it
 * leaves blocks every later change to that store until it is deleted.
 */
export class HomeLockLeftError extends DistributionError {
  constructor(
    readonly lock: string,
    reason: string,
  ) {
    super(
      'IA-DIST-HOME-LOCK-LEFT',
      `${lock} could not be removed (${reason}); this process no longer holds it, so delete it`,
      lock,
    );
    this.name = 'HomeLockLeftError';
  }
}

/**
 * Runs `action` holding the lock `<home>/<name>`. Creates the home as a write would. Rejects with `HomeLockedError` when
 * another holder is still there after `waitMs`, measured on a monotonic clock, or with `signal`'s reason as soon as that
 * fires while no lock is published; it never removes another holder's lock. `action` is synchronous and runs in the same
 * synchronous step that publishes the lock, together with the release, so nothing else (no timer, I/O callback or queued
 * microtask) runs while this call holds the lock.
 * Once this call's lock is published, everything that follows (removing the staging file, the action) runs inside the
 * `finally` that releases it. A release Windows refuses for a moment is retried; one that still fails leaves the lock
 * and throws `IA-DIST-HOME-LOCK-LEFT` naming it, unless the action threw, whose error then stands.
 */
export async function withHomeLock<T>(
  home: string,
  name: string,
  action: () => T,
  options: HomeLockOptions = {},
): Promise<T> {
  const {
    waitMs = HOME_LOCK_WAIT_MS,
    read = (path: string) => readFileSync(path, 'utf8'),
    removeStage = (path: string) => rmSync(path, { force: true }),
    onBlocked = () => {},
    removeLock = unlinkSync,
    signal,
  } = options;
  ensureHome(home);
  const lock = join(home, name);
  mkdirSync(dirname(lock), { recursive: true });
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    start: processStart(process.pid),
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const stage = `${lock}.${owner.token}.tmp`;
  writeFileSync(stage, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  let outcome: { readonly value: T } | { readonly error: unknown } | undefined;
  // Called by `acquire` right after the link that publishes the lock, before its promise settles: the lock is never
  // held across a yield. It records the outcome rather than throwing, so a failure here is never taken for a refusal.
  const held = (): void => {
    let failed = false;
    try {
      removeStage(stage);
      outcome = { value: action() };
    } catch (error) {
      failed = true;
      outcome = { error };
    } finally {
      const left = release(lock, owner.token, removeLock);
      if (left !== null && !failed) outcome = { error: left };
    }
  };
  try {
    await acquire(stage, lock, waitMs, read, onBlocked, signal, held);
  } catch (error) {
    try {
      removeStage(stage);
    } catch {
      /* A stray staging file holds no lock; the refusal is what the caller needs. */
    }
    throw error;
  }
  if (outcome === undefined) throw new Error(`${lock} was acquired without running its action`);
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * Removes `lock` when it is still this call's (`token`). A lock already gone is released; Windows refusing the read or
 * the removal for a moment (EPERM, EBUSY, EACCES) is retried. Returns the refusal to report when the lock is left
 * behind, which would otherwise block every later change until its pid is found dead by hand, or null.
 */
function release(lock: string, token: string, remove: (path: string) => void): HomeLockLeftError | null {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (parseOwner(readFileSync(lock, 'utf8'))?.token === token) remove(lock);
      return null;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT') return null;
      if (attempt < RELEASE_ATTEMPTS && TRANSIENT.includes(code)) {
        sleep(LOCK_POLL_MS);
        continue;
      }
      return new HomeLockLeftError(lock, code || (error as Error).message);
    }
  }
}

/**
 * Publishes `stage` as `lock`, polling on a timer while another holder has it; refuses once `waitMs` has passed after a
 * failure, and stops with `signal`'s reason before any attempt once that has fired. `held` runs right after the link
 * that publishes the lock, in the same synchronous step.
 */
async function acquire(
  stage: string,
  lock: string,
  waitMs: number,
  read: (path: string) => string,
  onBlocked: () => void,
  signal: AbortSignal | undefined,
  held: () => void,
): Promise<void> {
  const started = performance.now();
  for (let lastLook = false; ; ) {
    signal?.throwIfAborted();
    try {
      linkSync(stage, lock);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      onBlocked();
      if (performance.now() - started < waitMs) {
        // The timer rejects only for the signal, which the top of the loop reports.
        await delay(LOCK_POLL_MS, undefined, signal === undefined ? {} : { signal }).catch(() => {});
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
    // Published: the held section runs now, in this same step, and never throws.
    held();
    return;
  }
}

function locked(lock: string, holder: Holder): HomeLockedError {
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
  return new HomeLockedError(lock, held, host);
}
