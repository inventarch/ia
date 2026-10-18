import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  KERNEL_DIGEST,
  KERNEL_SOURCES,
  LANGUAGE_VERSION,
  LANG_CODES,
  buildRegistry,
  compile,
  parse,
} from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { GRAPH_CODES, load, stableSerialize } from '@inventarch/graph';
import type { RevisionInputs, RevisionSource } from '@inventarch/graph';
import {
  COMP_CODES,
  EVIDENCE_CODES,
  evaluate,
  fixtureCoverage,
  isConformanceEvidence,
  runLanguageFixture,
  verdict,
  verifyFixtures,
  verifyKernel,
} from '../src/index.js';
import { INVENTORY, INVENTORY_DIGEST } from '../src/conformance/inventory.generated.js';
import { inventoryDigest } from '../src/conformance/inventory.js';
import type { ConformanceInventory } from '../src/conformance/inventory.js';
import { runProfile } from '../src/conformance/verify.js';
import type { KernelSource, Report, ReportOptions } from '../src/index.js';
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
describe('kernel verification (C31)', () => {
  const changed = KERNEL_SOURCES.map((s) =>
    s.path.endsWith('/kind.ia') ? { ...s, text: s.text.replace("A standing 'ought'", "A standing 'Ought'") } : s,
  );
  it('passes the embedded floor and records its digest', () => {
    const evidence = verifyKernel();
    expect(evidence.assessment).toMatchObject({ check: 'COMP-KERNEL', outcome: 'pass' });
    expect(evidence.floorDigest).toBe(KERNEL_DIGEST);
    expect(verifyKernel(KERNEL_SOURCES).floorDigest).toBe(KERNEL_DIGEST);
  });
  it('fails a floor with one byte changed, and one that does not regenerate', () => {
    expect(changed.map((s) => s.text).join('')).not.toBe(KERNEL_SOURCES.map((s) => s.text).join(''));
    const evidence = verifyKernel(changed);
    expect(evidence.assessment.outcome).toBe('fail');
    expect(evidence.assessment.findings.map((f) => f.message).join()).toContain('KERNEL_DIGEST');
    expect(evidence.floorDigest).not.toBe(KERNEL_DIGEST);
    const broken = verifyKernel(KERNEL_SOURCES.filter((s) => !s.path.endsWith('/move.ia')));
    expect(broken.assessment.outcome).toBe('fail');
    expect(broken.assessment.findings[0]!.message).toContain('MOVES');
  });
  it('fails when the running language exports differ from regeneration', async () => {
    vi.resetModules();
    vi.doMock('@inventarch/language', async (original) => {
      const actual = await original<Record<string, unknown>>();
      return { ...actual, KINDS: [...(actual['KINDS'] as string[])].reverse() };
    });
    try {
      const mocked = await import('../src/index.js');
      expect(mocked.verifyKernel().assessment.findings.map((f) => f.message)).toEqual([
        'Kernel verification: KINDS differs from regeneration',
      ]);
    } finally {
      vi.doUnmock('@inventarch/language');
      vi.resetModules();
    }
  });
  it('fails when the running verb phrases differ from the regenerated present phrases', async () => {
    vi.resetModules();
    vi.doMock('@inventarch/language', async (original) => {
      const actual = await original<Record<string, unknown>>();
      const verbOf = actual['verbOf'] as (phrase: string) => unknown;
      return {
        ...actual,
        VERB_PHRASES: (actual['VERB_PHRASES'] as string[]).map((p) => (p === 'governs' ? 'governz' : p)),
        verbOf: (phrase: string) => (phrase === 'governs' ? undefined : verbOf(phrase)),
      };
    });
    try {
      const mocked = await import('../src/index.js');
      expect(mocked.verifyKernel().assessment.findings.map((f) => f.message)).toEqual([
        'Kernel verification: PRESENT_PHRASES differs from regeneration',
      ]);
    } finally {
      vi.doUnmock('@inventarch/language');
      vi.resetModules();
    }
  });
});
describe('package-v1 suites (C31)', () => {
  it('are compiled package code that imports no repository tool or test', () => {
    const base = resolve(import.meta.dirname, '../src');
    const files = readdirSync(base, { recursive: true, encoding: 'utf8' })
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['conformance/refusals.ts', 'conformance/evidence-fixtures.ts']));
    for (const file of files) {
      const text = readFileSync(resolve(base, file), 'utf8');
      expect(text, file).not.toMatch(/from '[^']*\/(tools|tests|fixtures)\//);
      // A package-internal subpath resolves only to a built dist, which kernel:check and the other prebuild steps lack.
      expect(text, file).not.toMatch(/from '@inventarch\/[^']+\/internal\//);
    }
  });
});
describe('fixture verification (C31)', () => {
  const directory = new URL('../fixtures/language/', import.meta.url);
  const messages = (result: { assessment: { findings: readonly { message: string }[] } }) =>
    result.assessment.findings.map((f) => f.message).sort();
  const tampered = (change: (inventory: ConformanceInventory) => ConformanceInventory) => {
    const inventory = change(INVENTORY);
    return { inventory, digest: inventoryDigest(inventory) };
  };
  const copy = (edit: (root: string) => void) => {
    const temp = mkdtempSync(join(tmpdir(), 'ia-profile-'));
    cpSync(fileURLToPath(directory), temp, { recursive: true });
    edit(temp);
    return { temp, url: pathToFileURL(temp + '/') };
  };
  it('passes the package-v1 profile, observes every required code and lists what it does not run', () => {
    const evidence = verifyFixtures();
    expect(evidence.assessment).toMatchObject({ check: 'COMP-FIXTURES', scope: 'package-v1', outcome: 'pass' });
    expect(evidence.profile).toBe('package-v1');
    expect(evidence.inventoryDigest).toBe(INVENTORY_DIGEST);
    expect(INVENTORY.requiredCodes).toHaveLength(
      LANG_CODES.length + GRAPH_CODES.length + COMP_CODES.length + EVIDENCE_CODES.length,
    );
    expect(evidence.observedCodes).toEqual(expect.arrayContaining([...INVENTORY.requiredCodes]));
    expect(evidence.outOfProfile.map((s) => s.suite)).toEqual(['HOOK', 'RUNTIME', 'escalation', 'EXEC', 'PUBLICATION']);
    expect(evidence.outOfProfile.every((s) => s.codes.length > 0 && s.reason.length > 0)).toBe(true);
  });
  it('fails a changed companion file', () => {
    const { temp, url } = copy((root) => appendFileSync(join(root, 'format/fail/lost-comment.candidate.txt'), ' '));
    try {
      expect(messages(runProfile(INVENTORY, INVENTORY_DIGEST, url))).toEqual([
        'No passing failing-case observation covers IA-LANG-FORMAT-LOSSY',
        'format/fail/lost-comment.candidate.txt: differs from the inventory',
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it('fails when the sole failing case for a code is removed', () => {
    const { inventory, digest } = tampered((i) => ({
      ...i,
      fixtures: i.fixtures.filter((f) => f.path !== 'format/fail/lost-comment.ia'),
    }));
    const { temp, url } = copy((root) => {
      for (const suffix of ['.ia', '.diagnostics.json', '.candidate.txt'])
        rmSync(join(root, 'format/fail/lost-comment' + suffix));
    });
    try {
      expect(messages(runProfile(inventory, digest, url))).toEqual([
        'No passing failing-case observation covers IA-LANG-FORMAT-LOSSY',
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it('fails an extra path, a missing file and a duplicate inventory path', () => {
    const { temp, url } = copy((root) => {
      writeFileSync(join(root, 'format/fail/extra.txt'), '');
      rmSync(join(root, 'format/pass/token-spacing.formatted.txt'));
    });
    try {
      expect(messages(runProfile(INVENTORY, INVENTORY_DIGEST, url))).toEqual([
        'format/fail/extra.txt: unexpected fixture entry or orphan companion',
        'format/pass/token-spacing.formatted.txt: missing',
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    const { inventory, digest } = tampered((i) => ({ ...i, fixtures: [...i.fixtures, i.fixtures[0]!] }));
    expect(messages(runProfile(inventory, digest, directory))).toEqual([
      `${INVENTORY.fixtures[0]!.path}: duplicate inventory path`,
    ]);
  });
  it('fails an inventory that differs from its digest, or from the running code inventories', () => {
    const changed = { ...INVENTORY, outOfProfile: INVENTORY.outOfProfile.slice(1) };
    expect(messages(runProfile(changed, INVENTORY_DIGEST, directory))).toEqual([
      'The inventory differs from the digest it is pinned by',
    ]);
    const { inventory, digest } = tampered((i) => ({ ...i, requiredCodes: i.requiredCodes.slice(1) }));
    expect(messages(runProfile(inventory, digest, directory))).toEqual([
      "The inventory's required codes differ from the running toolchain's",
    ]);
  });
  it('fails a boundary case the inventory does not list, or one that no longer runs', () => {
    const { inventory, digest } = tampered((i) => ({
      ...i,
      boundaries: [...i.boundaries.slice(1), 'boundary/IA-COMP-INVENTED'].sort(),
    }));
    expect(messages(runProfile(inventory, digest, directory))).toEqual(
      [
        'boundary/IA-COMP-INVENTED: listed boundary case did not run',
        `${INVENTORY.boundaries[0]}: boundary case is not in the inventory`,
      ].sort(),
    );
  });
  it('fails a companion its clause and mode do not admit, and a fixture listed under another clause', () => {
    const extra = '{}\n';
    const { temp, url } = copy((root) => writeFileSync(join(root, 'identity/fail/facet-undeclared.ast.json'), extra));
    try {
      const companion = tampered((i) => ({
        ...i,
        fixtures: i.fixtures.map((f) =>
          f.path !== 'identity/fail/facet-undeclared.ia'
            ? f
            : { ...f, files: { ...f.files, '.ast.json': createHash('sha256').update(extra).digest('hex') } },
        ),
      }));
      // The refused fixture does not run, so the code only it observes is uncovered too.
      expect(messages(runProfile(companion.inventory, companion.digest, url))).toEqual([
        'No passing failing-case observation covers IA-LANG-FACET-UNDECLARED',
        'identity/fail/facet-undeclared.ast.json: .ast.json is not a companion of identity/fail fixtures',
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    const moved = tampered((i) => ({
      ...i,
      fixtures: i.fixtures.map((f) => (f.path !== 'records/pass/full.ia' ? f : { ...f, clause: 'strings' })),
    }));
    expect(messages(runProfile(moved.inventory, moved.digest, directory))).toEqual([
      'records/pass/full.ia: listed as a strings/pass fixture',
    ]);
  });
  it('is not evaluated, not failed, when one listed fixture file cannot be read', async () => {
    const unreadable = resolve(fileURLToPath(directory), 'format/fail/lost-comment.diagnostics.json');
    vi.resetModules();
    vi.doMock('node:fs', async (original) => {
      const actual = await original<typeof import('node:fs')>();
      const readFileSync = ((path: unknown, ...rest: unknown[]) => {
        if (resolve(String(path)) === unreadable)
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof actual.readFileSync;
      return { ...actual, default: { ...actual, readFileSync }, readFileSync };
    });
    try {
      const mocked = await import('../src/conformance/verify.js');
      const result = mocked.runProfile(INVENTORY, INVENTORY_DIGEST, directory);
      expect(result.assessment.outcome).toBe('not-evaluated');
      expect(result.assessment.findings.map((f) => [f.code, f.path])).toEqual([
        ['IA-COMP-NOT-EVALUATED', 'format/fail/lost-comment.diagnostics.json'],
      ]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
  it('is not evaluated when the fixture files cannot be read', () => {
    const result = runProfile(INVENTORY, INVENTORY_DIGEST, new URL('./missing/', directory));
    expect(result.assessment.outcome).toBe('not-evaluated');
    expect(result.assessment.findings.map((f) => f.code)).toEqual(['IA-COMP-NOT-EVALUATED']);
  });
});
describe('conformance evidence objects (C31)', () => {
  const kernel = verifyKernel(),
    fixtures = verifyFixtures();
  const frozen = (value: unknown, path = 'evidence'): string[] =>
    typeof value !== 'object' || value === null
      ? []
      : [
          ...(Object.isFrozen(value) ? [] : [path]),
          ...Object.entries(value).flatMap(([key, item]) => frozen(item, `${path}.${key}`)),
        ];
  it('accepts only what verifyKernel and verifyFixtures produced, each for its own kind', () => {
    expect(isConformanceEvidence(kernel)).toBe(true);
    expect(isConformanceEvidence(kernel, 'COMP-KERNEL')).toBe(true);
    expect(isConformanceEvidence(kernel, 'COMP-FIXTURES')).toBe(false);
    expect(isConformanceEvidence(fixtures, 'COMP-FIXTURES')).toBe(true);
    expect(isConformanceEvidence(fixtures, 'COMP-KERNEL')).toBe(false);
  });
  it('refuses a structured clone, a spread copy and a hand-built object', () => {
    for (const evidence of [kernel, fixtures]) {
      expect(isConformanceEvidence(structuredClone(evidence))).toBe(false);
      expect(isConformanceEvidence({ ...evidence })).toBe(false);
      expect(isConformanceEvidence(JSON.parse(JSON.stringify(evidence)))).toBe(false);
    }
    expect(isConformanceEvidence(null)).toBe(false);
    expect(isConformanceEvidence('COMP-KERNEL')).toBe(false);
  });
  it('freezes the evidence at every depth', () => {
    expect(frozen(kernel)).toEqual([]);
    expect(frozen(fixtures)).toEqual([]);
    expect(() => (fixtures.observedCodes as string[]).push('IA-COMP-INVENTED')).toThrow();
  });
});
describe('evaluate binds conformance evidence to the graph (C31)', () => {
  const floorAt: Location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
  const authoredAt: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  /** A graph over `floor` and `extra`, loaded for the given toolchain, with the revision inputs it was loaded from. */
  function floorGraph(
    floor: readonly KernelSource[],
    extra: readonly RevisionSource[] = [],
    toolchain = { kernelDigest: KERNEL_DIGEST as string, languageVersion: LANGUAGE_VERSION as string },
  ) {
    const sources = [...floor.map((s) => ({ path: s.path, text: s.text, location: floorAt })), ...extra];
    const parsed = sources.map((s) => ({ ...parse(s.text, s.path), location: s.location }));
    const vocabulary = buildRegistry(parsed).registry;
    const first = parsed.flatMap((s) => compile(s.ast, vocabulary, s.location, []).records);
    const compiled = parsed.flatMap(
      (s) =>
        compile(
          s.ast,
          vocabulary,
          s.location,
          first.filter((r) => r.source.path !== s.ast.path),
        ).records,
    );
    const inputs: RevisionInputs = { sources, ...toolchain };
    return { graph: load(compiled, vocabulary, { ...inputs, location: '' }), inputs };
  }
  const changed = KERNEL_SOURCES.map((s) =>
    s.path.endsWith('/kind.ia') ? { ...s, text: s.text.replace("A standing 'ought'", "A standing 'Ought'") } : s,
  );
  const embedded = floorGraph(KERNEL_SOURCES),
    local = floorGraph(changed),
    kernel = verifyKernel(),
    fixtures = verifyFixtures();
  const fixturesSummary = {
    inventoryDigest: INVENTORY_DIGEST,
    observedCodes: fixtures.observedCodes,
    outOfProfile: fixtures.outOfProfile,
  };
  const verdictsOf = (report: Report) =>
    Object.fromEntries(
      report.verdicts
        .filter((v) => v.check === 'COMP-KERNEL' || v.check === 'COMP-FIXTURES')
        .map((v) => [v.check, { outcome: v.outcome, basis: v.basis, messages: v.findings.map((f) => f.message) }]),
    );
  const notEvaluated = (check: string, reason: string) => ({
    outcome: 'not-evaluated',
    basis: undefined,
    messages: [`${check}: ${reason}`],
  });
  const digest = (value: unknown) => createHash('sha256').update(stableSerialize(value)).digest('hex');
  it('keeps the outcome and digest of reports that pass neither option', () => {
    // These snapshots bind the current kernel digest through every report revision.
    expect(digest(evaluate(graph))).toBe('223f0321cc0f05a0cc19fc604035a9d843c1c2e3a0f23a055ab182842a69119f');
    expect(digest(evaluate(graph, { sourceDiagnostics: [], folders }))).toBe(
      '54b002ee23d811e4e5166b27fe55b580cc342ee82a7478bec460caded4402653',
    );
    const report = evaluate(embedded.graph);
    expect(report.conformance).toBeUndefined();
    expect(verdictsOf(report)).toEqual({
      'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', 'matching-revision verification evidence was not supplied'),
      'COMP-KERNEL': notEvaluated('COMP-KERNEL', 'matching-revision verification evidence was not supplied'),
    });
  });
  it('passes both checks with verified evidence for the graph and reports the conformance summary', () => {
    const report = evaluate(embedded.graph, { conformance: { inputs: embedded.inputs, kernel, fixtures } });
    expect(verdictsOf(report)).toEqual({
      'COMP-FIXTURES': { outcome: 'pass', basis: 'verified', messages: [] },
      'COMP-KERNEL': { outcome: 'pass', basis: 'verified', messages: [] },
    });
    expect(report.conformance).toEqual({
      profile: 'package-v1',
      toolchain: kernel.toolchain,
      kernel: { floorDigest: KERNEL_DIGEST },
      fixtures: fixturesSummary,
    });
    expect(Object.isFrozen(report.conformance)).toBe(true);
  });
  it('labels results from the caller-asserted evidence map without changing their outcome', () => {
    const report = evaluate(graph, { sourceDiagnostics: [], folders, evidence });
    expect(verdictsOf(report)).toEqual({
      'COMP-FIXTURES': { outcome: 'pass', basis: 'caller-asserted', messages: [] },
      'COMP-KERNEL': { outcome: 'pass', basis: 'caller-asserted', messages: [] },
    });
    expect(report.conformance).toBeUndefined();
    const claimed = new Map([...evidence!].map(([check, v]) => [check, { ...v, basis: 'verified' as const }]));
    expect(verdictsOf(evaluate(graph, { evidence: claimed }))['COMP-KERNEL']!.basis).toBe('caller-asserted');
  });
  it('refuses hand-built, copied or swapped evidence, malformed inputs, and evidence with conformance', () => {
    const inputs = embedded.inputs;
    for (const conformance of [
      { inputs, kernel: { ...kernel }, fixtures },
      { inputs, kernel: structuredClone(kernel), fixtures },
      { inputs, kernel, fixtures: { ...fixtures } },
      { inputs, kernel: { ...kernel, assessment: { ...kernel.assessment, outcome: 'pass' } }, fixtures },
      { inputs, kernel: fixtures, fixtures: kernel },
      { inputs, kernel: fixtures, fixtures },
      { inputs, kernel, fixtures: kernel },
      { inputs: undefined, kernel, fixtures },
    ])
      expect(() => evaluate(embedded.graph, { conformance } as unknown as ReportOptions)).toThrow(TypeError);
    expect(() => evaluate(embedded.graph, { evidence, conformance: { inputs, kernel, fixtures } })).toThrow('not both');
  });
  it("leaves another graph's evidence and a foreign toolchain not evaluated", () => {
    const revision = "the conformance inputs do not recompute this graph's revision";
    expect(verdictsOf(evaluate(graph, { conformance: { inputs: embedded.inputs, kernel, fixtures } }))).toEqual({
      'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', revision),
      'COMP-KERNEL': notEvaluated('COMP-KERNEL', revision),
    });
    const toolchain = 'the graph was loaded for another language version or kernel digest than the running one';
    for (const foreign of [
      floorGraph(KERNEL_SOURCES, [], { kernelDigest: 'f'.repeat(64), languageVersion: LANGUAGE_VERSION }),
      floorGraph(KERNEL_SOURCES, [], { kernelDigest: KERNEL_DIGEST, languageVersion: '0.9' }),
    ])
      expect(
        verdictsOf(evaluate(foreign.graph, { conformance: { inputs: foreign.inputs, kernel, fixtures } })),
      ).toEqual({
        'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', toolchain),
        'COMP-KERNEL': notEvaluated('COMP-KERNEL', toolchain),
      });
  });
  it('leaves evidence produced by a stale toolchain not evaluated', async () => {
    const running = { kernelDigest: KERNEL_DIGEST as string, languageVersion: LANGUAGE_VERSION as string };
    vi.resetModules();
    vi.doMock('@inventarch/language', async (original) => {
      const actual = await original<Record<string, unknown>>();
      return Object.defineProperties(
        { ...actual },
        {
          KERNEL_DIGEST: { get: () => running.kernelDigest, enumerable: true },
          LANGUAGE_VERSION: { get: () => running.languageVersion, enumerable: true },
        },
      );
    });
    try {
      const mocked = await import('../src/index.js');
      const stale = { kernel: mocked.verifyKernel(), fixtures: mocked.verifyFixtures() };
      expect(stale.kernel.toolchain.kernelDigest).toBe(KERNEL_DIGEST);
      for (const change of [{ kernelDigest: 'e'.repeat(64) }, { languageVersion: '1.1' }]) {
        Object.assign(running, change);
        const current = floorGraph(KERNEL_SOURCES, [], { ...running });
        expect(
          verdictsOf(mocked.evaluate(current.graph, { conformance: { inputs: current.inputs, ...stale } })),
        ).toEqual({
          'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', 'the evidence was produced by another toolchain'),
          'COMP-KERNEL': notEvaluated('COMP-KERNEL', 'the evidence was produced by another toolchain'),
        });
        Object.assign(running, { kernelDigest: KERNEL_DIGEST, languageVersion: LANGUAGE_VERSION });
      }
    } finally {
      vi.doUnmock('@inventarch/language');
      vi.resetModules();
    }
  });
  it('leaves embedded-floor evidence for a local floor, and an ambiguous floor source, not evaluated', () => {
    const onLocal = evaluate(local.graph, { conformance: { inputs: local.inputs, kernel, fixtures } });
    expect(verdictsOf(onLocal)).toEqual({
      'COMP-FIXTURES': { outcome: 'pass', basis: 'verified', messages: [] },
      'COMP-KERNEL': notEvaluated('COMP-KERNEL', 'the kernel evidence verified another floor'),
    });
    // The bound fixture pass still names what the profile does not run.
    expect(onLocal.conformance).toEqual({
      profile: 'package-v1',
      toolchain: kernel.toolchain,
      fixtures: fixturesSummary,
    });
    for (const [path, location] of [
      ['.ia/src/notes.ia', floorAt],
      ['.ia/src/floor/notes.ia', authoredAt],
    ] as const) {
      const ambiguous = floorGraph(KERNEL_SOURCES, [{ path, text: '#! ia 1.0\n', location }]);
      const report = evaluate(ambiguous.graph, { conformance: { inputs: ambiguous.inputs, kernel, fixtures } });
      expect(verdictsOf(report)['COMP-KERNEL'], path).toEqual(
        notEvaluated('COMP-KERNEL', `floor source ${path} has a floor path or a floor placement, not both`),
      );
      expect(report.conformance?.kernel).toBeUndefined();
    }
  });
  it('fails COMP-KERNEL for a local floor with one byte changed, and for language exports that differ', async () => {
    const report = evaluate(local.graph, {
      conformance: { inputs: local.inputs, kernel: verifyKernel(changed), fixtures },
    });
    expect(verdictsOf(report)['COMP-KERNEL']).toMatchObject({ outcome: 'fail', basis: 'verified' });
    expect(report.outcome).toBe('fail');
    vi.resetModules();
    vi.doMock('@inventarch/language', async (original) => {
      const actual = await original<Record<string, unknown>>();
      return { ...actual, PHASES: ['orient'] };
    });
    try {
      const mocked = await import('../src/index.js');
      const mismatched = mocked.evaluate(embedded.graph, {
        conformance: { inputs: embedded.inputs, kernel: mocked.verifyKernel(), fixtures: mocked.verifyFixtures() },
      });
      expect(verdictsOf(mismatched)['COMP-KERNEL']).toEqual({
        outcome: 'fail',
        basis: 'verified',
        messages: ['Kernel verification: PHASES differs from regeneration'],
      });
    } finally {
      vi.doUnmock('@inventarch/language');
      vi.resetModules();
    }
  });
  it('reads the inputs once, so getters cannot show the binding other inputs than the revision', () => {
    // Each getter returns the tampered value first and the embedded floor or running version afterwards.
    let sourceReads = 0,
      textReads = 0,
      versionReads = 0;
    const bySources = {
      languageVersion: local.inputs.languageVersion,
      kernelDigest: local.inputs.kernelDigest,
      get sources() {
        sourceReads++;
        return sourceReads <= 2 ? local.inputs.sources : embedded.inputs.sources;
      },
    };
    const tampered = local.inputs.sources.find((s) => s.path.endsWith('/kind.ia'))!,
      original = embedded.inputs.sources.find((s) => s.path.endsWith('/kind.ia'))!;
    const byText = {
      ...local.inputs,
      sources: local.inputs.sources.map((s) =>
        s !== tampered
          ? s
          : {
              path: s.path,
              location: s.location,
              get text() {
                textReads++;
                return textReads === 1 ? tampered.text : original.text;
              },
            },
      ),
    };
    const old = floorGraph(KERNEL_SOURCES, [], { kernelDigest: KERNEL_DIGEST, languageVersion: '0.0.1' });
    const byVersion = {
      sources: old.inputs.sources,
      kernelDigest: KERNEL_DIGEST,
      get languageVersion() {
        versionReads++;
        return versionReads === 1 ? '0.0.1' : LANGUAGE_VERSION;
      },
    };
    for (const inputs of [bySources, byText]) {
      const report = evaluate(local.graph, { conformance: { inputs, kernel, fixtures } });
      expect(verdictsOf(report)['COMP-KERNEL']).toEqual(
        notEvaluated('COMP-KERNEL', 'the kernel evidence verified another floor'),
      );
      expect(report.conformance?.kernel).toBeUndefined();
    }
    const toolchain = 'the graph was loaded for another language version or kernel digest than the running one';
    expect(verdictsOf(evaluate(old.graph, { conformance: { inputs: byVersion, kernel, fixtures } }))).toEqual({
      'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', toolchain),
      'COMP-KERNEL': notEvaluated('COMP-KERNEL', toolchain),
    });
    expect([sourceReads, textReads, versionReads]).toEqual([1, 1, 1]);
  });
  it('copies the sources without Array methods, so a species constructor cannot swap them after validation', () => {
    // Array methods build their result through constructor[Symbol.species]. This array's species hands back, in place
    // of the validated copies, the caller's own objects, whose text getter shows the tampered floor first.
    const tampered = local.inputs.sources.find((s) => s.path.endsWith('/kind.ia'))!,
      original = embedded.inputs.sources.find((s) => s.path.endsWith('/kind.ia'))!;
    let textReads = 0;
    const own = local.inputs.sources.map((s) =>
      s !== tampered
        ? s
        : {
            path: s.path,
            location: s.location,
            get text() {
              textReads++;
              return textReads === 1 ? tampered.text : original.text;
            },
          },
    );
    // The first array a copy makes passes the caller's objects through; the second swaps each validated element, as it
    // is defined, for the caller's object at that index; later ones are plain arrays.
    let made = 0;
    function Species(length: number): unknown[] {
      made++;
      if (made > 2) return new Array<unknown>(length);
      const swap = made === 2;
      return new Proxy(new Array<unknown>(length), {
        defineProperty: (target, key, descriptor) =>
          Reflect.defineProperty(
            target,
            key,
            swap && typeof key === 'string' && /^\d+$/.test(key) && 'value' in descriptor
              ? { ...descriptor, value: own[Number(key)] }
              : descriptor,
          ),
        get: (target, key, receiver) =>
          key === 'constructor' ? { [Symbol.species]: Species } : Reflect.get(target, key, receiver),
      });
    }
    const sources: unknown[] = [...local.inputs.sources];
    Object.defineProperty(sources, 'constructor', { value: { [Symbol.species]: Species } });
    const inputs = { ...local.inputs, sources: sources as unknown as typeof local.inputs.sources };
    const report = evaluate(local.graph, { conformance: { inputs, kernel, fixtures } });
    expect(verdictsOf(report)['COMP-KERNEL']).toEqual(
      notEvaluated('COMP-KERNEL', 'the kernel evidence verified another floor'),
    );
    expect(report.conformance?.kernel).toBeUndefined();
    // The copy reads the given array by index, so the caller's swapped-in objects are never reached.
    expect(textReads).toBe(0);
  });
  it('refuses revision inputs whose fields are not plain strings and locations', () => {
    const inputs = embedded.inputs,
      first = inputs.sources[0]!;
    for (const bad of [
      { ...inputs, languageVersion: 1 },
      { ...inputs, kernelDigest: undefined },
      { ...inputs, sources: 'not a list' },
      { ...inputs, sources: [{ ...first, text: 1 }] },
      { ...inputs, sources: [{ ...first, path: undefined }] },
      { ...inputs, sources: [{ ...first, location: { ...floorAt, placement: { ...floorAt.placement, band: '10' } } }] },
    ])
      expect(() =>
        evaluate(embedded.graph, { conformance: { inputs: bad, kernel, fixtures } } as unknown as ReportOptions),
      ).toThrow(TypeError);
  });
  it('leaves only the stale object not evaluated when one was produced by another toolchain', () => {
    const version = Object.getOwnPropertyDescriptor(process, 'version')!;
    const underOtherNode = <T>(produce: () => T): T => {
      Object.defineProperty(process, 'version', { ...version, value: 'v0.0.0' });
      try {
        return produce();
      } finally {
        Object.defineProperty(process, 'version', version);
      }
    };
    const stale = 'the evidence was produced by another toolchain';
    const oldKernel = underOtherNode(() => verifyKernel());
    expect(oldKernel.toolchain.node).toBe('v0.0.0');
    const first = evaluate(embedded.graph, { conformance: { inputs: embedded.inputs, kernel: oldKernel, fixtures } });
    expect(verdictsOf(first)).toEqual({
      'COMP-FIXTURES': { outcome: 'pass', basis: 'verified', messages: [] },
      'COMP-KERNEL': notEvaluated('COMP-KERNEL', stale),
    });
    expect(first.conformance).toEqual({
      profile: 'package-v1',
      toolchain: kernel.toolchain,
      fixtures: fixturesSummary,
    });
    const oldFixtures = underOtherNode(() => verifyFixtures());
    const second = evaluate(embedded.graph, {
      conformance: { inputs: embedded.inputs, kernel, fixtures: oldFixtures },
    });
    expect(verdictsOf(second)).toEqual({
      'COMP-FIXTURES': notEvaluated('COMP-FIXTURES', stale),
      'COMP-KERNEL': { outcome: 'pass', basis: 'verified', messages: [] },
    });
    expect(second.conformance).toEqual({
      profile: 'package-v1',
      toolchain: kernel.toolchain,
      kernel: { floorDigest: KERNEL_DIGEST },
    });
  });
  it('neither labels nor summarises fixture evidence that was not evaluated', async () => {
    const root = resolve(fileURLToPath(new URL('../fixtures/language/', import.meta.url)));
    vi.resetModules();
    vi.doMock('node:fs', async (original) => {
      const actual = await original<typeof import('node:fs')>();
      const readdirSync = ((path: unknown, ...rest: unknown[]) => {
        if (resolve(String(path)) === root)
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof actual.readdirSync;
      return { ...actual, default: { ...actual, readdirSync }, readdirSync };
    });
    try {
      const mocked = await import('../src/index.js');
      const unread = mocked.verifyFixtures();
      expect(unread.assessment.outcome).toBe('not-evaluated');
      const report = mocked.evaluate(embedded.graph, {
        conformance: { inputs: embedded.inputs, kernel: mocked.verifyKernel(), fixtures: unread },
      });
      expect(verdictsOf(report)['COMP-FIXTURES']).toMatchObject({ outcome: 'not-evaluated', basis: undefined });
      expect(verdictsOf(report)['COMP-KERNEL']).toMatchObject({ outcome: 'pass', basis: 'verified' });
      expect(report.conformance?.fixtures).toBeUndefined();
      expect(report.conformance?.kernel).toEqual({ floorDigest: KERNEL_DIGEST });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
