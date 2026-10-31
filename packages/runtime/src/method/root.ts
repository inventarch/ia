import { open } from '@inventarch/db';
import { defaultActor, governingMandates, profileRefusal } from '../mandate-modes.js';
import type { Mode } from '../mandate-modes.js';
import { MethodError } from './errors.js';

/**
 * One workspace root a host serves, checked before a method tool acts there: its repository `@workspace`, and the
 * profile its governing mandates give the default actor for a mode. A root no mandate governs is unrestricted; one
 * whose mandates refuse the mode, or cannot be read, refuses.
 */
export interface RootCheck {
  readonly workspace: string | null;
  readonly governed: boolean;
}

export function checkRoot(root: string, mode: Mode): RootCheck {
  let handle: ReturnType<typeof open>;
  try {
    handle = open(root, { cache: false });
  } catch (error) {
    // The installation's reason (`restore-required`, `lock-drift`, …) travels on, so a host can say what to run.
    const reason = (error as { reason?: unknown } | null)?.reason;
    throw Object.assign(
      new MethodError(
        `the workspace at ${root} does not open: ${error instanceof Error ? error.message : String(error)}`,
        'IA-CORE-ROOT-UNAVAILABLE',
      ),
      typeof reason === 'string' ? { reason } : {},
    );
  }
  try {
    const within = handle.resolveScope().token;
    const seat = handle.resolveSeat('', { within }).seat;
    const workspace = seat !== undefined && handle.get(seat, { within })?.discriminator === 'workspace' ? seat : null;
    let verdict: ReturnType<typeof profileRefusal>, governed: boolean;
    try {
      const actor = workspace === null ? undefined : defaultActor(handle, within, workspace);
      if (actor?.refusal) throw new MethodError(actor.refusal.message, actor.refusal.code);
      const mandates = governingMandates(handle, within, {
        ...(workspace === null ? {} : { workspace }),
        ...(actor?.actor === undefined ? {} : { actor: actor.actor }),
      });
      governed = mandates.length > 0;
      verdict = profileRefusal(mandates, mode);
    } catch (error) {
      if (error instanceof MethodError) throw error;
      throw new MethodError(
        `the mandate profile of ${root} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        'IA-CORE-ROOT-MANDATE',
      );
    }
    if (verdict.refusal) throw new MethodError(verdict.refusal.message, verdict.refusal.code);
    return { workspace, governed };
  } finally {
    handle.close();
  }
}
