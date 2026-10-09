import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { digest } from '@inventarch/session-system';
import { EditorSnapshot } from '@inventarch/db/editor';
import { compileHarness, installed, executionManifest } from '../src/index.js';
import type { Capture, CompiledHarness } from '../src/index.js';
import { admitSourceCapture } from '@inventarch/workspace-runtime/sources';

import { compilerCapture, compilerCatalog as catalogWithDigest } from './compiler-fixture.js';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const captured = compilerCapture(root);
const implementationDigest = digest(readFileSync(`${root}/packages/workspace-runtime/src/corpus.ts`, 'utf8'));
const sampleCatalog = (model: string) => catalogWithDigest(model, implementationDigest);
const options = () => ({ harness: 'native-sample', entry: 'sample-entry', catalog: sampleCatalog('ide') });
const name = (n: string) => `agent-composition-system/binding/agent-profile/sample-${n}-profile`;
const corpusOperation = 'authoring-system/binding/operation/sample-read';
const assessmentOperation = 'authoring-system/binding/operation/fixture-secondary-read';
const profileCapabilities = 'capabilities [@capability fixture-readion, @capability secondary-read]';
function modified(suffix: string, before: string, after: string, base = captured): Capture {
  let found = false;
  const { revision: _revision, ...body } = base;
  const sources = body.sources.map((s) => {
    if (!s.path.endsWith(suffix)) return s;
    expect(s.text).toContain(before);
    found = true;
    return { ...s, text: s.text.replace(before, after) };
  });
  expect(found).toBe(true);
  const next = { ...body, sources };
  return { ...next, revision: digest(next) };
}
function good(
  capture = captured,
  catalog = sampleCatalog('ide'),
  entry = 'sample-entry',
  definitions?: Capture,
): CompiledHarness {
  const result = compileHarness(capture, { ...options(), catalog, entry, ...(definitions ? { definitions } : {}) });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.manifest;
}
function refused(capture: Capture, code: string, catalog = sampleCatalog('ide'), entry = 'sample-entry') {
  const result = compileHarness(capture, { ...options(), catalog, entry });
  expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
  if (result.ok) throw new Error('Unexpected compilation');
  return result.diagnostics[0]!;
}

it('compiles the admitted native author/architect without execution and retains field/component provenance', () => {
  const before = readFileSync(
    `${root}/examples/conformance/composition/.ia/src/systems/agent-composition-system/records/native-sample.ia`,
    'utf8',
  );
  const m = good();
  expect(m.format).toBe('ia.compiled-harness.v1');
  expect(m.profiles[name('author')]).toMatchObject({
    role: 'author',
    delegates: [name('architect')],
    effects: ['read'],
    limits: { modelCalls: 12, tokens: 400000 },
    completion: 'response',
  });
  expect(m.profiles[name('architect')]).toMatchObject({ role: 'architect', delegates: [], limits: { modelCalls: 4 } });
  expect(m.profiles[name('author')]!.instructions.join('\n')).toContain('Fixture sample-author text 6.');
  expect(m.profiles[name('author')]!.instructions.join('\n')).not.toContain('Fixture sample-cells text 6.'); // plan cell is not flattened into act
  // A method's cell arrives after its says and answers, so the agent reads what the step is for first.
  expect(
    m.profiles[name('author')]!.instructions.some((text) =>
      /^says .+\nanswers .+\nFixture sample-cells text 9./.test(text),
    ),
  ).toBe(true);
  for (const role of ['author', 'architect'])
    expect(m.profiles[name(role)]!.operations).toEqual([corpusOperation, assessmentOperation]);
  expect(Object.keys(m.operations)).toEqual([corpusOperation, assessmentOperation]);
  expect(m.operations[corpusOperation]).toMatchObject({
    owner: 'authoring-system',
    physicalOwner: 'agent-composition-system',
    handler: 'ia.corpus.inspect.v1',
    effects: ['read'],
    recovery: 'repeatable',
  });
  expect(m.operations[assessmentOperation]).toMatchObject({
    owner: 'authoring-system',
    physicalOwner: 'agent-composition-system',
    effects: ['read'],
    recovery: 'repeatable',
  });
  expect(m.provenance.fields[`${name('author')}:composition.voice`]).toEqual([
    'agent-composition-system/definition/voice/sample-voice',
  ]);
  expect(m.provenance.sources.some((s) => s.path.endsWith('/schemas/agent-profile.schema.ia'))).toBe(true);
  expect(m.provenance.installed.some((p) => p.group === 'validators')).toBe(true);
  expect(
    readFileSync(
      `${root}/examples/conformance/composition/.ia/src/systems/agent-composition-system/records/native-sample.ia`,
      'utf8',
    ),
  ).toBe(before);
  expect(good()).toEqual(m);
  expect(JSON.parse(JSON.stringify(m))).toEqual(m);
});
it('uses identical semantics for independently serialized local/API captures and catalogs', () => {
  const result = compileHarness(JSON.parse(JSON.stringify(captured)), {
    ...options(),
    catalog: JSON.parse(JSON.stringify(sampleCatalog('ide'))),
  });
  expect(result).toEqual({ ok: true, manifest: good() });
});
it('pins each component over the admitted record without its per-record digest, as before graph G13', () => {
  const reader = new EditorSnapshot({
    root: process.cwd(),
    sources: captured.sources,
    folders: captured.folders,
    floorOrigin: captured.floorOrigin,
    fingerprint: captured.revision,
  });
  try {
    const pins = good().provenance.components;
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      const node = reader.get(pin.identity)!,
        { digest: recordDigest, ...record } = node;
      expect(recordDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.digest).toBe(digest(record));
      expect(pin.digest).not.toBe(digest(node));
    }
  } finally {
    reader.close();
  }
});
it('keeps voice modular without changing effects, operations, mandate or bounds', () => {
  const before = good(),
    after = good(modified('sample-voice.ia', 'Fixture sample-voice text 3.', 'Detailed and explanatory.'));
  const a = before.profiles[name('author')]!,
    b = after.profiles[name('author')]!;
  expect(a.voice).not.toBe(b.voice);
  for (const k of ['operations', 'effects', 'limits', 'completion', 'checks', 'mandateContracts', 'outcomes'] as const)
    expect(b[k]).toEqual(a[k]);
  expect(before.provenance.executableDigest).not.toBe(after.provenance.executableDigest);
});
it('separates frozen task data from executable drift and detects same-identity/catalog changes', () => {
  const original = good();
  const unrelated = modified('repository-distribution.ia', 'meaning', '# unrelated document change\n  meaning');
  expect(good(captured, sampleCatalog('ide'), 'sample-entry', unrelated)).toEqual(original);
  const changed = modified('sample-author.ia', 'Fixture sample-author text 1.', 'reviewed change');
  expect(good(captured, sampleCatalog('ide'), 'sample-entry', changed).provenance.executableDigest).not.toBe(
    original.provenance.executableDigest,
  );
  const catalog = sampleCatalog('other-model');
  expect(good(captured, catalog).provenance.executableDigest).not.toBe(original.provenance.executableDigest);
});
it('refuses unresolved references and duplicate roles with the responsible source', () => {
  const reference = refused(
    modified('sample-author-profile.ia', '@voice sample-voice', '@voice missing'),
    'IA-COMPOSITION-REFERENCE',
  );
  expect(reference.source?.path).toContain('sample-author-profile.ia');
  expect(reference.field).toBe('composition.voice');
  refused(modified('sample-architect-profile.ia', 'role architect', 'role author'), 'IA-COMPOSITION-ROLE');
});
it('refuses an equal-authority duplicate occurrence through the shared admission rules', () => {
  const { revision: _r, ...body } = captured;
  const voice = body.sources.find((s) => s.path.endsWith('/sample-voice.ia'))!;
  const next = {
    ...body,
    sources: [...body.sources, { ...voice, path: voice.path.replace('sample-voice.ia', 'duplicate-voice.ia') }],
  };
  refused({ ...next, revision: digest(next) }, 'IA-COMPOSITION-REFERENCE');
});
it('refuses capability/delegate cycles and out-of-harness delegates', () => {
  refused(
    modified('fixture-readion.ia', '  composition\n', '  composition\n    includes [@capability fixture-readion]\n'),
    'IA-COMPOSITION-CYCLE',
  );
  refused(
    modified(
      'sample-architect-profile.ia',
      '  execution\n',
      '    delegates [@agent-profile sample-author-profile]\n  execution\n',
    ),
    'IA-COMPOSITION-CYCLE',
  );
  refused(
    modified(
      'native-sample.ia',
      'profiles [@agent-profile sample-author-profile, @agent-profile sample-architect-profile]',
      'profiles [@agent-profile sample-author-profile]',
    ),
    'IA-COMPOSITION-REFERENCE',
  );
});
it('refuses missing handlers, digest mismatches, physical-owner drift and legacy operation descriptors', () => {
  const missing = sampleCatalog('ide');
  delete missing.operations['fixture-read-v1'];
  refused(captured, 'IA-COMPOSITION-UNAVAILABLE', missing);
  const bad = sampleCatalog('ide');
  bad.operations['fixture-read-v1']!.digest = 'forged';
  refused(captured, 'IA-COMPOSITION-CONFLICT', bad);
  const wrong = sampleCatalog('ide');
  wrong.operations['fixture-read-v1'] = installed({
    ...wrong.operations['fixture-read-v1']!.value,
    owner: 'authoring-system',
  });
  refused(captured, 'IA-COMPOSITION-CONFLICT', wrong);
  refused(modified('operations/sample-read.ia', '    profile governed-v1\n', ''), 'IA-COMPOSITION-UNAVAILABLE');
  const unpinned = sampleCatalog('ide');
  unpinned.operations['fixture-read-v1'] = installed({
    ...unpinned.operations['fixture-read-v1']!.value,
    implementationDigest: 'version-label-only',
  });
  refused(captured, 'IA-COMPOSITION-UNAVAILABLE', unpinned);
  const changed = catalogWithDigest('ide', digest('new implementation bytes'));
  expect(good(captured, changed).provenance.executableDigest).not.toBe(good().provenance.executableDigest);
});
it('refuses a write hidden behind read-only or repeatable declarations', () => {
  const c = sampleCatalog('ide');
  c.operations['fixture-read-v1'] = installed({ ...c.operations['fixture-read-v1']!.value, effects: ['local-write'] });
  refused(captured, 'IA-COMPOSITION-CONFLICT', c);
  const write = modified('operations/sample-read.ia', 'effects read-only', 'effects local-write');
  refused(write, 'IA-COMPOSITION-CONFLICT', c);
});
it('refuses unavailable validators, malformed schemas and required evaluators', () => {
  const c = sampleCatalog('ide');
  delete c.validators['corpus-output-v1'];
  refused(captured, 'IA-COMPOSITION-UNAVAILABLE', c);
  c.validators['corpus-output-v1'] = installed({
    schema: { type: 'object', properties: {}, required: ['missing'], additionalProperties: false },
  });
  refused(captured, 'IA-COMPOSITION-UNAVAILABLE', c);
  const checked = modified(
    'fixture-readion.ia',
    '  composition\n',
    '  composition\n    checks [@check instance-schema-check]\n',
  );
  expect(refused(checked, 'IA-COMPOSITION-UNAVAILABLE').field).toBe('check.runs');
  // An implementation-only check resolves its evaluator the same way (compliance checkRunner precedence) and the
  // refusal names the field actually read.
  const implemented = modified(
    'checks/instance-schema-check.ia',
    '    runs COMP-SCHEMA',
    '    implementation COMP-SCHEMA',
    checked,
  );
  expect(refused(implemented, 'IA-COMPOSITION-UNAVAILABLE').field).toBe('check.implementation');
  // Layered: a check naming both fields with different values is refused at admission (IA-COMP-CHECK-CONFLICT) and
  // leaves the graph, so the capability's reference to it has no target and the compiler never chooses between them.
  const conflicting = modified(
    'checks/instance-schema-check.ia',
    '    runs COMP-SCHEMA',
    '    runs COMP-SCHEMA\n    implementation COMP-KERNEL',
    checked,
  );
  expect(refused(conflicting, 'IA-COMPOSITION-REFERENCE')).toMatchObject({ message: 'IA-GRAPH-TARGET-MISSING' });
});
it('narrows limits and refuses negative, conditional or unknown limits', () => {
  const tight = modified(
    'native-sample.ia',
    'host-profile captured-sample-v1',
    'host-profile captured-sample-v1\n    limit-model-calls 2',
  );
  expect(good(tight).profiles[name('author')]!.limits.modelCalls).toBe(2);
  const limit = (line: string, base = captured) =>
    modified(
      'native-sample.ia',
      'host-profile captured-sample-v1',
      `host-profile captured-sample-v1\n    ${line}`,
      base,
    );
  expect(refused(limit('limit-model-calls -1'), 'IA-COMPOSITION-CONFLICT').field).toBe('execution.limit-model-calls');
  // Layered: the shipped closed schema refuses an undeclared limit at admission, so the harness never reaches the compiler.
  expect(refused(limit('limit-mystery 2'), 'IA-COMPOSITION-REFERENCE').admission).toEqual([
    {
      code: 'IA-COMP-FIELD-UNKNOWN',
      path: '.ia/src/systems/agent-composition-system/records/native-sample.ia',
      line: 13,
    },
  ]);
  // A loosened schema that declares the limit admits the harness; the compiler's own limit guard still refuses it.
  const declared = modified(
    'schemas/harness.schema.ia',
    'may have execution.limit-duration-ms as number',
    'may have execution.limit-duration-ms as number\n    may have execution.limit-mystery as number',
  );
  expect(refused(limit('limit-mystery 2', declared), 'IA-COMPOSITION-CONFLICT')).toMatchObject({
    message: 'Unknown executable field',
    field: 'execution',
  });
  refused(limit('limit-model-calls 2 when phase is act'), 'IA-COMPOSITION-REFERENCE');
});
it('does not silently execute reaction/skill/procedure profiles without their consumers', () => {
  refused(modified('sample-entry.ia', 'kind entry', 'kind reaction'), 'IA-COMPOSITION-UNAVAILABLE');
  refused(
    modified('fixture-readion.ia', 'effects [read]', 'effects [read]\n    procedure-profile arbitrary-code'),
    'IA-COMPOSITION-UNAVAILABLE',
  );
});
it('compiles an independent entry when another profile needs an unavailable implementation', () => {
  const c = modified('sample-author-profile.ia', 'mandate-contract sample-task-v1', 'mandate-contract not-installed');
  refused(c, 'IA-COMPOSITION-UNAVAILABLE');
  const m = good(c, sampleCatalog('ide'), 'architect-entry');
  expect(Object.keys(m.profiles)).toEqual([name('architect')]);
});
it('pins schema bytes and rejects unknown executable fields instead of weakening restrictions', () => {
  const before = good();
  const changedSchema = modified('schemas/voice.schema.ia', '@schema voice', '# changed schema source\n@schema voice');
  expect(good(captured, sampleCatalog('ide'), 'sample-entry', changedSchema).provenance.executableDigest).not.toBe(
    before.provenance.executableDigest,
  );
  const permissions = (base = captured) =>
    modified('sample-author-profile.ia', 'role author', 'role author\n    permissions unrestricted', base);
  // Layered: the shipped closed schema refuses the undeclared field at admission (IA-COMP-FIELD-UNKNOWN); compileHarness only sees the harness's
  // profile reference fail, because a referenced (not selected) record carries no admission findings.
  expect(admitSourceCapture(permissions())).toMatchObject({
    ok: false,
    refused: 1,
    diagnostics: [
      {
        code: 'IA-COMP-FIELD-UNKNOWN',
        path: '.ia/src/systems/agent-composition-system/records/sample-author-profile.ia',
      },
    ],
  });
  expect(refused(permissions(), 'IA-COMPOSITION-REFERENCE')).toMatchObject({
    message: 'IA-GRAPH-TARGET-MISSING',
    field: 'composition.profiles',
  });
  // A loosened schema that declares the field admits the profile; the compiler's closed-field guard still refuses it instead of granting it.
  const loosened = modified(
    'schemas/agent-profile.schema.ia',
    'may have execution.model-profile as id',
    'may have execution.model-profile as id\n    may have execution.permissions as id',
  );
  const guard = refused(permissions(loosened), 'IA-COMPOSITION-CONFLICT');
  expect(guard).toMatchObject({ message: 'Unknown executable field', field: 'execution' });
  expect(guard.source?.path).toContain('sample-author-profile.ia');
});
it('retains conjunctive input contracts and refuses incompatible required contracts', () => {
  const changed = modified('fixture-readion.ia', 'input task-text-v1', 'input object-input');
  const c = sampleCatalog('ide');
  c.validators['object-input'] = installed({
    schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  });
  refused(changed, 'IA-COMPOSITION-CONFLICT', c);
  c.validators['object-input'] = installed({ schema: { type: 'string', maxLength: 80 } });
  expect(good(changed, c).profiles[name('author')]!.inputContracts.map((i) => i.id)).toEqual([
    'task-text-v1',
    'object-input',
  ]);
});
it('refuses conflicting completion contracts and a model outside the mandate', () => {
  const c = sampleCatalog('ide');
  c.outcomes['artifact-outcomes'] = installed({ kinds: ['proposal', 'deliverable'], completion: 'artifact' });
  c.outcomes['sample-outcomes-v1'] = installed({ kinds: ['proposal'], completion: 'proposal' });
  refused(
    modified('sample-author-profile.ia', 'outcomes sample-outcomes-v1', 'outcomes artifact-outcomes'),
    'IA-COMPOSITION-CONFLICT',
    c,
  );
  const other = sampleCatalog('ide');
  other.mandates['sample-task-v1'] = installed({
    ...other.mandates['sample-task-v1']!.value,
    models: ['another-model'],
  });
  refused(captured, 'IA-COMPOSITION-CONFLICT', other);
});
it('supports reasoning-only capabilities and does not grant the unused operation catalog', () => {
  const reasoning = modified('fixture-readion.ia', '    operations [@operation sample-read]\n', '');
  const limited = modified('fixture-readion.ia', 'effects [read]', 'effects []', reasoning);
  const author = modified(
    'sample-author-profile.ia',
    profileCapabilities,
    'capabilities [@capability fixture-readion]',
    limited,
  );
  const capture = modified(
    'sample-architect-profile.ia',
    profileCapabilities,
    'capabilities [@capability fixture-readion]',
    author,
  );
  // Installed catalog entries are available implementations, not authority for an unselected capability.
  const c = sampleCatalog('ide');
  expect(Object.keys(c.operations).length).toBeGreaterThan(0);
  const result = good(capture, c);
  for (const profile of Object.values(result.profiles)) expect(profile.operations).toEqual([]);
  expect(result.operations).toEqual({});
});
it('rejects cap effects wider than the host and keeps narrowed delegation bounds', () => {
  refused(modified('fixture-readion.ia', 'effects [read]', 'effects [read, local-write]'), 'IA-COMPOSITION-CONFLICT');
  const parent = modified('sample-author-profile.ia', 'role author', 'role author\n    limit-model-calls 2');
  const profile = good(parent).profiles[name('author')]!;
  expect(profile.delegation).toEqual([{ profile: name('architect'), limits: { ...profile.limits, modelCalls: 2 } }]);
});
it('refuses non-serializable executable catalog callbacks without invoking them', () => {
  let called = false;
  const c = sampleCatalog('ide');
  Object.assign(c.operations['fixture-read-v1']!.value, {
    execute: () => {
      called = true;
    },
  });
  refused(captured, 'IA-COMPOSITION-CONFLICT', c);
  expect(called).toBe(false);
});
it('does not promote another phase of a required method when its selected cell is absent', () => {
  const c = sampleCatalog('ide');
  c.contexts['captured-context-v1'] = installed({ ...c.contexts['captured-context-v1']!.value, tokens: 1 });
  refused(captured, 'IA-COMPOSITION-UNAVAILABLE', c);
  const method = captured.sources.find((s) => s.path.endsWith('/sample-cells.ia'))!;
  const act = method.text.slice(method.text.indexOf('    act\n'), method.text.indexOf('    learn\n'));
  refused(modified('/sample-cells.ia', act, ''), 'IA-COMPOSITION-UNAVAILABLE');
});
it('deduplicates a shared capability DAG instead of expanding every possible inclusion path', () => {
  const records: string[] = [];
  for (let level = 0; level < 24; level++)
    for (const side of ['a', 'b']) {
      records.push(
        `@capability layer-${level}-${side}\n  meaning\n    says "Shared reasoning component"\n    answers "What is reused?"\n  composition\n    includes ${level === 0 ? '[]' : `[@capability layer-${level - 1}-a, @capability layer-${level - 1}-b]`}\n  execution\n    effects []`,
      );
    }
  const updated = modified(
    'sample-author-profile.ia',
    profileCapabilities,
    'capabilities [@capability fixture-readion, @capability secondary-read, @capability layer-23-a, @capability layer-23-b]',
  );
  const { revision: _r, ...body } = updated;
  const own = body.sources.find((s) => s.path.endsWith('/fixture-readion.ia'))!;
  const next = {
    ...body,
    sources: [
      ...body.sources,
      {
        ...own,
        path: own.path.replace('fixture-readion.ia', 'shared-reasoning.ia'),
        text: '#! ia 1.0\n\n' + records.join('\n\n') + '\n',
      },
    ],
  };
  const result = good({ ...next, revision: digest(next) });
  expect(result.profiles[name('author')]!.capabilities).toHaveLength(50);
  expect(new Set(result.profiles[name('author')]!.capabilities).size).toBe(50);
  expect(result.profiles[name('author')]!.operations).toEqual([corpusOperation, assessmentOperation]);
});

it('pins explicit independent reviewer policy through mandate composition into the engine contract', () => {
  const catalog = sampleCatalog('ide'),
    base = catalog.mandates['sample-task-v1']!.value;
  const review = {
    rule: 'independent-exact-candidate-v1' as const,
    reviewer: 'reviewer-bob',
    mandate: 'separate-review-mandate',
    policyRevision: 'policy-1',
  };
  catalog.mandates['sample-task-v1'] = installed({ ...base, review });
  const compiled = good(captured, catalog),
    manifest = executionManifest(compiled, catalog);
  for (const profile of Object.values(manifest.profiles)) expect(profile.contract!.review).toEqual(review);
  expect(compiled.provenance.fields['normalized:' + name('author') + ':review']).toContain('mandates:sample-task-v1');
  catalog.mandates['sample-task-v1'] = installed({ ...base, review: { ...review, policyRevision: 'policy-2' } });
  expect(() => executionManifest(compiled, catalog)).toThrow('Installed contract changed');
  catalog.mandates['sample-task-v1'] = installed({ ...base, review: { ...review, mandate: '' } });
  refused(captured, 'IA-COMPOSITION-CONFLICT', catalog);
});

import './sdk-runtime/onboarding-case.js';
