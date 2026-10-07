import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Door, MACHINE_PROTOCOL } from '@inventarch/runtime';
import { Protocol, PROTOCOL_VERSION } from '../src/protocol.js';

const fixture = resolve(import.meta.dirname, '../../../packages/compliance/fixtures/loop'),
  instances: Protocol[] = [];
const message = (id: number | string, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
function protocol() {
  const value = new Protocol(fixture);
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
  vi.restoreAllMocks();
});
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
  // Eleven door operations (the eight version-1 ones served here, then ia_position, ia_read and ia_next) and
  // ia_vocabulary.
  expect(listed.tools).toHaveLength(12);
  expect(listed.tools.slice(-4).map((tool) => tool.name)).toEqual([
    'ia_position',
    'ia_read',
    'ia_next',
    'ia_vocabulary',
  ]);
  expect(listed.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  expect(listed.tools.some((t) => t.name === 'ia_report')).toBe(false);
  expect(value.request(message(4, 'initialize'))?.error?.code).toBe(-32600);
});
it('serves ia_position and ia_read as the Door answers them, refusals with their next action', () => {
  const value = protocol();
  initialize(value);
  const door = new Door(fixture, { cache: false });
  try {
    let id = 2;
    const call = (name: string, args: Record<string, unknown>) =>
      value.request(message(id++, 'tools/call', { name, arguments: args }))?.result as {
        content: { type: string; text: string }[];
        structuredContent: Record<string, unknown>;
        isError: boolean;
      };
    const position = call('ia_position', { shape: 'context', phase: 'orient' });
    expect(position.isError).toBe(false);
    expect(JSON.parse(position.content[0]!.text)).toEqual(position.structuredContent);
    const expected = door.request({ operation: 'position', params: { shape: 'context', phase: 'orient' } });
    if (!expected.ok) throw new Error(expected.message);
    const result = position.structuredContent['result'] as Record<string, unknown>;
    expect(result['body']).toEqual((expected.result as Record<string, unknown>)['body']);
    // The MCP door has no CLI and reads no installed state: those host facts are null.
    expect(result['hostNote']).toMatchObject({ cli: null, adapter: null, installedStateDigest: null });
    const locator = MACHINE_PROTOCOL.operations.find((operation) => operation.name === 'read')!.example;
    expect(call('ia_read', locator)).toMatchObject({
      isError: false,
      structuredContent: door.request({ operation: 'read', params: locator }),
    });
    expect(call('ia_read', {})).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID', next: expect.any(String) },
    });
    expect(call('ia_position', { depth: 3 })).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID', next: expect.any(String) },
    });
    // A scope issued by ia_scope narrows a later position in the same server process.
    const scope = call('ia_scope', { identities: [locator['locator']] }).structuredContent['result'] as {
      token: string;
    };
    expect(call('ia_position', { within: scope.token, seat: locator['locator'] })).toMatchObject({
      isError: false,
      structuredContent: { ok: true, result: { body: { seat: { identity: locator['locator'] } } } },
    });
  } finally {
    door.close();
  }
});
it('serves ia_next as the Door answers it, a refusal with the next command for its cause', () => {
  // The loop fixture holds no plan: the view is refused with its cause's own next command.
  const loop = protocol();
  initialize(loop);
  expect(loop.request(message(2, 'tools/call', { name: 'ia_next', arguments: {} }))?.result).toMatchObject({
    isError: true,
    structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID', next: 'ia vocabulary plan --example' },
  });
  // A copy of the conformance corpus with this repository's work records holds one plan.
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mcp-next-')),
    work = '.ia/src/systems/work-system/records/work.ia',
    repository = resolve(import.meta.dirname, '../../..');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  mkdirSync(resolve(root, work, '..'), { recursive: true });
  cpSync(resolve(repository, work), resolve(root, work));
  const value = new Protocol(root);
  instances.push(value);
  initialize(value);
  const door = new Door(root, { cache: false });
  try {
    const got = value.request(message(3, 'tools/call', { name: 'ia_next', arguments: {} }))?.result as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
      isError: boolean;
    };
    expect(got.isError).toBe(false);
    expect(JSON.parse(got.content[0]!.text)).toEqual(got.structuredContent);
    expect(got.structuredContent).toEqual(door.request({ operation: 'next', params: {} }));
    expect(got.structuredContent).toMatchObject({
      ok: true,
      result: { seat: { identity: 'work-system/definition/plan/example-plan', word: 'plan' } },
    });
    expect(
      value.request(message(4, 'tools/call', { name: 'ia_next', arguments: { unlisted: 1 } }))?.result,
    ).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'IA-RUNTIME-REQUEST-INVALID', next: expect.any(String) },
    });
  } finally {
    door.close();
    rmSync(root, { recursive: true, force: true });
  }
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
