import { CONDITION_AXES } from '@inventarch/language';
import type { ConditionAxis } from '@inventarch/language';
import { selectors } from '@inventarch/graph';
import type { ReadHandle, Scope } from '@inventarch/db';
import { collect } from './collect.js';
import { RuntimeError } from './errors.js';
import { freeze } from './types.js';
import type { ContextOptions, ContextRequest, Entry, Refusal } from './types.js';

export interface SelectOptions extends ContextOptions {
  readonly requiredAxes?: readonly ConditionAxis[];
}
export type SelectResult =
  | {
      readonly ok: true;
      readonly selection: { readonly revision: string; readonly scope: Scope; readonly entry: Entry };
    }
  | Refusal;
export function select(
  handle: ReadHandle,
  request: ContextRequest,
  candidates: readonly string[],
  options: SelectOptions = {},
): SelectResult {
  const required = options.requiredAxes ?? [];
  if (required.some((axis) => !(CONDITION_AXES as readonly string[]).includes(axis)))
    throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', `Required axes must be among ${CONDITION_AXES.join(', ')}`);
  const collected = collect(handle, request, options);
  if ('ok' in collected) return collected;
  const wanted = new Set(candidates),
    coordinate = collected.coordinate.values;
  const missing = new Set<string>(required.filter((axis) => coordinate[axis] === undefined));
  for (const node of handle.records({ within: collected.scope.token })) {
    if (!wanted.has(node.identity) || node.selectors.length === 0 || selectors(node, coordinate).status !== 'neutral')
      continue;
    for (const group of node.selectors) {
      if (group.some((term) => coordinate[term.axis] !== undefined && coordinate[term.axis] !== term.value)) continue;
      for (const term of group) if (coordinate[term.axis] === undefined) missing.add(term.axis);
    }
  }
  if (missing.size > 0)
    return freeze({
      ok: false,
      code: 'coordinate-incomplete',
      escalation: 'coordinate-incomplete',
      message: `Exclusive selection requires ${[...missing].sort().join(', ')}`,
      missing: [...missing].sort(),
    });
  const eligible = collected.candidates.map((c) => c.entry).filter((entry) => wanted.has(entry.identity));
  const top = eligible[0];
  if (top === undefined)
    return freeze({
      ok: false,
      code: 'no-candidate',
      escalation: 'no-candidate',
      message: 'No supplied candidate is eligible in this scope and coordinate',
    });
  const tied = new Set(
    eligible
      .filter((entry) => entry.step === top.step && entry.score === top.score && entry.band === top.band)
      .map((entry) => entry.identity),
  );
  if (tied.size > 1)
    return freeze({
      ok: false,
      code: 'deny-wins-tie',
      escalation: 'deny-wins-tie',
      message: `Equal leading step, score and band: ${[...tied].sort().join(', ')}`,
    });
  return freeze({ ok: true, selection: { revision: collected.scope.revision, scope: collected.scope, entry: top } });
}
