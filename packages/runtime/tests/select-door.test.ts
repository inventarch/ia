import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPTURE_DIR, captureOf, digestIndex, readCapturedSnapshot, writeCaptured } from '@inventarch/db';
import { KINDS } from '@inventarch/language';
import { expect, it, vi } from 'vitest';
import {
  Door,
  MACHINE_PROTOCOL,
  NEXT_COMMANDS,
  context,
  next,
  normalizeScopeKey,
  parseLocator,
  position,
  readBody,
  select,
} from '../src/index.js';
import type { ContextRequest, DeliveryView, DoorResponse, HostFacts, Scope } from '../src/index.js';
import { database, lawId, methodId, methodPath, playbook, put, workspace } from './workspace.js';

it('refuses equal leading choices and resolves a stronger applicable selector without ordering bias', () => {
  const root = workspace();
  for (const name of ['one', 'two'])
    put(
      root,
      `.ia/src/${name}.ia`,
      playbook(
        name,
        '  activation\n    activate when category is decision\n',
        '    learn\n      primary Learning\n      Learning means "Later"\n',
      ),
    );
  const db = database(root),
    within = db.resolveScope().token,
    prefix = 'governance-system/definition/procedure/';
  const request = { within, text: '', coordinate: { phase: 'act', primitive: 'Decision', category: 'decision' } },
    candidates = [prefix + 'one', prefix + 'two'];
  expect(select(db, request, candidates)).toMatchObject({ ok: false, escalation: 'deny-wins-tie' });
  expect(select(db, request, [...candidates].reverse())).toMatchObject({ ok: false, escalation: 'deny-wins-tie' });
  put(
    root,
    '.ia/src/one.ia',
    playbook(
      'one',
      '  activation\n    activate when category is decision and primitive is Decision\n',
      '    learn\n      primary Learning\n      Learning means "Later"\n',
    ),
  );
  db.refresh();
  expect(select(db, { ...request, within: db.resolveScope().token }, candidates)).toMatchObject({
    ok: true,
    selection: { entry: { identity: prefix + 'one', score: 2 } },
  });
});
it('requires missing selector axes for exclusive selection while retaining topical context eligibility', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/partial.ia',
    playbook(
      'partial',
      '  activation\n    activate when category is decision and move is Verification\n',
      '    learn\n      primary Learning\n      Learning means "Later"\n',
    ),
  );
  const db = database(root),
    within = db.resolveScope().token,
    request = { within, text: 'partial', coordinate: { phase: 'act', primitive: 'Decision', category: 'decision' } },
    candidates = ['governance-system/definition/procedure/partial'];
  expect(context(db, request, { tokens: 10000, records: 100 })).toMatchObject({ ok: true });
  expect(select(db, request, candidates)).toMatchObject({
    ok: false,
    escalation: 'coordinate-incomplete',
    missing: ['move'],
  });
  expect(
    select(db, { ...request, coordinate: { ...request.coordinate, move: 'Verification' } }, candidates),
  ).toMatchObject({ ok: true });
});
it('refuses missing host declarations, extra required axes and empty/outside candidate sets', () => {
  const db = database(workspace()),
    within = db.resolveScope({ identities: [methodId] }).token;
  const request = { within, text: '', coordinate: { phase: 'act', primitive: 'Decision', category: 'process' } };
  expect(select(db, { ...request, coordinate: { phase: 'act' } }, [methodId])).toMatchObject({
    escalation: 'coordinate-incomplete',
    missing: ['primitive'],
  });
  expect(select(db, request, [methodId], { requiredAxes: ['move'] })).toMatchObject({
    escalation: 'coordinate-incomplete',
    missing: ['move'],
  });
  expect(select(db, request, ['outside'])).toMatchObject({ escalation: 'no-candidate' });
  expect(select(db, request, [])).toMatchObject({ escalation: 'no-candidate' });
  expect(() => context(db, { text: '', coordinate: {} } as ContextRequest, { tokens: 1, records: 1 })).toThrow(
    'IA-RUNTIME-REQUEST-INVALID',
  );
});
// This full-native admission and multi-operation fixture took 9.8s on Windows CI.
// Keep its allowance separate from production budgets and ordinary unit tests.
it('serves scoped JSON operations from a privately owned door and rejects unknown parameters', () => {
  const door = new Door(workspace(), { cache: false, boundary: { root: 'team', identities: [methodId] } });
  try {
    const scoped = door.request({ operation: 'scope' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const scope = scoped.result as Scope;
    expect(door.request({ operation: 'get', params: { within: scope.token, identity: methodId } })).toMatchObject({
      ok: true,
      result: { identity: methodId },
    });
    expect(door.request({ operation: 'scope', params: { root: '' } })).toMatchObject({
      ok: false,
      code: 'IA-DB-SCOPE-MISMATCH',
    });
    expect(door.request({ operation: 'records' })).toMatchObject({
      ok: true,
      result: { root: 'team', records: [expect.objectContaining({ identity: methodId })] },
    });
    // The frozen get/records results keep their released record shape: the per-record digest stays off the wire.
    const got = door.request({ operation: 'get', params: { within: scope.token, identity: methodId } });
    const listed = door.request({ operation: 'records' });
    expect(got.ok && listed.ok).toBe(true);
    if (!got.ok || !listed.ok) return;
    expect(Object.keys(got.result as object)).not.toContain('digest');
    const snapshot = listed.result as { records: readonly object[] };
    expect(snapshot.records.every((record) => !Object.keys(record).includes('digest'))).toBe(true);
    expect(Object.isFrozen(got.result) && Object.isFrozen(snapshot) && Object.isFrozen(snapshot.records)).toBe(true);
    expect(
      door.request({
        operation: 'resolve',
        params: { reference: { kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' } },
      }),
    ).toMatchObject({ ok: true, result: { ok: true, identity: methodId } });
    expect(door.request({ operation: 'search', params: { text: 'fixture' } })).toMatchObject({
      ok: true,
      result: [expect.objectContaining({ identity: methodId })],
    });
    expect(door.request({ operation: 'traverse', params: { start: [methodId], follow: [] } })).toMatchObject({
      ok: true,
      result: { nodes: [{ identity: methodId, depth: 0 }], edges: [] },
    });
    // The Door asks for each cell's purpose, so its callers (ia context, the MCP ia_context tool) receive it.
    expect(
      door.request({
        operation: 'context',
        params: { text: '', coordinate: { phase: 'orient', primitive: 'Memory', category: 'process' } },
      }),
    ).toMatchObject({
      ok: true,
      result: {
        included: [
          expect.objectContaining({ identity: methodId, purpose: expect.stringMatching(/^says .+\nanswers /) }),
        ],
      },
    });
    const selected = door.request({
      operation: 'select',
      params: {
        text: '',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'process' },
        candidates: [methodId],
      },
    });
    expect(selected).toMatchObject({ ok: true, result: { entry: { identity: methodId } } });
    if (!selected.ok) return;
    // select chooses one binding and delivers no context, so it does not ask for the purpose.
    expect((selected.result as { entry: object }).entry).not.toHaveProperty('purpose');
    for (const request of [
      null,
      [],
      { operation: 'write' },
      { operation: 'get', params: { identity: methodId, extra: true } },
      { operation: 'select', params: { text: '', candidates: 'bad' } },
      { operation: 'resolve', params: { reference: { kind: 'bad' } } },
      { operation: 'traverse', params: { start: [], filter: { unknown: true } } },
    ])
      expect(door.request(request)).toMatchObject({ ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' });
  } finally {
    door.close();
  }
  expect(door.request({ operation: 'records' })).toMatchObject({ ok: false, code: 'IA-DB-CLOSED' });
}, 30_000);
it('preserves named lower-layer errors and guards privileged reports and foreign tokens', () => {
  const root = workspace(),
    door = new Door(root, { cache: false }),
    other = new Door(root, { cache: false, allowReport: true });
  try {
    expect(door.request({ operation: 'report' })).toMatchObject({ ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' });
    expect(other.request({ operation: 'report' })).toMatchObject({ ok: true });
    const scope = other.request({ operation: 'scope' });
    if (!scope.ok) throw new Error('Fixture scope failed');
    expect(door.request({ operation: 'records', params: { within: (scope.result as Scope).token } })).toMatchObject({
      ok: false,
      code: 'IA-DB-SCOPE-UNAVAILABLE',
    });
    expect(door.request({ operation: 'get', params: { identity: 'outside' } })).toMatchObject({
      ok: false,
      code: 'IA-DB-OUT-OF-SCOPE',
    });
    expect(door.request({ operation: 'records', params: { revision: 'old' } })).toMatchObject({
      ok: false,
      code: 'IA-DB-SCOPE-MISMATCH',
    });
    expect(
      door.request({ operation: 'context', params: { text: '', coordinate: { primitive: 'Thinking' } } }),
    ).toMatchObject({ ok: false, code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' });
    expect(door.request({ operation: 'context', params: { text: '', coordinate: { phase: 'act' } } })).toMatchObject({
      ok: false,
      escalation: 'coordinate-incomplete',
    });
    expect(door.request({ operation: 'traverse', params: { start: [], follow: ['invented'] } })).toMatchObject({
      ok: false,
      code: 'IA-GRAPH-VERB-UNKNOWN',
    });
  } finally {
    door.close();
    other.close();
  }
});

/** The keys the Door names when it refuses an unknown one: what it accepts, in its own words. */
function admittedKeys(door: Door, operation: string, params: Record<string, unknown>): ReadonlySet<string> {
  const response = door.request({ operation, params });
  if (response.ok) throw new Error(`${operation} accepted an unlisted parameter`);
  const listed = /; admitted: (.*)$/.exec(response.message)?.[1];
  if (listed === undefined) throw new Error(`${operation}: ${response.message}`);
  return new Set(listed === '' ? [] : listed.split(', '));
}
const keysOf = (schema: unknown): ReadonlySet<string> =>
  new Set(Object.keys((schema as { properties?: object }).properties ?? {}));
const propertiesOf = (name: string): Record<string, unknown> =>
  (
    MACHINE_PROTOCOL.operations.find((operation) => operation.name === name)!.params as {
      properties: Record<string, unknown>;
    }
  ).properties;
// spec-0012 DRF-01: the description names exactly what the Door admits; the Door, not the table, is the authority.
it('describes exactly the operations and parameters the Door admits', () => {
  const door = new Door(workspace(), { cache: false, allowReport: true });
  try {
    const unknown = door.request({ operation: 'unlisted' });
    const operations = unknown.ok ? [] : /admitted: (.*)$/.exec(unknown.message)?.[1]?.split(', ');
    expect(MACHINE_PROTOCOL.operations.map((operation) => operation.name)).toEqual(operations);
    for (const operation of MACHINE_PROTOCOL.operations)
      expect(admittedKeys(door, operation.name, { unlisted: 1 }), operation.name).toEqual(keysOf(operation.params));
    const coordinate = { phase: 'orient', primitive: 'Decision' },
      start = [methodId];
    expect(
      admittedKeys(door, 'context', { text: '', coordinate, budget: { tokens: 1, records: 1, unlisted: 1 } }),
    ).toEqual(keysOf(propertiesOf('context')['budget']));
    expect(admittedKeys(door, 'traverse', { start, filter: { unlisted: 1 } })).toEqual(
      keysOf(propertiesOf('traverse')['filter']),
    );
    const [identity, named] = (propertiesOf('resolve')['reference'] as { oneOf: readonly unknown[] }).oneOf;
    expect(admittedKeys(door, 'resolve', { reference: { kind: 'identity', identity: methodId, unlisted: 1 } })).toEqual(
      keysOf(identity),
    );
    expect(
      admittedKeys(door, 'resolve', {
        reference: { kind: 'ref', discriminator: 'playbook', name: 'sample-procedure', unlisted: 1 },
      }),
    ).toEqual(keysOf(named));
    const filter = propertiesOf('traverse')['filter'] as { properties: { kind: { enum: readonly string[] } } };
    expect([...filter.properties.kind.enum].sort()).toEqual([...KINDS].sort());
    const depth = (propertiesOf('traverse')['depth'] as { maximum: number }).maximum;
    expect(door.request({ operation: 'traverse', params: { start, follow: [], depth } }).ok).toBe(true);
    expect(door.request({ operation: 'traverse', params: { start, follow: [], depth: depth + 1 } })).toMatchObject({
      ok: false,
      code: 'IA-GRAPH-TRAVERSAL-INVALID',
    });
  } finally {
    door.close();
  }
}, 30_000);

/** spec-0012 VER-01: the parameter digest each description version carries. */
const PARAMS_DIGESTS: Readonly<Record<number, string>> = {
  1: 'b92e71f8d59eadd34034974eb77cdc868ccd33b34a6c3c73fe2b2999707f7206',
  2: 'b92936dac712a9381069d5432448eec2045110d0af54ad4d41938c18f8c17dae',
};
const strip = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(strip)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'description')
            .map(([key, child]) => [key, strip(child)]),
        )
      : value;
const paramsDigest = (operations: typeof MACHINE_PROTOCOL.operations): string =>
  createHash('sha256')
    .update(JSON.stringify(operations.map((operation) => [operation.name, strip(operation.params)])))
    .digest('hex');
it("bumps the protocol description version whenever an operation's parameters change", () => {
  // Rewording a description keeps the digest; a changed key, type or closed set changes it and needs a new version.
  expect(
    paramsDigest(MACHINE_PROTOCOL.operations),
    "An operation's params changed: bump MACHINE_PROTOCOL.version and pin its digest here",
  ).toBe(PARAMS_DIGESTS[MACHINE_PROTOCOL.version]);
});
/** The nine operations protocol version 1 described, in its order. */
const VERSION_1 = ['scope', 'context', 'select', 'get', 'records', 'resolve', 'search', 'traverse', 'report'];
it("adds version 2's operations after version 1's nine, whose parameters still digest to version 1's", () => {
  expect(MACHINE_PROTOCOL.version).toBe(2);
  const first = MACHINE_PROTOCOL.operations.slice(0, VERSION_1.length),
    added = MACHINE_PROTOCOL.operations.slice(VERSION_1.length);
  expect(first.map((operation) => operation.name)).toEqual(VERSION_1);
  // The nine rows carry no since, so they print as version 1 printed them; their parameters are version 1's.
  for (const operation of first) expect(Object.hasOwn(operation, 'since'), operation.name).toBe(false);
  expect(paramsDigest(first)).toBe(PARAMS_DIGESTS[1]);
  expect(added.map((operation) => [operation.name, operation.since, operation.mcp])).toEqual([
    ['position', 2, 'ia_position'],
    ['read', 2, 'ia_read'],
    ['next', 2, 'ia_next'],
  ]);
  // One flow line, the last, tells what version 2 adds.
  expect(MACHINE_PROTOCOL.flow.at(-1)).toMatch(/^Since version 2: position .* read .* next /);
});

/** The refusal's next action for `code`, as the operation's protocol row lists it. */
const nextOf = (operation: string, code: string): string | undefined =>
  MACHINE_PROTOCOL.operations.find((row) => row.name === operation)?.refusals.find((refusal) => refusal.code === code)
    ?.next;
const refused = (response: DoorResponse, operation: string, code: string): void => {
  expect(response, `${operation} ${code}`).toMatchObject({ ok: false, code });
  expect(response.ok ? undefined : response.next, `${operation} ${code}`).toBe(nextOf(operation, code));
  expect(nextOf(operation, code), `${operation} ${code}`).toEqual(expect.any(String));
};

it('serves position: the body and digest position() gives, its host note, and no new scope token', () => {
  const root = workspace(),
    facts = vi.fn((): HostFacts => ({ cli: 'ia@9.9.9', installedStateDigest: 'f'.repeat(64) })),
    door = new Door(root, { cache: false, hostFacts: facts }),
    db = database(root),
    within = db.resolveScope().token;
  try {
    for (const key of [{}, { shape: 'governance', phase: 'plan', depth: 2, budget: 64 }, { word: 'law', depth: 0 }]) {
      const got = door.request({ operation: 'position', params: key });
      if (!got.ok) throw new Error(`position ${JSON.stringify(key)}: ${got.message}`);
      const expected = position(db, within, normalizeScopeKey(key));
      const result = got.result as typeof expected;
      expect(Object.keys(result)).toEqual(['body', 'digest', 'hostNote']);
      // body(K) is the same through the Door and through position(): the token and the host's facts never reach it.
      expect(result.body).toEqual(expected.body);
      expect(result.digest).toBe(expected.digest);
      expect(result.hostNote).toMatchObject({
        revision: db.revision,
        cli: 'ia@9.9.9',
        installedStateDigest: 'f'.repeat(64),
        adapter: null,
        key: { ...expected.hostNote.key },
      });
      expect(JSON.stringify(result)).not.toMatch(/"token"/);
    }
    // The host is asked for its facts once per position, and never by another operation.
    expect(facts).toHaveBeenCalledTimes(3);
    expect(door.request({ operation: 'records', params: {} }).ok).toBe(true);
    expect(facts).toHaveBeenCalledTimes(3);
    // A scope issued by the Door seats the body inside it.
    const narrowed = door.request({ operation: 'scope', params: { identities: [methodId] } });
    if (!narrowed.ok) throw new Error(narrowed.message);
    const token = (narrowed.result as Scope).token;
    const seated = door.request({ operation: 'position', params: { within: token, seat: methodId } });
    expect(seated).toMatchObject({ ok: true, result: { body: { seat: { identity: methodId } } } });
  } finally {
    door.close();
  }
});

it('refuses position and read with a next action from their protocol rows, and the nine routes without one', () => {
  const door = new Door(workspace(), { cache: false });
  try {
    const narrowed = door.request({ operation: 'scope', params: { identities: [methodId] } });
    if (!narrowed.ok) throw new Error(narrowed.message);
    const token = (narrowed.result as Scope).token;
    const position = (params: Record<string, unknown>) => door.request({ operation: 'position', params });
    refused(position({ unlisted: 1 }), 'position', 'IA-RUNTIME-REQUEST-INVALID');
    refused(position({ depth: 3 }), 'position', 'IA-RUNTIME-REQUEST-INVALID');
    refused(position({ budget: 65 }), 'position', 'IA-RUNTIME-REQUEST-INVALID');
    refused(position({ seat: '' }), 'position', 'IA-RUNTIME-REQUEST-INVALID');
    // A host-supplied participant is no part of a scope key: the body stays a function of the key alone.
    refused(position({ participant: 'someone' }), 'position', 'IA-RUNTIME-REQUEST-INVALID');
    refused(position({ within: 'forged' }), 'position', 'IA-DB-SCOPE-UNAVAILABLE');
    refused(position({ shape: 'unlisted' }), 'position', 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN');
    refused(position({ phase: 'unlisted' }), 'position', 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN');
    refused(position({ within: token, seat: lawId }), 'position', 'IA-DB-OUT-OF-SCOPE');
    refused(position({ seat: '../outside' }), 'position', 'IA-DB-PATH-UNSAFE');
    const read = (params: Record<string, unknown>) => door.request({ operation: 'read', params });
    refused(read({}), 'read', 'IA-RUNTIME-REQUEST-INVALID');
    refused(read({ locator: 'not a locator' }), 'read', 'IA-RUNTIME-REQUEST-INVALID');
    refused(read({ locator: methodId, unlisted: 1 }), 'read', 'IA-RUNTIME-REQUEST-INVALID');
    refused(read({ locator: methodId, within: 'forged' }), 'read', 'IA-DB-SCOPE-UNAVAILABLE');
    refused(read({ locator: lawId, within: token }), 'read', 'IA-DB-OUT-OF-SCOPE');
    refused(read({ locator: 'a/b/c/d' }), 'read', 'IA-DB-OUT-OF-SCOPE');
    refused(read({ locator: `${methodId}#REQ-NONE-1` }), 'read', 'IA-DB-SOURCE-UNAVAILABLE');
    refused(read({ locator: 'nowhere.ia:1' }), 'read', 'IA-DB-SOURCE-UNAVAILABLE');
    // The nine version-1 routes refuse as version 1 did: code and message, no next.
    for (const request of [
      { operation: 'get', params: {} },
      { operation: 'scope', params: { within: 'forged' } },
      { operation: 'get', params: { identity: lawId, within: token } },
      { operation: 'unlisted', params: {} },
    ]) {
      const got = door.request(request);
      expect(got.ok, request.operation).toBe(false);
      expect(Object.keys(got), request.operation).toEqual(['ok', 'code', 'message']);
    }
    // An unknown operation lists the version-2 operations after the nine, in table order.
    expect(door.request({ operation: 'unlisted' })).toMatchObject({
      message: expect.stringMatching(/admitted: scope, .*, traverse, position, read, next$/),
    });
  } finally {
    door.close();
  }
});

it('serves read: the body readBody gives behind a locator, inside the scope', () => {
  const root = workspace(),
    door = new Door(root, { cache: false }),
    db = database(root),
    within = db.resolveScope().token;
  try {
    for (const locator of [methodId, `${methodId}#orient/Decision`, `${methodPath}:3`]) {
      const got = door.request({ operation: 'read', params: { locator } });
      expect(got, locator).toEqual({ ok: true, result: readBody(db, parseLocator(locator), { within }) });
    }
    const narrowed = door.request({ operation: 'scope', params: { identities: [methodId] } });
    if (!narrowed.ok) throw new Error(narrowed.message);
    expect(
      door.request({ operation: 'read', params: { locator: methodId, within: (narrowed.result as Scope).token } }),
    ).toMatchObject({ ok: true, result: { identity: methodId, source: 'record' } });
  } finally {
    door.close();
  }
});

it("counts a position's staleness over the records its scope admits", () => {
  const root = workspace();
  put(root, '.ia/src/gone.ia', playbook('gone'));
  const first = database(root),
    members = first.membership().length;
  writeCaptured(root, CAPTURE_DIR, captureOf(first));
  // After the capture: edit the scoped record, add one record and remove another.
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8').replace('statement 1.', 'statement one.'));
  put(root, '.ia/src/fresh.ia', playbook('fresh'));
  rmSync(resolve(root, '.ia/src/gone.ia'));
  const door = new Door(root, { cache: false });
  try {
    // The initial scope holds the whole workspace: every record counts, removals included.
    expect(door.request({ operation: 'position', params: {} })).toMatchObject({
      ok: true,
      result: { hostNote: { staleness: { changed: 1, new: 1, removed: 1, unchanged: members - 2 } } },
    });
    // A narrowed scope counts its own records only; a removal cannot be placed inside or outside it.
    const narrowed = door.request({ operation: 'scope', params: { identities: [methodId] } });
    if (!narrowed.ok) throw new Error(narrowed.message);
    const within = (narrowed.result as Scope).token;
    expect(door.request({ operation: 'position', params: { within, seat: methodId } })).toMatchObject({
      ok: true,
      result: {
        hostNote: {
          captured: { freshness: 'stale' },
          staleness: { changed: 1, new: 0, removed: null, unchanged: 0 },
        },
      },
    });
  } finally {
    door.close();
  }
});

/** One plan with one milestone and two tasks, written into the work system of a corpus copy. */
const WORK_RECORDS = '.ia/src/systems/work-system/records';
const PLAN = 'work-system/definition/plan/door-plan',
  MILESTONE = 'work-system/definition/milestone/door-milestone',
  FIRST = 'work-system/definition/task/first-task',
  SECOND = 'work-system/definition/task/second-task';
function planned(root: string, second = 'Second task.'): void {
  put(
    root,
    `${WORK_RECORDS}/door.ia`,
    '#! ia 1.0\n\n' +
      '@plan door-plan\n  meaning\n    says "Door plan."\n  work\n    title "door plan"\n    status open\n\n' +
      '@milestone door-milestone\n  meaning\n    says "Door milestone."\n  work\n    title "door milestone"\n    status open\n' +
      '    plan @plan door-plan\n    exit "Both tasks done."\n\n' +
      '@task first-task\n  meaning\n    says "First task."\n  work\n    title "first"\n    status open\n' +
      '    milestone @milestone door-milestone\n\n' +
      `@task second-task\n  meaning\n    says "${second}"\n  work\n    title "second"\n    status open\n` +
      '    milestone @milestone door-milestone\n  relationships\n    requires @task first-task\n',
  );
}
const admitted = (view: DeliveryView): Record<string, string> =>
  Object.fromEntries(
    view.entries.map((entry) => [entry.identity, entry.lines.find((line) => line.line === 'admitted')!.value]),
  );

it('serves next: the delivery view next() gives over a handle that retains the captured current snapshot', () => {
  const root = workspace();
  planned(root);
  const door = new Door(root, { cache: false });
  try {
    // Nothing captured: the Door's handle retains no snapshot, so no record reads as admitted in one.
    const bare = door.request({ operation: 'next', params: {} });
    if (!bare.ok) throw new Error(bare.message);
    const db = database(root);
    expect(bare.result).toEqual(next(db, db.resolveScope().token));
    expect((bare.result as DeliveryView).snapshot).toBeNull();
    expect(Object.values(admitted(bare.result as DeliveryView))).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect((bare.result as DeliveryView).entries.map((entry) => entry.identity)).toEqual([
      PLAN,
      MILESTONE,
      FIRST,
      SECOND,
    ]);
    expect(JSON.stringify(bare.result)).not.toMatch(/"token"/);
  } finally {
    door.close();
  }
  // Two captures, the second after an edit: the store's current snapshot holds the edited task, its previous one not.
  writeCaptured(root, CAPTURE_DIR, captureOf(database(root)));
  planned(root, 'Second task, edited.');
  writeCaptured(root, CAPTURE_DIR, captureOf(database(root)));
  const store = readCapturedSnapshot(root);
  expect(store.previous?.revision).not.toBe(store.current?.revision);
  const seeded = new Door(root, { cache: false });
  try {
    const got = seeded.request({ operation: 'next', params: { seat: MILESTONE } });
    if (!got.ok) throw new Error(got.message);
    const view = got.result as DeliveryView,
      db = database(root, { previous: digestIndex(store.current!) });
    expect(view).toEqual(next(db, db.resolveScope().token, { seat: MILESTONE }));
    // The retained snapshot is the store's current one, so every record, the edited task included, is admitted in it.
    expect(view.snapshot).toBe(store.current!.revision);
    expect(admitted(view)).toEqual({ [MILESTONE]: 'admitted', [FIRST]: 'admitted', [SECOND]: 'admitted' });
    // A scope issued by the Door narrows the view in the same process.
    const narrowed = seeded.request({ operation: 'scope', params: { identities: [FIRST] } });
    if (!narrowed.ok) throw new Error(narrowed.message);
    expect(
      seeded.request({ operation: 'next', params: { within: (narrowed.result as Scope).token, seat: FIRST } }),
    ).toMatchObject({ ok: true, result: { seat: { identity: FIRST, word: 'task' }, entries: [{ identity: FIRST }] } });
  } finally {
    seeded.close();
  }
  // A host that names its own retained snapshot keeps it: the Door seeds from the store only when none is given.
  const own = new Door(root, { cache: false, previous: digestIndex(store.previous!) });
  try {
    const got = own.request({ operation: 'next', params: { seat: SECOND } });
    expect(got).toMatchObject({ ok: true, result: { snapshot: store.previous!.revision } });
    expect(admitted((got as { result: DeliveryView }).result)).toEqual({ [SECOND]: 'not evaluated' });
  } finally {
    own.close();
  }
});

it("refuses next with the delivery view's own next command for its causes, and the row's next for the rest", () => {
  const empty = workspace(),
    two = workspace();
  planned(two);
  put(
    two,
    `${WORK_RECORDS}/other.ia`,
    '#! ia 1.0\n\n@plan another-plan\n  meaning\n    says "Another plan."\n  work\n    title "another"\n    status open\n',
  );
  const bare = new Door(empty, { cache: false }),
    door = new Door(two, { cache: false });
  try {
    const cause = (got: DoorResponse, next: string): void => {
      expect(got).toMatchObject({ ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' });
      expect(got.ok ? undefined : got.next).toBe(next);
    };
    // No authored plan and no seat: the worked example of the plan word.
    cause(bare.request({ operation: 'next', params: {} }), NEXT_COMMANDS.noPlan());
    // Two plans and no seat: seat the view at the first.
    cause(
      door.request({ operation: 'next', params: {} }),
      NEXT_COMMANDS.choosePlan('work-system/definition/plan/another-plan'),
    );
    // A seat naming nothing, or nothing a view is seated at.
    cause(
      door.request({ operation: 'next', params: { seat: 'work-system/definition/task/none' } }),
      NEXT_COMMANDS.dropSeat(),
    );
    cause(door.request({ operation: 'next', params: { seat: '' } }), NEXT_COMMANDS.dropSeat());
    cause(door.request({ operation: 'next', params: { seat: methodId } }), NEXT_COMMANDS.position(methodId));
    // Every other refusal names the next action its protocol row lists for the code.
    const call = (params: Record<string, unknown>) => door.request({ operation: 'next', params });
    refused(call({ unlisted: 1 }), 'next', 'IA-RUNTIME-REQUEST-INVALID');
    refused(call({ seat: 1 }), 'next', 'IA-RUNTIME-REQUEST-INVALID');
    refused(call({ within: 'forged' }), 'next', 'IA-DB-SCOPE-UNAVAILABLE');
    // The view is never a version-1 refusal: every refusal of next carries a next.
    expect(Object.keys(call({ unlisted: 1 }))).toEqual(['ok', 'code', 'message', 'next']);
  } finally {
    bare.close();
    door.close();
  }
});
