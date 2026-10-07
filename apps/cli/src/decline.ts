/**
 * `ia init --decline` and `--forget-decline`: docs/specs/host-plugin-distribution/README.md §7.2 and §9.
 * They write only the IA home's decisions file, never the repository. `clearDecline` is what a successful
 * `ia init --apply` runs, and it never fails the init: a broken decisions file is reported by `ia doctor`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Decision, DeclineKind } from '@inventarch/distribution/decisions';
import {
  DECISIONS,
  forgetDecision,
  readDecisions,
  recordDecision,
  repositoryKey,
} from '@inventarch/distribution/decisions';
import { resolveIaHome } from '@inventarch/distribution/ia-home';
import type { Context, Result } from './consumer.js';
import { Refusal, refusalOf } from './consumer.js';
import { homeSrcRemedy } from './home-remedy.js';
import { document, entry, quote, words } from './render.js';

type Env = Readonly<Record<string, string | undefined>>;
const homeOf = (env: Env): string => resolveIaHome(env, homedir()).home;

/**
 * §9.2: the remedy depends on why the write failed, not on a fixed sentence. `home` is undefined only when
 * `resolveIaHome` itself refused (a relative IA_HOME/IA_HOST_HOME), before any file could be named; `ia host`'s own
 * `homeSrcRemedy` is reused rather than duplicated for the home-looks-like-a-workspace cause, and an invalid
 * decisions file is inspected directly with `readDecisions` rather than by pattern-matching the caught message.
 * Each remedy ends in the one command that runs the refused decline again (design row 27).
 */
function declineRefusal(home: string | undefined, error: unknown, rerun: string): Refusal {
  const refusal = refusalOf(error);
  if (home === undefined)
    return new Refusal(
      refusal.code,
      refusal.message,
      3,
      null,
      `Set IA_HOME to an absolute directory, or unset it to use ~/.ia; then run "${rerun}".`,
    );
  if (refusal.code === 'IA-DIST-PATH-UNSAFE')
    return new Refusal(refusal.code, refusal.message, 3, null, homeSrcRemedy(home, rerun));
  if (refusal.code === 'IA-DIST-INPUT-INVALID') {
    const file = join(home, DECISIONS);
    const { reason } = readDecisions(home);
    const next =
      reason === 'parse' || reason === 'schema'
        ? `Fix or delete ${file}, then run "${rerun}".`
        : `Check the permissions of ${file}, then run "${rerun}".`;
    return new Refusal(refusal.code, refusal.message, 3, { path: file }, next);
  }
  return refusal;
}

export function runDecline(context: Context, target: string, kind: DeclineKind | undefined): Result {
  const { args, caps, json, host } = context;
  const path = repositoryKey(target).path;
  let home: string | undefined,
    decision: Decision | null = null,
    forgotten = false;
  try {
    home = homeOf(host.env);
    if (kind === undefined) forgotten = forgetDecision(home, target);
    else decision = recordDecision(home, target, kind, args.value('host') ?? 'none');
  } catch (error) {
    const host = args.value('host');
    const rerun = [
      'ia init',
      ...args.positionals.map(quote),
      ...(kind === undefined ? ['--forget-decline'] : ['--decline', kind]),
      ...(host === undefined ? [] : ['--host', host]),
    ].join(' ');
    throw declineRefusal(home, error, rerun);
  }
  if (json)
    return {
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, command: 'init', root: target, path, decision, forgotten }) + '\n',
      stderr: '',
    };
  const line =
    decision === null
      ? forgotten
        ? `Forgot the recorded decline for ${target}.`
        : `No decline was recorded for ${target}.`
      : decision.decision === 'declined-forever'
        ? `Recorded: never offer to initialize ${decision.path}. "ia init" still works when run explicitly.`
        : `Recorded: do not offer to initialize ${decision.path} again today.`;
  return {
    exitCode: 0,
    // §9.2's "no entry" case is informational, not a completed action; every other line records one, and keeps `success`.
    stdout: document(
      [entry([words(line)], { depth: 0, symbol: decision === null && !forgotten ? 'info' : 'success' }, caps)],
      { leadingBlank: true },
    ),
    stderr: '',
  };
}
export function clearDecline(env: Env, target: string): void {
  try {
    forgetDecision(homeOf(env), target);
  } catch {
    // §9.2: a broken decisions file never fails an init; `ia doctor` reports it.
  }
}
