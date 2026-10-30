import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Door } from '@inventarch/runtime';
import { captureKnowledge, LIMITS, selectableKnowledgeRecord } from '@inventarch/kb';
import { readWorkspaceBytes } from '@inventarch/db';
import { knowledgeTool, MEMBERSHIP } from '../src/kb.js';
import { Protocol, PROTOCOL_VERSION } from '../src/protocol.js';
vi.mock('../src/kb.js', { spy: true });
vi.mock('@inventarch/db', { spy: true });
const roots: string[] = [],
  servers: Protocol[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const s of servers.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const ID = 'work-system/contract/spec/alpha',
  HIDDEN = 'work-system/contract/spec/hidden';
it('bounds the complete JSON-RPC knowledge response including escaped text and request id', () => {
  const { root, server } = fixture();
  writeFileSync(join(root, 'alpha.md'), 'x'.repeat(25 * 1024));
  const result = server.request({
    jsonrpc: '2.0',
    id: 'bounded',
    method: 'tools/call',
    params: { name: 'ia_kb_read', arguments: { locator: ID } },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024);
});
it('truncates search against the complete duplicated MCP envelope', () => {
  const { server } = fixture(45);
  const response = server.request({
    jsonrpc: '2.0',
    id: 'search',
    method: 'tools/call',
    params: { name: 'ia_kb_search', arguments: { query: 'search-bound' } },
  });
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(48 * 1024);
  expect(response?.result).toMatchObject({
    isError: false,
    structuredContent: { ok: true, value: { truncated: true } },
  });
  const content = response?.result as { structuredContent: { value: { results: unknown[] } } };
  expect(content.structuredContent.value.results.length).toBeGreaterThan(0);
});
function fixture(extra = 0) {
  const root = mkdtempSync(join(tmpdir(), 'ia-kb-mcp-'));
  roots.push(root);
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), join(root, '.ia/src'), {
    recursive: true,
  });
  mkdirSync(join(root, '.ia/src/knowledge'), { recursive: true });
  for (const name of ['alpha', 'hidden']) {
    writeFileSync(
      join(root, '.ia/src/knowledge', name + '.ia'),
      '#! ia 1.0\n@spec ' +
        name +
        '\n  meaning\n    says "' +
        name +
        '."\n  work\n    title "' +
        name +
        '"\n    status draft\n    source "' +
        name +
        '.md"\n',
    );
    writeFileSync(join(root, name + '.md'), name + ' document-only term');
  }
  if (extra)
    writeFileSync(
      join(root, '.ia/src/knowledge/many.ia'),
      '#! ia 1.0\n' +
        Array.from(
          { length: extra },
          (_, i) =>
            '@spec match-' +
            i +
            '\n  meaning\n    says "search-bound ' +
            'x'.repeat(220) +
            '"\n  work\n    title "Match"\n    status draft\n',
        ).join('\n'),
    );
  const server = new Protocol(root);
  servers.push(server);
  server.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  server.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  let id = 2;
  const call = (name: string, args: unknown = {}) =>
    (
      server.request({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })?.result as {
        structuredContent: Record<string, any>;
      }
    )?.structuredContent;
  return { root, server, call };
}
it('adds five read tools and restricts body reads to original Door membership', () => {
  const { root, server, call } = fixture();
  const tools = server.request({ jsonrpc: '2.0', id: 90, method: 'tools/list' })?.result as {
    tools: { name: string }[];
  };
  expect(tools.tools.filter((t) => t.name.startsWith('ia_kb_')).map((t) => t.name)).toEqual([
    'ia_kb_check',
    'ia_kb_search',
    'ia_kb_read',
    'ia_kb_resolve',
    'ia_kb_traverse',
  ]);
  const within = call('ia_scope', { identities: [ID] })['result'].token;
  expect(call('ia_kb_search', { within, query: 'alpha document-only' })).toMatchObject({
    ok: true,
    value: { results: [{ identity: ID }] },
  });
  expect(call('ia_kb_search', { within, query: 'hidden document-only' })).toMatchObject({
    ok: true,
    value: { results: [] },
  });
  const denied = call('ia_kb_read', { within, locator: HIDDEN });
  expect(denied).toMatchObject({ ok: false, error: { code: 'IA-KB-UNAVAILABLE' } });
  expect(JSON.stringify(denied)).not.toContain(HIDDEN);
  expect(call('ia_kb_read', { within: 'forged', locator: ID })).toMatchObject({ ok: false });
  expect(call('ia_kb_search', { query: 'x', root: 'elsewhere' })).toMatchObject({ ok: false });
  expect(existsSync(join(root, '.kb'))).toBe(false);
});
it('refuses a body excluded by the persisted resource selection without reading it', () => {
  const { root, call } = fixture();
  const select = (resources: string[]) =>
    writeFileSync(
      join(root, '.ia/knowledge.json'),
      JSON.stringify({
        format: 'ia.kb.selection.v1',
        sourceId: 'workspace',
        records: [ID],
        resources,
      }),
    );
  select(['alpha.md']);
  vi.mocked(readWorkspaceBytes).mockClear();
  expect(call('ia_kb_read', { locator: ID })).toMatchObject({ ok: true });
  expect(readWorkspaceBytes).toHaveBeenCalledWith(root, 'alpha.md', LIMITS.fileBytes);
  select([]);
  vi.mocked(readWorkspaceBytes).mockClear();
  expect(call('ia_kb_read', { locator: ID })).toMatchObject({ ok: false, error: { code: 'IA-KB-UNAVAILABLE' } });
  expect(vi.mocked(readWorkspaceBytes).mock.calls.some(([, path]) => path === 'alpha.md')).toBe(false);
});
it.each(['{}', '{'])('rejects invalid persisted selection %s before reading body resources', (selection) => {
  const { root, call } = fixture();
  writeFileSync(join(root, '.ia/knowledge.json'), selection);
  vi.mocked(readWorkspaceBytes).mockClear();
  expect(call('ia_kb_read', { locator: ID })).toMatchObject({ ok: false, error: { code: 'IA-KB-INVALID' } });
  expect(vi.mocked(readWorkspaceBytes).mock.calls.some(([, path]) => path === 'alpha.md' || path === 'hidden.md')).toBe(
    false,
  );
});
it('budgets the persisted selection inside Door membership, not every authored record', () => {
  const { root, call } = fixture(1001);
  writeFileSync(
    join(root, '.ia/knowledge.json'),
    JSON.stringify({
      format: 'ia.kb.selection.v1',
      sourceId: 'workspace',
      records: [ID],
      resources: ['alpha.md'],
    }),
  );
  expect(captureKnowledge(root).records.map((record) => record.identity)).toEqual([ID]);
  expect(call('ia_kb_read', { locator: ID })).toMatchObject({ ok: true, value: { identity: ID } });
  const within = call('ia_scope', { identities: [HIDDEN] })['result'].token;
  expect(call('ia_kb_read', { within, locator: ID })).toMatchObject({
    ok: false,
    error: { code: 'IA-KB-UNAVAILABLE' },
  });
});
it('refuses a stale citation and a native scope whose graph changed', () => {
  const { root, call } = fixture(),
    within = call('ia_scope', { identities: [ID] })['result'].token;
  const citation = call('ia_kb_read', { within, locator: ID })['value'].citation;
  writeFileSync(join(root, 'alpha.md'), 'Changed body');
  expect(call('ia_kb_resolve', { within, citation })).toMatchObject({
    ok: false,
    error: { code: 'IA-KB-SNAPSHOT-UNAVAILABLE' },
  });
  writeFileSync(
    join(root, '.ia/src/knowledge/alpha.ia'),
    '#! ia 1.0\n@spec alpha\n  meaning\n    says "Changed graph."\n  work\n    title "Alpha"\n    status draft\n',
  );
  expect(call('ia_kb_read', { within, locator: ID })).toMatchObject({ ok: false });
});
it('answers an id too long for any bounded knowledge response with that id, before reading', () => {
  const { server, call } = fixture(),
    id = 'i'.repeat(60000);
  vi.mocked(knowledgeTool).mockClear();
  expect(call('ia_kb_check')).toMatchObject({ ok: true });
  expect(knowledgeTool).toHaveBeenCalledTimes(1);
  vi.mocked(knowledgeTool).mockClear();
  const response = server.request({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'ia_kb_check', arguments: {} },
  });
  expect(response).toMatchObject({ id, error: { code: -32600 } });
  expect(knowledgeTool).not.toHaveBeenCalled();
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(LIMITS.responseBytes);
});
it('refuses an oversized knowledge response with the bounded refusal and the original id', () => {
  const { root, server } = fixture();
  writeFileSync(join(root, 'alpha.md'), 'x'.repeat(30 * 1024));
  const response = server.request({
    jsonrpc: '2.0',
    id: 'over',
    method: 'tools/call',
    params: { name: 'ia_kb_read', arguments: { locator: ID } },
  });
  expect(response).toMatchObject({
    id: 'over',
    result: { isError: true, structuredContent: { error: { code: 'IA-KB-RESPONSE-LIMIT' } } },
  });
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(LIMITS.responseBytes);
});
/** Membership as the tool sees it: every record in scope, and the authored records capture can select. */
function membership(root: string) {
  const door = new Door(root, { cache: false });
  try {
    const records = (door.request({ operation: 'records', params: {} }) as { result: { records: any[] } }).result
      .records;
    const authored = records.filter((record) => selectableKnowledgeRecord(record));
    return { total: records.length, authored };
  } finally {
    door.close();
  }
}
it('pins the membership budget', () => {
  expect(MEMBERSHIP).toEqual({ records: 5000, bytes: 40 * 1024 * 1024 });
});
it('counts only selectable authored records against the membership record budget', () => {
  const { root } = fixture(),
    { total, authored } = membership(root);
  // Floor records are in the Door's membership but never selectable, so they spend no budget.
  expect(total).toBeGreaterThan(authored.length);
  const write = (count: number) =>
    writeFileSync(
      join(root, '.ia/src/knowledge/many.ia'),
      '#! ia 1.0\n' +
        Array.from(
          { length: count },
          (_, i) => '@spec budget-' + i + '\n  meaning\n    says "Budget."\n  work\n    title "B"\n    status draft\n',
        ).join('\n'),
    );
  const check = () => {
    const door = new Door(root, { cache: false });
    try {
      return knowledgeTool(root, door, 'check', {});
    } finally {
      door.close();
    }
  };
  write(MEMBERSHIP.records - authored.length);
  expect(membership(root).authored).toHaveLength(MEMBERSHIP.records);
  expect(check()).toMatchObject({ ok: true });
  write(MEMBERSHIP.records - authored.length + 1);
  expect(check()).toMatchObject({ ok: false, error: { code: 'IA-KB-SCOPE-LIMIT' } });
}, 120000);
it('admits authored membership of exactly the byte budget and refuses one byte less of budget', () => {
  const { root } = fixture(),
    bytes = Buffer.byteLength(JSON.stringify(membership(root).authored)),
    door = new Door(root, { cache: false });
  try {
    expect(knowledgeTool(root, door, 'check', {}, { records: MEMBERSHIP.records, bytes })).toMatchObject({ ok: true });
    expect(knowledgeTool(root, door, 'check', {}, { records: MEMBERSHIP.records, bytes: bytes - 1 })).toMatchObject({
      ok: false,
      error: { code: 'IA-KB-SCOPE-LIMIT' },
    });
  } finally {
    door.close();
  }
});
