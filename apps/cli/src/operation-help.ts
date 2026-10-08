/**
 * `ia <operation> --help` (docs/specs/command-discoverability/README.md CLI-01..02): one operation's help, rendered
 * from the machine protocol table that the MCP door and the reference page also read, so the three cannot drift. The
 * machine route stays uncoloured whatever the environment asks for (SPEC.md C10), so the capabilities are fixed here.
 */
import { MACHINE_PROTOCOL } from '@inventarch/runtime';
import type { ProtocolOperation } from '@inventarch/runtime';
import type { Capabilities } from './render.js';
import { atom, document, entry, fieldRows, MAX_WIDTH, sectionLabel, words } from './render.js';

const PLAIN: Capabilities = { color: false, ascii: true, width: MAX_WIDTH };
/**
 * Plan amendment A2: the machine routes are the version 1 operations, described at version 1 as 1.1.0 described them.
 * An operation a later version adds (`since`) is the Door's and the MCP door's, and a consumer verb here, so it has no
 * route, help or schema on this one.
 */
const ROUTE_VERSION = 1;
/** spec-0012 CLI-05: asks for the operation's description as JSON rather than as help text. */
export const SCHEMA_TOKEN = '--schema';
export const describeOperation = (name: string): ProtocolOperation | undefined =>
  MACHINE_PROTOCOL.operations.find((operation) => operation.since === undefined && operation.name === name);
/** CLI-05: one JSON line, the same object the MCP door's input schema is derived from. */
export const renderOperationSchema = (operation: ProtocolOperation): string =>
  JSON.stringify({ version: ROUTE_VERSION, ...operation }) + '\n';
type Schema = Readonly<Record<string, unknown>>;
/** A JSON Schema fragment spelled for a reader: `string`, `array of string`, `integer 0-8`, `one of a | b`, `{a, b}`. */
export function typeText(schema: Schema): string {
  if (Array.isArray(schema['enum'])) return `one of ${(schema['enum'] as readonly string[]).join(' | ')}`;
  if (schema['const'] !== undefined) return JSON.stringify(schema['const']);
  for (const key of ['anyOf', 'oneOf'])
    if (Array.isArray(schema[key])) return (schema[key] as readonly Schema[]).map(typeText).join(' or ');
  if (schema['type'] === 'array') return `array of ${typeText((schema['items'] ?? {}) as Schema)}`;
  if (schema['type'] === 'integer')
    return schema['maximum'] === undefined
      ? 'integer'
      : `integer ${String(schema['minimum'] ?? 0)}-${String(schema['maximum'])}`;
  if (schema['type'] === 'object') {
    const keys = Object.keys((schema['properties'] ?? {}) as object);
    return keys.length === 0 ? 'object' : `{${keys.join(', ')}}`;
  }
  return String(schema['type'] ?? 'value');
}
/** C03: the route's exit for a documented refusal, derived rather than stored (spec-0012 ERR-02). */
export const refusalExit = (code: string): number => (code === 'IA-RUNTIME-REQUEST-INVALID' ? 2 : 1);
export function renderOperationHelp(operation: ProtocolOperation): string {
  const params = operation.params as {
    readonly properties?: Readonly<Record<string, Schema>>;
    readonly required?: readonly string[];
  };
  const required = new Set(params.required ?? []);
  const rows = Object.entries(params.properties ?? {}).map(([name, schema]) => ({
    label: name,
    value: words(
      `${required.has(name) ? 'Required. ' : ''}${typeText(schema)}.${typeof schema['description'] === 'string' ? ` ${schema['description']}` : ''}`,
    ),
  }));
  return document([
    entry([[atom(`ia ${operation.name}`, null, 0), ...words(operation.summary, null, 2)]], { depth: 0 }, PLAIN),
    [
      sectionLabel('Usage', PLAIN),
      ...entry([[atom(`ia ${operation.name} [--root <workspace>] [--params <JSON|->]`, null, 0)]], { depth: 1 }, PLAIN),
      ...entry([[atom(`ia ${operation.name} ${SCHEMA_TOKEN}`, null, 0)]], { depth: 1 }, PLAIN),
    ],
    entry([words(operation.description)], { depth: 0 }, PLAIN),
    [
      sectionLabel('Parameters (the --params JSON object)', PLAIN),
      ...(rows.length === 0
        ? entry([words('None; pass {} or omit --params.')], { depth: 1 }, PLAIN)
        : fieldRows(rows, { depth: 1 }, PLAIN)),
    ],
    [sectionLabel('Result', PLAIN), ...entry([words(operation.result)], { depth: 1 }, PLAIN)],
    [
      sectionLabel('Refusals', PLAIN),
      ...fieldRows(
        operation.refusals.map((refusal) => ({
          label: refusal.code,
          value: words(`Exit ${refusalExit(refusal.code)}. ${refusal.when} ${refusal.next}`),
        })),
        { depth: 1 },
        PLAIN,
      ),
    ],
    [
      sectionLabel('Example', PLAIN),
      ...entry(
        [[atom(`ia ${operation.name} --root <workspace> --params '${JSON.stringify(operation.example)}'`, null, 0)]],
        { depth: 1 },
        PLAIN,
      ),
    ],
    entry(
      [
        words(
          `Machine protocol v${ROUTE_VERSION}: JSON in, one JSON line out, no color. ${operation.mcp === null ? 'The MCP door does not serve it.' : `MCP tool: ${operation.mcp}.`}`,
        ),
      ],
      { depth: 0 },
      PLAIN,
    ),
  ]);
}
