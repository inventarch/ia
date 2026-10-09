import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { admits, adopterOf, consentFor } from '../../src/registry/consent.js';
import { buildRegistry } from '../../src/registry/index.js';
import type { ConsentRow, Location } from '../../src/registry/types.js';

const row = (
  predicate: ConsentRow['predicate'],
  targets: ConsentRow['targets'],
  sources: ConsentRow['sources'],
): ConsentRow => ({ predicate, targets, sources, span: { line: 1, endLine: 1 } });

describe('admits', () => {
  it('admits only when one row admits both ends of the edge', () => {
    const rows = [row('cite', ['law'], ['check']), row('cite', ['pattern'], ['guardrail'])];
    expect(admits(rows, 'cite', 'check', 'law')).toBe(true);
    expect(admits(rows, 'cite', 'guardrail', 'pattern')).toBe(true);
    expect(admits(rows, 'cite', 'check', 'pattern')).toBe(false);
    expect(admits(rows, 'use', 'check', 'law')).toBe(false);
  });

  it('treats * as any keyword on its side and an absent ledger as admitting nothing', () => {
    expect(admits([row('use', '*', ['agent'])], 'use', 'agent', 'anything')).toBe(true);
    expect(admits([row('use', '*', ['agent'])], 'use', 'other', 'anything')).toBe(false);
    expect(admits([row('use', '*', '*')], 'use', 'a', 'b')).toBe(true);
    expect(admits(undefined, 'use', 'a', 'b')).toBe(false);
  });

  it('allows any source with a source wildcard while still restricting the target and predicate', () => {
    const rows = [row('use', ['agent'], '*')];
    expect(admits(rows, 'use', 'anything', 'agent')).toBe(true);
    expect(admits(rows, 'use', 'anything', 'other')).toBe(false);
    expect(admits(rows, 'cite', 'anything', 'agent')).toBe(false);
  });

  it('matches any listed member on both sides without treating a prefix as a member', () => {
    const rows = [row('cite', ['law', 'rule'], ['agent', 'check'])];
    expect(admits(rows, 'cite', 'check', 'rule')).toBe(true);
    expect(admits(rows, 'cite', 'agent', 'law')).toBe(true);
    expect(admits(rows, 'cite', 'agent-extra', 'law')).toBe(false);
    expect(admits(rows, 'cite', 'agent', 'law-extra')).toBe(false);
  });

  it('admits nothing from an empty ledger', () => {
    expect(admits([], 'cite', 'agent', 'law')).toBe(false);
  });

  it('matches any-adopter only through the supplied adopter test, which defaults to nobody', () => {
    const rows = [row('require', ['task'], ['any-adopter'])];
    expect(admits(rows, 'require', 'note', 'task')).toBe(false);
    expect(admits(rows, 'require', 'note', 'task', (keyword) => keyword === 'note')).toBe(true);
    expect(admits(rows, 'require', 'memo', 'task', (keyword) => keyword === 'note')).toBe(false);
    // The literal keyword is not a word: it matches itself no more than any other non-adopter.
    expect(admits(rows, 'require', 'any-adopter', 'task', () => false)).toBe(false);
  });
});

const AUTHORED: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const source = (text: string, path: string) => ({ ...parse(text, path), location: AUTHORED });
/** One system minting one word, with the rows and direct requirements given; its schema sits in the same file. */
function system(name: string, word: string, rows: readonly string[], requires: readonly string[] = []): string {
  const required = requires.length === 0 ? '' : `  requires\n${requires.map((r) => `    - ${r}\n`).join('')}`;
  return `#! ia 1.0
@system ${name}
  provider "fixture"
  version "1.0.0"
${required}  discriminators
    ${word} lowers to definition
      category process
      facets [head]
      schema @schema ${word}
  edges
${rows.map((r) => `    ${r}\n`).join('')}@schema ${word}
  lowers to definition
  sections
    open
`;
}
const WIDE = ['require * using *', 'ground * using *', 'cite * using *'];
const adopters = buildRegistry([
  source(
    system('base', 'task', [
      'require task using task, any-adopter',
      'ground any-adopter using task',
      'cite any-adopter using task',
    ]),
    'base.ia',
  ),
  source(system('adopter', 'note', WIDE, ['base']), 'adopter.ia'),
  source(system('indirect', 'card', WIDE, ['adopter']), 'indirect.ia'),
  source(system('stranger', 'memo', WIDE), 'stranger.ia'),
]);

describe('any-adopter', () => {
  it('builds the fixture registry with every system in force', () => {
    expect(adopters.diagnostics).toEqual([]);
    expect([...adopters.registry.systems.keys()].sort()).toEqual(['adopter', 'base', 'indirect', 'stranger']);
  });

  it('matches, on the sources side, the words of systems that require the ledger owner directly or transitively', () => {
    const { registry } = adopters;
    expect(consentFor(registry, 'require', 'note', 'task')).toBeUndefined();
    expect(consentFor(registry, 'require', 'card', 'task')).toBeUndefined();
    expect(consentFor(registry, 'require', 'task', 'task')).toBeUndefined();
    // stranger requires nothing: base refuses it as the target side.
    expect(consentFor(registry, 'require', 'memo', 'task')).toBe('target');
  });

  it('matches on the targets side too, and never the ledger owner’s own words', () => {
    const { registry } = adopters;
    expect(consentFor(registry, 'ground', 'task', 'note')).toBeUndefined();
    expect(consentFor(registry, 'ground', 'task', 'card')).toBeUndefined();
    expect(consentFor(registry, 'ground', 'task', 'memo')).toBe('source');
    // base is not its own adopter: `ground any-adopter using task` does not admit task -> task.
    expect(consentFor(registry, 'ground', 'task', 'task')).toBe('source');
  });

  it('never matches a built-in’s word, where * would', () => {
    const { registry } = adopters;
    const test = adopterOf(registry, 'base');
    expect(test('schema')).toBe(false);
    expect(test('system')).toBe(false);
    expect(test('note')).toBe(true);
    expect(test('card')).toBe(true);
    expect(test('memo')).toBe(false);
    expect(test('task')).toBe(false);
    expect(test('ghost')).toBe(false);
    // The floor would admit the citation; base's any-adopter row refuses the source side where * admits it.
    expect(consentFor(registry, 'cite', 'task', 'schema')).toBe('source');
    const wide = buildRegistry([
      source(system('base', 'task', ['cite * using task']), 'base.ia'),
      source(system('adopter', 'note', WIDE, ['base']), 'adopter.ia'),
    ]).registry;
    expect(consentFor(wide, 'cite', 'task', 'schema')).toBeUndefined();
  });

  it('is a subset of * on every keyword', () => {
    const test = adopterOf(adopters.registry, 'base');
    const narrow = [row('require', ['task'], ['any-adopter'])];
    const wide = [row('require', ['task'], '*')];
    for (const keyword of ['note', 'card', 'memo', 'task', 'schema', 'system', 'ghost', 'any-adopter'])
      if (admits(narrow, 'require', keyword, 'task', test)) expect(admits(wide, 'require', keyword, 'task')).toBe(true);
    expect(['note', 'card'].every((keyword) => admits(narrow, 'require', keyword, 'task', test))).toBe(true);
  });

  it('is reserved as a registration keyword yet accepted as a row member', () => {
    const text = `#! ia 1.0
@system s
  provider "fixture"
  version "1.0.0"
  discriminators
    any-adopter lowers to definition
      category process
      facets [head]
      schema @schema widget
  edges
    cite any-adopter using any-adopter
@schema widget
  lowers to definition
  sections
    open
`;
    const { registry, diagnostics } = buildRegistry([source(text, 's.ia')]);
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-KEYWORD-RESERVED', 6]]);
    expect(diagnostics[0]!.message).toContain('reserved for consent rows');
    expect(registry.registrations.has('any-adopter')).toBe(false);
    expect(registry.consent.get('s')).toMatchObject([
      { predicate: 'cite', targets: ['any-adopter'], sources: ['any-adopter'] },
    ]);
  });
});
