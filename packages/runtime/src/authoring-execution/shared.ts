import type { CompiledRecord, CompiledValue } from '@ia/language';
import type { DraftPreview } from '@ia/db';
import { portableDraftPath } from '../publication.js';
import { ExecutionError } from './types.js';
import type { Context, ExecCode } from './types.js';

export const idPattern = /^[a-z][a-z0-9-]*$/;
export const fail = (code: ExecCode, message: string): never => {
  throw new ExecutionError(code, message);
};
export function object(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return fail('IA-EXEC-INPUT-INVALID', 'Expected a JSON object');
  const value = input as Record<string, unknown>;
  if (
    keys !== undefined &&
    (Object.keys(value).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(value, k)))
  )
    return fail('IA-EXEC-INPUT-INVALID', `Expected exactly: ${keys.join(', ')}`);
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.from(value).toString('utf8') !== value)
    return fail('IA-EXEC-INPUT-INVALID', 'Expected nonempty valid Unicode text');
  return value;
}
export function id(value: unknown): string {
  const name = string(value);
  if (!idPattern.test(name)) return fail('IA-EXEC-INPUT-INVALID', 'Expected a lowercase id');
  return name;
}
/** Language2.4 recognizes only escaped quote/backslash, not JSON escapes. */
export function quoteIA(value: string): string {
  if (/[\r\n]/.test(value))
    return fail(
      'IA-EXEC-INPUT-INVALID',
      'This factory field requires single-line text; use validate-ia for multiline source',
    );
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
export function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    return fail('IA-EXEC-INPUT-INVALID', 'Expected a nonempty string array');
  const items = value.map(string);
  if (new Set(items).size !== items.length) return fail('IA-EXEC-INPUT-INVALID', 'Duplicate list items');
  return items;
}
export function portablePath(value: unknown): string {
  try {
    return portableDraftPath(string(value));
  } catch {
    return fail('IA-EXEC-OUTPUT-UNSAFE', 'Unsafe artifact path');
  }
}
export function draftPath(context: Context, value: unknown): string {
  const path = portablePath(value),
    match = /^\.ia\/src\/systems\/([a-z][a-z0-9-]*)\/(.+\.ia)$/.exec(path);
  if (
    !match ||
    match[2] === 'system.ia' ||
    match[2]!.startsWith('schemas/') ||
    !context.records.some(
      (r) =>
        r.discriminator === 'system' &&
        r.name === match[1] &&
        r.source.path === `.ia/src/systems/${match[1]}/system.ia`,
    )
  )
    return fail(
      'IA-EXEC-OUTPUT-UNSAFE',
      'Draft target requires an admitted system, excluding its declaration and schemas',
    );
  return path;
}
export function field(
  record: CompiledRecord,
  section: string,
  key: string,
  code: ExecCode = 'IA-EXEC-BINDING-MISMATCH',
): CompiledValue {
  const fields = record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f) => 'key' in f && f.key === key);
  const f = fields.length === 1 ? fields[0] : undefined;
  if (f === undefined || !('value' in f) || f.when !== undefined || f.fields !== undefined)
    return fail(code, `${record.identity} requires one unconditional ${section}.${key}`);
  return f.value;
}
export function text(value: CompiledValue, code: ExecCode = 'IA-EXEC-BINDING-MISMATCH'): string {
  if (value.kind !== 'scalar' && value.kind !== 'string' && value.kind !== 'prose')
    return fail(code, 'Expected compiled text');
  return value.text;
}
export function list(value: CompiledValue, code: ExecCode = 'IA-EXEC-BINDING-MISMATCH'): readonly string[] {
  if (value.kind !== 'list') return fail(code, 'Expected a compiled list');
  return value.items.map((v) => text(v, code));
}
export function preview(
  context: Context,
  path: string,
  source: string,
  expected?: { discriminator: string; name: string },
): DraftPreview {
  const result = context.db.preview([{ path, text: source }]),
    errors = result.report.findings.filter((f) => f.severity === 'error');
  const records = result.records.filter((r) => r.source.path === path);
  if (
    errors.length ||
    records.length === 0 ||
    (expected !== undefined &&
      (records.length !== 1 ||
        records[0]!.discriminator !== expected.discriminator ||
        records[0]!.name !== expected.name))
  )
    throw new ExecutionError('IA-EXEC-VALIDATION-FAILED', 'Draft failed contextual admission', errors);
  return result;
}
export function evidence(result: DraftPreview): Readonly<Record<string, unknown>> {
  return {
    admitted: result.records.length,
    findings: result.report.findings,
    unavailable: result.report.verdicts
      .filter((v) => v.outcome === 'not-evaluated')
      .map((v) => ({ check: v.check, scope: v.scope })),
  };
}
