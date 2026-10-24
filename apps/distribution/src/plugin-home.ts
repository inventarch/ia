import { randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { caseFold } from '@inventarch/db';
import { fail, portable } from './files.js';
import { assertIaHomeUsable, ensureIaHome } from './ia-home.js';

/** Host plugin distribution spec §6.3: the materialized Claude marketplace lives here, in every channel. */
export const MARKETPLACE_DIR = 'claude/marketplace';
export interface PluginFile {
  readonly path: string;
  readonly text: string;
}
const PLUGIN_JSON = 'plugins/ia/.claude-plugin/plugin.json',
  META_JSON = 'plugins/ia/ia-plugin.json';
const LEFTOVER_PREFIXES = ['.stage-', '.previous-', '.remove-'] as const;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** Win32 renames a directory holding an open file with EPERM/EBUSY/EACCES depending on what holds it; elsewhere only EBUSY means "busy" — EPERM/EACCES there are a real permission problem, not a lock to wait out. */
const BUSY_CODES = new Set(process.platform === 'win32' ? ['EPERM', 'EBUSY', 'EACCES'] : ['EBUSY']);
const PERMISSION_CODES = new Set(process.platform === 'win32' ? [] : ['EPERM', 'EACCES']);
/** Synchronous backoff; `Atomics.wait` blocks this thread only, which is what a CLI process wants here. */
function waitBusy(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Retries a rename across a lock briefly held by an editor, indexer or another `ia` process; ~1.5s total, backing
 * off 50ms to 400ms, before refusing as INSTALL-BUSY naming `contextDir`. Off win32, EPERM/EACCES are not treated as
 * a transient lock: they fail immediately as INPUT-INVALID. Any other error is rethrown as-is.
 */
function renameRetrying(from: string, to: string, contextDir: string): void {
  const deadline = Date.now() + 1500;
  let delay = 50;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && BUSY_CODES.has(code)) {
        if (Date.now() >= deadline)
          fail(
            'INSTALL-BUSY',
            `A process holds files open under ${contextDir}; close Claude Code sessions, editors or terminals using it, then rerun ia host claude --user --apply`,
          );
        waitBusy(delay);
        delay = Math.min(delay * 2, 400);
        continue;
      }
      if (code && PERMISSION_CODES.has(code))
        fail('INPUT-INVALID', `${contextDir} cannot be renamed (${code}); check its permissions`);
      throw error;
    }
  }
}
const LOCK_NAME = '.lock',
  LOCK_EMPTY_GRACE_MS = 10 * 1000,
  /**
   * A run holds its lock for milliseconds, so a lock this old whose pid is running belongs to a process that reused a
   * dead owner's pid, to one that answers EPERM, or to a run frozen in its hold: it is taken over all the same.
   */
  LOCK_LIVE_BACKSTOP_MS = 24 * 60 * 60 * 1000,
  LOCK_TAKEOVER_ATTEMPTS = 5,
  /**
   * How long from a `createLock` call's first try it may still begin a wait before retrying a busy create, as for a
   * lock name another run is still removing (on Windows, under 1 ms); each call starts over. The last wait can end
   * after it: a call's waits total at most 263 ms, if each ends on time.
   */
  LOCK_PENDING_WAIT_MS = 250,
  /** A pid is at most 10 decimal digits on every platform and leads the lock; no more is read to judge one. */
  LOCK_PID_BYTES = 32,
  /**
   * More than the at most 47 bytes a run writes to its lock (a pid of at most 10 digits, a space and a 36-character
   * UUID), so reading this much shows whether the lock holds anything beyond them.
   */
  LOCK_OWNER_BYTES = 64,
  /**
   * How old a takeover's claim is once it counts as abandoned: claiming and releasing take microseconds, so its run
   * died or froze in between.
   */
  LOCK_CLAIM_ABANDONED_MS = 10 * 1000,
  /** What ends a takeover's claim on a judged lock, `<lock>.<ino>.claim`, beside the lock (`claimJudged`). */
  CLAIM_SUFFIX = '.claim';
/** A lock this run holds: its path, and exactly the text this run wrote there, which no other run's lock holds. */
interface HeldLock {
  readonly path: string;
  readonly owner: string;
}
/** Opens a lock to judge it: read-only, never waiting on a FIFO and, where the platform has O_NOFOLLOW, never through a symbolic link. */
function openLockToJudge(path: string): number {
  return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
}
/** Reads at most `limit` bytes from the start of the just-opened `fd`, looping until the file ends or `limit` is reached. */
function readLockHead(fd: number, limit: number): Buffer {
  const bytes = Buffer.alloc(limit);
  let total = 0;
  while (total < limit) {
    const count = readSync(fd, bytes, total, limit - total, null);
    if (count === 0) break;
    total += count;
  }
  return bytes.subarray(0, total);
}
/** `process.kill(pid, 0)` throwing ESRCH is the only "not alive" case; any other outcome, including an unreadable errno, is treated as alive so a live run is never stolen from under itself. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  return true;
}
/**
 * One takeover attempt on the lock `acquireLock` found held at `path`: `busy` while it must be waited for, `removed`
 * once a stale lock is gone, or `retry` when there was nothing it could judge or remove (the lock vanished or was
 * replaced, could not be opened, or could not be removed), so the caller retries its own open. Every judged value (the
 * file's type, its age and its pid) comes from one descriptor, so all of them describe one file (CodeQL
 * js/file-system-race); it is opened by `openLockToJudge`. Only a regular file is ever taken over: the lock is created
 * as nothing else, so a symbolic link or any other file there was put there by something else. It is stale once its
 * pid, the number that leads it in either format (this CLI's `<pid> <token>`, or an older CLI's pid alone), parsed as
 * an integer from 1 to 2147483647 and is not running, or, when no such pid parsed (empty, the short window between
 * another run's create and its write, unparseable, 0 or negative, or above 2147483647), once it is older than
 * `LOCK_EMPTY_GRACE_MS`. Such a pid that is running is busy until the lock is older than `LOCK_LIVE_BACKSTOP_MS`: a
 * younger age does not show that its owner stopped. Running is judged in this process's own pid namespace, so a run
 * in another namespace sharing the IA home can take over a live run's lock. A hard link at the lock path names the
 * judged file itself, so it is judged like any other lock, and taking it over removes only that name. A stale lock
 * is removed only under a claim on the judged file (`claimJudged`), and only after its name is found, before and
 * again under that claim, to still name the judged file. Both comparisons are made while the descriptor is open, so
 * that file's inode cannot be reused (on Windows, where a symbolic link is followed, they are what refuses one). Two
 * runs that judged the same stale lock therefore never both remove it, and a lock another run created after this
 * run's judgment is found under the claim and left in place. The descriptor is closed before the removal, as Windows
 * may keep a removed file's name until its last handle closes. Node has no unlink-if-same, so the removal still takes
 * whatever the name holds by then; only something that removes the lock without this claim can change it in that
 * window: a hand, an earlier CLI (which never claims), or a run whose claim was removed as abandoned, either because it
 * froze inside it for longer than `LOCK_CLAIM_ABANDONED_MS` or because removing an abandoned claim is itself a check
 * and then a removal, which two runs preempted at the wrong moments can interleave. These hold among runs on one host.
 */
function takeOverStale(path: string): 'busy' | 'removed' | 'retry' {
  let fd: number;
  try {
    fd = openLockToJudge(path);
  } catch {
    return 'retry'; // vanished, a symbolic link O_NOFOLLOW refuses, or unopenable: the attempt bound stops the spin
  }
  let claim: string | undefined;
  try {
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) return 'busy';
      const ageMs = Date.now() - Number(opened.mtimeNs) / 1e6;
      let pid = Number.NaN;
      try {
        pid = Number.parseInt(readLockHead(fd, LOCK_PID_BYTES).toString('utf8'), 10);
      } catch {
        /* unreadable: pid stays NaN, judged as a pid that did not parse below */
      }
      // Only a pid from 1 to 2147483647 names one owner. On POSIX, process.kill takes 0 or a negative pid for a
      // process group or for every process, so 0, -1 and a live group read as running and any other negative from
      // -2147483648 as dead; on Windows 0 is the caller itself. Node refuses a pid above 2147483647 or below
      // -2147483648 as an invalid argument on every platform, which isPidAlive reads as running. None of them names
      // the lock's owner, so each is judged as a pid that did not parse.
      const owner = Number.isInteger(pid) && pid > 0 && pid <= 2147483647;
      const stale = owner ? ageMs > LOCK_LIVE_BACKSTOP_MS || !isPidAlive(pid) : ageMs > LOCK_EMPTY_GRACE_MS;
      if (!stale) return 'busy';
      if (!namesJudged(path, opened)) return 'retry';
      claim = claimJudged(path, opened);
      if (claim === undefined) return 'retry'; // another run holds the claim, or it could not be made
      // Another run may have removed the judged lock and created its own between the comparison above and the claim.
      if (!namesJudged(path, opened)) return 'retry';
    } finally {
      closeSync(fd);
    }
    rmSync(path, { force: true });
    return 'removed';
  } catch {
    return 'retry'; // not judged, the name vanished before a comparison, or removal failing; the attempt bound stops it
  } finally {
    if (claim !== undefined) releaseClaim(claim);
  }
}
/** Whether `path` names `judged`, the opened file: same device and inode, never through a link; throws if unnamed. */
function namesJudged(path: string, judged: BigIntStats): boolean {
  const named = lstatSync(path, { bigint: true });
  return named.dev === judged.dev && named.ino === judged.ino;
}
/**
 * Claims the judged lock for one takeover: an exclusive directory beside it, named for the judged file's inode, which
 * no other file in that directory can share while the takeover's descriptor keeps that inode in use. Only the run that
 * creates the claim removes that lock. Returns the claim, or undefined when another run holds it or it cannot be made
 * (on Windows, a claim still being removed refuses EPERM). A claim older than `LOCK_CLAIM_ABANDONED_MS` is abandoned
 * and removed, so a later attempt can claim.
 */
function claimJudged(path: string, judged: BigIntStats): string | undefined {
  const claim = `${path}.${judged.ino}${CLAIM_SUFFIX}`;
  try {
    mkdirSync(claim);
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') removeAbandonedClaim(claim);
    return undefined;
  }
}
/** Removes `claim` once it is a directory older than `LOCK_CLAIM_ABANDONED_MS`; best effort, as another run may too. */
function removeAbandonedClaim(claim: string): void {
  try {
    const claimed = lstatSync(claim);
    if (claimed.isDirectory() && Date.now() - claimed.mtimeMs > LOCK_CLAIM_ABANDONED_MS) rmdirSync(claim);
  } catch {
    /* gone already, or not removable: the attempt bound stops the takeover */
  }
}
/** Removes this takeover's claim; one left behind is abandoned once it is older than `LOCK_CLAIM_ABANDONED_MS`. */
function releaseClaim(claim: string): void {
  try {
    rmdirSync(claim);
  } catch {
    /* left in place: a later takeover or acquisition removes it as abandoned */
  }
}
/** Removes every abandoned claim beside the lock, such as one left by a run that died after its takeover's removal. */
function sweepAbandonedClaims(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(`${LOCK_NAME}.`) && name.endsWith(CLAIM_SUFFIX)) removeAbandonedClaim(join(parent, name));
}
/**
 * Held for the lifetime of a materialize's recovery-through-swap, or of a whole `removeMarketplace`, so two
 * concurrent `ia host --user` runs cannot interleave their renames, except where `takeOverStale` and `releaseLock` say
 * a lock can still be replaced (a run in another pid namespace, an earlier CLI, a hand, or a run frozen inside a
 * takeover's claim). The lock is created exclusively and holds this run's pid, a space and a random token: the
 * pid first, so a reader that parses a leading pid (an older CLI, and `takeOverStale`'s bounded read) still finds it,
 * and the token, which `releaseLock` checks, tells this run's lock from any other. A held lock is taken over — never
 * trusted blindly — only by `takeOverStale`, once it is a regular file whose pid, from 1 to 2147483647, has died, or
 * whose pid is empty, unparseable, 0 or negative, or above 2147483647 (the short window between another run's
 * `openSync` and its write among them) and that is older than `LOCK_EMPTY_GRACE_MS`; otherwise this refuses
 * INSTALL-BUSY. A lock whose pid is running is judged stale only once it is older than `LOCK_LIVE_BACKSTOP_MS`, so a
 * lock whose dead owner's pid another process has reused stays busy until then, or until it is removed by hand, as the
 * refusal says to do when no run is active. A symbolic link or any other non-regular file at the lock path is never
 * taken over, so it refuses INSTALL-BUSY too. Bounded at `LOCK_TAKEOVER_ATTEMPTS`, so a lock file that keeps coming
 * back (removal failing, a lock replaced while it was judged, another run holding the claim, or another process
 * winning the race) fails loudly instead of spinning forever. Once acquired, it sweeps abandoned claims beside the
 * lock. The sweep functions below must never touch this file or a claim.
 */
function acquireLock(parent: string): HeldLock {
  mkdirSync(parent, { recursive: true });
  const path = join(parent, LOCK_NAME),
    owner = `${process.pid} ${randomUUID()}`;
  const busy = (): never =>
    fail(
      'INSTALL-BUSY',
      `Another ia host --user run holds ${path}; wait for it or delete the file if no run is active`,
    );
  for (let attempts = 0; ; attempts++) {
    if (createLock(path, owner)) {
      sweepAbandonedClaims(parent);
      return { path, owner };
    }
    if (attempts >= LOCK_TAKEOVER_ATTEMPTS) busy();
    // Judged in its own function, from a descriptor it opens itself: the exclusive create only shows the name is taken.
    if (takeOverStale(path) === 'busy') busy();
  }
}
/**
 * Creates the lock exclusively and writes `owner` to it: true once created, false while its name is taken. On Windows
 * a name another run is removing stays delete-pending for well under a millisecond, and the exclusive create refuses
 * it with a busy code (`BUSY_CODES`); that is retried after waits that start at 1 ms and double to at most 50 ms, each
 * begun less than `LOCK_PENDING_WAIT_MS` after this call's first try began (each call starts over). A busy code after
 * that while a file still holds the name is judged like any held lock; once nothing holds the name, one more create
 * is tried, and a busy code from it, or a permission code off Windows (`PERMISSION_CODES`), refuses INPUT-INVALID,
 * naming the directory and saying to check its permissions. Any other error is rethrown.
 */
function createLock(path: string, owner: string): boolean {
  const deadline = Date.now() + LOCK_PENDING_WAIT_MS;
  let delay = 1,
    lastTry = false;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code && BUSY_CODES.has(code)) {
        if (Date.now() < deadline) {
          waitBusy(delay);
          delay = Math.min(delay * 2, 50);
          continue;
        }
        if (nameTaken(path)) return false;
        if (!lastTry) {
          lastTry = true; // the pending name may have cleared since the create above
          continue;
        }
      }
      if (code && (BUSY_CODES.has(code) || PERMISSION_CODES.has(code)))
        fail('INPUT-INVALID', `${dirname(path)} cannot hold the install lock (${code}); check its permissions`);
      throw error;
    }
    try {
      writeFileSync(fd, owner);
    } finally {
      closeSync(fd);
    }
    return true;
  }
}
/** Whether anything holds `path`'s name, a file whose removal is still pending included, never through a link. */
function nameTaken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
/**
 * Whether `lock.path` still names the lock this run created: a regular file, opened by `openLockToJudge`, holding
 * exactly `lock.owner` (read through `LOCK_OWNER_BYTES`, past its end, so a longer file never matches), whose name is
 * found, while that descriptor is open, to still name the judged file. Throws when it cannot tell (the lock vanished,
 * or could not be opened, read or compared).
 */
function holdsLock(lock: HeldLock): boolean {
  const fd = openLockToJudge(lock.path);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !readLockHead(fd, LOCK_OWNER_BYTES).equals(Buffer.from(lock.owner))) return false;
    const named = lstatSync(lock.path, { bigint: true });
    return named.dev === opened.dev && named.ino === opened.ino;
  } finally {
    closeSync(fd); // first, as Windows may keep a removed file's name until its last handle closes
  }
}
/**
 * Removes the lock `acquireLock` returned only while `holdsLock` finds it still this run's. Any other lock at its path
 * (another run's token, an older CLI's pid alone, a symbolic link or any other non-regular file) is left in place, as
 * is one that cannot be judged; best effort, it never throws, so it never masks the run's own result. A window between
 * the comparison and the removal remains, as in `takeOverStale`: Node has no unlink-if-same, so the removal takes
 * whatever the name holds by then. The lock path can change in it when a run in another pid namespace sharing the IA
 * home (which judges this run's pid not running), a hand, an older CLI, or a takeover whose claim was removed as
 * abandoned (see `takeOverStale`) replaces or removes this run's lock at that moment; the release then removes the
 * replacement. Any other takeover by a run of this CLI on this host removes only the lock it judged, under a claim,
 * unless this run froze in its release for longer than `LOCK_LIVE_BACKSTOP_MS`.
 */
function releaseLock(lock: HeldLock): void {
  try {
    if (holdsLock(lock)) rmSync(lock.path, { force: true });
  } catch {
    /* best-effort: left in place */
  }
}
/**
 * Validates every path once (portability, duplicates, prefix collisions) before anything is created; returns the portable
 * form in the same order. Folded on every platform: the set is installed wherever the plugin is, macOS and Windows volumes
 * both open `a` and `A` as one file, and APFS also opens `ß` and `ss` as one (`caseFold`).
 */
function assertPortableFileSet(files: readonly PluginFile[]): readonly string[] {
  const entries = files.map((file) => {
    const path = portable(file.path);
    return { path, key: caseFold(path) };
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) fail('PATH-UNSAFE', `Duplicate marketplace path: ${entry.path}`);
    seen.add(entry.key);
  }
  for (const a of entries)
    for (const b of entries)
      if (a !== b && b.key.startsWith(a.key + '/'))
        fail('PATH-UNSAFE', `${b.path} is nested under file path ${a.path}`);
  return entries.map((entry) => entry.path);
}
/** A staged `plugin.json`/`ia-plugin.json`, when present, must round-trip through disk as JSON; anything else is written verbatim. */
function assertStagedMetadataParses(stage: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (path !== PLUGIN_JSON && path !== META_JSON) continue;
    try {
      JSON.parse(readFileSync(join(stage, path), 'utf8'));
    } catch (error) {
      fail('INPUT-INVALID', `${path} was staged but does not parse as JSON (${describe(error)})`);
    }
  }
}
/**
 * Idempotent startup repair for a call that crashed or was killed mid-swap: if `target` is missing and exactly one
 * `.previous-*` sits beside it, that is the marketplace that survived the last attempt, so it is renamed back. Then
 * every `.stage-*` and `.remove-*` is swept (always disposable), and a `.previous-*` is swept only once `target`
 * exists again (never delete the one surviving copy while the marketplace itself is still missing). Best-effort:
 * a failure here is left for the next call or for `rename it back … or rerun ia host claude --user --apply`.
 */
function recoverMarketplaceState(parent: string, target: string): void {
  if (!existsSync(parent)) return;
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  if (!existsSync(target)) {
    const previousDirs = entries.filter((name) => name.startsWith('.previous-'));
    if (previousDirs.length === 1) {
      try {
        renameSync(join(parent, previousDirs[0] as string), target);
      } catch {
        /* left for the next call, or for manual recovery */
      }
    }
  }
  let after: string[];
  try {
    after = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of after) {
    const sweepable =
      name.startsWith('.stage-') ||
      name.startsWith('.remove-') ||
      (name.startsWith('.previous-') && existsSync(target));
    if (sweepable) {
      try {
        rmSync(join(parent, name), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
/**
 * Stage beside the target and swap it in whole, holding `claude/.lock` from just before recovery through the end of
 * the swap. `previous` is deleted only after the swap has succeeded, or after a restore of it has succeeded; if
 * both the swap and the restore fail, `previous` is kept on disk (never deleted) and the call refuses with
 * RECOVERY-REQUIRED naming it, so no attempt here can ever lose the marketplace that was already there. The stage
 * is always disposable and its cleanup is best-effort either way.
 */
export function materializeMarketplace(home: string, files: readonly PluginFile[]): { readonly directory: string } {
  assertIaHomeUsable(home);
  const paths = assertPortableFileSet(files);
  ensureIaHome(home);
  const parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  const lock = acquireLock(parent);
  try {
    recoverMarketplaceState(parent, target);
    const stage = join(parent, `.stage-${randomUUID()}`),
      previous = join(parent, `.previous-${randomUUID()}`);
    mkdirSync(stage, { recursive: true });
    let removePrevious = false;
    try {
      files.forEach((file, index) => {
        const path = join(stage, paths[index] as string);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.text, { flag: 'wx' });
      });
      assertStagedMetadataParses(stage, paths);
      const demoted = existsSync(target);
      if (demoted) renameRetrying(target, previous, target);
      try {
        renameRetrying(stage, target, target);
        removePrevious = demoted;
      } catch (swapError) {
        if (!demoted) throw swapError;
        try {
          renameRetrying(previous, target, target);
        } catch (restoreError) {
          fail(
            'RECOVERY-REQUIRED',
            `Marketplace swap failed (${describe(swapError)}) and restoring the previous copy also failed (${describe(restoreError)}); rename ${previous} back to ${target}, or rerun ia host claude --user --apply`,
          );
        }
        throw swapError;
      }
    } finally {
      try {
        if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      } catch {
        /* best-effort; never masks the real result */
      }
      try {
        if (removePrevious && existsSync(previous)) rmSync(previous, { recursive: true, force: true });
      } catch {
        /* best-effort; a stray .previous-* is swept by the next materialize */
      }
    }
  } finally {
    releaseLock(lock);
  }
  return { directory: target };
}
export type MaterializedPlugin =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly reason: string }
  | {
      readonly state: 'ok';
      readonly version: string;
      readonly cli: string;
      readonly channel: string;
      readonly entry: string;
    };
/** What `doctor` reports: `absent` (no directory), `invalid` (present but unreadable, unparseable or the wrong shape — `reason` is the read error's code, `'parse'` or `'shape'`), or `ok`. */
export function inspectMaterializedPlugin(home: string): MaterializedPlugin {
  const target = join(home, MARKETPLACE_DIR);
  if (!existsSync(target)) return { state: 'absent' };
  const read = (
    path: string,
  ): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } => {
    let text: string;
    try {
      text = readFileSync(join(target, path), 'utf8');
    } catch (error) {
      return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? describe(error) };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'parse' };
    }
  };
  const plugin = read(PLUGIN_JSON);
  if (!plugin.ok) return { state: 'invalid', reason: plugin.reason };
  const meta = read(META_JSON);
  if (!meta.ok) return { state: 'invalid', reason: meta.reason };
  const p = plugin.value as { version?: unknown },
    m = meta.value as Record<string, unknown>;
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.version !== 'string' ||
    m === null ||
    typeof m !== 'object' ||
    typeof m['cli'] !== 'string' ||
    typeof m['channel'] !== 'string' ||
    typeof m['entry'] !== 'string'
  )
    return { state: 'invalid', reason: 'shape' };
  return {
    state: 'ok',
    version: p.version,
    cli: m['cli'] as string,
    channel: m['channel'] as string,
    entry: m['entry'] as string,
  };
}
/** What `doctor` and `ia host --user` compare: the plugin version and the CLI it was rendered by, or null. Delegates to `inspectMaterializedPlugin`, collapsing `absent`/`invalid` to null. */
export function readMaterializedPlugin(
  home: string,
): { readonly version: string; readonly cli: string; readonly channel: string; readonly entry: string } | null {
  const inspected = inspectMaterializedPlugin(home);
  return inspected.state === 'ok'
    ? { version: inspected.version, cli: inspected.cli, channel: inspected.channel, entry: inspected.entry }
    : null;
}
/**
 * Renames `target` out of the way first (retried the same as a materialize swap), then, holding the same lock,
 * best-effort sweeps every `.stage-*`, `.previous-*` and `.remove-*` left beside it — all garbage once the caller
 * asked to remove the marketplace, including a `.previous-*` a prior RECOVERY-REQUIRED left behind. Returns true if
 * `target` or any leftover was actually removed. Never touches `.lock`.
 */
export function removeMarketplace(home: string): boolean {
  const parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  if (!existsSync(parent)) return false;
  const lock = acquireLock(parent);
  try {
    let removed = false;
    if (existsSync(target)) {
      const removing = join(parent, `.remove-${randomUUID()}`);
      renameRetrying(target, removing, target);
      removed = true;
      try {
        rmSync(removing, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* best-effort; swept below or by the next materialize */
      }
    }
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name === LOCK_NAME || !LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      try {
        rmSync(join(parent, name), { recursive: true, force: true });
        removed = true;
      } catch {
        /* best-effort */
      }
    }
    return removed;
  } finally {
    releaseLock(lock);
  }
}
