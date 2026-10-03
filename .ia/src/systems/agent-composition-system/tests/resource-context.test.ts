import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@inventarch/session-system';
import { captureWorkspace } from '../src/corpus.js';
import type { Capture } from '../src/corpus.js';
import { openLocalAuthoringView } from '../src/authoring-manifest.js';
import { resourceOccurrences, verifyResources } from '../src/resources.js';
import { clearNativeContexts, NATIVE_CONTEXT_ENTRIES, nativeContext } from '../src/resource-context.js';
import { metadataDigest } from '../src/resource-format.js';

// The shipped-view case captures the whole repository.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Counts full native rebuilds. The subclass is otherwise transparent to every caller.
const rebuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@inventarch/db/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/db/editor')>();
  class CountedSnapshot extends actual.EditorSnapshot {
    constructor(...input: ConstructorParameters<typeof actual.EditorSnapshot>) {
      super(...input);
      rebuilds.count += 1;
    }
  }
  return { ...actual, EditorSnapshot: CountedSnapshot };
});
function countRebuilds<T>(run: () => T): { value: T; rebuilds: number } {
  const before = rebuilds.count,
    value = run();
  return { value, rebuilds: rebuilds.count - before };
}
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'no refusal';
}

const repository = fileURLToPath(new URL('../../../../..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'ia-native-context-'));
afterAll(() => {
  const target = resolve(temporary),
    parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('ia-native-context-'))
    throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
});
beforeEach(() => clearNativeContexts());

let sequence = 0;
/** A distinct verified capture of the embedded floor per call. */
const fresh = (): Capture => captureWorkspace(temporary, `cache-${sequence++}`);
const resign = (capture: Capture): Capture => {
  const { revision: _revision, ...body } = capture;
  return { ...body, revision: digest(body) };
};
/** Moves every record in the first source with occurrences down one line. */
function shifted(capture: Capture): Capture['sources'] {
  const path = resourceOccurrences(capture).occurrences[0]!.path;
  return capture.sources.map((source) => (source.path === path ? { ...source, text: '\n' + source.text } : source));
}
/** Same capture whose first shifted source answers `reads(n)` on its n-th text read. */
function reading(capture: Capture, reads: (n: number) => 'honest' | 'shifted'): Capture {
  const moved = shifted(capture),
    index = moved.findIndex((source, i) => source.text !== capture.sources[i]!.text);
  const honest = capture.sources[index]!,
    other = moved[index]!;
  let count = 0;
  const source = { path: honest.path, location: honest.location } as Capture['sources'][number];
  Object.defineProperty(source, 'text', {
    enumerable: true,
    get: () => (reads(++count) === 'honest' ? honest.text : other.text),
  });
  return { ...capture, sources: capture.sources.map((row, i) => (i === index ? source : row)) };
}
const emptyEnvelope = (capture: Capture) => {
  const body = {
    format: 'ia.captured-resources.v1' as const,
    sourceRevisions: resourceOccurrences(capture).sourceRevisions,
    nativeCaptureRevision: capture.revision,
    files: [],
    associations: [],
  };
  return { ...body, digest: metadataDigest(body) };
};

describe('native context reuse', () => {
  it('builds one native context for repeated public calls on the same verified capture', () => {
    const capture = fresh(),
      envelope = emptyEnvelope(capture);
    clearNativeContexts();
    const calls = countRebuilds(() => [
      resourceOccurrences(capture),
      verifyResources(envelope, capture),
      resourceOccurrences(structuredClone(capture)),
    ]);
    expect(calls.rebuilds).toBe(1);
    expect(calls.value[2]).toEqual(calls.value[0]);
  });

  it('never reuses a context for different bytes, whatever revision they carry', () => {
    const capture = fresh(),
      expected = resourceOccurrences(capture),
      moved = shifted(capture);
    // Different bytes under the cached revision are refused before any lookup.
    expect(countRebuilds(() => codeOf(() => resourceOccurrences({ ...capture, sources: moved }))).value).toBe(
      'IA-CORPUS-INVALID',
    );
    // Different bytes under their own valid revision build a new context.
    const other = countRebuilds(() => resourceOccurrences(resign({ ...capture, sources: moved })));
    expect(other.rebuilds).toBe(1);
    expect(other.value.occurrences.map((o) => o.line)).not.toEqual(expected.occurrences.map((o) => o.line));
    // A source that changes between reads is read once: the context matches the verified bytes.
    clearNativeContexts();
    expect(resourceOccurrences(reading(capture, () => 'honest'))).toEqual(expected);
    // Cold cache: the changing source must build its own context from the verified read. reading() itself
    // calls resourceOccurrences, so it runs before the clear.
    const changing = reading(capture, (n) => (n === 1 ? 'honest' : 'shifted'));
    clearNativeContexts();
    expect(countRebuilds(() => resourceOccurrences(changing))).toEqual({ value: expected, rebuilds: 1 });
    expect(countRebuilds(() => resourceOccurrences(capture))).toEqual({ value: expected, rebuilds: 0 });
    expect(codeOf(() => resourceOccurrences(reading(capture, (n) => (n === 1 ? 'shifted' : 'honest'))))).toBe(
      'IA-CORPUS-INVALID',
    );
  });

  it('keeps no caller object and shares only a deeply frozen context', () => {
    const capture = fresh(),
      pristine = structuredClone(capture),
      context = nativeContext(capture),
      before = JSON.stringify(context);
    expect(context.capture).not.toBe(capture);
    expect(context.capture.sources).not.toBe(capture.sources);
    for (const value of [
      context,
      context.capture,
      context.capture.sources,
      context.capture.sources[0],
      context.occurrences,
      context.occurrences[0],
      context.sourceRevisions,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    // Mutating the caller's capture after the call reaches neither the cached context nor a later lookup.
    (capture.sources as unknown as { text: string }[])[0]!.text += '\n';
    expect(JSON.stringify(context)).toBe(before);
    expect(nativeContext(pristine)).toBe(context);
    expect(codeOf(() => nativeContext(capture))).toBe('IA-CORPUS-INVALID');
    expect(nativeContext(resign(capture))).not.toBe(context);
  });

  it(`holds at most ${NATIVE_CONTEXT_ENTRIES} contexts and evicts the least recently used`, () => {
    expect(NATIVE_CONTEXT_ENTRIES).toBe(4);
    const captures = Array.from({ length: 6 }, fresh);
    clearNativeContexts();
    const cost = (i: number) => countRebuilds(() => nativeContext(captures[i]!)).rebuilds;
    expect([0, 1, 2, 3].map(cost)).toEqual([1, 1, 1, 1]);
    expect(cost(0)).toBe(0);
    expect(cost(4)).toBe(1); // evicts 1, the least recently used
    expect(cost(1)).toBe(1); // evicts 2
    expect([0, 3, 4, 1].map(cost)).toEqual([0, 0, 0, 0]);
    expect(cost(2)).toBe(1);
    expect(cost(5)).toBe(1);
    expect([0, 3, 4, 1, 2, 5].map(cost)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('opens a local authoring view with one native context, and re-checks it without another', () => {
    const view = countRebuilds(() =>
      openLocalAuthoringView({
        root: repository,
        id: 'cache-view',
        adopted: [],
        manifests: [{ source: 'self', root: repository }],
        scope: { root: '', identities: null },
      }),
    );
    try {
      // One native context, the authoring index reader and the returned view reader.
      expect(view.rebuilds).toBe(3);
      expect(countRebuilds(() => view.value.assertCurrent()).rebuilds).toBe(2);
    } finally {
      view.value.close();
    }
  });
});
