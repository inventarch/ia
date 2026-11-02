import { readFileSync } from 'node:fs';
import { Door } from '@inventarch/runtime';
import type { DoorResponse } from '@inventarch/runtime';
import { OPERATIONS, TOOLS } from './tools.js';
import { compactContext } from './presentation.js';
import { vocabulary } from './vocabulary.js';
import { knowledgeTool } from './kb.js';
import type { KnowledgeOperation } from '@inventarch/kb/protocol';
import { LIMITS } from '@inventarch/kb';
import { MethodTools } from './method.js';
import type { MethodHost, MethodOperation } from './method.js';

export const PROTOCOL_VERSION = '2025-11-25';
const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
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
  #root: string;
  /** The workspace Door, or undefined when the workspace does not open yet (a fresh clone needs `ia restore`). */
  #door: Door | undefined;
  #unopened: Error | undefined;
  #method: MethodTools;
  #state: 'new' | 'negotiated' | 'ready' | 'closed' = 'new';
  constructor(root: string, options: Omit<MethodHost, 'root'> = {}) {
    this.#root = root;
    // A workspace whose installation needs restoring does not open, yet the method tools still serve it, so ia_session
    // can say to run ia restore; the read tools answer that same refusal until it is restored.
    try {
      this.#door = new Door(root, { cache: false });
    } catch (error) {
      this.#unopened = error instanceof Error ? error : new Error(String(error));
    }
    this.#method = new MethodTools({ root, ...options });
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
          serverInfo: { name: 'ia-mcp-door', version: PACKAGE_VERSION },
          instructions:
            'Declare phase and primitive for context/selection. Scope tokens live only in this server process. These tools read; selection grants no execution permission. Start a session with ia_session, list a lane with ia_catalogue and resolve one key with ia_method; those three write only under the IA home.',
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
        if (operation.startsWith('method:')) {
          const answer = this.#method.call(operation as MethodOperation, args);
          return success({
            content: [{ type: 'text', text: JSON.stringify(answer.value) }],
            structuredContent: answer.value,
            isError: !answer.ok,
          });
        }
        if (this.#door === undefined) {
          const reason = this.#unopened as (Error & { code?: string }) | undefined;
          const value = {
            version: 1,
            ok: false,
            error: {
              code: reason?.code ?? 'IA-DB-SOURCE-UNAVAILABLE',
              message: reason?.message ?? 'workspace unavailable',
            },
          };
          return success({
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: true,
          });
        }
        const door = this.#door;
        const format = operation === 'context' ? args['format'] : undefined;
        if (format !== undefined && format !== 'full' && format !== 'compact')
          return rpcError(requestId, -32602, 'context format must be full or compact');
        if (operation === 'context') delete args['format'];
        const knowledge = operation.startsWith('kb:'),
          size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
        const refusal = {
          version: 1,
          ok: false,
          error: {
            code: 'IA-KB-RESPONSE-LIMIT',
            message: 'Knowledge transport response exceeds 48 KiB; narrow the request',
          },
        };
        const bounded = success({
          content: [{ type: 'text', text: JSON.stringify(refusal) }],
          structuredContent: refusal,
          isError: true,
        });
        // An id too long for even the bounded refusal is refused before any work, still answering that id.
        if (knowledge && size(bounded) > LIMITS.responseBytes)
          return rpcError(requestId, -32600, 'Knowledge request id exceeds response budget');
        const raw = knowledge
          ? knowledgeTool(this.#root, door, operation.slice(3) as KnowledgeOperation, args)
          : operation === 'vocabulary'
            ? vocabulary(args)
            : door.request({ operation, params: args });
        const result = format === 'compact' ? compactContext(raw as DoorResponse) : raw;
        const envelope = (value: typeof result) =>
          success({
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: !value.ok,
          });
        let response = envelope(result);
        if (operation === 'kb:search' && result.ok && 'value' in result) {
          const search = result.value as { results: readonly unknown[]; truncated: boolean };
          const results = [...search.results];
          while (size(response) > LIMITS.responseBytes && results.length) {
            results.pop();
            response = envelope({ ...result, value: { ...search, results, truncated: true } });
          }
        }
        return knowledge && size(response) > LIMITS.responseBytes ? bounded : response;
      }
      return rpcError(requestId, -32601, `Unknown method '${method}'`);
    } catch {
      return rpcError(requestId, -32603, 'Internal protocol error');
    }
  }
  close(): void {
    this.#state = 'closed';
    this.#door?.close();
  }
}
