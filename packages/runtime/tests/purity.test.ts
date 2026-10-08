import { basename, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CAPTURE_FORMAT, writeCapture } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { digest } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { K0, context, normalizeScopeKey, position, positionBody, resolveScopeKey } from '../src/index.js';
import type { PositionBody, PositionOutput, ScopeKey } from '../src/index.js';
import { database, law, lawId, lawPath, put, workspace } from './workspace.js';

// R16 (position-and-projection §1 and item 11; plan amendment A9): position(handle, within, partial) returns body(K),
// its digest and the host note. The body is a function of the key and the admitted revision alone: no root, token,
// request text or capture enters it, and no record at runtime placement (band 0) does (decision evidence-placement),
// though the revision and admission's findings still read every placement (R15, R16: the limits pinned below).
const governanceSystem = 'floor/definition/system/governance-system',
  foundation = 'workspace-system/definition/workspace/foundation-workspace',
  check = 'compliance-system/check/gate/instance-schema-check',
  records = '.ia/src/systems/governance-system/records';
const KEYS: Readonly<Record<string, Partial<ScopeKey>>> = {
  k0: {},
  'governance-at-law': { seat: lawId, shape: 'governance' },
  'sequence-depth-2': { shape: 'sequence', depth: 2 },
  'word-law': { seat: governanceSystem, shape: 'governance', word: 'law' },
  'system-governance': { seat: governanceSystem, shape: 'governance', depth: 2 },
  'check-frontier': { seat: check, shape: 'governance', depth: 0 },
  location: { seat: { path: 'src/billing/invoice.ts' }, depth: 0, budget: 0 },
  // No record is declared at a path under .ia/work: only claims compose it.
  'claimed-location': { seat: { path: '.ia/work/notes/billing.md' }, depth: 0, budget: 0 },
};
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
const at = (db: Handle, partial: Partial<ScopeKey>, within = db.resolveScope().token): PositionOutput =>
  position(db, within, partial);
const text = (body: PositionBody): string => JSON.stringify(body);
const captureOf = (db: Handle): string =>
  `${JSON.stringify({ format: CAPTURE_FORMAT, revision: db.revision, membership: db.snapshot().membership })}\n`;
const refusal = (message: string) =>
  expect.objectContaining({ code: 'IA-RUNTIME-REQUEST-INVALID', message: expect.stringContaining(message) });
/** An observation of `subject`, shaped as the delivery fixtures write one. */
const observation = (name: string, subject: string): string =>
  [
    `@observation ${name}`,
    '  meaning',
    `    says "A success observed on ${subject}."`,
    '    answers "Did it work?"',
    '  evidence',
    '    origin check',
    '    actor "ia-compliance@1.1.0"',
    '    observed-at "2026-10-08T00:00:00Z"',
    '    captured-at "2026-10-08T00:00:00Z"',
    '    workspace "foundation"',
    `    locator "${subject}"`,
    `    revision "${'1'.repeat(64)}"`,
    `    bundle ".ia/learning/observations/${name}.json"`,
    `    digest "${'0'.repeat(64)}"`,
    '    availability unavailable',
    `    subject ${subject}`,
    `    subject-revision "${'1'.repeat(64)}"`,
    '    evaluator "ia-compliance@1.1.0"',
    '    move Verification',
    '    verdict success',
    '  interpretation',
    '    applies "The subject at the named revision only."',
    '    limits "A test record."',
    '    reason "Runtime-band evidence."',
    '    basis inference',
    '  retention',
    '    status retained',
    '',
  ].join('\n');

it('gives one key on two copies of the corpus at different roots byte-equal bodies and digests, root-free', () => {
  const first = database(workspace()),
    second = database(workspace());
  expect(first.root).not.toBe(second.root);
  expect(first.revision).toBe(second.revision);
  for (const [name, partial] of Object.entries(KEYS)) {
    const a = at(first, partial),
      b = at(second, partial);
    expect(text(b.body), name).toBe(text(a.body));
    expect(b.digest, name).toBe(a.digest);
    // The digest is graph's codec digest of the body.
    expect(a.digest, name).toBe(digest(a.body));
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  }
  // A location spelled as an absolute path under each root: the body names its root-relative path, and only the
  // host note keeps the key as the caller spelled it.
  const outputs = [first, second].map((db) => {
    const within = db.resolveScope().token,
      output = position(db, within, { seat: { path: resolve(db.root, lawPath) }, shape: 'governance' }),
      body = text(output.body);
    for (const spelling of [db.root, db.root.replaceAll('\\', '/'), JSON.stringify(db.root).slice(1, -1)])
      expect(body).not.toContain(spelling);
    expect(body).not.toContain(basename(db.root));
    expect(body).not.toContain(within);
    expect(output.body.key.seat).toEqual({ path: lawPath });
    expect(output.hostNote.key.seat).toEqual({ path: resolve(db.root, lawPath) });
    return output;
  });
  expect(text(outputs[1]!.body)).toBe(text(outputs[0]!.body));
  expect(outputs[1]!.digest).toBe(outputs[0]!.digest);
  expect(outputs[1]!.hostNote).not.toEqual(outputs[0]!.hostNote);
});

it('moves only the host note when a capture is written, and names no capture revision in the body', () => {
  const root = workspace(),
    db = database(root),
    within = db.resolveScope().token,
    revision = db.revision;
  // No capture: the note says so and names no captured or previous revision.
  const before = at(db, {}, within);
  expect(before.hostNote).toEqual({ revision, freshness: 'no-capture', key: K0 });
  expect(Object.keys(before.hostNote)).toEqual(['revision', 'freshness', 'key']);
  expect(Object.isFrozen(before) && Object.isFrozen(before.hostNote)).toBe(true);
  // `ia capture` writes the pair at this revision; the handle reads it again on refresh, and the token holds.
  writeCapture(root, captureOf(db));
  db.refresh();
  const uncaptured = database(workspace());
  for (const [name, partial] of Object.entries(KEYS)) {
    const plain = at(uncaptured, partial),
      captured = at(db, partial, within);
    expect(text(captured.body), name).toBe(text(plain.body));
    expect(captured.digest, name).toBe(plain.digest);
  }
  const current = at(db, {}, within);
  expect(text(current.body)).toBe(text(before.body));
  expect(current.digest).toBe(before.digest);
  expect(current.hostNote).toEqual({ revision, capturedRevision: revision, freshness: 'current', key: K0 });
  // A handle opened after the capture reads the same note.
  expect(at(database(root), {}).hostNote).toEqual(current.hostNote);
  // An edit after the capture: the capture is stale and the earlier revision is previous. The body is the new
  // revision's, and names neither.
  put(root, `${records}/later-rule.ia`, law('later-rule', 'advisory'));
  db.refresh();
  const stale = at(db, { seat: governanceSystem, shape: 'governance' });
  expect(stale.hostNote).toEqual({
    revision: db.revision,
    capturedRevision: revision,
    previousRevision: revision,
    freshness: 'stale',
    key: { seat: governanceSystem, shape: 'governance', phase: 'plan', depth: 1, budget: 16 },
  });
  expect(stale.body.revision).toBe(db.revision);
  expect(text(stale.body)).not.toContain(revision);
  expect(stale.body.loaded).toContainEqual(
    expect.objectContaining({ identity: 'governance-system/governance/law/later-rule' }),
  );
});

it('runs nothing text-driven: text or a token is refused, and a context call with any text moves nothing', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  for (const part of ['text', 'token', 'within'])
    expect(
      () => position(db, within, { [part]: 'what governs billing' } as unknown as Partial<ScopeKey>),
      part,
    ).toThrow(
      expect.objectContaining({
        code: 'IA-RUNTIME-REQUEST-INVALID',
        message: expect.stringContaining(`Unknown scope key part '${part}'`),
      }),
    );
  for (const token of ['', undefined])
    expect(() => position(db, token as unknown as string)).toThrow(
      expect.objectContaining({ code: 'IA-RUNTIME-REQUEST-INVALID' }),
    );
  expect(() => position(db, 'forged')).toThrow(expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }));
  const before = Object.values(KEYS).map((partial) => at(db, partial, within));
  // The version 1 `context` operation's function, as the Door calls it, with request text in both rankings, on the
  // same handle and token.
  const tokens: string[] = [];
  for (const [request, ranking] of [
    ['what governs src/billing/invoice.ts', 'topical'],
    ['sample fixture statement enforce the law', 'native'],
  ] as const) {
    const got = context(
      db,
      { within, text: request, coordinate: { phase: 'act', primitive: 'Decision', category: 'process' } },
      { tokens: 4000, records: 50 },
      { purpose: true, ranking },
    );
    expect(got.ok, request).toBe(true);
    if (got.ok) tokens.push(got.packet.scope.token);
  }
  for (const [index, partial] of Object.values(KEYS).entries()) {
    const after = at(db, partial, within);
    expect(text(after.body)).toBe(text(before[index]!.body));
    expect(after.digest).toBe(before[index]!.digest);
    for (const token of [within, ...tokens]) expect(text(after.body)).not.toContain(token);
  }
});

it('leaves records at runtime placement out of every body; only the revision they enter moves', () => {
  // Runtime-band evidence and a blocking law that, authored, would be composition, a word member, a claimant, a
  // reserved rule, a pointer and frontier: observations of the workspace and of the law, and a law that the check
  // enforces and that claims src/billing/** and .ia/work/notes/**. Each names authored records, and no authored record
  // names one of them (that case moves the findings, pinned below).
  const plain = database(workspace()),
    root = workspace(),
    lawFile = `${records}/runtime-rule.ia`,
    evidenceFile = '.ia/src/systems/learning-system/records/runtime-evidence.ia',
    runtimeLaw = 'governance-system/governance/law/runtime-rule';
  put(
    root,
    lawFile,
    law(
      'runtime-rule',
      'blocking',
      '  subject\n    covers ["src/billing/**", ".ia/work/notes/**"]\n  relationships\n    enforced-by @check instance-schema-check\n',
    ),
  );
  put(
    root,
    evidenceFile,
    `#! ia 1.0\n${observation('workspace-checked', '@workspace foundation-workspace')}\n${observation('rule-checked', '@law sample-rule')}`,
  );
  const placed = database(root, { locations: { [lawFile]: RUNTIME, [evidenceFile]: RUNTIME } }),
    authored = database(root);
  for (const db of [placed, authored]) {
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(db.refused).toEqual([]);
  }
  expect(placed.get(runtimeLaw)?.band).toBe(0);
  expect(placed.records().filter((r) => r.band === 0)).toHaveLength(3);
  for (const [name, partial] of Object.entries(KEYS)) {
    const before = at(plain, partial),
      after = at(placed, partial),
      // Authored, the same records change every one of these bodies.
      control = at(authored, partial);
    expect(text({ ...control.body, revision: before.body.revision }), name).not.toBe(text(before.body));
    // Placed at runtime, the body is byte-equal but for its revision, and so is its digest.
    expect(text({ ...after.body, revision: before.body.revision }), name).toBe(text(before.body));
    expect(digest({ ...after.body, revision: before.body.revision }), name).toBe(before.digest);
    // The revision hashes every source at its placement, a runtime-band one included (graph revisionOf), so it and
    // the digest still move: decision evidence-placement's "excluded from the authored revision" is not built yet.
    expect(after.body.revision, name).not.toBe(before.body.revision);
    expect(after.digest, name).not.toBe(before.digest);
  }
  // A seat at runtime placement is refused: no body enters it. K0's seat is the repository's own @workspace, which the
  // database decides over every placement, so K0 is refused when that @workspace is placed at runtime.
  expect(() => at(placed, { seat: runtimeLaw })).toThrow(
    refusal(`The seat '${runtimeLaw}' is at runtime placement (band 0), which no position body enters`),
  );
  const unseated = database(workspace(), {
    locations: { '.ia/src/systems/workspace-system/records/foundation-workspace.ia': RUNTIME },
  });
  expect(unseated.get(foundation)?.band).toBe(0);
  expect(unseated.resolveSeat('').seat).toBe(foundation);
  for (const partial of [{}, { shape: 'governance' }] as const)
    expect(() => at(unseated, partial)).toThrow(
      refusal(`The seat '${foundation}' is at runtime placement (band 0), which no position body enters`),
    );
  // A key resolved through one token and assembled through a narrower one that does not admit its seat names the
  // position without that seat, as resolveScopeKey's refusal of a seat outside the scope does (R14).
  const resolved = resolveScopeKey(plain, plain.resolveScope().token, normalizeScopeKey({ seat: lawId }));
  expect(() => positionBody(plain, plain.resolveScope({ identities: [check] }).token, resolved)).toThrow(
    expect.objectContaining({
      code: 'IA-RUNTIME-REQUEST-INVALID',
      message: expect.stringContaining(`The seat '${lawId}' is not an admitted record in this scope`),
      next: 'ia position',
    }),
  );
});

it('names the seat unknown at a location whose only declarer is at runtime placement', () => {
  // A runtime-band @system and its steward: the database still seats the folder's paths at that @system (D02b reads
  // every placement), but the body composes no declarer, and names the unknowns the paths have without them. An
  // authored law claims one of the two paths.
  const plainRoot = workspace(),
    root = workspace(),
    folder = '.ia/src/systems/fresh-system',
    claims = law('fresh-claim', 'advisory', `  subject\n    covers ["${folder}/records/**"]\n`);
  for (const copy of [plainRoot, root]) put(copy, `${records}/fresh-claim.ia`, claims);
  put(
    root,
    `${folder}/system.ia`,
    '#! ia 1.0\n@system fresh-system\n  provider "inventarch.local"\n  version "0.1.0"\n  describes "A runtime-band fixture system"\n  steward @agent fresh-steward\n  requires\n    - agent-system\n    - workspace-system\n',
  );
  put(
    root,
    `${folder}/steward.ia`,
    '#! ia 1.0\n@agent fresh-steward\n  meaning\n    says "Owns the fixture system."\n    answers "Who owns the fixture system?"\n  governance\n    applies [agent]\n',
  );
  const plain = database(plainRoot),
    placed = database(root, {
      locations: { [`${folder}/system.ia`]: RUNTIME, [`${folder}/steward.ia`]: RUNTIME },
    });
  expect(placed.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(placed.refused).toEqual([]);
  expect(placed.records().filter((r) => r.band === 0)).toHaveLength(2);
  const messages = {
    [`${folder}/notes.md`]: `no record claims '${folder}/notes.md' and none is declared at it`,
    [`${folder}/records/claimed.md`]: `no admitted record in this scope is declared at '${folder}/records/claimed.md'`,
  };
  for (const [path, message] of Object.entries(messages)) {
    expect(placed.resolveSeat(path).seat).toBe('floor/definition/system/fresh-system');
    for (const partial of [{ seat: { path }, depth: 0, budget: 0 }, { seat: { path } }]) {
      const plainBody = at(plain, partial).body,
        body = at(placed, partial).body;
      expect(body.unknowns, path).toEqual(plainBody.unknowns);
      expect(body.unknowns[0], path).toEqual({
        kind: 'seat',
        subject: path,
        message: expect.stringContaining(message),
      });
      // The limit (R15): the resolved seat is the database's, so it names no `unknown` here; nothing else moves.
      expect(plainBody.seat).toEqual({ kind: 'location', path, unknown: 'undeclared' });
      expect(body.seat).toEqual({ kind: 'location', path });
      expect(text({ ...body, revision: plainBody.revision, seat: plainBody.seat }), path).toBe(text(plainBody));
    }
  }
});

it('reads admission over every placement: a runtime-band record an authored reference names takes its finding out', () => {
  // The limit pinned (R15, R16): admission resolves references against every placement, so a runtime-band check that
  // an authored law's `enforced-by` names, and a runtime-band observation that a task's `work.exit-evidence` names (the
  // evidence flow an `ia validate` will write), resolve them. Each record's missing-target or missing-field-reference
  // finding leaves its body, and the row to the runtime-band record is dropped, so the body names the relation nowhere.
  // An admission view without runtime-band sources, for the findings as for the revision, is milestone
  // generation-binding's.
  const needsFile = `${records}/needs-check.ia`,
    workFile = '.ia/src/systems/work-system/records/fixture-work.ia',
    checkFile = '.ia/src/systems/compliance-system/checks/later-check.ia',
    evidenceFile = '.ia/src/systems/learning-system/records/later-evidence.ia',
    needsLaw = 'governance-system/governance/law/needs-check',
    task = 'work-system/definition/task/schema';
  const work = [
    '#! ia 1.0',
    '@plan release',
    '  meaning',
    '    says "Release the fixture."',
    '  work',
    '    title "Release"',
    '    status open',
    '',
    '@milestone foundation',
    '  meaning',
    '    says "The fixture foundation."',
    '  work',
    '    title "Foundation"',
    '    status open',
    '    plan @plan release',
    '    exit "The schema is written."',
    '',
    '@task schema',
    '  meaning',
    '    says "Write the fixture schema."',
    '  work',
    '    title "Schema"',
    '    status closed',
    '    milestone @milestone foundation',
    '    exit-evidence @observation later-checked',
    '',
  ].join('\n');
  const plainRoot = workspace(),
    root = workspace();
  for (const copy of [plainRoot, root]) {
    put(copy, needsFile, law('needs-check', 'advisory', '  relationships\n    enforced-by @check later-check\n'));
    put(copy, workFile, work);
  }
  put(
    root,
    checkFile,
    '#! ia 1.0\n@check later-check\n  meaning\n    says "A check placed at runtime."\n    answers "Which check enforces needs-check?"\n  check\n    runs COMP-SCHEMA\n    scope "every admitted native record"\n  governance\n    severity advisory\n',
  );
  put(root, evidenceFile, `#! ia 1.0\n${observation('later-checked', '@task schema')}`);
  const plain = database(plainRoot),
    placed = database(root, { locations: { [checkFile]: RUNTIME, [evidenceFile]: RUNTIME } });
  for (const db of [plain, placed]) {
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(db.refused).toEqual([]);
  }
  expect(
    placed
      .records()
      .filter((r) => r.band === 0)
      .map((r) => r.identity),
  ).toEqual(['compliance-system/check/gate/later-check', 'learning-system/definition/observation/later-checked']);
  for (const [partial, code] of [
    [{ seat: needsLaw, shape: 'governance' }, 'IA-GRAPH-TARGET-MISSING'],
    [{ seat: task }, 'IA-COMP-FIELD-REF-MISSING'],
    [{ seat: task, shape: 'sequence' }, 'IA-COMP-FIELD-REF-MISSING'],
  ] as const) {
    const before = at(plain, partial).body,
      after = at(placed, partial).body,
      found = (body: PositionBody) => body.unknowns.filter((unknown) => unknown.kind === 'finding');
    expect(found(before), code).toEqual([expect.objectContaining({ subject: partial.seat, code })]);
    expect(found(after), code).toEqual([]);
    expect(text({ ...after, revision: before.revision }), code).toBe(
      text({ ...before, unknowns: before.unknowns.filter((unknown) => unknown.kind !== 'finding') }),
    );
  }
  // K0 loads neither record, so it does not move but for its revision.
  expect(text({ ...at(placed, {}).body, revision: '' })).toBe(text({ ...at(plain, {}).body, revision: '' }));
});
