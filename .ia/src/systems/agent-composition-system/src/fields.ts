import type { CompiledRecord, CompiledValue } from '@inventarch/language';
import { CompositionError } from './compiled.js';
import type { CompositionCode } from './compiled.js';
import type { ResourceLimits } from './catalog.js';

export function fail(code: CompositionCode, message: string, node?: CompiledRecord, field?: string): never {
  throw new CompositionError({
    code,
    message,
    ...(node ? { source: { identity: node.identity, path: node.source.path, line: node.source.line } } : {}),
    ...(field ? { field } : {}),
  });
}
export function value(node: CompiledRecord, section: string, key: string, required = false): CompiledValue | undefined {
  const matches = node.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f) => 'key' in f && f.key === key);
  if (matches.length === 0 && !required) return undefined;
  const f = matches[0];
  if (matches.length !== 1 || !f || !('value' in f) || f.when || f.fields)
    fail('IA-COMPOSITION-CONFLICT', 'Expected one unconditional scalar/list field', node, `${section}.${key}`);
  return f.value;
}
export function text(v: CompiledValue | undefined, node: CompiledRecord, path: string): string {
  if (!v || !['scalar', 'string', 'prose'].includes(v.kind) || !('text' in v) || !v.text.trim())
    fail('IA-COMPOSITION-CONFLICT', 'Expected nonempty text', node, path);
  return v.text;
}
export function field(node: CompiledRecord, section: string, key: string, fallback?: string): string {
  const v = value(node, section, key, fallback === undefined);
  return v === undefined ? fallback! : text(v, node, `${section}.${key}`);
}
export function list(node: CompiledRecord, section: string, key: string): readonly CompiledValue[] {
  const v = value(node, section, key);
  if (v === undefined) return [];
  if (v.kind !== 'list') fail('IA-COMPOSITION-CONFLICT', 'Expected list', node, `${section}.${key}`);
  return v.items;
}
export function strings(node: CompiledRecord, section: string, key: string): string[] {
  return list(node, section, key).map((v) => text(v, node, `${section}.${key}`));
}
export const LIMIT_KEYS = [
  'steps',
  'modelCalls',
  'operations',
  'tokens',
  'children',
  'depth',
  'bytes',
  'durationMs',
] as const;
const nativeLimits: Record<string, keyof ResourceLimits> = {
  steps: 'steps',
  'model-calls': 'modelCalls',
  operations: 'operations',
  tokens: 'tokens',
  children: 'children',
  depth: 'depth',
  bytes: 'bytes',
  'duration-ms': 'durationMs',
};
export function limits(node: CompiledRecord): ResourceLimits {
  const entries = node.sections
    .filter((s) => s.name === 'execution')
    .flatMap((s) => s.fields)
    .filter((f) => 'key' in f && (f.key.startsWith('limit-') || f.key === 'limits'));
  const result: ResourceLimits = {};
  for (const f of entries) {
    if (!('key' in f) || !Object.hasOwn(nativeLimits, f.key.slice(6)) || f.when || f.fields)
      fail('IA-COMPOSITION-CONFLICT', 'Unknown or conditional limit', node, 'execution.limit-*');
    const key = nativeLimits[f.key.slice(6)]!,
      number = Number(text(f.value, node, `execution.${f.key}`));
    if (
      Object.hasOwn(result, key) ||
      !Number.isSafeInteger(number) ||
      number < 0 ||
      (key === 'durationMs' && number === 0)
    )
      fail('IA-COMPOSITION-CONFLICT', 'Invalid or duplicate limit', node, `execution.${f.key}`);
    result[key] = number;
  }
  return result;
}
export function minimum(...values: ResourceLimits[]): ResourceLimits {
  const result: ResourceLimits = {};
  for (const v of values)
    for (const key of LIMIT_KEYS) if (v[key] !== undefined) result[key] = Math.min(result[key] ?? Infinity, v[key]!);
  return result;
}
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** The language closes sections; the installed composition consumer additionally closes executable fields. */
export function closedFields(node: CompiledRecord): void {
  const contracts: Record<string, Record<string, string[]>> = {
    voice: { communication: ['tone', 'terminology', 'explanation', 'uncertainty', 'audience', 'citations'] },
    'agent-profile': {
      composition: ['agent', 'voice', 'mandate', 'capabilities', 'delegates'],
      execution: ['role', 'outcomes', 'mandate-contract', 'model-profile'],
    },
    harness: { composition: ['workspace', 'profiles', 'bindings'], execution: ['host-profile'] },
    capability: {
      composition: ['operations', 'playbooks', 'templates', 'checks', 'includes'],
      execution: ['input', 'outcomes', 'context-profile', 'procedure-profile', 'mapping-profile', 'effects'],
    },
    'execution-binding': {
      binding: ['kind', 'implementation', 'target', 'mapping', 'event', 'guard', 'tools', 'filters'],
    },
    mandate: { execution: ['contract'] },
    operation: { execution: ['handler', 'effects', 'input', 'output', 'profile', 'recovery'] },
  };
  const contract = contracts[node.discriminator];
  if (!contract) return;
  for (const section of node.sections) {
    const keys = contract[section.name];
    if (!keys) continue;
    for (const f of section.fields) {
      if (
        !('key' in f) ||
        (!keys.includes(f.key) &&
          !(
            section.name === 'execution' &&
            node.discriminator !== 'operation' &&
            Object.hasOwn(nativeLimits, f.key.slice(6)) &&
            f.key.startsWith('limit-')
          ))
      )
        fail('IA-COMPOSITION-CONFLICT', 'Unknown executable field', node, section.name);
      if (f.when || f.fields)
        fail(
          'IA-COMPOSITION-CONFLICT',
          'Conditional or nested executable fields are unsupported',
          node,
          `${section.name}.${f.key}`,
        );
    }
  }
}
