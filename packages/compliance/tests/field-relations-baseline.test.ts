import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { validateConsent } from '../src/index.js';
import { inputs, records, registry } from './native.js';

// The @spec composition-field-relations baseline guard (§4.1), consent half. It
// pins COMP-CONSENT to the exact diagnostic list it reads, so a second relation
// channel cannot add or drop a finding without failing here by name rather than
// by count. The graph half of the guard lives in packages/graph/tests.
//
// Coverage is deliberately stated rather than implied. validateConsent filters on
// three codes; this file exercises the two that a real load can produce:
//   IA-GRAPH-TARGET-MISSING     — a referenced record is absent
//   IA-GRAPH-EDGE-UNCONSENTED   — an owning system refuses the relation
// The third, IA-GRAPH-TARGET-AMBIGUOUS, is not reachable through load(): its
// candidate list is built by identity lookup (packages/graph/src/load.ts), so
// candidates are deduplicated before resolution, and two distinct identities
// cannot share the discriminator, system, kind, facet and name that resolution
// matches on. The filter carries it defensively. Naming it in a constant here
// without a fixture would assert coverage against permanently empty data.
const options = { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const native = load(records, registry, options);
const CONSENT_CODES = ['IA-GRAPH-EDGE-UNCONSENTED', 'IA-GRAPH-TARGET-MISSING', 'IA-GRAPH-TARGET-AMBIGUOUS'];
const consentFindings = (graph: Parameters<typeof validateConsent>[0]) =>
  graph.diagnostics.filter((diagnostic) => CONSENT_CODES.includes(diagnostic.code));

describe('composition-field-relations baseline (@spec composition-field-relations §4.1)', () => {
  // Not a guard: on the clean corpus both sides are empty, so this cannot fail for
  // any change to the filter. It records the precondition the two guards rely on.
  it('starts from a corpus that emits no diagnostic at all', () => {
    expect(native.diagnostics).toEqual([]);
    expect(validateConsent(native).outcome).toBe('pass');
    expect(validateConsent(native).findings).toEqual([]);
  });

  it('reports IA-GRAPH-TARGET-MISSING as an exact list when a referenced record is absent', () => {
    const contractId = 'compliance-system/contract/signature/foundation-authoring-contract';
    const missing = load(
      records.filter((record) => record.identity !== contractId),
      registry,
      options,
    );
    const assessment = validateConsent(missing);
    expect(assessment.findings.map((finding) => finding.code)).toEqual(
      Array.from(assessment.findings, () => 'IA-GRAPH-TARGET-MISSING'),
    );
    expect(assessment.findings.length).toBeGreaterThan(0);
    expect(assessment.findings).toEqual(consentFindings(missing));
  });

  it('reports IA-GRAPH-EDGE-UNCONSENTED as an exact list when an owning system refuses', () => {
    // Emptying one system's consent list refuses the relations it owns; the edge is
    // dropped and only the diagnostic remains, which is the path REQ-CFR-4 protects.
    // The refusing system is recomputed, not named: the first by name whose refusal
    // drops an edge in whichever corpus is loaded, so the public conformance corpus
    // exercises the same path as the full one.
    const refusing = (system: string) => {
      const consent = new Map(registry.consent);
      consent.set(system, []);
      return load(records, { ...registry, consent }, options);
    };
    const owner = [...new Map(registry.consent).keys()]
      .sort()
      .find((system) => refusing(system).edges.length < native.edges.length);
    expect(owner, 'the corpus holds no consented relation to refuse').toBeDefined();
    const refused = refusing(owner!);
    const assessment = validateConsent(refused);
    expect(assessment.findings.map((finding) => finding.code)).toEqual(
      Array.from(assessment.findings, () => 'IA-GRAPH-EDGE-UNCONSENTED'),
    );
    expect(assessment.findings.length).toBeGreaterThan(0);
    expect(assessment.findings).toEqual(consentFindings(refused));
    expect(assessment.outcome).toBe('fail');
    // The refusal removed edges without leaving a dangling entry: consent and
    // resolution are separate registers, which is what REQ-CFR-5 keeps separate.
    expect(refused.edges.length).toBeLessThan(native.edges.length);
    expect(refused.dangling).toEqual([]);
  });
});
