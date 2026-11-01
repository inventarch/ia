import type { RecordNode } from '../ast.js';
import { WORK_COST, meter, others } from '../bounded.js';
import { resolveKey } from '../compile/values.js';
import type { Spelling } from '../compile/values.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { conditionOf } from './conditions.js';
import { misplacedIn } from './placement.js';
import type { Variant } from './types.js';

export interface VariantsResult {
  readonly variants: readonly Variant[];
  readonly diagnostics: readonly Diagnostic[];
}

export function readVariants(record: RecordNode, path: string, spellings: readonly Spelling[]): VariantsResult {
  const variants: Variant[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const section of record.sections) {
    if (section.name !== 'governance') continue;
    for (const field of section.children) {
      if (field.kind !== 'field') continue;
      const { key, value } = resolveKey(field, spellings);
      if (key === 'severity' || field.words[0] === 'when') {
        const misplaced = misplacedIn([field], path)[0];
        if (misplaced) diagnostics.push(misplaced);
        continue;
      }
      const condition = conditionOf(field, path);
      if (!condition.ok) {
        diagnostics.push(condition.diagnostic);
        continue;
      }
      const misplaced = misplacedIn(
        field.children.filter((c) => !(c.kind === 'field' && c.words[0] === 'when')),
        path,
      )[0];
      if (misplaced) {
        diagnostics.push(misplaced);
        continue;
      }
      meter()?.product();
      variants.push({
        key,
        value,
        ...(condition.condition === undefined ? {} : { condition: condition.condition }),
        span: field.span,
      });
    }
  }
  const groups = new Map<string, Variant[]>();
  for (const variant of variants) {
    const key = JSON.stringify([variant.key, variant.condition ?? []]);
    const group = groups.get(key);
    if (group) group.push(variant);
    else groups.set(key, [variant]);
  }
  // A family of clauses is judged pair by pair (compliance COMP-VARIANT), which each pair pays for here.
  const families = new Map<string, number>();
  for (const variant of variants) families.set(variant.key, (families.get(variant.key) ?? 0) + 1);
  for (const clauses of families.values()) meter()?.charge((clauses * (clauses - 1) * WORK_COST.clausePair) / 2);
  const refused = new Set<Variant>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const variant of group) {
      refused.add(variant);
      diagnostics.push(
        diag(
          'IA-LANG-VARIANT-DUPLICATE',
          path,
          variant.span.line,
          `Duplicate ${variant.key} condition; other occurrences at ${others(group, variant, (v) => `${path}:${v.span.line}`)}.`,
          { endLine: variant.span.endLine },
        ),
      );
    }
  }
  diagnostics.sort((a, b) => a.line - b.line);
  return { variants: variants.filter((v) => !refused.has(v)), diagnostics };
}
