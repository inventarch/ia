import type { DraftPreview, ReadHandle } from '@ia/db';
import { format } from '@ia/language';
import { portableDraftPath } from '@ia/runtime';

export const DRAFT_LIMIT = 1024 * 1024;
export type DraftCode =
  | 'IA-EXEC-INPUT-INVALID'
  | 'IA-EXEC-OUTPUT-UNSAFE'
  | 'IA-EXEC-VALIDATION-FAILED'
  | 'IA-EXEC-SCOPE-UNAVAILABLE'
  | 'IA-EXEC-LIMIT-EXCEEDED';
export class DraftError extends Error {
  constructor(
    readonly code: DraftCode,
    message: string,
    readonly diagnostics: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'DraftError';
  }
}
export interface DraftContext {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly revision: string;
}
export interface DraftResult {
  readonly baseRevision: string;
  readonly candidateRevision: string;
  readonly artifacts: readonly { readonly path: string; readonly text: string }[];
  readonly evidence: {
    readonly admitted: number;
    readonly findings: DraftPreview['report']['findings'];
    readonly unavailable: readonly { readonly check: string; readonly scope: string }[];
  };
}
function fail(code: DraftCode, message: string): never {
  throw new DraftError(code, message);
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > DRAFT_LIMIT)
    fail('IA-EXEC-LIMIT-EXCEEDED', 'Draft input or result exceeds 1 MiB');
}
function diagnose(message: string, diagnostics: readonly unknown[]): never {
  bounded(diagnostics);
  throw new DraftError('IA-EXEC-VALIDATION-FAILED', message, diagnostics);
}
/** Preview is a whole-workspace operation. Refuse narrower views before reading diagnostics. */
function scope(context: DraftContext): ReturnType<ReadHandle['records']> {
  try {
    if (
      !context.within ||
      context.reader.revision !== context.revision ||
      !context.reader.isCompleteScope(context.within)
    )
      throw Error();
    const selected = context.reader.snapshot({ within: context.within, revision: context.revision }),
      all = context.reader.records();
    if (
      selected.root !== '' ||
      selected.phase !== undefined ||
      selected.records.length !== all.length ||
      selected.records.some((node, index) => node !== all[index])
    )
      throw Error();
    return selected.records;
  } catch {
    return fail('IA-EXEC-SCOPE-UNAVAILABLE', 'Draft admission requires the current complete disclosed workspace scope');
  }
}
function execute(context: DraftContext, input: unknown, formatting: boolean): DraftResult {
  const records = scope(context);
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).sort().join(',') !== 'path,text'
  )
    fail('IA-EXEC-INPUT-INVALID', 'Expected exactly path and text');
  const values = input as Record<string, unknown>;
  for (const key of ['path', 'text'])
    if (
      typeof values[key] !== 'string' ||
      !(values[key] as string).trim() ||
      Buffer.from(values[key] as string).toString('utf8') !== values[key]
    )
      fail('IA-EXEC-INPUT-INVALID', 'Expected nonempty valid Unicode text');
  bounded(input);
  let path: string;
  try {
    path = portableDraftPath(values['path'] as string);
  } catch {
    return fail('IA-EXEC-OUTPUT-UNSAFE', 'Unsafe draft target');
  }
  const target = /^\.ia\/src\/systems\/([a-z][a-z0-9-]*)\/(.+\.ia)$/.exec(path);
  if (
    !target ||
    target[2] === 'system.ia' ||
    target[2]!.startsWith('schemas/') ||
    !records.some(
      (r) =>
        r.discriminator === 'system' &&
        r.name === target[1] &&
        r.source.path === `.ia/src/systems/${target[1]}/system.ia`,
    )
  )
    fail(
      'IA-EXEC-OUTPUT-UNSAFE',
      'Draft target requires an admitted authored system instance, excluding declaration and schemas',
    );
  const baseErrors = context.reader.report.findings.filter((f) => f.severity === 'error');
  if (baseErrors.length) diagnose('Base workspace has admission errors', baseErrors);
  let text = values['text'] as string;
  if (formatting) {
    const formatted = format(text, path);
    if (formatted.text === null) diagnose('Formatter refused this draft', formatted.diagnostics);
    text = formatted.text;
  }
  const preview = context.reader.preview([{ path, text }]),
    errors = preview.report.findings.filter((f) => f.severity === 'error');
  if (errors.length || !preview.records.some((r) => r.source.path === path))
    diagnose('Draft failed contextual admission', errors);
  scope(context);
  const result: DraftResult = {
    baseRevision: context.revision,
    candidateRevision: preview.revision,
    artifacts: formatting ? [{ path, text }] : [],
    evidence: {
      admitted: preview.records.length,
      findings: preview.report.findings,
      unavailable: preview.report.verdicts
        .filter((v) => v.outcome === 'not-evaluated')
        .map((v) => ({ check: v.check, scope: v.scope })),
    },
  };
  bounded(result);
  return result;
}
export function validateDraft(context: DraftContext, input: unknown): DraftResult {
  return execute(context, input, false);
}
export function formatDraft(context: DraftContext, input: unknown): DraftResult {
  return execute(context, input, true);
}
