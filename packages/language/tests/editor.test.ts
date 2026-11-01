import { describe, expect, it } from 'vitest';
import { parse, references, scan } from '../src/index.js';
import { cursorContext, draftSource, projectSource, SourceEditError } from '../src/editor/index.js';

describe('editor source projection', () => {
  it('projects a list of many references in time that grows with it', () => {
    const count = 60_000,
      source = `#! ia 1.0\n@playbook sample\n  peers [${'@agent a, '.repeat(count)}@agent b]\n`,
      { references } = projectSource(source, 'sample.ia');
    expect(references).toHaveLength(count + 1);
    expect(references.at(-1)).toMatchObject({ reference: { name: 'b' }, range: { start: { line: 2 } } });
    expect(references[1]!.range.start.character).toBe(references[0]!.range.start.character + 10);
  });
  it('projects a reference spread over the lines of a multi-line list, each at its own line', () => {
    const source =
        '#! ia 1.0\n@playbook sample\n  peers [\n    @agent a,\n    @agent b,\n    @agent c\n  ]\n  other @agent d\n',
      { references } = projectSource(source, 'sample.ia');
    expect(references.map((use) => [(use.reference as { name: string }).name, use.range.start.line])).toEqual([
      ['a', 3],
      ['b', 4],
      ['c', 5],
      ['d', 7],
    ]);
  });
  it('finds an identity reference among many on a line', () => {
    const count = 5_000,
      identity = 'agent-system/binding/head/x',
      source = `#! ia 1.0\n@playbook sample\n  relationships\n${`    cites ${identity}\n`.repeat(count)}`,
      { references } = projectSource(source, 'sample.ia');
    expect(references).toHaveLength(count);
    expect(references.at(-1)!.range.start.line).toBe(count + 2);
  });
  it('finds a reference on a line of more tokens than one call can take as arguments', () => {
    const items = Array.from({ length: 150_000 }, () => 'w').join(', ');
    const source = `#! ia 1.0\n@playbook sample\n  peers [${items}, @agent Alpha]\n`;
    const { references } = projectSource(source, 'sample.ia');
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ reference: { name: 'Alpha' } });
  });
  it('serializes schema-backed text without changing quotes, backslashes, tabs or Unicode', () => {
    const schema = {
      sections: [{ name: 'meaning', must: true }],
      fields: [{ section: 'meaning', key: 'says', type: 'text' as const, must: true }],
    };
    const value = 'A "quoted" C:\\file\t😀';
    const source = draftSource('playbook', 'test', schema, { 'meaning/says': value });
    const parsed = parse(source, 'draft.ia');
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.ast.records[0]?.sections[0]?.children[0]).toMatchObject({ value: { kind: 'string', text: value } });
    expect(() => draftSource('playbook', 'test', schema, { 'meaning/says': 'first\nsecond' })).toThrow('single-line');
    expect(() => draftSource('playbook', 'test', schema, { 'meaning/foreign': 'x' })).toThrow('undeclared');
    const headed = draftSource(
      'playbook',
      'headed',
      { ...schema, fields: [...schema.fields, { section: 'head', key: 'tag', type: 'id', must: true }] },
      { 'meaning/says': value, 'head/tag': 'sample' },
    );
    expect(parse(headed, 'head.ia').ast.records[0]?.head[0]).toMatchObject({ key: 'tag' });
  });
  it('enumerates typed head/list/relationship uses, preserving multiple occurrences and ignoring prose', () => {
    const source =
      '#! ia 1.0\n@playbook sample\n  title "😀 @agent fake"\n  peers [@agent Alpha, @agent Beta, @agent Alpha]\n  relationships\n    use agent-system/binding/agent/alpha\n  body\n    text """@agent fake"""\n';
    const result = projectSource(source, 'sample.ia');
    expect(result.references).toHaveLength(4);
    expect(references(parse(source, 'sample.ia').ast).map((r) => r.use)).toEqual([
      'value',
      'value',
      'value',
      'relationship',
    ]);
    const lines = source.split('\n');
    expect(
      result.references.map((r) => lines[r.range.start.line]!.slice(r.range.start.character, r.range.end.character)),
    ).toEqual(['@agent Alpha', '@agent Beta', '@agent Alpha', 'agent-system/binding/agent/alpha']);
  });
  it('keeps physical lines through list comments and blanks, with BOM/CRLF and astral characters', () => {
    const source =
      '\uFEFF#! ia 1.0\r\n@playbook sample\r\n  peers ["😀",\r\n    # comment\r\n\r\n      @agent Alpha,\r\n    @agent Beta]\r\n';
    const projected = projectSource(source, 'sample.ia');
    expect(projected.references.map((r) => r.range)).toEqual([
      { start: { line: 5, character: 6 }, end: { line: 5, character: 18 } },
      { start: { line: 6, character: 4 }, end: { line: 6, character: 15 } },
    ]);
    expect(
      scan(source, 'sample.ia')
        .tokens.filter((t) => t.kind === 'sigil')
        .map((t) => t.line),
    ).toEqual([2, 6, 7]);
  });
  it('retains the innermost record as the reference owner', () => {
    const ast = parse(
      '#! ia 1.0\n@playbook parent\n  children\n    @playbook child\n      peer @agent Alpha\n',
      'x.ia',
    ).ast;
    expect(references(ast)[0]?.record.name).toBe('child');
  });
  it('recovers partial references and refuses suggestions in prose, strings, comments and unsupported versions', () => {
    const base = '#! ia 1.0\n@playbook sample\n  relationships\n    use @ag';
    expect(cursorContext(base, 'x.ia', { line: 3, character: 11 }).slot).toBe('reference');
    expect(cursorContext(base, 'x.ia', { line: 3, character: 11 }).discriminator).toBe('ag');
    for (const suffix of ['    text "hello @ag', '    text """hello\n    @ag', '    # @ag']) {
      const source = '#! ia 1.0\n@playbook sample\n  body\n' + suffix,
        lines = source.split('\n');
      expect(cursorContext(source, 'x.ia', { line: lines.length - 1, character: lines.at(-1)!.length }).slot).toBe(
        'none',
      );
    }
    expect(cursorContext('#! ia 9.0\n@ag', 'x.ia', { line: 1, character: 3 }).slot).toBe('none');
  });
});

/**
 * 2.0.0's `draftSource` (6239cbc), reproduced to pin what it wrote: text quoted, every other type written as given.
 * The 2.0.0 function admitted no line break and nothing else.
 */
function draftSource200(
  discriminator: string,
  name: string,
  schema: {
    readonly sections: readonly { readonly name: string; readonly must: boolean }[];
    readonly fields: readonly { readonly section: string; readonly key: string; readonly type: string }[];
  },
  values: Readonly<Record<string, string>>,
): string {
  const sections = new Map<string, string[]>();
  for (const section of schema.sections) if (section.must) sections.set(section.name, []);
  for (const field of schema.fields) {
    const value = values[`${field.section}/${field.key}`];
    if (value === undefined) continue;
    const encoded = field.type === 'text' ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value;
    const rows = sections.get(field.section) ?? [];
    rows.push(`${field.key} ${encoded}`);
    sections.set(field.section, rows);
  }
  return (
    `#! ia 1.0\n\n@${discriminator} ${name}\n` +
    [...sections]
      .sort(([a], [b]) => (a === 'head' ? -1 : b === 'head' ? 1 : 0))
      .map(([section, rows]) =>
        section === '' || section === 'head'
          ? rows.map((r) => `  ${r}\n`).join('')
          : `  ${section}\n${rows.map((r) => `    ${r}\n`).join('')}`,
      )
      .join('')
  );
}

describe('draftSource keeps 2.0.0 spelling', () => {
  const schema = {
    sections: [
      { name: 'meaning', must: true },
      { name: 'work', must: true },
    ],
    fields: [
      { section: 'meaning', key: 'says', type: 'text' as const, must: true },
      { section: 'work', key: 'due', type: 'text' as const, must: false, form: 'iso-date' as const },
      { section: 'work', key: 'status', type: 'id' as const, must: false, values: ['open', 'closed'] },
      { section: 'work', key: 'milestone', type: 'ref' as const, must: false, target: 'milestone' },
      { section: 'work', key: 'peers', type: 'list of ref' as const, must: false, target: 'task' },
      { section: 'work', key: 'done', type: 'flag' as const, must: false },
      { section: 'work', key: 'weight', type: 'number' as const, must: false },
    ],
  };
  const char = (code: number) => String.fromCharCode(code);
  it('writes every value 2.0.0 wrote, as 2.0.0 wrote it', () => {
    for (const values of [
      { 'meaning/says': `separator${char(0x2028)}here` },
      { 'meaning/says': `vertical${char(0x0b)}tab` },
      { 'meaning/says': `nul${char(0)}byte` },
      { 'meaning/says': `escape${char(0x1b)}[2J` },
      { 'meaning/says': 'A "quoted" C:\\file\t' },
      { 'meaning/says': 'x', 'work/due': 'tomorrow' },
      { 'meaning/says': 'x', 'work/status': 'alien' },
      { 'meaning/says': 'x', 'work/status': 'is open' },
      { 'meaning/says': 'x', 'work/milestone': '@task elsewhere' },
      { 'meaning/says': 'x', 'work/peers': '@task bare' },
      { 'meaning/says': 'x', 'work/done': 'yes' },
      { 'meaning/says': 'x', 'work/weight': '1e400' },
    ])
      expect(draftSource('task', 'kept', schema, values), JSON.stringify(values)).toBe(
        draftSource200('task', 'kept', schema, values),
      );
  });
  it('refuses only a value that would add a condition, a comment or a line', () => {
    for (const value of ['open when phase act', 'open # hidden', '[@task a] # c'])
      expect(() =>
        draftSource('task', 'bad', schema, { 'meaning/says': 'x', 'work/status': value, 'work/peers': '[@task a]' }),
      ).toThrow(SourceEditError);
    expect(() => draftSource('task', 'bad', schema, { 'meaning/says': 'first\nsecond' })).toThrow('single-line');
    expect(() => draftSource('task', 'bad', schema, { 'meaning/says': 'x', 'work/status': 'open\rclosed' })).toThrow(
      'single-line',
    );
    // A line break throws a plain Error, as 2.0.0 did; only structure from a condition or comment is SourceEditError.
    expect(() => draftSource('task', 'bad', schema, { 'meaning/says': 'first\nsecond' })).not.toThrow(SourceEditError);
  });
  it('refuses a value that opens a string, prose or list it does not close', () => {
    // Across two values, an opener and a closer would swallow the rows between them and add a comment.
    expect(() =>
      draftSource('task', 'bad', schema, {
        'meaning/says': 'x',
        'work/status': '"""',
        'work/peers': '""" # injected',
      }),
    ).toThrow(SourceEditError);
    for (const value of ['"""', '"open', '[@task a', '[@task a, "b'])
      expect(() => draftSource('task', 'bad', schema, { 'meaning/says': 'x', 'work/peers': value }), value).toThrow(
        SourceEditError,
      );
  });
});
