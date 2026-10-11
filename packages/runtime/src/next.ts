import { valuesFor } from '@inventarch/language';
import type { ConditionAxis, EdgeReference, Term } from '@inventarch/language';
import { conditionHolds } from '@inventarch/graph';
import type { Coordinate, DirectedEdgeRow, DirectedRow } from '@inventarch/graph';
import type { ReadHandle, Readiness } from '@inventarch/db';
import { RUNTIME_CODES } from './errors.js';
import type { RuntimeCode } from './errors.js';
import { statedText } from './render.js';
import { freeze } from './types.js';

/**
 * The delivery view: position-and-projection §9 step 2, the five lines of §10 and design row 21, which `ia next` reads.
 *
 * One @plan, its milestones and their tasks in one prerequisites-first order, each task with the basis lines of its
 * effective prerequisites, one verdict and the five state lines, then the review items and the next command. It is a
 * pure function of the admitted records one scope reads: computed per read, never stored, and nothing is written.
 *
 * A task's effective prerequisites are the records it requires plus those its milestone requires; work-system consents
 * `require` to a @task, @milestone or @decision only, so no @spec is ever one. Exit evidence is an @observation whose
 * `evidence.verdict` is success, whose `evidence.subject` names the record or which the record's `work.exit-evidence`
 * names, and whose `evidence.subject-revision` reads `current` under the handle's `readiness` (db D08). A record's own
 * `work.status` is printed as self-declared and is never a basis.
 *
 * What the scope does not read is never a basis either (design §10, IM-24). A requirement a record declares whose
 * answer this scope does not read blocks, as unknown; and no milestone is satisfied through its tasks, nor is every
 * task said to have exit evidence, while some task may go unread: on a narrowed scope, and on a whole-workspace scope
 * (db PT5, the only one that may disclose admission findings) while admission refuses a @task, or a whole file (D03).
 *
 * A relation row that carries a condition, such as `grounds @task guide when phase is act`, counts only where its
 * condition holds at the coordinate the scope binds (decision conditional-relations-in-delivery), decided as graph
 * traversal decides it; where the coordinates the scope may still be completed to disagree on it, as on an axis the
 * scope binds no value for, the row is conditional and its basis unknown, so it is never satisfied: a conditional
 * requirement blocks as unknown and orders nothing, and the intent read through a conditional grounding or supersession
 * is unknown unless it reads the same at every such coordinate.
 */

export type NextCode = Extract<RuntimeCode, `IA-RUNTIME-NEXT-${string}`>;
/** The refusal codes the delivery view can return; each is registered in RUNTIME_CODES. */
export const NEXT_CODES: readonly NextCode[] = Object.freeze(
  RUNTIME_CODES.filter((code): code is NextCode => code.startsWith('IA-RUNTIME-NEXT-')),
);

/** One declared `require` row of a refused cycle: `from` requires `to`, stated on `declaredOn` at `path`:`line`. */
export interface CycleRow {
  readonly from: string;
  readonly to: string;
  readonly declaredOn: string;
  readonly path: string;
  readonly line: number;
}
export interface NextRefusal {
  readonly ok: false;
  readonly code: NextCode;
  readonly message: string;
  /** Exactly one catalog command with closed arguments (design row 27). */
  readonly next: string;
  /** IA-RUNTIME-NEXT-AMBIGUOUS: the admitted @plan identities at band 100, in identity order. */
  readonly plans?: readonly string[];
  /** IA-RUNTIME-NEXT-CYCLE: the declared rows of one cycle, each row's `to` requiring the next row's. */
  readonly cycle?: readonly CycleRow[];
}

/** One effective prerequisite of a task, its own or inherited from its milestone, with its basis line. */
export interface Prerequisite {
  /** The required record, or the reference as authored when no admitted record answers the requirement. */
  readonly target: string;
  /** The required record's word; absent when no admitted record answers the requirement. */
  readonly word?: string;
  /** The milestone whose requirement the task inherits; absent for the task's own. */
  readonly via?: string;
  readonly satisfied: boolean;
  readonly basis: string;
}
export type StateDimension = 'intent' | 'definition' | 'realizable' | 'realized' | 'worked';
/** One of the five independent state lines of design §10: a value and the only basis it is read from. */
export interface StateLine {
  readonly dimension: StateDimension;
  readonly value: string;
  readonly basis: string;
}
export interface ExitEvidence {
  readonly observation: string;
  /** `evidence.evaluator` as recorded; absent when the observation records none. */
  readonly evaluator?: string;
  /**
   * `self` when the evaluator is the identity the task's `work.owner-agent` names (decision
   * task-owner-and-agent-description); `unknown` when the task states an owner-agent that no admitted @agent in this
   * scope answers, or the observation records no evaluator for a task that names one; else `other`.
   */
  readonly attribution: 'self' | 'other' | 'unknown';
}
export interface DeliveryTask {
  readonly identity: string;
  readonly milestone: string;
  /** `status <work.status> (self-declared)`: printed beside the verdict, never its basis. */
  readonly status: string;
  readonly prerequisites: readonly Prerequisite[];
  readonly verdict: 'evidenced' | 'unblocked' | 'blocked';
  /**
   * `exit evidence recorded (<observation>, evaluator <evaluator>[, self-attributed | , self-attribution unknown])`,
   * `no declared blocker`, or `blocked (<basis>; …)` naming each unsatisfied prerequisite.
   */
  readonly line: string;
  readonly evidence?: ExitEvidence;
  /** intent, definition, realizable, realized and worked, in that order. */
  readonly states: readonly StateLine[];
}
export interface DeliveryMilestone {
  readonly identity: string;
  readonly status: string;
  /** Its tasks, in the view's order. */
  readonly tasks: readonly string[];
  /** It has exit evidence of its own, or it has tasks, each of them has exit evidence and no task can go unread. */
  readonly satisfied: boolean;
  /** Which of the two applies, or why neither does. */
  readonly basis: string;
}
/** A contradiction or finding the view reports and does not resolve, for the owner it names (IM-32). */
export interface ReviewItem {
  /**
   * `grounding`: decisions grounding one record of the plan; `currency`: accepted specs, one superseding the other;
   * `admission`: a @plan, @milestone or @task admission refused, or a file a language error refuses whole, which the
   * view cannot place in any plan.
   */
  readonly kind: 'grounding' | 'currency' | 'admission';
  /**
   * The grounded record then its decisions, the superseding spec then the spec it supersedes, or the refused record;
   * empty for a refused file.
   */
  readonly records: readonly string[];
  /** The `head.steward` of the system of the record the item is about, when the scope admits that @system. */
  readonly owner?: string;
  readonly message: string;
}
export interface DeliveryView {
  readonly format: 'ia.delivery-view.v1';
  /** The revision of the view the scope reads. */
  readonly revision: string;
  readonly plan: string;
  /** In the order their prerequisites are met. */
  readonly milestones: readonly DeliveryMilestone[];
  /** Prerequisites first, ties by (milestone identity, task identity). */
  readonly tasks: readonly DeliveryTask[];
  readonly review: readonly ReviewItem[];
  /** `ia position --seat <task> --shape sequence` for the first task in order with no declared blocker, else null. */
  readonly next: string | null;
  /** How many tasks have exit evidence, then the next task or why there is none. */
  readonly summary: string;
}
export type DeliveryResult = { readonly ok: true; readonly view: DeliveryView } | NextRefusal;

/** The command IA-RUNTIME-NEXT-NO-PLAN names: its help says which @plan, @milestone and @task records make a plan. */
const NO_PLAN_NEXT = 'ia next --help';
const SEATS = ['plan', 'milestone', 'task'];
const ATTRIBUTION_SUFFIX = { self: ', self-attributed', other: '', unknown: ', self-attribution unknown' } as const;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const refuse = (code: NextCode, message: string, next: string, more: Partial<NextRefusal> = {}): NextRefusal =>
  freeze({ ok: false, code, message, next, ...more });
const referenceText = (reference: EdgeReference): string =>
  reference.kind === 'identity' ? reference.identity : `@${reference.discriminator} ${reference.name}`;
/**
 * The most coordinates the intent line is read at to learn whether a conditional row can change it; past that many, a
 * line that reads a conditional row stays unknown.
 */
const COMPLETIONS = 256;
/** A condition as its terms read: `phase is act and severity is blocking`. */
const conditionText = (condition: readonly Term[]): string =>
  condition.map((term) => `${term.axis} is ${term.value}`).join(' and ');
/** The first of `items` per key, in their order. */
function firstPer<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  const kept = new Map<string, T>();
  for (const item of items) if (!kept.has(key(item))) kept.set(key(item), item);
  return [...kept.values()];
}

/** A vertex of the order: a task, or the start (prerequisites met) or end (satisfied) of a milestone. */
interface Vertex {
  readonly key: string;
  readonly milestone: string;
  readonly task?: string;
}
/** `from` must precede `to`; a declared `require` row carries the row, a milestone's own structure none. */
interface Arc {
  readonly from: string;
  readonly to: string;
  readonly row?: CycleRow;
}
/** Milestone vertices first, as they only release tasks; then tasks by (milestone identity, task identity). */
const releaseFirst = (a: Vertex, b: Vertex): number =>
  a.task === undefined
    ? b.task === undefined
      ? order(a.key, b.key)
      : -1
    : b.task === undefined
      ? 1
      : order(a.milestone, b.milestone) || order(a.task, b.task);
/** Tasks first, by (milestone identity, task identity); then milestone vertices by key. */
const tasksFirst = (a: Vertex, b: Vertex): number =>
  (a.task === undefined) === (b.task === undefined) ? releaseFirst(a, b) : a.task === undefined ? 1 : -1;

/**
 * Kahn's algorithm over the vertices: repeatedly emit the ready vertex `releaseFirst` ranks first. Returns every vertex
 * in that order, or, when a cycle leaves some waiting, the declared rows of one cycle among them, read from its first
 * vertex by `tasksFirst`, and that vertex.
 */
function sortVertices(
  vertices: ReadonlyMap<string, Vertex>,
  arcs: readonly Arc[],
): { readonly order: readonly Vertex[] } | { readonly cycle: readonly CycleRow[]; readonly first: Vertex } {
  const outgoing = new Map<string, Arc[]>(),
    incoming = new Map<string, Arc[]>(),
    waiting = new Map<string, number>();
  for (const key of vertices.keys()) {
    outgoing.set(key, []);
    incoming.set(key, []);
    waiting.set(key, 0);
  }
  for (const arc of arcs) {
    outgoing.get(arc.from)!.push(arc);
    incoming.get(arc.to)!.push(arc);
    waiting.set(arc.to, waiting.get(arc.to)! + 1);
  }
  const ready = [...vertices.values()].filter((vertex) => waiting.get(vertex.key) === 0),
    emitted: Vertex[] = [];
  while (ready.length > 0) {
    const vertex = ready.sort(releaseFirst).shift()!;
    emitted.push(vertex);
    for (const arc of outgoing.get(vertex.key)!) {
      waiting.set(arc.to, waiting.get(arc.to)! - 1);
      if (waiting.get(arc.to) === 0) ready.push(vertices.get(arc.to)!);
    }
  }
  if (emitted.length === vertices.size) return { order: emitted };
  // Each vertex left waits on another vertex left, so walking back along prerequisites closes a cycle. The walk
  // stays on milestone vertices where it can, so a cycle of milestone rows is not reported through a milestone's tasks.
  const left = new Set([...vertices.keys()].filter((key) => waiting.get(key)! > 0));
  const back = (key: string): Arc =>
    incoming
      .get(key)!
      .filter((arc) => left.has(arc.from))
      .sort((a, b) => releaseFirst(vertices.get(a.from)!, vertices.get(b.from)!))[0]!;
  const path: string[] = [],
    seen = new Map<string, number>();
  let key = [...left].map((k) => vertices.get(k)!).sort(tasksFirst)[0]!.key;
  while (!seen.has(key)) {
    seen.set(key, path.length);
    path.push(key);
    key = back(key).from;
  }
  const loop = path.slice(seen.get(key)),
    first = loop.map((k) => vertices.get(k)!).sort(tasksFirst)[0]!,
    at = loop.indexOf(first.key);
  return {
    cycle: [...loop.slice(at), ...loop.slice(0, at)].flatMap((k) => {
      const row = back(k).row;
      return row === undefined ? [] : [row];
    }),
    first,
  };
}

/**
 * A relation row the view reads, and whether its condition holds where it is read: true, or undefined when the
 * coordinates the bound one may still be completed to disagree on it.
 */
interface Related {
  readonly row: DirectedEdgeRow;
  readonly holds: true | undefined;
}
/**
 * Where a condition is read: at the coordinate the scope binds, `closed` false, where an axis it binds no value for is
 * still open; or at one completion of it, `closed` true, where every axis is decided, an absent one included.
 */
interface Reading {
  readonly at: Coordinate;
  readonly closed: boolean;
}
/** A conditional row a reading leaves undecided, in words, with its condition and the record that states it. */
interface Pending {
  readonly text: string;
  readonly condition: readonly Term[];
  readonly subject: string;
}

interface Observed {
  readonly observation: string;
  readonly verdict?: string;
  readonly readiness?: Readiness;
  readonly evaluator?: string;
}

/**
 * The delivery view of one @plan in the scope `within`, or one refusal naming one next command. The seat is a @plan,
 * @milestone or @task identity, read as its plan; without one, the plan is the only admitted @plan at band 100.
 * IA-RUNTIME-NEXT-SEAT refuses a seat that is no admitted @plan, @milestone or @task; IA-RUNTIME-NEXT-NO-PLAN a seat
 * that belongs to no admitted plan, or no seat and no authored plan; IA-RUNTIME-NEXT-AMBIGUOUS no seat and several
 * authored plans; IA-RUNTIME-NEXT-CYCLE a plan whose `require` rows form a cycle, among tasks, milestones or both.
 * Every read goes through `within`, but for the admission findings a whole-workspace `within` alone may disclose
 * (db PT5), and nothing is written.
 */
export function deliveryView(handle: ReadHandle, within: string, seat?: string): DeliveryResult {
  const read = { within },
    snapshot = handle.snapshot(read),
    nodes = new Map(snapshot.records.map((node) => [node.identity, node]));
  const viewed = new Map<string, readonly DirectedRow[]>();
  const rowsOf = (identity: string): readonly DirectedRow[] => {
    let rows = viewed.get(identity);
    if (rows === undefined) viewed.set(identity, (rows = handle.directedView(identity, read)));
    return rows;
  };
  const word = (identity: string): string | undefined => nodes.get(identity)?.discriminator;
  const text = (identity: string, field: string): string | undefined => {
    const node = nodes.get(identity);
    return node === undefined ? undefined : statedText(node, field);
  };
  /** The admitted records of `discriminator` among `identities`, once each, in identity order. */
  const of = (identities: readonly string[], discriminator: string): readonly string[] =>
    [...new Set(identities)].filter((identity) => word(identity) === discriminator).sort(order);
  /** The counterparts of `identity`'s typed field references at `field`: its targets `out`, its holders `in`. */
  const refs = (identity: string, field: string, direction: 'out' | 'in'): readonly string[] =>
    rowsOf(identity)
      .filter((row) => row.kind === 'field-ref' && row.field === field && row.direction === direction)
      .map((row) => row.counterpart);
  // Decision conditional-relations-in-delivery: the coordinate the scope binds, a phase or none (db resolveScope binds no
  // other condition axis), which a row's condition is read against as graph traversal reads it.
  const bound: Coordinate = snapshot.phase === undefined ? {} : { phase: snapshot.phase },
    BOUND: Reading = { at: bound, closed: false };
  /** The coordinates `at` may be completed to on `axis`: itself where it binds the axis, else with it absent or set. */
  const completions = (at: Coordinate, axis: ConditionAxis): readonly Coordinate[] =>
    at[axis] !== undefined ? [at] : [at, ...(valuesFor(axis) ?? []).map((value) => ({ ...at, [axis]: value }))];
  /**
   * The axes of `condition`, stated by `subject`, on which the bound coordinate leaves it undecided: graph
   * `conditionHolds` reads the condition's terms on that axis differently at two of its completions. An axis the scope
   * binds no value for is such an axis, but for provenance and artifact set, which `conditionHolds` reads from the
   * subject alone, and for severity where the subject's own severity decides it (graph `effectiveSeverity` takes the
   * stronger of the subject's and the coordinate's, so the coordinate can raise it but never lower it).
   */
  const openAxes = (condition: readonly Term[], subject: string): readonly ConditionAxis[] => {
    const node = nodes.get(subject),
      axes = [...new Set(condition.map((term) => term.axis))];
    return node === undefined
      ? axes
      : axes.filter((axis) => {
          const terms = condition.filter((term) => term.axis === axis);
          return new Set(completions(bound, axis).map((at) => conditionHolds(terms, node.dimensions, at))).size > 1;
        });
  };
  /**
   * Whether `condition`, stated by `subject` (the author, graph G06's condition subject), holds where `reading` reads
   * it, as graph `conditionHolds` decides it: at a closed reading's coordinate, true or false; at the bound coordinate,
   * true or false where every completion of it agrees, else undefined, unless a term on another axis fails everywhere.
   */
  const holds = (condition: readonly Term[] | undefined, subject: string, reading = BOUND): boolean | undefined => {
    if (condition === undefined) return true;
    const node = nodes.get(subject);
    if (node === undefined) return undefined;
    if (reading.closed) return conditionHolds(condition, node.dimensions, reading.at);
    let open = false;
    for (const axis of new Set(condition.map((term) => term.axis))) {
      const terms = condition.filter((term) => term.axis === axis),
        results = new Set(completions(bound, axis).map((at) => conditionHolds(terms, node.dimensions, at)));
      if (results.size > 1) open = true;
      else if (!results.has(true)) return false;
    }
    return open ? undefined : true;
  };
  /** Why an undecided condition is unknown here: its terms, and the axes the scope binds no value to decide. */
  const undecided = (condition: readonly Term[], subject: string): string =>
    `conditional on ${conditionText(condition)}, which the scope binds no ${openAxes(condition, subject).join(' or ')} to decide (unknown)`;
  /**
   * The rows of `predicate` read from `identity`'s side, whichever end declared them, one per counterpart, the first
   * whose condition holds, else the first undecided one (`holds` undefined); a row whose condition fails where it is
   * read is no row.
   */
  const related = (
    identity: string,
    predicate: string,
    direction: 'out' | 'in',
    reading = BOUND,
  ): readonly Related[] => {
    const kept = new Map<string, Related>();
    for (const row of rowsOf(identity)) {
      if (row.kind === 'field-ref' || row.predicate !== predicate || row.direction !== direction) continue;
      const at = holds(row.condition, row.declaredOn, reading);
      if (at === false) continue;
      const prior = kept.get(row.counterpart);
      if (prior === undefined || (prior.holds === undefined && at === true))
        kept.set(row.counterpart, { row, holds: at });
    }
    return [...kept.values()];
  };
  /** The rows of `related` whose condition holds where they are read, or that have none. */
  const holding = (
    identity: string,
    predicate: string,
    direction: 'out' | 'in',
    reading = BOUND,
  ): readonly DirectedEdgeRow[] =>
    related(identity, predicate, direction, reading).flatMap((entry) => (entry.holds === true ? [entry.row] : []));
  const status = (identity: string): string =>
    `status ${text(identity, 'work.status') ?? 'not stated'} (self-declared)`;
  /** The record states `field`, a `section.key` path, whatever its value. */
  const states = (identity: string, field: string): boolean => {
    const [section, key] = field.split('.');
    return nodes
      .get(identity)!
      .sections.some((s) => s.name === section && s.fields.some((f) => 'key' in f && f.key === key));
  };

  // db PT5: only a whole-workspace scope may disclose admission findings, so only it reads which work records admission
  // refused (an identity another occurrence wins is admitted, not refused) and which files a language error refused
  // whole (D03). A narrowed scope may leave tasks unread instead.
  const complete = handle.isCompleteScope(within),
    here = complete ? '' : ' in this scope';
  const refusedWork = complete
      ? handle.refused.filter((record) => SEATS.includes(record.identity.split('/')[2]!) && !nodes.has(record.identity))
      : [],
    unparsed = complete
      ? firstPer(
          handle.report.verdicts
            .filter((verdict) => verdict.check === 'COMP-PARSE')
            .flatMap((verdict) => verdict.findings)
            .filter((finding) => finding.severity === 'error'),
          (finding) => finding.path,
        )
      : [];
  const refusedAny = (discriminator: string): boolean =>
    refusedWork.some((record) => record.identity.split('/')[2] === discriminator);
  /**
   * Why a task of one milestone may go unread, or with `wholePlan` a task of the plan (a refused @milestone hides its
   * tasks), when one may.
   */
  const unseen = (wholePlan: boolean): string | undefined =>
    !complete
      ? 'records outside this scope are unknown'
      : unparsed.length > 0 || refusedAny('task') || (wholePlan && refusedAny('milestone'))
        ? 'records admission refused are unknown'
        : undefined;

  // The plan: the seat's, else the only authored one.
  const authored = of(
    snapshot.records.filter((node) => node.band === 100).map((node) => node.identity),
    'plan',
  );
  /** The view read without a seat, which runs: the only authored plan's, else the first's, else what makes a plan. */
  const unseated =
    authored.length === 0 ? NO_PLAN_NEXT : authored.length === 1 ? 'ia next' : `ia next --seat ${authored[0]!}`;
  let plan: string;
  if (seat !== undefined) {
    const node = nodes.get(seat);
    if (node === undefined)
      return refuse('IA-RUNTIME-NEXT-SEAT', `${seat} is not an admitted record in this scope`, unseated);
    if (!SEATS.includes(node.discriminator))
      return refuse(
        'IA-RUNTIME-NEXT-SEAT',
        `${seat} is a @${node.discriminator}; the delivery view is read from a @plan, @milestone or @task`,
        `ia position --seat ${seat}`,
      );
    const milestone = node.discriminator === 'task' ? of(refs(seat, 'work.milestone', 'out'), 'milestone')[0] : seat;
    const found =
      node.discriminator === 'plan'
        ? seat
        : milestone === undefined
          ? undefined
          : of(refs(milestone, 'work.plan', 'out'), 'plan')[0];
    if (found === undefined)
      return refuse('IA-RUNTIME-NEXT-NO-PLAN', `${seat} belongs to no admitted @plan in this scope`, NO_PLAN_NEXT);
    plan = found;
  } else {
    const plans = authored;
    if (plans.length === 0)
      return refuse(
        'IA-RUNTIME-NEXT-NO-PLAN',
        'No admitted @plan at authored placement (band 100) in this scope',
        NO_PLAN_NEXT,
      );
    if (plans.length > 1)
      return refuse(
        'IA-RUNTIME-NEXT-AMBIGUOUS',
        `${plans.length} admitted @plan records at band 100 and no seat to choose one: ${plans.join(', ')}`,
        `ia next --seat ${plans[0]!}`,
        { plans },
      );
    plan = plans[0]!;
  }

  const milestones = of(refs(plan, 'work.plan', 'in'), 'milestone');
  const tasksOf = (milestone: string): readonly string[] => of(refs(milestone, 'work.milestone', 'in'), 'task');
  const milestoneOf = new Map(milestones.flatMap((milestone) => tasksOf(milestone).map((task) => [task, milestone])));
  const members = [...milestones, ...milestoneOf.keys()];
  /** The records `identity` requires, each row whose condition holds here or that the scope does not decide. */
  const requires = (identity: string): readonly Related[] => related(identity, 'require', 'out');
  // A requirement no admitted record answers is an admission finding with no row; the traversal still names it, with
  // the lines that declare it and its condition, which is read here as a row's is.
  const unanswered = new Map<
    string,
    {
      readonly reference: string;
      readonly lines: readonly number[];
      readonly holds: boolean | undefined;
      readonly condition?: readonly Term[];
      readonly subject: string;
    }[]
  >();
  for (const edge of handle.traverse({ ...read, start: members, follow: ['require'], depth: 1 }).dangling)
    if (edge.from !== null)
      unanswered.set(edge.from, [
        ...(unanswered.get(edge.from) ?? []),
        {
          reference: referenceText(edge.reference),
          lines: edge.assertions.map((assertion) => assertion.source.line),
          holds: holds(edge.condition, edge.conditionSubject),
          ...(edge.condition === undefined ? {} : { condition: edge.condition }),
          subject: edge.conditionSubject,
        },
      ]);
  /**
   * The references of `holder`'s own `require` declarations that give neither a row nor a dangling edge in this scope:
   * their answer is outside it (db D09 prunes the row, and the traversal never reaches past the scope) or no row is
   * read for it, so the requirement is unknown, never met. A declaration whose condition fails here is none; one the
   * scope does not decide is unknown all the same. Every row and dangling edge answers its lines, conditional or not.
   */
  const unread = (holder: string): readonly string[] => {
    const answered = new Set([
      ...rowsOf(holder)
        .filter((row) => row.kind === 'edge' && row.predicate === 'require' && row.direction === 'out')
        .map((row) => row.source.line),
      ...(unanswered.get(holder) ?? []).flatMap((entry) => entry.lines),
    ]);
    return nodes
      .get(holder)!
      .edges.filter(
        (edge) =>
          edge.predicate === 'require' &&
          edge.direction === 'out' &&
          !answered.has(edge.span.line) &&
          holds(edge.condition, holder) !== false,
      )
      .map((edge) => referenceText(edge.reference));
  };

  // One global order. A milestone is two vertices, its start (its own prerequisites met) and its end (satisfied):
  // its tasks follow its start and precede its end, and a record requiring it follows its end. Requirements outside
  // the plan are basis lines only, and so is a conditional requirement the scope does not decide.
  const start = (milestone: string): string => `start ${milestone}`,
    end = (milestone: string): string => `end ${milestone}`;
  const vertices = new Map<string, Vertex>(),
    arcs: Arc[] = [];
  for (const milestone of milestones) {
    vertices.set(start(milestone), { key: start(milestone), milestone });
    vertices.set(end(milestone), { key: end(milestone), milestone });
    arcs.push({ from: start(milestone), to: end(milestone) });
  }
  for (const [task, milestone] of milestoneOf) {
    vertices.set(task, { key: task, milestone, task });
    arcs.push({ from: start(milestone), to: task }, { from: task, to: end(milestone) });
  }
  for (const member of members)
    for (const row of holding(member, 'require', 'out')) {
      const target = row.counterpart,
        from = milestoneOf.has(target) ? target : milestones.includes(target) ? end(target) : undefined;
      if (from !== undefined)
        arcs.push({
          from,
          to: milestoneOf.has(member) ? member : start(member),
          row: { from: member, to: target, declaredOn: row.declaredOn, path: row.source.path, line: row.source.line },
        });
    }
  const sorted = sortVertices(vertices, arcs);
  if ('cycle' in sorted)
    return refuse(
      'IA-RUNTIME-NEXT-CYCLE',
      `The require rows of ${plan} form a cycle, so no order exists: ${sorted.cycle
        .map((row) => `${row.from} requires ${row.to}`)
        .join(', ')}`,
      `ia position --seat ${sorted.first.task ?? sorted.first.milestone} --shape sequence`,
      { cycle: sorted.cycle },
    );

  // Exit evidence and the worked line read the same observations.
  const observed = new Map<string, readonly Observed[]>();
  const observationsOf = (identity: string): readonly Observed[] => {
    let found = observed.get(identity);
    if (found === undefined) {
      const named = of(
        [...refs(identity, 'evidence.subject', 'in'), ...refs(identity, 'work.exit-evidence', 'out')],
        'observation',
      );
      found = named.map((observation): Observed => {
        const verdict = text(observation, 'evidence.verdict'),
          revision = text(observation, 'evidence.subject-revision'),
          evaluator = text(observation, 'evidence.evaluator');
        return {
          observation,
          ...(verdict === undefined ? {} : { verdict }),
          ...(revision === undefined ? {} : { readiness: handle.readiness(identity, revision, read) }),
          ...(evaluator === undefined ? {} : { evaluator }),
        };
      });
      observed.set(identity, found);
    }
    return found;
  };
  const evidenceOf = (identity: string): Observed | undefined =>
    observationsOf(identity).find((o) => o.verdict === 'success' && o.readiness === 'current');
  const satisfaction = (milestone: string): { readonly satisfied: boolean; readonly reason: string } => {
    const own = evidenceOf(milestone);
    if (own !== undefined) return { satisfied: true, reason: `exit evidence ${own.observation}` };
    const tasks = tasksOf(milestone),
      missing = tasks.filter((task) => evidenceOf(task) === undefined).length,
      why = unseen(false);
    if (tasks.length === 0) return { satisfied: false, reason: `no task${here} and no exit evidence` };
    if (missing > 0)
      return { satisfied: false, reason: `exit evidence missing for ${missing} of ${tasks.length} tasks` };
    return why === undefined
      ? { satisfied: true, reason: 'every task has exit evidence' }
      : { satisfied: false, reason: `every task the view reads has exit evidence; ${why}` };
  };
  const prerequisite = (target: string, via: string | undefined): Prerequisite => {
    const discriminator = word(target)!;
    let satisfied: boolean, basis: string;
    switch (discriminator) {
      case 'task': {
        const evidence = evidenceOf(target);
        satisfied = evidence !== undefined;
        basis = `task ${target}: ${evidence === undefined ? 'no exit evidence' : `exit evidence ${evidence.observation}`}`;
        break;
      }
      case 'milestone': {
        const reading = satisfaction(target);
        satisfied = reading.satisfied;
        basis = `milestone ${target}: ${reading.reason}`;
        break;
      }
      case 'decision':
        satisfied = text(target, 'decision.choice') !== undefined;
        basis = `decision ${target}: ${satisfied ? 'choice made' : 'no choice'}`;
        break;
      default:
        satisfied = false;
        basis = `@${discriminator} ${target}: no delivery basis`;
    }
    return {
      target,
      word: discriminator,
      ...(via === undefined ? {} : { via }),
      satisfied,
      basis: via === undefined ? basis : `${basis} (via ${via})`,
    };
  };
  /**
   * A requirement of `target` whose `condition`, stated by `subject`, the scope does not decide: never satisfied,
   * whatever the target's state, its basis the condition and the axes the scope binds no value to decide.
   */
  const conditional = (
    target: string,
    via: string | undefined,
    condition: readonly Term[],
    subject: string,
  ): Prerequisite => {
    const discriminator = word(target)!,
      basis = `${['task', 'milestone', 'decision'].includes(discriminator) ? discriminator : `@${discriminator}`} ${target}: ${undecided(condition, subject)}`;
    return {
      target,
      word: discriminator,
      ...(via === undefined ? {} : { via }),
      satisfied: false,
      basis: via === undefined ? basis : `${basis} (via ${via})`,
    };
  };
  /**
   * The task's own requirements, then the ones it inherits from its milestone, each target once: the first line whose
   * requirement holds here, else the first conditional one the scope does not decide.
   */
  const prerequisitesOf = (task: string): readonly Prerequisite[] => {
    const unmet = (reference: string, via: string | undefined, reason: string): Prerequisite => ({
      target: reference,
      ...(via === undefined ? {} : { via }),
      satisfied: false,
      basis: `${reference}: ${reason}${via === undefined ? '' : ` (via ${via})`}`,
    });
    const lines = (holder: string, via: string | undefined): readonly { line: Prerequisite; decided: boolean }[] => [
      ...requires(holder).map(({ row, holds: at }) => ({
        line:
          at === true
            ? prerequisite(row.counterpart, via)
            : conditional(row.counterpart, via, row.condition!, row.declaredOn),
        decided: at === true,
      })),
      ...(unanswered.get(holder) ?? []).flatMap(({ reference, holds: at, condition, subject }) =>
        at === false
          ? []
          : [
              {
                line: unmet(
                  reference,
                  via,
                  at === true
                    ? 'no admitted record answers it'
                    : `no admitted record answers it, ${undecided(condition!, subject)}`,
                ),
                decided: at === true,
              },
            ],
      ),
      ...unread(holder).map((reference) => ({
        line: unmet(reference, via, 'no record in this scope answers it (unknown)'),
        decided: true,
      })),
    ];
    const milestone = milestoneOf.get(task)!,
      kept = new Map<string, { line: Prerequisite; decided: boolean }>();
    for (const entry of [...lines(task, undefined), ...lines(milestone, milestone)]) {
      const prior = kept.get(entry.line.target);
      if (prior === undefined || (!prior.decided && entry.decided)) kept.set(entry.line.target, entry);
    }
    return [...kept.values()].map((entry) => entry.line);
  };

  /**
   * The @decision records grounding `record` through a row that holds where `reading` reads it, in identity order; the
   * live ones, which no other of them supersedes unless the two supersede each other through a cycle among them, which
   * removes neither; those in such a cycle; and the conditional rows the reading leaves undecided among those the
   * grounding is read from (each grounding row, then each supersession between two decisions grounding it), `record`
   * named as `label` in them.
   */
  const groundingOf = (
    record: string,
    reading = BOUND,
    label = record,
  ): { readonly live: readonly string[]; readonly cyclic: readonly string[]; readonly pending: readonly Pending[] } => {
    const grounds = related(record, 'ground', 'in', reading).filter(
        (entry) => word(entry.row.counterpart) === 'decision',
      ),
      decisions = of(
        grounds.flatMap((entry) => (entry.holds === true ? [entry.row.counterpart] : [])),
        'decision',
      ),
      candidates = of(
        grounds.map((entry) => entry.row.counterpart),
        'decision',
      );
    const pending: readonly Pending[] = [
      ...grounds.flatMap(({ row, holds: at }) =>
        at === true
          ? []
          : [{ text: `${row.counterpart} grounds ${label}`, condition: row.condition!, subject: row.declaredOn }],
      ),
      ...candidates.flatMap((decision) =>
        related(decision, 'supersede', 'out', reading).flatMap(({ row, holds: at }) =>
          at === true || !candidates.includes(row.counterpart)
            ? []
            : [
                {
                  text: `${decision} supersedes ${row.counterpart}`,
                  condition: row.condition!,
                  subject: row.declaredOn,
                },
              ],
        ),
      ),
    ];
    const supersedes = new Map(
      decisions.map((decision) => [
        decision,
        holding(decision, 'supersede', 'out', reading)
          .map((row) => row.counterpart)
          .filter((other) => decisions.includes(other)),
      ]),
    );
    /** `to` is reached from `from` through one or more supersessions among the decisions. */
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>(),
        queue = [...supersedes.get(from)!];
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(...supersedes.get(next)!);
        }
      }
      return false;
    };
    return {
      live: decisions.filter(
        (decision) =>
          !decisions.some((other) => supersedes.get(other)!.includes(decision) && !reaches(decision, other)),
      ),
      cyclic: decisions.filter((decision) => reaches(decision, decision)),
      pending,
    };
  };
  /** `records` with those `sure` holds before the rest, each part in its order. */
  const sureFirst = <T>(records: readonly T[], sure: ReadonlySet<string>, key: (record: T) => string): readonly T[] =>
    [...records].sort((a, b) => Number(!sure.has(key(a))) - Number(!sure.has(key(b))));
  /**
   * The first live @decision grounding `identity` where `reading` reads it that has a choice and an effective revision
   * (design §10 line 1), each conditional row the reading leaves undecided read as no row, a decision a row that holds
   * at the bound coordinate grounds read before one only a conditional row grounds; and those undecided rows.
   */
  const acceptedBy = (
    identity: string,
    reading: Reading,
    label = identity,
  ): {
    readonly accepted?: { readonly decision: string; readonly revision: string };
    readonly pending: readonly Pending[];
  } => {
    const grounding = groundingOf(identity, reading, label),
      sure = new Set(holding(identity, 'ground', 'in').map((row) => row.counterpart));
    for (const decision of sureFirst(grounding.live, sure, (live) => live)) {
      const revision = text(decision, 'decision.effective-revision');
      if (text(decision, 'decision.choice') !== undefined && revision !== undefined)
        return { accepted: { decision, revision }, pending: grounding.pending };
    }
    return { pending: grounding.pending };
  };
  /**
   * The intent line where `reading` reads it, each conditional row the reading leaves undecided read as no row, and
   * those of them that could change it. A supersession by an accepted record through a row that holds decides it, so no
   * later supersession is read, a record a row that holds at the bound coordinate names read before one only a
   * conditional row names; one the reading leaves undecided counts when its record is or may be accepted.
   */
  const intentAt = (
    task: string,
    reading: Reading,
  ): { readonly line: StateLine; readonly pending: readonly Pending[] } => {
    const pending: Pending[] = [],
      sure = new Set(holding(task, 'supersede', 'in').map((row) => row.counterpart));
    for (const { row, holds: at } of sureFirst(
      related(task, 'supersede', 'in', reading),
      sure,
      (entry) => entry.row.counterpart,
    )) {
      const by = acceptedBy(row.counterpart, reading);
      if (at === undefined && (by.accepted !== undefined || by.pending.length > 0))
        pending.push({ text: `${row.counterpart} supersedes it`, condition: row.condition!, subject: row.declaredOn });
      pending.push(...by.pending);
      if (at === true && by.accepted !== undefined)
        return {
          line: {
            dimension: 'intent',
            value: 'superseded',
            basis: `${row.counterpart} supersedes it, grounded by ${by.accepted.decision} @${by.accepted.revision}`,
          },
          pending,
        };
    }
    const own = acceptedBy(task, reading, 'it');
    pending.push(...own.pending);
    if (own.accepted !== undefined)
      return {
        line: {
          dimension: 'intent',
          value: 'accepted',
          basis: `${own.accepted.decision}: choice made, effective-revision ${own.accepted.revision}`,
        },
        pending,
      };
    const decision = groundingOf(task, reading).live[0];
    return {
      line: {
        dimension: 'intent',
        value: 'unknown',
        basis:
          decision === undefined
            ? `no @decision${here} grounds it`
            : `${decision}: ${text(decision, 'decision.choice') === undefined ? 'no choice' : 'no effective-revision'}`,
      },
      pending,
    };
  };
  /**
   * The intent line (design §10 line 1). When the bound coordinate leaves a row it reads undecided, the line is read
   * again at each completion of the bound coordinate on the axes those rows leave open (each absent, or set to each of
   * its values), where every row is decided: a line that reads the same at every one is the line, since no binding the
   * scope could take changes it and the conditional row is never read as satisfied, as when a decision that only may
   * ground the task has no choice while another grounds it unconditionally and is accepted; else the intent is unknown,
   * its basis the first such row. Past COMPLETIONS coordinates the line is not read again and stays unknown.
   */
  const intent = (task: string): StateLine => {
    const { line, pending } = intentAt(task, BOUND);
    if (pending.length === 0) return line;
    const axes = [...new Set(pending.flatMap((row) => openAxes(row.condition, row.subject)))],
      size = axes.reduce((product, axis) => product * ((valuesFor(axis)?.length ?? 0) + 1), 1);
    if (size <= COMPLETIONS) {
      const readings = axes
        .reduce<readonly Coordinate[]>((all, axis) => all.flatMap((at) => completions(at, axis)), [bound])
        .map((at) => intentAt(task, { at, closed: true }));
      const [first] = readings;
      if (
        first !== undefined &&
        readings.every(
          (reading) =>
            reading.pending.length === 0 &&
            reading.line.value === first.line.value &&
            reading.line.basis === first.line.basis,
        )
      )
        return first.line;
    }
    const [row] = pending;
    return { dimension: 'intent', value: 'unknown', basis: `${row!.text} ${undecided(row!.condition, row!.subject)}` };
  };
  const worked = (task: string): StateLine => {
    const observations = observationsOf(task),
      current = (verdict: string): Observed | undefined =>
        observations.find((o) => o.readiness === 'current' && o.verdict === verdict);
    const success = current('success'),
      refusal = current('refusal'),
      stale = observations.find((o) => o.readiness === 'previous');
    if (success !== undefined)
      return {
        dimension: 'worked',
        value: 'observed success',
        basis: `${success.observation}: success at the current digest`,
      };
    if (refusal !== undefined)
      return {
        dimension: 'worked',
        value: 'observed refusal',
        basis: `${refusal.observation}: refusal at the current digest`,
      };
    if (stale !== undefined)
      return {
        dimension: 'worked',
        value: 'stale',
        basis: `${stale.observation}: its subject-revision is the digest in the previous snapshot`,
      };
    const other = observations[0];
    // A narrowed scope may hold an observation it does not read, so absence there is unknown (IM-24).
    if (other === undefined)
      return {
        dimension: 'worked',
        value: complete ? 'unobserved' : 'unknown',
        basis: `no @observation${here} names it`,
      };
    return {
      dimension: 'worked',
      value: 'unknown',
      basis: `${other.observation}: ${
        other.readiness === undefined
          ? 'no subject-revision'
          : other.readiness === 'current'
            ? `verdict ${other.verdict ?? 'not recorded'} at the current digest`
            : 'its subject-revision matches neither retained snapshot'
      }`,
    };
  };
  /** The steward the @system `system` names in `head.steward`, when the scope admits that @system. */
  const stewardOf = (system: string): string | undefined => {
    const identity = `floor/definition/system/${system}`;
    return nodes.has(identity) ? refs(identity, 'head.steward', 'out')[0] : undefined;
  };
  /** Whether the evaluator is the identity the task's `work.owner-agent` names, which only an answer in scope can say. */
  const attributionOf = (task: string, evaluator: string | undefined): ExitEvidence['attribution'] => {
    const owner = refs(task, 'work.owner-agent', 'out')[0];
    if (owner === undefined) return states(task, 'work.owner-agent') ? 'unknown' : 'other';
    return evaluator === undefined ? 'unknown' : evaluator === owner ? 'self' : 'other';
  };

  const ordered = sorted.order.flatMap((vertex) => (vertex.task === undefined ? [] : [vertex.task]));
  const tasks = ordered.map((identity): DeliveryTask => {
    const prerequisites = prerequisitesOf(identity),
      found = evidenceOf(identity);
    const evidence: ExitEvidence | undefined =
      found === undefined
        ? undefined
        : {
            observation: found.observation,
            ...(found.evaluator === undefined ? {} : { evaluator: found.evaluator }),
            attribution: attributionOf(identity, found.evaluator),
          };
    const blockers = prerequisites.filter((p) => !p.satisfied);
    const [verdict, line]: readonly [DeliveryTask['verdict'], string] =
      evidence !== undefined
        ? [
            'evidenced',
            `exit evidence recorded (${evidence.observation}, evaluator ${evidence.evaluator ?? 'not recorded'}${
              ATTRIBUTION_SUFFIX[evidence.attribution]
            })`,
          ]
        : blockers.length === 0
          ? ['unblocked', 'no declared blocker']
          : ['blocked', `blocked (${blockers.map((p) => p.basis).join('; ')})`];
    return {
      identity,
      milestone: milestoneOf.get(identity)!,
      status: status(identity),
      prerequisites,
      verdict,
      line,
      ...(evidence === undefined ? {} : { evidence }),
      states: [
        intent(identity),
        { dimension: 'definition', value: 'admitted', basis: `db admission at digest ${nodes.get(identity)!.digest}` },
        { dimension: 'realizable', value: 'not applicable', basis: 'a @task binds nothing' },
        { dimension: 'realized', value: 'not applicable', basis: 'no effect owner realizes a @task' },
        worked(identity),
      ],
    };
  });
  const plannedMilestones = sorted.order
    .filter((vertex) => vertex.key === start(vertex.milestone))
    .map(({ milestone }): DeliveryMilestone => {
      const reading = satisfaction(milestone);
      return {
        identity: milestone,
        status: status(milestone),
        tasks: ordered.filter((task) => milestoneOf.get(task) === milestone),
        satisfied: reading.satisfied,
        basis: reading.reason,
      };
    });

  // Review items: live decisions grounding one record of the plan; accepted specs one of which supersedes the other
  // with no replaced-scope, so the partial supersession that keeps both live is no item; and, on a whole-workspace
  // scope, the work records and files admission refused, which no plan can place.
  const review: ReviewItem[] = [];
  const item = (
    kind: ReviewItem['kind'],
    records: readonly string[],
    system: string | undefined,
    message: string,
  ): void => {
    const owner = system === undefined ? undefined : stewardOf(system);
    review.push({ kind, records, ...(owner === undefined ? {} : { owner }), message });
  };
  for (const record of [plan, ...plannedMilestones.map((m) => m.identity), ...ordered]) {
    const { live, cyclic } = groundingOf(record);
    if (live.length > 1)
      item(
        'grounding',
        [record, ...live],
        nodes.get(record)!.system,
        `${live.join(' and ')} each ground ${record}; ${
          cyclic.length === 0 ? 'none supersedes another' : `${cyclic.join(' and ')} supersede one another in a cycle`
        }`,
      );
  }
  const accepted = (spec: string): boolean => text(spec, 'work.status') === 'accepted';
  for (const spec of of([...nodes.keys()], 'spec'))
    for (const row of holding(spec, 'supersede', 'out')) {
      const replaced = row.counterpart;
      if (
        word(replaced) === 'spec' &&
        text(spec, 'work.replaced-scope') === undefined &&
        accepted(spec) &&
        accepted(replaced)
      )
        item(
          'currency',
          [spec, replaced],
          nodes.get(replaced)!.system,
          `${spec} supersedes ${replaced} with no replaced-scope, yet both declare status accepted`,
        );
    }
  for (const refused of refusedWork)
    item(
      'admission',
      [refused.identity],
      refused.identity.split('/')[0],
      `admission refused ${refused.identity} at ${refused.path}:${refused.line} (${refused.reason}), so no plan can place it; ia validate reports why`,
    );
  for (const finding of unparsed)
    item(
      'admission',
      [],
      undefined,
      `${finding.code} at ${finding.path}:${finding.line} refuses every record in that file, so no plan can read them; ia validate reports why`,
    );

  const evidenced = tasks.filter((task) => task.verdict === 'evidenced').length,
    first = tasks.find((task) => task.verdict === 'unblocked'),
    why = unseen(true);
  const summary =
    tasks.length === 0
      ? `${plan} has no task${here}`
      : evidenced === tasks.length
        ? why === undefined
          ? `every task has exit evidence (${evidenced} of ${tasks.length})`
          : `every task the view reads has exit evidence (${evidenced} of ${tasks.length}); ${why}`
        : `${evidenced} of ${tasks.length} tasks have exit evidence; ${
            first === undefined ? 'every other task is blocked' : `next: ${first.identity}, with no declared blocker`
          }`;
  return freeze({
    ok: true,
    view: {
      format: 'ia.delivery-view.v1',
      revision: snapshot.revision,
      plan,
      milestones: plannedMilestones,
      tasks,
      review,
      next: first === undefined ? null : `ia position --seat ${first.identity} --shape sequence`,
      summary,
    },
  });
}
