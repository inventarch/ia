import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { canonSeverity, lawStatuses } from '../src/index.js';
import type { Verdict } from '../src/index.js';
import { inputs, records, registry } from './native.js';

const location = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
const law = (name: string, severity: string, extra = '') =>
  `@law ${name}\n  meaning\n    says "Canon law ${name}."\n    answers "What does canon law ${name} require?"\n  governance\n    severity ${severity}\n${extra}`;
const enforcedBy = (check: string) => `  relationships\n    enforced-by @check ${check}\n`;
const check = (name: string, runs: string) =>
  `@check ${name}\n  meaning\n    says "Canon check ${name}."\n    answers "What does canon check ${name} evaluate?"\n  check\n    runs ${runs}\n    scope "fixture"\n`;
const improvement = (name: string, target: string, status: string) =>
  `@improvement ${name}\n  meaning\n    says "Improvement ${name}."\n    answers "What does improvement ${name} propose?"\n  proposal\n    target ${target}\n    system governance-system\n    path "x"\n    before "a"\n    candidate "b"\n    digest "d"\n    applies "now"\n    verification "v"\n    reversal "r"\n  review\n    status ${status}\n  publication\n    status draft\n  relationships\n    cites @law sample-rule\n`;
function graphOf(...texts: string[]) {
  const sources = texts.map((text, i) => ({ path: `canon-${i}.ia`, text: `#! ia 1.0\n${text}`, location }));
  // Two passes, as native.ts does: the second resolves edges between the new records.
  const pass = (pool: typeof records) =>
    sources.flatMap(
      (s) =>
        compile(
          parse(s.text, s.path).ast,
          registry,
          s.location,
          pool.filter((r) => r.source.path !== s.path),
        ).records,
    );
  const compiled = pass([...records, ...pass(records)]);
  const graph = load([...records, ...compiled], registry, {
    sources: [...inputs, ...sources],
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
  return graph;
}
const build = (...texts: string[]) => [...graphOf(...texts).nodes.values()];
const verdict = (id: string, outcome: Verdict['outcome']): Verdict =>
  ({ check: id, scope: 'graph', outcome, findings: [], revision: 'r' }) as Verdict;
const only = (nodes: ReturnType<typeof build>, name: string) =>
  lawStatuses(nodes, [verdict('COMP-VARIANT', 'pass')]).find((s) => s.identity.endsWith(`/${name}`))!;

describe('canon law status and severity', () => {
  it('a law without enforced-by is pending', () => {
    const nodes = build(law('lonely-law', 'blocking'));
    expect(only(nodes, 'lonely-law')).toMatchObject({
      severity: 'blocking',
      state: 'pending',
      checks: [],
      suspendedBy: null,
    });
  });
  it('a law enforced by a built-in check with a verdict is enforced', () => {
    const nodes = build(
      law('schema-law', 'advisory', enforcedBy('schema-runner')),
      check('schema-runner', 'COMP-VARIANT'),
    );
    const status = only(nodes, 'schema-law');
    expect(status.state).toBe('enforced');
    expect(status.checks).toHaveLength(1);
    expect(canonSeverity(nodes, 'COMP-VARIANT')).toBe('warning');
  });
  it('a law enforced by a non-built-in or unavailable check is not-evaluated', () => {
    const nodes = build(law('far-law', 'blocking', enforcedBy('far-runner')), check('far-runner', 'NOT-A-BUILTIN'));
    expect(only(nodes, 'far-law').state).toBe('not-evaluated');
    const builtin = build(law('near-law', 'blocking', enforcedBy('near-runner')), check('near-runner', 'COMP-VARIANT'));
    const unavailable = lawStatuses(builtin, [verdict('COMP-VARIANT', 'not-evaluated')]);
    expect(unavailable.find((s) => s.identity.endsWith('/near-law'))!.state).toBe('not-evaluated');
    expect(lawStatuses(builtin, []).find((s) => s.identity.endsWith('/near-law'))!.state).toBe('not-evaluated');
  });
  it('a suspended blocking law yields warning severity and state suspended', () => {
    const plain = build(law('hard-law', 'blocking', enforcedBy('hard-runner')), check('hard-runner', 'COMP-VARIANT'));
    expect(canonSeverity(plain, 'COMP-VARIANT')).toBe('error');
    const lawId = plain.find((n) => n.name === 'hard-law')!.identity;
    const nodes = build(
      law('hard-law', 'blocking', enforcedBy('hard-runner')),
      check('hard-runner', 'COMP-VARIANT'),
      improvement('pause-hard-law', lawId, 'suspended'),
    );
    const status = only(nodes, 'hard-law');
    expect(status.state).toBe('suspended');
    expect(status.suspendedBy).toMatch(/\/pause-hard-law$/);
    expect(canonSeverity(nodes, 'COMP-VARIANT')).toBe('warning');
    const open = build(
      law('hard-law', 'blocking', enforcedBy('hard-runner')),
      check('hard-runner', 'COMP-VARIANT'),
      improvement('pause-hard-law', lawId, 'proposed'),
    );
    expect(only(open, 'hard-law').state).toBe('enforced');
  });
  it('a blocking law enforced by one built-in and one non-built-in check yields warning, not error', () => {
    const twoChecks = `  relationships\n    enforced-by @check mixed-builtin\n    enforced-by @check mixed-external\n`;
    const nodes = build(
      law('mixed-law', 'blocking', twoChecks),
      check('mixed-builtin', 'COMP-VARIANT'),
      check('mixed-external', 'NOT-A-BUILTIN'),
    );
    expect(only(nodes, 'mixed-law').checks).toHaveLength(2);
    expect(canonSeverity(nodes, 'COMP-VARIANT')).toBe('warning');
    const graph = graphOf(
      law('mixed-law', 'blocking', twoChecks),
      check('mixed-builtin', 'COMP-VARIANT'),
      check('mixed-external', 'NOT-A-BUILTIN'),
    );
    expect(canonSeverity([...graph.nodes.values()], 'COMP-VARIANT', graph)).toBe('warning');
    const builtins = build(
      law('mixed-law', 'blocking', twoChecks),
      check('mixed-builtin', 'COMP-VARIANT'),
      check('mixed-external', 'COMP-SCHEMA'),
    );
    expect(canonSeverity(builtins, 'COMP-VARIANT')).toBe('error');
  });
  it('informational or absent law makes the check inactive', () => {
    const nodes = build(
      law('soft-law', 'informational', enforcedBy('soft-runner')),
      check('soft-runner', 'COMP-VARIANT'),
    );
    expect(canonSeverity(nodes, 'COMP-VARIANT')).toBeNull();
    expect(canonSeverity(nodes, 'COMP-OTHER')).toBeNull();
  });
});

describe("canon severity over the graph's resolved edges", () => {
  const texts = [law('hard-law', 'blocking', enforcedBy('hard-runner')), check('hard-runner', 'COMP-VARIANT')];
  const unresolved = (nodes: ReturnType<typeof build>) =>
    nodes.map((node) => ({ ...node, edges: node.edges.map((edge) => ({ ...edge, target: null })) }));
  it('uses the graph edges when nodes carry no targets, as in the db view', () => {
    const graph = graphOf(...texts);
    const nodes = unresolved([...graph.nodes.values()]);
    expect(canonSeverity(nodes, 'COMP-VARIANT')).toBeNull();
    expect(canonSeverity(nodes, 'COMP-VARIANT', graph)).toBe('error');
    expect(lawStatuses(nodes, [], graph).find((s) => s.identity.endsWith('/hard-law'))!.checks).toHaveLength(1);
  });
  it('a same-named check in another system, which the graph does not resolve to, changes nothing', () => {
    const graph = graphOf(...texts);
    const [decoy] = build(check('hard-runner', 'COMP-OTHER')).filter(
      (n) => n.discriminator === 'check' && n.name === 'hard-runner',
    );
    const nodes = [
      ...unresolved([...graph.nodes.values()]),
      { ...decoy!, identity: 'other-system/check/gate/hard-runner' },
    ];
    expect(canonSeverity(nodes, 'COMP-VARIANT', graph)).toBe('error');
    expect(canonSeverity(nodes, 'COMP-OTHER', graph)).toBeNull();
  });
});
