import { existsSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Report } from '@inventarch/compliance';
import { KERNEL_DIGEST, KERNEL_SOURCES, LANGUAGE_VERSION } from '@inventarch/language';
import { bindChecks, EVIDENCE_DIRECTORY, evidenceText, open, readEvidence, writeEvidence } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

// D10: the conformance producers, wrapped but unchanged, so a test can count the runs a reader starts.
// The wrapper keeps the count, not mock history, which Vitest 5 clears before every test.
const produced = vi.hoisted(() => ({ kernel: 0, fixtures: 0, unavailable: false }));
vi.mock('@inventarch/compliance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/compliance')>();
  return {
    ...actual,
    verifyKernel: (...args: Parameters<typeof actual.verifyKernel>) => {
      produced.kernel += 1;
      const result = actual.verifyKernel(...args);
      return produced.unavailable
        ? { ...result, assessment: { ...result.assessment, outcome: 'not-evaluated' as const } }
        : result;
    },
    verifyFixtures: (...args: Parameters<typeof actual.verifyFixtures>) => {
      produced.fixtures += 1;
      const result = actual.verifyFixtures(...args);
      return produced.unavailable
        ? { ...result, assessment: { ...result.assessment, outcome: 'not-evaluated' as const } }
        : result;
    },
  };
});

describe('cache-free editor capture', () => {
  it('shares disk admission and preserves the existing draft contract', () => {
    const root = workspace(),
      editor = new EditorDatabase(root),
      disk = open(root, { cache: false });
    expect(editor.current.records()).toEqual(disk.records());
    expect(editor.current.report).toEqual(disk.report);
    const text = readFileSync(resolve(root, methodPath), 'utf8').replace('sample-procedure', 'another-method');
    const candidate = editor.current.candidate([{ path: methodPath, text, version: 1 }]);
    expect(candidate.records()).toEqual(disk.preview([{ path: methodPath, text }]).records);
    expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
    expect(disk.get(methodId)).toBeDefined();
    candidate.close();
    editor.close();
    disk.close();
  });
  it('refuses the complete dirty file, retains healthy sources, and retires old scope issuers', () => {
    const root = workspace(),
      editor = new EditorDatabase(root),
      previous = editor.current;
    const scope = previous.resolveScope();
    editor.update([{ path: methodPath, text: '#! ia 9.0\n@playbook broken\n', version: 2 }]);
    expect(editor.current.get(methodId)).toBeUndefined();
    expect(editor.current.records().length).toBeGreaterThan(100);
    expect(editor.current.report.findings.some((f) => f.code === 'IA-LANG-VERSION-UNSUPPORTED')).toBe(true);
    expect(() => previous.records({ within: scope.token })).toThrow('IA-DB-CLOSED');
    expect(() => editor.current.records({ within: scope.token })).toThrow('IA-DB-SCOPE-UNAVAILABLE');
    expect(() => editor.update([{ path: methodPath, text: '', version: 1 }])).toThrow('IA-DB-STALE');
    expect(() => editor.update([{ path: methodPath, text: '', version: 2 }])).toThrow('IA-DB-STALE');
    editor.update([]);
    expect(editor.current.get(methodId)).toBeDefined();
    editor.close();
    expect(() => editor.update([])).toThrow('IA-DB-CLOSED');
  });
  it('reconciles disk deletion and supports local floor overlays without writing source', () => {
    const root = workspace(),
      editor = new EditorDatabase(root);
    const source = editor.current.sources.find((s) => s.path.startsWith('.ia/src/floor/'))!;
    expect(source.origin).toBe('local');
    editor.update([{ path: source.path, text: '#! ia 1.0\n', version: 1 }]);
    expect(readFileSync(resolve(root, source.path), 'utf8')).toBe(source.text);
    unlinkSync(resolve(root, methodPath));
    editor.update([], true);
    expect(editor.current.sources.some((s) => s.path === methodPath)).toBe(false);
    editor.close();
  });
  it('refuses virtual floor edits, path escapes, and duplicate aliases', () => {
    const root = workspace(false),
      editor = new EditorDatabase(root),
      floor = editor.current.sources[0]!;
    expect(floor.origin).toBe('embedded');
    expect(floor.writable).toBe(false);
    expect(() => editor.update([{ path: floor.path, text: '', version: 1 }])).toThrow('read-only');
    expect(() => editor.update([{ path: '../escape.ia', text: '', version: 1 }])).toThrow();
    expect(() =>
      editor.update([
        { path: '.ia/src/x.ia', text: '', version: 1 },
        { path: '.ia/src/x.ia', text: '', version: 2 },
      ]),
    ).toThrow('duplicate');
    expect(editor.current.sources[0]).toEqual(floor);
    editor.close();
  });
  it('refuses an overlay of a source a location override places outside the workspace', () => {
    const root = workspace(false),
      vendored = '.ia/src/vendored.ia';
    put(root, vendored, '#! ia 1.0\n');
    const editor = new EditorDatabase(root, {
      locations: { [vendored]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
    });
    try {
      expect(editor.current.sources.find((source) => source.path === vendored)?.writable).toBe(false);
      expect(() => editor.update([{ path: vendored, text: '#! ia 1.0\n# rewritten\n', version: 1 }])).toThrow(
        expect.objectContaining({
          code: 'IA-DB-DRAFT-INVALID',
          message: 'IA-DB-DRAFT-INVALID: Non-workspace sources are read-only',
        }),
      );
    } finally {
      editor.close();
    }
  });
  it('refuses an overlay whose path passes through a link', () => {
    const root = workspace(false),
      outside = workspace(false);
    put(root, '.ia/src/kept.ia', '#! ia 1.0\n');
    const editor = new EditorDatabase(root);
    try {
      symlinkSync(outside, resolve(root, '.ia/src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => editor.update([{ path: '.ia/src/linked/x.ia', text: '#! ia 1.0\n', version: 1 }])).toThrow(
        expect.objectContaining({
          code: 'IA-DB-PATH-UNSAFE',
          message: expect.stringContaining('Symlink/junction traversal is not admitted'),
          path: '.ia/src/linked',
        }),
      );
    } finally {
      editor.close();
    }
  });
  it('refuses an overlay whose version is negative or fractional', () => {
    const editor = new EditorDatabase(workspace(false));
    try {
      for (const version of [-1, 1.5])
        expect(() => editor.update([{ path: '.ia/src/x.ia', text: '#! ia 1.0\n', version }]), String(version)).toThrow(
          expect.objectContaining({
            code: 'IA-DB-DRAFT-INVALID',
            message: 'IA-DB-DRAFT-INVALID: Invalid, duplicate or aliased editor overlay',
          }),
        );
    } finally {
      editor.close();
    }
  });
  it('retains location and phase scope enforcement in preview readers', () => {
    const root = workspace(),
      path = '.ia/src/example.ia';
    put(root, path, '#! ia 1.0\n@playbook local\n  meaning\n    says "Only local"\n');
    const editor = new EditorDatabase(root, {
      locations: { [path]: { placement: { kind: 'authored', band: 100, reach: 'area' }, provenance: 'workspace' } },
    });
    expect(editor.current.sources.find((s) => s.path === path)?.location.placement.reach).toBe('area');
    const scope = editor.current.resolveScope({ root: 'area', identities: [methodId] });
    expect(editor.current.records({ within: scope.token }).map((r) => r.identity)).toEqual([methodId]);
    expect(() => editor.current.records({ within: scope.token, root: '' })).toThrow('IA-DB-SCOPE-MISMATCH');
    editor.close();
  });
});

describe('conformance verification (D10)', () => {
  const draft = { path: '.ia/src/draft.ia', text: '#! ia 1.0\n' };
  /** How many times this process has run each producer. */
  const runs = () => ({ kernel: produced.kernel, fixtures: produced.fixtures });
  /** The report's COMP-KERNEL and COMP-FIXTURES verdicts, with their basis when they carry one. */
  const conformance = (report: Report) =>
    report.verdicts
      .filter((verdict) => verdict.check === 'COMP-KERNEL' || verdict.check === 'COMP-FIXTURES')
      .map(({ check, outcome, basis }) => ({ check, outcome, ...(basis === undefined ? {} : { basis }) }))
      .sort((a, b) => a.check.localeCompare(b.check));
  const verified = (kernel: 'pass' | 'fail') => [
    { check: 'COMP-FIXTURES', outcome: 'pass', basis: 'verified' },
    { check: 'COMP-KERNEL', outcome: kernel, basis: 'verified' },
  ];
  const unverified = [
    { check: 'COMP-FIXTURES', outcome: 'not-evaluated' },
    { check: 'COMP-KERNEL', outcome: 'not-evaluated' },
  ];
  /**
   * A workspace whose local floor is the embedded floor with one byte of one `says` text changed to `byte` (to `y` where
   * it already is `byte`), so two different bytes give two different floors.
   */
  const changedFloor = (byte = 'x'): string => {
    const root = workspace(false),
      [changed] = KERNEL_SOURCES.filter((source) => source.text.includes('says "'));
    for (const source of KERNEL_SOURCES) {
      const at = source.text.indexOf('says "') + 'says "'.length;
      put(
        root,
        source.path,
        source === changed
          ? source.text.slice(0, at) + (source.text[at] === byte ? 'y' : byte) + source.text.slice(at + 1)
          : source.text,
      );
    }
    return root;
  };

  it('verifies both checks for an embedded floor when the reader asks, and its candidates inherit it', () => {
    const root = workspace(false),
      editor = new EditorDatabase(root, { conformance: 'verify' }),
      report = editor.current.report;
    expect(conformance(report)).toEqual(verified('pass'));
    expect(report.conformance?.profile).toBe('package-v1');
    expect(report.conformance?.kernel?.floorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.conformance?.fixtures?.outOfProfile.map((suite) => suite.suite)).toEqual([
      'HOOK',
      'RUNTIME',
      'escalation',
      'EXEC',
      'PUBLICATION',
    ]);
    expect(conformance(editor.current.inspect({ phase: 'act' }).report)).toEqual(verified('pass'));
    const candidate = editor.current.candidate([{ ...draft, version: 1 }]);
    expect(conformance(candidate.report)).toEqual(verified('pass'));
    editor.update([{ ...draft, version: 1 }]);
    expect(conformance(editor.current.report)).toEqual(verified('pass'));
    candidate.close();
    editor.close();
  });
  it('verifies through a disk handle and its drafts, and leaves the graph cache as an unverified open writes it', () => {
    // The embedded floor: the native example corpus keeps a floor of its own, which COMP-KERNEL rightly fails.
    const root = workspace(false),
      cache = resolve(root, '.ia/.iadb/graph.json'),
      plain = open(root);
    const bytes = readFileSync(cache);
    plain.close();
    const disk = open(root, { conformance: 'verify' });
    expect(disk.cache.state).toBe('hit');
    expect(conformance(disk.report)).toEqual(verified('pass'));
    expect(conformance(disk.preview([draft]).report)).toEqual(verified('pass'));
    expect(readFileSync(cache)).toEqual(bytes);
    disk.close();
    // A verifying open on a fresh root writes the cache, the same bytes an unverified open writes there.
    const fresh = workspace(false),
      freshCache = resolve(fresh, '.ia/.iadb/graph.json'),
      written = open(fresh, { conformance: 'verify' });
    expect(written.cache.state).toBe('written');
    written.close();
    const verifiedBytes = readFileSync(freshCache);
    rmSync(freshCache);
    open(fresh).close();
    expect(readFileSync(freshCache)).toEqual(verifiedBytes);
  });
  it('fails COMP-KERNEL for a local floor one byte away from the embedded one, instead of leaving it unevaluated', () => {
    const root = changedFloor(),
      editor = new EditorDatabase(root, { conformance: 'verify' }),
      embedded = new EditorDatabase(workspace(false), { conformance: 'verify' }),
      plain = new EditorDatabase(root);
    expect(editor.current.sources.find((source) => source.path.startsWith('.ia/src/floor/'))?.origin).toBe('local');
    expect(conformance(editor.current.report)).toEqual(verified('fail'));
    expect(editor.current.report.outcome).toBe('fail');
    expect(editor.current.report.conformance?.kernel?.floorDigest).not.toBe(
      embedded.current.report.conformance?.kernel?.floorDigest,
    );
    expect(conformance(plain.current.report)).toEqual(unverified);
    editor.close();
    embedded.close();
    plain.close();
  });
  it('runs no producer and changes nothing for a reader that does not ask', () => {
    const before = runs(),
      root = workspace(),
      editor = new EditorDatabase(root),
      structural = new EditorDatabase(root, { checks: 'structural' }),
      disk = open(root, { cache: false }),
      candidate = editor.current.candidate([{ ...draft, version: 1 }]);
    const reports = [editor.current.report, structural.current.report, disk.report, candidate.report];
    reports.push(disk.preview([draft]).report);
    for (const report of reports) {
      expect(conformance(report)).toEqual(unverified);
      expect(report).not.toHaveProperty('conformance');
    }
    expect(runs()).toEqual(before);
    candidate.close();
    editor.close();
    structural.close();
    disk.close();
  });
  it('retries unevaluated producers and caches their subsequent evaluated result', async () => {
    vi.resetModules();
    const { conformanceOf } = await import('../src/conformance.js');
    const inputs = {
      sources: KERNEL_SOURCES.map((source) => ({
        ...source,
        location: {
          placement: { kind: 'floor' as const, band: 10 as const, reach: '' },
          provenance: 'bootstrap' as const,
        },
      })),
      languageVersion: LANGUAGE_VERSION,
      kernelDigest: KERNEL_DIGEST,
    };
    const before = runs();
    produced.unavailable = true;
    try {
      conformanceOf(inputs);
      conformanceOf(inputs);
      expect(runs()).toEqual({ kernel: before.kernel + 2, fixtures: before.fixtures + 2 });
    } finally {
      produced.unavailable = false;
    }
    conformanceOf(inputs);
    conformanceOf(inputs);
    expect(runs()).toEqual({ kernel: before.kernel + 3, fixtures: before.fixtures + 3 });
  });
  it('evicts the least recently used floor after sixteen entries and refreshes hits', () => {
    const roots = Array.from({ length: 17 }, (_, index) => changedFloor(`cache-floor-${index}`));
    const verify = (root: string) => new EditorDatabase(root, { conformance: 'verify' }).close();
    const before = runs();
    for (const root of roots.slice(0, 16)) verify(root);
    expect(runs().kernel).toBe(before.kernel + 16);
    verify(roots[0]!); // Refresh the oldest entry before inserting the seventeenth.
    verify(roots[16]!);
    expect(runs().kernel).toBe(before.kernel + 17);
    verify(roots[0]!);
    expect(runs().kernel).toBe(before.kernel + 17);
    verify(roots[1]!); // This floor, rather than the refreshed first one, was evicted.
    expect(runs().kernel).toBe(before.kernel + 18);
  });
  it('runs the fixture profile once per process and the kernel once per floor', () => {
    const embedded = workspace(false);
    new EditorDatabase(embedded, { conformance: 'verify' }).close();
    const warmed = runs();
    expect(warmed.fixtures).toBeGreaterThan(0);
    const again = new EditorDatabase(embedded, { conformance: 'verify' }),
      disk = open(embedded, { conformance: 'verify', cache: false });
    again.update([{ ...draft, version: 1 }]);
    expect(runs()).toEqual(warmed);
    // Another floor than the one-byte floor above, which an earlier test may already have verified in this process.
    const changed = changedFloor('z'),
      first = new EditorDatabase(changed, { conformance: 'verify' });
    expect(runs()).toEqual({ kernel: warmed.kernel + 1, fixtures: warmed.fixtures });
    const second = open(changed, { conformance: 'verify', cache: false });
    expect(runs()).toEqual({ kernel: warmed.kernel + 1, fixtures: warmed.fixtures });
    expect(conformance(second.report)).toEqual(verified('fail'));
    for (const reader of [again, disk, first, second]) reader.close();
  });
  it('keeps verifying across a handle refresh, an editor refresh and a location view', () => {
    const root = workspace(false),
      disk = open(root, { conformance: 'verify' }),
      editor = new EditorDatabase(root, { conformance: 'verify' });
    put(root, draft.path, draft.text);
    disk.refresh();
    expect(conformance(disk.report)).toEqual(verified('pass'));
    editor.update([], true);
    expect(editor.current.sources.some((source) => source.path === draft.path)).toBe(true);
    expect(conformance(editor.current.report)).toEqual(verified('pass'));
    expect(conformance(editor.current.inspect({ root: 'area' }).report)).toEqual(verified('pass'));
    disk.close();
    editor.close();
  });

  const CHECKS = '.ia/src/systems/compliance-system/checks/bound-checks.ia';
  /** A whole-workspace `@check` in the native compliance system naming `runner`. */
  const check = (name: string, runner: string) => `@check ${name}
  meaning
    says "Bind ${name} for the test."
    answers "What does ${name} select?"
  check
    runs ${runner}
    scope "*"
  governance
    severity blocking
  relationships
    enforces @contract foundation-authoring-contract
`;
  const reader = (root: string, verify: boolean) =>
    open(root, { cache: false, checks: 'structural', evidence: true, ...(verify ? { conformance: 'verify' } : {}) });
  /** Records D14 evidence as the validate request does, which does not verify; returns the observations it wrote. */
  const validate = (root: string) => {
    const db = reader(root, false);
    try {
      const built = evidenceText({
        authoredRevision: db.authoredRevision,
        bindings: bindChecks(db.records(), db.report, { status: 'unavailable', reason: 'no catalog' }),
        records: db.records(),
        prior: readEvidence(root, `${EVIDENCE_DIRECTORY}/${db.authoredRevision}.ia`),
        // In the past: D14 refuses a time more than five minutes ahead of the reading clock.
        now: new Date('2026-10-11T12:00:00.000Z'),
      });
      writeEvidence(root, db.authoredRevision, built.text);
      return built.observations.map((observation) => [observation.check, observation.verdict]);
    } finally {
      db.close();
    }
  };
  /** Opens `root` with and without verification; both must admit the evidence and so read one graph. */
  const sameEvidence = (root: string): Report => {
    const plain = reader(root, false),
      verifying = reader(root, true);
    try {
      expect(plain.revision).not.toBe(plain.authoredRevision);
      expect(verifying.authoredRevision).toBe(plain.authoredRevision);
      expect(verifying.revision).toBe(plain.revision);
      expect(verifying.records()).toEqual(plain.records());
      expect(conformance(plain.report)).toEqual(unverified);
      return verifying.report;
    } finally {
      plain.close();
      verifying.close();
    }
  };
  it('admits the same D14 evidence, and so the same graph, when a whole-workspace check runs a verified check', () => {
    const root = workspace();
    // The embedded floor, so COMP-KERNEL passes once verified.
    rmSync(resolve(root, '.ia/src/floor'), { recursive: true });
    put(root, CHECKS, `#! ia 1.0\n\n${check('kernel-check', 'COMP-KERNEL')}\n${check('schema-check', 'COMP-SCHEMA')}`);
    // Unverified, COMP-KERNEL is not-evaluated, so validation records only the schema check.
    expect(validate(root)).toEqual([['compliance-system/check/gate/schema-check', 'success']]);
    expect(conformance(sameEvidence(root))).toEqual(verified('pass'));
  });
  it('admits the same D14 evidence, and so the same graph, when verification fails the report', () => {
    // The native example's own floor, which COMP-KERNEL fails once verified.
    const root = workspace();
    put(root, CHECKS, `#! ia 1.0\n\n${check('schema-check', 'COMP-SCHEMA')}`);
    expect(validate(root)).toEqual([['compliance-system/check/gate/schema-check', 'success']]);
    const report = sameEvidence(root);
    expect(conformance(report)).toEqual(verified('fail'));
    expect(report.outcome).toBe('fail');
  });
});
