import { describe, expect, it } from 'vitest';
import { tokenizeLine } from '../../src/scanner/tokenize.js';
import { itemValue, splitField } from '../../src/parser/values.js';

const split = (text: string, line = 1) => splitField(tokenizeLine(text, 'a.ia', line).tokens, 'a.ia', line);
const codes = (text: string) => split(text).diagnostics.map((d) => d.code);
const item = (text: string) => itemValue(tokenizeLine(text, 'a.ia', 1).tokens.slice(1), 'a.ia', 1);

describe('splitField', () => {
  it('uses the first word as key and the rest as a scalar', () => {
    expect(split('state active')).toMatchObject({
      key: 'state',
      words: ['state', 'active'],
      value: { kind: 'scalar', text: 'active' },
    });
    expect(split('primary Memory')).toMatchObject({ key: 'primary', value: { kind: 'scalar', text: 'Memory' } });
    expect(split('describes Orient, then plan')).toMatchObject({
      key: 'describes',
      value: { kind: 'scalar', text: 'Orient, then plan' },
    });
    expect(split('agent lowers to binding')).toMatchObject({
      key: 'agent',
      words: ['agent', 'lowers', 'to', 'binding'],
      value: { kind: 'scalar', text: 'lowers to binding' },
    });
    expect(split('says a    b\tc')).toMatchObject({
      key: 'says',
      words: ['says', 'a', 'b', 'c'],
      value: { kind: 'scalar', text: 'a b c' },
    });
  });

  it('makes every word before a string the key, and words carries only those words', () => {
    expect(split('Decision means "commit"')).toMatchObject({
      key: 'Decision means',
      words: ['Decision', 'means'],
      value: { kind: 'string', text: 'commit' },
    });
  });

  it('makes every word before prose the key', () => {
    expect(split('says """a\n  b"""')).toMatchObject({
      key: 'says',
      words: ['says'],
      value: { kind: 'prose', text: 'a b' },
    });
  });

  it('makes every word before a list the key and typed items, with no item words in words', () => {
    expect(split('facets [ head, "two words", @law x ]')).toMatchObject({
      key: 'facets',
      words: ['facets'],
      value: {
        kind: 'list',
        items: [
          { kind: 'scalar', text: 'head' },
          { kind: 'string', text: 'two words' },
          { kind: 'ref', discriminator: 'law', name: 'x' },
        ],
      },
    });
    expect(split('tags []')).toMatchObject({ value: { kind: 'list', items: [] } });
    expect(split('tags [ a b ]')).toMatchObject({ value: { kind: 'list', items: [{ kind: 'scalar', text: 'a b' }] } });
    expect(split('tags [a, when, b]')).toMatchObject({
      value: {
        kind: 'list',
        items: [
          { kind: 'scalar', text: 'a' },
          { kind: 'scalar', text: 'when' },
          { kind: 'scalar', text: 'b' },
        ],
      },
    });
    expect(split('tags [a, when, b]').when).toBeUndefined();
    expect(codes('tags [a, when, b]')).toEqual([]);
  });

  it('makes every word before a sigil the key and reads name and fragment', () => {
    expect(split('cites @law sample-rule')).toMatchObject({
      key: 'cites',
      words: ['cites'],
      value: { kind: 'ref', discriminator: 'law', name: 'sample-rule', raw: '@law sample-rule' },
    });
    expect(split('implements @contract x#REQ-1')).toMatchObject({
      value: { kind: 'ref', discriminator: 'contract', name: 'x', fragment: 'REQ-1' },
    });
    expect(split('cites @law when')).toMatchObject({ value: { kind: 'ref', discriminator: 'law', name: 'when' } });
    expect(split('cites @law when').when).toBeUndefined();
  });

  it('splits a trailing when clause into words, keeping quoted strings quoted', () => {
    expect(split('uses @playbook p when phase is orient and move is Delegation')).toMatchObject({
      key: 'uses',
      value: { kind: 'ref', discriminator: 'playbook', name: 'p' },
      when: ['phase', 'is', 'orient', 'and', 'move', 'is', 'Delegation'],
    });
    expect(split('requires "corroboration" when primitive is Memory')).toMatchObject({
      value: { kind: 'string', text: 'corroboration' },
      when: ['primitive', 'is', 'Memory'],
    });
    expect(split('activate when category is "capability"')).toMatchObject({
      key: 'activate',
      value: { kind: 'none' },
      when: ['category', 'is', '"capability"'],
    });
  });

  it('refuses a when clause that is empty or carries a list or prose', () => {
    expect(codes('uses @playbook p when')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('uses @playbook p when a is [b, c]')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('uses @playbook p when a is """b"""')).toEqual(['IA-LANG-VALUE-TRAILING']);
  });

  it('applies the is-form only when the whole line is words', () => {
    expect(split('category is capability')).toMatchObject({
      key: 'category',
      value: { kind: 'scalar', text: 'capability' },
      assertive: true,
    });
    expect(split('category is "x"')).toMatchObject({ key: 'category is', value: { kind: 'string', text: 'x' } });
    expect(split('category is "x"').assertive).toBeUndefined();
  });

  it('returns a none value for a bare key and a keyed line whose key is when', () => {
    expect(split('meaning')).toMatchObject({ key: 'meaning', value: { kind: 'none' } });
    expect(split('when severity is blocking')).toMatchObject({
      key: 'when',
      value: { kind: 'scalar', text: 'severity is blocking' },
    });
    expect(split('when severity is blocking').when).toBeUndefined();
  });

  it('refuses a value with no key once, without reading the value', () => {
    expect(codes('"a"')).toEqual(['IA-LANG-FIELD-KEY-MISSING']);
    expect(codes('[a]')).toEqual(['IA-LANG-FIELD-KEY-MISSING']);
    expect(codes('"foo" extra')).toEqual(['IA-LANG-FIELD-KEY-MISSING']);
    expect(codes('"foo" when [x]')).toEqual(['IA-LANG-FIELD-KEY-MISSING']);
    expect(codes('"foo" when')).toEqual(['IA-LANG-FIELD-KEY-MISSING']);
    expect(split('"foo" extra')).toMatchObject({ key: '', value: { kind: 'none' } });
  });

  it('refuses a malformed reference with exactly one diagnostic', () => {
    expect(codes('cites @law')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @1x y')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @law bad.name')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @law "x"')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @law [x]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('cites @law [when]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('tags [@law "x"]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('tags [@law [x]]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(split('tags [a, @law] when x is y')).toMatchObject({ when: ['x', 'is', 'y'] });
    expect(codes('tags [a, @law] when x is y')).toEqual(['IA-LANG-REF-MALFORMED']);
  });

  it('refuses tokens left over after a value, naming the character', () => {
    expect(codes('says "a"b')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('says "a" "b"')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('says a"b" c')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('cites @law x extra')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('tags [a] b')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('tags [a] [b]')).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(codes('says "a" when phase is act')).toEqual([]);
  });

  it('refuses a malformed list with exactly one diagnostic per mistake', () => {
    expect(codes('tags [,]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags [a,,b]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags [[a]]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags [[a], b]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags [a,]')).toEqual([]);
    expect(codes('tags [@law]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('tags [@law, x]')).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(codes('tags [a "b"]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags ["a" b]')).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(codes('tags [@law x y]')).toEqual(['IA-LANG-LIST-MALFORMED']);
  });

  it('reports list refusals at the line of the offending token in a joined multi-line list', () => {
    const r = split('tags [a,\n,b]', 5);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-LIST-MALFORMED', 6]]);
    const open = split('tags [a', 5);
    expect(open.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-LIST-UNTERMINATED', 5]]);
  });
});

describe('itemValue', () => {
  it('reads a scalar, string, ref or list item with no key rule', () => {
    expect(item('- taxonomy')).toMatchObject({ value: { kind: 'scalar', text: 'taxonomy' }, diagnostics: [] });
    expect(item('- "agent system"')).toMatchObject({ value: { kind: 'string', text: 'agent system' } });
    expect(item('- @law x')).toMatchObject({ value: { kind: 'ref', discriminator: 'law', name: 'x' } });
    expect(item('- is b')).toMatchObject({ value: { kind: 'scalar', text: 'is b' } });
    expect(item('- a when b')).toMatchObject({ value: { kind: 'scalar', text: 'a when b' } });
  });

  it('refuses an empty item and tokens after an item value', () => {
    expect(item('-').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(item('- "a" b').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(item('- @1x y').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-REF-MALFORMED']);
    expect(item('- [a, b]').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(item('- [a,,b]').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(item('- """p"""').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-LIST-MALFORMED']);
    expect(item('- """p"""').value).toEqual({ kind: 'none' });
  });
});
