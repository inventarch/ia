import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Door, MACHINE_PROTOCOL, openDatabase, position } from '@inventarch/runtime';
import { Protocol, PROTOCOL_VERSION } from '../src/protocol.js';

const fixture = resolve(import.meta.dirname, '../../../packages/compliance/fixtures/loop'),
  instances: Protocol[] = [],
  temporary: string[] = [];
const message = (id: number | string, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
function protocol(root = fixture) {
  const value = new Protocol(root);
  instances.push(value);
  return value;
}
function initialize(value: Protocol) {
  const response = value.request(
    message(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    }),
  );
  value.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}
afterEach(() => {
  for (const value of instances.splice(0)) value.close();
  for (const root of temporary.splice(0)) {
    const path = relative(tmpdir(), root);
    if (path.startsWith('..') || !/^ia-mcp-(?:delivery|read)-/.test(path)) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
/** The runtime's delivery fixture (one plan, two milestones, five tasks) laid over the conformance corpus. */
function delivery(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mcp-delivery-'));
  temporary.push(root);
  for (const source of ['examples/conformance/native', 'packages/runtime/tests/fixtures/delivery/base'])
    cpSync(resolve(import.meta.dirname, '../../..', source), resolve(root, '.ia/src'), { recursive: true });
  return root;
}
const FOREIGN = 'governance-system/definition/procedure/foreign-procedure';
const spec = (name: string, source: string): string =>
  `\n@spec ${name}\n  meaning\n    says "The ${name} statement."\n  work\n    title "${name}"\n    status draft\n    source "${source}"\n`;
/**
 * The conformance corpus with a @playbook the agent system's folder cannot author, which admission refuses, and specs
 * whose documents lie under a junction to another directory and outside the workspace.
 */
function reading(): { readonly root: string; readonly target: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mcp-read-')),
    target = mkdtempSync(resolve(tmpdir(), 'ia-mcp-read-target-'));
  temporary.push(root, target);
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, '.ia/src'), {
    recursive: true,
  });
  writeFileSync(
    resolve(root, '.ia/src/systems/agent-system/records/foreign.ia'),
    '#! ia 1.0\n@playbook foreign-procedure\n  meaning\n    says "Foreign here."\n    answers "What is foreign?"\n  cognition\n    act\n      primary Decision\n      Decision means "Foreign."\n',
  );
  mkdirSync(resolve(root, '.ia/src/systems/work-system/records'), { recursive: true });
  writeFileSync(
    resolve(root, '.ia/src/systems/work-system/records/located.ia'),
    `#! ia 1.0\n${spec('linked-spec', 'linked/located.md')}${spec('escaping-spec', '../outside.md')}`,
  );
  writeFileSync(resolve(target, 'located.md'), '# Elsewhere\n');
  symlinkSync(target, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, target: realpathSync(target) };
}
it('negotiates the pinned profile, discovers twelve tools and enforces initialization order', () => {
  const value = protocol();
  expect(value.request(message(1, 'tools/list'))?.error?.code).toBe(-32000);
  expect(value.request(message(1, 'initialize', {}))?.error?.code).toBe(-32602);
  expect(
    value.request(
      message('init', 'initialize', {
        protocolVersion: 'future',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      }),
    ),
  ).toMatchObject({
    id: 'init',
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: 'ia-mcp-door',
        version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      },
    },
  });
  expect(value.request(message(2, 'tools/list'))?.error?.code).toBe(-32000);
  expect(value.request({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  const listed = value.request(message(3, 'tools/list'))?.result as {
    tools: { name: string; annotations: { readOnlyHint: boolean } }[];
  };
  // Plan amendment A3: the eight version 1 door tools, ia_read, ia_next and ia_position from protocol version 2, and
  // ia_vocabulary.
  expect(listed.tools).toHaveLength(12);
  expect(listed.tools.map((tool) => tool.name).slice(8, 11)).toEqual(['ia_read', 'ia_next', 'ia_position']);
  expect(listed.tools.at(-1)?.name).toBe('ia_vocabulary');
  expect(listed.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  expect(listed.tools.some((t) => t.name === 'ia_report')).toBe(false);
  expect(value.request(message(4, 'initialize'))?.error?.code).toBe(-32600);
});
it('returns exact door successes and refusals as matching text and structured tool content', () => {
  const value = protocol();
  initialize(value);
  const call = value.request(
    message(2, 'tools/call', {
      name: 'ia_context',
      arguments: { text: '', coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' } },
    }),
  )?.result as { content: { text: string }[]; structuredContent: unknown; isError: boolean };
  expect(call.isError).toBe(false);
  expect(JSON.parse(call.content[0]!.text)).toEqual(call.structuredContent);
  const bad = value.request(message(3, 'tools/call', { name: 'ia_records', arguments: { within: 'forged' } }))?.result;
  expect(bad).toMatchObject({ isError: true, structuredContent: { ok: false, code: 'IA-DB-SCOPE-UNAVAILABLE' } });
  expect(value.request(message(4, 'tools/call', { name: 'ia_report' }))?.error?.code).toBe(-32602);
});
const PROCEDURE = 'governance-system/definition/procedure/sample-procedure';
it('serves ia_read through the door: the body inside the scope a token names, and one plain refusal outside it', () => {
  const value = protocol();
  initialize(value);
  const call = (id: number, args: unknown) =>
    value.request(message(id, 'tools/call', { name: 'ia_read', arguments: args }))?.result as {
      content: { text: string }[];
      structuredContent: unknown;
      isError: boolean;
    };
  const cell = call(2, { locator: `${PROCEDURE}#act/Decision` });
  expect(cell.isError).toBe(false);
  expect(JSON.parse(cell.content[0]!.text)).toEqual(cell.structuredContent);
  expect(cell.structuredContent).toEqual({
    ok: true,
    result: {
      locator: `${PROCEDURE}#act/Decision`,
      identity: PROCEDURE,
      kind: 'record',
      digest: createHash('sha256').update('Sample fixture statement 18.').digest('hex'),
      body: 'Sample fixture statement 18.',
      certified: false,
    },
  });
  // A token ia_scope issued narrows later reads in the same server process; outside it nothing is named.
  const scope = value.request(message(3, 'tools/call', { name: 'ia_scope', arguments: { identities: [PROCEDURE] } }))
    ?.result as { structuredContent: { result: { token: string } } };
  const within = scope.structuredContent.result.token;
  expect(call(4, { within, locator: PROCEDURE }).isError).toBe(false);
  expect(call(5, { within, locator: 'agent-system/binding/agent/agent-steward' })).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-READ-UNADMITTED', message: 'The locator is not in this scope' },
  });
  expect(call(6, { locator: PROCEDURE, unlisted: 1 })).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' },
  });
});
it("names a refused record through ia_read on a whole-workspace scope only, and never the server's root", () => {
  const { root, target } = reading(),
    value = protocol(root);
  initialize(value);
  const call = (id: number, args: unknown) =>
    value.request(message(id, 'tools/call', { name: 'ia_read', arguments: args }))?.result as {
      content: { text: string }[];
      structuredContent: { ok: boolean; code?: string; message?: string; reason?: string };
      isError: boolean;
    };
  // db PT5: the server's initial scope is the whole workspace, so a record admission refused is named with its reason.
  const refused = call(2, { locator: FOREIGN });
  expect(refused).toMatchObject({
    isError: true,
    structuredContent: {
      ok: false,
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `${FOREIGN} is in this workspace's sources, but admission refused it`,
      path: '.ia/src/systems/agent-system/records/foreign.ia',
      file: 'refused',
      reason: expect.any(String),
    },
  });
  // A token ia_scope issued with identities, a phase or a root below the workspace root is narrower than the whole
  // workspace, so through it the same locator names nothing; one issued without narrowing is the whole workspace still.
  const token = (id: number, args: unknown) =>
    (
      value.request(message(id, 'tools/call', { name: 'ia_scope', arguments: args }))?.result as {
        structuredContent: { result: { token: string } };
      }
    ).structuredContent.result.token;
  expect(call(4, { within: token(3, { identities: [PROCEDURE] }), locator: FOREIGN }).structuredContent).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-UNADMITTED',
    message: 'The locator is not in this scope',
  });
  expect(call(6, { within: token(5, {}), locator: FOREIGN }).structuredContent).toEqual(refused.structuredContent);
  // A document under a junction and one outside the workspace are refused by their workspace-relative paths alone.
  for (const [id, name, cause] of [
    [7, 'linked-spec', /Symlink\/junction traversal is not admitted: linked\/located\.md$/],
    [8, 'escaping-spec', /, \.\.\/outside\.md, is outside the workspace$/],
  ] as const) {
    const got = call(id, { locator: `work-system/contract/spec/${name}` });
    expect(got, name).toMatchObject({ isError: true, structuredContent: { code: 'IA-RUNTIME-READ-UNREACHABLE' } });
    expect(got.structuredContent.message, name).toMatch(cause);
    for (const directory of [root, realpathSync(root), target])
      for (const spelling of [directory, directory.replaceAll('\\', '/'), basename(directory)])
        expect(got.content[0]!.text, `${name} ${spelling}`).not.toContain(spelling);
  }
});
it('serves ia_position through the door: body(K) as runtime position reads it, and a key refusal naming its next command', () => {
  const value = protocol();
  initialize(value);
  const call = (id: number, args: unknown) =>
    value.request(message(id, 'tools/call', { name: 'ia_position', arguments: args }))?.result as {
      content: { text: string }[];
      structuredContent: unknown;
      isError: boolean;
    };
  const db = openDatabase(fixture, { cache: false });
  try {
    // K0 and a governance key, byte for byte what runtime position returns through the whole workspace's scope.
    for (const [id, key] of [
      [2, {}],
      [3, { seat: PROCEDURE, shape: 'governance' }],
    ] as const) {
      const got = call(id, key);
      expect(got.isError).toBe(false);
      expect(got.content[0]!.text).toBe(JSON.stringify(got.structuredContent));
      expect(got.content[0]!.text).toBe(
        JSON.stringify({ ok: true, result: position(db, db.resolveScope().token, key) }),
      );
    }
    // A token ia_scope issued narrows the position in the same server process.
    const scope = value.request(message(4, 'tools/call', { name: 'ia_scope', arguments: { identities: [PROCEDURE] } }))
      ?.result as { structuredContent: { result: { token: string } } };
    const key = { seat: PROCEDURE, shape: 'governance' } as const;
    expect(call(5, { ...key, within: scope.structuredContent.result.token }).content[0]!.text).toBe(
      JSON.stringify({ ok: true, result: position(db, db.resolveScope({ identities: [PROCEDURE] }).token, key) }),
    );
  } finally {
    db.close();
  }
  // A refusal of the key carries the one command to run; the Door's own refusal of a parameter keeps three keys.
  expect(call(6, { depth: 3 })).toEqual({
    content: [{ type: 'text', text: expect.stringContaining('"next":"ia position --depth 2"') }],
    structuredContent: {
      ok: false,
      code: 'IA-RUNTIME-REQUEST-INVALID',
      message: 'IA-RUNTIME-REQUEST-INVALID: Scope key depth must be an integer in 0..2',
      next: 'ia position --depth 2',
    },
    isError: true,
  });
  expect(call(7, { text: 'what governs billing' }).structuredContent).toEqual({
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message:
      "IA-RUNTIME-REQUEST-INVALID: Unknown parameter 'text'; admitted: within, seat, shape, phase, depth, budget, word",
  });
});
it("serves ia_next through the door: one plan's delivery view inside the scope, and a refusal naming its next command", () => {
  const value = protocol(delivery());
  initialize(value);
  const call = (id: number, args: unknown, on = value) =>
    on.request(message(id, 'tools/call', { name: 'ia_next', arguments: args }))?.result as {
      content: { text: string }[];
      structuredContent: { ok: boolean; result?: { plan: string; tasks: { identity: string }[] } };
      isError: boolean;
    };
  const plan = 'work-system/definition/plan/release',
    task = (name: string) => `work-system/definition/task/${name}`;
  const view = call(2, {});
  expect(view.isError).toBe(false);
  expect(JSON.parse(view.content[0]!.text)).toEqual(view.structuredContent);
  expect(view.structuredContent).toMatchObject({
    ok: true,
    result: { format: 'ia.delivery-view.v1', plan, next: `ia position --seat ${task('guide')} --shape sequence` },
  });
  expect(view.structuredContent.result!.tasks.map((t) => t.identity)).toEqual(
    ['guide', 'schema', 'examples', 'package', 'release-notes'].map(task),
  );
  expect(call(3, { seat: task('package') }).structuredContent).toEqual(view.structuredContent);
  // A token ia_scope issued narrows the view in the same server process.
  const scope = value.request(
    message(4, 'tools/call', { name: 'ia_scope', arguments: { identities: [plan, task('schema')] } }),
  )?.result as { structuredContent: { result: { token: string } } };
  expect(call(5, { within: scope.structuredContent.result.token, seat: plan })).toMatchObject({
    isError: false,
    structuredContent: { ok: true, result: { plan, milestones: [], tasks: [] } },
  });
  // A version 2 refusal carries the one command deliveryView names; the loop fixture authors no plan.
  const loop = protocol();
  initialize(loop);
  expect(call(6, {}, loop)).toMatchObject({
    isError: true,
    structuredContent: {
      ok: false,
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      message: 'No admitted @plan at authored placement (band 100) in this scope',
      next: 'ia next --help',
    },
  });
  expect(call(7, { seat: plan, unlisted: 1 })).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' },
  });
});
// Decision conditional-relations-in-delivery: ia_next reads a conditional row against the phase its token binds, and
// ia_position against its key's phase, as the Door does.
it('reads a conditional row through ia_next and ia_position at the phase the token or the key binds', () => {
  const root = delivery(),
    path = resolve(root, '.ia/src/work.ia');
  writeFileSync(
    path,
    readFileSync(path, 'utf8')
      .replace('    grounds @task guide\n', '    grounds @task guide when phase is act\n')
      .replace('    requires @task guide\n', '    requires @task guide when phase is act\n'),
  );
  const value = protocol(root);
  initialize(value);
  const call = (id: number, name: string, args: unknown) =>
    (value.request(message(id, 'tools/call', { name, arguments: args }))?.result as { structuredContent: unknown })
      .structuredContent as { ok: boolean; result: Record<string, unknown> };
  const guide = 'work-system/definition/task/guide',
    notes = 'work-system/definition/task/release-notes';
  const intent = (view: Record<string, unknown>) =>
    (view['tasks'] as { identity: string; states: { dimension: string; value: string; basis: string }[] }[])
      .find((task) => task.identity === guide)!
      .states.find((line) => line.dimension === 'intent')!;
  // The initial token binds no phase: the conditional grounding is undecided, never accepted.
  expect(intent(call(2, 'ia_next', {}).result)).toMatchObject({
    value: 'unknown',
    basis: expect.stringContaining('conditional on phase is act'),
  });
  let id = 3;
  for (const phase of ['orient', 'act'] as const) {
    const token = call(id++, 'ia_scope', { phase }).result['token'];
    expect(intent(call(id++, 'ia_next', { within: token }).result).value, phase).toBe(
      phase === 'act' ? 'accepted' : 'unknown',
    );
    const body = call(id++, 'ia_position', { seat: notes, shape: 'sequence', phase }).result['body'] as {
      loaded: { identity?: string }[];
    };
    expect(
      body.loaded.some((entry) => entry.identity === guide),
      phase,
    ).toBe(phase === 'act');
  }
});
it('names a record admission refused through ia_next on the initial whole-workspace scope only', () => {
  const root = delivery(),
    migrate = 'work-system/definition/task/migrate';
  writeFileSync(
    resolve(root, '.ia/src/migrate.ia'),
    '#! ia 1.0\n\n@task migrate\n  meaning\n    says "Migrate the fixture data."\n  work\n    title "Migrate"\n    status bogus\n    milestone @milestone foundation\n',
  );
  const value = protocol(root);
  initialize(value);
  const call = (id: number, name: string, args: unknown) =>
    (
      value.request(message(id, 'tools/call', { name, arguments: args }))?.result as {
        structuredContent: { result: { token?: string; review?: { kind: string; records: string[] }[] } };
      }
    ).structuredContent.result;
  expect(call(2, 'ia_next', {}).review).toMatchObject([{ kind: 'admission', records: [migrate] }]);
  // db PT5: a token ia_scope issued with identities is narrower than the whole workspace, so its view names no refused
  // record.
  const { token } = call(3, 'ia_scope', { identities: ['work-system/definition/plan/release'] });
  expect(call(4, 'ia_next', { within: token }).review).toEqual([]);
});
it('rejects malformed framing/envelopes/parameters and unknown methods while ignoring notifications', () => {
  const value = protocol();
  expect(value.line('{')?.error?.code).toBe(-32700);
  for (const input of [
    [],
    null,
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { jsonrpc: '2.0', id: 1.5, method: 'ping' },
  ])
    expect(value.request(input)?.error?.code).toBe(-32600);
  expect(value.request(message(0, 'ping', null))?.error?.code).toBe(-32602);
  initialize(value);
  expect(value.request(message(2, 'invented'))?.error?.code).toBe(-32601);
  expect(value.request(message(3, 'tools/list', { cursor: 'not-issued' }))?.error?.code).toBe(-32602);
  expect(value.request(message(4, 'tools/call', { name: 'ia_scope', arguments: [] }))?.error?.code).toBe(-32602);
  expect(value.request({ jsonrpc: '2.0', method: 'notifications/unknown' })).toBeUndefined();
  expect(value.request(message('ping', 'ping'))).toEqual({ jsonrpc: '2.0', id: 'ping', result: {} });
});
it('contains an unexpected adapter failure and refuses use after closure', () => {
  const value = protocol();
  initialize(value);
  vi.spyOn(Door.prototype, 'request').mockImplementationOnce(() => {
    throw new Error('unexpected fixture failure');
  });
  expect(value.request(message(2, 'tools/call', { name: 'ia_scope' }))?.error?.code).toBe(-32603);
  value.close();
  expect(value.request(message(3, 'ping'))?.error?.code).toBe(-32000);
});
it('compacts diagnostics without changing delivered obligations or scope, and preserves refusals', () => {
  const value = protocol();
  initialize(value);
  const arguments_ = {
    text: 'review',
    coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
    budget: { tokens: 4000, records: 50 },
  };
  const call = (format: string, extra = {}) =>
    value.request(message(2, 'tools/call', { name: 'ia_context', arguments: { ...arguments_, ...extra, format } }));
  const full = call('full')?.result as {
    structuredContent: { ok: true; result: import('@inventarch/runtime').Packet };
  };
  const compact = call('compact')?.result as {
    content: { text: string }[];
    structuredContent: {
      ok: true;
      result: { included: unknown[]; omissions: { total: number }; limits: { tokensUsed: number } };
    };
  };
  expect(compact.structuredContent.ok).toBe(true);
  expect(compact.structuredContent.result.included).toEqual(
    full.structuredContent.result.included.map(({ band: _band, score: _score, why: _why, ...entry }) => entry),
  );
  expect(compact.structuredContent.result.omissions.total).toBe(full.structuredContent.result.omitted.length);
  expect(compact.structuredContent.result.limits.tokensUsed).toBe(full.structuredContent.result.limits.tokensUsed);
  expect(JSON.parse(compact.content[0]!.text)).toEqual(compact.structuredContent);
  expect(call('compact', { within: 'forged' })?.result).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-DB-SCOPE-UNAVAILABLE' },
  });
  expect(call('invented')?.error?.code).toBe(-32602);
});
it('answers ia_vocabulary from the shipped catalogue with door-shaped successes and refusals', () => {
  const value = protocol();
  initialize(value);
  const call = (id: number, args: unknown) =>
    value.request(message(id, 'tools/call', { name: 'ia_vocabulary', arguments: args }))?.result as {
      content: { text: string }[];
      structuredContent: {
        ok: boolean;
        code?: string;
        result?: { words: { word: string; schema: Record<string, unknown> }[] };
      };
      isError: boolean;
    };
  const one = call(2, { word: '@playbook', schema: true });
  expect(one.isError).toBe(false);
  expect(JSON.parse(one.content[0]!.text)).toEqual(one.structuredContent);
  expect(one.structuredContent.result?.words.map((word) => word.word)).toEqual(['playbook']);
  expect(one.structuredContent.result?.words[0]?.schema).toHaveProperty('fields');
  expect(call(3, { word: 'playbook' }).structuredContent.result?.words[0]?.schema).not.toHaveProperty('fields');
  expect(call(4, { word: 'invented-word' })).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-VOCABULARY-UNKNOWN-WORD' },
  });
  for (const bad of [
    { within: 'token' },
    { word: 3 },
    { schema: 'yes' },
    { domain: 'taxonomy' },
    { search: 'x'.repeat(257) },
    { kind: Array.from({ length: 65 }, () => 'law') },
  ])
    expect(call(5, bad)).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID' },
    });
});
// spec-0012 DRF-04: tools/list is the table's projection, plus only the documented MCP parts.
it('serves the door operations as the machine protocol table describes them', () => {
  const value = protocol();
  initialize(value);
  const listed = value.request(message(2, 'tools/list'))?.result as {
    tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[];
  };
  const tools = listed.tools;
  const served = MACHINE_PROTOCOL.operations.filter((operation) => operation.mcp !== null);
  expect(tools.map((tool) => tool.name)).toEqual([...served.map((operation) => operation.mcp), 'ia_vocabulary']);
  expect(
    MACHINE_PROTOCOL.operations.filter((operation) => operation.mcp === null).map((operation) => operation.name),
  ).toEqual(['report']);
  for (const operation of served) {
    const tool = tools.find((candidate) => candidate.name === operation.mcp)!;
    expect(tool.description.startsWith(operation.description), operation.name).toBe(true);
    const { format, ...properties } = tool.inputSchema.properties;
    // M04a: format is the one transport-only parameter, and only ia_context takes it.
    expect(format !== undefined, operation.name).toBe(operation.name === 'context');
    expect({ ...tool.inputSchema, properties }, operation.name).toEqual(operation.params);
  }
});
