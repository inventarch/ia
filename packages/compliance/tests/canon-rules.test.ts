import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { canonAssessments, canonKitMethodWords, canonKitWorkspace, evaluate, isKitWorkspace } from '../src/index.js';
import { inputs, records, registry } from './native.js';

const location = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
const CODE = 'IA-COMP-CANON-WORK-PLACEMENT';
const law = (severity: string) =>
  `@law work-placement-law\n  meaning\n    says "Work records stay out of system payloads."\n    answers "Where may work records not live?"\n  governance\n    severity ${severity}\n  relationships\n    enforced-by @check work-placement-check\n`;
const check = `@check work-placement-check\n  meaning\n    says "Evaluates work placement."\n    answers "What does the work placement check evaluate?"\n  check\n    runs CANON-WORK-PLACEMENT\n    scope "fixture"\n`;
const spec = `@spec offending-spec\n  meaning\n    says "A specification inside a system folder."\n    answers "Which specification sits in a system folder?"\n  work\n    title "Offending"\n    status draft\n`;

function graphOf(...texts: readonly (readonly [string, string])[]) {
  const sources = texts.map(([path, text]) => ({ path, text: `#! ia 1.0\n${text}`, location }));
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
  return load([...records, ...compiled], registry, {
    sources: [...inputs, ...sources],
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
}
const canonFindings = (graph: ReturnType<typeof graphOf>) =>
  evaluate(graph).findings.filter((f) => f.code.startsWith('IA-COMP-CANON-'));
const system = '.ia/src/systems/work-system/records/offending-spec.ia';

describe('A14 work placement', () => {
  it('A14 reports a spec inside a system folder as error when its law is blocking', () => {
    const found = canonFindings(graphOf(['law.ia', law('blocking')], ['check.ia', check], [system, spec]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: CODE, severity: 'error', path: system });
  });
  it('A14 reports as warning when its law is advisory', () => {
    const found = canonFindings(graphOf(['law.ia', law('advisory')], ['check.ia', check], [system, spec]));
    expect(found).toMatchObject([{ code: CODE, severity: 'warning' }]);
  });
  it('no canon law in closure means no CANON findings', () => {
    expect(canonFindings(graphOf([system, spec]))).toEqual([]);
    expect(canonFindings(graphOf(['law.ia', law('informational')], ['check.ia', check], [system, spec]))).toEqual([]);
  });
  it('a spec outside system folders is not reported', () => {
    const elsewhere = '.ia/src/records/ok-spec.ia';
    expect(canonFindings(graphOf(['law.ia', law('blocking')], ['check.ia', check], [elsewhere, spec]))).toEqual([]);
  });
});

const KIT = '.ia/src/systems/kit-a';
const lawFor = (name: string, severity: string) =>
  `@law ${name}-law\n  meaning\n    says "Kit rule ${name}."\n    answers "What does the ${name} law require?"\n  governance\n    severity ${severity}\n  relationships\n    enforced-by @check ${name}-check\n`;
const checkFor = (name: string, id: string) =>
  `@check ${name}-check\n  meaning\n    says "Evaluates ${name}."\n    answers "What does the ${name} check evaluate?"\n  check\n    runs ${id}\n    scope "fixture"\n`;
const kitSystem = (extra: string, requires: readonly string[] = ['workspace-system'], name = 'kit-a') =>
  `@system ${name}\n  provider "local"\n  version "0.1.0"\n  describes "A kit."\n  requires\n${requires.map((r) => `    - ${r}\n`).join('')}${extra}`;
const plainDistribution = (name: string, systems: string) =>
  `@distribution ${name}\n  meaning\n    says "The ${name} distribution."\n    answers "What does ${name} ship?"\n  distribution\n    records [${systems}]\n`;
const productDistribution = (system: string, listed = `@system ${system}`) =>
  `${plainDistribution(`${system}-plugin`, listed)}  product\n    name ${system}\n    hosts [claude]\n`;
// A method record in the kit system: a law is a method word owned by governance-system.
const methodLaw = [`${KIT}/records/method.ia`, lawFor('kit', 'informational')] as const;
const lowered = (system: string): readonly (readonly [string, string])[] => [
  [`${KIT}/system.ia`, system],
  [`${KIT}/records/plugin.ia`, productDistribution('kit-a')],
];
const native = (system: string): readonly (readonly [string, string])[] => [
  [`${KIT}/system.ia`, system],
  [`${KIT}/records/distribution.ia`, plainDistribution('kit-a-distribution', '@system kit-a, @system kit-b')],
  ['.ia/src/systems/kit-b/system.ia', kitSystem('', ['workspace-system'], 'kit-b')],
];
const workspaceWith = (composition: string) =>
  `@workspace kit-workspace\n  meaning\n    says "The shipped kit workspace."\n    answers "What does the kit workspace compose?"\n  composition\n    systems [@system kit-a]\n${composition}`;
const ruleFindings = (graph: ReturnType<typeof graphOf>, code: string) =>
  canonFindings(graph).filter((f) => f.code === code);
const nodesOf = (graph: ReturnType<typeof graphOf>) => [...graph.nodes.values()];
const wordsLaw = [
  ['law.ia', lawFor('words', 'blocking')],
  ['check.ia', checkFor('words', 'CANON-KIT-WORDS')],
] as const;

describe('kit detection and C4/C5a', () => {
  it('isKitWorkspace recognises one system with a product distribution', () => {
    expect(isKitWorkspace(nodesOf(graphOf(...lowered(kitSystem('')))))).toBe(true);
    const plain = graphOf(
      [`${KIT}/system.ia`, kitSystem('')],
      [`${KIT}/records/plugin.ia`, plainDistribution('kit-a-plugin', '@agent kit-steward')],
    );
    expect(isKitWorkspace(nodesOf(plain))).toBe(false);
    expect(isKitWorkspace(nodesOf(graphOf(['elsewhere/plugin.ia', productDistribution('kit-a')])))).toBe(false);
  });
  it('isKitWorkspace is false for form (a) when two systems author a product distribution', () => {
    const graph = graphOf(
      [`${KIT}/system.ia`, kitSystem('')],
      [`${KIT}/records/plugin.ia`, productDistribution('kit-a', '@agent kit-steward')],
      ['.ia/src/systems/kit-b/system.ia', kitSystem('', ['workspace-system'], 'kit-b')],
      ['.ia/src/systems/kit-b/records/plugin.ia', productDistribution('kit-b', '@agent kit-steward')],
    );
    expect(isKitWorkspace(nodesOf(graph))).toBe(false);
  });
  it('isKitWorkspace recognises a native multi-system kit and not a release root outside systems', () => {
    expect(isKitWorkspace(nodesOf(graphOf(...native(kitSystem('')))))).toBe(true);
    const release = graphOf(
      [`${KIT}/system.ia`, kitSystem('')],
      ['.ia/src/releases/distribution.ia', plainDistribution('kit-a-distribution', '@system kit-a')],
    );
    expect(isKitWorkspace(nodesOf(release))).toBe(false);
  });
  it('C4 reports a kit method system that mints a word', () => {
    const system = kitSystem('  discriminators\n    widget lowers to definition\n      category state\n', [
      'workspace-system',
      'governance-system',
    ]);
    const graph = graphOf(...wordsLaw, ...lowered(system), methodLaw);
    const found = ruleFindings(graph, 'IA-COMP-CANON-KIT-WORDS');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', path: `${KIT}/system.ia` });
  });
  it('C4 reports a used word whose owner is not required', () => {
    const graph = graphOf(...wordsLaw, ...native(kitSystem('')), methodLaw);
    const found = ruleFindings(graph, 'IA-COMP-CANON-KIT-WORDS');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('governance-system');
  });
  it('C4 does not flag a vocabulary-only kit system that mints words', () => {
    const system = kitSystem('  discriminators\n    widget lowers to definition\n      category state\n');
    const graph = graphOf(...wordsLaw, ...lowered(system));
    expect(ruleFindings(graph, 'IA-COMP-CANON-KIT-WORDS')).toEqual([]);
  });
  it('C4 reads the records of a SystemFolder when one is passed', () => {
    const graph = graphOf(...wordsLaw, ...native(kitSystem('')), methodLaw);
    const nodes = nodesOf(graph);
    const folder = {
      name: 'kit-a',
      path: KIT,
      sources: [],
      records: nodes.filter((n) => n.source.path.startsWith(`${KIT}/`)),
    };
    expect(canonKitMethodWords(nodes, [folder])).toHaveLength(1);
    expect(canonKitMethodWords(nodes, [{ ...folder, records: [] }])).toEqual([]);
  });
  it('C5a reports a kit workspace with a steward or sources', () => {
    const graph = graphOf(
      ['law.ia', lawFor('ws', 'blocking')],
      ['check.ia', checkFor('ws', 'CANON-KIT-WORKSPACE')],
      ...native(kitSystem('')),
      ['.ia/src/workspace.ia', workspaceWith('    steward @agent kit-steward\n    sources [".ia/src @authored"]\n')],
    );
    expect(ruleFindings(graph, 'IA-COMP-CANON-KIT-WORKSPACE')).toHaveLength(2);
    const clean = graphOf(
      ['law.ia', lawFor('ws', 'blocking')],
      ['check.ia', checkFor('ws', 'CANON-KIT-WORKSPACE')],
      ...lowered(kitSystem('')),
      ['.ia/src/workspace.ia', workspaceWith('')],
    );
    expect(ruleFindings(clean, 'IA-COMP-CANON-KIT-WORKSPACE')).toEqual([]);
  });
  it('non-kit workspaces get no C4/C5a findings', () => {
    const nodes = nodesOf(graphOf(['.ia/src/workspace.ia', workspaceWith('    steward @agent kit-steward\n')]));
    expect(canonKitMethodWords(nodes, undefined)).toEqual([]);
    expect(canonKitWorkspace(nodes)).toEqual([]);
    expect(canonAssessments(nodes, undefined)).toEqual([]);
  });
});
