import type { EditorSnapshot } from '@inventarch/db/editor';
export function readProduct(
  snapshot: EditorSnapshot,
  identity: string,
  revision?: string,
): { identity: string; revision: string; title: string; status: string; owner: string; plans: string[] };
