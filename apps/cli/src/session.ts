/**
 * Opening a workspace for a consumer verb: docs/specs/consumer-cli-contract/README.md §2.0 and §3.
 *
 * The open is the one step every workspace verb shares and the one that decides class 3 rather than class 1:
 * a root that cannot be read produced no finding set, so it is a refusal and never a diagnostic. The service's
 * own code is carried through unchanged (§4.1); only the next action is the CLI's.
 */
import { openWorkspaceSession } from '@inventarch/distribution/services';
import { Refusal, serviceNext } from './consumer.js';
import { recoverCommand } from './host.js';
import { quote } from './render.js';

export type Session = ReturnType<typeof openWorkspaceSession>;

export const codeOf = (error: unknown, fallback: string): string =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;

/**
 * Design row 27 for a workspace that does not open. `requireRoot` has already found a directory, and a directory with
 * no sources opens with the floor alone, so what reaches here is mostly a workspace whose sources the db does not read.
 * §2.5: IA-DB-SOURCE-UNAVAILABLE carries the installation state when the db raised it as an InstallationError: an
 * interrupted apply names the recovery, a missing or drifted generation the restore, any other state `ia doctor`.
 * Without one it is a source the db could not read, repaired first and then confirmed. A source path it does not admit
 * (a link or junction, an alias, a nonregular or misplaced source) is repaired first, and a source that changed during
 * the read is read again; either way `ia validate` for that root is the command that confirms the workspace opens. Only
 * a root the db found not to be a directory previews initializing one there, and any other code is `serviceNext`'s.
 */
function openNext(error: unknown, root: string): string {
  const code = codeOf(error, ''),
    validate = `ia validate --root ${quote(root)}`;
  if (code === 'IA-DB-SOURCE-UNAVAILABLE') {
    // The db's InstallationError names the installation state; a plain IA-DB-SOURCE-UNAVAILABLE is a source it could
    // not read (bytes that are not UTF-8, an unreadable .ia/workspace.json, a floor path that is not a directory).
    const reason =
      error !== null && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
        ? error.reason
        : undefined;
    if (reason === 'recovery-required')
      return `An interrupted installation blocks the read. Run "${recoverCommand('recover', root)}".`;
    if (reason === 'restore-required' || reason === 'lock-drift')
      return `Run "ia restore --apply --yes --root ${quote(root)}" to reinstall the locked generation.`;
    if (reason === undefined) return `Repair the source named above, then run "${validate}".`;
    return serviceNext(code, { command: null, root });
  }
  if (code === 'IA-DB-PATH-UNSAFE') return `Replace or remove the source path named above, then run "${validate}".`;
  if (code === 'IA-DB-SOURCE-CHANGED') return `Once nothing is writing the workspace's sources, run "${validate}".`;
  if (code === 'IA-DB-ROOT-INVALID')
    return `Run "ia init ${quote(root)}" to see what a new workspace there would contain.`;
  return serviceNext(code, { command: null, root });
}

export function openSession(root: string): Session {
  try {
    return openWorkspaceSession({ root });
  } catch (error) {
    throw new Refusal(
      codeOf(error, 'IA-DB-ROOT-INVALID'),
      error instanceof Error ? error.message : String(error),
      3,
      { path: root },
      openNext(error, root),
    );
  }
}
