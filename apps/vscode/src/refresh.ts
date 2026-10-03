import type { EditorComposition, EditorView, ViewStamp } from '@inventarch/runtime/editor';

/** The editor server maps a lost view (EditorError 'stale') onto this response code. */
export const STALE_VIEW = -32801;
export function staleView(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === STALE_VIEW;
}
export type SnapshotRequest = <T>(operation: string, extra?: { readonly stamp: ViewStamp }) => Promise<T>;
/**
 * Read a view together with the composition that belongs to it.
 * A capture landing between the two reads retires the first stamp, so the pair is read again
 * instead of failing: a requested rebuild must not be lost to a keystroke that arrived beside it.
 */
export async function readSnapshot(
  request: SnapshotRequest,
  attempts = 3,
): Promise<{ readonly view: EditorView; readonly composition: EditorComposition }> {
  for (let attempt = 1; ; attempt++) {
    const view = await request<EditorView>('view');
    try {
      return { view, composition: await request<EditorComposition>('composition', { stamp: view.stamp }) };
    } catch (error) {
      if (attempt >= attempts || !staleView(error)) throw error;
    }
  }
}
