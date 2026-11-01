import { afterEach, expect, it, vi } from 'vitest';
import { readWorkspaceBytes } from '@inventarch/db';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Foundation } from '../src/foundation.js';
import { digest, hash, LIMITS } from '../src/format.js';
import { captureKnowledge } from '../src/local.js';
import { readKnowledgeSelection, selectableKnowledgeRecord } from '../src/selection.js';
import { verifySelection } from '../src/package.js';
import type { KnowledgeSelection } from '../src/package.js';
import { executeKnowledge } from '../src/protocol.js';
import { openKnowledgeView } from '../src/view.js';
vi.mock('@inventarch/db', { spy: true });
const base = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8'),
) as Foundation;
const sources = base.capture.sources
  .filter((s) => s.location.placement.kind === 'adopted')
  .map((s) => ({ path: s.path.replace(/^\.ia\/distributions\/store\/[^/]+\//, ''), text: s.text }));
const input = { adopted: [{ id: 'public-base', revision: digest(sources), sources }] };
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge limits '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  return root;
}
const name = (i: number) => 'k' + String(i).padStart(3, '0');
const identity = (i: number) => 'work-system/contract/spec/' + name(i);
const record = (i: number, says: string, body?: string) =>
  '@spec ' +
  name(i) +
  '\n  meaning\n    says "' +
  says +
  '"\n  work\n    title "T"\n    status draft\n' +
  (body === undefined ? '' : '    source "' + body + '"\n');
/** One native file holding `count` records, each bound to its own body file of `bytes(i)` bytes. */
function bound(root: string, count: number, bytes: (i: number) => number): string {
  const text =
    '#! ia 1.0\n' +
    Array.from({ length: count }, (_, i) => record(i, 'Record.', 'bodies/' + name(i) + '.md')).join('\n');
  writeFileSync(join(root, '.ia/src/notes.ia'), text);
  mkdirSync(join(root, 'bodies'), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'bodies', name(i) + '.md'), 'x'.repeat(bytes(i)));
  return text;
}
const outcome = (root: string, options: { selection?: KnowledgeSelection } = {}) => {
  const snapshot = captureKnowledge(root, { input, ...options });
  return { records: snapshot.records.length, unavailable: snapshot.unavailable.map((u) => u.code) };
};
const listing = (count: number): KnowledgeSelection => ({
  format: 'ia.kb.selection.v1',
  sourceId: 'example',
  records: Array.from({ length: count }, (_, i) => identity(i)),
  resources: [],
});

it('pins the format limits and the wider capture limits', () => {
  expect(LIMITS).toMatchObject({
    records: 1000,
    files: 100,
    selectedBytes: 8 * 1024 * 1024,
    selectionBytes: 64 * 1024,
    captureRecords: 5000,
    captureFiles: 1000,
    captureBytes: 40 * 1024 * 1024,
    captureSelectionBytes: 512 * 1024,
  });
});

it.each([
  ['authored', '.ia/src/notes.ia', identity(0), true],
  ['floor', '.ia/src/notes.ia', identity(0), false],
  ['adopted', '.ia/src/notes.ia', identity(0), false],
  ['authored', '.ia/src/floor/notes.ia', identity(0), false],
  ['authored', 'notes.ia', identity(0), false],
  ['authored', '.ia/src/notes.ia', identity(1), false],
] as const)('selects %s %s %s only when eligible', (kind, path, id, expected) => {
  expect(
    selectableKnowledgeRecord(
      { identity: id, placement: { kind }, source: { path } },
      {
        format: 'ia.kb.selection.v1',
        sourceId: 'example',
        records: [identity(0)],
        resources: [],
      },
    ),
  ).toBe(expected);
});
it('reads a body listed in the selection and leaves an unlisted one unavailable', () => {
  const root = workspace();
  bound(root, 1, () => 1);
  const selection = (resources: string[]): KnowledgeSelection => ({
    format: 'ia.kb.selection.v1',
    sourceId: 'example',
    records: [identity(0)],
    resources,
  });
  expect(outcome(root, { selection: selection(['bodies/k000.md']) })).toEqual({ records: 1, unavailable: [] });
  expect(readWorkspaceBytes).toHaveBeenCalledWith(root, 'bodies/k000.md', LIMITS.fileBytes);
  vi.mocked(readWorkspaceBytes).mockClear();
  expect(outcome(root, { selection: selection([]) })).toEqual({
    records: 0,
    unavailable: ['IA-RUNTIME-READ-UNREACHABLE'],
  });
  expect(vi.mocked(readWorkspaceBytes).mock.calls.some(([, path]) => path === 'bodies/k000.md')).toBe(false);
});

it('reads a body of exactly the file byte limit and refuses one byte more', () => {
  const root = workspace();
  bound(root, 1, () => LIMITS.fileBytes);
  expect(outcome(root)).toEqual({ records: 1, unavailable: [] });
  bound(root, 1, () => LIMITS.fileBytes + 1);
  expect(outcome(root)).toMatchObject({ records: 0, unavailable: [expect.any(String)] });
});

it('reads exactly the file limit across native and body files and refuses the next body', () => {
  const root = workspace();
  // One native file plus 999 bodies is exactly LIMITS.captureFiles.
  bound(root, LIMITS.captureFiles - 1, () => 1);
  expect(outcome(root)).toEqual({ records: LIMITS.captureFiles - 1, unavailable: [] });
  bound(root, LIMITS.captureFiles, () => 1);
  expect(outcome(root)).toMatchObject({ records: LIMITS.captureFiles - 1, unavailable: [expect.any(String)] });
});

it('admits exactly LIMITS.captureFiles native files and refuses one more before reading bodies', () => {
  const root = workspace(),
    limit = LIMITS.captureFiles;
  for (let i = 0; i < limit; i++)
    writeFileSync(join(root, '.ia/src', name(i) + '.ia'), '#! ia 1.0\n' + record(i, 'Record.'));
  expect(captureKnowledge(root, { input }).records).toHaveLength(limit);
  writeFileSync(join(root, '.ia/src', name(limit) + '.ia'), '#! ia 1.0\n' + record(limit, 'Record.'));
  expect(() => captureKnowledge(root, { input })).toThrow('Knowledge selection exceeds capture budget');
});

it('admits a capture selection of exactly LIMITS.captureRecords records and refuses one more', () => {
  expect(verifySelection(listing(LIMITS.captureRecords), true).records).toHaveLength(LIMITS.captureRecords);
  expect(() => verifySelection(listing(LIMITS.captureRecords + 1), true)).toThrow(
    'Knowledge selection record limit exceeded',
  );
});

it('admits a package selection of exactly LIMITS.records records and refuses one more', () => {
  expect(verifySelection(listing(LIMITS.records)).records).toHaveLength(LIMITS.records);
  expect(() => verifySelection(listing(LIMITS.records + 1))).toThrow('Knowledge selection record limit exceeded');
});

it.each([
  ['capture', true, LIMITS.captureFiles],
  ['package', false, LIMITS.files],
] as const)(
  'admits a %s selection of exactly its file limit in resources and refuses one more',
  (_, capture, limit) => {
    const resources = (count: number) => ({
      ...listing(1),
      resources: Array.from({ length: count }, (_, i) => 'bodies/' + name(i) + '.md'),
    });
    expect(verifySelection(resources(limit), capture).resources).toHaveLength(limit);
    expect(() => verifySelection(resources(limit + 1), capture)).toThrow('Knowledge selection resource limit exceeded');
  },
);

it('admits a package selection of exactly LIMITS.selectionBytes and refuses one byte more', () => {
  const json = JSON.stringify(listing(1)),
    padded = (bytes: number) => json + ' '.repeat(bytes - Buffer.byteLength(json));
  expect(verifySelection(padded(LIMITS.selectionBytes)).records).toEqual([identity(0)]);
  expect(() => verifySelection(padded(LIMITS.selectionBytes + 1))).toThrow('JSON byte limit exceeded');
});

it('reads a selection file listing every capture record, past the package byte limit', () => {
  const root = workspace(),
    json = JSON.stringify(listing(LIMITS.captureRecords));
  expect(Buffer.byteLength(json)).toBeGreaterThan(LIMITS.selectionBytes);
  writeFileSync(join(root, '.ia/knowledge.json'), json);
  expect(readKnowledgeSelection(root)?.records).toHaveLength(LIMITS.captureRecords);
});

it('captures a selection file above the package record limit', () => {
  const root = workspace(),
    count = LIMITS.records + 1;
  writeFileSync(
    join(root, '.ia/src/notes.ia'),
    '#! ia 1.0\n' + Array.from({ length: count }, (_, i) => record(i, 'Record.')).join('\n'),
  );
  writeFileSync(join(root, '.ia/knowledge.json'), JSON.stringify(listing(count)));
  expect(captureKnowledge(root, { input }).records).toHaveLength(count);
});

it('reads a selection file of exactly LIMITS.captureSelectionBytes and refuses one byte more', () => {
  const root = workspace(),
    json = JSON.stringify(listing(1));
  const write = (bytes: number) =>
    writeFileSync(join(root, '.ia/knowledge.json'), json + ' '.repeat(bytes - Buffer.byteLength(json)));
  write(LIMITS.captureSelectionBytes);
  expect(readKnowledgeSelection(root)?.records).toEqual([identity(0)]);
  write(LIMITS.captureSelectionBytes + 1);
  expect(() => readKnowledgeSelection(root)).toThrow();
});

it('captures exactly LIMITS.captureRecords records without a selection and refuses one more', () => {
  const root = workspace(),
    write = (count: number) =>
      writeFileSync(
        join(root, '.ia/src/notes.ia'),
        '#! ia 1.0\n' + Array.from({ length: count }, (_, i) => record(i, 'Record.')).join('\n'),
      );
  write(LIMITS.captureRecords);
  expect(captureKnowledge(root, { input }).records).toHaveLength(LIMITS.captureRecords);
  write(LIMITS.captureRecords + 1);
  expect(() => captureKnowledge(root, { input })).toThrow('Knowledge selection exceeds capture budget');
});

it('captures every capture record bound to one large document', () => {
  const root = workspace(),
    text = 'x'.repeat(128 * 1024);
  writeFileSync(join(root, 'shared.md'), text);
  writeFileSync(
    join(root, '.ia/src/notes.ia'),
    '#! ia 1.0\n' +
      Array.from({ length: LIMITS.captureRecords }, (_, i) => record(i, 'Record.', 'shared.md')).join('\n'),
  );
  const snapshot = captureKnowledge(root, { input });
  expect(snapshot.records).toHaveLength(LIMITS.captureRecords);
  expect(snapshot.records.at(-1)).toMatchObject({ body: text, bodySha256: hash(text) });
  const changed = 'y'.repeat(text.length);
  writeFileSync(join(root, 'shared.md'), changed);
  expect(captureKnowledge(root, { input }).digest).not.toBe(snapshot.digest);
}, 120000);

it('admits a knowledge scope of exactly LIMITS.captureRecords identities and refuses one more', () => {
  const root = workspace(),
    ids = (count: number) => Array.from({ length: count }, (_, i) => identity(i));
  writeFileSync(join(root, '.ia/src/notes.ia'), '#! ia 1.0\n' + record(0, 'Record.'));
  expect(captureKnowledge(root, { input, identities: ids(LIMITS.captureRecords) }).records).toHaveLength(1);
  expect(() => captureKnowledge(root, { input, identities: ids(LIMITS.captureRecords + 1) })).toThrow(
    'Invalid knowledge scope',
  );
});

it('gives each record of one file its own lines and the whole file hash', () => {
  const root = workspace(),
    text = '#! ia 1.0\n' + record(0, 'First.') + '\n' + record(1, 'Second.');
  writeFileSync(join(root, '.ia/src/notes.ia'), text);
  const { records } = captureKnowledge(root, { input });
  expect(records.map((r) => [r.identity, r.recordText, r.recordSha256])).toEqual([
    [identity(0), record(0, 'First.').trimEnd(), hash(text)],
    [identity(1), record(1, 'Second.').trimEnd(), hash(text)],
  ]);
});

it('reads native bytes past the package byte limit', () => {
  const root = workspace(),
    // A captured source may not pass the file limit, record syntax included.
    says = LIMITS.fileBytes - 1024,
    count = Math.ceil(LIMITS.selectedBytes / says);
  for (let i = 0; i < count; i++)
    writeFileSync(join(root, '.ia/src', name(i) + '.ia'), '#! ia 1.0\n' + record(i, 'x'.repeat(says)));
  expect(captureKnowledge(root, { input }).records).toHaveLength(count);
});

it('reads exactly the capture byte budget and refuses one byte more', () => {
  const root = workspace(),
    count = LIMITS.captureBytes / LIMITS.fileBytes;
  // Native bytes count toward the budget, so the last body takes what the native file left.
  const native = Buffer.byteLength(bound(root, count, () => 1));
  const fill = (extra: number) => (i: number) =>
    i === count - 1 ? LIMITS.fileBytes - native + extra : LIMITS.fileBytes;
  bound(root, count, fill(0));
  expect(outcome(root)).toEqual({ records: count, unavailable: [] });
  bound(root, count, fill(1));
  expect(outcome(root)).toMatchObject({ records: count - 1, unavailable: [expect.any(String)] });
});

it.each([10, 1])('truncates search with a bare result %i bytes below the response boundary', (margin) => {
  const root = workspace(),
    count = 100,
    write = (padding: (i: number) => number) =>
      writeFileSync(
        join(root, '.ia/src/notes.ia'),
        '#! ia 1.0\n' +
          Array.from({ length: count }, (_, i) => record(i, 'needle ' + 'y'.repeat(padding(i)))).join('\n'),
      );
  const measure = () => {
    const view = openKnowledgeView(captureKnowledge(root, { input }));
    // The value as the view alone bounds it: what the protocol wrapped before it reserved its envelope.
    const value = view.search('needle');
    return { view, results: value.results.length, bytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  write(() => 110);
  const first = measure();
  first.view.close();
  expect(first.results).toBeLessThan(count);
  // Grow the kept results until the bare value sits just under the limit: inside the bound alone, over it
  // once `{"version":1,"ok":true,"value":…}` wraps it.
  let gap = LIMITS.responseBytes - margin - first.bytes;
  const extra = Array.from({ length: count }, () => 0);
  for (let i = 0; gap > 0 && i < first.results; i++) {
    extra[i] = Math.min(gap, 40);
    gap -= extra[i]!;
  }
  write((i) => 110 + extra[i]!);
  const edge = measure();
  try {
    expect(edge).toMatchObject({ results: first.results, bytes: LIMITS.responseBytes - margin });
    const wrapped = Buffer.byteLength(JSON.stringify({ version: 1, ok: true, value: edge.view.search('needle') }));
    expect(wrapped).toBeGreaterThan(LIMITS.responseBytes);
    const response = executeKnowledge(edge.view, 'search', { query: 'needle' });
    expect(response).toMatchObject({ ok: true, value: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(LIMITS.responseBytes);
    expect((response.value as { results: unknown[] }).results).toHaveLength(first.results - 1);
  } finally {
    edge.view.close();
  }
});
