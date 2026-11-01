import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspaceBytes } from '@inventarch/db';
import { LIMITS } from './format.js';
import { verifySelection } from './package.js';
import type { KnowledgeSelection } from './package.js';

/** Read and validate the optional workspace selector before choosing membership or reading bodies. */
export function readKnowledgeSelection(root: string): KnowledgeSelection | undefined {
  return existsSync(join(root, '.ia/knowledge.json'))
    ? verifySelection(
        Buffer.from(readWorkspaceBytes(root, '.ia/knowledge.json', LIMITS.captureSelectionBytes)).toString('utf8'),
        true,
      )
    : undefined;
}

/** Shared eligibility for capture and adapters; a selector can only narrow native membership. */
export function selectableKnowledgeRecord(
  record: {
    readonly identity: string;
    readonly placement: { readonly kind: string };
    readonly source: { readonly path: string };
  },
  selection?: KnowledgeSelection,
): boolean {
  return (
    record.placement.kind === 'authored' &&
    record.source.path.startsWith('.ia/src/') &&
    !record.source.path.startsWith('.ia/src/floor/') &&
    (selection === undefined || selection.records.includes(record.identity))
  );
}
