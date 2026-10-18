import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Protocol, PROTOCOL_VERSION } from '../src/protocol.js';
const roots: string[] = [],
  servers: Protocol[] = [];
afterEach(() => {
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
function fixture() {
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
  expect(denied).toMatchObject({ ok: false });
  expect(JSON.stringify(denied)).not.toContain(HIDDEN);
  expect(call('ia_kb_read', { within: 'forged', locator: ID })).toMatchObject({ ok: false });
  expect(call('ia_kb_search', { query: 'x', root: 'elsewhere' })).toMatchObject({ ok: false });
  expect(existsSync(join(root, '.kb'))).toBe(false);
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
