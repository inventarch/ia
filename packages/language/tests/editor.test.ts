import { describe, expect, it } from 'vitest';
import { parse, references, scan } from '../src/index.js';
import { cursorContext, draftSource, projectSource } from '../src/editor/index.js';

describe('editor source projection', () => {
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
