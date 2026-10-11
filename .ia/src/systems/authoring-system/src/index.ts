import { pathKey } from '@inventarch/db';
import type { DraftPreview, ReadHandle } from '@inventarch/db';
import { format } from '@inventarch/language';
import { portableDraftPath } from '@inventarch/runtime';

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
/** A record file in the folder of an admitted system that the workspace authors, never its declaration or schemas. */
function instanceTarget(records: ReturnType<ReadHandle['records']>, path: string): boolean {
  const target = /^\.ia\/src\/systems\/([a-z][a-z0-9-]*)\/(.+\.ia)$/.exec(path);
  return (
    target !== null &&
    target[2] !== 'system.ia' &&
    !target[2]!.startsWith('schemas/') &&
    records.some(
      (r) =>
        r.discriminator === 'system' &&
        r.name === target[1] &&
        r.source.path === `.ia/src/systems/${target[1]}/system.ia`,
    )
  );
}
/**
 * An IA file of the repository's own source outside every system folder, under a root an admitted `@workspace`
 * declares at the authored placement (`composition.sources`, as db membership reads it; db D02c), such as the three
 * records a default `ia init` writes to `.ia/src/workspace.ia`. A system folder keeps the instance rule above, and the
 * floor, an installed package and an adopted mount are never drafted: none of their paths is a repository-relative one
 * under `.ia/src/` outside `.ia/src/floor/`. The floor and system-folder prefixes are compared on db's `pathKey`, as
 * the preview compares them, so a spelling that differs only in case reaches neither.
 */
function rootTarget(context: DraftContext, path: string): boolean {
  const key = pathKey(path);
  if (
    !path.startsWith('.ia/src/') ||
    !path.endsWith('.ia') ||
    key.startsWith('.ia/src/floor/') ||
    key.startsWith('.ia/src/systems/')
  )
    return false;
  return context.reader
    .roots()
    .some(
      (declared) => declared.placement === 'authored' && (declared.root === '' || path.startsWith(`${declared.root}/`)),
    );
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
  if (!instanceTarget(records, path) && !rootTarget(context, path))
    fail(
      'IA-EXEC-OUTPUT-UNSAFE',
      'Draft target requires an admitted authored system instance, excluding declaration and schemas, or a file under an authored root',
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
