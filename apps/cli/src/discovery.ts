/**
 * consumer-cli-contract §1.2's workspace discovery and the IA home it passes over. They sit apart from the consumer shell
 * so the `ia` bin can decide a hand-off before any command module loads (bin.ts): Node built-ins and two leaf modules
 * only. consumer.ts re-exports both.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { sameFile } from '@inventarch/db/internal/paths';
import { resolveIaHome } from '@inventarch/distribution/ia-home';

/**
 * §1.2: walk from cwd toward the filesystem root and take the first directory containing `.ia/src`. Host plugin
 * distribution spec §3: a directory whose `.ia` is the IA home is never a workspace, even if src/ appeared there.
 */
export function discoverRoot(start: string, iaHome?: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    // The IA home by device and inode, so a home spelled in another case or normalization is still recognized.
    if (existsSync(resolve(current, '.ia/src')) && (iaHome === undefined || !sameFile(resolve(current, '.ia'), iaHome)))
      return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
/** The IA home for discovery, or undefined when its variable is malformed; the verb that needs the home refuses then. */
export function iaHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string | undefined {
  try {
    return resolveIaHome(env, home).home;
  } catch {
    return undefined;
  }
}
