import type { ChildNode, FieldNode, RecordNode } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { PHASES, PRIMITIVES } from '../taxonomy.js';
import type { Phase, Primitive } from '../taxonomy.js';
import { conditionOf } from './conditions.js';
import { misplacedIn } from './placement.js';
import type { Cell } from './types.js';

export interface CellsResult {
  readonly cells: readonly Cell[];
  readonly diagnostics: readonly Diagnostic[];
}
const isField = (node: ChildNode): node is FieldNode => node.kind === 'field';
const isPrimitive = (word: string | undefined): word is Primitive => (PRIMITIVES as readonly unknown[]).includes(word);

export function readCells(record: RecordNode, path: string): CellsResult {
  const cells: Cell[] = [];
  const diagnostics: Diagnostic[] = [];
  const malformed = (node: ChildNode, message: string): void => {
    diagnostics.push(diag('IA-LANG-CELL-MALFORMED', path, node.span.line, message, { endLine: node.span.endLine }));
  };
  const phases = record.sections
    .filter((s) => s.name === 'cognition')
    .flatMap((s) => s.children)
    .filter((c) => c.kind !== 'record');
  const counts = new Map<string, number>();
  for (const node of phases)
    if (isField(node) && node.words.length === 1) counts.set(node.words[0]!, (counts.get(node.words[0]!) ?? 0) + 1);
  for (const node of phases) {
    if (!isField(node) || node.words.length !== 1 || !(PHASES as readonly string[]).includes(node.words[0]!)) {
      malformed(node, `Expected a phase block: ${PHASES.join(', ')}.`);
      continue;
    }
    const phase = node.words[0] as Phase;
    if (counts.get(phase)! > 1) {
      malformed(node, `Repeated ${phase} phase block; every occurrence is refused.`);
      continue;
    }
    const phaseConditions =
      node.when !== undefined
        ? [diag('IA-LANG-CONDITION-MISPLACED', path, node.span.line, 'A phase block cannot have a condition.')]
        : misplacedIn(
            node.children.filter((c) => isField(c) && c.words[0] === 'when'),
            path,
          );
    if (phaseConditions.length) {
      diagnostics.push(...phaseConditions);
      continue;
    }
    if (node.value.kind !== 'block' && node.value.kind !== 'none') {
      malformed(node, 'A phase opens a block, without a value.');
      continue;
    }
    const fields = node.children.filter(isField);
    const primaries = fields.filter((field) => field.words[0] === 'primary');
    if (primaries.length > 1) {
      for (const primary of primaries) malformed(primary, 'Only one primary declaration is permitted per phase.');
      continue;
    }
    const primary = primaries[0];
    let primaryName: Primitive | undefined;
    if (primary) {
      const misplaced = misplacedIn([primary], path);
      if (misplaced.length) {
        diagnostics.push(...misplaced);
        continue;
      }
      if (
        primary.words.length !== 2 ||
        !isPrimitive(primary.words[1]) ||
        primary.value.kind !== 'scalar' ||
        primary.children.some((c) => c.kind !== 'record')
      ) {
        malformed(
          primary,
          `Use primary <Primitive> and a separate <Primitive> means "text" line; primary move is retired. Primitives: ${PRIMITIVES.join(', ')}.`,
        );
        continue;
      }
      primaryName = primary.words[1];
    }
    const means = fields.filter((field) => field.words[1] === 'means' && isPrimitive(field.words[0]));
    const duplicateMeans = new Set(
      means.filter((field) => means.filter((other) => other.words[0] === field.words[0]).length > 1),
    );
    const phaseCells: Cell[] = [];
    for (const field of node.children) {
      if (field.kind === 'record' || field === primary) continue;
      if (!isField(field)) {
        malformed(field, 'A phase contains primary and primitive means lines.');
        continue;
      }
      if (duplicateMeans.has(field)) {
        malformed(field, `Repeated ${field.words[0]} means line; every occurrence is refused.`);
        continue;
      }
      if (
        field.words.length !== 2 ||
        field.words[1] !== 'means' ||
        !isPrimitive(field.words[0]) ||
        (field.value.kind !== 'string' && field.value.kind !== 'prose')
      ) {
        malformed(
          field,
          `Expected <Primitive> means followed by string or prose text. Primitives: ${PRIMITIVES.join(', ')}.`,
        );
        continue;
      }
      const unsupported = field.children.filter((c) => c.kind !== 'record' && !(isField(c) && c.words[0] === 'when'));
      if (unsupported.length) {
        const misplaced = misplacedIn(unsupported, path);
        if (misplaced.length) diagnostics.push(...misplaced);
        else malformed(field, 'A means line admits only a direct child when.');
        continue;
      }
      const condition = conditionOf(field, path);
      if (!condition.ok) {
        diagnostics.push(condition.diagnostic);
        continue;
      }
      phaseCells.push({
        phase,
        primitive: field.words[0],
        primary: field.words[0] === primaryName,
        text: field.value.text,
        ...(condition.condition === undefined ? {} : { condition: condition.condition }),
        span: field.span,
      });
    }
    // A refused line naming this primitive already explains why its means did not survive.
    if (primaryName && !fields.some((field) => field.words[0] === primaryName)) {
      malformed(primary!, `Primary ${primaryName} needs a matching means line.`);
      continue;
    }
    cells.push(...phaseCells);
  }
  diagnostics.sort((a, b) => a.line - b.line);
  return { cells, diagnostics };
}
