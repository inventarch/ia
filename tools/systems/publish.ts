import { open } from '../../packages/db/src/index.js';
import { preparePublication, PublicationError } from '../../packages/runtime/src/index.js';
import { ExecutionError } from '@inventarch/runtime/authoring-execution';
import type { Success } from '@inventarch/runtime/authoring-execution';
import { id } from '@inventarch/runtime/authoring-execution';

/** The execution's base is the authored revision (runtime authoring-execution), so it is what a publication rechecks. */
function fresh(root: string, revision: string): void {
  const db = open(root, { cache: false });
  try {
    if (db.authoredRevision !== revision)
      throw new ExecutionError('IA-EXEC-SOURCE-CHANGED', 'Native inputs changed before draft publication');
  } finally {
    db.close();
  }
}
/** Stage E preserves its paths/result format while sharing the create-only runtime primitive. */
export function publish(root: string, result: Success, runId: string): string {
  try {
    const destination = `.ia/work/generated/${id(runId)}`;
    fresh(root, result.baseRevision);
    const prepared = preparePublication(
      root,
      destination,
      result.artifacts,
      JSON.stringify({ ...result, published: destination }, null, 2) + '\n',
    );
    try {
      fresh(root, result.baseRevision);
      return prepared.publish();
    } finally {
      prepared.close();
    }
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    if (error instanceof PublicationError && error.code === 'IA-PUBLICATION-CONFLICT')
      throw new ExecutionError('IA-EXEC-OUTPUT-EXISTS', error.message);
    throw new ExecutionError('IA-EXEC-OUTPUT-UNSAFE', `Draft publication failed: ${String(error)}`);
  }
}
