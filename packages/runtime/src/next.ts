import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledRecord, EdgeReference } from '@inventarch/language';
import { RuntimeError } from './errors.js';
import { normalizeScopeKey } from './scope-key.js';
import { seatOf } from './seed.js';
import { freeze } from './types.js';

/**
 * The delivery view: what is next under a plan, a milestone or a task. It is computed on each read and never stored:
 * a pure function of the admitted records the `within` scope token reads (the runtime band never among them), the
 * retained snapshot the handle carries, and the evidence an `EvidenceReader` supplies. Every listed record carries
 * five state lines, each with its basis, its requirements with their standing, and one delivery verdict; a missing
 * basis reads `unknown`, never ready.
 */

/** The format of a delivery view; a new definition takes a new tag, never a new meaning for this one. */
export const NEXT_VIEW_FORMAT = 'ia-next-1';
/** The five state lines every listed record carries, in this order. */
export const STATE_LINES = ['accepted', 'admitted', 'realizable', 'realized', 'worked'] as const;
export type StateLine = (typeof STATE_LINES)[number];
/** The words a delivery view is seated at and lists. */
export const WORK_WORDS = ['plan', 'milestone', 'task'] as const;
export type WorkWord = (typeof WORK_WORDS)[number];
/**
 * The next command each refusal and the view name. Until a command that previews a plan ships, a workspace without a
 * plan is pointed at the worked example of the plan word.
 */
export const NEXT_COMMANDS = Object.freeze({
  noPlan: (): string => 'ia vocabulary plan --example',
  choosePlan: (plan: string): string => `ia next --seat ${plan}`,
  dropSeat: (): string => 'ia next',
  position: (identity: string): string => `ia position --seat ${identity}`,
});

/** A request the view cannot answer, with the one command to run instead. */
export class DeliveryRefusal extends RuntimeError {
  constructor(
    message: string,
    readonly next: string,
  ) {
    super('IA-RUNTIME-REQUEST-INVALID', message);
    this.name = 'DeliveryRefusal';
  }
}

export type ObservedVerdict = 'success' | 'refusal' | 'inconclusive';
const VERDICTS: readonly string[] = ['success', 'refusal', 'inconclusive'];
/** One observation as the view reads it: whatever stores it, only these fields reach the view. */
export interface Evidence {
  readonly identity: string;
  /** The placement it was read at: `authored`, or `runtime` for an overlay. */
  readonly placement: string;
  /** The record `evidence.subject` names; null when it names none the reader can resolve. */
  readonly subject: string | null;
  readonly subjectRevision: string | null;
  readonly evaluator: string | null;
  readonly verdict: ObservedVerdict | null;
}
export interface EvidenceRead {
  readonly observations: readonly Evidence[];
  /** The digest of the overlay that supplied observations beside the authored ones; null when there is none. */
  readonly overlay: string | null;
}
/** Where the view's evidence comes from. The default reads authored observations only. */
export interface EvidenceReader {
  readonly name: string;
  read(handle: ReadHandle, within: string): EvidenceRead;
}

type Value = CompiledRecord['sections'][number]['fields'][number];
/** The first text value of `<section>.<key>`; null when the record has none. */
function fieldText(record: CompiledRecord, section: string, key: string): string | null {
  for (const entry of record.sections)
    if (entry.name === section)
      for (const field of entry.fields as readonly Value[])
        if ('key' in field && field.key === key) {
          const value = field.value;
          if (value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose') return value.text;
        }
  return null;
}
/** The records `identity`'s own field `field` refers to, as the scoped directed view resolves them. */
function references(handle: ReadHandle, within: string, identity: string, field: string): readonly string[] {
  return handle
    .directedView(identity, { within })
    .filter(
      (row) => row.kind === 'field-ref' && row.direction === 'out' && row.spelling === field && row.other !== null,
    )
    .map((row) => row.other!);
}

/** An @observation record admitted in the handle, read as evidence: its subject, subject revision, evaluator and verdict. */
export function observationEvidence(handle: ReadHandle, within: string, node: Node): Evidence {
  const verdict = fieldText(node, 'evidence', 'verdict');
  return freeze({
    identity: node.identity,
    placement: node.placement.kind,
    subject: references(handle, within, node.identity, 'evidence.subject')[0] ?? null,
    subjectRevision: fieldText(node, 'evidence', 'subject-revision'),
    evaluator: fieldText(node, 'evidence', 'evaluator'),
    verdict: verdict !== null && VERDICTS.includes(verdict) ? (verdict as ObservedVerdict) : null,
  });
}
/** The default evidence reader: the authored @observation records the scope admits; no overlay. */
export const AUTHORED_EVIDENCE: EvidenceReader = Object.freeze({
  name: 'authored',
  read: (handle: ReadHandle, within: string): EvidenceRead => ({
    observations: handle
      .records({ within })
      .filter((node) => node.discriminator === 'observation' && node.placement.kind === 'authored')
      .map((node) => observationEvidence(handle, within, node)),
    overlay: null,
  }),
});

export interface NextRequest {
  /** A plan, milestone or task identity; omitted, the scope's only authored plan. */
  readonly seat?: string;
}
export interface NextOptions {
  readonly evidence?: EvidenceReader;
}
export interface StateValue {
  readonly line: StateLine;
  readonly value: string;
  readonly basis: string;
}
/** One requirement of a listed record and where it stands. */
export interface Basis {
  /** `require`: a record this one requires; `supersede`: a record that supersedes this one. */
  readonly predicate: 'require' | 'supersede';
  /** The required or superseding record's identity, or the reference as written when it resolves to none. */
  readonly target: string;
  readonly resolved: boolean;
  /** The required record's word; null when the view cannot read it. */
  readonly word: string | null;
  readonly standing: string;
  readonly blocking: boolean;
}
export interface DeliveryVerdict {
  readonly kind: 'clear' | 'blocked' | 'evidence';
  /** `no declared blocker`, `blocked (<basis>)` or `exit evidence recorded (<observation>, evaluator <id>[, self-attributed])`. */
  readonly text: string;
  readonly observation: string | null;
  readonly evaluator: string | null;
  readonly selfAttributed: boolean;
}
export interface DeliveryEntry {
  readonly identity: string;
  readonly word: WorkWord;
  /** A task's milestone; null for a plan or milestone. */
  readonly milestone: string | null;
  /** `work.status` as written: shown, never a basis. */
  readonly status: string | null;
  readonly owner: string | null;
  readonly lines: readonly StateValue[];
  readonly basis: readonly Basis[];
  readonly verdict: DeliveryVerdict;
}
export interface ReviewItem {
  readonly kind: 'cycle';
  readonly records: readonly string[];
  /** `work.owner` of the plan or milestone whose order the cycle breaks; null when it names none. */
  readonly owner: string | null;
}
export interface DeliveryView {
  readonly format: typeof NEXT_VIEW_FORMAT;
  readonly revision: string;
  readonly seat: { readonly identity: string; readonly word: WorkWord; readonly declared: boolean };
  /** The seat home workspace's steward, the participant evidence is self-attributed to. */
  readonly participant: string | null;
  /** The revision of the snapshot the handle retains; null when it retains none. */
  readonly snapshot: string | null;
  readonly evidence: { readonly reader: string; readonly overlay: string | null };
  /**
   * False when a require cycle leaves no order to claim: the records the cycle does not hold up still come first in
   * require order, those it leaves unordered follow in identity order, the cycle is a review item and `next` is null.
   */
  readonly ordered: boolean;
  readonly entries: readonly DeliveryEntry[];
  readonly review: readonly ReviewItem[];
  /** Position at the first task in order with no declared blocker; null when there is none or no order is claimed. */
  readonly next: string | null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isWork = (word: string): word is WorkWord => (WORK_WORDS as readonly string[]).includes(word);
const written = (reference: EdgeReference): string =>
  reference.kind === 'ref' ? `@${reference.discriminator} ${reference.name}` : reference.identity;

interface Reading {
  readonly handle: ReadHandle;
  readonly within: string;
  readonly revision: string;
  /** Every record the scope admits outside the runtime band. */
  readonly nodes: ReadonlyMap<string, Node>;
  readonly evidence: readonly Evidence[];
  readonly previous: ReturnType<ReadHandle['previous']>;
}
type Readiness = 'current' | 'previous' | 'unknown' | 'missing';
interface Chosen {
  readonly evidence: Evidence;
  readonly readiness: Readiness;
}
const RANK = (chosen: Chosen): number =>
  chosen.readiness === 'current'
    ? ['success', 'refusal', 'inconclusive'].indexOf(chosen.evidence.verdict ?? '') + 1 || 4
    : { previous: 5, unknown: 6, missing: 7 }[chosen.readiness];

/**
 * The evidence about a record: observations whose subject is it, and the one its `work.exit-evidence` names, each
 * read against its digest. Preferred: a success at the current digest, then other current verdicts, then the
 * retained snapshot's digest, then neither; identity breaks ties.
 */
function evidenceOf(read: Reading, node: Node): Chosen | undefined {
  const declared = new Set(references(read.handle, read.within, node.identity, 'work.exit-evidence'));
  return read.evidence
    .filter((item) => item.subject === node.identity || declared.has(item.identity))
    .map(
      (item): Chosen => ({
        evidence: item,
        readiness:
          item.subjectRevision === null
            ? 'missing'
            : read.handle.readiness(node.identity, item.subjectRevision, { within: read.within }),
      }),
    )
    .sort((a, b) => RANK(a) - RANK(b) || compare(a.evidence.identity, b.evidence.identity))[0];
}
const recorded = (chosen: Chosen): boolean => chosen.readiness === 'current' && chosen.evidence.verdict === 'success';

/** The @decision grounding `identity` with a choice and an effective revision (the smallest identity); null for none. */
function groundingOf(handle: ReadHandle, within: string, identity: string): string | null {
  return (
    handle
      .directedView(identity, { within })
      .filter((row) => row.predicate === 'ground' && row.direction === 'in' && row.other !== null)
      .map((row) => handle.get(row.other!, { within }))
      .filter(
        (decision): decision is Node =>
          decision !== undefined &&
          decision.discriminator === 'decision' &&
          decision.placement.kind !== 'runtime' &&
          fieldText(decision, 'decision', 'choice') !== null &&
          fieldText(decision, 'decision', 'effective-revision') !== null,
      )
      .map((decision) => decision.identity)
      .sort(compare)[0] ?? null
  );
}
/**
 * The records that supersede `identity`, in identity order: its consented `supersede` rows read from the superseded
 * end (either spelling), through the token and outside the runtime band, each with the decision grounding it.
 */
function supersessionsOf(
  handle: ReadHandle,
  within: string,
  identity: string,
): readonly { readonly by: Node; readonly grounding: string | null }[] {
  const found = new Map<string, Node>();
  for (const row of handle.directedView(identity, { within })) {
    if (row.predicate !== 'supersede' || row.direction !== 'in' || row.other === null || !row.consented) continue;
    const by = handle.get(row.other, { within });
    if (by !== undefined && by.placement.kind !== 'runtime') found.set(by.identity, by);
  }
  return [...found.values()]
    .sort((a, b) => compare(a.identity, b.identity))
    .map((by) => ({ by, grounding: groundingOf(handle, within, by.identity) }));
}

/**
 * Where a spec stands: superseded only when a superseding spec is grounded by a @decision with a choice and an
 * effective revision; a grounded supersession whose superseding spec states `work.replaced-scope` leaves the spec live
 * for the scope it does not replace; an ungrounded one leaves it current.
 */
export function specStanding(
  handle: ReadHandle,
  within: string,
  spec: string,
): { readonly standing: string; readonly blocking: boolean } {
  const standings: { standing: string; blocking: boolean; rank: number }[] = [];
  for (const { by: record, grounding } of supersessionsOf(handle, within, spec)) {
    const by = record.identity;
    if (grounding === null)
      standings.push({ standing: `supersession declared, not grounded (${by})`, blocking: false, rank: 2 });
    else if (fieldText(record, 'work', 'replaced-scope') !== null)
      standings.push({
        standing: `partially superseded by ${by} (grounded by ${grounding})`,
        blocking: false,
        rank: 1,
      });
    else standings.push({ standing: `superseded by ${by} (grounded by ${grounding})`, blocking: true, rank: 0 });
  }
  const chosen = standings.sort((a, b) => a.rank - b.rank || compare(a.standing, b.standing))[0];
  return freeze(
    chosen === undefined
      ? { standing: 'current', blocking: false }
      : { standing: chosen.standing, blocking: chosen.blocking },
  );
}

/**
 * The supersessions of a listed record as blocking bases (`superseded by <record> (<grounding>)`). A superseded plan,
 * milestone or task is where work stopped, so a declared supersession blocks it whether or not a decision grounds it
 * yet; the basis says which. Reading supersession as blocking only once grounded, as a spec's is, changes this one
 * function.
 */
function supersessionBasis(read: Reading, node: Node): readonly Basis[] {
  return supersessionsOf(read.handle, read.within, node.identity)
    .filter(({ by }) => read.nodes.has(by.identity))
    .map(({ by, grounding }) => ({
      predicate: 'supersede',
      target: by.identity,
      resolved: true,
      word: by.discriminator,
      standing: `superseded by ${by.identity} (${grounding === null ? 'supersession declared, not grounded' : `grounded by ${grounding}`})`,
      blocking: true,
    }));
}

/** The records `node` requires: its own `require` rows, resolved or not, and the inverse rows others declare. */
function requirements(read: Reading, node: Node): readonly Basis[] {
  const targets = new Map<string, boolean>();
  for (const edge of node.edges)
    if (edge.predicate === 'require' && edge.direction === 'out')
      targets.set(edge.target ?? written(edge.reference), edge.target !== null);
  for (const row of read.handle.directedView(node.identity, { within: read.within }))
    if (
      row.predicate === 'require' &&
      row.direction === 'out' &&
      row.declaredOn !== node.identity &&
      row.other !== null
    )
      targets.set(row.other, true);
  const basis = [...targets].map(([target, resolved]): Basis => {
    if (!resolved)
      return { predicate: 'require', target, resolved, word: null, standing: 'unresolved', blocking: true };
    const required = read.nodes.get(target);
    if (required === undefined)
      return { predicate: 'require', target, resolved, word: null, standing: 'outside the scope', blocking: true };
    const word = required.discriminator,
      line = (standing: string, blocking: boolean): Basis => ({
        predicate: 'require',
        target,
        resolved,
        word,
        standing,
        blocking,
      });
    if (word === 'decision')
      return fieldText(required, 'decision', 'choice') === null ? line('no choice', true) : line('choice made', false);
    if (word === 'spec') {
      const spec = specStanding(read.handle, read.within, target);
      return line(spec.standing, spec.blocking);
    }
    if (isWork(word)) {
      const chosen = evidenceOf(read, required);
      if (chosen !== undefined && recorded(chosen)) return line(`exit evidence ${chosen.evidence.identity}`, false);
      if (chosen?.readiness === 'previous' && chosen.evidence.verdict === 'success')
        return line(`exit evidence stale (${chosen.evidence.identity})`, true);
      return line('no exit evidence', true);
    }
    return line('resolved', false);
  });
  return basis.sort((a, b) => Number(!a.resolved) - Number(!b.resolved) || compare(a.target, b.target));
}

function linesOf(
  read: Reading,
  node: Node,
  basis: readonly Basis[],
  chosen: Chosen | undefined,
): readonly StateValue[] {
  const warnings = read.handle.report.findings.filter(
      (finding) => (finding as { identity?: string }).identity === node.identity,
    ).length,
    accepted = `admitted against ${node.schema}${warnings === 0 ? '' : `; ${warnings} finding${warnings === 1 ? '' : 's'} name it`}`;
  const previous = read.previous,
    held = previous?.digests.get(node.identity);
  const admitted: Omit<StateValue, 'line'> =
    previous === undefined
      ? { value: 'unknown', basis: 'no retained snapshot' }
      : held === node.digest
        ? { value: 'admitted', basis: `snapshot ${previous.revision} holds this digest` }
        : held === undefined
          ? { value: 'not evaluated', basis: `not in snapshot ${previous.revision}` }
          : { value: 'not evaluated', basis: `snapshot ${previous.revision} holds another digest` };
  const unresolved = basis.filter((item) => !item.resolved),
    unread = basis.filter((item) => item.resolved && item.word === null);
  const realizable: Omit<StateValue, 'line'> =
    unresolved.length > 0
      ? { value: 'unresolved', basis: `unresolved: ${unresolved.map((item) => item.target).join(', ')}` }
      : unread.length > 0
        ? { value: 'unknown', basis: `outside the scope: ${unread.map((item) => item.target).join(', ')}` }
        : basis.length === 0
          ? { value: 'resolved', basis: 'declares no requirement' }
          : { value: 'resolved', basis: `${basis.length} requirement${basis.length === 1 ? '' : 's'} resolved` };
  const realized: Omit<StateValue, 'line'> =
    chosen === undefined
      ? { value: 'unobserved', basis: 'no observation names it' }
      : { value: 'recorded', basis: `${chosen.evidence.identity} (${chosen.evidence.placement})` };
  const id = chosen?.evidence.identity;
  const worked: Omit<StateValue, 'line'> =
    chosen === undefined
      ? { value: 'unobserved', basis: 'no observation names it' }
      : chosen.readiness === 'missing'
        ? { value: 'unknown', basis: `${id} records no subject revision` }
        : chosen.readiness === 'previous'
          ? { value: 'stale', basis: `${id} observed the retained snapshot's digest` }
          : chosen.readiness === 'unknown'
            ? { value: 'unknown', basis: `${id} observed a digest neither the record nor the retained snapshot holds` }
            : chosen.evidence.verdict === null
              ? { value: 'unknown', basis: `${id} records no verdict` }
              : { value: `observed ${chosen.evidence.verdict}`, basis: `${id} at the current digest` };
  const values: Readonly<Record<StateLine, Omit<StateValue, 'line'>>> = {
    accepted: { value: 'accepted', basis: accepted },
    admitted,
    realizable,
    realized,
    worked,
  };
  return STATE_LINES.map((line) => ({ line, ...values[line] }));
}

function entryOf(read: Reading, node: Node, word: WorkWord, participant: string | null): DeliveryEntry {
  const required = requirements(read, node),
    basis = [...required, ...supersessionBasis(read, node)],
    chosen = evidenceOf(read, node),
    blocking = basis.filter((item) => item.blocking);
  let verdict: DeliveryVerdict;
  if (chosen !== undefined && recorded(chosen)) {
    const { identity, evaluator } = chosen.evidence,
      owners = references(read.handle, read.within, node.identity, 'work.owner-agent'),
      self = evaluator !== null && (owners.includes(evaluator) || evaluator === participant);
    verdict = {
      kind: 'evidence',
      text: `exit evidence recorded (${identity}, evaluator ${evaluator ?? 'unknown'}${self ? ', self-attributed' : ''})`,
      observation: identity,
      evaluator,
      selfAttributed: self,
    };
  } else
    verdict =
      blocking.length > 0
        ? {
            kind: 'blocked',
            text: `blocked (${blocking.map((item) => (item.predicate === 'supersede' ? item.standing : `${item.target} ${item.standing}`)).join('; ')})`,
            observation: null,
            evaluator: null,
            selfAttributed: false,
          }
        : { kind: 'clear', text: 'no declared blocker', observation: null, evaluator: null, selfAttributed: false };
  return {
    identity: node.identity,
    word,
    milestone:
      word === 'task' ? (references(read.handle, read.within, node.identity, 'work.milestone')[0] ?? null) : null,
    status: fieldText(node, 'work', 'status'),
    owner: fieldText(node, 'work', 'owner'),
    lines: linesOf(read, node, required, chosen),
    basis,
    verdict,
  };
}

/** The records of `word` whose field `field` refers to `identity`, in identity order. */
function referrers(read: Reading, identity: string, field: string, word: WorkWord): readonly string[] {
  return [
    ...new Set(
      read.handle
        .referencedBy(identity, { within: read.within })
        .filter((reference) => reference.field === field && read.nodes.get(reference.from)?.discriminator === word)
        .map((reference) => reference.from),
    ),
  ].sort(compare);
}
/**
 * `ids` in require order (a required record first; the smallest identity among the ready ones next). A cycle leaves
 * its records and those after them unordered: they follow in identity order and the cycle is a review item.
 */
function ordered(
  read: Reading,
  ids: readonly string[],
  owner: string | null,
): { readonly order: readonly string[]; readonly review: ReviewItem | null } {
  const members = new Set(ids),
    before = new Map<string, readonly string[]>(
      ids.map((id) => [
        id,
        requirements(read, read.nodes.get(id)!)
          .filter((item) => item.resolved && members.has(item.target) && item.target !== id)
          .map((item) => item.target),
      ]),
    );
  const order: string[] = [],
    placed = new Set<string>();
  for (;;) {
    const ready = ids.filter((id) => !placed.has(id) && before.get(id)!.every((other) => placed.has(other)));
    if (ready.length === 0) break;
    const first = [...ready].sort(compare)[0]!;
    order.push(first);
    placed.add(first);
  }
  const left = ids.filter((id) => !placed.has(id)).sort(compare);
  if (left.length === 0) return { order, review: null };
  // A record lies on a cycle when it reaches itself through the records left unordered.
  const onCycle = left.filter((start) => {
    const seen = new Set<string>(),
      stack = [...before.get(start)!];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === start) return true;
      if (seen.has(id) || placed.has(id)) continue;
      seen.add(id);
      stack.push(...before.get(id)!);
    }
    return false;
  });
  return { order: [...order, ...left], review: { kind: 'cycle', records: onCycle, owner } };
}

function seatOfView(read: Reading, request: NextRequest): { node: Node; word: WorkWord; declared: boolean } {
  if (request.seat === undefined) {
    const plans = [...read.nodes.values()]
      .filter((node) => node.discriminator === 'plan' && node.placement.kind === 'authored')
      .map((node) => node.identity)
      .sort(compare);
    if (plans.length === 0)
      throw new DeliveryRefusal(
        'No authored @plan is admitted in the scope and no seat was given',
        NEXT_COMMANDS.noPlan(),
      );
    if (plans.length > 1)
      throw new DeliveryRefusal(
        `${plans.length} authored plans are admitted in the scope (${plans.join(', ')}); name one as the seat`,
        NEXT_COMMANDS.choosePlan(plans[0]!),
      );
    return { node: read.nodes.get(plans[0]!)!, word: 'plan', declared: false };
  }
  const seat: unknown = request.seat;
  if (typeof seat !== 'string' || seat === '')
    throw new DeliveryRefusal('The seat must be a plan, milestone or task identity', NEXT_COMMANDS.dropSeat());
  // Read through the token only: a seat outside the scope and one that names nothing get the same refusal.
  const node = read.nodes.get(seat);
  if (node === undefined)
    throw new DeliveryRefusal(`Seat ${seat} names no record the scope reads`, NEXT_COMMANDS.dropSeat());
  if (!isWork(node.discriminator))
    throw new DeliveryRefusal(
      `Seat ${seat} is a @${node.discriminator}, not a plan, milestone or task`,
      NEXT_COMMANDS.position(seat),
    );
  return { node, word: node.discriminator, declared: true };
}

/**
 * The delivery view at a plan, milestone or task (`request.seat`; omitted, the scope's only authored plan), read
 * through the `within` scope token. A plan lists itself, then its milestones in require order, each followed by its
 * tasks in require order; a milestone lists itself and its tasks; a task lists itself. Evidence comes from
 * `options.evidence` (default `AUTHORED_EVIDENCE`). Nothing is written.
 */
export function next(
  handle: ReadHandle,
  within: string,
  request: NextRequest = {},
  options: NextOptions = {},
): DeliveryView {
  const reader = options.evidence ?? AUTHORED_EVIDENCE,
    snapshot = handle.snapshot({ within }),
    supplied = reader.read(handle, within);
  const read: Reading = {
    handle,
    within,
    revision: snapshot.revision,
    nodes: new Map(
      snapshot.records.filter((node) => node.placement.kind !== 'runtime').map((node) => [node.identity, node]),
    ),
    evidence: supplied.observations.map((item) => freeze({ ...item })),
    previous: handle.previous({ within }),
  };
  const seat = seatOfView(read, request),
    home = seatOf(handle, within, normalizeScopeKey({ seat: seat.node.identity })).home,
    participant =
      home === null || !read.nodes.has(home)
        ? null
        : (references(handle, within, home, 'composition.steward')[0] ?? null);
  const listed: { identity: string; word: WorkWord }[] = [],
    review: ReviewItem[] = [];
  const tasksOf = (milestone: string) => {
    const result = ordered(
      read,
      referrers(read, milestone, 'work.milestone', 'task'),
      fieldText(read.nodes.get(milestone)!, 'work', 'owner'),
    );
    if (result.review !== null) review.push(result.review);
    for (const identity of result.order) listed.push({ identity, word: 'task' });
  };
  if (seat.word === 'plan') {
    listed.push({ identity: seat.node.identity, word: 'plan' });
    const milestones = ordered(
      read,
      referrers(read, seat.node.identity, 'work.plan', 'milestone'),
      fieldText(seat.node, 'work', 'owner'),
    );
    if (milestones.review !== null) review.push(milestones.review);
    for (const milestone of milestones.order) {
      listed.push({ identity: milestone, word: 'milestone' });
      tasksOf(milestone);
    }
  } else if (seat.word === 'milestone') {
    listed.push({ identity: seat.node.identity, word: 'milestone' });
    tasksOf(seat.node.identity);
  } else listed.push({ identity: seat.node.identity, word: 'task' });
  const entries = listed.map(({ identity, word }) => entryOf(read, read.nodes.get(identity)!, word, participant)),
    // A cycle leaves no order to claim, so no task is first.
    first =
      review.length > 0 ? undefined : entries.find((item) => item.word === 'task' && item.verdict.kind === 'clear');
  return freeze({
    format: NEXT_VIEW_FORMAT,
    revision: read.revision,
    seat: { identity: seat.node.identity, word: seat.word, declared: seat.declared },
    participant,
    snapshot: read.previous?.revision ?? null,
    evidence: { reader: reader.name, overlay: supplied.overlay },
    ordered: review.length === 0,
    entries,
    review,
    next: first === undefined ? null : NEXT_COMMANDS.position(first.identity),
  });
}
