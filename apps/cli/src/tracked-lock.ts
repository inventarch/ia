/**
 * The tracked list's store lock (consumer CLI contract §2.16). Every mutation reads, checks and replaces
 * `tracked-workspaces.json` as one transaction, so two `ia` processes cannot both start from the same rows and lose one
 * addition: the mutation holds `<IA home>/tracked-workspaces.json.lock` from before it loads to after it replaces.
 *
 * The mechanism is the IA home's owner-stamped lock (`@inventarch/distribution/home-lock`), which the update cache
 * shares: a lock file created whole with its owner in it, removed only by the owner that published it. A lock some other
 * owner holds is never renamed or deleted, whether that owner is running or gone and however old the lock is. A holder
 * that is killed therefore leaves a lock that blocks every mutation until a person deletes it: the call waits, then
 * refuses as `IA-CLI-TRACKED-LOCKED` naming the lock path and its owner, and says so when that owner is on this host and
 * its pid is no longer running. A signal during the wait stops it (`LockOptions.signal`), leaving that lock as it was.
 */
import {
  HOME_LOCK_WAIT_MS,
  HomeLockedError,
  HomeLockLeftError,
  withHomeLock,
} from '@inventarch/distribution/home-lock';
import type { HomeLockOptions } from '@inventarch/distribution/home-lock';
import { Refusal } from './consumer.js';

export type { LockOwner } from '@inventarch/distribution/home-lock';
export { pidRunning, processStart } from '@inventarch/distribution/home-lock';

export const TRACKED_LOCK_FILE = 'tracked-workspaces.json.lock';
/** How long a mutation waits for another holder before it refuses; a hold lasts milliseconds. */
export const LOCK_WAIT_MS = HOME_LOCK_WAIT_MS;

export type LockOptions = HomeLockOptions;

/**
 * Runs `action` holding the store lock under `home`. Creates the home as a write would. Refuses as
 * `IA-CLI-TRACKED-LOCKED` when another holder is still there after `waitMs`; it never removes another holder's lock.
 * Refuses as `IA-CLI-TRACKED-LOCK-LEFT` when the action's change was made but this call's own lock could not be removed.
 * Rejects with `options.signal`'s reason when that fires during the wait, for the command boundary to report as §3's 130.
 */
export async function withTrackedLock<T>(home: string, action: () => T, options: LockOptions = {}): Promise<T> {
  try {
    return await withHomeLock(home, TRACKED_LOCK_FILE, action, options);
  } catch (error) {
    if (error instanceof HomeLockLeftError)
      throw new Refusal(
        'IA-CLI-TRACKED-LOCK-LEFT',
        `The change was made, but its lock could not be removed: ${error.message}`,
        3,
        { path: error.lock },
        `Once no other ia process is running on this host, delete ${error.lock} by hand (until then every change to the tracked list waits for it and refuses), then run "ia workspaces list" to see the change.`,
      );
    if (!(error instanceof HomeLockedError)) throw error;
    throw new Refusal(
      'IA-CLI-TRACKED-LOCKED',
      `The tracked list is locked by another ia process (${error.held}): ${error.lock}`,
      3,
      { path: error.lock },
      `Wait for the other "ia workspaces" command to finish. ia never removes another owner's lock automatically: if no ia process is running on ${error.host}, delete ${error.lock} by hand, then run the command again.`,
    );
  }
}
