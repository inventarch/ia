import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { evaluate } from '../src/index.js';
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
