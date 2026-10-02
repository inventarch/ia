import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';

describe('parse: fields', () => {
  it('parses fields, blocks and items', () => {
    const src = [
      '#! ia 1.0',
      '@system s',
      '  requires',
      '    - taxonomy',
      '    - "agent system"',
      '  discriminators',
      '    agent lowers to binding',
      '      category capability',
      '      facets [head]',
      '      schema @schema agent',
      '',
    ].join('\n');
    const r = parse(src, 'a.ia');
    expect(r.diagnostics).toEqual([]);
    const [requires, discriminators] = r.ast.records[0]!.sections;
    expect(requires?.children.map((c) => c.kind)).toEqual(['item', 'item']);
    expect(requires?.children[0]).toMatchObject({ kind: 'item', value: { kind: 'scalar', text: 'taxonomy' } });
    expect(requires?.children[1]).toMatchObject({ kind: 'item', value: { kind: 'string', text: 'agent system' } });
    const entry = discriminators?.children[0];
    expect(entry).toMatchObject({
      kind: 'field',
      key: 'agent',
      value: { kind: 'scalar', text: 'lowers to binding' },
      words: ['agent', 'lowers', 'to', 'binding'],
    });
    expect(entry?.kind === 'field' && entry.children.map((c) => (c.kind === 'field' ? c.key : c.kind))).toEqual([
      'category',
      'facets',
      'schema',
    ]);
  });

  it('parses the cognition shape as plain fields with words preserved', () => {
    const src =
      '#! ia 1.0\n@playbook p\n  cognition\n    orient\n      primary Memory\n      Memory means """recall"""\n';
    const r = parse(src, 'a.ia');
    const orient = r.ast.records[0]?.sections[0]?.children[0];
    expect(orient).toMatchObject({ kind: 'field', key: 'orient', value: { kind: 'block' } });
    expect(orient?.kind === 'field' && orient.children).toMatchObject([
      { key: 'primary', value: { kind: 'scalar', text: 'Memory' } },
      { key: 'Memory means', value: { kind: 'prose', text: 'recall' } },
    ]);
  });

  it('parses a relationships line as a ref field with a when clause', () => {
    const r = parse('#! ia 1.0\n@law x\n  relationships\n    uses @playbook p when phase is orient\n', 'a.ia');
    const f = r.ast.records[0]?.sections[0]?.children[0];
    expect(f).toMatchObject({
      kind: 'field',
      key: 'uses',
      value: { kind: 'ref', discriminator: 'playbook', name: 'p' },
      when: ['phase', 'is', 'orient'],
    });
  });

  it('records the span of a multi-line prose field', () => {
    const r = parse('#! ia 1.0\n@law x\n  meaning\n    says """a\n      b"""\n    answers "q"\n', 'a.ia');
    const says = r.ast.records[0]?.sections[0]?.children[0];
    expect(says?.span).toEqual({ line: 4, endLine: 5 });
  });

  it('a field with a value may still open a block', () => {
    const r = parse('#! ia 1.0\n@law x\n  governance\n    requires "b"\n      when severity is blocking\n', 'a.ia');
    const req = r.ast.records[0]?.sections[0]?.children[0];
    expect(req).toMatchObject({ key: 'requires', value: { kind: 'string', text: 'b' } });
    expect(req?.kind === 'field' && req.children[0]).toMatchObject({
      key: 'when',
      value: { kind: 'scalar', text: 'severity is blocking' },
    });
  });
});
