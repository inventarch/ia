import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RecordNode } from '../src/ast.js';
import { buildRegistry, format, parse } from '../src/index.js';
import type { Location } from '../src/index.js';
import * as editor from '../src/editor/index.js';
import { SourceEditError } from '../src/editor/index.js';
import type { SourceEditReason } from '../src/editor/index.js';

// Milestone generation-binding plan amendment C18: schema-aware source edits that change one top-level record of a file.
const schema = {
  sections: [
    { name: 'meaning', must: true },
    { name: 'work', must: true },
  ],
  fields: [
    { section: 'head', key: 'tag', type: 'id' as const, must: false },
    { section: 'meaning', key: 'says', type: 'text' as const, must: true },
    { section: 'work', key: 'status', type: 'id' as const, must: true, values: ['open', 'closed'] },
    { section: 'work', key: 'peers', type: 'list of ref' as const, must: false, target: 'task' },
    { section: 'work', key: 'labels', type: 'list of text' as const, must: false },
    { section: 'work', key: 'milestone', type: 'ref' as const, must: false, target: 'milestone' },
    { section: 'work', key: 'due', type: 'text' as const, must: false, form: 'iso-date' as const },
    { section: 'work', key: 'weight', type: 'number' as const, must: false },
    { section: 'work', key: 'done', type: 'flag' as const, must: false },
    { section: 'work', key: 'system', type: 'qname' as const, must: false },
  ],
};
const source = [
  '#! ia 1.0',
  '',
  '@task one',
  '  meaning',
  '    says "First"',
  '  work',
  '    status open # still open',
  '    peers [@task two]',
  '',
  '# keep this comment',
  '@task two',
  '  meaning',
  '    says "Second"',
  '  work',
  '    status open',
  '    peers [@task one,',
  '      # the first task',
  '      @task three]',
  '  relationships',
  '    requires @task one',
  '',
  '@milestone m1',
  '  meaning',
  '    says "A milestone, last in the file"',
  '',
].join('\n');

/** The record without its spans: a digest that moves only when what the record states moves, as record digests do. */
const stripped = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stripped)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'span')
            .map(([key, item]) => [key, stripped(item)]),
        )
      : value;
const digests = (text: string): ReadonlyMap<string, string> => {
  const parsed = parse(text, 'x.ia');
  expect(parsed.diagnostics).toEqual([]);
  return new Map(
    parsed.ast.records.map((record: RecordNode) => [
      `@${record.discriminator} ${record.name}`,
      createHash('sha256')
        .update(JSON.stringify(stripped(record)))
        .digest('hex'),
    ]),
  );
};
/** The source lines of each top-level record, the comments and blanks before it included. */
const slices = (text: string): ReadonlyMap<string, string> => {
  const lines = text.split('\n'),
    records = parse(text, 'x.ia').ast.records;
  return new Map(
    records.map((record, index) => [
      `@${record.discriminator} ${record.name}`,
      lines.slice(index === 0 ? 0 : records[index - 1]!.span.endLine, record.span.endLine).join('\n'),
    ]),
  );
};
/** Every record but `changed` keeps its digest and its source bytes; `changed` moves (or appears) and nothing vanishes. */
function onlyChanged(before: string, after: string, changed: string): void {
  const [was, now] = [digests(before), digests(after)];
  expect([...now.keys()].filter((key) => now.get(key) !== was.get(key))).toEqual([changed]);
  expect([...was.keys()].filter((key) => !now.has(key))).toEqual([]);
  const [old, next] = [slices(before), slices(after)];
  for (const [key, text] of old) if (key !== changed) expect(next.get(key), key).toBe(text);
  // The result is already formatted: format() is its normalization.
  expect(format(after, 'x.ia').text).toBe(after);
}
const refusedWith = (reason: SourceEditReason, work: () => unknown): void => {
  let error: unknown;
  try {
    work();
  } catch (caught) {
    error = caught;
  }
  expect(error, reason).toBeInstanceOf(SourceEditError);
  expect((error as SourceEditError).reason).toBe(reason);
};

describe('appendRecord', () => {
  it('appends one draft record, keeping the pragma once and every other record byte for byte', () => {
    const draft = editor.draftSource('task', 'three', schema, { 'meaning/says': 'Third', 'work/status': 'open' });
    const result = editor.appendRecord(source, draft);
    expect(result.match(/#! ia/g)).toHaveLength(1);
    expect(parse(result, 'x.ia').ast.records.map((r) => r.name)).toEqual(['one', 'two', 'm1', 'three']);
    expect(result).toContain('# keep this comment');
    expect(result.endsWith('\n@task three\n  meaning\n    says "Third"\n  work\n    status open\n')).toBe(true);
    onlyChanged(source, result, '@task three');
  });
  it('makes an empty file a new file with the draft pragma, and refuses a record the file already declares', () => {
    const draft = editor.draftSource('task', 'one', schema, { 'meaning/says': 'Again', 'work/status': 'open' });
    expect(editor.appendRecord('', draft)).toBe(
      '#! ia 1.0\n\n@task one\n  meaning\n    says "Again"\n  work\n    status open\n',
    );
    refusedWith('duplicate', () => editor.appendRecord(source, draft));
    refusedWith('duplicate', () => editor.appendRecord(source, draft.replace('@task one', '@task ONE')));
    refusedWith('parse', () => editor.appendRecord(source, `${draft}\n@task four\n`));
    refusedWith('parse', () => editor.appendRecord('#! ia 1.0\n@task broken\n  says "unterminated\n', draft));
  });
  it('drafts every value through its field type, so a form value cannot inject syntax', () => {
    expect(() =>
      editor.draftSource('task', 'bad', schema, { 'meaning/says': 'x', 'work/status': 'open when phase act' }),
    ).toThrow(SourceEditError);
    expect(() => editor.draftSource('task', 'bad', schema, { 'meaning/says': 'x', 'work/status': 'open # c' })).toThrow(
      SourceEditError,
    );
    const quoted = editor.draftSource('task', 'ok', schema, {
      'meaning/says': '@task injected\n'.trim() + ' "quoted" \\ # not a comment',
      'work/status': 'closed',
      'work/peers': '[@task one, @task two]',
      'head/tag': 'sample',
    });
    expect(parse(quoted, 'x.ia').diagnostics).toEqual([]);
    expect(quoted).toContain('  tag sample\n');
    expect(quoted).toContain('says "@task injected \\"quoted\\" \\\\ # not a comment"');
    expect(quoted).toContain('peers [@task one, @task two]');
  });
});

describe('addRelationship', () => {
  it('appends a row to the relationships section, or opens one at the record end', () => {
    const opened = editor.addRelationship(source, '@task one', 'requires', '@task two');
    expect(opened).toContain('    peers [@task two]\n  relationships\n    requires @task two\n\n# keep this comment');
    onlyChanged(source, opened, '@task one');
    const appended = editor.addRelationship(source, '@task two', 'runs before', '@milestone m1');
    expect(appended).toContain('  relationships\n    requires @task one\n    runs before @milestone m1\n');
    onlyChanged(source, appended, '@task two');
    // Inverse spellings, canonical identities and fragments are rows too.
    const inverse = editor.addRelationship(source, '@task two', 'required-by', 'work-system/definition/task/one#a/b');
    expect(inverse).toContain('    required-by work-system/definition/task/one#a/b\n');
  });
  it('refuses a duplicate row, an unknown verb, a malformed or injected target and an absent record', () => {
    refusedWith('duplicate', () => editor.addRelationship(source, '@task two', 'requires', '@task one'));
    refusedWith('spelling', () => editor.addRelationship(source, '@task one', 'needs', '@task two'));
    refusedWith('spelling', () => editor.addRelationship(source, '@task one', 'requires\n@task x', '@task two'));
    for (const target of [
      '@task two\n@task injected',
      '@task two # hidden',
      '@task two when phase act',
      '@task two\n  work',
      '@task',
      'two',
      '"@task two"',
    ])
      refusedWith('target', () => editor.addRelationship(source, '@task one', 'requires', target));
    refusedWith('identity', () => editor.addRelationship(source, '@task nine', 'requires', '@task two'));
    refusedWith('identity', () =>
      editor.addRelationship(source, 'work-system/definition/task/one', 'requires', '@task two'),
    );
    refusedWith('identity', () => editor.addRelationship(source, '@milestone one', 'requires', '@task two'));
  });
  it('refuses a record stated twice, a nested record and a file that does not parse', () => {
    refusedWith('repeated', () =>
      editor.addRelationship(
        `${source}\n@task one\n  meaning\n    says "Again"\n`,
        '@task one',
        'requires',
        '@task two',
      ),
    );
    const nested = '#! ia 1.0\n@task outer\n  children\n    @task inner\n      meaning\n        says "x"\n';
    refusedWith('nested', () => editor.addRelationship(nested, '@task inner', 'requires', '@task two'));
    refusedWith('parse', () => editor.addRelationship('@task one\n', '@task one', 'requires', '@task two'));
    const twice = source.replace(
      '  relationships\n    requires @task one\n',
      '  relationships\n    requires @task one\n  relationships\n    uses @task one\n',
    );
    refusedWith('repeated', () => editor.addRelationship(twice, '@task two', 'requires', '@milestone m1'));
  });
});

describe('setField', () => {
  it('replaces a typed value, quoting text and keeping a trailing comment on a one-line field', () => {
    const said = editor.setField(source, '@task one', 'meaning.says', 'A "quote" and \\path', schema);
    expect(said).toContain('    says "A \\"quote\\" and \\\\path"\n');
    onlyChanged(source, said, '@task one');
    const closed = editor.setField(source, '@task one', 'work.status', 'closed', schema);
    expect(closed).toContain('    status closed # still open\n');
    onlyChanged(source, closed, '@task one');
  });
  it('adds an absent field to its section, opens an absent section, and places a head field before the sections', () => {
    const due = editor.setField(source, '@task one', 'work.due', '2026-10-11', schema);
    expect(due).toContain('    peers [@task two]\n    due "2026-10-11"\n');
    onlyChanged(source, due, '@task one');
    const opened = editor.setField(source, '@milestone m1', 'work.status', 'open', schema);
    expect(opened.endsWith('    says "A milestone, last in the file"\n  work\n    status open\n')).toBe(true);
    onlyChanged(source, opened, '@milestone m1');
    const tagged = editor.setField(source, '@task one', 'head.tag', 'sample', schema);
    expect(tagged).toContain('@task one\n  tag sample\n  meaning\n');
    onlyChanged(source, tagged, '@task one');
  });
  it('appends one item to a list, creating the list when absent, and refuses a duplicate item', () => {
    const appended = editor.setField(source, '@task one', 'work.peers', '@task three', schema, true);
    expect(appended).toContain('    peers [@task two, @task three]\n');
    onlyChanged(source, appended, '@task one');
    const created = editor.setField(source, '@task one', 'work.labels', 'first label', schema, true);
    expect(created).toContain('    labels ["first label"]\n');
    const again = editor.setField(created, '@task one', 'work.labels', 'second', schema, true);
    expect(again).toContain('    labels ["first label", "second"]\n');
    refusedWith('duplicate', () => editor.setField(appended, '@task one', 'work.peers', '@task three', schema, true));
    refusedWith('duplicate', () => editor.setField(source, '@task one', 'work.peers', '[@task a, @task a]', schema));
    // A whole list replaces the value; a scalar append and a non-list replace are refused.
    expect(editor.setField(source, '@task one', 'work.peers', '[@task a, @task b]', schema)).toContain(
      '    peers [@task a, @task b]\n',
    );
    refusedWith('value', () => editor.setField(source, '@task one', 'work.status', 'closed', schema, true));
    refusedWith('value', () => editor.setField(source, '@task one', 'work.peers', '@task a', schema));
  });
  it('refuses a value of another type, an undeclared field and every value that would carry syntax', () => {
    for (const [path, value] of [
      ['work.status', 'alien'],
      ['work.status', '"alien"'],
      ['work.status', '"open closed"'],
      ['work.status', 'is open'],
      ['work.status', 'open closed'],
      ['work.status', 'open # hidden'],
      ['work.status', 'open when phase act'],
      ['work.status', 'open\n  relationships\n    requires @task two'],
      ['work.status', 'open\n@task injected'],
      ['work.status', ''],
      ['work.milestone', '@task two'],
      ['work.milestone', '@milestone m1 extra'],
      ['work.milestone', 'm1'],
      ['work.peers', '[@task two, @agent wrong]'],
      ['work.peers', '[@task two] # c'],
      ['work.due', '2026-02-30'],
      ['work.due', 'tomorrow'],
      ['work.weight', 'heavy'],
      ['work.weight', '1 2'],
      ['work.done', 'yes'],
      ['work.system', 'work-system/task'],
      ['work.system', 'a/notakind/b/c'],
      ['meaning.says', 'line one\nline two'],
      ['meaning.says', 'carriage\rreturn'],
      ['meaning.says', 'separator\u2028here'],
      // C1 controls (NEL, CSI) and bidirectional overrides and isolates (C-R3).
      ['meaning.says', `next${String.fromCharCode(0x85)}line`],
      ['meaning.says', `csi${String.fromCharCode(0x9b)}2J`],
      ['meaning.says', `override${String.fromCharCode(0x202e)}txt`],
      ['meaning.says', `isolate${String.fromCharCode(0x2066)}here`],
    ] as const)
      refusedWith('value', () => editor.setField(source, '@task one', path, value, schema));
    refusedWith('field', () => editor.setField(source, '@task one', 'work.foreign', 'x', schema));
    refusedWith('field', () => editor.setField(source, '@task one', 'status', 'open', schema));
    // The accepted spellings of each remaining type.
    expect(editor.setField(source, '@task one', 'work.weight', '-1.5e3', schema)).toContain('    weight -1.5e3\n');
    // An id, qname or number may be quoted, as compliance admits, and is spelled bare.
    expect(editor.setField(source, '@task one', 'work.status', '"closed"', schema)).toContain(
      '    status closed # still open\n',
    );
    expect(editor.setField(source, '@task one', 'work.weight', '"2"', schema)).toContain('    weight 2\n');
    expect(editor.setField(source, '@task one', 'work.done', 'true', schema)).toContain('    done true\n');
    expect(editor.setField(source, '@task one', 'work.system', 'work-system/definition/task/one', schema)).toContain(
      '    system work-system/definition/task/one\n',
    );
    expect(editor.setField(source, '@task one', 'work.milestone', '@milestone M1', schema)).toContain(
      '    milestone @milestone M1\n',
    );
    expect(editor.setField(source, '@task one', 'meaning.says', 'tab\there', schema)).toContain('says "tab\there"');
  });
  it('refuses a repeated field or section, a conditional field and a comment inside a multi-line value', () => {
    refusedWith('repeated', () =>
      editor.setField(
        source.replace('status open #', 'status open\n    status closed #'),
        '@task one',
        'work.status',
        'open',
        schema,
      ),
    );
    refusedWith('repeated', () =>
      editor.setField(
        `${source}  work\n    status open\n  work\n    status closed\n`,
        '@milestone m1',
        'work.status',
        'open',
        schema,
      ),
    );
    refusedWith('structure', () =>
      editor.setField(
        source.replace('status open #', 'status closed when phase act #'),
        '@task one',
        'work.status',
        'open',
        schema,
      ),
    );
    refusedWith('structure', () => editor.setField(source, '@task two', 'work.peers', '[@task one]', schema));
    refusedWith('structure', () => editor.setField(source, '@task two', 'work.peers', '@task four', schema, true));
    // Without a comment, a multi-line list is replaced by one line, and every other record keeps its bytes.
    const plain = source.replace('      # the first task\n', '');
    const replaced = editor.setField(plain, '@task two', 'work.peers', '[@task one]', schema);
    expect(replaced).toContain('    status open\n    peers [@task one]\n  relationships\n');
    onlyChanged(plain, replaced, '@task two');
  });
});

describe('annotateRecord', () => {
  it('puts one comment above the record, replacing one with the same first word, and moves no digest', () => {
    const line = '# authored-by @agent demo under @mandate demo-mandate at abc';
    const once = editor.annotateRecord(source, '@task two', line);
    expect(once).toContain(`# keep this comment\n${line}\n@task two\n`);
    expect(digests(once)).toEqual(digests(source));
    expect(format(once, 'x.ia').text).toBe(once);
    // A second attribution replaces the first; another comment above stays where it is.
    const twice = editor.annotateRecord(once, '@task two', '# authored-by @agent ops under @mandate ops at def');
    expect(twice).toContain('# keep this comment\n# authored-by @agent ops under @mandate ops at def\n@task two\n');
    expect(twice).not.toContain(line);
    const first = editor.annotateRecord(source, '@task one', line);
    expect(first.startsWith(`#! ia 1.0\n\n${line}\n@task one\n`)).toBe(true);
    expect(slices(first).get('@task two')).toBe(slices(source).get('@task two'));
    for (const bad of ['authored-by x', '# ', '# two\n# lines', '# bell\u0007'])
      refusedWith('value', () => editor.annotateRecord(source, '@task one', bad));
    refusedWith('identity', () => editor.annotateRecord(source, '@task nine', line));
  });
});

describe('the bytes of everything but the edited record (review C-R8)', () => {
  const crlf = source.replaceAll('\n', '\r\n'),
    bom = String.fromCharCode(0xfeff);
  const edits: readonly (readonly [string, (text: string) => string])[] = [
    ['setField', (text) => editor.setField(text, '@task two', 'work.status', 'closed', schema)],
    ['addRelationship', (text) => editor.addRelationship(text, '@task one', 'requires', '@task two')],
    [
      'appendRecord',
      (text) =>
        editor.appendRecord(
          text,
          editor.draftSource('task', 'three', schema, { 'meaning/says': 'Third', 'work/status': 'open' }),
        ),
    ],
    [
      'annotateRecord',
      (text) => editor.annotateRecord(text, '@task two', '# authored-by @agent demo under @mandate m at abc'),
    ],
  ];
  it('keeps CRLF line endings, the edited record taking them too', () => {
    for (const [name, edit] of edits) {
      const out = edit(crlf);
      expect(out, name).toBe(edit(source).replaceAll('\n', '\r\n'));
      expect(/[^\r]\n/.test(out), name).toBe(false);
    }
  });
  it('keeps a byte-order mark', () => {
    for (const [name, edit] of edits) expect(edit(`${bom}${source}`), name).toBe(`${bom}${edit(source)}`);
  });
  it("leaves another record's non-canonical spacing as it is, formatting only the edited record", () => {
    const odd = source
      .replace('    says "First"', '    says   "First"   ')
      .replace('  meaning\n    says "Second"', '  meaning   \n    says    "Second"');
    const out = editor.setField(odd, '@task two', 'work.status', 'closed', schema);
    const head = odd.slice(0, odd.indexOf('@task two'));
    expect(out.startsWith(head)).toBe(true);
    expect(out).toContain('@task two\n  meaning\n    says "Second"\n  work\n    status closed\n');
    // A record that is not edited keeps its bytes even when the edit appends after it.
    const appended = edits[2]![1](odd);
    expect(appended.startsWith(odd)).toBe(true);
  });
  it("keeps the old last line's own ending in a file of mixed endings (review C-RC3)", () => {
    // CRLF for every line but the last, which ends LF: the file's bytes stay a prefix, new lines take CRLF.
    const lines = source.replace(/\n$/, '').split('\n');
    const mixed = `${lines.join('\r\n')}\n`;
    const appended = edits[2]![1](mixed);
    expect(appended.startsWith(mixed)).toBe(true);
    expect(appended.slice(mixed.length)).toBe(
      '\r\n@task three\r\n  meaning\r\n    says "Third"\r\n  work\r\n    status open\r\n',
    );
  });
  it.each(edits)('preserves mixed LF/CRLF sibling bytes through %s (L6-03)', (name, edit) => {
    // Alternate every physical ending, including comments and blanks. Exercise either first ending, a BOM,
    // noncanonical sibling spacing and an unterminated last record; no whole-file formatter is an oracle here.
    const odd = source.replace('says "First"', 'says   "First"   ').replace('says "Second"', 'says    "Second"');
    for (const first of ['\n', '\r\n']) {
      for (const finalEnding of [true, false]) {
        let line = 0;
        const mixed = `${bom}${odd.replace(/\n/g, () => (line++ % 2 === 0 ? first : first === '\n' ? '\r\n' : '\n'))}`;
        const input = finalEnding ? mixed : mixed.replace(/\r?\n$/, '');
        const output = edit(input);
        expect(parse(output, 'x.ia').diagnostics).toEqual([]);
        const changed = name === 'addRelationship' ? '@task one' : '@task two';
        const bounds = (text: string) => {
          const pieces = text.match(/[^\n]*\n|[^\n]+$/g)!;
          const record = parse(text, 'x.ia').ast.records.find(
            (row) => `@${row.discriminator} ${row.name}` === changed,
          )!;
          return {
            before: pieces.slice(0, record.span.line - 1).join(''),
            after: pieces.slice(record.span.endLine).join(''),
          };
        };
        if (name === 'appendRecord') {
          expect(Buffer.from(output.slice(0, input.length))).toEqual(Buffer.from(input));
          expect([...digests(output).keys()]).toEqual([...digests(input).keys(), '@task three']);
        } else if (name === 'annotateRecord') {
          const added = `# authored-by @agent demo under @mandate m at abc${first}`;
          expect(output).toContain(added);
          expect(Buffer.from(output.replace(added, ''))).toEqual(Buffer.from(input));
          expect(digests(output)).toEqual(digests(input));
        } else {
          expect(Buffer.from(bounds(output).before)).toEqual(Buffer.from(bounds(input).before));
          expect(Buffer.from(bounds(output).after)).toEqual(Buffer.from(bounds(input).after));
          const was = digests(input),
            now = digests(output);
          expect([...now.keys()].filter((key) => now.get(key) !== was.get(key))).toEqual([changed]);
          expect([...now.keys()]).toEqual([...was.keys()]);
        }
      }
    }
  });
  it('gives a last line with no ending one before appending, and keeps it absent on an edit at the end', () => {
    const open = source.replace(/\n$/, '');
    const appended = edits[2]![1](open);
    expect(appended.startsWith(`${open}\n\n@task three\n`)).toBe(true);
    expect(appended.endsWith('\n')).toBe(true);
    const set = editor.setField(open, '@milestone m1', 'meaning.says', 'Still last', schema);
    expect(set.endsWith('    says "Still last"')).toBe(true);
    expect(set.slice(0, set.indexOf('@milestone m1'))).toBe(open.slice(0, open.indexOf('@milestone m1')));
  });
});

describe('relationshipConsent', () => {
  const AUTHORED: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  const system = `#! ia 1.0
@system plans
  provider "fixture"
  version "1.0.0"
  discriminators
    task lowers to definition
      category process
      facets [task]
      schema @schema task
    note lowers to definition
      category process
      facets [note]
      schema @schema note
  edges
    require task using task
    cite note using task
@schema task
  lowers to definition
  sections
    open
@schema note
  lowers to definition
  sections
    open
`;
  const { registry, diagnostics } = buildRegistry([{ ...parse(system, 'plans.ia'), location: AUTHORED }]);
  it('judges the edge as admission does, inverse spellings included, naming the refusing system', () => {
    expect(diagnostics).toEqual([]);
    expect(editor.relationshipConsent(registry, 'task', 'requires', 'task')).toEqual({
      predicate: 'require',
      direction: 'out',
      from: 'task',
      to: 'task',
    });
    expect(editor.relationshipConsent(registry, 'task', 'cites', 'note').refused).toBeUndefined();
    expect(editor.relationshipConsent(registry, 'task', 'requires', 'note')).toEqual({
      predicate: 'require',
      direction: 'out',
      from: 'task',
      to: 'note',
      refused: { side: 'source', system: 'plans' },
    });
    // `required-by` turns the row round: note -> task, which no row admits.
    expect(editor.relationshipConsent(registry, 'task', 'required-by', 'note')).toMatchObject({
      direction: 'in',
      from: 'note',
      to: 'task',
      refused: { side: 'source', system: 'plans' },
    });
    // An unregistered word is refused by admission on its own, not here.
    expect(editor.relationshipConsent(registry, 'task', 'requires', 'ghost').refused).toBeUndefined();
    refusedWith('spelling', () => editor.relationshipConsent(registry, 'task', 'needs', 'task'));
  });
});
