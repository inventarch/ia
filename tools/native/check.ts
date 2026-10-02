import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, validateSystems } from '../../packages/compliance/src/index.js';
import type { CompiledRecord } from '../../packages/language/src/index.js';
import { compileNative } from './compile.js';
import type { NativeInput } from './compile.js';
import { isEntry } from '../entry/is-entry.mjs';

export function readNative(root: string): { inputs: readonly NativeInput[]; folders: readonly string[] } {
  const inputs: NativeInput[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name.toLowerCase())) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.ia'))
        inputs.push({
          path: child,
          text: readFileSync(resolve(root, child), 'utf8'),
          location: child.startsWith('.ia/src/floor/')
            ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
            : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
        });
    }
  };
  walk('.ia/src');
  const folders = readdirSync(resolve(root, '.ia/src/systems'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return { inputs, folders };
}
export function checkNative(inputs: readonly NativeInput[], folders: readonly string[]) {
  const corpus = compileNative(inputs);
  const assessments = [
    ...corpus.records.map((r) => validateSchema(r, corpus.registry, corpus.records)),
    ...validateSystems(
      folders.map((name) => {
        const path = `.ia/src/systems/${name}`;
        return {
          name,
          path,
          sources: corpus.sources.filter((s) => s.ast.path.startsWith(`${path}/`)),
          records: corpus.records.filter((r) => r.source.path.startsWith(`${path}/`)),
        };
      }),
      corpus.registry,
      corpus.records,
    ),
  ];
  return {
    ...corpus,
    assessments,
    ok: !corpus.diagnostics.some((d) => d.severity === 'error') && assessments.every((a) => a.outcome === 'pass'),
  };
}
/**
 * `answers` templates that ask about the record's own name instead of the need it serves. Removing the name leaves
 * one identical sentence per template, so the phrase cannot tell its record apart.
 */
export const CIRCULAR_ANSWERS: readonly RegExp[] = [
  /^What does .+ designate in the .+ domain\?$/,
  /^Does this node lower into the .+ lane\?$/,
  /^What cognitive operation does .+ name\?$/,
];
export interface MeaningFinding {
  readonly code: 'IA-NATIVE-ANSWERS-DUPLICATE' | 'IA-NATIVE-ANSWERS-CIRCULAR';
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

function answersOf(record: CompiledRecord): string | undefined {
  for (const section of record.sections)
    if (section.name === 'meaning')
      for (const field of section.fields) {
        if (
          'key' in field &&
          field.key === 'answers' &&
          (field.value.kind === 'string' || field.value.kind === 'prose')
        )
          return field.value.text;
      }
  return undefined;
}
/** Refuse repeated selection questions and known circular templates without exceptions. */
export function checkMeaning(records: readonly CompiledRecord[]): readonly MeaningFinding[] {
  const phrases = records.flatMap((record) => {
    const answers = answersOf(record);
    return answers === undefined ? [] : [{ record, answers }];
  });
  const byText = new Map<string, CompiledRecord[]>();
  for (const { record, answers } of phrases) byText.set(answers, [...(byText.get(answers) ?? []), record]);
  const findings: MeaningFinding[] = [];
  for (const { record, answers } of phrases) {
    const others = byText
      .get(answers)!
      .filter((other) => other !== record)
      .map((other) => other.identity);
    const source = { identity: record.identity, path: record.source.path, line: record.source.line };
    if (others.length > 0)
      findings.push({
        ...source,
        code: 'IA-NATIVE-ANSWERS-DUPLICATE',
        message: `answers "${answers}" repeats ${others.join(', ')}; ask the question only this record answers`,
      });
    if (CIRCULAR_ANSWERS.some((pattern) => pattern.test(answers)))
      findings.push({
        ...source,
        code: 'IA-NATIVE-ANSWERS-CIRCULAR',
        message: `answers "${answers}" asks about the record's own name; ask the question a requester has when this is the right record`,
      });
  }
  return findings;
}
export function nativeOutcome(result: ReturnType<typeof checkNative>) {
  const meaning = checkMeaning(result.records);
  return {
    ok: result.ok && meaning.length === 0,
    findings: [...result.diagnostics, ...result.assessments.flatMap((a) => a.findings), ...meaning],
  };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const { inputs, folders } = readNative(fileURLToPath(new URL('../../', import.meta.url)));
  const result = checkNative(inputs, folders);
  const { ok, findings } = nativeOutcome(result);
  if (findings.length > 0) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}: ${result.records.length} native records; ${result.assessments.length} structural assessments; order ${result.registry.order.join(', ')}.\n`,
  );
  if (!ok) process.exitCode = 1;
}
