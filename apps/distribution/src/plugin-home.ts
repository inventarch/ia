import { randomUUID } from 'node:crypto';
import {
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
  LOCK_TAKEOVER_ATTEMPTS = 5,
  /** A pid is at most 10 decimal digits on every platform and leads the lock; no more is read to judge one. */
  LOCK_PID_BYTES = 32,
  /**
   * More than the at most 47 bytes a run writes to its lock (a pid of at most 10 digits, a space and a 36-character
   * UUID), so reading this much shows whether the lock holds anything beyond them.
   */
  LOCK_OWNER_BYTES = 64;
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
 * `LOCK_EMPTY_GRACE_MS`. Such a pid that is running is busy however old the lock is: its age does not show that its
 * owner stopped. A hard link at the lock path names the judged file itself, so it is judged like any other lock, and
 * taking it over removes only that name. A stale lock is removed only after its name is found to still name the judged
 * file, compared while the descriptor is open so that file's inode cannot be reused (on Windows, where a symbolic link
 * is followed, this comparison is what refuses one); the descriptor is closed first, as Windows may keep a removed
 * file's name until its last handle closes. A window between that comparison and the removal remains: Node has no
 * unlink-if-same. The lock path can change in it only if another run takes over the same stale lock at that moment, or
 * a hand replaces or removes it.
 */
function takeOverStale(path: string): 'busy' | 'removed' | 'retry' {
  let fd: number;
  try {
    fd = openLockToJudge(path);
  } catch {
    return 'retry'; // vanished, a symbolic link O_NOFOLLOW refuses, or unopenable: the attempt bound stops the spin
  }
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
    // Only a pid from 1 to 2147483647 names one owner. process.kill takes 0 or a negative pid for a process group or
    // for every process, and refuses a larger one as an invalid argument; isPidAlive reads either as running, whoever
    // wrote the lock, so those are judged as a pid that did not parse.
    const owner = Number.isInteger(pid) && pid > 0 && pid <= 2147483647;
    const stale = owner ? !isPidAlive(pid) : ageMs > LOCK_EMPTY_GRACE_MS;
    if (!stale) return 'busy';
    const named = lstatSync(path, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) return 'retry';
  } catch {
    return 'retry'; // the descriptor could not be judged, or the name vanished before it was compared
  } finally {
    closeSync(fd);
  }
  try {
    rmSync(path, { force: true });
  } catch {
    return 'retry'; // removal itself failing too; the caller's attempt bound stops the spin
  }
  return 'removed';
}
/**
 * Held for the lifetime of a materialize's recovery-through-swap, or of a whole `removeMarketplace`, so two
 * concurrent `ia host --user` runs cannot interleave their renames. The lock is created exclusively and holds this
 * run's pid, a space and a random token: the pid first, so a reader that parses a leading pid (an older CLI, and
 * `takeOverStale`'s bounded read) still finds it, and the token, which `releaseLock` checks, tells this run's lock from
 * any other. A held lock is taken over — never trusted blindly — only by `takeOverStale`, once it is a regular file
 * whose pid, from 1 to 2147483647, has died, or whose pid is empty, unparseable, 0 or negative, or above 2147483647
 * (the short window between another run's `openSync` and its write among them) and that is older than
 * `LOCK_EMPTY_GRACE_MS`; otherwise this refuses INSTALL-BUSY. A lock whose pid is running is never taken over however
 * old it is, so a lock whose dead owner's pid another process has reused stays busy until it is removed by hand, as the
 * refusal says to do when no run is active. A symbolic link or any other non-regular file at the lock path is never
 * taken over, so it refuses INSTALL-BUSY too. Bounded at `LOCK_TAKEOVER_ATTEMPTS`, so a lock file that keeps coming
 * back (removal failing, a lock replaced while it was judged, or another process winning the race) fails loudly instead
 * of spinning forever. The sweep functions below must never touch this file.
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
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return { path, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempts >= LOCK_TAKEOVER_ATTEMPTS) busy();
      // Judged in its own function, from a descriptor it opens itself: the exclusive open above only shows the
      // name is taken.
      if (takeOverStale(path) === 'busy') busy();
    }
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
 * the comparison and the removal remains, as in `takeOverStale`: Node has no unlink-if-same. Since this CLI never takes
 * over a lock whose pid is running, and this run's pid is running while it releases, the lock path can change in it
 * only if a hand, or an older CLI's 10-minute age rule, replaces or removes this run's lock at that moment.
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
 * both open `a` and `A` as one file (crowncodes/ia#315), and APFS also opens `ß` and `ss` as one (`caseFold`, crowncodes/ia#323).
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
