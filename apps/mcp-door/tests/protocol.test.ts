import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Door, MACHINE_PROTOCOL } from '@inventarch/runtime';
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
    if (path.startsWith('..') || !path.startsWith('ia-mcp-delivery-')) throw new Error('Unsafe test cleanup');
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
it('negotiates the pinned profile, discovers eleven tools and enforces initialization order', () => {
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
  // Plan amendment A3: the eight version 1 door tools, ia_read and ia_next from protocol version 2, and ia_vocabulary.
  expect(listed.tools).toHaveLength(11);
  expect(listed.tools.map((tool) => tool.name)).toContain('ia_read');
  expect(listed.tools.map((tool) => tool.name)).toContain('ia_next');
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
  // db PT5: a token ia_scope issued is never the whole workspace, so its view names no refused record.
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
