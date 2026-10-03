import type { CompiledRecord, CompiledValue } from '@inventarch/language';
import { portableDraftPath } from '@inventarch/runtime';
import { invalid, inputInvalid, object, TemplateError } from './contract.js';

/** Original T01 semantics; contextual admission/publication remains the caller's job. */
export function renderScalarTemplate(record: CompiledRecord, supplied: unknown): { path: string; text: string } {
  const values = object(supplied),
    used = new Set<string>();
  if (record.discriminator !== 'template') invalid('Expected an admitted template record');
  const field = (key: string): CompiledValue => {
    const rows = record.sections
        .filter((s) => s.name === 'template')
        .flatMap((s) => s.fields)
        .filter((f) => 'key' in f && f.key === key),
      f = rows.length === 1 ? rows[0] : undefined;
    if (!f || !('value' in f) || f.when !== undefined || f.fields !== undefined)
      invalid(`Template requires one unconditional template.${key}`);
    return f.value;
  };
  const text = (value: CompiledValue): string => {
    if (!('text' in value)) invalid('Expected compiled template text');
    return value.text;
  };
  const list = (value: CompiledValue): readonly string[] => {
    if (value.kind !== 'list') invalid('Expected a compiled template list');
    return value.items.map(text);
  };
  const profile = record.sections
    .filter((s) => s.name === 'template')
    .flatMap((s) => s.fields)
    .find((f) => 'key' in f && (f.key === 'profile' || f.key === 'resource'));
  if (profile) invalid('An explicitly profiled template requires its matching renderer');
  const filename = text(field('filename')),
    content = list(field('lines')).join('\n'),
    parameters = list(field('parameters'));
  for (const source of [filename, content]) {
    const remainder = source.replace(/\{\{([a-z][a-z0-9-]*)\}\}/g, (_match, key: string) => {
      used.add(key);
      return '';
    });
    if (remainder.includes('{{') || remainder.includes('}}'))
      invalid('Only {{lowercase-id}} placeholders are supported');
  }
  if (
    !parameters.length ||
    new Set(parameters).size !== parameters.length ||
    parameters.some((p) => !/^[a-z][a-z0-9-]*$/.test(p) || !used.has(p)) ||
    [...used].some((p) => !parameters.includes(p))
  )
    invalid('Template declaration and placeholders disagree');
  if (
    Object.keys(values).length !== parameters.length ||
    parameters.some((p) => !Object.hasOwn(values, p) || typeof values[p] !== 'string') ||
    Object.keys(values).some((p) => !parameters.includes(p))
  )
    inputInvalid(`Supply exactly the string parameters: ${parameters.join(', ')}`);
  const substitute = (source: string): string =>
    source.replace(/\{\{([a-z][a-z0-9-]*)\}\}/g, (_match, key: string) => values[key] as string);
  let path: string;
  try {
    path = portableDraftPath(substitute(filename));
  } catch {
    throw new TemplateError('IA-EXEC-OUTPUT-UNSAFE', 'Unsafe artifact path');
  }
  const output = substitute(content);
  if (Buffer.from(output).toString('utf8') !== output) inputInvalid('Template parameters must be valid Unicode');
  return { path, text: output };
}
