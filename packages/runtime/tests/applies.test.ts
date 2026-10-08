import { createHash } from 'node:crypto';
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readInputs } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { normalizeScopeKey, positionBody, readBody, resolveScopeKey } from '../src/index.js';
import type { PositionBody, ScopeKey } from '../src/index.js';
import { database, declare, law, lawId, lawPath, methodPath, playbook, put, workspace } from './workspace.js';

// R17 (position-and-projection §6 and §7, rows 18 and 19; plan amendments A4 and A8; decision scope-key-caps): the
// rules and playbooks that apply by word to body(K)'s loaded set, their cells at (P, primitive(H)), the blocking rules
// reserved by word whatever the budget truncates, and the mandates that govern the seat.
const foundation = 'workspace-system/definition/workspace/foundation-workspace',
  governanceSystem = 'floor/definition/system/governance-system',
  check = 'compliance-system/check/gate/instance-schema-check',
  contract = 'compliance-system/contract/signature/foundation-authoring-contract',
  procedure = 'governance-system/definition/procedure/sample-procedure',
  localWorkspace = 'workspace-system/definition/workspace/local-workspace',
  convention = 'governance-system/governance/convention/sample-convention',
  principle = 'governance-system/governance/principle/sample-principle',
  scopedMandate = 'agent-system/policy/mandate/scoped-mandate',
  sampleMandate = 'agent-system/policy/mandate/sample-mandate',
  records = '.ia/src/systems/governance-system/records',
  field = 'field match, not a row';
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
const bodyOf = (db: Handle, partial: Partial<ScopeKey> = {}, within = db.resolveScope().token): PositionBody =>
  positionBody(db, within, resolveScopeKey(db, within, normalizeScopeKey(partial)));
const ids = (entries: readonly object[]) => entries.map((entry) => ('identity' in entry ? entry.identity : undefined));
/** The record text at `path` with a subject section of `fields`, before its relationships or appended. */
function subject(root: string, path: string, fields: string): void {
  const text = readFileSync(resolve(root, path), 'utf8'),
    section = `  subject\n${fields}`;
  put(
    root,
    path,
    text.includes('  relationships\n')
      ? text.replace('  relationships\n', `${section}  relationships\n`)
      : `${text}${section}`,
  );
}
/** A fixture playbook applying by word to definitions, its cognition one `primary` cell per listed phase. */
function procedureOf(name: string, cells: Readonly<Record<string, string>>): string {
  const cognition = Object.entries(cells)
    .map(
      ([phase, primitive]) =>
        `    ${phase}\n      primary ${primitive}\n      ${primitive} means "${name} ${phase}."\n`,
    )
    .join('');
  return playbook(name, '  subject\n    subject-kind definition\n', cognition);
}
/** A fixture @convention of `severity`, `more` appended as further sections. */
function conventionOf(name: string, severity: string, more: string): string {
  return `#! ia 1.0\n@convention ${name}\n  meaning\n    says "Fixture convention ${name}."\n    answers "What does ${name} require?"\n  governance\n    severity ${severity}\n${more}`;
}
/** A fixture @mandate, its `authority` section after the participant being `authority`. */
function mandateOf(name: string, authority: string): string {
  return `#! ia 1.0\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "Where does it apply?"\n  governance\n    requires "Fixture statement."\n  authority\n    participant @agent agent-steward\n${authority}`;
}
/** A mandate whose `authority.scope` names the foundation workspace. */
const SCOPED =
  '#! ia 1.0\n@mandate scoped-mandate\n  meaning\n    says "A mandate scoped to the foundation workspace."\n    answers "Where does it apply?"\n  governance\n    requires "Fixture statement."\n  authority\n    participant @agent agent-steward\n    scope [@workspace foundation-workspace]\n';
/**
 * A root adopting the conformance corpus at band 90 from `vendor/foundation`, `edit` applied to that copy before it is
 * pinned, with a local workspace capturing `.ia/src`.
 */
function adoptedRoot(edit: (vendor: string) => void = () => {}): string {
  const root = workspace(null),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  edit(resolve(root, vendor));
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  put(
    root,
    '.ia/src/systems/workspace-system/records/local-workspace.ia',
    '#! ia 1.0\n@workspace local-workspace\n  meaning\n    says "The local boundary."\n    answers "What is local?"\n  composition\n    systems [@system governance-system]\n    sources [".ia/src @authored"]\n',
  );
  return root;
}

it("delivers the fixture playbook's plan cell at phase plan, as ia read reads it, and here P moves only the cells", () => {
  const plain = database(workspace()),
    root = workspace();
  subject(root, methodPath, '    subject-kind definition\n');
  const db = database(root);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  // At the workspace seat, the playbook applies by its subject-kind, the workspace's kind, as a field match: no row
  // reaches it, so it is neither loaded nor a pointer. Governance's primitive is Inference.
  const plan = bodyOf(db, { shape: 'governance', phase: 'plan' });
  expect(ids(plan.loaded)).toEqual([foundation]);
  expect([...ids(plan.pointers), ...ids(plan.rules)]).not.toContain(procedure);
  expect(plan.appliesByWord).toContainEqual(
    expect.objectContaining({
      identity: procedure,
      word: 'playbook',
      hop: 0,
      via: {
        by: 'subject',
        label: field,
        matches: [{ field: 'subject.subject-kind', value: 'definition', record: foundation }],
      },
    }),
  );
  expect(plan.cells).toEqual([
    { playbook: procedure, address: `${procedure}#plan/Inference`, text: 'Sample fixture statement 11.' },
  ]);
  // The text is what `ia read <address>` reads, the cell's own text, never its document.
  const read = readBody(db, `${procedure}#plan/Inference`, {
    read: () => {
      throw new Error('a cell reads no file');
    },
  });
  expect(read).toMatchObject({ ok: true, body: { kind: 'record', body: 'Sample fixture statement 11.' } });
  // Context's primitive is Attention: the same phase delivers the plan's Attention cell.
  expect(bodyOf(db, { shape: 'context', phase: 'plan' }).cells).toEqual([
    { playbook: procedure, address: `${procedure}#plan/Attention`, text: 'Sample fixture statement 10.' },
  ]);
  // Here the phase changes only the cell delivered and the keys it is spelled in (design §6, routing): no conditional
  // row bears on this body. A row whose condition holds at one phase only moves the loaded set (decision
  // conditional-relations-in-delivery; tests/position.test.ts).
  const orient = bodyOf(db, { shape: 'governance', phase: 'orient' });
  expect(orient.cells).toEqual([
    { playbook: procedure, address: `${procedure}#orient/Inference`, text: 'Sample fixture statement 5.' },
  ]);
  for (const part of ['loaded', 'rules', 'pointers', 'pointerTallies', 'mandates', 'frontier', 'unknowns', 'counts'])
    expect(orient[part as keyof PositionBody], part).toEqual(plan[part as keyof PositionBody]);
  expect(ids(orient.appliesByWord)).toEqual(ids(plan.appliesByWord));
  // Without its subject, the playbook applies to nothing, and no cell is delivered.
  expect(bodyOf(plain, { shape: 'governance', phase: 'plan' }).cells).toEqual([]);
});

it('names the nearest phase with a cell of the primitive, a tie to the earlier phase, and delivers four cells', () => {
  const root = workspace();
  // Five playbooks apply to the workspace by subject-kind; in identity order, the sample procedure is the fifth.
  for (const [name, cells] of [
    ['a-plan-act', { plan: 'Inference', act: 'Inference' }],
    ['b-orient-act', { orient: 'Inference', act: 'Inference' }],
    ['c-memory', { orient: 'Memory' }],
    ['d-orient', { orient: 'Inference' }],
  ] as const)
    put(root, `${records}/${name}.ia`, procedureOf(name, cells));
  subject(root, methodPath, '    subject-kind definition\n');
  const db = database(root),
    id = (name: string) => `governance-system/definition/procedure/${name}`;
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const learn = bodyOf(db, { shape: 'governance', phase: 'learn' });
  expect(learn.cells).toEqual([
    // From learn, act is one phase away and plan two: the distance decides before the order.
    {
      playbook: id('a-plan-act'),
      missing: `${id('a-plan-act')}#learn/Inference`,
      nearest: 'act',
      message: 'no cell; nearest phase with a cell: act',
    },
    // The cycle wraps: orient is one phase past learn, as act is one before it, and the tie goes to the phase the
    // order orient, plan, act, learn lists first.
    {
      playbook: id('b-orient-act'),
      missing: `${id('b-orient-act')}#learn/Inference`,
      nearest: 'orient',
      message: 'no cell; nearest phase with a cell: orient',
    },
    // No phase has an Inference cell.
    {
      playbook: id('c-memory'),
      missing: `${id('c-memory')}#learn/Inference`,
      message: 'no cell; no phase has a cell at Inference',
    },
    {
      playbook: id('d-orient'),
      missing: `${id('d-orient')}#learn/Inference`,
      nearest: 'orient',
      message: 'no cell; nearest phase with a cell: orient',
    },
  ]);
  // c = 4: the fifth playbook applies by word, and delivers no cell.
  expect(ids(learn.appliesByWord)).toContain(procedure);
  expect(learn.cells.map((cell) => cell.playbook)).not.toContain(procedure);
  const orient = bodyOf(db, { shape: 'governance', phase: 'orient' });
  expect(orient.cells.slice(0, 2)).toEqual([
    {
      playbook: id('a-plan-act'),
      missing: `${id('a-plan-act')}#orient/Inference`,
      nearest: 'plan',
      message: 'no cell; nearest phase with a cell: plan',
    },
    { playbook: id('b-orient-act'), address: `${id('b-orient-act')}#orient/Inference`, text: 'b-orient-act orient.' },
  ]);
});

it('orders the section and its cells by band, then identity: a local playbook before an adopted one', () => {
  const root = adoptedRoot((vendor) => subject(vendor, methodPath, '    subject-kind definition\n'));
  put(root, `${records}/z-local.ia`, procedureOf('z-local', { plan: 'Inference' }));
  const db = database(root),
    local = 'governance-system/definition/procedure/z-local';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(db.get(procedure)?.band).toBe(90);
  const body = bodyOf(db, { seat: localWorkspace, shape: 'governance' });
  // The local playbook (band 100) ranks before the adopted one (band 90), though its identity sorts after.
  expect(body.appliesByWord.filter((entry) => entry.word === 'playbook').map((e) => [e.identity, e.band])).toEqual([
    [local, 100],
    [procedure, 90],
  ]);
  expect(body.cells.map((cell) => cell.playbook)).toEqual([local, procedure]);
});

it('reserves the blocking fixture law at budget 0 by a claim and by subject-kind on a truncated candidate', () => {
  const plain = database(workspace()),
    root = workspace();
  subject(root, lawPath, '    subject-word check\n    subject-kind contract\n    covers ["src/billing/**"]\n');
  const db = database(root);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const nowhere = (body: PositionBody) => [...ids(body.loaded), ...ids(body.pointers), ...ids(body.appliesByWord)];
  // Through a claim: the law selects the location through subject.covers, so it is a candidate, reserved in R.
  const claimed = bodyOf(db, { seat: { path: 'src/billing/invoice.ts' }, depth: 0, budget: 0 });
  expect(claimed.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      via: { by: 'claim', matches: [{ field: 'subject.covers', selection: 'src/billing/**' }] },
    }),
  ]);
  expect(nowhere(claimed)).not.toContain(lawId);
  // Through a subject-kind match: from the workspace, the sequence focus reaches the contract one hop out, and budget
  // 0 truncates it to a pointer. No row or composition class reaches the law, which applies to the contract by kind:
  // it is in `rules`, not in `appliesByWord` or `pointers`.
  const key = { shape: 'sequence', depth: 1, budget: 0 } as const,
    truncated = bodyOf(db, key);
  expect(ids(truncated.loaded)).toEqual([foundation]);
  expect(truncated.pointers).toContainEqual(expect.objectContaining({ identity: contract, hop: 1 }));
  expect(truncated.counts.truncatedLoaded).toBe(1);
  expect(truncated.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      hop: 0,
      digest: db.get(lawId)!.digest,
      via: {
        by: 'subject',
        label: field,
        matches: [{ field: 'subject.subject-kind', value: 'contract', record: contract }],
      },
    }),
  ]);
  expect(nowhere(truncated)).not.toContain(lawId);
  expect(truncated.counts.rules).toBe(1);
  // Without its subject the law reaches no record of that key.
  expect(bodyOf(plain, key).rules).toEqual([]);
  // At the check, the law is an out-of-focus pointer (it is enforced by the check, at act, where its row holds); its
  // subject-word names the check, so it leaves the pointers for `rules`.
  const atCheck = { seat: check, shape: 'context', phase: 'act', depth: 0, budget: 0 } as const;
  expect(ids(bodyOf(plain, atCheck).pointers)).toContain(lawId);
  const reserved = bodyOf(db, atCheck);
  expect(ids(reserved.rules)).toEqual([lawId]);
  expect(reserved.rules[0]!.via).toEqual({
    by: 'subject',
    label: field,
    matches: [{ field: 'subject.subject-word', value: 'check', record: check }],
  });
  expect(nowhere(reserved)).not.toContain(lawId);
  // Under governance the law's enforce row is in focus, so at depth 0 it is the frontier one hop past the check; no
  // composition class or hop reaches it, and reserved by its subject-word it leaves the frontier for `rules`.
  const governed = { ...atCheck, shape: 'governance', budget: 16 } as const,
    ruled = (body: PositionBody) =>
      body.frontier.find((tally) => tally.system === 'governance-system' && tally.kind === 'governance');
  expect(ruled(bodyOf(plain, governed))).toMatchObject({ count: 1 });
  const left = bodyOf(db, governed);
  expect(ids(left.rules)).toEqual([lawId]);
  expect(left.rules[0]!.via).toMatchObject({ by: 'subject' });
  expect(ruled(left)).toBeUndefined();
  // An advisory rule that applies by word to a truncated candidate is not reserved: the section reads L, not K.
  const advisory = workspace();
  put(
    advisory,
    `${records}/advisory-rule.ia`,
    law('advisory-rule', 'advisory', '  subject\n    subject-kind contract\n'),
  );
  const loose = bodyOf(database(advisory), key);
  expect(loose.rules).toEqual([]);
  expect(ids(loose.appliesByWord)).not.toContain('governance-system/governance/law/advisory-rule');
});

it('applies by word to a blocking candidate in rules as to a loaded record, and to no rule reserved by word alone', () => {
  const aboutLaws = 'governance-system/governance/convention/about-laws',
    lawBook = 'governance-system/definition/procedure/law-book';
  /** The corpus with a convention and a playbook whose subject-word is law, the fixture law edited by `edit`. */
  const corpus = (edit: (root: string) => void): Handle => {
    const root = workspace();
    put(root, `${records}/about-laws.ia`, conventionOf('about-laws', 'advisory', '  subject\n    subject-word law\n'));
    put(
      root,
      `${records}/law-book.ia`,
      playbook(
        'law-book',
        '  subject\n    subject-word law\n',
        '    act\n      primary Inference\n      Inference means "law-book act."\n',
      ),
    );
    edit(root);
    const db = database(root);
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    return db;
  };
  const blocking = corpus(() => {}),
    // Advisory, the law's `enforced-by` row must not also be conditional on its severity being blocking, or it would
    // hold nowhere and nothing would reach the law.
    advisory = corpus((root) =>
      put(
        root,
        lawPath,
        readFileSync(resolve(root, lawPath), 'utf8')
          .replace('severity blocking\n', 'severity advisory\n')
          .replace('when phase is act and severity is blocking\n', 'when phase is act\n'),
      ),
    );
  // At the check under governance, the law is a candidate one enforce row away, at act, where the row holds: blocking,
  // R reserves it in `rules`; advisory, it is loaded. Either way the convention and the playbook that name its word
  // apply to it, and the playbook's act cell is delivered: making the law blocking takes nothing that applies to it
  // away.
  const key = { seat: check, shape: 'governance', phase: 'act' } as const,
    reserved = bodyOf(blocking, key),
    loaded = bodyOf(advisory, key);
  expect(ids(reserved.rules)).toEqual([lawId]);
  expect(ids(reserved.loaded)).not.toContain(lawId);
  expect(ids(loaded.rules)).toEqual([]);
  expect(ids(loaded.loaded)).toContain(lawId);
  const onLaw = [{ field: 'subject.subject-word', value: 'law', record: lawId }];
  for (const body of [reserved, loaded]) {
    expect(ids(body.appliesByWord)).toEqual([lawBook, aboutLaws, convention]);
    expect(body.appliesByWord.slice(0, 2).map((entry) => entry.via.matches)).toEqual([onLaw, onLaw]);
    expect(body.cells).toEqual([{ playbook: lawBook, address: `${lawBook}#act/Inference`, text: 'law-book act.' }]);
  }
  // A rule `rules` holds by word alone is a field match itself, no record of L or R: from the workspace at budget 0
  // the law applies by kind to the contract the budget truncated, and nothing applies by word to it.
  const byWord = corpus((root) => subject(root, lawPath, '    subject-kind contract\n')),
    truncated = bodyOf(byWord, { shape: 'sequence', depth: 1, budget: 0, phase: 'plan' });
  expect(truncated.rules).toEqual([
    expect.objectContaining({ identity: lawId, via: expect.objectContaining({ by: 'subject' }) }),
  ]);
  expect(ids(truncated.appliesByWord)).toEqual([principle]);
  expect(truncated.cells).toEqual([]);
});

it('keeps rules in the governance order, each once and never the seat, a rule reserved by word naming each match', () => {
  const root = workspace(),
    claimRule = 'governance-system/governance/law/claim-rule';
  put(
    root,
    `${records}/claim-rule.ia`,
    law(
      'claim-rule',
      'blocking',
      '  subject\n    subject-word system\n    subject-kind definition\n    covers ["src/billing/**"]\n',
    ),
  );
  subject(root, lawPath, '    subject-word law\n');
  const db = database(root);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  // At a path the claim rule claims, it is in R by its claim, and the fixture law applies to it by word. R and the
  // rules reserved by word are one order: the law's enforce row, which holds at act, primes it before the claim rule,
  // which states no row, though its identity sorts after.
  const claimed = bodyOf(db, { seat: { path: 'src/billing/invoice.ts' }, phase: 'act', depth: 0, budget: 0 });
  expect(claimed.rules.map((rule) => [rule.identity, rule.via])).toEqual([
    [
      lawId,
      { by: 'subject', label: field, matches: [{ field: 'subject.subject-word', value: 'law', record: claimRule }] },
    ],
    [claimRule, { by: 'claim', matches: [{ field: 'subject.covers', selection: 'src/billing/**' }] }],
  ]);
  // At the governance-system @system both laws are word members, in R by that class. Each also applies by word to a
  // candidate, and each is listed once with the class that reached it.
  const system = bodyOf(db, { seat: governanceSystem, shape: 'governance', phase: 'act' });
  expect(system.rules.map((rule) => [rule.identity, rule.via])).toEqual([
    [lawId, { by: 'word', system: 'governance-system' }],
    [claimRule, { by: 'word', system: 'governance-system' }],
  ]);
  expect(system.counts.rules).toBe(2);
  // Seated at the fixture law, whose subject-word is its own word, the law is the seat and no rule.
  const atLaw = bodyOf(db, { seat: lawId });
  expect(ids(atLaw.loaded)[0]).toBe(lawId);
  expect(ids(atLaw.rules)).not.toContain(lawId);
  // At K0 the claim rule is no candidate and is reserved through both its fields, each naming the first candidate that
  // answers it, the seat first and then by identity: the first @system by identity, and the workspace itself.
  const k0 = bodyOf(db);
  expect(k0.rules).toEqual([
    expect.objectContaining({
      identity: claimRule,
      hop: 0,
      via: {
        by: 'subject',
        label: field,
        matches: [
          { field: 'subject.subject-word', value: 'system', record: 'floor/definition/system/agent-system' },
          { field: 'subject.subject-kind', value: 'definition', record: foundation },
        ],
      },
    }),
  ]);
  expect(k0.counts.rules).toBe(1);
});

it("reads no subject or mandate of another workspace's root: none applies by word, is reserved by word or governs", () => {
  const foreign = 'governance-system/governance/law/foreign-blocker';
  /** The foundation workspace capturing `.ia/src`, and with `others`, two workspaces declaring two systems' folders. */
  const seated = (others: boolean): PositionBody => {
    const root = workspace();
    declare(root, ['.ia/src @authored']);
    put(
      root,
      `${records}/foreign-blocker.ia`,
      law('foreign-blocker', 'blocking', '  subject\n    subject-kind definition\n'),
    );
    put(root, '.ia/src/systems/agent-system/records/scoped-mandate.ia', SCOPED);
    if (others)
      for (const system of ['governance-system', 'agent-system'])
        put(
          root,
          `.ia/src/systems/workspace-system/records/${system}-workspace.ia`,
          `#! ia 1.0\n@workspace ${system}-workspace\n  meaning\n    says "The ${system} records' own boundary."\n    answers "Which root does it capture?"\n  composition\n    systems [@system ${system}]\n    sources [".ia/src/systems/${system} @authored"]\n`,
        );
    const db = database(root);
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    return bodyOf(db, { seat: foundation, shape: 'governance' });
  };
  // While the foundation workspace's root holds every record, the principle applies to the workspace by its kind, the
  // blocking law is reserved, and the mandate scoped to the workspace governs it.
  const alone = seated(false);
  expect(ids(alone.appliesByWord)).toContain(principle);
  expect(ids(alone.rules)).toContain(foreign);
  expect(ids(alone.mandates)).toEqual([scopedMandate]);
  // Once two other workspaces declare the governance-system's and the agent-system's folders, their records are
  // outside its closure: the principle and the law name its kind, and the mandate its workspace, all to no effect.
  const split = seated(true);
  expect(ids(split.appliesByWord)).not.toContain(principle);
  expect(ids(split.rules)).not.toContain(foreign);
  expect(split.mandates).toEqual([]);
});

it('lists each applies-by-word entry once, with each field it matches, its re-seat key, and tallies past 48', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  // The sample convention's subject-word and subject-kind are both contract: it appears, once with both matches, when a
  // @contract is loaded, and not while the contract is only a pointer.
  const loaded = bodyOf(db, { shape: 'sequence', depth: 2 }, within);
  expect(ids(loaded.loaded)).toEqual([foundation, contract]);
  expect(ids(loaded.appliesByWord)).toEqual([convention, principle]);
  expect(loaded.appliesByWord[0]).toMatchObject({
    identity: convention,
    via: {
      by: 'subject',
      label: field,
      matches: [
        { field: 'subject.subject-word', value: 'contract', record: contract },
        { field: 'subject.subject-kind', value: 'contract', record: contract },
      ],
    },
    reseat: { seat: convention, shape: 'sequence', phase: 'plan', depth: 1, budget: 16 },
  });
  expect(Object.keys(loaded.appliesByWord[0]!.reseat)).toEqual(['seat', 'shape', 'phase', 'depth', 'budget']);
  expect(ids(bodyOf(db, { shape: 'sequence', depth: 2, budget: 0 }, within).appliesByWord)).toEqual([principle]);
  expect(ids(bodyOf(db, {}, within).appliesByWord)).toEqual([principle]);
  // The re-seat key seats a position at the entry.
  expect(ids(bodyOf(db, loaded.appliesByWord[0]!.reseat, within).loaded)[0]).toBe(convention);
  // Non-blocking governance stays where the body placed it: the principle is loaded at the governance-system seat,
  // and applies by word to that @system, a definition, too.
  const system = bodyOf(db, { seat: governanceSystem, shape: 'governance' }, within);
  expect(ids(system.loaded)).toContain(principle);
  expect(ids(system.appliesByWord)).toEqual([principle]);
  expect(system.appliesByWord[0]!.via.matches).toEqual([
    { field: 'subject.subject-kind', value: 'definition', record: governanceSystem },
  ]);

  // Fifty laws that each match the workspace by word and by kind: one entry apiece, 48 listed and the rest tallied.
  const root = workspace(),
    many = Array.from({ length: 50 }, (_, i) =>
      law(`many-${i}`, 'advisory', '  subject\n    subject-word workspace\n    subject-kind definition\n').replace(
        '#! ia 1.0\n',
        '',
      ),
    );
  put(root, `${records}/many-rules.ia`, `#! ia 1.0\n${many.join('\n')}`);
  const crowded = database(root);
  expect(crowded.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  for (const partial of [{}, { shape: 'sequence', depth: 2 }, { shape: 'context', budget: 64 }] as const) {
    const body = bodyOf(crowded, partial),
      listed = ids(body.appliesByWord);
    expect(new Set(listed).size, JSON.stringify(partial)).toBe(listed.length);
    expect(listed, JSON.stringify(partial)).toHaveLength(48);
    expect(body.counts.appliesByWord - body.counts.truncatedAppliesByWord).toBe(48);
    expect(body.appliesByWordTallies.reduce((sum, t) => sum + t.count, 0)).toBe(body.counts.truncatedAppliesByWord);
  }
  const k0 = bodyOf(crowded);
  expect(k0.counts).toMatchObject({ appliesByWord: 51, truncatedAppliesByWord: 3 });
  expect(k0.appliesByWord[0]!.via.matches).toEqual([
    { field: 'subject.subject-word', value: 'workspace', record: foundation },
    { field: 'subject.subject-kind', value: 'definition', record: foundation },
  ]);
  // By identity, the last two laws and the principle are past the 48th entry.
  expect(k0.appliesByWordTallies).toEqual([
    { system: 'governance-system', word: 'law', steward: 'agent-system/binding/agent/governance-steward', count: 2 },
    {
      system: 'governance-system',
      word: 'principle',
      steward: 'agent-system/binding/agent/governance-steward',
      count: 1,
    },
  ]);
});

it("delivers the mandates that claim a location seat or whose authority.scope names the seat's workspace", () => {
  const plain = database(workspace()),
    root = workspace();
  put(root, '.ia/src/systems/agent-system/records/scoped-mandate.ia', SCOPED);
  const db = database(root);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const scoped = expect.objectContaining({
    identity: scopedMandate,
    word: 'mandate',
    hop: 0,
    via: { by: 'field', from: foundation, field: 'authority.scope', direction: 'in' },
  });
  // At K0 the workspace is the seat: the scoped mandate governs it, and the sample mandate, which claims docs/** and
  // names no scope, does not; no participant is matched before milestone position-packet.
  expect(bodyOf(db).mandates).toEqual([scoped]);
  expect(bodyOf(plain).mandates).toEqual([]);
  // A record seat's workspace is the one whose closure holds it.
  expect(bodyOf(db, { seat: lawId, shape: 'governance' }).mandates).toEqual([scoped]);
  // A location the sample mandate claims: the claimant and the scoped one, both band 100, by identity.
  const docs = bodyOf(db, { seat: { path: 'docs/guide.md' }, depth: 0, budget: 0 }),
    claim = { by: 'claim', matches: [{ field: 'authority.covers', selection: 'docs/**' }] };
  expect(docs.mandates).toEqual([expect.objectContaining({ identity: sampleMandate, via: claim }), scoped]);
  expect(bodyOf(plain, { seat: { path: 'docs/guide.md' } }).mandates).toEqual([
    expect.objectContaining({ identity: sampleMandate }),
  ]);

  // A mandate scoped to another workspace governs that workspace, not the foundation one.
  const two = workspace(),
    other = 'workspace-system/definition/workspace/other-workspace',
    elsewhere = 'agent-system/policy/mandate/elsewhere-mandate';
  put(
    two,
    '.ia/src/systems/workspace-system/records/other-workspace.ia',
    '#! ia 1.0\n@workspace other-workspace\n  meaning\n    says "Another boundary."\n    answers "What else is composed?"\n  composition\n    systems [@system agent-system]\n',
  );
  put(
    two,
    '.ia/src/systems/agent-system/records/elsewhere-mandate.ia',
    mandateOf('elsewhere-mandate', '    scope [@workspace other-workspace]\n'),
  );
  const scopedElsewhere = database(two);
  expect(scopedElsewhere.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(bodyOf(scopedElsewhere, { seat: foundation }).mandates).toEqual([]);
  expect(bodyOf(scopedElsewhere, { seat: other }).mandates).toEqual([
    expect.objectContaining({
      identity: elsewhere,
      via: { by: 'field', from: other, field: 'authority.scope', direction: 'in' },
    }),
  ]);

  // A mandate that both claims the location and is scoped to its workspace is listed once, by its claim.
  const twice = workspace(),
    both = 'agent-system/policy/mandate/both-mandate';
  put(
    twice,
    '.ia/src/systems/agent-system/records/both-mandate.ia',
    mandateOf('both-mandate', '    covers ["docs/**"]\n    scope [@workspace foundation-workspace]\n'),
  );
  const claimsAndScopes = database(twice);
  expect(claimsAndScopes.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(bodyOf(claimsAndScopes).mandates).toEqual([
    expect.objectContaining({
      identity: both,
      via: { by: 'field', from: foundation, field: 'authority.scope', direction: 'in' },
    }),
  ]);
  expect(
    bodyOf(claimsAndScopes, { seat: { path: 'docs/guide.md' } }).mandates.map((entry) => [entry.identity, entry.via]),
  ).toEqual([
    [both, claim],
    [sampleMandate, claim],
  ]);

  // Band ranks before identity: a local mandate before the adopted sample mandate, though its identity sorts after.
  const adopted = adoptedRoot(),
    local = 'agent-system/policy/mandate/z-mandate';
  put(adopted, '.ia/src/systems/agent-system/records/z-mandate.ia', mandateOf('z-mandate', '    covers ["docs/**"]\n'));
  const vendored = database(adopted);
  expect(vendored.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(
    bodyOf(vendored, { seat: { path: 'docs/guide.md' } }).mandates.map((entry) => [entry.identity, entry.band]),
  ).toEqual([
    [local, 100],
    [sampleMandate, 90],
  ]);
});

it('filters only what loads, lists and tallies by the word: rules, applies by word, cells and mandates stay whole', () => {
  const root = workspace();
  put(root, `${records}/law-rule.ia`, law('law-rule', 'advisory', '  subject\n    subject-word law\n'));
  put(
    root,
    `${records}/block-convention.ia`,
    conventionOf('block-convention', 'blocking', '  subject\n    subject-kind definition\n'),
  );
  subject(root, methodPath, '    subject-kind definition\n');
  put(root, '.ia/src/systems/agent-system/records/scoped-mandate.ia', SCOPED);
  const db = database(root),
    lawRule = 'governance-system/governance/law/law-rule',
    blockConvention = 'governance-system/governance/convention/block-convention';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const key = { seat: governanceSystem, shape: 'governance', phase: 'plan' } as const,
    all = bodyOf(db, key),
    laws = bodyOf(db, { ...key, word: 'law' });
  expect(ids(all.appliesByWord)).toEqual([procedure, lawRule, principle]);
  expect(all.cells).toHaveLength(1);
  expect(ids(all.mandates)).toEqual([scopedMandate]);
  // At plan the law's enforce row, which holds only at act, primes nothing: the two blocking rules tie up to identity.
  expect(ids(all.rules)).toEqual([blockConvention, lawId]);
  // The word restricts what loads, the pointers and their tallies: the seat, then laws only.
  expect(ids(laws.loaded)).toContain(lawRule);
  expect(laws.loaded.slice(1).every((entry) => 'word' in entry && entry.word === 'law')).toBe(true);
  expect([...laws.pointers, ...laws.pointerTallies].every((entry) => entry.word === 'law')).toBe(true);
  // Decision scope-key-caps reserves blockers outside n and restricts seeds and tallies: the blocking convention, a
  // word member of the @system, governs the seat whatever the word, so it stays in `rules`; the rules, the cells and
  // the mandates are those of the body without the word, and the applies-by-word section lists the same rules and
  // playbooks, of every word, since each here applies to the seat or to a reserved rule.
  for (const word of ['law', 'convention', 'playbook', 'contract']) {
    const filtered = bodyOf(db, { ...key, word });
    for (const part of ['rules', 'cells', 'mandates'] as const)
      expect(filtered[part], `${word} ${part}`).toEqual(all[part]);
    expect(ids(filtered.appliesByWord), word).toEqual(ids(all.appliesByWord));
    expect(filtered.counts.rules, word).toBe(2);
  }
  // A match names the first answering record in `loaded`, then `rules`: under another word the advisory law-rule is
  // not loaded, so the rule that applies to laws names the reserved law instead.
  const conventions = bodyOf(db, { ...key, word: 'convention' }),
    ruleMatch = (body: PositionBody) => body.appliesByWord.find((entry) => entry.identity === lawRule)!.via.matches;
  expect(ruleMatch(all)).toEqual([{ field: 'subject.subject-word', value: 'law', record: lawRule }]);
  expect(ruleMatch(conventions)).toEqual([{ field: 'subject.subject-word', value: 'law', record: lawId }]);
  // At the workspace, no class or hop reaches the convention, which R17 reserves by its subject-kind alone; it is
  // reserved under every word, its own or another.
  const reservedBy = (word?: string) =>
    bodyOf(db, { shape: 'governance', ...(word === undefined ? {} : { word }) }).rules.map((rule) => [
      rule.identity,
      rule.via,
    ]);
  const byKind = {
    by: 'subject',
    label: field,
    matches: [{ field: 'subject.subject-kind', value: 'definition', record: foundation }],
  };
  for (const word of [undefined, 'convention', 'law'])
    expect(reservedBy(word), word).toEqual([[blockConvention, byKind]]);
  // With w = playbook, no playbook loads (none is the @system's word member), yet the playbook applying by word to the
  // seat still delivers its plan cell.
  const playbooks = bodyOf(db, { ...key, word: 'playbook' });
  expect(ids(playbooks.loaded)).toEqual([governanceSystem]);
  expect(playbooks.cells).toEqual([
    { playbook: procedure, address: `${procedure}#plan/Inference`, text: 'Sample fixture statement 11.' },
  ]);
});

it('reserves a blocking law under another word, by its claim on a location, by a hop and by its subject-word', () => {
  // From the check under governance, the law is reached at hop 1 along the check's enforce row. Under the word contract
  // the walk follows it as a waypoint only, so `rules` reserves it from the walk without the word, with the hop and the
  // row that reach it there, as the body without the word does.
  const plain = database(workspace()),
    enforced = { seat: check, shape: 'governance', phase: 'act', depth: 1 } as const,
    hopped = bodyOf(plain, { ...enforced, word: 'contract' });
  expect(hopped.loaded.slice(1).every((entry) => 'word' in entry && entry.word === 'contract')).toBe(true);
  expect(ids(hopped.loaded)).not.toContain(lawId);
  expect(hopped.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      hop: 1,
      via: expect.objectContaining({ by: 'row', from: check, predicate: 'enforce' }),
    }),
  ]);
  expect(hopped.rules).toEqual(bodyOf(plain, enforced).rules);
  const root = workspace();
  subject(root, lawPath, '    subject-word contract\n    covers ["src/billing/**"]\n');
  const db = database(root);
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  // At a path the blocking law claims, under the word contract: the claim is composition of another word, so nothing
  // loads or is listed, but the law governs the location and is reserved in `rules`.
  const claimed = bodyOf(db, { seat: { path: 'src/billing/invoice.ts' }, depth: 0, budget: 0, word: 'contract' });
  expect(claimed.loaded).toEqual([{ path: 'src/billing/invoice.ts' }]);
  expect([...claimed.pointers, ...claimed.pointerTallies]).toEqual([]);
  expect(claimed.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      word: 'law',
      via: { by: 'claim', matches: [{ field: 'subject.covers', selection: 'src/billing/**' }] },
    }),
  ]);
  // From the workspace under sequence, the contract the workspace requires loads at hop 1 under its own word, and the
  // law, which applies to contracts by its subject-word and no row reaches, is reserved in `rules`, outside the
  // budget, as it is without the word.
  const key = { shape: 'sequence', depth: 1 } as const,
    contracts = bodyOf(db, { ...key, word: 'contract' });
  expect(ids(contracts.loaded)).toEqual([foundation, contract]);
  expect(contracts.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      via: {
        by: 'subject',
        label: field,
        matches: [{ field: 'subject.subject-word', value: 'contract', record: contract }],
      },
    }),
  ]);
  expect(contracts.rules).toEqual(bodyOf(db, key).rules);
  // Under the word contract with budget 0, the contract is a pointer and the law is still reserved.
  const truncated = bodyOf(db, { ...key, budget: 0, word: 'contract' });
  expect(ids(truncated.pointers)).toEqual([contract]);
  expect(ids(truncated.rules)).toEqual([lawId]);
});

it('reads no record at runtime placement: none applies by word, is reserved by word, gives a cell or governs', () => {
  const plain = database(workspace()),
    root = workspace(),
    files = [
      `${records}/runtime-rule.ia`,
      `${records}/runtime-procedure.ia`,
      '.ia/src/systems/agent-system/records/scoped-mandate.ia',
    ];
  put(root, files[0]!, law('runtime-rule', 'blocking', '  subject\n    subject-kind definition\n'));
  put(root, files[1]!, procedureOf('runtime-procedure', { orient: 'Attention' }));
  put(root, files[2]!, SCOPED);
  const placed = database(root, { locations: Object.fromEntries(files.map((file) => [file, RUNTIME])) }),
    authored = database(root);
  for (const db of [placed, authored]) expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(placed.records().filter((r) => r.band === 0)).toHaveLength(3);
  // Authored, the three are a rule reserved by word, a cell and a mandate at K0.
  const control = bodyOf(authored);
  expect(ids(control.rules)).toEqual(['governance-system/governance/law/runtime-rule']);
  expect(control.cells.map((cell) => cell.playbook)).toEqual([
    'governance-system/definition/procedure/runtime-procedure',
  ]);
  expect(ids(control.mandates)).toEqual([scopedMandate]);
  // Placed at runtime, K0 is the plain body but for its revision.
  const before = bodyOf(plain),
    after = bodyOf(placed);
  expect(JSON.stringify({ ...after, revision: before.revision })).toBe(JSON.stringify(before));
});
