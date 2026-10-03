import { expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, parse } from '@inventarch/language';
import { load, stableSerialize } from '@inventarch/graph';
import { evaluate, fixtureCoverage, runLanguageFixture, verdict } from '../src/index.js';
import type { ReportOptions } from '../src/index.js';
import { inputs, records, registry, sources } from './native.js';

const options = { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const graph = load(records, registry, options);
const folders = [...registry.systems.keys()]
  .filter((name) => name !== 'taxonomy')
  .map((name) => {
    const path = `.ia/src/systems/${name}`;
    return {
      name,
      path,
      sources: sources.filter((s) => s.ast.path.startsWith(path + '/')),
      records: records.filter((r) => r.source.path.startsWith(path + '/')),
    };
  });
const evidence: ReportOptions['evidence'] = new Map(
  ['COMP-KERNEL', 'COMP-FIXTURES'].map((check) => [
    check as 'COMP-KERNEL' | 'COMP-FIXTURES',
    verdict({ check, scope: 'test', outcome: 'pass', findings: [] }, graph.revision),
  ]),
);
it('requires explicit observations and never equates declarations with execution', () => {
  const report = evaluate(graph);
  expect(report.outcome).toBe('not-evaluated');
  for (const check of ['COMP-PARSE', 'COMP-SYSTEM', 'COMP-STEWARD', 'COMP-KERNEL', 'COMP-FIXTURES', 'COMP-ADOPTION'])
    expect(report.verdicts.some((v) => v.check === check && v.outcome === 'not-evaluated')).toBe(true);
  expect(report.verdicts.every((v) => v.revision === graph.revision)).toBe(true);
});
it('accepts supplied matching evidence, refuses stale evidence and reports failures above unknowns', () => {
  const current = evaluate(graph, { sourceDiagnostics: [], folders, evidence });
  expect(current.verdicts.filter((v) => v.outcome !== 'pass').map((v) => v.check)).toEqual(['COMP-ADOPTION']);
  const stale = new Map(evidence);
  stale.set('COMP-KERNEL', { ...stale.get('COMP-KERNEL')!, revision: 'old' });
  expect(evaluate(graph, { evidence: stale }).verdicts.find((v) => v.check === 'COMP-KERNEL')!.outcome).toBe(
    'not-evaluated',
  );
  expect(evaluate(graph, { sourceDiagnostics: parse('bad', 'bad.ia').diagnostics }).outcome).toBe('fail');
});
it('includes refused dimensions, uses stable ordering and freezes all report state', () => {
  const first = records.find((r) => r.name === 'sample-procedure')!;
  const changed = records.map((r) =>
    r !== first
      ? r
      : { ...r, head: [{ key: 'artifact-set', value: { kind: 'scalar' as const, text: 'bad' }, span: r.source }] },
  );
  const bad = load(changed, registry, options),
    report = evaluate(bad, { sourceDiagnostics: [] });
  expect(report.outcome).toBe('fail');
  expect(report.findings.filter((f) => f.code === 'IA-GRAPH-DIMENSION-UNKNOWN')).toHaveLength(1);
  expect(stableSerialize(evaluate(load([...changed].reverse(), registry, options), { sourceDiagnostics: [] }))).toBe(
    stableSerialize(report),
  );
  expect(() => (report.verdicts as unknown[]).pop()).toThrow();
  expect(() => (report.findings as unknown[]).pop()).toThrow();
});
it('runs actual fixture bytes and does not credit a mismatching case toward code coverage', () => {
  const source = '@agent missing-pragma\n',
    path = 'parser/fail/pragma.ia',
    parsed = parse(source, path);
  const good = runLanguageFixture({
    source,
    path,
    clause: 'parser',
    mode: 'fail',
    diagnostics: parsed.diagnostics.map((d) => ({ code: d.code, line: d.line })),
  });
  expect(good.assessment.outcome).toBe('pass');
  expect(fixtureCoverage(['IA-LANG-PRAGMA-MISSING'], [good]).outcome).toBe('pass');
  const bad = runLanguageFixture({ source, path, clause: 'parser', mode: 'fail', diagnostics: [] });
  expect(bad.assessment.outcome).toBe('fail');
  expect(fixtureCoverage(['IA-LANG-PRAGMA-MISSING'], [bad]).outcome).toBe('fail');
  expect(runLanguageFixture({ source: '#! ia 1.0\n', path, clause: 'parser', mode: 'pass' }).assessment.outcome).toBe(
    'fail',
  );
});
it('retains only failed/unavailable admission observations and coalesces their scopes without duplicates', () => {
  const observation = {
    check: 'COMP-SCHEMA',
    scope: 'refused',
    outcome: 'fail' as const,
    findings: [
      {
        code: 'IA-COMP-FIELD-MISSING' as const,
        path: 'refused.ia',
        line: 2,
        severity: 'error' as const,
        message: 'Missing required field',
      },
    ],
  };
  const report = evaluate(graph, {
    admission: [
      observation,
      observation,
      { check: 'COMP-SCHEMA', scope: 'candidate-only', outcome: 'pass', findings: [] },
    ],
  });
  expect(report.outcome).toBe('fail');
  expect(report.verdicts.filter((v) => v.scope === 'refused')).toHaveLength(1);
  expect(report.findings.filter((f) => f.path === 'refused.ia')).toHaveLength(1);
  expect(report.verdicts.some((v) => v.scope === 'candidate-only')).toBe(false);
});
