import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';
import { expect, it } from 'vitest';
import { DbError, open, readInputs } from '../src/index.js';
import { stableState } from '../src/handle.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

it('opens the native corpus through immutable public read products', () => {
  const db = open(workspace(), { cache: false }),
    snapshot = db.snapshot();
  expect(snapshot.records.some((record) => record.name === 'sample-procedure')).toBe(true);
  expect(db.cache.state).toBe('disabled');
  expect(db.get(methodId)?.discriminator).toBe('playbook');
  expect(db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }).ok).toBe(true);
  expect(db.search('fixture').some((hit) => hit.identity === methodId)).toBe(true);
  expect(db.traverse({ start: [methodId], depth: 0 }).nodes).toEqual([{ identity: methodId, depth: 0 }]);
  expect(db.report.revision).toBe(db.revision);
  expect(db.refused).toEqual([]);
  expect(() => (snapshot.records as unknown[]).pop()).toThrow();
  expect(() => {
    (db.get(methodId)! as { name: string }).name = 'changed';
  }).toThrow();
});
it('verifies an identical cache without rewriting and preserves authored bytes', () => {
  const root = workspace(),
    before = readInputs(root),
    first = open(root),
    path = resolve(root, '.ia/.iadb/graph.json');
  expect(first.cache.state).toBe('written');
  const bytes = readFileSync(path, 'utf8');
  utimesSync(path, new Date(100000), new Date(100000));
  const modified = statSync(path).mtimeMs;
  const second = open(root);
  expect(second.cache.state).toBe('hit');
  expect(statSync(path).mtimeMs).toBe(modified);
  expect(second.snapshot()).toEqual(first.snapshot());
  expect(second.refresh()).toEqual(first.snapshot());
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readInputs(root)).toEqual(before);
  expect(readdirSync(resolve(root, '.ia/.iadb'))).toEqual(['graph.json']);
});
it.each(['broken JSON', 'forged'])('replaces %s cache bytes even with a matching revision', (corruption) => {
  const root = workspace(),
    first = open(root),
    path = '.ia/.iadb/graph.json',
    good = readFileSync(resolve(root, path), 'utf8');
  put(
    root,
    path,
    corruption === 'forged' ? JSON.stringify({ ...JSON.parse(good), graph: { nodes: ['fabricated'] } }) : '{',
  );
  const second = open(root);
  expect(second.cache.state).toBe('written');
  expect(second.revision).toBe(first.revision);
  expect(second.records()).toEqual(first.records());
  expect(readFileSync(resolve(root, path), 'utf8')).toBe(good);
});
it('keeps fresh reads usable when cache access is obstructed or points outside', () => {
  const root = workspace(false);
  put(root, '.ia/.iadb', 'obstruction');
  const db = open(root);
  expect(db.records()).toHaveLength(118);
  expect(db.cache.state).toBe('unavailable');
  expect(db.cache.observations[0]?.code).toBe('IA-DB-CACHE-UNAVAILABLE');
  const other = workspace(),
    outside = workspace(false);
  put(outside, 'graph.json', 'do not touch');
  symlinkSync(outside, resolve(other, '.ia/.iadb'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(open(other).cache.state).toBe('unavailable');
  expect(readFileSync(resolve(outside, 'graph.json'), 'utf8')).toBe('do not touch');
});
it('publishes a new immutable generation after a byte edit without changing record identity', () => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, source + '\n# revision-only edit\n');
  expect(db.snapshot()).toEqual(before);
  const after = db.refresh();
  expect(after.revision).not.toBe(before.revision);
  expect(after.records.map((r) => r.identity)).toEqual(before.records.map((r) => r.identity));
  expect(() => db.records({ revision: before.revision })).toThrow(expect.objectContaining({ code: 'IA-DB-STALE' }));
  expect(open(root).snapshot()).toEqual(after);
  expect(before.revision).not.toBe(db.revision);
});
it('preserves the last published state when refresh fails', () => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot();
  put(root, '.ia/src/invalid.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => db.refresh()).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  expect(db.snapshot()).toEqual(before);
});
it('retries unstable scans at most three times and publishes only a stable candidate', () => {
  const root = workspace(false),
    first = readInputs(root);
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  const second = readInputs(root);
  let calls = 0;
  const stable = stableState(() => (++calls === 1 ? first : second), false);
  expect(calls).toBe(4);
  expect(stable.inputs).toBe(second);
  calls = 0;
  expect(() => stableState(() => (++calls % 2 ? first : second), false)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SOURCE-CHANGED' }),
  );
  expect(calls).toBe(6);
  calls = 0;
  expect(() =>
    stableState(() => {
      calls++;
      throw new DbError('IA-DB-SOURCE-CHANGED', 'concurrent change');
    }, false),
  ).toThrow('three consecutive');
  expect(calls).toBe(3);
});
it('closes idempotently and refuses all subsequent reads and refreshes', () => {
  const db = open(workspace(false), { cache: false });
  db.close();
  db.close();
  for (const read of [
    () => db.snapshot(),
    () => db.records(),
    () => db.get(methodId),
    () => db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }),
    () => db.search('x'),
    () => db.traverse({ start: [] }),
    () => db.membership(),
    () => db.staleness(methodId),
    () => db.readiness(methodId, 'f'.repeat(64)),
    () => db.previous(),
    () => db.refresh(),
    () => db.revision,
    () => db.report,
    () => db.refused,
    () => db.cache,
  ]) {
    expect(read).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
  }
});

const byIdentity = (a: { identity: string }, b: { identity: string }): number =>
  a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
const workspaceRecord = (name: string, sources: string) =>
  `#! ia 1.0\n\n@workspace ${name}\n  meaning\n    says "A ${name} test boundary."\n    answers "Which records does ${name} seat?"\n  composition\n    systems [@system governance-system]\n${sources}`;
it('reports one membership row per admitted record with its seat, root, placement, band and source digest', () => {
  const db = open(workspace(), { cache: false }),
    records = [...db.records()].sort(byIdentity),
    rows = db.membership(),
    seat = records.find((r) => r.discriminator === 'workspace' && r.name === 'foundation-workspace')!.identity;
  expect(rows.map((row) => row.identity)).toEqual(records.map((record) => record.identity));
  for (const row of rows) {
    const node = db.get(row.identity)!,
      floor = node.placement.kind === 'floor';
    // One admitted @workspace and no declared sources: authored records sit in it at the placement root (rule 3).
    expect(row).toEqual({
      identity: node.identity,
      seat: floor ? null : seat,
      root: floor ? '.ia/src/floor' : '.ia/src',
      placement: node.placement.kind,
      band: node.band,
      digest: node.digest,
    });
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(rows.some((row) => row.placement === 'floor')).toBe(true);
  expect(() => (rows as unknown[]).pop()).toThrow();
  const scope = db.resolveScope({ identities: [methodId] });
  expect(db.membership({ within: scope.token }).map((row) => row.identity)).toEqual([methodId]);
});
it('moves a membership digest only when that record text changes', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    digestOf = () => db.membership().find((row) => row.identity === methodId)!.digest,
    line = () => db.get(methodId)!.source.line,
    before = digestOf(),
    beforeLine = line(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, source.replace('#! ia 1.0\n', '#! ia 1.0\n# lines above the record\n\n'));
  db.refresh();
  expect(line()).toBe(beforeLine + 2);
  expect(digestOf()).toBe(before);
  put(root, methodPath, source.replace('Sample fixture statement 1.', 'An edited statement.'));
  db.refresh();
  expect(digestOf()).not.toBe(before);
});
it('seats records under the longest declared source root, then identity', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/team.ia',
    workspaceRecord('team-workspace', '    sources [".ia/src/systems/governance-system @authored"]\n'),
  );
  put(
    root,
    '.ia/src/whole.ia',
    workspaceRecord('whole-workspace', '    sources [".ia/src @authored", ".ia/src/floor @floor"]\n'),
  );
  put(root, '.ia/src/twin.ia', workspaceRecord('a-twin-workspace', '    sources [".ia/src @authored"]\n'));
  const db = open(root, { cache: false }),
    identity = (name: string) => db.records().find((r) => r.name === name)!.identity,
    row = (id: string) => db.membership().find((r) => r.identity === id)!;
  expect(db.refused).toEqual([]);
  expect(row(methodId)).toMatchObject({ seat: identity('team-workspace'), root: '.ia/src/systems/governance-system' });
  // Equal declared roots tie-break by workspace identity ascending.
  const tie = [identity('whole-workspace'), identity('a-twin-workspace')].sort()[0];
  expect(row(identity('team-workspace'))).toMatchObject({ seat: tie, root: '.ia/src' });
  // A declared root seats only records captured at its placement.
  const floor = db.membership().find((r) => r.placement === 'floor')!;
  expect(floor).toMatchObject({ seat: identity('whole-workspace'), root: '.ia/src/floor' });
});
it('seats adopted records in their admitted @system at the mount root, and nothing when no workspace is unique', () => {
  const native = workspace(),
    sources = readInputs(native, { adopted: [] })
      .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text })),
    revision = createHash('sha256').update(stableSerialize(sources)).digest('hex'),
    db = open(workspace(false), { cache: false, adopted: [{ id: 'foundation', revision, sources }] }),
    rows = db.membership(),
    method = rows.find((r) => r.identity === methodId)!,
    system = db.records().find((r) => r.discriminator === 'system' && r.name === 'governance-system')!;
  expect(method).toMatchObject({
    seat: system.identity,
    root: `.ia/adopted/foundation/${revision}/.ia/src/systems/governance-system`,
    placement: 'adopted',
    band: 90,
  });
  expect(rows.filter((r) => r.placement === 'floor').every((r) => r.seat === null)).toBe(true);
});

const edited = (source: string) => source.replace('Sample fixture statement 1.', 'An edited statement.');
it('keeps the prior digests as previous across a refresh and reports staleness by digest equality', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    identities = db.records().map((node) => node.identity),
    reading = (value: string) => db.records().filter((node) => db.staleness(node.identity) === value),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  // Nothing retained yet: every present record is new.
  expect(identities.every((identity) => db.staleness(identity) === 'new')).toBe(true);
  put(root, methodPath, edited(source));
  db.refresh();
  expect(reading('changed').map((node) => node.identity)).toEqual([methodId]);
  expect(reading('unchanged')).toHaveLength(identities.length - 1);
  expect(reading('new')).toEqual([]);
  // A refresh with no source change keeps previous: the edited record still reads changed.
  db.refresh();
  expect(db.staleness(methodId)).toBe('changed');
  // Lines moving above the record change the revision but not the record: unchanged.
  put(root, methodPath, edited(source).replace('#! ia 1.0\n', '#! ia 1.0\n# moved down\n\n'));
  db.refresh();
  expect(db.staleness(methodId)).toBe('unchanged');
  // A failed refresh publishes nothing and keeps previous.
  put(root, '.ia/src/invalid.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => db.refresh()).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  rmSync(resolve(root, '.ia/src/invalid.ia'));
  expect(db.staleness(methodId)).toBe('unchanged');
});
it('reports new and removed identities, and unknown for an identity in neither snapshot', () => {
  const root = workspace(),
    db = open(root, { cache: false });
  put(root, '.ia/src/team.ia', workspaceRecord('team-workspace', ''));
  db.refresh();
  const team = db.records().find((node) => node.name === 'team-workspace')!.identity;
  expect(db.staleness(team)).toBe('new');
  rmSync(resolve(root, '.ia/src/team.ia'));
  db.refresh();
  expect(db.get(team)).toBeUndefined();
  expect(db.staleness(team)).toBe('removed');
  expect(db.staleness('workspace-system/definition/workspace/nowhere')).toBe('unknown');
  const scope = db.resolveScope({ identities: [methodId] });
  expect(db.staleness(methodId, { within: scope.token })).toBe('unchanged');
  expect(() => db.staleness(team, { within: scope.token })).toThrow(
    expect.objectContaining({ code: 'IA-DB-OUT-OF-SCOPE' }),
  );
});
it('reads an observed subject revision as current, previous or unknown', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    before = db.get(methodId)!.digest;
  expect(db.readiness(methodId, before)).toBe('current');
  expect(db.readiness(methodId, 'f'.repeat(64))).toBe('unknown');
  put(root, methodPath, edited(readFileSync(resolve(root, methodPath), 'utf8')));
  db.refresh();
  expect(db.readiness(methodId, before)).toBe('previous');
  expect(db.readiness(methodId, db.get(methodId)!.digest)).toBe('current');
  expect(db.readiness(methodId, 'f'.repeat(64))).toBe('unknown');
});
it('seeds previous from a supplied digest index so a later process can compare', () => {
  const root = workspace(),
    first = open(root, { cache: false }),
    digests = new Map(first.records().map((node) => [node.identity, node.digest]));
  put(root, methodPath, edited(readFileSync(resolve(root, methodPath), 'utf8')));
  const later = open(root, { cache: false, previous: { revision: first.revision, digests } });
  expect(
    later
      .records()
      .filter((node) => later.staleness(node.identity) === 'changed')
      .map((n) => n.identity),
  ).toEqual([methodId]);
  digests.clear();
  // The handle copied the index: caller mutation cannot change it.
  expect(later.staleness(methodId)).toBe('changed');
  expect(() => open(root, { cache: false, previous: { revision: 7, digests } as never })).toThrow(
    expect.objectContaining({ code: 'IA-DB-SNAPSHOT-UNAVAILABLE' }),
  );
});
it('exposes the retained previous digest index as a copy, pruned to a supplied scope', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    revision = db.revision,
    digests = new Map(db.records().map((node) => [node.identity, node.digest]));
  expect(db.previous()).toBeUndefined();
  put(root, '.ia/src/team.ia', workspaceRecord('team-workspace', ''));
  put(root, methodPath, edited(readFileSync(resolve(root, methodPath), 'utf8')));
  db.refresh();
  const previous = db.previous()!;
  expect(previous).toEqual({ revision, digests });
  expect(Object.isFrozen(previous)).toBe(true);
  // A copy: mutating it changes neither the handle nor a later read.
  (previous.digests as Map<string, string>).clear();
  expect(db.previous()!.digests).toEqual(digests);
  expect(db.staleness(methodId)).toBe('changed');
  const scope = db.resolveScope({ identities: [methodId] });
  expect(db.previous({ within: scope.token })).toEqual({
    revision,
    digests: new Map([[methodId, digests.get(methodId)]]),
  });
  // A seeded index reads back as given, and any ReadonlyMap seeds it.
  const view: ReadonlyMap<string, string> = {
    get size() {
      return digests.size;
    },
    get: (key) => digests.get(key),
    has: (key) => digests.has(key),
    forEach: (each) => digests.forEach(each),
    entries: () => digests.entries(),
    keys: () => digests.keys(),
    values: () => digests.values(),
    [Symbol.iterator]: () => digests[Symbol.iterator](),
  };
  const later = open(root, { cache: false, previous: { revision, digests: view } });
  expect(later.previous()).toEqual({ revision, digests });
  expect(later.staleness(methodId)).toBe('changed');
  expect(() => open(root, { cache: false, previous: { revision, digests: [['a', 'b']] } as never })).toThrow(
    expect.objectContaining({ code: 'IA-DB-SNAPSHOT-UNAVAILABLE' }),
  );
});

const WORK_PATH = '.ia/src/systems/work-system/records/work.ia';
const MANDATE_PATH = '.ia/src/systems/agent-system/records/work-mandate.ia';
const workSpec =
  '#! ia 1.0\n\n@spec work-scope\n  meaning\n    says "The work-system records."\n  work\n    title "Work records"\n    status accepted\n    covers [".ia/src/systems/work-system/**"]\n';
const workMandate =
  '#! ia 1.0\n\n@mandate work-mandate\n  meaning\n    says "Covers the work-system records."\n    answers "Who may change the work-system records?"\n  governance\n    requires "Changes keep the work records admitted."\n  authority\n    moves [Observation]\n    covers [".ia/src/systems/work-system/records/"]\n';
const seated = (locations = {}) => {
  const root = workspace();
  put(root, WORK_PATH, workSpec);
  put(root, MANDATE_PATH, workMandate);
  const db = open(root, { cache: false, locations }),
    identity = (word: string, name: string) =>
      db.records().find((r) => r.discriminator === word && r.name === name)!.identity;
  return { root, db, identity };
};
it('resolves a path to its declared-at seat, the records declared there and the records that claim it', () => {
  const { db, identity } = seated(),
    seat = db.resolveSeat(WORK_PATH);
  expect(db.refused).toEqual([]);
  expect(seat.path).toBe(WORK_PATH);
  expect(seat.seat).toEqual({ kind: 'system', name: 'work-system', identity: identity('system', 'work-system') });
  expect(seat.declared).toEqual([identity('spec', 'work-scope')]);
  // Equal bands order by identity ascending: the agent-system mandate before the work-system spec.
  expect(seat.claimants.map((c) => [c.identity, c.word, c.field, c.selection, c.band])).toEqual([
    [identity('mandate', 'work-mandate'), 'mandate', 'authority.covers', '.ia/src/systems/work-system/records/', 100],
    [identity('spec', 'work-scope'), 'spec', 'work.covers', '.ia/src/systems/work-system/**', 100],
  ]);
  expect(seat.claimants[0]!.source).toEqual({ path: MANDATE_PATH, line: 11, endLine: 11 });
  expect(seat.invalid).toEqual([]);
  expect(seat.unknown).toBeUndefined();
  expect(() => (seat.claimants as unknown[]).pop()).toThrow();
  expect(() => {
    (seat as { path: string }).path = 'elsewhere';
  }).toThrow();
  // A path spelled another way names the same location; a directory is declared-at for the records beneath it.
  expect(db.resolveSeat('./.ia/src/systems/work-system/records/work.ia')).toEqual(seat);
  expect(db.resolveSeat('.ia/src/systems/work-system').seat).toEqual(seat.seat);
  expect(db.resolveSeat('.ia/src/systems/work-system').declared).toEqual([identity('spec', 'work-scope')]);
});
it('orders claimants by band descending before identity, and names an unclaimed path', () => {
  const adopted = { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } as const,
    { db, identity } = seated({ [MANDATE_PATH]: adopted }),
    seat = db.resolveSeat(WORK_PATH);
  expect(seat.claimants.map((c) => [c.identity, c.band])).toEqual([
    [identity('spec', 'work-scope'), 100],
    [identity('mandate', 'work-mandate'), 90],
  ]);
  // The shipped fixture mandate claims docs/**; outside every system folder the one admitted @workspace is the seat.
  const workspaceId = identity('workspace', 'foundation-workspace'),
    docs = db.resolveSeat('docs/guide.md');
  expect(docs.seat).toEqual({ kind: 'workspace', identity: workspaceId });
  expect(docs.declared).toEqual([]);
  expect(docs.claimants.map((c) => c.identity)).toEqual([identity('mandate', 'sample-mandate')]);
  const none = db.resolveSeat('src/unclaimed.ts');
  expect(none).toMatchObject({
    seat: { kind: 'workspace', identity: workspaceId },
    declared: [],
    claimants: [],
    unknown: 'no record claims src/unclaimed.ts',
  });
});
it('prunes declared records and claimants to a supplied scope while the seat stays view-wide', () => {
  const { db, identity } = seated(),
    spec = identity('spec', 'work-scope'),
    scope = db.resolveScope({ identities: [spec] }),
    scoped = db.resolveSeat(WORK_PATH, { within: scope.token });
  expect(scoped.seat).toEqual(db.resolveSeat(WORK_PATH).seat);
  expect(scoped.declared).toEqual([spec]);
  expect(scoped.claimants.map((c) => c.identity)).toEqual([spec]);
  const elsewhere = db.resolveScope({ identities: [methodId] }),
    unseen = db.resolveSeat(WORK_PATH, { within: elsewhere.token });
  expect(unseen).toMatchObject({ declared: [], claimants: [], unknown: `no record claims ${WORK_PATH}` });
});
it('seats a path under the longest declared source root, else the one workspace, else no workspace', () => {
  const root = workspace();
  put(root, '.ia/src/team.ia', workspaceRecord('team-workspace', '    sources ["docs @authored"]\n'));
  put(root, '.ia/src/guides.ia', workspaceRecord('guide-workspace', '    sources ["docs/guides @open"]\n'));
  const db = open(root, { cache: false }),
    identity = (name: string) => db.records().find((r) => r.name === name)!.identity;
  expect(db.refused).toEqual([]);
  expect(db.resolveSeat('docs/a.md').seat).toEqual({ kind: 'workspace', identity: identity('team-workspace') });
  // A path carries no placement, so any declared root contains it; the longest wins.
  expect(db.resolveSeat('docs/guides/b.md').seat).toEqual({
    kind: 'workspace',
    identity: identity('guide-workspace'),
  });
  // Three admitted workspaces and no declared root: the synthetic workspace closure, named by no identity.
  expect(db.resolveSeat('src/a.ts').seat).toEqual({ kind: 'workspace', identity: null });
  // A system folder is a system seat whatever the workspaces declare; an unadmitted system has no identity.
  expect(db.resolveSeat('.ia/src/systems/no-such-system/x.ia').seat).toEqual({
    kind: 'system',
    name: 'no-such-system',
    identity: null,
  });
});
it('lists claims whose selection cannot be read instead of matching them, and refuses a path outside the workspace', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/systems/governance-system/records/broken-rule.ia',
    '#! ia 1.0\n\n@law broken-rule\n  meaning\n    says "Claims what it cannot."\n    answers "What does a malformed selection claim?"\n  governance\n    severity blocking\n  subject\n    covers ["/etc/**", "src/**"]\n',
  );
  const db = open(root, { cache: false }),
    rule = db.records().find((r) => r.name === 'broken-rule')!.identity,
    seat = db.resolveSeat('src/a.ts');
  expect(db.refused).toEqual([]);
  expect(seat.claimants.map((c) => [c.identity, c.selection])).toEqual([[rule, 'src/**']]);
  expect(seat.invalid).toEqual([
    expect.objectContaining({ identity: rule, selection: '/etc/**', reason: expect.stringContaining('absolute') }),
  ]);
  for (const path of ['/etc/passwd', '../outside', 'C:/work'])
    expect(() => db.resolveSeat(path)).toThrow(
      expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE', message: expect.stringContaining('workspace-relative') }),
    );
  db.close();
  expect(() => db.resolveSeat('src/a.ts')).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
});
it('refuses a malformed composition.sources entry by name, in membership and seat resolution alike', () => {
  for (const entry of ['docs', 'docs @nowhere', '../outside @authored', '/abs @authored', 'docs @Authored']) {
    const root = workspace();
    put(root, '.ia/src/team.ia', workspaceRecord('team-workspace', `    sources [".ia/src @authored", "${entry}"]\n`));
    const db = open(root, { cache: false });
    expect(db.refused).toEqual([]);
    const refusal = expect.objectContaining({
      code: 'IA-DB-SOURCES-INVALID',
      message: expect.stringMatching(/team-workspace.*\.ia\/src\/team\.ia:\d+.*<root> @<placement>/),
    });
    expect(() => db.membership()).toThrow(refusal);
    expect(() => db.resolveSeat('docs/a.md')).toThrow(refusal);
    expect(() => db.membership()).toThrow(expect.objectContaining({ message: expect.stringContaining(entry) }));
  }
});
