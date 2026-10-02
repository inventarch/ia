import { Door } from '@ia/runtime';
import { OPERATIONS, TOOLS } from './tools.js';
import { compactContext } from './presentation.js';
import { vocabulary } from './vocabulary.js';

export const PROTOCOL_VERSION = '2025-11-25';
type Id = string | number | null;
export interface Response {
  readonly jsonrpc: '2.0';
  readonly id: Id;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}
export const rpcError = (id: Id, code: number, message: string): Response => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export class Protocol {
  #door: Door;
  #state: 'new' | 'negotiated' | 'ready' | 'closed' = 'new';
  constructor(root: string) {
    this.#door = new Door(root, { cache: false });
  }
  line(line: string): Response | undefined {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }
    return this.request(message);
  }
  request(message: unknown): Response | undefined {
    if (!object(message) || message['jsonrpc'] !== '2.0' || typeof message['method'] !== 'string')
      return rpcError(null, -32600, 'Invalid JSON-RPC request');
    const id = message['id'];
    if (id !== undefined && typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id)))
      return rpcError(null, -32600, 'Request id must be a string or integer');
    const method = message['method'],
      params = message['params'] === undefined ? {} : message['params'];
    if (id === undefined) {
      if (method === 'notifications/initialized' && this.#state === 'negotiated' && object(params))
        this.#state = 'ready';
      return undefined;
    }
    const requestId = id as string | number;
    const success = (result: unknown): Response => ({ jsonrpc: '2.0', id: requestId, result });
    if (this.#state === 'closed') return rpcError(requestId, -32000, 'Server is closed');
    if (!object(params)) return rpcError(requestId, -32602, 'Parameters must be an object');
    try {
      if (method === 'ping') return success({});
      if (method === 'initialize') {
        if (this.#state !== 'new') return rpcError(requestId, -32600, 'Server was already initialized');
        if (
          typeof params['protocolVersion'] !== 'string' ||
          params['protocolVersion'].length === 0 ||
          !object(params['capabilities']) ||
          !object(params['clientInfo']) ||
          typeof params['clientInfo']['name'] !== 'string' ||
          typeof params['clientInfo']['version'] !== 'string'
        )
          return rpcError(
            requestId,
            -32602,
            'initialize requires protocolVersion, capabilities and clientInfo name/version',
          );
        this.#state = 'negotiated';
        return success({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ia-mcp-door', version: '1.0.0' },
          instructions:
            'Declare phase and primitive for context/selection. Scope tokens live only in this server process. These tools read; selection grants no execution permission.',
        });
      }
      if (this.#state !== 'ready')
        return rpcError(requestId, -32000, 'Initialize and send notifications/initialized before using tools');
      if (method === 'tools/list') {
        if (params['cursor'] !== undefined)
          return rpcError(requestId, -32602, 'No pagination cursor is issued by this server');
        return success({ tools: TOOLS });
      }
      if (method === 'tools/call') {
        const name = params['name'],
          operation = typeof name === 'string' ? OPERATIONS.get(name) : undefined;
        if (operation === undefined) return rpcError(requestId, -32602, 'Unknown tool name');
        if (params['arguments'] !== undefined && !object(params['arguments']))
          return rpcError(requestId, -32602, 'Tool arguments must be an object');
        const args = { ...((params['arguments'] as Record<string, unknown> | undefined) ?? {}) };
        const format = operation === 'context' ? args['format'] : undefined;
        if (format !== undefined && format !== 'full' && format !== 'compact')
          return rpcError(requestId, -32602, 'context format must be full or compact');
        if (operation === 'context') delete args['format'];
        const raw = operation === 'vocabulary' ? vocabulary(args) : this.#door.request({ operation, params: args });
        const result = format === 'compact' ? compactContext(raw) : raw;
        return success({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: !result.ok,
        });
      }
      return rpcError(requestId, -32601, `Unknown method '${method}'`);
    } catch {
      return rpcError(requestId, -32603, 'Internal protocol error');
    }
  }
  close(): void {
    this.#state = 'closed';
    this.#door.close();
  }
}
