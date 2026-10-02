/**
 * The IA home as `ia host`, `ia host --user` and `ia init --decline` resolve and check it: host plugin distribution
 * spec §3. A service refusal keeps its code and message (contract §4.1); the CLI adds the location and next action.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveIaHome } from '@ia/distribution/ia-home';
import { Refusal, refusalOf } from './consumer.js';

/** A service refusal kept verbatim (§4.1) and given the location and next action the CLI can supply. */
export function located<T>(where: string | null, next: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const refusal = refusalOf(error);
    throw new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      where === null ? refusal.where : { path: where },
      next,
    );
  }
}
/** §3. A relative IA_HOME is the service's refusal; the remedy is the CLI's. */
export const hostHome = (env: Readonly<Record<string, string | undefined>>): string =>
  located(
    null,
    'Set IA_HOME to an absolute directory, or unset it to use ~/.ia.',
    () => resolveIaHome(env, homedir()).home,
  );
/**
 * §3: the remedy for an IA home that itself looks like a workspace. Callers run `assertIaHomeUsable` explicitly (not
 * by pattern-matching a refusal's message), so this wording is never guessed at, and every verb words it the same.
 */
export const homeSrcRemedy = (home: string): string =>
  `Move ${join(home, 'src')} out of the IA home, or set IA_HOME to another absolute directory.`;
