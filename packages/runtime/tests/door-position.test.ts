/**
 * The Door's `position` operation (MACHINE_PROTOCOL version 2, SPEC R12): runtime `position` (R16) through the door's
 * scope token, its output the result byte for byte, over copies of the conformance corpus and the loop fixture. The
 * body is compared with what `position` returns rather than with a hand-written one, so these tests hold the Door to the
 * runtime whatever sections the body carries.
 */
import { basename, resolve } from 'node:path';
import { SHAPES } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { afterEach, expect, it } from 'vitest';
import { Door, MACHINE_PROTOCOL, SCOPE_KEY_CAPS, position } from '../src/index.js';
import type { DoorOptions, DoorResponse, PositionOutput, Scope, ScopeKey } from '../src/index.js';
import { database, lawId, lawPath, methodId, tree, workspace } from './workspace.js';

const governanceSystem = 'floor/definition/system/governance-system',
  foundation = 'workspace-system/definition/workspace/foundation-workspace';
/** K0 and a governance key, then the other seat forms, a deeper key and a word. */
const KEYS: Readonly<Record<string, Partial<ScopeKey>>> = {
  k0: {},
  governance: { seat: lawId, shape: 'governance' },
  'governance-system': { seat: governanceSystem, shape: 'governance', depth: 2 },
  location: { seat: { path: lawPath }, shape: 'governance', depth: 0, budget: 0 },
  sequence: { shape: 'sequence', depth: 2 },
  'word-law': { seat: governanceSystem, shape: 'governance', word: 'law' },
};
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
const doors: Door[] = [];
afterEach(() => {
  for (const opened of doors.splice(0)) opened.close();
});
function door(root: string, options: DoorOptions = {}): Door {
  const opened = new Door(root, { cache: false, ...options });
  doors.push(opened);
  return opened;
}
const positioned =
  (gate: Door) =>
  (params?: Record<string, unknown>): DoorResponse =>
    gate.request({ operation: 'position', ...(params === undefined ? {} : { params }) });
const served = (output: PositionOutput): string => JSON.stringify({ ok: true, result: output });
const resultOf = (response: DoorResponse): PositionOutput => {
  if (!response.ok) throw new Error(response.message);
  return response.result as PositionOutput;
};
/** Every value of an `identity` or `from` key in the body, wherever a section holds one. */
function named(value: unknown, into = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) for (const item of value) named(item, into);
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'identity' || key === 'from') && typeof child === 'string') into.add(child);
      else named(child, into);
    }
  return into;
}

it("answers with runtime position through the door's token, byte for byte, and writes nothing", () => {
  const root = workspace(),
    gate = door(root),
    db = database(root),
    within = db.resolveScope().token,
    before = tree(root);
  for (const [name, partial] of Object.entries(KEYS)) {
    const response = positioned(gate)(partial as Record<string, unknown>);
    expect(JSON.stringify(response), name).toBe(served(position(db, within, partial)));
    expect(Object.isFrozen(response), name).toBe(true);
  }
  // No params is the empty key, K0, as `{}` is.
  expect(JSON.stringify(positioned(gate)())).toBe(served(position(db, within)));
  expect(resultOf(positioned(gate)()).body.key).toEqual({ shape: 'context', phase: 'orient', depth: 0, budget: 0 });
  // A token the door issued reads as that token reads.
  const scope = gate.request({ operation: 'scope', params: { identities: [governanceSystem, lawId, methodId] } });
  if (!scope.ok) throw new Error(scope.message);
  const token = (scope.result as Scope).token,
    narrow = db.resolveScope({ identities: [governanceSystem, lawId, methodId] }).token;
  expect(JSON.stringify(positioned(gate)({ ...KEYS['governance-system'], within: token }))).toBe(
    served(position(db, narrow, KEYS['governance-system'])),
  );
  expect(tree(root)).toBe(before);
});

it('gives one key one body and digest at two absolute roots through the Door', () => {
  const roots = [workspace(), workspace()],
    gates = roots.map((root) => door(root));
  expect(roots[0]).not.toBe(roots[1]);
  for (const [name, partial] of Object.entries(KEYS)) {
    const [a, b] = gates.map((gate) => resultOf(positioned(gate)(partial as Record<string, unknown>)));
    expect(JSON.stringify(b!.body), name).toBe(JSON.stringify(a!.body));
    expect(b!.digest, name).toBe(a!.digest);
  }
  // A location spelled as an absolute path under each root: one body and digest, no root in it; the host note keeps the
  // key as the caller spelled it.
  const outputs = roots.map((root, index) =>
    resultOf(positioned(gates[index]!)({ seat: { path: resolve(root, lawPath) }, shape: 'governance' })),
  );
  for (const [index, output] of outputs.entries()) {
    const body = JSON.stringify(output.body),
      root = roots[index]!;
    for (const spelling of [root, root.replaceAll('\\', '/'), JSON.stringify(root).slice(1, -1), basename(root)])
      expect(body).not.toContain(spelling);
    expect(output.body.key.seat).toEqual({ path: lawPath });
    expect(output.hostNote.key.seat).toEqual({ path: resolve(root, lawPath) });
  }
  expect(JSON.stringify(outputs[1]!.body)).toBe(JSON.stringify(outputs[0]!.body));
  expect(outputs[1]!.digest).toBe(outputs[0]!.digest);
});

it("prunes the body to a narrowed boundary, naming no record outside it, as the runtime does through that scope's token", () => {
  const root = workspace(),
    boundary = [governanceSystem, lawId, methodId],
    db = database(root),
    whole = door(root),
    bounded = door(root, { boundary: { identities: boundary } });
  for (const [name, partial] of Object.entries({ k0: {}, 'governance-system': KEYS['governance-system']! })) {
    const response = positioned(bounded)(partial as Record<string, unknown>);
    expect(JSON.stringify(response), name).toBe(
      served(position(db, db.resolveScope({ identities: boundary }).token, partial)),
    );
    const narrow = named(resultOf(response).body),
      wide = named(resultOf(positioned(whole)(partial as Record<string, unknown>)).body);
    expect(
      [...narrow].filter((identity) => !boundary.includes(identity)),
      name,
    ).toEqual([]);
    expect([...narrow].every((identity) => wide.has(identity)) && wide.size > narrow.size, name).toBe(true);
    // A narrowed scope reads no admission finding, and says so.
    expect(resultOf(response).body.unknowns, name).toContainEqual(expect.objectContaining({ kind: 'unread' }));
  }
});

// Plan T3's same-Door line, on a real Door: a version 1 `context` call with any request text, in both rankings, between
// two positions moves neither the body, nor its digest, nor the host note.
it('answers a position again byte for byte after a version 1 context call with arbitrary text on the same Door', () => {
  const gate = door(workspace()),
    read = positioned(gate);
  for (const [name, partial] of Object.entries(KEYS)) {
    const before = JSON.stringify(read(partial as Record<string, unknown>));
    for (const [text, ranking] of [
      ['what governs src/billing/invoice.ts', 'topical'],
      ['sample fixture statement enforce the law', 'native'],
    ] as const)
      expect(
        gate.request({
          operation: 'context',
          params: { text, coordinate: { phase: 'act', primitive: 'Decision', category: 'process' }, ranking },
        }).ok,
        `${name}: ${text}`,
      ).toBe(true);
    expect(JSON.stringify(read(partial as Record<string, unknown>)), name).toBe(before);
  }
});

// A refusal of the key carries `next`, the one command to run (design row 27), as the lead's rule for a version 2
// operation's refusals has it; the Door's own refusals of a position request, and a version 1 operation's, keep the
// three keys 1.1.0's had.
it('refuses a key with its next command and keeps the three keys of the refusals the Door raises itself', () => {
  const root = workspace(),
    gate = door(root),
    db = database(root),
    within = db.resolveScope().token;
  const shapes = `ia position --shape <${SHAPES.join('|')}>`;
  for (const [params, next] of [
    [{ shape: 'bogus' }, shapes],
    [{ shape: 3 }, shapes],
    [{ phase: 'later' }, 'ia position --phase <orient|plan|act|learn>'],
    [{ depth: SCOPE_KEY_CAPS.depth + 1 }, `ia position --depth ${SCOPE_KEY_CAPS.depth}`],
    [{ depth: 1.5 }, `ia position --depth ${SCOPE_KEY_CAPS.depth}`],
    [{ budget: SCOPE_KEY_CAPS.budget + 1 }, `ia position --budget ${SCOPE_KEY_CAPS.budget}`],
    [{ budget: -1 }, `ia position --budget ${SCOPE_KEY_CAPS.budget}`],
    [{ word: 'nope' }, 'ia vocabulary'],
    [{ word: 3 }, 'ia vocabulary'],
    [{ seat: 'governance-system/governance/law/absent' }, 'ia position'],
    [{ seat: { path: '../outside.md' } }, 'ia position'],
    [{ seat: { file: lawPath } }, 'ia position'],
    [{ seat: null }, 'ia position'],
  ] as const) {
    const label = JSON.stringify(params),
      response = positioned(gate)(params);
    let thrown: unknown;
    try {
      position(db, within, params as Partial<ScopeKey>);
    } catch (error) {
      thrown = error;
    }
    // The refusal is the error position throws, its code, message and next.
    expect(thrown, label).toMatchObject({ code: 'IA-RUNTIME-REQUEST-INVALID', next });
    expect(response, label).toEqual({
      ok: false,
      code: 'IA-RUNTIME-REQUEST-INVALID',
      message: (thrown as Error).message,
      next,
    });
    expect(Object.keys(response), label).toEqual(['ok', 'code', 'message', 'next']);
  }
  // A seat at runtime placement: the position without it, K0, which recovers, or the overview when the seat is the one
  // K0 takes, the repository's own @workspace, whether the key names it or not, as K0 refuses it alike. positionBody
  // raises each with that `next` (R15), so the Door answers with the error `position` throws, as for a key refusal.
  const thrownBy = (handle: ReturnType<typeof database>, params: Partial<ScopeKey> = {}): unknown => {
    try {
      position(handle, handle.resolveScope().token, params);
    } catch (error) {
      return error;
    }
    throw new Error('position did not refuse');
  };
  const lawPlaced = { locations: { [lawPath]: RUNTIME } },
    placed = door(workspace(), lawPlaced);
  const runtimeSeat = {
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message: `IA-RUNTIME-REQUEST-INVALID: The seat '${lawId}' is at runtime placement (band 0), which no position body enters`,
    next: 'ia position',
  };
  expect(positioned(placed)({ seat: lawId })).toEqual(runtimeSeat);
  expect(thrownBy(database(workspace(), lawPlaced), { seat: lawId })).toMatchObject({
    code: runtimeSeat.code,
    message: runtimeSeat.message,
    next: runtimeSeat.next,
  });
  expect(positioned(placed)().ok).toBe(true);
  const workspacePlaced = {
      locations: { '.ia/src/systems/workspace-system/records/foundation-workspace.ia': RUNTIME },
    },
    unseated = door(workspace(), workspacePlaced),
    unseatedDb = database(workspace(), workspacePlaced);
  const overview = {
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message: `IA-RUNTIME-REQUEST-INVALID: The seat '${foundation}' is at runtime placement (band 0), which no position body enters`,
    next: 'ia inspect',
  };
  for (const params of [undefined, { shape: 'governance' }, { seat: foundation }, { seat: foundation, depth: 2 }]) {
    expect(positioned(unseated)(params), JSON.stringify(params)).toEqual(overview);
    expect(thrownBy(unseatedDb, params as Partial<ScopeKey> | undefined), JSON.stringify(params)).toMatchObject({
      code: overview.code,
      message: overview.message,
      next: overview.next,
    });
  }
  // The Door's own refusals: request text, a token or any other part the key does not have is an unknown parameter, a
  // within that is no string or that the door did not issue, and a version 1 operation's refusal.
  for (const request of [
    { operation: 'position', params: { text: 'what governs billing' } },
    { operation: 'position', params: { token: within } },
    { operation: 'position', params: { within: 3 } },
    { operation: 'position', params: { within: 'forged', depth: 9 } },
    { operation: 'get', params: { identity: lawId, within: 'forged' } },
  ]) {
    const response = gate.request(request);
    expect(response.ok, JSON.stringify(request)).toBe(false);
    expect(Object.keys(response), JSON.stringify(request)).toEqual(['ok', 'code', 'message']);
  }
  expect(positioned(gate)({ text: 'what governs billing' })).toEqual({
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message:
      "IA-RUNTIME-REQUEST-INVALID: Unknown parameter 'text'; admitted: within, seat, shape, phase, depth, budget, word",
  });
  // A door serving version 1, as the CLI's machine routes do, knows no position operation, and reads no parameter.
  expect(positioned(door(root, { protocol: 1 }))({ depth: 9 })).toEqual({
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message:
      "IA-RUNTIME-REQUEST-INVALID: Unknown operation 'position'; admitted: scope, context, select, get, records, resolve, search, traverse",
  });
});

// spec-0012 DRF-02 for the position row: its example reads the loop fixture, it requires no parameter, its closed sets
// and caps are the key's, and its refusal list is proven both ways.
it('holds the position row of the machine protocol table to the Door', () => {
  const row = MACHINE_PROTOCOL.operations.find((operation) => operation.name === 'position')!;
  expect(row).toMatchObject({ since: 2, mcp: 'ia_position' });
  expect(MACHINE_PROTOCOL.operations.at(-1)).toBe(row);
  const params = row.params as {
    required: readonly string[];
    properties: Record<string, { enum?: readonly string[]; maximum?: number }>;
  };
  expect(params.required).toEqual([]);
  expect(params.properties['shape']!.enum).toEqual(SHAPES);
  expect(params.properties['depth']!.maximum).toBe(SCOPE_KEY_CAPS.depth);
  expect(params.properties['budget']!.maximum).toBe(SCOPE_KEY_CAPS.budget);
  const loop = door(resolve(import.meta.dirname, '../../compliance/fixtures/loop'));
  const example = positioned(loop)(row.example);
  expect(example).toMatchObject({ ok: true, result: { body: { format: 'ia.position-body.v1' } } });
  expect(resultOf(example).body.loaded[0]).toMatchObject({ identity: row.example['seat'] });
  // Each cap is admitted and one past it refused.
  for (const part of ['depth', 'budget'] as const) {
    expect(positioned(loop)({ [part]: SCOPE_KEY_CAPS[part] }).ok, part).toBe(true);
    expect(positioned(loop)({ [part]: SCOPE_KEY_CAPS[part] + 1 }).ok, part).toBe(false);
  }
  const triggers: Readonly<Record<string, Record<string, unknown>>> = {
    'IA-RUNTIME-REQUEST-INVALID': { depth: SCOPE_KEY_CAPS.depth + 1 },
    'IA-DB-SCOPE-UNAVAILABLE': { within: 'forged' },
  };
  const observed = Object.values(triggers).map((params) => {
    const response = positioned(loop)(params);
    return response.ok ? 'accepted' : response.code;
  });
  expect(observed).toEqual(Object.keys(triggers));
  expect(row.refusals.map((refusal) => refusal.code).sort()).toEqual(Object.keys(triggers).sort());
});
