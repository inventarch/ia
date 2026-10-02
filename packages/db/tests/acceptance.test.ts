import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Location } from '@ia/language';
import { expect, it } from 'vitest';
import { open } from '../src/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

it.each([
  ['record', methodPath],
  ['system', '.ia/src/systems/agent-system/system.ia'],
  ['schema', '.ia/src/systems/agent-system/schemas/agent.schema.ia'],
  ['kernel', '.ia/src/floor/primitive.ia'],
])('matches fresh, cached and refreshed products after a %s edit', (_kind, path) => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot(),
    scope = db.resolveScope();
  const original = readFileSync(resolve(root, path), 'utf8');
  put(root, path, original + '\n# acceptance byte change\n');
  const after = db.refresh();
  expect(after.revision).not.toBe(before.revision);
  expect(db.cache.state).toBe('written');
  expect(() => db.records({ within: scope.token })).toThrow(expect.objectContaining({ code: 'IA-DB-STALE' }));
  const fresh = open(root, { cache: false }),
    cached = open(root);
  expect(cached.cache.state).toBe('hit');
  expect(fresh.snapshot()).toEqual(after);
  expect(cached.snapshot()).toEqual(after);
  expect(fresh.report).toEqual(db.report);
  expect(cached.report).toEqual(db.report);
  expect(after.records.map((r) => r.identity)).toEqual(before.records.map((r) => r.identity));
});
it('rebuilds changed schema admission and restores it identically through public handles', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/schemas/agent.schema.ia',
    original = readFileSync(resolve(root, path), 'utf8'),
    db = open(root);
  const before = db.records().filter((r) => r.discriminator === 'agent');
  put(root, path, original.replace('  fields', '  fields\n    must have meaning.new-obligation as text'));
  db.refresh();
  expect(db.records().some((r) => r.discriminator === 'agent')).toBe(false);
  expect(db.report.findings.some((f) => f.code === 'IA-COMP-FIELD-MISSING')).toBe(true);
  expect(open(root).snapshot()).toEqual(db.snapshot());
  put(root, path, original);
  db.refresh();
  expect(db.records().filter((r) => r.discriminator === 'agent')).toEqual(before);
  expect(open(root).snapshot()).toEqual(db.snapshot());
});
// Windows CI measured 8.7s for this full-native admission/cache/refresh fixture.
// Give this case a bounded fixture allowance without changing runtime limits.
it('stamps placement/overlay changes and copies caller options for subsequent refresh', () => {
  const root = workspace(),
    first = open(root),
    overlay = '.ia/src/overlay.ia';
  put(root, overlay, readFileSync(resolve(root, methodPath), 'utf8'));
  const locations: Record<string, Location> = {
    [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
  };
  const changed = open(root, { locations });
  expect(changed.revision).not.toBe(first.revision);
  expect(changed.get(methodId)?.source.path).toBe(overlay);
  expect(open(root, { locations }).snapshot()).toEqual(changed.snapshot());
  const saved = changed.snapshot();
  delete locations[methodPath];
  expect(changed.refresh()).toEqual(saved);
  expect(changed.get(methodId)?.source.path).toBe(overlay);
  const tied = open(root);
  expect(tied.get(methodId)).toBeUndefined();
  expect(tied.report.findings.some((f) => f.code === 'IA-GRAPH-IDENTITY-TIE')).toBe(true);
}, 30_000);
