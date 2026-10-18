import type { CompiledRecord } from '../../packages/language/src/index.js';

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
