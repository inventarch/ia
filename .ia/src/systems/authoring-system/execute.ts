import { DraftError, formatDraft, validateDraft } from '@ia/authoring-system';
import { ExecutionError } from '../../../../tools/systems/types.js';
import type { Context, Product } from '../../../../tools/systems/types.js';

export function validateIA(context: Context, input: unknown): Product {
  return draft(context, input, false);
}
export function formatIA(context: Context, input: unknown): Product {
  return draft(context, input, true);
}
function draft(context: Context, input: unknown, formatting: boolean): Product {
  try {
    const result = (formatting ? formatDraft : validateDraft)(
      { reader: context.db, within: context.db.resolveScope().token, revision: context.db.revision },
      input,
    );
    return { artifacts: result.artifacts, candidateRevision: result.candidateRevision, evidence: result.evidence };
  } catch (error) {
    if (error instanceof DraftError)
      throw new ExecutionError(
        error.code === 'IA-EXEC-SCOPE-UNAVAILABLE'
          ? 'IA-EXEC-SOURCE-CHANGED'
          : error.code === 'IA-EXEC-LIMIT-EXCEEDED'
            ? 'IA-EXEC-INPUT-INVALID'
            : error.code,
        error.message,
        error.diagnostics,
      );
    throw error;
  }
}
