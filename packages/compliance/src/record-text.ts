import type { CompiledChild, CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';

/** Inline text of one compiled value. A block carries its content in its field's children; use fieldText for it. */
export function text(value: CompiledValue): string {
  if (value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose') return value.text;
  if (value.kind === 'list') return value.items.length === 0 ? '[]' : value.items.map(text).join(', ');
  if (value.kind === 'ref') return `@${value.discriminator} ${value.name}`;
  return '';
}
export function cite(record: CompiledRecord): string {
  return `@${record.discriminator} ${record.name} (${record.source.path}:${record.source.line})`;
}
function childLine(child: CompiledChild): string {
  if ('item' in child) return text(child.item);
  const value = fieldText(child);
  return !value ? '' : child.value.kind === 'block' ? `${child.key}:\n${value}` : `${child.key}: ${value}`;
}
/** A field's rendered value: inline values as text, a block as one `- ` bullet per nonempty item or nested field. */
export function fieldText(field: CompiledField): string {
  if (field.value.kind !== 'block') return text(field.value);
  return (field.fields ?? [])
    .map(childLine)
    .filter((line) => line.trim() !== '')
    .map((line) => '- ' + line.replace(/\n/g, '\n  '))
    .join('\n');
}
/** The first field `key` directly under the record's `section`. */
export function fieldOf(record: CompiledRecord, section: string, key: string): CompiledField | undefined {
  return record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .find((f): f is CompiledField => 'key' in f && f.key === key);
}
/** The fields directly under the record's `section`, in authored order. */
export function fieldsOf(record: CompiledRecord, section: string): readonly CompiledField[] {
  return record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f);
}
export function says(record: CompiledRecord): string {
  return fieldsOf(record, 'meaning')
    .filter((f) => f.key === 'says')
    .map(fieldText)
    .join('\n');
}
export type Clauses = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly key: string };
/**
 * Unconditional governance variants named by `keys`, in authored order, as `key: value` or, for a block, `key:` over
 * a bulleted list. An inline empty list (`applies []`) authors "none" and is skipped like an absent clause, never
 * projected as a literal `key: []`. Any other clause that renders empty is refused rather than projected as a bare
 * `key:` line, so content the renderer cannot express is never dropped silently.
 */
export function governanceClauses(record: CompiledRecord, keys: readonly string[]): Clauses {
  const governance = fieldsOf(record, 'governance'),
    rendered: string[] = [];
  for (const variant of record.variants) {
    if (variant.condition !== undefined || !keys.includes(variant.key)) continue;
    if (variant.value.kind === 'list' && variant.value.items.length === 0) continue;
    const field =
      variant.value.kind === 'block'
        ? governance.find((f) => f.key === variant.key && f.span.line === variant.span.line)
        : undefined;
    const value = field === undefined ? text(variant.value) : fieldText(field);
    if (value.trim() === '') return { ok: false, key: variant.key };
    rendered.push(variant.value.kind === 'block' ? `${variant.key}:\n${value}` : `${variant.key}: ${value}`);
  }
  return { ok: true, text: rendered.join('\n\n') };
}
