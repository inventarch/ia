import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stableSerialize } from '@inventarch/graph';
import { DbError, open, readInputs } from '../src/index.js';
import { stableState } from '../src/handle.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

it('opens the native corpus through immutable public read products', () => {
  const db = open(workspace(), { cache: false }),
    snapshot = db.snapshot();
  expect(snapshot.records.some((record) => record.name === 'sample-procedure')).toBe(true);
  expect(db.cache.state).toBe('disabled');
  expect(db.get(methodId)?.discriminator).toBe('playbook');
  expect(db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }).ok).toBe(true);
  expect(db.search('fixture').some((hit) => hit.identity === methodId)).toBe(true);
  expect(db.traverse({ start: [methodId], depth: 0 }).nodes).toEqual([{ identity: methodId, depth: 0 }]);
  expect(db.report.revision).toBe(db.revision);
  expect(db.refused).toEqual([]);
  expect(db.unadmitted).toEqual([]);
  expect(() => (snapshot.records as unknown[]).pop()).toThrow();
  expect(() => {
    (db.get(methodId)! as { name: string }).name = 'changed';
  }).toThrow();
});
it('verifies an identical cache without rewriting and preserves authored bytes', () => {
  const root = workspace(),
    before = readInputs(root),
    first = open(root),
    path = resolve(root, '.ia/.iadb/graph.json');
  expect(first.cache.state).toBe('written');
  expect(first.cache.observations).toEqual([]);
  const bytes = readFileSync(path, 'utf8');
  utimesSync(path, new Date(100000), new Date(100000));
  const modified = statSync(path).mtimeMs;
  const second = open(root);
  expect(second.cache.state).toBe('hit');
  expect(statSync(path).mtimeMs).toBe(modified);
  expect(second.snapshot()).toEqual(first.snapshot());
  expect(second.refresh()).toEqual(first.snapshot());
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readInputs(root)).toEqual(before);
  // D08a: the retained pair is the capture's, which no handle writes; the cache holds the graph alone.
  expect(second.previousRevision).toBeUndefined();
  expect(readdirSync(resolve(root, '.ia/.iadb'))).toEqual(['graph.json']);
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
});
it.each(['broken JSON', 'forged'])('replaces %s cache bytes even with a matching revision', (corruption) => {
  const root = workspace(),
    first = open(root),
    path = '.ia/.iadb/graph.json',
    good = readFileSync(resolve(root, path), 'utf8');
  put(
    root,
    path,
    corruption === 'forged' ? JSON.stringify({ ...JSON.parse(good), graph: { nodes: ['fabricated'] } }) : '{',
  );
  const second = open(root);
  expect(second.cache.state).toBe('written');
  expect(second.revision).toBe(first.revision);
  expect(second.records()).toEqual(first.records());
  expect(readFileSync(resolve(root, path), 'utf8')).toBe(good);
});
it('keeps fresh reads usable when cache access is obstructed or points outside', () => {
  const root = workspace(false);
  put(root, '.ia/.iadb', 'obstruction');
  const db = open(root);
  expect(db.records()).toHaveLength(118);
  expect(db.cache.state).toBe('unavailable');
  expect(db.cache.observations[0]?.code).toBe('IA-DB-CACHE-UNAVAILABLE');
  const other = workspace(),
    outside = workspace(false);
  put(outside, 'graph.json', 'do not touch');
  symlinkSync(outside, resolve(other, '.ia/.iadb'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(open(other).cache.state).toBe('unavailable');
  expect(readFileSync(resolve(outside, 'graph.json'), 'utf8')).toBe('do not touch');
});
it('publishes a new immutable generation after a byte edit without changing record identity', () => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, source + '\n# revision-only edit\n');
  expect(db.snapshot()).toEqual(before);
  const after = db.refresh();
  expect(after.revision).not.toBe(before.revision);
  expect(after.records.map((r) => r.identity)).toEqual(before.records.map((r) => r.identity));
  expect(() => db.records({ revision: before.revision })).toThrow(expect.objectContaining({ code: 'IA-DB-STALE' }));
  expect(open(root).snapshot()).toEqual(after);
  expect(before.revision).not.toBe(db.revision);
});
it('preserves the last published state when refresh fails', () => {
  const root = workspace(),
    db = open(root),
    first = db.revision;
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8') + '\n# revision-only edit\n');
  const before = db.refresh();
  put(root, '.ia/src/invalid.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => db.refresh()).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  expect(db.snapshot()).toEqual(before);
  // D08: a failed refresh rotates nothing.
  expect(db.previousRevision).toBe(first);
  expect(db.staleness(methodId)).toBe('unchanged');
});
it('retries unstable scans at most three times and publishes only a stable candidate', () => {
  const root = workspace(false),
    first = readInputs(root);
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  const second = readInputs(root);
  let calls = 0;
  const stable = stableState(() => (++calls === 1 ? first : second), false);
  expect(calls).toBe(4);
  expect(stable.inputs).toBe(second);
  calls = 0;
  expect(() => stableState(() => (++calls % 2 ? first : second), false)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SOURCE-CHANGED' }),
  );
  expect(calls).toBe(6);
  calls = 0;
  expect(() =>
    stableState(() => {
      calls++;
      throw new DbError('IA-DB-SOURCE-CHANGED', 'concurrent change');
    }, false),
  ).toThrow('three consecutive');
  expect(calls).toBe(3);
});
/** A fixture `@mandate` of the native agent-system, its header on line 3 of a file that opens with the pragma. */
const mandateSource = (name: string, moves = 'moves [Observation]', before = ''): string =>
  `#! ia 1.0\n\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may it do?"\n  governance\n    requires "Nothing."\n  authority\n    participant @agent agent-steward\n    ${moves}\n${before}`;
/** An entry's own admission finding, by code, path and line. */
const finding = (entry: {
  readonly finding: { readonly code: string; readonly path: string; readonly line: number };
}) => [entry.finding.code, entry.finding.path, entry.finding.line];
it('lists every record occurrence the root view does not admit, with its band and own admission finding (lane D, D1)', () => {
  const root = workspace();
  // (a) refused by schema admission, so `refused` names it too.
  put(root, '.ia/src/refused.ia', mandateSource('bogus', 'moves [Bogus]'));
  // (b) one identity at one band twice: both occurrences tie and neither is admitted.
  put(root, '.ia/src/tie-a.ia', mandateSource('tied'));
  put(root, '.ia/src/tie-b.ia', mandateSource('tied'));
  // (c) a file refused whole by a language error elsewhere in it: the parse still reads both headers.
  put(
    root,
    '.ia/src/whole.ia',
    mandateSource(
      'whole',
      'moves [Observation]',
      '\n@agent loose\n  meaning\n    says "x"\n  governance\n    applies []\n   misindented here\n',
    ),
  );
  // (c) a header the parse cannot read at all: the captured text still shows it.
  put(root, '.ia/src/header.ia', '#! ia 1.0\n\n@mandate Bad_Name!\n  meaning\n    says "x"\n');
  // (c) no pragma, so the parse reads no record: a header after a byte-order mark is still seen.
  put(root, '.ia/src/bom.ia', '\ufeff@mandate bommed\n  meaning\n    says "x"\n');
  // (c) review D-R3: a header behind a no-break space, a form feed or a zero-width space, and one in a CR-only file.
  for (const [name, lead] of [
    ['nbsp', '\u00a0'],
    ['formfeed', '\f'],
    ['zwsp', '\u200b'],
  ] as const)
    put(root, `.ia/src/${name}.ia`, `#! ia 1.0\n\n${lead}@mandate ${name}\n  meaning\n    says "x"\n`);
  put(root, '.ia/src/cr.ia', `${mandateSource('cr')}   misindented\n`.replaceAll('\n', '\r'));
  // (c) a file whose parse reads no record at all: a `@mandate` token anywhere on one of its lines is seen.
  put(root, '.ia/src/anywhere.ia', '#! ia 9.9\n\nnot a header @mandate hidden\n');
  // (c) a file refused whole for a requirement id another file declares too.
  put(
    root,
    '.ia/src/duplicate.ia',
    mandateSource(
      'dup',
      'moves [Observation]',
      '\n@contract clash\n  version "0.1.0"\n  meaning\n    says "x"\n    answers "y"\n  relationships\n    governs @check instance-schema-check\n  inputs\n    REQ-FOUNDATION-INPUT "Clashes with the foundation contract."\n',
    ),
  );
  // A parse error in a file that declares no mandate is listed under the word it does declare, and a reference inside
  // a record its parse reads is no header.
  put(root, '.ia/src/plain.ia', '#! ia 1.0\n\n@agent plain\n  meaning\n    answers "x @agent named"\n    says "x\n');
  const db = open(root, { cache: false }),
    unadmitted = db.unadmitted,
    at = (path: string) => unadmitted.filter((entry) => entry.path === path);
  expect(Object.isFrozen(unadmitted)).toBe(true);
  expect(unadmitted.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.finding))).toBe(true);
  expect(db.get('agent-system/policy/mandate/bogus')).toBeUndefined();
  expect(at('.ia/src/refused.ia')).toEqual([
    {
      identity: 'agent-system/policy/mandate/bogus',
      word: 'mandate',
      name: 'bogus',
      band: 100,
      path: '.ia/src/refused.ia',
      line: 3,
      endLine: 11,
      finding: {
        code: 'IA-COMP-FIELD-VALUE',
        path: '.ia/src/refused.ia',
        line: 11,
        message: expect.stringContaining("'authority.moves' admits one of"),
      },
    },
  ]);
  // Every `refused` occurrence is listed.
  for (const record of db.refused)
    expect(
      unadmitted.some(
        (entry) => entry.identity === record.identity && entry.path === record.path && entry.line === record.line,
      ),
      record.identity,
    ).toBe(true);
  for (const path of ['.ia/src/tie-a.ia', '.ia/src/tie-b.ia'])
    expect(at(path)).toEqual([
      {
        identity: 'agent-system/policy/mandate/tied',
        word: 'mandate',
        name: 'tied',
        band: 100,
        path,
        line: 3,
        endLine: 11,
        finding: {
          code: 'IA-GRAPH-IDENTITY-TIE',
          path,
          line: 3,
          message: expect.stringContaining('agent-system/policy/mandate/tied ties at band 100'),
        },
      },
    ]);
  // A record of a file refused whole carries the error inside its lines, else the file's first error.
  expect(
    at('.ia/src/whole.ia').map((entry) => [entry.identity, entry.word, entry.name, entry.line, ...finding(entry)]),
  ).toEqual([
    ['agent-system/policy/mandate/whole', 'mandate', 'whole', 3, 'IA-LANG-INDENT-STEP', '.ia/src/whole.ia', 18],
    ['agent-system/binding/agent/loose', 'agent', 'loose', 13, 'IA-LANG-INDENT-STEP', '.ia/src/whole.ia', 18],
  ]);
  expect(at('.ia/src/bom.ia')).toEqual([
    {
      word: 'mandate',
      name: 'bommed',
      band: 100,
      path: '.ia/src/bom.ia',
      line: 1,
      endLine: 1,
      finding: expect.objectContaining({ code: 'IA-LANG-PRAGMA-MISSING', path: '.ia/src/bom.ia', line: 1 }),
    },
  ]);
  expect(at('.ia/src/header.ia')).toEqual([
    // The text names the record as spelled, lowercased, though the parse refuses the spelling.
    {
      word: 'mandate',
      name: 'bad_name!',
      band: 100,
      path: '.ia/src/header.ia',
      line: 3,
      endLine: 3,
      finding: expect.objectContaining({ code: 'IA-LANG-HEADER-MALFORMED', line: 3 }),
    },
  ]);
  for (const name of ['nbsp', 'formfeed', 'zwsp'])
    expect(
      at(`.ia/src/${name}.ia`).map((entry) => [entry.word, entry.name, entry.band, entry.line]),
      name,
    ).toEqual([['mandate', name, 100, 3]]);
  // The parse reads a CR-only file as one line (no pragma there); the text, split at every terminator, reads its header,
  // and the reference on a line no parsed record spans is listed under its word alone.
  expect(at('.ia/src/cr.ia').map((entry) => [entry.word, entry.name, entry.line, entry.finding.code])).toEqual([
    // Its first line, the pragma's text, is a comment to the text's reading, which declares nothing (review D2 recheck F2).
    ['mandate', 'cr', 3, 'IA-LANG-PRAGMA-MISSING'],
    ['agent', undefined, 10, 'IA-LANG-PRAGMA-MISSING'],
  ]);
  // A token found past the start of a line names no record: only its word is known.
  expect(at('.ia/src/anywhere.ia')).toEqual([
    // The pragma line reads as a comment, so the unsupported pragma's error is taken at the first line past it, which no
    // identified record accounts for: an occurrence of no known word (review D2-R2 and its recheck F1, F2).
    {
      band: 100,
      path: '.ia/src/anywhere.ia',
      line: 3,
      endLine: 3,
      finding: expect.objectContaining({ code: 'IA-LANG-VERSION-UNSUPPORTED', line: 1 }),
    },
    {
      word: 'mandate',
      band: 100,
      path: '.ia/src/anywhere.ia',
      line: 3,
      endLine: 3,
      finding: expect.objectContaining({ code: 'IA-LANG-VERSION-UNSUPPORTED', line: 1 }),
    },
  ]);
  expect(at('.ia/src/duplicate.ia')).toEqual([
    expect.objectContaining({
      identity: 'agent-system/policy/mandate/dup',
      word: 'mandate',
      line: 3,
      finding: expect.objectContaining({ code: 'IA-LANG-REQUIREMENT-DUPLICATE', path: '.ia/src/duplicate.ia' }),
    }),
    expect.objectContaining({
      identity: 'compliance-system/contract/signature/clash',
      word: 'contract',
      finding: expect.objectContaining({ code: 'IA-LANG-REQUIREMENT-DUPLICATE', path: '.ia/src/duplicate.ia' }),
    }),
  ]);
  // That file compiles cleanly: only the requirement id it shares with the foundation contract refuses it.
  expect(
    db.report.findings
      .filter((finding) => finding.path === '.ia/src/duplicate.ia' && finding.severity === 'error')
      .map((finding) => finding.code),
  ).toEqual(['IA-LANG-REQUIREMENT-DUPLICATE']);
  expect(at('.ia/src/plain.ia')).toEqual([
    // Its compile refuses the record, so spec 3.1 names the header's identity.
    {
      identity: 'agent-system/binding/agent/plain',
      word: 'agent',
      name: 'plain',
      band: 100,
      path: '.ia/src/plain.ia',
      line: 3,
      endLine: expect.any(Number),
      finding: expect.objectContaining({ code: 'IA-LANG-STRING-UNTERMINATED', line: 6 }),
    },
  ]);
  // The floor and every admitted record stay out of the list.
  expect(unadmitted.some((entry) => entry.identity === methodId)).toBe(false);
  db.close();
});
it('lists a record an adopted base refuses at that base band, 90 (lane D, D15)', () => {
  const root = workspace(false),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  put(resolve(root, vendor), '.ia/src/vendored.ia', mandateSource('vendored', 'moves [Bogus]'));
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  put(root, '.ia/src/authored.ia', mandateSource('authored', 'moves [Bogus]'));
  const db = open(root, { cache: false });
  try {
    expect(db.unadmitted.map((entry) => [entry.identity, entry.band, entry.finding.code])).toEqual([
      ['agent-system/policy/mandate/vendored', 90, 'IA-COMP-FIELD-VALUE'],
      ['agent-system/policy/mandate/authored', 100, 'IA-COMP-FIELD-VALUE'],
    ]);
  } finally {
    db.close();
  }
});
it('lists an occurrence of no known word for every error line of a file refused whole that no identified record accounts for (review D2-R2)', () => {
  const root = workspace();
  const body = '  meaning\n    says "x"\n';
  // A header no reading can name: a space after the at sign, a full-width at sign.
  put(root, '.ia/src/space.ia', `#! ia 1.0\n\n@ mandate spaced\n${body}`);
  put(root, '.ia/src/fullwidth.ia', `#! ia 1.0\n\n${String.fromCharCode(0xff20)}mandate wide\n${body}`);
  // Text in another encoding: UTF-16LE without a byte-order mark decodes, NUL bytes and all, to no pragma.
  put(root, '.ia/src/utf16.ia', Buffer.from(`#! ia 1.0\n\n@mandate sixteen\n${body}`, 'utf16le'));
  // A stray top-level line beside an identified record.
  put(
    root,
    '.ia/src/stray.ia',
    '#! ia 1.0\n\n@agent strayhost\n  meaning\n    says "x"\n    answers "y"\n  governance\n    applies []\n\ngarbage line here\n',
  );
  // An error inside an identified record is that record's: no occurrence of no known word.
  put(root, '.ia/src/inside.ia', '#! ia 1.0\n\n@agent inside\n  meaning\n    says "x\n');
  // An empty file declares nothing, so its missing pragma lists nothing; an error at a blank line is taken at the first
  // non-blank line from there, here a header no reading names, and at a header the reading names lists only that.
  put(root, '.ia/src/empty.ia', '');
  put(root, '.ia/src/late.ia', `\n\n@ mandate late\n${body}`);
  put(root, '.ia/src/headed.ia', `\n\n@agent headed\n`);
  const db = open(root, { cache: false }),
    at = (path: string) => db.unadmitted.filter((entry) => entry.path === path),
    unknown = (path: string) =>
      at(path)
        .filter((entry) => entry.word === undefined)
        .map((entry) => [entry.line, entry.finding.line, entry.name, entry.identity]);
  try {
    for (const path of ['.ia/src/space.ia', '.ia/src/fullwidth.ia']) {
      expect(unknown(path)[0], path).toEqual([3, 3, undefined, undefined]);
      expect(
        at(path).every((entry) => entry.word === undefined),
        path,
      ).toBe(true);
    }
    // Its first line reads as a comment (`#` and NUL bytes); every later line opens with a NUL at column 0 of a file
    // refused at its pragma (review D2 recheck F1, F2).
    expect(unknown('.ia/src/utf16.ia').map(([line]) => line)).toEqual([2, 3, 4, 5, 6]);
    expect(at('.ia/src/utf16.ia')[0]!.finding.code).toBe('IA-LANG-PRAGMA-MISSING');
    expect(at('.ia/src/stray.ia').map((entry) => [entry.word, entry.line])).toEqual([
      ['agent', 3],
      [undefined, 10],
    ]);
    expect(at('.ia/src/inside.ia').map((entry) => [entry.word, entry.identity, entry.line])).toEqual([
      ['agent', 'agent-system/binding/agent/inside', 3],
    ]);
    expect(db.report.findings.filter((finding) => finding.path === '.ia/src/empty.ia').length).toBeGreaterThan(0);
    expect(at('.ia/src/empty.ia')).toEqual([]);
    expect(unknown('.ia/src/late.ia')).toEqual([[3, 1, undefined, undefined]]);
    expect(at('.ia/src/late.ia')[0]!.finding.code).toBe('IA-LANG-PRAGMA-MISSING');
    expect(at('.ia/src/headed.ia').map((entry) => [entry.word, entry.name, entry.line])).toEqual([
      ['agent', 'headed', 3],
    ]);
  } finally {
    db.close();
  }
});
it('lists a record of no word for every unnamed line opening with an at sign, and every unnamed top-level line of a file refused at its pragma, but none for comments (review D2 recheck F1, F2)', () => {
  const root = workspace();
  const wide = String.fromCharCode(0xff20),
    joiner = String.fromCharCode(0x200d),
    agentText = '@agent other\n  meaning\n    says "x"\n',
    body = '  meaning\n    says "x"\n';
  // F1 (a): a file refused at its pragma reports nothing past it, so every top-level line no header reading names is
  // one, as is every line opening with an at sign: after a named first header, a spaced, full-width or joined at sign.
  put(root, '.ia/src/np-space.ia', `${agentText}\n@ mandate extra\n${body}`);
  put(root, '.ia/src/np-wide.ia', `${agentText}\n${wide}mandate extra\n${body}`);
  put(root, '.ia/src/np-joined.ia', `${agentText}\n@${joiner}mandate extra\n${body}`);
  put(root, '.ia/src/np-blank.ia', `\n\n${agentText}\n@ mandate extra\n${body}`);
  put(root, '.ia/src/np-version.ia', `#! ia 9.9\n\n${agentText}\n@ mandate extra\n${body}`);
  put(root, '.ia/src/np-garbage.ia', `${agentText}garbage\n`);
  put(root, '.ia/src/np-clean.ia', agentText);
  // F1 (b): a line opening with an at sign that no reading names is one wherever it stands: indented inside a parsed
  // record, behind a tab, or inside a prose value left open.
  put(root, '.ia/src/in-indented.ia', `#! ia 1.0\n\n${agentText}  @ mandate extra\n    meaning\n`);
  put(root, '.ia/src/in-tab.ia', `#! ia 1.0\n\n${agentText}\t@ mandate extra\n`);
  put(
    root,
    '.ia/src/in-prose.ia',
    `#! ia 1.0\n\n@agent other\n  meaning\n    says """\n\n${wide}mandate extra\n${body}`,
  );
  // F2: a comment declares nothing, so a file of comments alone lists nothing, but a malformed header after one does.
  put(root, '.ia/src/comments.ia', '# notes for later\n');
  put(root, '.ia/src/comments-header.ia', '# notes for later\n@ mandate extra\n');
  const db = open(root, { cache: false }),
    lines = (path: string) =>
      db.unadmitted.filter((entry) => entry.path === path && entry.word === undefined).map((entry) => entry.line);
  try {
    for (const path of ['np-space', 'np-wide', 'np-joined']) expect(lines(`.ia/src/${path}.ia`), path).toEqual([5]);
    expect(lines('.ia/src/np-blank.ia')).toEqual([7]);
    expect(lines('.ia/src/np-version.ia')).toEqual([7]);
    expect(lines('.ia/src/np-garbage.ia')).toEqual([4]);
    expect(lines('.ia/src/np-clean.ia')).toEqual([]);
    expect(db.unadmitted.filter((entry) => entry.path === '.ia/src/np-clean.ia').map((entry) => entry.word)).toEqual([
      'agent',
    ]);
    expect(lines('.ia/src/in-indented.ia')).toEqual([6]);
    expect(lines('.ia/src/in-tab.ia')).toEqual([6]);
    expect(lines('.ia/src/in-prose.ia')).toEqual([7]);
    expect(db.unadmitted.filter((entry) => entry.path === '.ia/src/comments.ia')).toEqual([]);
    expect(lines('.ia/src/comments-header.ia')).toEqual([2]);
  } finally {
    db.close();
  }
});
it('closes idempotently and refuses all subsequent reads and refreshes', () => {
  const db = open(workspace(false), { cache: false });
  db.close();
  db.close();
  for (const read of [
    () => db.snapshot(),
    () => db.records(),
    () => db.get(methodId),
    () => db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }),
    () => db.search('x'),
    () => db.traverse({ start: [] }),
    () => db.refresh(),
    () => db.revision,
    () => db.report,
    () => db.refused,
    () => db.unadmitted,
    () => db.cache,
    () => db.previousRevision,
    () => db.staleness(methodId),
    () => db.readiness(methodId, '0'.repeat(64)),
  ]) {
    expect(read).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
  }
});
