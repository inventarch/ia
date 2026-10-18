import type { Door } from '@inventarch/runtime';
import { captureKnowledge, openKnowledgeView, KnowledgeError } from '@inventarch/kb';
import { executeKnowledge, knowledgeFailure, parseKnowledgeRequest } from '@inventarch/kb/protocol';
import type { KnowledgeOperation } from '@inventarch/kb/protocol';
/** Tokens are interpreted only by their issuing Door. Transfer membership and graph revision, never the token. */
export function knowledgeTool(root: string, door: Door, operation: KnowledgeOperation, input: unknown) {
  try {
    const args = parseKnowledgeRequest(operation, input);
    const membership = door.request({
      operation: 'records',
      params: args.within === undefined ? {} : { within: args.within },
    });
    if (!membership.ok) throw new KnowledgeError('IA-KB-SCOPE-UNAVAILABLE', 'Knowledge scope unavailable');
    const snapshot = membership.result as { revision: string; records: readonly { identity: string }[] };
    if (snapshot.records.length > 1000 || Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024)
      throw new KnowledgeError('IA-KB-SCOPE-LIMIT', 'Knowledge scope exceeds membership budget');
    const view = openKnowledgeView(
      captureKnowledge(root, {
        identities: snapshot.records.map((r) => r.identity),
        expectedRevision: snapshot.revision,
      }),
    );
    try {
      return executeKnowledge(view, operation, args);
    } finally {
      view.close();
    }
  } catch (error) {
    return knowledgeFailure(error);
  }
}
