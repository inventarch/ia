import { VERB_PHRASES, verbOf } from '@inventarch/language';
import type { ReadHandle } from '@inventarch/db';
import { collect, entryOrder } from './collect.js';
import { RuntimeError } from './errors.js';
import { freeze } from './types.js';
import type {
  Budget,
  ContextOptions,
  ContextRequest,
  ContextResult,
  Entry,
  Omission,
  Packet,
  Tokenizer,
} from './types.js';

export const DEFAULT_TOKENIZER: Tokenizer = Object.freeze({
  name: 'byte-estimate',
  count: (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
});
export function context(
  handle: ReadHandle,
  request: ContextRequest,
  budget: Budget,
  options: ContextOptions = {},
): ContextResult {
  if (
    budget === null ||
    typeof budget !== 'object' ||
    !Number.isSafeInteger(budget.tokens) ||
    !Number.isSafeInteger(budget.records) ||
    budget.tokens < 0 ||
    budget.records < 0
  )
    throw new RuntimeError('IA-RUNTIME-BUDGET-INVALID', 'Budget tokens and records must be nonnegative safe integers');
  const result = collect(handle, request, options);
  if ('ok' in result) return result;
  if (options.ranking !== undefined && options.ranking !== 'native' && options.ranking !== 'topical')
    throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', 'Context ranking must be native or topical');
  const scores =
    options.ranking === 'topical'
      ? new Map(handle.search(request.text, { within: result.scope.token }).map((hit) => [hit.identity, hit.score]))
      : new Map<string, number>();
  const candidates =
    options.ranking === 'topical'
      ? [...result.candidates].sort(
          (a, b) =>
            Number(b.blocking) - Number(a.blocking) ||
            (scores.get(b.entry.identity) ?? 0) - (scores.get(a.entry.identity) ?? 0) ||
            entryOrder(a.entry, b.entry),
        )
      : result.candidates;
  const tokenizer = options.tokenizer ?? DEFAULT_TOKENIZER;
  if (typeof tokenizer.name !== 'string' || tokenizer.name.length === 0)
    throw new RuntimeError('IA-RUNTIME-BUDGET-INVALID', 'The text estimator needs a nonempty name');
  const sizes = new Map<Entry, number>();
  const measure = (text: string): number => {
    const count = tokenizer.count(text);
    if (!Number.isSafeInteger(count) || count < 0 || (text.length > 0 && count === 0))
      throw new RuntimeError(
        'IA-RUNTIME-BUDGET-INVALID',
        'The text estimator must return nonnegative safe integer counts, positive for nonempty text',
      );
    return count;
  };
  for (const { entry } of candidates)
    sizes.set(entry, measure(entry.text) + (entry.purpose === undefined ? 0 : measure(entry.purpose)));
  const selected = new Set<Entry>(),
    identities = new Set<string>(),
    blockingSizes = new Map<string, number>();
  let tokensUsed = 0;
  for (const { entry, blocking } of candidates)
    if (blocking) {
      selected.add(entry);
      identities.add(entry.identity);
      tokensUsed += sizes.get(entry)!;
      blockingSizes.set(entry.identity, (blockingSizes.get(entry.identity) ?? 0) + sizes.get(entry)!);
    }
  if (tokensUsed > budget.tokens || identities.size > budget.records) {
    let remainingTokens = tokensUsed,
      remainingRecords = identities.size;
    const reduction: string[] = [];
    for (const [identity, count] of [...blockingSizes].sort(
      ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
    )) {
      if (remainingTokens <= budget.tokens && remainingRecords <= budget.records) break;
      reduction.push(identity);
      remainingTokens -= count;
      remainingRecords--;
    }
    return freeze({
      ok: false,
      code: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
      message:
        'The budget cannot hold all applicable blocking governance; narrow the authorized scope or increase the budget',
      required: { tokens: tokensUsed, records: identities.size },
      reduction,
    });
  }
  const omitted: Omission[] = [...result.omitted];
  for (const { entry } of candidates) {
    if (selected.has(entry)) continue;
    const count = sizes.get(entry)!;
    if (
      tokensUsed + count > budget.tokens ||
      identities.size + (identities.has(entry.identity) ? 0 : 1) > budget.records
    ) {
      omitted.push({
        address: entry.address,
        reason: 'budget',
        detail: `Entry requires ${count} text tokens and ${identities.has(entry.identity) ? 0 : 1} additional record slots`,
      });
      continue;
    }
    selected.add(entry);
    identities.add(entry.identity);
    tokensUsed += count;
  }
  const included = candidates.filter(({ entry }) => selected.has(entry)).map(({ entry }) => entry);
  const follow =
    request.follow ??
    result.coordinate.focus.predicates.map(
      (predicate) =>
        VERB_PHRASES.find((phrase) => {
          const verb = verbOf(phrase)!;
          return verb.direction === 'out' && verb.predicate === predicate;
        })!,
    );
  const walk = handle.traverse({
    start: [...identities],
    depth: 1,
    within: result.scope.token,
    follow,
    coordinate: result.coordinate.values,
  });
  const packet: Packet = {
    ...(options.ranking === 'topical' ? { ranking: 'topical' as const } : {}),
    revision: result.scope.revision,
    scope: result.scope,
    coordinate: result.coordinate,
    included,
    omitted,
    followed: walk.edges,
    gated: walk.gated,
    dangling: walk.dangling,
    limits: { ...budget, tokensUsed, recordsUsed: identities.size, estimator: tokenizer.name, envelopeBytes: 0 },
  };
  return freeze({
    ok: true,
    packet: { ...packet, limits: { ...packet.limits, envelopeBytes: envelopeBytes(packet) } },
  });
}
/**
 * The envelope estimate of a packet as it is answered: its JSON bytes with `limits.envelopeBytes` 0 and without
 * delivered text and purpose bytes, which are already accounted for in tokensUsed. It includes citations, scope and
 * omissions. The Door's version 1 `context` answers the packet in 1.1.0's shape and estimates that shape (R12).
 */
export function envelopeBytes<P extends { readonly included: readonly Entry[]; readonly limits: Packet['limits'] }>(
  packet: P,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...packet,
      included: packet.included.map((entry) => ({
        ...entry,
        text: '',
        ...(entry.purpose === undefined ? {} : { purpose: '' }),
      })),
      limits: { ...packet.limits, envelopeBytes: 0 },
    }),
    'utf8',
  );
}
