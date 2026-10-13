/**
 * Opening a workspace for a consumer verb: docs/specs/consumer-cli-contract/README.md §2.0 and §3.
 *
 * The open is the one step every workspace verb shares and the one that decides class 3 rather than class 1:
 * a root that cannot be read produced no finding set, so it is a refusal and never a diagnostic. The service's
 * own code is carried through unchanged (§4.1); only the next action is the CLI's.
 */
import { EditorDatabase } from '@inventarch/db/editor';
import type { EditorSnapshot } from '@inventarch/db/editor';
import { openWorkspaceSession } from '@inventarch/distribution/services';
import type { SessionOptions } from '@inventarch/distribution/services';
import { Refusal, serviceNext } from './consumer.js';
import { nearestTokens } from './commands.js';
import { recoverCommand } from './host.js';
import { quote } from './render.js';

export type Session = ReturnType<typeof openWorkspaceSession>;
/** What the identity remedies below read of an open workspace: an editor snapshot answers them as a session's reader does. */
export type Records = Pick<Session['reader'], 'refused' | 'records'>;

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
    if (reason === 'engine-incompatible')
      return `Use an IA installation supporting the required distribution engine, then run "${validate}". Keep the lock and archive engine ranges intact; restore cannot upgrade the running CLI. To downgrade, restore a complete pre-upgrade workspace backup with its matching CLI.`;
    if (reason === undefined) return `Repair the source named above, then run "${validate}".`;
    return serviceNext(code, { command: null, root });
  }
  if (code === 'IA-DB-PATH-UNSAFE') return `Replace or remove the source path named above, then run "${validate}".`;
  if (code === 'IA-DB-SOURCE-CHANGED') return `Once nothing is writing the workspace's sources, run "${validate}".`;
  if (code === 'IA-DB-ROOT-INVALID')
    return `Run "ia init ${quote(root)}" to see what a new workspace there would contain.`;
  return serviceNext(code, { command: null, root });
}

/** How `ia validate` opens its session: checks admitted structurally (C21); no evidence is read (review finding B3-R4). */
export const VALIDATING = { checks: 'structural' } as const;
export function openSession(root: string, options: Omit<SessionOptions, 'root'> = {}): Session {
  try {
    return openWorkspaceSession({ root, ...options });
  } catch (error) {
    throw openRefusal(error, root);
  }
}
const openRefusal = (error: unknown, root: string): Refusal =>
  new Refusal(
    codeOf(error, 'IA-DB-ROOT-INVALID'),
    error instanceof Error ? error.message : String(error),
    3,
    { path: root },
    openNext(error, root),
  );

/** An open editor snapshot: one consistent read of the workspace's sources, their admission and its registry. */
export interface Editor {
  readonly snapshot: EditorSnapshot;
  close(): void;
}
/**
 * How `ia preview` and `ia author` open their editor snapshot: checks admitted structurally, as `ia validate` admits
 * them (C21), so a `@check` naming an evaluator that is not built in is a record they can draft beside and edit rather
 * than an admission error; no evidence is listed (review finding B3-N5), so a candidate never reads it.
 */
export const AUTHORING = { checks: 'structural' } as const;
/**
 * The authoring verbs' open (plan amendment C18): db's editor database, which reads the inputs twice and keeps them only
 * when both reads agree, so the source text a draft edits, the registry its schema comes from and the admission it is
 * compiled against are one state, admitted as `AUTHORING` says. It publishes no cache and writes nothing. A workspace
 * that does not open refuses as `openSession` refuses.
 */
export function openEditor(root: string): Editor {
  let database: EditorDatabase;
  try {
    database = new EditorDatabase(root, AUTHORING);
  } catch (error) {
    throw openRefusal(error, root);
  }
  return { snapshot: database.current, close: () => database.close() };
}

/** The words `ia next` reads a plan from, as its `--seat`. */
const SEAT_WORDS: readonly string[] = ['plan', 'milestone', 'task'];

/**
 * Design row 27 for an identity a workspace verb finds no admitted record of, where the workspace says what answers
 * it, so `ia inspect`, `ia read` and `ia next` name the same command for the same cause: a source holds it and
 * admission refused it names `ia validate`, which says why; else the nearest admitted identity, run through the same
 * verb, answers a misspelling (for `ia next`, the nearest @plan, @milestone or @task as its seat). Null when neither does.
 */
export function nearestNext(
  reader: Records,
  identity: string,
  verb: 'inspect' | 'read' | 'next',
  rooted: string,
): string | null {
  if (reader.refused.some((record) => record.identity === identity))
    return `Run "ia validate${rooted}" to see why admission refused ${identity}.`;
  const [nearest] = nearestTokens(
    identity,
    reader
      .records()
      .filter((record) => verb !== 'next' || SEAT_WORDS.includes(record.discriminator))
      .map((record) => record.identity),
    1,
  );
  if (nearest === undefined) return null;
  return verb === 'next'
    ? `Run "ia next --seat ${nearest}${rooted}" for the nearest admitted @plan, @milestone or @task.`
    : `Run "ia ${verb} ${nearest}${rooted}" for the nearest admitted identity.`;
}

/**
 * Design row 27 for an identity `ia inspect` or `ia read` finds no admitted record of: what `nearestNext` names, else
 * the workspace overview.
 */
export function identityNext(reader: Records, identity: string, verb: 'inspect' | 'read', rooted: string): string {
  return (
    nearestNext(reader, identity, verb, rooted) ??
    `Run "ia inspect${rooted}" for the overview of what the workspace admits.`
  );
}
