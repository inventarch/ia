import { parseLocator } from '@inventarch/runtime';
import { closed, data, fail, frozen, KnowledgeError, LIMITS } from './format.js';
import { boundedResponse } from './view.js';
import type { openKnowledgeView } from './view.js';
export const KB_PROTOCOL_VERSION = 1;
export interface KnowledgeResponse {
  readonly version: 1;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
const text = { type: 'string', minLength: 1, maxLength: 1024 };
const within = { ...text, description: 'Optional scope token issued by this MCP server; never a filesystem path.' };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: { ...properties, within },
  required,
  additionalProperties: false,
});
export const KB_OPERATIONS = frozen([
  {
    name: 'check',
    description: 'Check selected knowledge and report unavailable bodies and compliance checks separately.',
    inputSchema: object({}, []),
  },
  {
    name: 'search',
    description: 'Search bounded selected native and bound document text; snippets come from the captured snapshot.',
    inputSchema: object(
      { query: { ...text, maxLength: LIMITS.query }, limit: { type: 'integer', minimum: 1, maximum: LIMITS.results } },
      ['query'],
    ),
  },
  {
    name: 'read',
    description: 'Read an admitted selected identity or native fragment with an exact snapshot citation.',
    inputSchema: object({ locator: text }, ['locator']),
  },
  {
    name: 'resolve',
    description: 'Resolve an exact citation against this snapshot, or refuse if the pinned bytes are unavailable.',
    inputSchema: object(
      { citation: { type: 'object', description: 'The complete ia.kb.citation.v1 returned by a knowledge read.' } },
      ['citation'],
    ),
  },
  {
    name: 'traverse',
    description: 'Traverse native resolved outgoing edges within selected knowledge. Conditions remain unevaluated.',
    inputSchema: object({ identity: text, steps: { type: 'integer', minimum: 1, maximum: LIMITS.steps } }, [
      'identity',
    ]),
  },
] as const);
export type KnowledgeOperation = (typeof KB_OPERATIONS)[number]['name'];
export interface KnowledgeRequest {
  readonly within?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly locator?: string;
  readonly citation?: unknown;
  readonly identity?: string;
  readonly steps?: number;
}
export function parseKnowledgeRequest(operation: string, input: unknown): KnowledgeRequest {
  const spec = KB_OPERATIONS.find((o) => o.name === operation);
  if (!spec) return fail('Unknown knowledge operation');
  const value = data<KnowledgeRequest>(input, 16 * 1024),
    keys = Object.keys(spec.inputSchema.properties);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    spec.inputSchema.required.some((k) => !Object.hasOwn(value, k))
  )
    return fail('Invalid knowledge request fields');
  const str = (v: unknown, max = 1024) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) fail('Invalid knowledge request text');
  };
  if (value.within !== undefined) str(value.within);
  if (operation === 'search') str(value.query, LIMITS.query);
  for (const [v, max] of [
    [value.limit, LIMITS.results],
    [value.steps, LIMITS.steps],
  ] as const)
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > max)) fail('Invalid knowledge request limit');
  if (operation === 'read') {
    str(value.locator);
    const p = parseLocator(value.locator!);
    if (!p || p.form === 'line') fail('Native knowledge locator required');
  }
  if (operation === 'traverse') {
    str(value.identity);
    const p = parseLocator(value.identity!);
    if (!p || p.form !== 'identity') fail('Full native identity required');
  }
  if (operation === 'resolve') {
    const c = value.citation as Record<string, unknown>;
    if (!c || typeof c !== 'object' || Array.isArray(c)) fail('Complete knowledge citation required');
    closed(
      c,
      c['kind'] === 'commit'
        ? ['format', 'kind', 'sourceId', 'snapshot', 'locator', 'identity', 'body', 'commit']
        : ['format', 'kind', 'sourceId', 'snapshot', 'locator', 'identity', 'body'],
    );
  }
  return frozen(value);
}
export function knowledgeFailure(error: unknown): KnowledgeResponse {
  return boundedResponse({
    version: KB_PROTOCOL_VERSION,
    ok: false as const,
    error:
      error instanceof KnowledgeError
        ? { code: error.code, message: error.message }
        : { code: 'IA-KB-UNAVAILABLE', message: 'Knowledge unavailable in this scope' },
  });
}
export function executeKnowledge(
  view: ReturnType<typeof openKnowledgeView>,
  operation: KnowledgeOperation,
  input: unknown,
): KnowledgeResponse {
  try {
    const args = parseKnowledgeRequest(operation, input);
    const value =
      operation === 'check'
        ? view.check()
        : operation === 'search'
          ? view.search(args.query!, args.limit)
          : operation === 'read'
            ? view.read(args.locator!)
            : operation === 'resolve'
              ? view.resolveCitation(args.citation)
              : view.traverse(args.identity!, args.steps);
    return boundedResponse({
      version: KB_PROTOCOL_VERSION,
      ok: operation === 'check' ? (value as ReturnType<typeof view.check>).ok : true,
      value,
    });
  } catch (error) {
    return knowledgeFailure(error);
  }
}
