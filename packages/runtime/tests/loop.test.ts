import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { context, select } from '../src/index.js';
import { database, lawId, methodId, methodPath, put, workspace } from './workspace.js';

const fixture = resolve(import.meta.dirname, '../../compliance/fixtures/loop/.ia/src'),
  budget = { tokens: 100000, records: 1000 };
it('admits the native loop independently of its foreign record and retains explicit unavailable evidence', () => {
  const db = database(workspace(fixture));
  expect(db.records()).toHaveLength(158);
  expect(db.report.findings.filter((f) => f.severity === 'error').map((f) => f.code)).toEqual([
    'IA-COMP-DISCRIMINATOR-FOREIGN',
  ]);
  expect(db.snapshot().systems).toEqual([
    'floor',
    'taxonomy',
    'agent-system',
    'compliance-system',
    'workspace-system',
    'governance-system',
    'session-system',
  ]);
  for (const check of ['COMP-ADOPTION', 'COMP-KERNEL', 'COMP-FIXTURES'])
    expect(db.report.verdicts.some((v) => v.check === check && v.outcome === 'not-evaluated')).toBe(true);
  expect(db.report.verdicts.filter((v) => v.check === 'COMP-COVERAGE').every((v) => v.outcome === 'pass')).toBe(true);
});
it('removes and restores registration, every agent and their joins through real source edits', () => {
  const root = workspace(fixture),
    path = '.ia/src/systems/agent-system/system.ia',
    original = readFileSync(resolve(root, path), 'utf8'),
    db = database(root);
  put(root, path, original.replace('      schema @schema agent\n', ''));
  db.refresh();
  expect(db.records().some((r) => r.discriminator === 'agent')).toBe(false);
  expect(db.report.findings.some((f) => f.code === 'IA-LANG-REGISTRATION-INCOMPLETE')).toBe(true);
  put(root, path, original);
  db.refresh();
  expect(db.records().filter((r) => r.discriminator === 'agent')).toHaveLength(5);
});
it('delivers orient/act evidence, declared category and exclusive-selection refusals from native records', () => {
  const db = database(workspace(fixture)),
    within = db.resolveScope().token;
  const get = (phase: string, primitive: string, severity?: string) =>
    context(
      db,
      {
        within,
        text: '',
        coordinate: { phase, primitive, category: 'process', ...(severity === undefined ? {} : { severity }) },
        follow: ['enforced-by'],
      },
      budget,
    );
  const orient = get('orient', 'Decision');
  expect(orient.ok).toBe(true);
  if (!orient.ok) return;
  expect(orient.packet.included[0]?.address).toBe(methodId + '#orient/Decision');
  expect(orient.packet.included[1]).toMatchObject({ step: 2, text: 'Fallback fixture memory' });
  const plain = get('act', 'Memory'),
    raised = get('act', 'Memory', 'blocking');
  if (!plain.ok || !raised.ok) throw new Error('Fixture context refused');
  expect(plain.packet.included.find((e) => e.identity === lawId)?.text).toContain('Sample fixture statement 3.');
  expect(raised.packet.included.find((e) => e.identity === lawId)?.text).toContain('Sample fixture statement 4.');
  expect(plain.packet.gated.some((e) => e.predicate === 'enforce')).toBe(true);
  expect(raised.packet.followed.some((e) => e.predicate === 'enforce')).toBe(true);
  const decision = context(
    db,
    { within, text: '', coordinate: { phase: 'act', primitive: 'Decision', category: 'decision' } },
    budget,
  );
  if (!decision.ok) throw new Error('Fixture category refused');
  expect(decision.packet.included.some((e) => e.identity.endsWith('/declared-decision') && e.step === 4)).toBe(true);
  const candidates = ['a', 'b'].map((n) => `governance-system/definition/procedure/choice-${n}`),
    request = { within, text: '', coordinate: { phase: 'act', primitive: 'Decision' } };
  expect(select(db, request, candidates)).toMatchObject({ escalation: 'deny-wins-tie' });
  expect(select(db, { ...request, coordinate: { phase: 'act' } }, candidates)).toMatchObject({
    escalation: 'coordinate-incomplete',
  });
});
it('fails coverage after removing a case and validates missing requirement fragments', () => {
  const root = workspace(fixture),
    path = '.ia/src/systems/compliance-system/cases/valid-native-record.ia',
    original = readFileSync(resolve(root, path), 'utf8'),
    db = database(root);
  put(root, path, '#! ia 1.0\n');
  db.refresh();
  expect(
    db.report.findings.some((f) => f.code === 'IA-COMP-COVERAGE-MISSING' && f.message.includes('REQ-FOUNDATION-INPUT')),
  ).toBe(true);
  put(root, path, original.replace('REQ-FOUNDATION-INPUT', 'REQ-MISSING'));
  db.refresh();
  expect(db.report.findings.some((f) => f.code === 'IA-COMP-FRAGMENT-MISSING')).toBe(true);
});
it('invalidates cached revisions on a prose byte while preserving every identity and surface', () => {
  const root = workspace(fixture),
    db = database(root, { cache: true }),
    before = db.snapshot(),
    original = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, original.replace('Sample fixture statement 1.', 'A revised fixture statement.'));
  const after = db.refresh();
  expect(after.revision).not.toBe(before.revision);
  expect(after.records.map((r) => [r.identity, r.discriminator])).toEqual(
    before.records.map((r) => [r.identity, r.discriminator]),
  );
  expect(database(root, { cache: true }).snapshot()).toEqual(after);
});
