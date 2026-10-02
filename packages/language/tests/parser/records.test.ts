import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';

const at = (src: string) => parse(src, 'a.ia').diagnostics.map((d) => [d.code, d.line]);

describe('parse: records', () => {
  it('parses a header, head fields, sections and spans', () => {
    const r = parse(
      '#! ia 1.0\n@system agent-system\n  provider "agent-system"\n  version "0.1.0"\n  meaning\n    says "x"\n',
      'a.ia',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.ast.version).toBe('1.0');
    const rec = r.ast.records[0]!;
    expect(rec.discriminator).toBe('system');
    expect(rec.name).toBe('agent-system');
    expect(rec.head.map((f) => f.key)).toEqual(['provider', 'version']);
    expect(rec.sections.map((s) => s.name)).toEqual(['meaning']);
    expect(rec.span).toEqual({ line: 2, endLine: 6 });
  });

  it('keeps the authored name spelling', () => {
    const r = parse('#! ia 1.0\n@primitive Memory\n', 'a.ia');
    expect(r.ast.records[0]?.name).toBe('Memory');
  });

  it('parses a record with no body and a section with no children', () => {
    const r = parse('#! ia 1.0\n@law x\n@law y\n  meaning\n', 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.ast.records[0]).toMatchObject({
      name: 'x',
      head: [],
      sections: [],
      nested: [],
      span: { line: 2, endLine: 2 },
    });
    expect(r.ast.records[1]?.sections[0]).toMatchObject({
      name: 'meaning',
      children: [],
      span: { line: 4, endLine: 4 },
    });
  });

  it("keeps two sections with the same name; admissibility is the schema's decision", () => {
    const r = parse('#! ia 1.0\n@law x\n  meaning\n    says "a"\n  meaning\n    says "b"\n', 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.ast.records[0]?.sections.map((s) => s.name)).toEqual(['meaning', 'meaning']);
  });

  it('refuses a malformed header and names what it found', () => {
    expect(at('#! ia 1.0\n@law\n')).toEqual([['IA-LANG-HEADER-MALFORMED', 2]]);
    expect(at('#! ia 1.0\n@law bad name\n')).toEqual([['IA-LANG-HEADER-MALFORMED', 2]]);
    expect(at('#! ia 1.0\n@Law x\n')).toEqual([['IA-LANG-HEADER-MALFORMED', 2]]);
    expect(at('#! ia 1.0\n@law x#frag\n')).toEqual([['IA-LANG-HEADER-MALFORMED', 2]]);
    expect(parse('#! ia 1.0\n@law bad name\n', 'a.ia').diagnostics[0]?.message).toContain("'name'");
  });

  it('refuses a non-header at top level once, with its block, and continues', () => {
    const r = parse('#! ia 1.0\nmeaning\n  says "a"\n@law x\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-TOPLEVEL-UNEXPECTED', 2]]);
    expect(r.ast.records).toHaveLength(1);
  });

  it('refuses a head field after a section', () => {
    expect(at('#! ia 1.0\n@law x\n  meaning\n    says "a"\n  version "1"\n')).toEqual([
      ['IA-LANG-HEAD-FIELD-AFTER-SECTION', 5],
    ]);
  });

  it('refuses an unsupported version and reports nothing else', () => {
    const r = parse('#! ia 9.9\n\t@law x\n  says "open\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-VERSION-UNSUPPORTED', 1]]);
    expect(r.ast.records).toEqual([]);
  });

  it('refuses a missing pragma and reports nothing else', () => {
    const r = parse('@law x\n  says "open\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-PRAGMA-MISSING', 1]]);
    expect(r.ast.records).toEqual([]);
    expect(r.ast.version).toBe('');
  });

  it('refuses lines indented under something that cannot hold children, once per block', () => {
    const r = parse('#! ia 1.0\n@law x\n  requires\n    - a\n      deeper "x"\n      deeper "y"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-INDENT-STEP', 5]]);
    const top = parse('#! ia 1.0\n  meaning\n    says "a"\n@law x\n', 'a.ia');
    expect(top.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-TOPLEVEL-UNEXPECTED', 2]]);
    expect(top.ast.records).toHaveLength(1);
    const header = parse(
      '#! ia 1.0\n@law x\n    meaning\n    other\n      deeper "z"\n  meaning\n    says "a"\n',
      'a.ia',
    );
    expect(header.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-INDENT-STEP', 3]]);
    expect(header.ast.records[0]?.sections.map((s) => s.name)).toEqual(['meaning']);
    const block = parse(
      '#! ia 1.0\n@law x\n  meaning\n    says "a"\n        deep "b"\n        deeper "c"\n    next "n"\n',
      'a.ia',
    );
    expect(block.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-INDENT-STEP', 5]]);
    expect(block.ast.records[0]?.sections[0]?.children.map((c) => (c.kind === 'field' ? c.key : c.kind))).toEqual([
      'says',
      'next',
    ]);
  });

  it('refuses an item or a nested record directly under a header', () => {
    expect(at('#! ia 1.0\n@law x\n  - a\n    deeper "x"\n  meaning\n')).toEqual([['IA-LANG-LIST-MALFORMED', 3]]);
    const r = parse('#! ia 1.0\n@law x\n  @law y\n    meaning\n      says "s"\n  meaning\n    says "t"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-HEADER-MALFORMED', 3]]);
    expect(r.ast.records[0]?.nested).toEqual([]);
    expect(r.ast.records[0]?.sections.map((s) => s.name)).toEqual(['meaning']);
  });

  it('skips the block beneath any refused line without judging it, and reports one diagnostic', () => {
    const header = parse('#! ia 1.0\n@law\n  meaning\n    says "a" extra\n@law b\n  meaning\n    says "b"\n', 'a.ia');
    expect(header.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-HEADER-MALFORMED', 2]]);
    expect(header.ast.records.map((r) => r.name)).toEqual(['b']);
    const keyless = parse(
      '#! ia 1.0\n@law x\n  meaning\n    "foo"\n      @law inner\n        meaning\n          says "i"\n    next "n"\n',
      'a.ia',
    );
    expect(keyless.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-FIELD-KEY-MISSING', 4]]);
    expect(keyless.ast.records[0]?.nested).toEqual([]);
    expect(keyless.ast.records[0]?.sections[0]?.children.map((c) => (c.kind === 'field' ? c.key : c.kind))).toEqual([
      'next',
    ]);
    const late = parse('#! ia 1.0\n@law x\n  meaning\n    says "a"\n  version "1"\n    child "c"\n', 'a.ia');
    expect(late.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-HEAD-FIELD-AFTER-SECTION', 5]]);
    expect(late.ast.records[0]?.span).toEqual({ line: 2, endLine: 4 });
  });

  it('reports one diagnostic when the scanner refuses a line that has a block beneath it', () => {
    const cases: [string, string][] = [
      [
        '#! ia 1.0\n@law x\n  meaning\n    says "open\n      because "why"\n    next "n"\n',
        'IA-LANG-STRING-UNTERMINATED',
      ],
      ['#! ia 1.0\n@law x\n  meaning\n\tsays "a"\n      because "why"\n    next "n"\n', 'IA-LANG-INDENT-TAB'],
      ['#! ia 1.0\n@law x\n  meaning\n     says "a"\n      because "why"\n    next "n"\n', 'IA-LANG-INDENT-STEP'],
      [
        '#! ia 1.0\n@law x\n  meaning\n    says """p""" junk\n      because "why"\n    next "n"\n',
        'IA-LANG-PROSE-TRAILING',
      ],
    ];
    for (const [source, code] of cases) {
      const r = parse(source, 'a.ia');
      expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([[code, 4]]);
      expect(r.ast.records[0]?.sections[0]?.children.map((c) => (c.kind === 'field' ? c.key : c.kind))).toEqual([
        'next',
      ]);
    }
  });

  it('reports diagnostics in line order when the scanner and the parser both refuse', () => {
    const r = parse('#! ia 1.0\n@law x\n  meaning\n    "keyless"\n    says "open\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-FIELD-KEY-MISSING', 4],
      ['IA-LANG-STRING-UNTERMINATED', 5],
    ]);
  });

  it('refuses each stray line before the first record on its own, consuming only its block', () => {
    const r = parse('#! ia 1.0\n  meaning\n    says "a"\n  other\n@law x\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-TOPLEVEL-UNEXPECTED', 2],
      ['IA-LANG-TOPLEVEL-UNEXPECTED', 4],
    ]);
    expect(r.ast.records.map((x) => x.name)).toEqual(['x']);
  });

  it('refuses a key-less line after a section for its missing key, once', () => {
    const r = parse('#! ia 1.0\n@law x\n  meaning\n    says "a"\n  "foo" extra\n    child "c"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-FIELD-KEY-MISSING', 5]]);
    expect(r.ast.records[0]?.span).toEqual({ line: 2, endLine: 4 });
  });

  it('drops a value with no key after refusing it', () => {
    const r = parse('#! ia 1.0\n@law x\n  "foo"\n  meaning\n    [a]\n    says "s"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-FIELD-KEY-MISSING', 3],
      ['IA-LANG-FIELD-KEY-MISSING', 5],
    ]);
    expect(r.ast.records[0]?.head).toEqual([]);
    expect(r.ast.records[0]?.sections[0]?.children.map((c) => (c.kind === 'field' ? c.key : c.kind))).toEqual(['says']);
  });

  it('parses a nested record inside a section with its own span', () => {
    const r = parse(
      '#! ia 1.0\n@law x\n  variants\n    @law x-strict\n      meaning\n        says "s"\n  lifecycle\n    state active\n',
      'a.ia',
    );
    const nested = r.ast.records[0]?.sections[0]?.children[0];
    expect(nested?.kind).toBe('record');
    expect(nested?.kind === 'record' && nested.name).toBe('x-strict');
    expect(nested?.span).toEqual({ line: 4, endLine: 6 });
    expect(r.ast.records[0]?.nested.map((n) => n.name)).toEqual(['x-strict']);
    expect(r.ast.records[0]?.span).toEqual({ line: 2, endLine: 8 });
  });

  it('keeps a real value on a field that opens a block, and marks a bare key with children as a block', () => {
    const r = parse(
      '#! ia 1.0\n@law x\n  governance\n    requires "b"\n      when severity is blocking\n    cognition\n      orient\n        primary Memory\n',
      'a.ia',
    );
    const gov = r.ast.records[0]?.sections[0];
    expect(gov?.children[0]).toMatchObject({ key: 'requires', value: { kind: 'string', text: 'b' } });
    expect(gov?.children[1]).toMatchObject({ key: 'cognition', value: { kind: 'block' } });
    const refused = parse(
      '#! ia 1.0\n@law x\n  relationships\n    uses @Playbook p\n      when phase is act\n',
      'a.ia',
    );
    expect(refused.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(refused.ast.records[0]?.sections[0]?.children[0]).toMatchObject({ key: 'uses', value: { kind: 'none' } });
  });
});
