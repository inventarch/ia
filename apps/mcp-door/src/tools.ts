import { MACHINE_PROTOCOL } from '@inventarch/runtime';
import { KB_OPERATIONS } from '@inventarch/kb/protocol';
import type { JsonSchema } from '@inventarch/runtime';
import { LIMITS } from './vocabulary.js';

const text = { type: 'string' };
const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
/** M04a: ia_context's transport-only option. protocol.ts strips it before the Door sees the request. */
const FORMAT = {
  enum: ['full', 'compact'],
  description:
    'Default full preserves the complete diagnostic packet. Compact retains all delivered content, citations, conditions and graph evidence while summarizing budget/disqualification omissions.',
};
const withFormat = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  properties: { ...(schema['properties'] as Record<string, unknown>), format: FORMAT },
});
/**
 * A token can expire while the server runs (database D08c), which the frozen version 1 rows cannot say. So the tools do:
 * in full on the one that issues tokens, and in brief on every `within`, where a client chooses what to pass.
 */
const EXPIRY =
  'A token can expire while the server runs: once 4,096 newer scopes are issued or read before it is read again, it refuses and reads nothing. Call ia_scope for a new one, with the same narrowing.';
const WITHIN_EXPIRY =
  'It can expire: on IA-DB-STALE, or IA-KB-SCOPE-UNAVAILABLE from an ia_kb tool, call ia_scope for a new one.';
const withExpiry = (schema: JsonSchema): JsonSchema => {
  const properties = schema['properties'] as Record<string, JsonSchema>,
    within = properties['within'];
  if (within === undefined) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      within: { ...within, description: `${String(within['description'])} ${WITHIN_EXPIRY}` },
    },
  };
};
/**
 * The door operations whose row names a tool, described once in @inventarch/runtime's MACHINE_PROTOCOL (runtime R12):
 * the eight of version 1 (report is CLI-only), and read, next and position, which version 2 adds.
 */
const served = MACHINE_PROTOCOL.operations.flatMap((operation) =>
  operation.mcp === null
    ? []
    : [
        {
          name: operation.mcp,
          operation: operation.name,
          description:
            operation.name === 'context'
              ? `${operation.description} Prefer format=compact for model context; full includes per-record omission diagnostics.`
              : operation.name === 'scope'
                ? `${operation.description} ${EXPIRY}`
                : operation.description,
          inputSchema: operation.name === 'context' ? withFormat(operation.params) : operation.params,
        },
      ],
);
/** M04c: the one tool no door operation backs, so it is described here rather than in the table. */
const vocabulary = {
  name: 'ia_vocabulary',
  operation: 'vocabulary',
  description:
    'Look up the public IA words, their schemas and fields from the catalogue shipped with this server (the one `ia vocabulary` reads). It reads no workspace records and takes no scope token. Omit word to list; schema=true adds fields and relationships.',
  inputSchema: object({
    word: { ...text, maxLength: LIMITS.word, description: 'One word, with or without @; an unknown word refuses.' },
    domain: {
      type: 'array',
      items: { ...text, maxLength: LIMITS.word },
      maxItems: LIMITS.filters,
      description: 'Owning systems to keep.',
    },
    kind: {
      type: 'array',
      items: { ...text, maxLength: LIMITS.word },
      maxItems: LIMITS.filters,
      description: 'Record kinds to keep.',
    },
    search: {
      ...text,
      maxLength: LIMITS.search,
      description: 'Case-insensitive substring of the word or its description.',
    },
    schema: {
      type: 'boolean',
      description:
        "Include each schema's sections, fields and relationships; default false returns name, path and closed only.",
    },
  }),
};
const definitions = [
  ...served,
  vocabulary,
  ...KB_OPERATIONS.map((row) => ({
    name: 'ia_kb_' + row.name,
    operation: 'kb:' + row.name,
    description: row.description,
    inputSchema: row.inputSchema,
  })),
];
export const TOOLS = definitions.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema: withExpiry(inputSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
export const OPERATIONS = new Map(definitions.map(({ name, operation }) => [name, operation]));
