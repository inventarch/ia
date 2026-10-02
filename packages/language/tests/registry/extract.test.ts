import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { extractSystems } from '../../src/registry/extract.js';

const extract = (source: string) => {
  const parsed = parse(source, 'sys.ia');
  const result = extractSystems(parsed.ast, 100, parsed.diagnostics);
  return { ...result, diagnostics: [...parsed.diagnostics, ...result.diagnostics].sort((a, b) => a.line - b.line) };
};
const codes = (source: string) => extract(source).diagnostics.map((d) => [d.code, d.line]);
const HEAD = '#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n';
const ENTRY =
  '    agent lowers to binding\n      category capability\n      facets [head]\n      schema @schema Agent\n';

const GOOD = `#! ia 1.0
@system Agent-System
  provider "agent-system"
  version "0.1.0"
  describes "Registers the agent discriminator."
  steward @agent Steward-One
  requires
    - taxonomy
  discriminators
    agent lowers to binding
      category capability
      facets [head, steward]
      schema @schema Agent
  edges
    cite * using agent
    use agent using *
    govern law, check using agent
  relationships
    grounds @schema agent
`;

describe('extractSystems', () => {
  it.each(['interface', 'protocol', 'shape'])(
    'refuses retired registration %s without adding a floor word',
    (keyword) => {
      const result = extract(`${HEAD}  discriminators\n${ENTRY.replace('agent lowers', `${keyword} lowers`)}`);
      expect(result.systems[0]!.entries).toEqual([]);
      expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-KEYWORD-RESERVED', 6]]);
      expect(result.diagnostics[0]!.message).toContain('retired');
    },
  );
  it('reads a complete system: head, steward, requires, entries, consent rows', () => {
    const { systems, diagnostics } = extract(GOOD);
    expect(diagnostics).toEqual([]);
    expect(systems).toHaveLength(1);
    const s = systems[0]!;
    expect(s).toMatchObject({
      name: 'agent-system',
      displayName: 'Agent-System',
      provider: 'agent-system',
      version: '0.1.0',
      describes: 'Registers the agent discriminator.',
      path: 'sys.ia',
      band: 100,
    });
    expect(s.steward).toEqual({ discriminator: 'agent', name: 'steward-one' });
    expect(s.requires.map((r) => r.name)).toEqual(['taxonomy']);
    expect(s.entries).toEqual([
      {
        keyword: 'agent',
        kind: 'binding',
        category: 'capability',
        facets: ['head', 'steward'],
        schema: 'agent',
        span: { line: 10, endLine: 13 },
      },
    ]);
    expect(s.consent.map((c) => [c.predicate, c.targets, c.sources])).toEqual([
      ['cite', '*', ['agent']],
      ['use', ['agent'], '*'],
      ['govern', ['law', 'check'], ['agent']],
    ]);
  });

  it('extracts nested systems once and ignores other record kinds', () => {
    const { systems } = extract(
      '#! ia 1.0\n@law x\n  meaning\n    says "a"\n@system s\n  provider "p"\n  version "1.0.0"\n  meaning\n    @system inner\n      provider "q"\n      version "1.0.0"\n',
    );
    expect(systems.map((s) => s.name)).toEqual(['s', 'inner']);
  });

  it('refuses a system whose head is incomplete or doubled, naming the element', () => {
    expect(codes('#! ia 1.0\n@system s\n  version "1.0.0"\n')).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 2]]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n')).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 2]]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n  version "1.0"\n')).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 4],
    ]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n  version "01.0.0"\n')).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 4],
    ]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0-beta.1+build.5"\n')).toEqual([]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n  provider "q"\n  version "1.0.0"\n')).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 4],
    ]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  requires [a]\n')).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 5],
    ]);
    expect(codes('#! ia 1.0\n@system s\n  provider "p" when phase is act\n  version "1.0.0"\n')).toEqual([
      ['IA-LANG-CONDITION-MISPLACED', 3],
    ]);
    expect(extract('#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  requires [a]\n').systems).toEqual([]);
  });

  it('keeps the system when a requires item is malformed, and lowercases requires names', () => {
    const r = extract(`${HEAD}  requires\n    - Agent-System\n    - "oops"\n`);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 7]]);
    expect(r.systems[0]?.requires.map((x) => x.name)).toEqual(['agent-system']);
  });

  it('drops a bad entry with its own diagnostics and keeps the system', () => {
    const head = '#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  discriminators\n';
    expect(codes(`${head}    agent binding\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(
      codes(
        `${head}    Agent lowers to binding\n      category capability\n      facets [head]\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(
      codes(
        `${head}    system lowers to definition\n      category boundary\n      facets [system]\n      schema @schema system\n`,
      ),
    ).toEqual([['IA-LANG-KEYWORD-RESERVED', 6]]);
    expect(
      codes(
        `${head}    agent lowers to widget\n      category capability\n      facets [head]\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-KIND-UNKNOWN', 6]]);
    expect(codes(`${head}    agent lowers to binding\n      facets [head]\n      schema @schema agent\n`)).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 6],
    ]);
    expect(
      codes(
        `${head}    agent lowers to binding\n      category widgets\n      facets [head]\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-CATEGORY-UNKNOWN', 7]]);
    expect(
      codes(
        `${head}    agent lowers to binding\n      category "capability"\n      facets [head]\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 7]]);
    expect(
      codes(
        `${head}    agent lowers to binding\n      category capability\n      facets []\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(
      codes(
        `${head}    agent lowers to binding\n      category capability\n      facets [head]\n      schema "agent"\n`,
      ),
    ).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(
      codes(
        `${head}    agent lowers to binding when phase is act\n      category capability\n      facets [head]\n      schema @schema agent\n`,
      ),
    ).toEqual([['IA-LANG-CONDITION-MISPLACED', 6]]);
    const kept = extract(
      `${head}    agent binding\n    mandate lowers to policy\n      category rule\n      facets [head]\n      schema @schema mandate\n`,
    );
    expect(kept.systems[0]?.entries.map((e) => e.keyword)).toEqual(['mandate']);
  });

  it('registers a keyword once per system', () => {
    const entry =
      '    agent lowers to binding\n      category capability\n      facets [head]\n      schema @schema agent\n';
    const r = extract(`#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  discriminators\n${entry}${entry}`);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 10]]);
    expect(r.systems[0]?.entries).toHaveLength(1);
  });

  it('drops a bad consent row with one diagnostic', () => {
    const head = '#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  edges\n';
    expect(codes(`${head}    cites * using agent\n`)).toEqual([['IA-LANG-PREDICATE-UNKNOWN', 6]]);
    expect(codes(`${head}    cite * agent\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(codes(`${head}    cite using agent\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(codes(`${head}    cite a using b using c\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(codes(`${head}    cite *, law using agent\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(codes(`${head}    cite law, using agent\n`)).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(codes(`${head}    cite "law" using agent\n`)).toEqual([['IA-LANG-VALUE-TRAILING', 6]]);
    expect(codes(`${head}    cite * using agent when phase is act\n`)).toEqual([
      ['IA-LANG-REGISTRATION-INCOMPLETE', 6],
    ]);
    expect(extract(`${head}    cite law,check using agent\n`).systems[0]?.consent[0]?.targets).toEqual([
      'law',
      'check',
    ]);
    expect(extract(`${head}    cite * agent\n    use * using *\n`).systems[0]?.consent).toHaveLength(1);
  });

  it.each(['"bob"', 'bob', '@agent Bob#meaning'])('refuses the whole system for malformed steward %s', (value) => {
    const result = extract(`${HEAD}  steward ${value}\n`);
    expect(result.systems).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 5]]);
  });

  it('requires version once and requires quoted provider and version values', () => {
    for (const source of [
      HEAD + '  version "2.0.0"\n',
      HEAD.replace('provider "p"', 'provider p'),
      HEAD.replace('version "1.0.0"', 'version 1.0.0'),
    ]) {
      const result = extract(source);
      expect(result.systems).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('IA-LANG-REGISTRATION-INCOMPLETE');
    }
  });

  it('does not impose uniqueness on describes or steward', () => {
    const result = extract(
      `${HEAD}  describes "first"\n  describes "second"\n  steward @agent First\n  steward @agent Second\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.systems[0]).toMatchObject({ describes: 'first', steward: { discriminator: 'agent', name: 'first' } });
    expect(extract(`${HEAD}  steward @agent First\n  steward "bad"\n`).systems).toEqual([]);
  });

  it.each([
    '1.01.0',
    '1.0.01',
    '1.0.0-01',
    '1.0.0-beta.01',
    '1.0.0-a..b',
    '1.0.0-.',
    '1.0.0-alpha.',
    '1.0.0+.',
    '1.0.0+build..5',
    '1.0.0+build.',
    '1.0.0-',
  ])('refuses invalid semver %s', (version) => {
    const result = extract(HEAD.replace('1.0.0', version));
    expect(result.systems).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 4]]);
  });

  it.each(['0.0.0', '1.0.0-0', '1.0.0-01a', '1.0.0-alpha.1+build.001', '1.0.0+001'])(
    'accepts valid semver %s',
    (version) => {
      const result = extract(HEAD.replace('1.0.0', version));
      expect(result.diagnostics).toEqual([]);
      expect(result.systems[0]?.version).toBe(version);
    },
  );

  it.each(['- Agent System', '- 123', '- agent,other', '- @system agent', 'taxonomy yes'])(
    'drops only the malformed requires child %s',
    (child) => {
      const result = extract(`${HEAD}  requires\n    - taxonomy\n    ${child}\n    - Floor\n`);
      expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 7]]);
      expect(result.systems[0]?.requires.map((r) => r.name)).toEqual(['taxonomy', 'floor']);
    },
  );

  it.each([
    ['  when phase is act\n', 5],
    ['  describes "text" when phase is act\n', 5],
    ['  describes "text"\n    when phase is act\n', 6],
    ['  describes "text"\n    details\n      note yes when phase is act\n', 7],
  ] as const)('refuses a condition in the head: %s', (body, line) => {
    const result = extract(HEAD + body);
    expect(result.systems).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CONDITION-MISPLACED', line]]);
  });

  it.each([
    [ENTRY.replace('category capability', 'category capability when phase is act'), 7],
    [ENTRY + '      when phase is act\n', 10],
    [ENTRY + '        when phase is act\n', 10],
    [ENTRY.replace('category capability\n', 'category capability\n        detail yes when phase is act\n'), 8],
  ] as const)('drops a discriminator entry containing a condition: %s', (entry, line) => {
    const result = extract(`${HEAD}  discriminators\n${entry}${ENTRY.replaceAll('agent', 'worker')}`);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CONDITION-MISPLACED', line]]);
    expect(result.systems[0]?.entries.map((e) => e.keyword)).toEqual(['worker']);
  });

  it.each(['when phase is act', 'taxonomy yes when phase is act', 'details\n      when phase is act'])(
    'uses the condition diagnostic inside requires: %s',
    (child) => {
      const result = extract(`${HEAD}  requires\n    ${child}\n    - taxonomy\n`);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('IA-LANG-CONDITION-MISPLACED');
      expect(result.systems[0]?.requires.map((r) => r.name)).toEqual(['taxonomy']);
    },
  );

  it.each([
    'cite law check using agent',
    'cite law using agent worker',
    'cite Law using agent',
    'cite law using Agent',
    'cite law using agent,',
    'cite law,,check using agent',
    'cite * using *,agent',
    'cite * using agent\n      when phase is act',
  ])('drops malformed consent row %s', (row) => {
    const result = extract(`${HEAD}  edges\n    ${row}\n    use * using *\n`);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 6]]);
    expect(result.systems[0]?.consent.map((r) => r.predicate)).toEqual(['use']);
  });

  it('accepts comma whitespace on either consent side and an absent ledger', () => {
    const result = extract(`${HEAD}  edges\n    cite law , check using agent, worker\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.systems[0]?.consent[0]).toMatchObject({ targets: ['law', 'check'], sources: ['agent', 'worker'] });
    expect(extract(HEAD).systems[0]?.consent).toEqual([]);
  });

  it('honors an assertive category and lowercases the schema name', () => {
    const result = extract(
      `${HEAD}  discriminators\n${ENTRY.replace('category capability', 'category is capability')}`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.systems[0]?.entries[0]).toMatchObject({ category: 'capability', schema: 'agent' });
  });

  it.each([
    ENTRY.replace('      facets [head]\n', ''),
    ENTRY.replace('      schema @schema Agent\n', ''),
    ENTRY.replace('facets [head]', 'facets ["head"]'),
    ENTRY.replace('schema @schema Agent', 'schema @agent Agent'),
    ENTRY.replace('schema @schema Agent', 'schema @schema Agent#meaning'),
  ])('drops an entry with a missing or malformed required element: %s', (entry) => {
    const result = extract(`${HEAD}  discriminators\n${entry}`);
    expect(result.systems[0]?.entries).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('IA-LANG-REGISTRATION-INCOMPLETE');
  });

  it('reads every repeated section and enforces keyword uniqueness across them', () => {
    const result = extract(
      `${HEAD}  requires\n    - floor\n  requires\n    - taxonomy\n  discriminators\n${ENTRY}  discriminators\n${ENTRY}${ENTRY.replace('agent lowers', 'helper lowers')}  edges\n    cite * using agent\n  edges\n    use * using helper\n`,
    );
    expect(result.systems[0]?.requires.map((r) => r.name)).toEqual(['floor', 'taxonomy']);
    expect(result.systems[0]?.entries.map((e) => e.keyword)).toEqual(['agent', 'helper']);
    expect(result.systems[0]?.consent.map((r) => r.predicate)).toEqual(['cite', 'use']);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 15]]);
  });

  it('keeps parser refusals local to their section when a section repeats', () => {
    const result = extract(
      `${HEAD}  discriminators\n${ENTRY.replace('@schema Agent', '@schema 123')}  discriminators\n${ENTRY}  requires\n    - []\n  requires\n    - taxonomy\n  edges\n    cite "law" using agent\n  edges\n    use * using agent\n`,
    );
    expect(result.systems[0]?.entries.map((e) => e.keyword)).toEqual(['agent']);
    expect(result.systems[0]?.requires.map((r) => r.name)).toEqual(['taxonomy']);
    expect(result.systems[0]?.consent.map((r) => r.predicate)).toEqual(['use']);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-REF-MALFORMED', 9],
      ['IA-LANG-LIST-MALFORMED', 16],
      ['IA-LANG-VALUE-TRAILING', 20],
    ]);
  });

  it('reserves schema as well as system', () => {
    expect(codes(`${HEAD}  discriminators\n${ENTRY.replace('agent lowers', 'schema lowers')}`)).toEqual([
      ['IA-LANG-KEYWORD-RESERVED', 6],
    ]);
  });

  it('allows the discriminator keyword when in an otherwise complete entry', () => {
    const result = extract(`${HEAD}  discriminators\n${ENTRY.replace('agent lowers', 'when lowers')}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.systems[0]?.entries[0]?.keyword).toBe('when');
  });

  it('discovers systems through other record kinds and multiple nesting levels exactly once', () => {
    const result = extract(
      '#! ia 1.0\n@law outer\n  meaning\n    @system One\n      provider "p"\n      version "1.0.0"\n      meaning\n        @law middle\n          meaning\n            @system Two\n              provider "p"\n              version "1.0.0"\n',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.systems.map((s) => s.name)).toEqual(['one', 'two']);
  });

  it('keeps parser faults in a nested system out of its enclosing system head', () => {
    const result = extract(
      `${HEAD}  describes "nested"\n    @system inner\n      provider @agent 123\n      version "1.0.0"\n`,
    );
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REF-MALFORMED', 7]]);
    expect(result.systems.map((s) => s.name)).toEqual(['s']);
  });

  it.each([
    [HEAD + '  requires\n    - []\n', 'IA-LANG-LIST-MALFORMED', 6, 1],
    [HEAD.replace('provider "p"', 'provider @agent 123'), 'IA-LANG-REF-MALFORMED', 3, 0],
    [HEAD + '  discriminators\n' + ENTRY.replace('@schema Agent', '@schema 123'), 'IA-LANG-REF-MALFORMED', 9, 1],
    [HEAD + '  edges\n    cite "law" using agent\n', 'IA-LANG-VALUE-TRAILING', 6, 1],
    [
      HEAD + '  discriminators\n' + ENTRY.replace('agent lowers to binding', 'agent lowers to binding when'),
      'IA-LANG-VALUE-TRAILING',
      6,
      1,
    ],
    [HEAD.replace('version "1.0.0"', 'version "1.0.0'), 'IA-LANG-STRING-UNTERMINATED', 4, 0],
    [
      HEAD + '  discriminators\n' + ENTRY.replace('schema @schema Agent', 'schema "broken'),
      'IA-LANG-STRING-UNTERMINATED',
      9,
      1,
    ],
  ] as const)('does not re-report a parser-refused element: %s', (source, code, line, systems) => {
    const parsed = parse(source, 'sys.ia');
    const result = extractSystems(parsed.ast, 100, parsed.diagnostics);
    expect(parsed.diagnostics.map((d) => [d.code, d.line])).toEqual([[code, line]]);
    expect(result.diagnostics).toEqual([]);
    expect(result.systems).toHaveLength(systems);
    if (systems > 0) expect(result.systems[0]).toMatchObject({ entries: [], requires: [], consent: [] });
  });
});
