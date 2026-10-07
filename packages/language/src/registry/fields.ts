import type { ChildNode, FieldNode, RecordNode, SectionNode } from '../ast.js';

/**
 * True when `spelling` starts the field's words as a whole key: on an all-words line the words must
 * continue past the spelling (they are the value); on any other line the words must be exactly the spelling.
 */
export function spelledAs(field: FieldNode, spelling: readonly string[]): boolean {
  if (field.words.length < spelling.length) return false;
  if (!spelling.every((word, index) => field.words[index] === word)) return false;
  return field.value.kind === 'scalar' ? field.words.length > spelling.length : field.words.length === spelling.length;
}

/** The first field among `children` spelled `spelling`. */
export function fieldOf(children: readonly ChildNode[], spelling: readonly string[]): FieldNode | undefined {
  for (const child of children) if (child.kind === 'field' && spelledAs(child, spelling)) return child;
  return undefined;
}

/** Every field among `children` spelled `spelling`, in source order. */
export function fieldsOf(children: readonly ChildNode[], spelling: readonly string[]): readonly FieldNode[] {
  return children.filter((child): child is FieldNode => child.kind === 'field' && spelledAs(child, spelling));
}

/** The words after a spelling on an all-words line: the scalar it carries. */
export function restAfter(field: FieldNode, spelling: readonly string[]): readonly string[] {
  return field.words.slice(spelling.length);
}

/** The text of a quoted string value, or undefined for any other value or no field. */
export function stringOf(field: FieldNode | undefined): string | undefined {
  return field !== undefined && field.value.kind === 'string' ? field.value.text : undefined;
}

export function sectionOf(record: RecordNode, name: string): SectionNode | undefined {
  return record.sections.find((section) => section.name === name);
}
