import { parse } from '@inventarch/language';
import type { BundleManifest } from './contracts.js';

/** Root release controls carry only the selected declaration, never arbitrary authored source or authority. */
export function verifyReleaseControl(manifest: BundleManifest, text: string, reject: (message: string) => never): void {
  const path = `.ia/src/releases/${manifest.distribution.split('/')[3]}.ia`;
  const parsed = parse(text, path),
    record = parsed.ast.records[0];
  const refuse = (): never => reject('Root release control differs from its exact declaration and system roots');
  if (
    parsed.diagnostics.some((finding) => finding.severity === 'error') ||
    parsed.ast.records.length !== 1 ||
    !record ||
    record.discriminator !== 'distribution' ||
    record.head.length ||
    record.nested.length ||
    manifest.distribution !== `workspace-system/definition/distribution/${record.name}` ||
    record.sections.length !== 2 ||
    record.sections.some((section) => !['meaning', 'distribution'].includes(section.name))
  )
    return refuse();
  const meaning = record.sections.find((section) => section.name === 'meaning'),
    distribution = record.sections.find((section) => section.name === 'distribution');
  if (
    !meaning ||
    meaning.children.length !== 2 ||
    meaning.children.some(
      (field) =>
        field.kind !== 'field' ||
        !['says', 'answers'].includes(field.key) ||
        field.when ||
        field.children.length ||
        !['scalar', 'string', 'prose'].includes(field.value.kind),
    ) ||
    new Set(meaning.children.map((field) => (field.kind === 'field' ? field.key : ''))).size !== 2 ||
    !distribution ||
    distribution.children.length !== 1
  )
    return refuse();
  const field = distribution.children[0]!;
  if (
    field.kind !== 'field' ||
    field.key !== 'records' ||
    field.when ||
    field.children.length ||
    field.value.kind !== 'list'
  )
    return refuse();
  const roots = field.value.items
    .map((ref) => {
      if (ref.kind !== 'ref' || ref.discriminator !== 'system' || ref.fragment !== undefined) return refuse();
      return `floor/definition/system/${ref.name}`;
    })
    .sort();
  if (JSON.stringify(roots) !== JSON.stringify(manifest.roots)) return refuse();
}
