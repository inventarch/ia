import type { FieldNode, RecordNode } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic, LangCode } from '../diagnostics.js';
import type { FrozenRegistry } from '../registry/types.js';
import { conditionOf } from './conditions.js';
import { misplacedIn } from './placement.js';
import { isRequirementId } from './requirements.js';
import { REQUIREMENT_KINDS } from './types.js';
import type { CompiledEdge, Requirement, RequirementKind } from './types.js';

export interface ContractResult {
  readonly requirements: readonly Requirement[];
  readonly diagnostics: readonly Diagnostic[];
}
export function isRetiredBinds(field: FieldNode): boolean {
  return field.key === 'binds' && field.value.kind === 'string';
}

export function readContract(
  record: RecordNode,
  path: string,
  registry: FrozenRegistry,
  edges: readonly CompiledEdge[],
  refusedBindings: ReadonlySet<'govern' | 'implement'>,
): ContractResult {
  const requirements: Requirement[] = [];
  const diagnostics: Diagnostic[] = [];
  if (record.discriminator !== 'contract' || !registry.registrations.has('contract'))
    return { requirements, diagnostics };
  let retiredBinding = false;
  for (const field of record.head) {
    if (!isRetiredBinds(field)) continue;
    retiredBinding = true;
    diagnostics.push(
      diag(
        'IA-LANG-CONTRACT-BINDS-RETIRED',
        path,
        field.span.line,
        'Quoted binds is retired; use relationships / governs @discriminator name.',
      ),
    );
  }
  for (const section of record.sections) {
    if (section.name === 'schema') {
      diagnostics.push(
        diag(
          'IA-LANG-CONTRACT-SCHEMA-SECTION',
          path,
          section.span.line,
          'Contract schema blocks are retired; write REQ-ID string/prose clauses under inputs, outputs, preconditions, invariants, failures, authority, context or evolution.',
        ),
      );
      continue;
    }
    if (!(REQUIREMENT_KINDS as readonly string[]).includes(section.name)) continue;
    for (const field of section.children) {
      if (field.kind === 'record') continue;
      const refuse = (code: LangCode, message: string): void => {
        diagnostics.push(diag(code, path, field.span.line, message, { endLine: field.span.endLine }));
      };
      if (field.kind === 'field' && field.words[0] === 'when') {
        refuse('IA-LANG-CONDITION-MISPLACED', 'A condition must belong to a requirement clause.');
        continue;
      }
      if (
        field.kind !== 'field' ||
        field.words.length !== 1 ||
        !isRequirementId(field.words[0]!) ||
        (field.value.kind !== 'string' && field.value.kind !== 'prose')
      ) {
        refuse(
          'IA-LANG-REQUIREMENT-MALFORMED',
          'Expected REQ-[A-Z0-9]+(-[A-Z0-9]+)* followed by string or prose text.',
        );
        continue;
      }
      const unsupported = field.children.filter(
        (c) => c.kind !== 'record' && !(c.kind === 'field' && c.words[0] === 'when'),
      );
      if (unsupported.length) {
        const misplaced = misplacedIn(unsupported, path)[0];
        if (misplaced) diagnostics.push(misplaced);
        else refuse('IA-LANG-REQUIREMENT-MALFORMED', 'A requirement admits only a direct child when.');
        continue;
      }
      const condition = conditionOf(field, path);
      if (!condition.ok) {
        diagnostics.push(condition.diagnostic);
        continue;
      }
      requirements.push({
        id: field.words[0]!,
        kind: section.name as RequirementKind,
        text: field.value.text,
        ...(condition.condition === undefined ? {} : { condition: condition.condition }),
        span: field.span,
      });
    }
  }
  if (
    !retiredBinding &&
    !refusedBindings.has('govern') &&
    !edges.some((edge) => edge.predicate === 'govern' && edge.direction === 'out')
  )
    diagnostics.push(
      diag('IA-LANG-CONTRACT-UNBOUND', path, record.span.line, 'A contract requires an outbound governs binding.'),
    );
  diagnostics.sort((a, b) => a.line - b.line);
  return { requirements, diagnostics };
}
