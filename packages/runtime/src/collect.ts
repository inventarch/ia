import type { Phase } from '@inventarch/language';
import { GraphUsageError, cell, effectiveSeverity, selectors, variants } from '@inventarch/graph';
import type { ReadHandle, Scope } from '@inventarch/db';
import { prepareCoordinate } from './coordinate.js';
import type { PreparedCoordinate } from './coordinate.js';
import { mentions, resolveMention, subjectMention } from './mentions.js';
import { clausesOf, purposeOf, recordText } from './render.js';
import type { ContextOptions, ContextRequest, Entry, Omission, Refusal } from './types.js';
import { freeze } from './types.js';
import { RuntimeError } from './errors.js';

export interface Candidate {
  readonly entry: Entry;
  readonly blocking: boolean;
}
export interface Collected {
  readonly scope: Scope;
  readonly coordinate: PreparedCoordinate;
  readonly candidates: readonly Candidate[];
  readonly omitted: readonly Omission[];
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function entryOrder(a: Entry, b: Entry): number {
  return (
    a.step - b.step ||
    (a.step >= 4 ? b.score - a.score : 0) ||
    b.band - a.band ||
    compare(a.identity, b.identity) ||
    compare(a.address, b.address)
  );
}
export function collect(handle: ReadHandle, request: ContextRequest, options: ContextOptions): Collected | Refusal {
  if (typeof request.within !== 'string' || request.within.length === 0)
    throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', 'Runtime reads require an explicit scope token');
  const coordinate = prepareCoordinate(request.text, request.coordinate, options),
    values = coordinate.values;
  // Validate the incoming token even when the coordinate is incomplete.
  handle.snapshot({
    within: request.within,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
  });
  const missing = ['phase', 'primitive'].filter((axis) => values[axis as 'phase' | 'primitive'] === undefined);
  if (missing.length > 0)
    return freeze({
      ok: false,
      code: 'coordinate-incomplete',
      escalation: 'coordinate-incomplete',
      message: `Declare ${missing.join(', ')} on the request`,
      missing,
    });
  const scope = handle.resolveScope({
    within: request.within,
    phase: values.phase as Phase,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
  });
  const nodes = handle.records({ within: scope.token }),
    hits = handle.search(request.text, { within: scope.token });
  const textScores = new Map(hits.map((hit) => [hit.identity, hit.score])),
    maximum = Math.max(0, ...hits.map((hit) => hit.score));
  const candidates: Candidate[] = [],
    omitted: Omission[] = [],
    mentioned = new Map<string, string>();
  const references = [
    ...(request.subject === undefined ? [] : [subjectMention(request.subject)]),
    ...mentions(request.text),
  ];
  for (const mention of references) {
    const resolved = resolveMention(handle, scope.token, nodes, mention);
    if ('detail' in resolved) omitted.push({ address: mention.address, reason: 'unresolved', detail: resolved.detail });
    else mentioned.set(resolved.node.identity, mention.address);
  }
  for (const node of nodes) {
    const match = selectors(node, values);
    if (match.status === 'disqualified') {
      const contradictions = node.selectors.flatMap((group) =>
        group
          .filter((t) => values[t.axis] !== undefined && values[t.axis] !== t.value)
          .map((t) => `${t.axis} is ${t.value}, request is ${values[t.axis]}`),
      );
      omitted.push({ address: node.identity, reason: 'disqualified', detail: [...new Set(contradictions)].join('; ') });
      continue;
    }
    const selected = variants(node, values);
    if (selected.diagnostics.length > 0)
      throw new GraphUsageError('IA-GRAPH-VARIANT-AMBIGUOUS', selected.diagnostics[0]!.message);
    const clauses = clausesOf(node, selected.selected),
      selectedCell = cell(node, values);
    const base = { identity: node.identity, kind: node.kind, band: node.band };
    let delivered = false;
    if (selectedCell !== undefined) {
      const value = selectedCell.cell,
        purpose = options.purpose === true ? purposeOf(node) : undefined;
      candidates.push({
        blocking: false,
        entry: {
          ...base,
          address: `${node.identity}#${value.phase}/${value.primitive}`,
          step: selectedCell.kind === 'exact' ? 1 : 2,
          score: 0,
          why:
            selectedCell.kind === 'exact'
              ? 'Exact phase/primitive cell'
              : 'Primary cell fallback for the requested phase',
          text: value.text,
          citations: [{ path: node.source.path, ...value.span }],
          ...(value.condition === undefined ? {} : { condition: value.condition }),
          ...(purpose === undefined ? {} : { purpose }),
        },
      });
      delivered = true;
    }
    if (node.kind === 'governance') {
      const severity = effectiveSeverity(node.dimensions, values);
      candidates.push({
        blocking: severity === 'blocking',
        entry: {
          ...base,
          address: node.identity,
          step: 3,
          score: 0,
          why: 'Applicable governance with maximum-specificity obligations',
          ...(severity === undefined ? {} : { severity }),
          text: recordText(node, values, clauses),
          clauses,
          citations: [node.source, ...clauses.map((clause) => clause.citation)],
        },
      });
      delivered = true;
    }
    if (delivered) continue;
    const score = match.specificity + (maximum === 0 ? 0 : (textScores.get(node.identity) ?? 0) / maximum);
    const step =
      match.status === 'matched' ? 4 : mentioned.has(node.identity) ? 5 : textScores.has(node.identity) ? 6 : undefined;
    if (step === undefined) continue;
    candidates.push({
      blocking: false,
      entry: {
        ...base,
        address: node.identity,
        step,
        score,
        why:
          step === 4
            ? `Satisfied selector group (${match.specificity} terms)`
            : step === 5
              ? `Resolved subject or mention: ${mentioned.get(node.identity)}`
              : 'Scoped topical text match',
        text: recordText(node, values, clauses),
        citations: [node.source],
        ...(clauses.length === 0 ? {} : { clauses }),
      },
    });
  }
  candidates.sort((a, b) => entryOrder(a.entry, b.entry));
  const uniqueOmissions = [...new Map(omitted.map((item) => [JSON.stringify(item), item])).values()];
  return { scope, coordinate, candidates, omitted: uniqueOmissions };
}
