import { MACHINE_PROTOCOL } from '@inventarch/runtime';
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
 * M04: the door operations whose row names a tool, described once in @inventarch/runtime's MACHINE_PROTOCOL (spec-0012
 * MCP-01): the eight of version 1 (report is CLI-only), and read and next, which version 2 adds (plan amendment A3).
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
const definitions = [...served, vocabulary];
export const TOOLS = definitions.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
export const OPERATIONS = new Map(definitions.map(({ name, operation }) => [name, operation]));
