import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { fieldOf, restAfter, sectionOf, stringOf } from '../../src/registry/fields.js';

const record = (body: string) => parse(`#! ia 1.0\n@system x\n${body}`, 'a.ia').ast.records[0]!;

describe('reading spelled keys', () => {
  it('matches a head field by the words that start it, whatever the value form', () => {
    const r = record('  provider "p"\n  lowers to binding\n  version "1.0.0"\n');
    expect(stringOf(fieldOf(r.head, ['provider']))).toBe('p');
    expect(restAfter(fieldOf(r.head, ['lowers', 'to'])!, ['lowers', 'to'])).toEqual(['binding']);
    // On an all-words line a shorter spelling matches as a prefix; the key rule picks the longest.
    expect(fieldOf(r.head, ['lowers'])?.words).toEqual(['lowers', 'to', 'binding']);
    expect(fieldOf(r.head, ['version', 'x'])).toBeUndefined();
    expect(stringOf(fieldOf(r.head, ['describes']))).toBeUndefined();
  });

  it('does not match a spelling that only shares a prefix word', () => {
    const r = record('  facets [a]\n  facet b\n');
    expect(fieldOf(r.head, ['facet'])?.words).toEqual(['facet', 'b']);
    expect(fieldOf(r.head, ['facets'])?.value.kind).toBe('list');
  });

  it('finds a section by name and returns undefined for a missing one', () => {
    const r = record('  requires\n    - taxonomy\n');
    expect(sectionOf(r, 'requires')?.children).toHaveLength(1);
    expect(sectionOf(r, 'edges')).toBeUndefined();
  });
});
