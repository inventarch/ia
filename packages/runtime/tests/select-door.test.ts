import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KINDS } from '@inventarch/language';
import { expect, it } from 'vitest';
import { Door, MACHINE_PROTOCOL, context, select } from '../src/index.js';
import type { ContextRequest, Scope } from '../src/index.js';
import { database, methodId, playbook, put, workspace } from './workspace.js';

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
it('answers get and records in their frozen version 1 shape, without the per-record digest or membership', () => {
  const root = workspace(),
    door = new Door(root, { cache: false }),
    db = database(root);
  try {
    const { digest, ...record } = db.get(methodId)!;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(door.request({ operation: 'get', params: { identity: methodId } }))).toBe(
      JSON.stringify({ ok: true, result: record }),
    );
    const snapshot = db.snapshot(),
      records = door.request({ operation: 'records' });
    expect(snapshot.membership).toHaveLength(snapshot.records.length);
    if (!records.ok) throw new Error('Fixture records failed');
    expect(Object.keys(records.result as object)).toEqual(['revision', 'root', 'records', 'systems']);
    expect(JSON.stringify(records.result)).toBe(
      JSON.stringify({
        revision: snapshot.revision,
        root: snapshot.root,
        records: snapshot.records.map(({ digest: _digest, ...node }) => node),
        systems: snapshot.systems,
      }),
    );
  } finally {
    door.close();
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
  // A door serving version 1, as the CLI's machine routes do (plan amendment A2), names exactly the version 1 rows, and
  // refuses a later version's operation before reading its parameters, with the bytes of 1.1.0's unknown operation.
  const routes = new Door(workspace(), { cache: false, allowReport: true, protocol: 1 });
  try {
    const unknown = routes.request({ operation: 'unlisted' });
    expect(unknown.ok ? [] : /admitted: (.*)$/.exec(unknown.message)?.[1]?.split(', ')).toEqual(
      MACHINE_PROTOCOL.operations
        .filter((operation) => operation.since === undefined)
        .map((operation) => operation.name),
    );
    for (const operation of MACHINE_PROTOCOL.operations.filter((row) => row.since !== undefined))
      expect(
        routes.request({ operation: operation.name, params: { ...operation.example, unlisted: 1 } }),
        operation.name,
      ).toEqual({
        ok: false,
        code: 'IA-RUNTIME-REQUEST-INVALID',
        message: `IA-RUNTIME-REQUEST-INVALID: Unknown operation '${operation.name}'; admitted: scope, context, select, get, records, resolve, search, traverse, report`,
      });
  } finally {
    routes.close();
  }
  for (const protocol of [0, 1.5, MACHINE_PROTOCOL.version + 1])
    expect(() => new Door(workspace(), { cache: false, protocol }), String(protocol)).toThrow(TypeError);
}, 30_000);

/**
 * spec-0012 VER-01: the parameter digest each description version carries, over the operations that version describes:
 * version 1's nine, frozen, and every later version's over its own rows and the rows before it.
 */
const PARAMS_DIGESTS: Readonly<Record<number, string>> = {
  1: 'b92e71f8d59eadd34034974eb77cdc868ccd33b34a6c3c73fe2b2999707f7206',
  2: '4035005b8d26662aa761646bcb6983d2b529433401c468b6254824eadc3322cb',
};
it("bumps the protocol description version whenever an operation's parameters change", () => {
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
  const digest = (version: number): string =>
    createHash('sha256')
      .update(
        JSON.stringify(
          MACHINE_PROTOCOL.operations
            .filter((operation) => (operation.since ?? 1) <= version)
            .map((operation) => [operation.name, strip(operation.params)]),
        ),
      )
      .digest('hex');
  // Rewording a description keeps the digest; a changed key, type or closed set changes it and needs a new version.
  expect(digest(1), 'A version 1 operation changed its params, which the frozen version 1 rows never do').toBe(
    PARAMS_DIGESTS[1],
  );
  expect(
    digest(MACHINE_PROTOCOL.version),
    "An operation's params changed: bump MACHINE_PROTOCOL.version and pin its digest here",
  ).toBe(PARAMS_DIGESTS[MACHINE_PROTOCOL.version]);
  expect(Math.max(...Object.keys(PARAMS_DIGESTS).map(Number))).toBe(MACHINE_PROTOCOL.version);
});

// The operator's additive constraint (plan amendment A2): a later version appends rows, so the nine version 1 rows keep
// the bytes 1.1.0 exported. The golden holds the rows as tag v1.1.0 exports them: it was written from a build whose
// src/machine-protocol.ts was the tag's, unchanged, and whose dist/machine-protocol.js was the published 1.1.0 file's.
it('keeps the nine version 1 rows byte-identical to 1.1.0 and marks each later row with its version', () => {
  const golden = readFileSync(resolve(import.meta.dirname, 'golden/machine-protocol-v1.json'), 'utf8'),
    rows = MACHINE_PROTOCOL.operations;
  expect(JSON.stringify(rows.slice(0, 9), null, 2) + '\n').toBe(golden);
  // No version 1 row carries the key, not even undefined, which JSON would not show.
  expect(rows.slice(0, 9).every((operation) => !('since' in operation))).toBe(true);
  const since = rows.slice(9).map((operation) => operation.since!);
  expect(since.length).toBeGreaterThan(0);
  expect(
    since.every(
      (version, index) => version >= 2 && version <= MACHINE_PROTOCOL.version && version >= (since[index - 1] ?? 2),
    ),
  ).toBe(true);
  expect(since.at(-1)).toBe(MACHINE_PROTOCOL.version);
});
