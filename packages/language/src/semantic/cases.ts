import type { FieldNode, RecordNode, SectionNode } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import type { FrozenRegistry } from '../registry/types.js';
import { misplacedIn } from './placement.js';
import { isRequirementId } from './requirements.js';
import type { CompiledEdge } from './types.js';

const KINDS = ['success', 'failure', 'refusal', 'resumption', 'escalation'] as const;
const REQUIRED = ['kind', 'given', 'request', 'expected', 'evaluator'] as const;
/** valid concerns only this reader's checks; earlier edge/parse errors still prevent admission. */
export interface CaseResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

function scenarioDiagnostics(section: SectionNode, path: string): readonly Diagnostic[] {
  const fail = (line: number, message: string): readonly Diagnostic[] => [
    diag('IA-LANG-CASE-MALFORMED', path, line, message),
  ];
  const fields = section.children.filter((c): c is FieldNode => c.kind === 'field');
  const verdict = fields.find((field) => field.words[0] === 'verdict');
  if (verdict) return fail(verdict.span.line, 'A case cannot carry verdict data; results are run evidence.');
  const misplaced = misplacedIn(section.children, path)[0];
  if (misplaced) return [misplaced];
  const item = section.children.find((c) => c.kind === 'item');
  if (item) return fail(item.span.line, 'Scenario data uses named fields, not item rows.');
  for (const key of REQUIRED) {
    const named = fields.filter((field) => field.key === key);
    if (named.length === 0) return fail(section.span.line, `Scenario requires ${key}.`);
    if (named.length > 1)
      return named.map((field) =>
        diag('IA-LANG-CASE-MALFORMED', path, field.span.line, `Scenario ${key} must be written once.`),
      );
    const field = named[0]!;
    if (field.children.some((child) => child.kind !== 'record'))
      return fail(field.span.line, `Scenario ${key} cannot have a child block.`);
    if (key === 'kind') {
      if (
        (field.value.kind !== 'scalar' && field.value.kind !== 'string') ||
        !(KINDS as readonly string[]).includes(field.value.text)
      )
        return fail(field.span.line, `Scenario kind must be ${KINDS.join(', ')}.`);
    } else if (field.value.kind !== 'string' && field.value.kind !== 'prose')
      return fail(field.span.line, `Scenario ${key} requires string or prose text.`);
  }
  return [];
}

function bindsRequirement(edge: CompiledEdge, registry: FrozenRegistry): boolean {
  if (
    edge.predicate !== 'implement' ||
    edge.direction !== 'out' ||
    edge.fragment === undefined ||
    !isRequirementId(edge.fragment)
  )
    return false;
  const contract = registry.registrations.get('contract');
  if (!contract) return false;
  if (edge.reference.kind === 'ref') return edge.reference.discriminator === 'contract';
  const slots = edge.reference.identity.split('/');
  return (
    slots.length === 4 &&
    slots[0] === contract.system &&
    slots[1] === contract.kind &&
    contract.facets.includes(slots[2]!) &&
    /^[a-z][a-z0-9-]*$/.test(slots[3]!)
  );
}

/** Structural validation only. Raw structured fields remain preview data; no verdict is produced. */
export function validateCase(
  record: RecordNode,
  path: string,
  registry: FrozenRegistry,
  edges: readonly CompiledEdge[],
  refusedBindings: ReadonlySet<'govern' | 'implement'>,
): CaseResult {
  if (record.discriminator !== 'case' || !registry.registrations.has('case')) return { valid: true, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  for (const field of record.head)
    if (field.words[0] === 'verdict')
      diagnostics.push(
        diag(
          'IA-LANG-CASE-MALFORMED',
          path,
          field.span.line,
          'A case cannot carry verdict data; results are run evidence.',
        ),
      );
  for (const section of record.sections)
    if (section.name === 'verdict')
      diagnostics.push(
        diag(
          'IA-LANG-CASE-MALFORMED',
          path,
          section.span.line,
          'A case cannot carry a verdict block; results are run evidence.',
        ),
      );
  const sections = record.sections.filter((section) => section.name === 'scenario');
  if (sections.length === 0)
    diagnostics.push(
      diag('IA-LANG-CASE-MALFORMED', path, record.span.line, 'A case requires exactly one scenario block.'),
    );
  else if (sections.length > 1)
    for (const section of sections)
      diagnostics.push(
        diag(
          'IA-LANG-CASE-MALFORMED',
          path,
          section.span.line,
          'A case requires exactly one scenario block; every duplicate is refused.',
        ),
      );
  else diagnostics.push(...scenarioDiagnostics(sections[0]!, path));
  if (!refusedBindings.has('implement') && !edges.some((edge) => bindsRequirement(edge, registry)))
    diagnostics.push(
      diag(
        'IA-LANG-CASE-UNBOUND',
        path,
        record.span.line,
        'A case requires an outbound implements binding to a registered contract with a REQ-ID fragment.',
      ),
    );
  diagnostics.sort((a, b) => a.line - b.line);
  return { valid: diagnostics.length === 0, diagnostics };
}
