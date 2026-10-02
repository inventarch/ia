import { createHash } from 'node:crypto';
import { id, inputInvalid, invalid, object, unicode } from './contract.js';

export const TEMPLATE_LIMITS = Object.freeze({
  inputBytes: 65536,
  nodes: 1024,
  depth: 8,
  listItems: 100,
  iterations: 1000,
  outputBytes: 1024 * 1024,
});
export type ScalarSchema = { readonly type: 'text' | 'boolean' | 'integer'; readonly required: boolean };
export type InputSchema =
  | ScalarSchema
  | { readonly type: 'list'; readonly required: boolean; readonly items: Readonly<Record<string, ScalarSchema>> };
export type TemplateNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly input: string }
  | {
      readonly kind: 'optional';
      readonly input: string;
      readonly test: 'present' | 'true';
      readonly children: readonly TemplateNode[];
    }
  | {
      readonly kind: 'each';
      readonly input: string;
      readonly item: string;
      readonly children: readonly TemplateNode[];
    };
export interface StructuredTemplate {
  readonly format: 'ia.structured-template.v1';
  readonly inputs: Readonly<Record<string, InputSchema>>;
  readonly nodes: readonly TemplateNode[];
}
export interface RenderedTemplate {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly iterations: number;
}
function scalar(value: unknown): ScalarSchema {
  const row = object(value, ['type', 'required']);
  if (!['text', 'boolean', 'integer'].includes(row['type'] as string) || typeof row['required'] !== 'boolean')
    invalid('Invalid scalar template schema');
  return { type: row['type'] as ScalarSchema['type'], required: row['required'] };
}
export function verifyStructuredTemplate(value: unknown): StructuredTemplate {
  const row = object(value, ['format', 'inputs', 'nodes']);
  if (row['format'] !== 'ia.structured-template.v1') invalid('Unknown structured template format');
  const declarations = Object.entries(object(row['inputs']));
  if (declarations.length > 64) invalid('Template input declaration ceiling exceeded');
  const inputs = Object.fromEntries(
    declarations.map(([key, value]): [string, InputSchema] => {
      id(key);
      const input = object(value);
      if (input['type'] !== 'list') return [key, scalar(input)];
      object(input, ['type', 'required', 'items']);
      if (typeof input['required'] !== 'boolean') invalid('List schema requires a literal required flag');
      const fields = Object.entries(object(input['items']));
      if (!fields.length || fields.length > 32) invalid('List items need 1–32 declared scalar fields');
      return [
        key,
        {
          type: 'list',
          required: input['required'],
          items: Object.fromEntries(fields.map(([field, schema]) => [id(field), scalar(schema)])),
        },
      ];
    }),
  );
  const used = new Set<string>();
  let count = 0,
    literalBytes = 0;
  const lookup = (path: unknown, aliases: ReadonlyMap<string, string>): { path: string; schema: InputSchema } => {
    const key = unicode(path, 129),
      segments = key.split('.');
    let schema: InputSchema | undefined,
      tracked = key;
    if (segments.length === 1) {
      id(key);
      schema = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
    } else if (segments.length === 2) {
      const root = aliases.get(id(segments[0]));
      if (!root) invalid('Item reference has no active repetition');
      const list = inputs[root];
      if (list?.type !== 'list') invalid('Item reference requires a list schema');
      const field = id(segments[1]);
      schema = Object.hasOwn(list.items, field) ? list.items[field] : undefined;
      tracked = root + '.' + field;
    }
    if (!schema) invalid('Template references an undeclared input');
    used.add(tracked);
    return { path: key, schema };
  };
  const nodes = (value: unknown, depth: number, aliases: ReadonlyMap<string, string>): TemplateNode[] => {
    if (!Array.isArray(value) || depth > TEMPLATE_LIMITS.depth || value.length > TEMPLATE_LIMITS.nodes)
      invalid('Template tree depth/node bound exceeded');
    return value.map((value): TemplateNode => {
      if (++count > TEMPLATE_LIMITS.nodes) invalid('Template node ceiling exceeded');
      const node = object(value);
      if (node['kind'] === 'text') {
        object(node, ['kind', 'text']);
        const text = unicode(node['text'], TEMPLATE_LIMITS.outputBytes);
        literalBytes += Buffer.byteLength(text);
        if (literalBytes > TEMPLATE_LIMITS.outputBytes) invalid('Template literal byte ceiling exceeded');
        return { kind: 'text', text };
      }
      if (node['kind'] === 'value') {
        object(node, ['kind', 'input']);
        const { path, schema } = lookup(node['input'], aliases);
        if (schema.type === 'list') invalid('A value node requires a scalar');
        return { kind: 'value', input: path };
      }
      if (node['kind'] === 'optional') {
        object(node, ['kind', 'input', 'test', 'children']);
        const { path, schema } = lookup(node['input'], aliases);
        if (
          !['present', 'true'].includes(node['test'] as string) ||
          (node['test'] === 'true' && schema.type !== 'boolean')
        )
          invalid('Optional test is incompatible with its input');
        return {
          kind: 'optional',
          input: path,
          test: node['test'] as 'present' | 'true',
          children: nodes(node['children'], depth + 1, aliases),
        };
      }
      if (node['kind'] === 'each') {
        object(node, ['kind', 'input', 'item', 'children']);
        const { path, schema } = lookup(node['input'], aliases),
          item = id(node['item']);
        if (schema.type !== 'list' || path.includes('.') || Object.hasOwn(inputs, item) || aliases.has(item))
          invalid('Repetition requires a declared list and a unique non-shadowing alias');
        return {
          kind: 'each',
          input: path,
          item,
          children: nodes(node['children'], depth + 1, new Map([...aliases, [item, path]])),
        };
      }
      return invalid('Unknown template node kind');
    });
  };
  const tree = nodes(row['nodes'], 1, new Map());
  for (const [key, input] of Object.entries(inputs)) {
    if (!used.has(key)) invalid('Unused declared template input');
    if (input.type === 'list' && Object.keys(input.items).some((field) => !used.has(key + '.' + field)))
      invalid('Unused declared item field');
  }
  // Bounds also cap metadata/text outside the input payload; no huge inert tree.
  const result: StructuredTemplate = { format: 'ia.structured-template.v1', inputs, nodes: tree };
  if (Buffer.byteLength(JSON.stringify(result)) > TEMPLATE_LIMITS.outputBytes) invalid('Template tree exceeds 1 MiB');
  return result;
}
type Scalar = string | number | boolean;
type Values = Record<string, Scalar | Record<string, Scalar>[]>;
function valuesFor(inputs: StructuredTemplate['inputs'], value: unknown): Values {
  const source = object(value),
    result: Values = {};
  let scalarBytes = 0;
  if (Object.keys(source).some((key) => !Object.hasOwn(inputs, key))) inputInvalid('Unknown template input');
  const valueOf = (schema: ScalarSchema, value: unknown): Scalar => {
    if (schema.type === 'text') {
      if (
        typeof value !== 'string' ||
        Buffer.byteLength(value) > TEMPLATE_LIMITS.inputBytes ||
        Buffer.from(value).toString('utf8') !== value
      )
        inputInvalid('Text input must be bounded valid Unicode');
      scalarBytes += Buffer.byteLength(value);
      if (scalarBytes > TEMPLATE_LIMITS.inputBytes) inputInvalid('Template input exceeds 64 KiB');
      return value;
    }
    if (
      (schema.type === 'boolean' && typeof value === 'boolean') ||
      (schema.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))
    )
      return value as Scalar;
    return inputInvalid('Scalar input type differs from its declaration');
  };
  for (const [key, schema] of Object.entries(inputs)) {
    if (!Object.hasOwn(source, key)) {
      if (schema.required) inputInvalid('Missing required template input');
      continue;
    }
    if (schema.type !== 'list') {
      result[key] = valueOf(schema, source[key]);
      continue;
    }
    const list = source[key];
    if (!Array.isArray(list) || list.length > TEMPLATE_LIMITS.listItems)
      inputInvalid('List input exceeds its type or item bound');
    result[key] = list.map((item) => {
      const row = object(item),
        result: Record<string, Scalar> = {};
      if (Object.keys(row).some((field) => !Object.hasOwn(schema.items, field))) inputInvalid('Unknown item field');
      for (const [field, declaration] of Object.entries(schema.items)) {
        if (!Object.hasOwn(row, field)) {
          if (declaration.required) inputInvalid('Missing required item field');
          continue;
        }
        result[field] = valueOf(declaration, row[field]);
      }
      return result;
    });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > TEMPLATE_LIMITS.inputBytes)
    inputInvalid('Template input exceeds 64 KiB');
  return result;
}
/** Pure finite interpreter. Values are data; there are no helpers, includes or I/O. */
export function renderStructuredTemplate(template: unknown, supplied: unknown): RenderedTemplate {
  const tree = verifyStructuredTemplate(template),
    values = valuesFor(tree.inputs, supplied),
    output: string[] = [];
  let bytes = 0,
    iterations = 0;
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text);
    if (bytes > TEMPLATE_LIMITS.outputBytes) invalid('Template output exceeds 1 MiB');
    output.push(text);
  };
  const render = (nodes: readonly TemplateNode[], items: ReadonlyMap<string, Record<string, Scalar>>): void => {
    const read = (key: string): Scalar | Record<string, Scalar>[] | undefined => {
      const [first, field] = key.split('.');
      if (field === undefined) return Object.hasOwn(values, first!) ? values[first!] : undefined;
      const item = items.get(first!);
      return item && Object.hasOwn(item, field) ? item[field] : undefined;
    };
    for (const node of nodes) {
      if (node.kind === 'text') append(node.text);
      else if (node.kind === 'value') {
        const value = read(node.input);
        if (value === undefined || Array.isArray(value)) inputInvalid('Rendered scalar input is absent');
        append(String(value));
      } else if (node.kind === 'optional') {
        const value = read(node.input);
        if (node.test === 'present' ? value !== undefined : value === true) render(node.children, items);
      } else {
        const list = read(node.input);
        if (!Array.isArray(list)) inputInvalid('Rendered list input is absent');
        for (const item of list) {
          if (++iterations > TEMPLATE_LIMITS.iterations) invalid('Template iteration ceiling exceeded');
          render(node.children, new Map([...items, [node.item, item]]));
        }
      }
    }
  };
  render(tree.nodes, new Map());
  const text = output.join('');
  return { text, bytes, sha256: createHash('sha256').update(text).digest('hex'), iterations };
}
