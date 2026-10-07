/**
 * Opening a workspace for a consumer verb: docs/specs/consumer-cli-contract/README.md §2.0 and §3.
 *
 * The open is the one step every workspace verb shares and the one that decides class 3 rather than class 1:
 * a root that cannot be read produced no finding set, so it is a refusal and never a diagnostic. The service's
 * own code is carried through unchanged (§4.1); only the next action is the CLI's.
 */
import { openWorkspaceSession } from '@inventarch/distribution/services';
import { Refusal } from './consumer.js';

export type Session = ReturnType<typeof openWorkspaceSession>;

export const codeOf = (error: unknown, fallback: string): string =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;

/** The service message without the `CODE: ` prefix its error class adds; a refusal carries the code itself. */
export const messageOf = (error: unknown, code: string): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
};

/**
 * A workspace that could not be opened (§2.5): exit 3, the service's own code carried through. IA-DB-SOURCE-UNAVAILABLE
 * here means an interrupted installation blocks the read, not a bad path.
 */
export function openRefusal(error: unknown, root: string): Refusal {
  const code = codeOf(error, 'IA-DB-ROOT-INVALID');
  return new Refusal(
    code,
    error instanceof Error ? error.message : String(error),
    3,
    { path: root },
    code === 'IA-DB-SOURCE-UNAVAILABLE'
      ? `An interrupted installation blocks the read. Run "ia-distribution recover --root ${root}".`
      : 'Pass --root <path> with an existing workspace, or run "ia init" to see what a new one would contain.',
  );
}
export function openSession(root: string): Session {
  try {
    return openWorkspaceSession({ root });
  } catch (error) {
    throw openRefusal(error, root);
  }
}
