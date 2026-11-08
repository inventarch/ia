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
const kitSystem = (extra: string) =>
  `@system kit-a\n  provider "local"\n  version "0.1.0"\n  describes "A kit."\n  requires\n    - workspace-system\n${extra}`;
const plainDistribution = `@distribution kit-a-plugin\n  meaning\n    says "The kit plugin."\n    answers "What does the kit ship?"\n  distribution\n    records [@system kit-a]\n`;
const kitDistribution = `${plainDistribution}  product\n    name kit-a\n    hosts [claude]\n`;
const kitFiles = (system: string): readonly (readonly [string, string])[] => [
  [`${KIT}/system.ia`, system],
  [`${KIT}/records/plugin.ia`, kitDistribution],
];
const workspaceWith = (composition: string) =>
  `@workspace kit-workspace\n  meaning\n    says "The shipped kit workspace."\n    answers "What does the kit workspace compose?"\n  composition\n    systems [@system kit-a]\n${composition}`;
const ruleFindings = (graph: ReturnType<typeof graphOf>, code: string) =>
  canonFindings(graph).filter((f) => f.code === code);
const nodesOf = (graph: ReturnType<typeof graphOf>) => [...graph.nodes.values()];

describe('kit detection and C4/C5a', () => {
  it('isKitWorkspace recognises one system with a product distribution', () => {
    expect(isKitWorkspace(nodesOf(graphOf(...kitFiles(kitSystem('')))))).toBe(true);
    const plain = graphOf([`${KIT}/system.ia`, kitSystem('')], [`${KIT}/records/plugin.ia`, plainDistribution]);
    expect(isKitWorkspace(nodesOf(plain))).toBe(false);
    expect(isKitWorkspace(nodesOf(graphOf(['elsewhere/plugin.ia', kitDistribution])))).toBe(false);
  });
  it('C4 reports a kit method system that mints a word', () => {
    const system = kitSystem('  discriminators\n    widget lowers to definition\n      category state\n');
    const graph = graphOf(
      ['law.ia', lawFor('words', 'blocking')],
      ['check.ia', checkFor('words', 'CANON-KIT-WORDS')],
      ...kitFiles(system),
    );
    const found = ruleFindings(graph, 'IA-COMP-CANON-KIT-WORDS');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', path: `${KIT}/system.ia` });
  });
  it('C4 reports a used word whose owner is not required', () => {
    const user = `@agent kit-agent\n  meaning\n    says "A kit agent."\n    answers "Which agent does the kit hold?"\n  governance\n    applies [agent]\n`;
    const graph = graphOf(
      ['law.ia', lawFor('words', 'blocking')],
      ['check.ia', checkFor('words', 'CANON-KIT-WORDS')],
      ...kitFiles(kitSystem('')),
      [`${KIT}/records/agent.ia`, user],
    );
    const found = ruleFindings(graph, 'IA-COMP-CANON-KIT-WORDS');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('agent-system');
  });
  it('C5a reports a kit workspace with a steward or sources', () => {
    const graph = graphOf(
      ['law.ia', lawFor('ws', 'blocking')],
      ['check.ia', checkFor('ws', 'CANON-KIT-WORKSPACE')],
      ...kitFiles(kitSystem('')),
      ['.ia/src/workspace.ia', workspaceWith('    steward @agent kit-steward\n    sources [".ia/src @authored"]\n')],
    );
    expect(ruleFindings(graph, 'IA-COMP-CANON-KIT-WORKSPACE')).toHaveLength(2);
    const clean = graphOf(
      ['law.ia', lawFor('ws', 'blocking')],
      ['check.ia', checkFor('ws', 'CANON-KIT-WORKSPACE')],
      ...kitFiles(kitSystem('')),
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
