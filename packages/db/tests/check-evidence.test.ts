// D13 and D14: every `@check` bound at validate against the verdicts its scope selects or the host's evaluator
// catalog, and the runtime evidence a validate effect records for the bound checks that passed or failed. Binding and
// discovery only read; `writeEvidence` is the writer.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Verdict } from '@inventarch/compliance';
import {
  bindChecks,
  checkVerdicts,
  EVIDENCE_DIRECTORY,
  evidenceText,
  open,
  readEvidence,
  WHOLE_WORKSPACE_SCOPE,
  writeEvidence,
} from '../src/index.js';
import type { CheckCatalog, Handle } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { OPENED_READ_FLAGS } from '../src/named.js';
import { fifo } from './file-races.js';
import { methodId, put, workspace } from './workspace.js';

// Every node:fs export calls through; a test can make one unlink fail as a file the process may not remove would.
vi.mock('node:fs', { spy: true });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const CHECKS = '.ia/src/systems/compliance-system/checks/bound-checks.ia';
/** A `@check` in the native compliance system naming `runner` with the text scope `scope`. */
const check = (name: string, runner: string, scope: string) => `@check ${name}
  meaning
    says "Bind ${name} for the test."
    answers "What does ${name} select?"
  check
    runs ${runner}
    scope "${scope}"
  governance
    severity blocking
  relationships
    enforces @contract foundation-authoring-contract
`;
const fixture = (root: string, ...checks: string[]) => put(root, CHECKS, `#! ia 1.0\n\n${checks.join('\n')}`);
const NONE: CheckCatalog = { status: 'unavailable', reason: 'no host has joined a catalog' };
const structural = (root: string, evidence = false): Handle =>
  open(root, { cache: false, checks: 'structural', ...(evidence ? { evidence: true } : {}) });
const using = <T>(db: Handle, read: (db: Handle) => T): T => {
  try {
    return read(db);
  } finally {
    db.close();
  }
};
const byName = (db: Handle, catalog: CheckCatalog = NONE) =>
  Object.fromEntries(bindChecks(db.records(), db.report, catalog).map((binding) => [binding.name, binding]));
const code = (value: string) => expect.objectContaining({ code: value });
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const entry = (id: string, availability: Record<string, string>, digest = 'a') => ({
  id,
  contractVersion: '1.0.0',
  implementationVersion: '2.1.0',
  implementationDigest: sha(digest),
  inputSchemaId: 'acme-typing-input@1',
  outputSchemaId: 'acme-typing-result@1',
  supportedScopes: ['package'],
  effects: ['read'],
  environmentProfile: { id: 'node-22-offline', credentials: 'none' },
  limits: { timeoutMs: 60000, memoryBytes: 536870912, outputBytes: 4096, concurrency: 2 },
  evidencePolicy: { kind: 'fresh-run' },
  availability,
});

it('aggregates the verdicts a scope selects: fail, then not-evaluated, then pass; nothing selected is not-evaluated (D13)', () => {
  const verdict = (scope: string, outcome: Verdict['outcome'], check = 'COMP-X'): Verdict =>
    ({ check, scope, outcome, findings: [], revision: 'r' }) as Verdict;
  const all = [
    verdict('a', 'pass'),
    verdict('b', 'not-evaluated'),
    verdict('c', 'fail'),
    verdict('a', 'fail', 'COMP-Y'),
  ];
  expect(checkVerdicts(all, 'COMP-X', WHOLE_WORKSPACE_SCOPE).outcome).toBe('fail');
  expect(checkVerdicts(all.slice(0, 2), 'COMP-X', '*').outcome).toBe('not-evaluated');
  expect(checkVerdicts([verdict('a', 'pass'), verdict('d', 'pass')], 'COMP-X', '*')).toMatchObject({ outcome: 'pass' });
  // Exact scope identity only: another runner's verdict on the same scope is never selected.
  expect(checkVerdicts(all, 'COMP-X', 'a')).toMatchObject({ outcome: 'pass', selected: [all[0]] });
  expect(checkVerdicts(all, 'COMP-X', 'c').outcome).toBe('fail');
  // Prose, an unknown scope, no scope, and an evaluator that reported nothing: an empty selection, never a pass.
  for (const scope of ['every admitted native record', 'A', 'workspace', '', null])
    expect(checkVerdicts(all, 'COMP-X', scope)).toEqual({ outcome: 'not-evaluated', selected: [] });
  expect(checkVerdicts(all, 'COMP-Z', '*')).toEqual({ outcome: 'not-evaluated', selected: [] });
  // A verdict about an excluded record (the runtime evidence) is never selected.
  expect(checkVerdicts(all, 'COMP-X', '*', new Set(['c'])).outcome).toBe('not-evaluated');
});

it('selects exact scopes without admitting descendants, lexical prefixes or ancestors (L6-02)', () => {
  const verdict = (scope: string, outcome: Verdict['outcome']): Verdict =>
    ({ check: 'COMP-SCHEMA', scope, outcome, findings: [], revision: 'r' }) as Verdict;
  const scopes = ['a', 'a/b', 'ab', 'a-b', 'a/b/c', 'a/bc'];
  for (const scope of scopes) {
    const exact = verdict(scope, 'pass');
    const neighbors = scopes.filter((other) => other !== scope).map((other) => verdict(other, 'fail'));
    expect(checkVerdicts([exact, ...neighbors], 'COMP-SCHEMA', scope), scope).toEqual({
      outcome: 'pass',
      selected: [exact],
    });
    expect(checkVerdicts(neighbors, 'COMP-SCHEMA', scope), `absent ${scope}`).toEqual({
      outcome: 'not-evaluated',
      selected: [],
    });
  }
});

it('binds a built-in check to the admission verdicts its scope selects, and a prose scope to not-evaluated (D13)', () => {
  const root = workspace();
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', WHOLE_WORKSPACE_SCOPE),
    check('method-schema-check', 'COMP-SCHEMA', methodId),
    check('unknown-scope-check', 'COMP-SCHEMA', 'no-such-scope'),
  );
  using(structural(root), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const bound = byName(db),
      schema = db.report.verdicts.filter((verdict) => verdict.check === 'COMP-SCHEMA');
    expect(bound['whole-schema-check']).toMatchObject({
      runner: 'COMP-SCHEMA',
      scope: '*',
      status: 'bound',
      implementation: 'built-in',
      outcome: 'pass',
      selected: schema.length,
    });
    expect(schema.length).toBeGreaterThan(1);
    expect(bound['method-schema-check']).toMatchObject({ status: 'bound', outcome: 'pass', selected: 1 });
    // The native check's prose scope selects nothing: bound, but not-evaluated, and never a pass.
    expect(bound['instance-schema-check']).toMatchObject({
      status: 'bound',
      outcome: 'not-evaluated',
      selected: 0,
      reason: expect.stringContaining('check.scope "every admitted native record" selects no COMP-SCHEMA verdict'),
    });
    expect(bound['unknown-scope-check']).toMatchObject({ outcome: 'not-evaluated', selected: 0 });
  });
});

it('selects verdicts by check.scope alone: check.covers claims paths and never changes a binding (D13)', () => {
  const root = workspace();
  const covered = (name: string, scope: string) =>
    check(name, 'COMP-SCHEMA', scope).replace(
      `    scope "${scope}"\n`,
      `    scope "${scope}"\n    covers ["src/**"]\n`,
    );
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', '*'),
    covered('covered-whole-check', '*'),
    covered('covered-prose-check', 'src/billing/*.ts'),
  );
  using(structural(root), (db) => {
    const bound = byName(db);
    // The same scope binds the same verdicts with or without covers.
    const { identity: _a, name: _b, ...plain } = bound['whole-schema-check']!;
    const { identity: _c, name: _d, ...withCovers } = bound['covered-whole-check']!;
    expect(withCovers).toEqual(plain);
    // A scope that selects nothing stays not-evaluated, whatever the check claims.
    expect(bound['covered-prose-check']).toMatchObject({ status: 'bound', outcome: 'not-evaluated', selected: 0 });
    // The claim is the location resolver's: covers claims src/x.ts, the scope claims nothing.
    const claimants = db
      .resolveSeat('src/billing/x.ts')
      .claimants.map((claimant) => [claimant.identity.split('/').at(-1), claimant.matches.map((match) => match.field)]);
    expect(claimants).toContainEqual(['covered-prose-check', ['check.covers']]);
    expect(claimants.some(([identity]) => identity === 'whole-schema-check')).toBe(false);
  });
});

it('admits an unknown evaluator only structurally, and binds it unavailable, revoked or supported-but-not-run (D13)', () => {
  const root = workspace();
  fixture(root, check('typing-check', 'acme-strict-typing', 'package'), check('lint-check', 'acme-lint', 'package'));
  // Strict admission, every existing reader's default, still refuses the record.
  using(open(root, { cache: false }), (db) => {
    expect(db.records().some((record) => record.name === 'typing-check')).toBe(false);
    expect(db.report.findings.map((finding) => finding.code)).toContain('IA-COMP-CHECK-UNKNOWN');
  });
  using(structural(root), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    // No catalog: unavailable, not-evaluated, with the reason the catalog source gives.
    expect(byName(db)['typing-check']).toMatchObject({
      status: 'unavailable',
      implementation: null,
      outcome: 'not-evaluated',
      reason: 'no host has joined a catalog',
    });
    // A catalog that failed verification revokes every catalog check, never a built-in one.
    const damaged = byName(db, { status: 'damaged', reason: 'IA-DIST-INTEGRITY-MISMATCH: Host payload changed' });
    expect(damaged['typing-check']).toMatchObject({ status: 'revoked', outcome: 'not-evaluated' });
    expect(damaged['instance-schema-check']).toMatchObject({ status: 'bound', implementation: 'built-in' });
    const present = (...entries: unknown[]): CheckCatalog => ({
      status: 'present',
      evaluators: { format: 'ia-evaluator-catalog/1.0', entries },
    });
    // The 2.0.0-era empty catalog lists nothing.
    expect(byName(db, present())['typing-check']).toMatchObject({
      status: 'unavailable',
      reason: 'the installed evaluator catalog lists no evaluator acme-strict-typing',
    });
    const listed = byName(
      db,
      present(
        entry('acme-strict-typing', { status: 'supported' }),
        entry('acme-lint', { status: 'revoked', reason: 'Superseded after advisory 7' }, 'b'),
      ),
    );
    // Supported, but no host implementation runs it in this release: bound, never invoked, so not-evaluated.
    expect(listed['typing-check']).toMatchObject({
      status: 'bound',
      implementation: 'acme-strict-typing@2.1.0',
      outcome: 'not-evaluated',
      reason: 'acme-strict-typing@2.1.0 is supported, but no host implementation ran it, so nothing was evaluated',
    });
    expect(listed['lint-check']).toMatchObject({
      status: 'revoked',
      reason: 'the installed evaluator catalog revokes acme-lint@2.1.0: Superseded after advisory 7',
    });
    const unavailable = byName(db, present(entry('acme-lint', { status: 'unavailable', reason: 'Not installed' })));
    expect(unavailable['lint-check']).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Not installed'),
    });
    // A catalog compliance does not accept is unavailable, not revoked: it vouches for nothing.
    expect(byName(db, present({ id: 'acme-strict-typing' }))['typing-check']).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('the installed evaluator catalog is not valid'),
    });
  });
});

/** The admitted root view's authored revision and the evidence file path for it. */
const evidencePath = (db: Handle) => `${EVIDENCE_DIRECTORY}/${db.authoredRevision}.ia`;
/** Binds and writes evidence as the validate request does; returns what was written. */
function validateOnce(root: string, now = new Date('2026-10-11T12:00:00.000Z')) {
  return using(structural(root, true), (db) => {
    const bindings = bindChecks(db.records(), db.report, NONE),
      built = evidenceText({
        authoredRevision: db.authoredRevision,
        bindings,
        records: db.records(),
        prior: readEvidence(root, evidencePath(db)),
        now,
      });
    return { ...writeEvidence(root, db.authoredRevision, built.text), observations: built.observations };
  });
}

it('records a passing built-in check as an admitted runtime observation without moving the authored revision (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const before = using(structural(root), (db) => ({ authored: db.authoredRevision, revision: db.revision }));
  const first = validateOnce(root);
  expect(first).toEqual({
    path: `${EVIDENCE_DIRECTORY}/${before.authored}.ia`,
    written: true,
    pruned: [],
    observations: [
      {
        name: `whole-schema-check-${before.authored.slice(0, 12)}`,
        check: 'compliance-system/check/gate/whole-schema-check',
        verdict: 'success',
      },
    ],
  });
  // Read with evidence: the observation is admitted at runtime placement, and the authored revision is unchanged.
  using(structural(root, true), (db) => {
    const observation = db.records().find((record) => record.name === first.observations[0]!.name)!;
    expect(observation).toMatchObject({ discriminator: 'observation', band: 0 });
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(db.authoredRevision).toBe(before.authored);
    expect(db.revision).not.toBe(before.revision);
    // Its own verdicts never feed a check: the binding does not move once evidence exists.
    expect(byName(db)['whole-schema-check']).toMatchObject({ outcome: 'pass' });
  });
  // Every existing reader, which reads no evidence, sees exactly what it saw.
  using(open(root, { cache: false }), (db) => {
    expect(db.records().some((record) => record.discriminator === 'observation' && record.band === 0)).toBe(false);
    expect(db.revision).toBe(before.revision);
  });
  // A second validate at the same authored revision writes nothing: same observations, same times, same bytes.
  const bytes = readFileSync(resolve(root, first.path!));
  expect(validateOnce(root, new Date('2026-10-12T00:00:00.000Z'))).toMatchObject({ written: false, pruned: [] });
  expect(readFileSync(resolve(root, first.path!))).toEqual(bytes);
  expect(using(structural(root), (db) => db.authoredRevision)).toBe(before.authored);
});

it('records nothing for an unbound, unavailable or not-evaluated check, and keeps no file then (D14)', () => {
  const root = workspace();
  fixture(root, check('typing-check', 'acme-strict-typing', 'package'), check('prose-check', 'COMP-SCHEMA', 'prose'));
  expect(validateOnce(root)).toEqual({ path: null, written: false, pruned: [], observations: [] });
  expect(existsSync(resolve(root, EVIDENCE_DIRECTORY))).toBe(false);
});

it('discovers only the current authored revision’s file, and the writer prunes the others and nothing else (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const older = `${EVIDENCE_DIRECTORY}/${'0'.repeat(64)}.ia`,
    notes = `${EVIDENCE_DIRECTORY}/notes.txt`,
    first = validateOnce(root);
  // An older revision's file, even one that would admit, is never read as evidence.
  put(root, older, readFileSync(resolve(root, first.path!), 'utf8').replaceAll('whole-schema-check-', 'older-check-'));
  put(root, notes, 'not evidence\n');
  using(structural(root, true), (db) =>
    expect(db.records().filter((record) => record.discriminator === 'observation' && record.band === 0)).toHaveLength(
      1,
    ),
  );
  // An authored change moves the revision: the old file is not this revision's, so nothing is admitted from it.
  put(
    root,
    '.ia/src/systems/compliance-system/checks/another.ia',
    `#! ia 1.0\n\n${check('another-check', 'COMP-SCHEMA', 'prose')}`,
  );
  using(structural(root, true), (db) => {
    expect(db.records().some((record) => record.discriminator === 'observation' && record.band === 0)).toBe(false);
  });
  const second = validateOnce(root);
  expect(second.written).toBe(true);
  expect(second.pruned).toEqual([older, first.path].sort());
  expect(readdirSync(resolve(root, EVIDENCE_DIRECTORY)).sort()).toEqual(
    [second.path!.split('/').at(-1), 'notes.txt'].sort(),
  );
});

it('ignores evidence that would collide with an authored observation or add a finding of its own (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    name = first.observations[0]!.name,
    evidence = readFileSync(resolve(root, first.path!), 'utf8');
  // An authored observation that holds the evidence's name: the authored record keeps it, and the evidence file is not
  // read at the authored revision it now has; the writer records nothing under that name either.
  const authoredPath = '.ia/src/systems/learning-system/records/held.ia';
  put(root, authoredPath, evidence.replace(name, 'held-observation'));
  const held = using(structural(root), (db) => db.authoredRevision);
  put(root, `${EVIDENCE_DIRECTORY}/${held}.ia`, evidence.replaceAll(name, 'held-observation'));
  using(structural(root, true), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const observations = db.records().filter((record) => record.name === 'held-observation');
    expect(observations.map((record) => record.band)).toEqual([100]);
    expect(db.authoredRevision).toBe(held);
  });
  expect(readFileSync(resolve(root, authoredPath), 'utf8')).toBe(evidence.replace(name, 'held-observation'));
  // Evidence whose observation the schema refuses is not admitted either, and adds no finding.
  rmSync(resolve(root, authoredPath));
  const revision = using(structural(root), (db) => db.authoredRevision);
  put(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`, evidence.replace('verdict success', 'verdict banana'));
  using(structural(root, true), (db) => {
    expect(db.report.findings.filter((finding) => finding.path.startsWith(EVIDENCE_DIRECTORY))).toEqual([]);
    expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false);
  });
  // Any other record kind in the evidence file (a requirement-bearing contract, a schema) is never evidence.
  put(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`, `${evidence}\n@schema planted\n`);
  using(structural(root, true), (db) =>
    expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false),
  );
});

it('never reads or writes evidence through a link or junction or at an entry of the wrong kind (D14)', () => {
  const root = workspace(),
    elsewhere = workspace(false);
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const revision = using(structural(root), (db) => db.authoredRevision);
  const noEvidence = () =>
    using(structural(root, true), (db) =>
      expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false),
    );
  // The evidence directory as a junction to a directory outside the workspace. Read: nothing behind it is evidence,
  // and the workspace still opens. Write: a passing check refuses, and with nothing to record nothing is pruned
  // through it either.
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(elsewhere, resolve(root, EVIDENCE_DIRECTORY), 'junction');
  const planted = `${'1'.repeat(64)}.ia`;
  put(elsewhere, planted, '#! ia 1.0\n');
  noEvidence();
  expect(() => validateOnce(root)).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: false, pruned: [] });
  expect(readdirSync(elsewhere)).toEqual([planted]);
  rmSync(resolve(root, EVIDENCE_DIRECTORY));
  // The evidence directory as a file, and the evidence file as a directory or a hard link.
  put(root, EVIDENCE_DIRECTORY, 'not a directory');
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: false, pruned: [] });
  noEvidence();
  rmSync(resolve(root, EVIDENCE_DIRECTORY));
  mkdirSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`), { recursive: true });
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  rmSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`), { recursive: true });
  put(elsewhere, 'outside.ia', '#! ia 1.0\n');
  linkSync(resolve(elsewhere, 'outside.ia'), resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`));
  // A hard-linked evidence file is never read as evidence, and the writer replaces the entry rather than writing
  // through it, so the file outside never changes.
  noEvidence();
  expect(writeEvidence(root, revision, '#! ia 1.0\n\n')).toMatchObject({ written: true });
  expect(readFileSync(resolve(elsewhere, 'outside.ia'), 'utf8')).toBe('#! ia 1.0\n');
  expect(statSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`)).nlink).toBe(1);
});

it('fails cleanly where the evidence cannot be written, leaving what it found and no staged file (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    target = resolve(root, first.path!),
    directory = resolve(root, EVIDENCE_DIRECTORY),
    before = readFileSync(target);
  // Windows refuses to replace a read-only file; elsewhere a read-only directory refuses the staged file.
  const lock = process.platform === 'win32' ? target : directory;
  chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
  try {
    if (process.platform !== 'win32' && process.getuid?.() === 0) return;
    expect(() => writeEvidence(root, first.path!.slice(-67, -3), '#! ia 1.0\n')).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^E(?:PERM|ACCES|ROFS|BUSY)$/) }),
    );
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    chmodSync(lock, process.platform === 'win32' ? 0o644 : 0o755);
  }
  expect(statSync(target).isFile()).toBe(true);
});

it('stages and renames, so repeated writes of differing evidence always leave one whole file (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const revision = using(structural(root), (db) => db.authoredRevision),
    path = resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`);
  for (let round = 0; round < 20; round++) {
    const text = `#! ia 1.0\n\n// round ${round}\n${'x'.repeat(round * 1000)}\n`;
    expect(writeEvidence(root, revision, text)).toMatchObject({ written: true });
    expect(readFileSync(path, 'utf8')).toBe(text);
  }
  expect(readdirSync(resolve(root, EVIDENCE_DIRECTORY))).toEqual([`${revision}.ia`]);
  expect(writeEvidence(root, revision, null)).toEqual({
    path: null,
    written: true,
    pruned: [`${EVIDENCE_DIRECTORY}/${revision}.ia`],
  });
});

/** The evidence file `validateOnce` wrote for `root`'s current authored revision, and that revision. */
const written = (root: string) => {
  const revision = using(structural(root), (db) => db.authoredRevision),
    path = `${EVIDENCE_DIRECTORY}/${revision}.ia`;
  return { revision, path, text: readEvidence(root, path)! };
};
const band0 = (db: Handle) =>
  db.records().filter((record) => record.band === 0 && record.discriminator === 'observation');
const findingLines = (db: Handle) =>
  db.report.findings
    .filter((finding) => !finding.path.startsWith(EVIDENCE_DIRECTORY))
    .map((finding) => `${finding.code} ${finding.path}`);

it('admits only evidence exactly as the writer makes it, which never changes what the authored records admit (D14)', () => {
  const root = workspace();
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', '*'),
    check('consent-check', 'COMP-CONSENT', 'graph'),
    check('prose-check', 'COMP-SCHEMA', 'every admitted record'),
  );
  validateOnce(root);
  const template = written(root).text,
    start = template.indexOf('@observation '),
    end = template.indexOf('\n\n@observation', start),
    block = template.slice(start, end < 0 ? undefined : end + 1);
  // An authored observation citing one that no source authors: a dangling reference the graph reports.
  put(
    root,
    '.ia/src/systems/learning-system/records/authored.ia',
    `#! ia 1.0\n\n${block.replace(/^@observation \S+/, '@observation authored-one').trimEnd()}\n  relationships\n    cites @observation forged-one\n`,
  );
  validateOnce(root);
  const genuine = written(root);
  const baseline = using(structural(root), (db) => ({
    findings: findingLines(db),
    consent: byName(db)['consent-check']!.outcome,
  }));
  expect(baseline.findings.some((finding) => finding.startsWith('IA-GRAPH-TARGET-MISSING'))).toBe(true);
  // The genuine file is admitted, and the authored admission beside it is unchanged.
  using(structural(root, true), (db) => {
    expect(band0(db)).toHaveLength(genuine.text.split('@observation ').length - 1);
    expect(findingLines(db)).toEqual(baseline.findings);
  });
  const genuineName = genuine.text.match(/^@observation (\S+)/m)![1]!;
  // A writer-shaped observation for the prose-scoped check, which is never evaluated and so never recorded.
  const prose = using(structural(root), (db) => db.records().find((record) => record.name === 'prose-check')!),
    wholeAt = genuine.text.indexOf('@observation whole-schema-check'),
    wholeEnd = genuine.text.indexOf('\n\n@observation', wholeAt),
    notEvaluated = genuine.text
      .slice(wholeAt, wholeEnd < 0 ? undefined : wholeEnd + 1)
      .replaceAll('whole-schema-check', 'prose-check')
      .replace(/locator "[^"]+"/, `locator "${prose.identity}"`)
      .replace(/ {4}digest "[0-9a-f]{64}"/, `    digest "${prose.digest}"`)
      .replace(/subject-revision "[0-9a-f]{64}"/, `subject-revision "${prose.digest}"`);
  expect(wholeAt).toBeGreaterThanOrEqual(0);
  const vectors: [string, string][] = [
    // Resolving the authored dangling reference: a name no admitted check's evidence takes.
    ['forged name', genuine.text.replaceAll(genuineName, 'forged-one')],
    // Adding edges into authored records.
    [
      'relationships',
      genuine.text.replace(
        '\n  retention\n    status retained\n',
        '\n  retention\n    status retained\n  relationships\n    supersedes @check whole-schema-check\n',
      ),
    ],
    ['another locator', genuine.text.replace(/locator "[^"]+"/, `locator "${methodId}"`)],
    ['another revision', genuine.text.replace(/ {4}revision "[0-9a-f]{64}"/, `    revision "${'0'.repeat(64)}"`)],
    [
      'a check no view admits',
      genuine.text.replaceAll(genuineName, genuineName.replace('whole-schema-check', 'absent-check')),
    ],
    ['an extra field', genuine.text.replace('    move Verification\n', '    move Verification\n    note "planted"\n')],
    // Writer-shaped, but not what the writer writes for this view.
    ['a forged verdict', genuine.text.replace(/(@observation whole-schema-check[\s\S]*?verdict )success/, '$1refusal')],
    [
      'a forged reason',
      genuine.text.replace(/reason "built-in COMP-SCHEMA[^"]*"/, 'reason "planted: an auditor passed it"'),
    ],
    [
      'a time without milliseconds',
      genuine.text.replace(/(observed|captured)-at "[^"]+"/g, '$1-at "2001-01-01T00:00:00Z"'),
    ],
    [
      'observed and captured apart',
      genuine.text.replace(/captured-at "[^"]+"/, 'captured-at "2001-01-01T00:00:00.000Z"'),
    ],
    [
      'a time not yet reached',
      genuine.text.replace(/(observed|captured)-at "[^"]+"/g, '$1-at "2999-01-01T00:00:00.000Z"'),
    ],
    ['an observation for a check not evaluated', `${genuine.text}\n${notEvaluated}`],
    ['a byte-order mark', `﻿${genuine.text}`],
    ['CRLF line endings', genuine.text.replaceAll('\n', '\r\n')],
  ];
  for (const [label, text] of vectors) {
    expect(text, label).not.toBe(genuine.text);
    put(root, genuine.path, text);
    using(structural(root, true), (db) => {
      expect(band0(db), label).toEqual([]);
      expect(findingLines(db), label).toEqual(baseline.findings);
      expect(byName(db)['consent-check']!.outcome, label).toBe(baseline.consent);
      const rows = db.directedView(byName(db)['whole-schema-check']!.identity);
      expect(
        rows.some((row) => row.counterpart.includes('/observation/')),
        label,
      ).toBe(false);
    });
  }
});

it('renders a failing built-in check as a refusal, failure dominating the real report, which no reader admits for a refused admission (D14)', () => {
  const root = workspace();
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', '*'),
    check('method-schema-check', 'COMP-SCHEMA', methodId),
    // A check without its required scope: refused, with a failing COMP-SCHEMA verdict of its own.
    '@check broken-check\n  meaning\n    says "Broken."\n    answers "What fails?"\n  check\n    runs COMP-SCHEMA\n',
  );
  using(structural(root), (db) => {
    const bound = byName(db),
      failing = db.report.verdicts.filter((verdict) => verdict.check === 'COMP-SCHEMA' && verdict.outcome === 'fail');
    expect(failing.map((verdict) => verdict.scope.split('/').at(-1))).toEqual(['broken-check']);
    expect(db.report.verdicts.some((verdict) => verdict.check === 'COMP-SCHEMA' && verdict.outcome === 'pass')).toBe(
      true,
    );
    // Fail dominates every passing verdict the whole-workspace scope also selects; an exact scope elsewhere passes.
    expect(bound['whole-schema-check']).toMatchObject({ outcome: 'fail' });
    expect(bound['method-schema-check']).toMatchObject({ outcome: 'pass' });
    expect(bound['broken-check']).toBeUndefined();
  });
  const recorded = validateOnce(root);
  expect(recorded.observations.map((row) => [row.name.replace(/-[0-9a-f]{12}$/, ''), row.verdict])).toEqual([
    ['method-schema-check', 'success'],
    ['whole-schema-check', 'refusal'],
  ]);
  // A failing verdict always refuses admission, and the validate request records nothing for a refused admission, so
  // the writer's own output for this view is still not evidence to any reader.
  expect(using(structural(root), (db) => db.report.findings.some((finding) => finding.severity === 'error'))).toBe(
    true,
  );
  using(structural(root, true), (db) => expect(band0(db)).toEqual([]));
  using(open(root, { cache: false, evidence: true }), (db) => expect(band0(db)).toEqual([]));
});

it('prunes best effort, never refusing with nothing to record or for a file it may not remove (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    revision = written(root).revision,
    stalePath = `${EVIDENCE_DIRECTORY}/${'2'.repeat(64)}.ia`,
    stale = resolve(root, stalePath),
    undeletable = Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
  put(root, stalePath, '#! ia 1.0\n');
  vi.mocked(unlinkSync).mockImplementation((target) => {
    if (String(target).endsWith(`${'2'.repeat(64)}.ia`)) throw undeletable;
    actualFs.unlinkSync(target);
  });
  try {
    // Unchanged bytes: nothing to write, and the stale file it may not remove is skipped.
    expect(writeEvidence(root, revision, readFileSync(resolve(root, first.path!), 'utf8'))).toEqual({
      path: first.path,
      written: false,
      pruned: [],
    });
    expect(existsSync(stale)).toBe(true);
    // Nothing to record: still no refusal, though the file it may not remove stays.
    expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: true, pruned: [first.path] });
    expect(existsSync(stale)).toBe(true);
    validateOnce(root);
  } finally {
    vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync);
  }
  // A file modified after the run read its inputs, as a validation of another revision may write one, is kept.
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(resolve(root, first.path!), hourAgo, hourAgo);
  expect(writeEvidence(root, revision, null, { pruneBefore: statSync(stale).mtimeMs })).toMatchObject({
    pruned: [first.path],
  });
  expect(existsSync(stale)).toBe(true);
  expect(writeEvidence(root, revision, null, { pruneBefore: Date.now() + 60_000 }).pruned).toEqual([stalePath]);
  // Nothing to record with a directory where this revision's file goes: nothing is done, and nothing refuses.
  mkdirSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`), { recursive: true });
  expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: false, pruned: [] });
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
});

it('records no observation under a name an authored observation already holds (D14)', () => {
  const root = workspace(),
    authoredRevision = 'a'.repeat(64),
    name = `whole-schema-check-${authoredRevision.slice(0, 12)}`;
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', WHOLE_WORKSPACE_SCOPE));
  const observe = () =>
    using(structural(root), (db) =>
      evidenceText({
        authoredRevision,
        bindings: bindChecks(db.records(), db.report, NONE),
        records: db.records(),
        prior: null,
      }),
    );
  const first = observe();
  expect(first.observations.map((observation) => observation.name)).toContain(name);
  put(root, '.ia/src/systems/learning-system/records/authored-observation.ia', first.text!);
  expect(observe().observations.map((observation) => observation.name)).not.toContain(name);
});

it('binds no check placed at runtime band (D13)', () => {
  const root = workspace();
  fixture(root, check('runtime-check', 'COMP-SCHEMA', WHOLE_WORKSPACE_SCOPE));
  using(structural(root), (db) => expect(byName(db)).toHaveProperty('runtime-check'));
  using(
    open(root, {
      cache: false,
      checks: 'structural',
      locations: { [CHECKS]: { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' } },
    }),
    (db) => {
      expect(db.records().some((record) => record.name === 'runtime-check' && record.band === 0)).toBe(true);
      expect(byName(db)).not.toHaveProperty('runtime-check');
    },
  );
});

it.skipIf(process.platform === 'win32')('prunes no FIFO named like an evidence file (D14)', async () => {
  const root = workspace(false),
    stale = resolve(root, EVIDENCE_DIRECTORY, `${'b'.repeat(64)}.ia`);
  await fifo(stale);
  expect(writeEvidence(root, 'a'.repeat(64), null).pruned).toEqual([]);
  expect(lstatSync(stale).isFIFO()).toBe(true);
});

it('previews a draft as the handle admits it, never with evidence, and caches no structural graph (D13)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  validateOnce(root);
  const draft = [{ path: CHECKS, text: `#! ia 1.0\n\n${check('typing-check', 'acme-strict-typing', 'package')}` }];
  const unknown = (db: Handle) =>
    db.preview(draft).report.findings.some((finding) => finding.code === 'IA-COMP-CHECK-UNKNOWN');
  using(open(root, { cache: false }), (db) => expect(unknown(db)).toBe(true));
  using(structural(root, true), (db) => {
    expect(band0(db)).toHaveLength(1);
    expect(unknown(db)).toBe(false);
    expect(db.preview([]).records.some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(
      false,
    );
  });
  // Neither a structural nor an evidence reader publishes its graph, whatever cache says; a strict one still does.
  const cache = resolve(root, '.ia/.iadb/graph.json');
  using(open(root, { checks: 'structural', cache: true }), () => undefined);
  using(open(root, { evidence: true }), () => undefined);
  expect(existsSync(cache)).toBe(false);
  using(open(root), () => undefined);
  expect(existsSync(cache)).toBe(true);
});

it('opens an editor database structurally only when asked, and lists no evidence into it or its drafts (D13)', () => {
  const root = workspace();
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', '*'),
    check('typing-check', 'acme-strict-typing', 'package'),
  );
  expect(validateOnce(root).written).toBe(true);
  // The file is evidence a reader that asks for it admits.
  const plain = using(structural(root), (db) => db.revision);
  using(structural(root, true), (db) => {
    expect(band0(db)).toHaveLength(1);
    expect(db.revision).not.toBe(plain);
  });
  const typing = (records: readonly { readonly name: string }[]) =>
    records.some((record) => record.name === 'typing-check');
  const text = `${readFileSync(resolve(root, CHECKS), 'utf8')}\n${check('lint-check', 'acme-lint', 'package')}`;
  // Strict by default, as every other editor caller has it: the record is refused, and so is a draft's.
  const strict = new EditorDatabase(root);
  try {
    expect(typing(strict.current.records())).toBe(false);
    expect(strict.current.report.findings.map((finding) => finding.code)).toContain('IA-COMP-CHECK-UNKNOWN');
    expect(strict.current.preview([{ path: CHECKS, text }]).records.some((r) => r.name === 'lint-check')).toBe(false);
  } finally {
    strict.close();
  }
  const editor = new EditorDatabase(root, { checks: 'structural' });
  try {
    const current = editor.current;
    expect(typing(current.records())).toBe(true);
    expect(current.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    // No evidence is listed: nothing at runtime placement, and the revision every evidence-free reader reports.
    expect(current.records().some((record) => record.placement.kind === 'runtime')).toBe(false);
    expect(current.revision).toBe(plain);
    expect(current.authoredRevision).toBe(plain);
    // Its drafts, candidates, overlays and refreshes admit structurally too, and none lists evidence.
    const draft = current.preview([{ path: CHECKS, text }]);
    expect(draft.records.some((record) => record.name === 'lint-check')).toBe(true);
    expect(draft.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(draft.records.some((record) => record.placement.kind === 'runtime')).toBe(false);
    const candidate = current.candidate([{ path: CHECKS, text, version: 1 }]);
    expect(candidate.records().some((record) => record.name === 'lint-check')).toBe(true);
    candidate.close();
    expect(
      editor
        .update([{ path: CHECKS, text, version: 1 }])
        .records()
        .some((r) => r.name === 'lint-check'),
    ).toBe(true);
    const refreshed = editor.update([], true);
    expect(typing(refreshed.records())).toBe(true);
    expect(refreshed.records().some((record) => record.placement.kind === 'runtime')).toBe(false);
    expect(refreshed.revision).toBe(plain);
  } finally {
    editor.close();
  }
});

it('never counts COMP-CHECK passing a check only structural admission admits (D13)', () => {
  const root = workspace();
  fixture(root, check('check-check', 'COMP-CHECK', '*'));
  expect(using(structural(root), (db) => byName(db)['check-check']!.outcome)).toBe('pass');
  fixture(root, check('check-check', 'COMP-CHECK', '*'), check('typing-check', 'acme-strict-typing', 'package'));
  using(structural(root), (db) => {
    expect(byName(db)['check-check']).toMatchObject({ outcome: 'not-evaluated' });
    const raw = db.report.verdicts.find(
      (verdict) => verdict.check === 'COMP-CHECK' && verdict.scope.endsWith('/typing-check'),
    );
    expect(raw?.outcome).toBe('pass');
  });
});

it('touches an unchanged current file, so a validation of an older revision that began earlier never prunes it (D14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    current = resolve(root, first.path!),
    text = readFileSync(current, 'utf8'),
    revision = written(root).revision;
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(current, hourAgo, hourAgo);
  // An older revision's validation opened now, before the current run below found its file unchanged.
  const olderOpened = Date.now() - 1_000;
  expect(writeEvidence(root, revision, text)).toEqual({ path: first.path, written: false, pruned: [] });
  expect(statSync(current).mtimeMs).toBeGreaterThanOrEqual(olderOpened);
  expect(writeEvidence(root, '9'.repeat(64), null, { pruneBefore: olderOpened }).pruned).toEqual([]);
  expect(readFileSync(current, 'utf8')).toBe(text);
});

it('replaces the evidence file while another process holds it open, as a concurrent validate reading it does (D14)', async () => {
  // On win32 a replacing rename fails (EPERM) while any other handle holds the target: a concurrent validate reading the
  // evidence it found. The writer retries until the reader lets go, so one whole file, the writer's bytes, results.
  const root = workspace(false),
    revision = 'b'.repeat(64),
    path = resolve(root, EVIDENCE_DIRECTORY, `${revision}.ia`);
  expect(writeEvidence(root, revision, '#! ia 1.0\n# first\n').written).toBe(true);
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(path)}, 'r'); process.stdout.write('open'); setTimeout(() => fs.closeSync(fd), 400);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  const closed = new Promise((done) => holder.on('close', done));
  await new Promise((ready) => holder.stdout.once('data', ready));
  const write = writeEvidence(root, revision, '#! ia 1.0\n# second\n');
  await closed;
  expect(write).toEqual({ path: `${EVIDENCE_DIRECTORY}/${revision}.ia`, written: true, pruned: [] });
  expect(readFileSync(path, 'utf8')).toBe('#! ia 1.0\n# second\n');
  expect(readdirSync(resolve(root, EVIDENCE_DIRECTORY))).toEqual([`${revision}.ia`]);
});
it.skipIf(!constants.O_NOCTTY)(
  'opens an evidence file with the no-controlling-terminal flag where the platform has it',
  () => {
    const root = workspace(false),
      path = `${EVIDENCE_DIRECTORY}/${'0'.repeat(64)}.ia`,
      file = resolve(root, path);
    put(root, path, '#! ia 1.0\n');
    vi.mocked(openSync).mockClear();
    expect(readEvidence(root, path)).toBe('#! ia 1.0\n');
    const flags = vi
      .mocked(openSync)
      .mock.calls.filter(([target]) => String(target) === file)
      .map(([, flags]) => Number(flags));
    // The flags every reader that opens a name before it judges it shares, so no open can drift from the others.
    expect(flags).toEqual([OPENED_READ_FLAGS]);
    expect(flags[0]! & constants.O_NOCTTY).toBe(constants.O_NOCTTY);
  },
);
