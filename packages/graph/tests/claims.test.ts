import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { CLAIM_FIELDS, claimants, isSelection, load, selects, serialize, stableSerialize } from '../src/index.js';
import type { Graph, LoadOptions } from '../src/index.js';
import { inputs, records, registry } from './native.js';

// G06c: claimant fields are indexed once at load; a path is matched against that index in one minimal glob dialect.
const options: LoadOptions = {
  sources: inputs,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
};
const native = load(records, registry, options);
const authored: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const adopted: Location = { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' };
function graphOf(files: readonly { readonly source: string; readonly path: string; readonly location?: Location }[]) {
  const compiled = files.map(({ source, path, location = authored }) => {
    const text = `#! ia 1.0\n${source}\n`;
    const parsed = parse(text, path);
    expect(parsed.diagnostics).toEqual([]);
    const result = compile(parsed.ast, registry, location, []);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return { records: result.records, input: { path, text, location } };
  });
  return (order: 'forward' | 'reversed' = 'forward'): Graph => {
    const all = [...records, ...compiled.flatMap((c) => c.records)],
      sources = [...inputs, ...compiled.map((c) => c.input)];
    return load(order === 'forward' ? all : [...all].reverse(), registry, {
      ...options,
      sources: order === 'forward' ? sources : [...sources].reverse(),
    });
  };
}
const meaning = '  meaning\n    says "x"\n    answers "y"';
const fixture = graphOf([
  {
    path: 'claims.ia',
    source: [
      `@mandate path-mandate\n${meaning}\n  authority\n    covers ["src/**", "docs/", "src/**", @agent agent-steward]\n    nested\n      covers ["nested/**"]`,
      `@law path-law\n${meaning}\n  governance\n    severity blocking\n  subject\n    covers ["**"]`,
      `@convention path-convention\n${meaning}\n  governance\n    severity advisory\n  subject\n    covers ["src/**/*.ts"]`,
      `@spec path-spec\n${meaning}\n  work\n    title "t"\n    status draft\n    covers ["src/billing/invoice.ts"]`,
      `@hook path-hook\n${meaning}\n  hook\n    event PreToolUse\n    tools [Edit]\n    paths ["src/billing/**"]\n    message "m"`,
      `@check path-check\n${meaning}\n  check\n    runs COMP-SCHEMA\n    scope "src/billing/*.ts"\n  governance\n    severity advisory`,
      `@playbook path-playbook\n${meaning}\n  subject\n    covers ["src/**"]\n  meaning-extra\n    covers ["never/**"]`,
    ].join('\n'),
  },
  {
    path: 'adopted.ia',
    location: adopted,
    source: `@law adopted-law\n${meaning}\n  governance\n    severity advisory\n  subject\n    covers ["src/"]`,
  },
]);
const graph = fixture();
const id = (word: string, name: string) =>
  [...graph.nodes.values()].find((n) => n.discriminator === word && n.name === name)!.identity;
const mandate = id('mandate', 'path-mandate'),
  law = id('law', 'path-law'),
  convention = id('convention', 'path-convention'),
  spec = id('spec', 'path-spec'),
  hook = id('hook', 'path-hook'),
  check = id('check', 'path-check'),
  playbook = id('playbook', 'path-playbook'),
  adoptedLaw = id('law', 'adopted-law');

describe('the path selection dialect (G06c)', () => {
  it('matches an exact path, and a trailing slash as the path and everything below it', () => {
    expect(selects('docs/README.md', 'docs/README.md')).toBe(true);
    expect(selects('docs/README.md', 'docs/README.mdx')).toBe(false);
    expect(selects('docs/README.md', 'docs')).toBe(false);
    expect(selects('docs', 'docs/README.md')).toBe(false);
    for (const path of ['docs', 'docs/a.md', 'docs/a/b/c.md']) expect(selects('docs/', path)).toBe(true);
    for (const path of ['doc', 'docsx', 'docsx/a.md', '']) expect(selects('docs/', path)).toBe(false);
  });

  it('reads `*` within one segment, `**` across segments and `?` as one character', () => {
    expect(selects('src/*.ts', 'src/a.ts')).toBe(true);
    expect(selects('src/*.ts', 'src/.ts')).toBe(true);
    expect(selects('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(selects('src/*', 'src')).toBe(false);
    for (const path of ['src/a.ts', 'src/a/b/c.ts']) expect(selects('src/**/*.ts', path)).toBe(true);
    expect(selects('src/**/*.ts', 'src/a/b.js')).toBe(false);
    for (const path of ['', 'a', 'a/b/c', '.ia/src/x.ia']) expect(selects('**', path)).toBe(true);
    expect(selects('src/**', 'src')).toBe(true);
    expect(selects('**/x', 'a/b/x')).toBe(true);
    expect(selects('**/x', 'x')).toBe(true);
    expect(selects('a**b/c', 'axyb/c')).toBe(true);
    expect(selects('a**b/c', 'ax/yb/c')).toBe(false);
    expect(selects('a?c', 'abc')).toBe(true);
    expect(selects('a?c', 'ac')).toBe(false);
    expect(selects('a?c', 'abbc')).toBe(false);
    expect(selects('a?b', 'a/b')).toBe(false);
    expect(selects('a?b', 'a\u00e9b')).toBe(true);
    expect(selects('a?b', 'a\u{1F600}b')).toBe(true);
  });

  it('is case-sensitive, gives dots no meaning and has no braces, classes, escapes or negation', () => {
    expect(selects('Docs/**', 'docs/a')).toBe(false);
    expect(selects('*', '.ia')).toBe(true);
    expect(selects('{a,b}', 'a')).toBe(false);
    expect(selects('{a,b}', '{a,b}')).toBe(true);
    expect(selects('[ab]', 'a')).toBe(false);
    expect(selects('[ab]', '[ab]')).toBe(true);
    expect(selects('!a', 'b')).toBe(false);
    expect(selects('!a', '!a')).toBe(true);
  });

  it('normalizes backslashes and canonical spellings of the path, and selects nothing outside the workspace', () => {
    expect(selects('src\\billing\\**', 'src\\billing\\invoice.ts')).toBe(true);
    expect(selects('src/billing/invoice.ts', './src//billing/x/../invoice.ts')).toBe(true);
    expect(selects('docs/', 'docs/')).toBe(true);
    for (const path of ['../x', '/x', '\\x', 'C:/x', 'C:\\x', 'a/../../x']) expect(selects('**', path)).toBe(false);
  });

  it('selects nothing for an empty, absolute or non-canonical selection', () => {
    for (const selection of ['', '/', '/abs/**', 'C:/x/**', 'C:\\x', 'a//b', './a', 'a/./b', 'a/../b', '..', '//']) {
      expect(selects(selection, 'a/b')).toBe(false);
      // isSelection names each as one the dialect does not read, so a host can say so where it is authored.
      expect(isSelection(selection), selection).toBe(false);
    }
    for (const selection of ['a/b', 'a/', '**', 'docs/*.md', 'supplied module source'])
      expect(isSelection(selection), selection).toBe(true);
  });

  it('stays bounded on selections built to backtrack', () => {
    const deep = Array.from({ length: 40 }, () => '**').join('/');
    const path = Array.from({ length: 200 }, (_, i) => `s${i}`).join('/');
    const started = performance.now();
    expect(selects(`${deep}/missing`, path)).toBe(false);
    expect(selects(`${'*a'.repeat(40)}*b`, 'a'.repeat(400))).toBe(false);
    expect(selects(`${deep}/s199`, path)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the claimant index (G06c)', () => {
  it('names the claimant fields', () => {
    expect(CLAIM_FIELDS).toEqual(['authority.covers', 'subject.covers', 'work.covers', 'hook.paths', 'check.scope']);
    expect(Object.isFrozen(CLAIM_FIELDS)).toBe(true);
  });

  it('indexes each text selection a winner states in a claimant field, once, in authored order per holder', () => {
    const probed = graph.claims.filter((claim) => !claim.source.path.startsWith('.ia/'));
    // Holders by identity; the repeated `src/**` once.
    expect(probed.map((c) => [c.from, c.field, c.selection])).toEqual([
      [mandate, 'authority.covers', 'src/**'],
      [mandate, 'authority.covers', 'docs/'],
      [check, 'check.scope', 'src/billing/*.ts'],
      [playbook, 'subject.covers', 'src/**'],
      [convention, 'subject.covers', 'src/**/*.ts'],
      [adoptedLaw, 'subject.covers', 'src/'],
      [law, 'subject.covers', '**'],
      [hook, 'hook.paths', 'src/billing/**'],
      [spec, 'work.covers', 'src/billing/invoice.ts'],
    ]);
    // A ref item, a nested `covers` and a `covers` outside a claimant section are not claims.
    expect(graph.claims.some((c) => c.selection === 'nested/**' || c.selection === 'never/**')).toBe(false);
    expect(graph.claims.find((c) => c.from === spec)).toEqual({
      from: spec,
      field: 'work.covers',
      selection: 'src/billing/invoice.ts',
      source: { path: 'claims.ia', line: 33, endLine: 33 },
    });
    // A claim's lines are its field's, not its record's.
    expect(graph.claims.find((c) => c.from === law)?.source).toEqual({ path: 'claims.ia', line: 17, endLine: 17 });
  });

  it('indexes the native corpus claims and nothing for records without claimant fields', () => {
    expect(native.claims.map((c) => [c.from, c.field, c.selection])).toEqual([
      ['agent-system/policy/mandate/sample-mandate', 'authority.covers', 'docs/**'],
      ['compliance-system/check/gate/instance-schema-check', 'check.scope', 'every admitted native record'],
    ]);
  });

  it('is deterministic under input permutation, snapshotted and outside the revision', () => {
    const reversed = fixture('reversed');
    expect(stableSerialize(reversed.claims)).toBe(stableSerialize(graph.claims));
    expect(serialize(reversed)).toBe(serialize(graph));
    expect(reversed.revision).toBe(graph.revision);
    expect(() => (graph.claims as unknown[]).pop()).toThrow();
    expect(() => {
      (graph.claims[0] as { selection: string }).selection = 'changed';
    }).toThrow();
  });
});

describe('claimants of a path (G06c)', () => {
  const brief = (path: string, scope?: ReadonlySet<string>) =>
    claimants(graph, path, scope).map((c) => [c.identity, c.band, c.matches.map((m) => `${m.field} ${m.selection}`)]);

  it('orders claimants band descending, then identity ascending, each with every claim that selects the path', () => {
    // The band-90 law sorts after every band-100 claimant, although its identity precedes the band-100 law's.
    expect(brief('src/billing/invoice.ts')).toEqual([
      [mandate, 100, ['authority.covers src/**']],
      [check, 100, ['check.scope src/billing/*.ts']],
      [playbook, 100, ['subject.covers src/**']],
      [convention, 100, ['subject.covers src/**/*.ts']],
      [law, 100, ['subject.covers **']],
      [hook, 100, ['hook.paths src/billing/**']],
      [spec, 100, ['work.covers src/billing/invoice.ts']],
      [adoptedLaw, 90, ['subject.covers src/']],
    ]);
    expect(brief('docs')).toEqual([
      [mandate, 100, ['authority.covers docs/']],
      ['agent-system/policy/mandate/sample-mandate', 100, ['authority.covers docs/**']],
      [law, 100, ['subject.covers **']],
    ]);
    expect(brief('README.md')).toEqual([[law, 100, ['subject.covers **']]]);
  });

  it('prunes holders outside the scope, and selects nothing outside the workspace', () => {
    expect(brief('src/billing/invoice.ts', new Set([hook, adoptedLaw, 'absent']))).toEqual([
      [hook, 100, ['hook.paths src/billing/**']],
      [adoptedLaw, 90, ['subject.covers src/']],
    ]);
    expect(brief('src/billing/invoice.ts', new Set())).toEqual([]);
    expect(claimants(graph, '../src/billing/invoice.ts')).toEqual([]);
    expect(claimants(graph, '/src/billing/invoice.ts')).toEqual([]);
    const result = claimants(graph, 'src/a.ts');
    expect(Object.isFrozen(result) && result.every((c) => Object.isFrozen(c) && Object.isFrozen(c.matches))).toBe(true);
  });

  it('groups several selections of one holder that select the path', () => {
    const several = graphOf([
      {
        path: 'several.ia',
        source: `@mandate several\n${meaning}\n  authority\n    covers ["src/", "src/**/*.ts", "docs/"]`,
      },
    ])();
    expect(claimants(several, 'src/a.ts').find((c) => c.identity.endsWith('/several'))?.matches).toEqual([
      { field: 'authority.covers', selection: 'src/' },
      { field: 'authority.covers', selection: 'src/**/*.ts' },
    ]);
  });
});
