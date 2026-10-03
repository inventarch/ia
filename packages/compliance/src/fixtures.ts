import {
  BAND_OF,
  PROVENANCES,
  buildRegistry,
  checkFormatPreservation,
  compile,
  format,
  parse,
} from '@inventarch/language';
import type { Diagnostic, Location } from '@inventarch/language';
import { stableSerialize } from '@inventarch/graph';
import { assess } from './types.js';
import type { Assessment, Finding } from './types.js';

export const COMPILE_CLAUSES: ReadonlySet<string> = new Set([
  'registry',
  'schema',
  'identity',
  'compile',
  'cells',
  'selectors',
  'edges',
  'conditions',
  'variants',
  'contracts',
  'cases',
]);
export interface LanguageFixture {
  readonly path: string;
  readonly clause: string;
  readonly mode: 'pass' | 'fail';
  readonly source: string;
  readonly ast?: unknown;
  readonly records?: unknown;
  readonly diagnostics?: readonly { readonly code: string; readonly line: number }[];
  readonly pool?: readonly { readonly path: string; readonly source: string; readonly location: Location }[];
  readonly formatted?: string;
  readonly candidate?: string;
}
export interface FixtureResult {
  readonly assessment: Assessment;
  readonly observedCodes: readonly string[];
}
const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
export function runLanguageFixture(fixture: LanguageFixture): FixtureResult {
  const findings: Finding[] = [],
    observed = new Set<string>();
  const mismatch = (message: string): void => {
    findings.push({
      code: 'IA-COMP-FIXTURE-MISMATCH',
      severity: 'error',
      path: fixture.path,
      line: 1,
      message: `${fixture.path}: ${message}`,
    });
  };
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (stableSerialize(actual) !== stableSerialize(expected)) mismatch(`${label} differs from the expected product`);
  };
  try {
    const parsed = parse(fixture.source, fixture.path);
    let diagnostics: readonly Diagnostic[] = parsed.diagnostics,
      records: unknown;
    if (fixture.clause === 'format') {
      if (fixture.mode === 'pass') {
        const result = format(fixture.source, fixture.path);
        diagnostics = result.diagnostics;
        if (fixture.formatted === undefined) mismatch('Missing formatted expectation');
        else equal(result.text, fixture.formatted, 'format');
      } else if (fixture.candidate === undefined) mismatch('Missing preservation candidate');
      else diagnostics = checkFormatPreservation(fixture.source, fixture.candidate, fixture.path);
    } else if (COMPILE_CLAUSES.has(fixture.clause) && diagnostics.length === 0) {
      const poolSources = (fixture.pool ?? []).map((entry) => {
        if (
          BAND_OF[entry.location.placement.kind] !== entry.location.placement.band ||
          !PROVENANCES.includes(entry.location.provenance)
        )
          throw new TypeError('Invalid fixture pool location');
        return { ...parse(entry.source, entry.path), location: entry.location };
      });
      const registered = buildRegistry([{ ...parsed, location }, ...poolSources]);
      const poolResults = poolSources.map((s) => compile(s.ast, registered.registry, s.location, []));
      const result = compile(
        parsed.ast,
        registered.registry,
        location,
        poolResults.flatMap((r) => r.records),
      );
      records = result.records;
      diagnostics = [
        ...registered.diagnostics,
        ...poolResults.flatMap((r) => r.diagnostics),
        ...result.diagnostics,
      ].sort((a, b) => a.line - b.line);
    }
    for (const d of diagnostics) observed.add(d.code);
    if (fixture.mode === 'pass') {
      if (diagnostics.length > 0) mismatch('A passing fixture produced diagnostics');
      if (COMPILE_CLAUSES.has(fixture.clause) ? fixture.records === undefined : fixture.ast === undefined)
        mismatch('Missing mandatory expected product');
      if (fixture.ast !== undefined) equal(parsed.ast, fixture.ast, 'AST');
      if (fixture.records !== undefined) equal(records, fixture.records, 'records');
    } else {
      if (diagnostics.length === 0) mismatch('A failing fixture produced no diagnostic');
      if (fixture.diagnostics === undefined) mismatch('Missing diagnostic expectation');
      else
        equal(
          diagnostics.map((d) => ({ code: d.code, line: d.line })),
          fixture.diagnostics,
          'diagnostics',
        );
    }
  } catch (error) {
    mismatch(`Fixture could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({
    assessment: assess('COMP-FIXTURES', fixture.path, findings),
    observedCodes: Object.freeze([...observed].sort()),
  });
}
export function fixtureCoverage(required: readonly string[], results: readonly FixtureResult[]): Assessment {
  const observed = new Set(results.filter((r) => r.assessment.outcome === 'pass').flatMap((r) => r.observedCodes));
  const missing = required.filter((code) => !observed.has(code));
  return assess(
    'COMP-FIXTURES',
    'refusal-code-coverage',
    missing.map((code) => ({
      code: 'IA-COMP-FIXTURE-MISMATCH',
      severity: 'error',
      path: '',
      line: 1,
      message: `No passing failing-case observation covers ${code}`,
    })),
  );
}
