import { expect, it } from 'vitest';
import type { EditorComposition, EditorView } from '@ia/runtime/editor';
import { STALE_VIEW, readSnapshot, staleView } from '../src/refresh.js';

const view = (generation: number): EditorView =>
  ({
    stamp: {
      protocol: 1,
      ownerSession: 'owner',
      generation,
      savedRevision: 'saved',
      viewRevision: `view-${generation}`,
      location: '',
      phase: null,
    },
    records: [],
    diagnostics: [],
    systems: [],
    outcome: 'pass',
    health: [],
  }) as unknown as EditorView;
const composition = {
  stamp: view(0).stamp,
  localRevision: 'local',
  dependencies: [],
  uses: [],
} as unknown as EditorComposition;
const rejection = (code: number): { code: number; message: string } => ({ code, message: 'The view changed.' });

it('identifies only the stale-view response code', () => {
  expect(staleView(rejection(STALE_VIEW))).toBe(true);
  expect(staleView(rejection(-32600))).toBe(false);
  expect(staleView(new Error('The view changed.'))).toBe(false);
});

it('retries the pair when a capture lands between the view and composition reads', async () => {
  const operations: string[] = [];
  let generation = 0;
  const request = async <T>(operation: string): Promise<T> => {
    operations.push(operation);
    if (operation === 'view') return view(generation) as T;
    // A local capture advanced the generation, so the first stamped read is refused once.
    if (generation === 0) {
      generation = 1;
      throw rejection(STALE_VIEW);
    }
    return composition as T;
  };
  const result = await readSnapshot(request);
  expect(result.view.stamp.generation).toBe(1);
  expect(operations).toEqual(['view', 'composition', 'view', 'composition']);
});

it('surfaces an unrelated failure without retrying', async () => {
  let calls = 0;
  const request = async <T>(operation: string): Promise<T> => {
    calls++;
    if (operation === 'view') return view(0) as T;
    throw rejection(-32600);
  };
  await expect(readSnapshot(request)).rejects.toMatchObject({ code: -32600 });
  expect(calls).toBe(2);
});

it('stops retrying once the attempt budget is spent', async () => {
  let views = 0;
  const request = async <T>(operation: string): Promise<T> => {
    if (operation === 'view') {
      views++;
      return view(views) as T;
    }
    throw rejection(STALE_VIEW);
  };
  await expect(readSnapshot(request, 3)).rejects.toMatchObject({ code: STALE_VIEW });
  expect(views).toBe(3);
});
