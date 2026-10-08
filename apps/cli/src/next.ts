/**
 * `ia next`: position-and-projection §9 step 2 and design rows 21 and 22, the delivery view.
 *
 * The runtime's `deliveryView` reads one plan: its milestones and tasks in one prerequisites-first order, each task with
 * a basis line per requirement, one verdict, its self-declared status and the five state lines of design §10, then the
 * review items and the next task. This verb prints that view, or with `--json` the view the Door's `next` operation
 * returns. A task's own `work.status` is printed and is never its verdict's basis.
 *
 * The view is computed per read and never stored: the workspace opens as every read verb opens it, without the db
 * cache, and the view is read through the whole-workspace scope, the one that may also name the work records admission
 * refused (db PT5). Nothing is written.
 */
import { deliveryView } from '@inventarch/runtime';
import type { CycleRow, DeliveryResult, DeliveryTask, DeliveryView, NextRefusal } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import type { Capabilities, SymbolName, Token } from './render.js';
import {
  atom,
  blockSymbolWidth,
  document,
  entry,
  headerLine,
  quote,
  remedyWords,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';
import { nearestNext, openSession } from './session.js';
import type { Session } from './session.js';

export function nextEnvelope(view: DeliveryView): unknown {
  return { version: 1, ok: true, view };
}

const VERDICT_SYMBOL: Readonly<Record<DeliveryTask['verdict'], SymbolName>> = {
  evidenced: 'success',
  unblocked: 'info',
  blocked: 'warning',
};

/** Escape scalar terminal controls before layout and colour; generated newlines and SGR remain presentation-owned. */
const terminalText = (text: string): string =>
  text.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * The plan and its summary; its milestones, satisfied or not and why; each task in the view's order with its verdict
 * line, its self-declared status, a basis line per requirement and its five state lines; the review items; and, when a
 * task has no declared blocker, the command the view names for it, with the root this invocation gave.
 */
export function renderNext(view: DeliveryView, caps: Capabilities, rooted = ''): string {
  const symbols: readonly SymbolName[] = [...Object.values(VERDICT_SYMBOL)];
  const symbolWidth = blockSymbolWidth(symbols, caps.ascii);
  const milestones = view.milestones.flatMap((milestone) =>
    entry(
      [
        [atom(terminalText(milestone.identity), 'cyan', 0)],
        words(`${milestone.satisfied ? 'satisfied' : 'not satisfied'}: ${terminalText(milestone.basis)}`),
        words(terminalText(milestone.status), 'dim'),
      ],
      { depth: 1, symbol: milestone.satisfied ? 'success' : 'warning', symbolWidth },
      caps,
    ),
  );
  // One block per task, so each one's lines stand apart from the next task's.
  const tasks = view.tasks.map((task, index) => [
    ...(index === 0 ? [sectionLabel('Tasks', caps)] : []),
    ...entry(
      [
        [atom(terminalText(task.identity), 'cyan', 0)],
        words(terminalText(task.line)),
        words(terminalText(task.status), 'dim'),
        ...task.prerequisites.map((prerequisite) => words(terminalText(`requires ${prerequisite.basis}`))),
        ...task.states.map((state) => words(terminalText(`${state.dimension} ${state.value}: ${state.basis}`), 'dim')),
      ],
      { depth: 1, symbol: VERDICT_SYMBOL[task.verdict], symbolWidth },
      caps,
    ),
  ]);
  const review =
    view.review.length === 0
      ? entry([words('No review item.', 'dim')], { depth: 1 }, caps)
      : view.review.flatMap((item) =>
          entry(
            [
              [atom(item.kind, null, 0), ...words(terminalText(item.message), null, 2)],
              ...(item.owner === undefined
                ? []
                : [[atom('owner', 'dim', 0), atom(terminalText(item.owner), 'cyan', 2)]]),
            ],
            { depth: 1, symbol: 'warning' },
            caps,
          ),
        );
  const first = view.tasks.find((task) => task.verdict === 'unblocked');
  const next: readonly Token[] | null =
    view.next === null || first === undefined
      ? null
      : remedyWords(
          terminalText(
            `Run "${view.next}${rooted}" for the position of ${first.identity}, the next task with no declared blocker.`,
          ),
        );
  return document(
    [
      headerLine(
        'Plan',
        terminalText(view.plan),
        [{ text: `revision ${terminalText(truncateDigest(view.revision, caps.ascii))}`, column: 50 }],
        caps,
      ),
      entry([words(terminalText(view.summary))], { depth: 1, symbol: 'info' }, caps),
      milestones.length === 0 ? [] : [sectionLabel('Milestones', caps), ...milestones],
      ...tasks,
      [sectionLabel('Review', caps), ...review],
      next === null ? [] : entry([next], { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );
}

/** The `@<word> <name>` references `identity`'s `work.<key>` states, each item of a list included. */
function stated(reader: Session['reader'], identity: string, key: string) {
  const field = reader
    .get(identity)
    ?.sections.find((section) => section.name === 'work')
    ?.fields.find((child) => 'key' in child && child.key === key);
  const value = field === undefined || !('value' in field) ? undefined : field.value;
  return (value === undefined ? [] : value.kind === 'list' ? value.items : [value]).flatMap((item) =>
    item.kind === 'ref' ? [item] : [],
  );
}

/** The records admission refused whose identity no other occurrence wins, so none of them is admitted. */
const refusedOnly = (reader: Session['reader']) =>
  reader.refused.filter((record) => reader.get(record.identity) === undefined);
const validateNext = (rooted: string, identity: string): string =>
  `Run "ia validate${rooted}" to see why admission refused ${identity}.`;

/**
 * The record admission refused where a seat's way to its plan breaks, so IA-RUNTIME-NEXT-NO-PLAN names the validation
 * that says why rather than records a source already holds: the @milestone a @task seat's `work.milestone` names, or
 * the @plan that `work.plan` names on its admitted milestone or on a @milestone seat. No reference resolves to a
 * refused record, so one is matched by its word and name.
 */
function refusedOnTheWay(reader: Session['reader'], seat: string): string | undefined {
  const refused = refusedOnly(reader);
  const named = (identity: string, key: string): string | undefined =>
    stated(reader, identity, key).flatMap((reference) =>
      refused.flatMap((record) => {
        const [, , word, name] = record.identity.split('/');
        return word === reference.discriminator && name?.toLowerCase() === reference.name.toLowerCase()
          ? [record.identity]
          : [];
      }),
    )[0];
  if (reader.get(seat)?.discriminator !== 'task') return named(seat, 'plan');
  const milestone = reader
    .directedView(seat)
    .find(
      (row) =>
        row.kind === 'field-ref' &&
        row.field === 'work.milestone' &&
        row.direction === 'out' &&
        reader.get(row.counterpart)?.discriminator === 'milestone',
    )?.counterpart;
  return milestone === undefined ? named(seat, 'milestone') : named(milestone, 'plan');
}

/**
 * The command that reads a plan without a seat, chosen by the @plan records at band 100 the workspace admits, which
 * `deliveryView` counts the same way: the view of the only one; the first of several, which the view refuses to choose
 * between; with none, the validation that says why admission refused a @plan a source holds, else the records to
 * author, then the view.
 */
function unseated(reader: Session['reader'], rooted: string): string {
  const plans = reader
    .records()
    .filter((node) => node.discriminator === 'plan' && node.band === 100)
    .map((node) => node.identity)
    .sort();
  if (plans.length === 1) return `Run "ia next${rooted}" to read ${plans[0]!}, the only plan the workspace authors.`;
  if (plans.length > 1)
    return `Run "ia next --seat ${quote(plans[0]!)}${rooted}" to read the first of the ${plans.length} plans the workspace authors; seat any other the same way.`;
  const refused = refusedOnly(reader).find((record) => record.identity.split('/')[2] === 'plan');
  return refused !== undefined
    ? validateNext(rooted, refused.identity)
    : `Author a @plan, @milestone records whose work.plan names it and @task records whose work.milestone names one of them, then run "ia next${rooted}".`;
}

/**
 * The record IA-RUNTIME-NEXT-CYCLE's own `next` seats at (runtime SPEC R18), read from the rows the refusal lists: the
 * cycle's first task in the view's order, by milestone then task, else the first milestone a row requires. Every task
 * in the cycle is named by one of its rows and every milestone a row requires closes it, so this is the runtime's seat.
 * The runtime's `next` is not forwarded: a next action this CLI names is built here, where design row 27 is checked.
 */
function cycleSeat(rows: readonly CycleRow[], reader: Session['reader']): string {
  const milestoneOf = (task: string): string =>
    reader
      .directedView(task)
      .find(
        (row) =>
          row.kind === 'field-ref' &&
          row.field === 'work.milestone' &&
          row.direction === 'out' &&
          reader.get(row.counterpart)?.discriminator === 'milestone',
      )?.counterpart ?? '';
  const byte = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const tasks = [...new Set(rows.flatMap((row) => [row.from, row.to]))]
    .filter((identity) => identity.split('/')[2] === 'task')
    .map((task) => ({ task, milestone: milestoneOf(task) }))
    .sort((a, b) => byte(a.milestone, b.milestone) || byte(a.task, b.task));
  return tasks[0]?.task ?? rows.map((row) => row.to).sort(byte)[0]!;
}

/**
 * Design row 27: the one command after each delivery refusal, carrying the root the invocation gave, which the runtime's
 * own `next` does not. A seat the workspace does not admit names what `ia inspect` and `ia read` name for an identity
 * they do not admit (`nearestNext`): the validation for a record admission refused, else the nearest @plan,
 * @milestone or @task as the seat, else the view without a seat (`unseated`). A record of another word names its
 * position, as the runtime does. A missing plan names what the view without a seat names, or with a seat the
 * validation for a record admission refused on its way to its plan, else the records to author, then the same view
 * again. Several plans name the view of the first, which the message lists with the others, and a cycle the sequence
 * position of the record the runtime's own `next` seats at (`cycleSeat`), whose require rows the message lists.
 */
function nextAfter(
  refusal: NextRefusal,
  context: Pick<Context, 'command' | 'args'>,
  rooted: string,
  reader: Session['reader'],
): string {
  const seat = context.args.value('seat');
  switch (refusal.code) {
    case 'IA-RUNTIME-NEXT-SEAT':
      if (seat !== undefined && reader.get(seat) !== undefined)
        return `Run "ia position --seat ${quote(seat)}${rooted}" for where that record sits; the delivery view is read from a @plan, @milestone or @task.`;
      // deliveryView refuses a seat it does not admit only when it was given one.
      return nearestNext(reader, seat ?? '', 'next', rooted) ?? unseated(reader, rooted);
    case 'IA-RUNTIME-NEXT-NO-PLAN': {
      if (seat === undefined) return unseated(reader, rooted);
      const refused = refusedOnTheWay(reader, seat);
      return refused !== undefined
        ? validateNext(rooted, refused)
        : `Author the @plan ${seat} belongs to through work.plan (and work.milestone for a @task), then run "${respell(context)}".`;
    }
    case 'IA-RUNTIME-NEXT-AMBIGUOUS':
      return `Run "ia next --seat ${quote(refusal.plans![0]!)}${rooted}" to read the first plan the message lists; seat any other the same way.`;
    case 'IA-RUNTIME-NEXT-CYCLE':
      return `Run "ia position --seat ${cycleSeat(refusal.cycle!, reader)} --shape sequence${rooted}" for the require rows around the cycle the message names; one of them must go before the plan has an order.`;
  }
}
/**
 * §4.1: the runtime's delivery refusal with its code and message unchanged, at exit 1, as `ia inspect` refuses an
 * identity it does not admit: each concerns the workspace's records. A cycle is located at its first declared row.
 */
export function nextRefusal(
  refusal: NextRefusal,
  context: Pick<Context, 'command' | 'args'>,
  root: string,
  /** The workspace, still open, so the command named follows from what it admits and what admission refused. */
  reader: Session['reader'],
): Refusal {
  const seat = context.args.value('seat'),
    supplied = context.args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`,
    first = refusal.cycle?.[0];
  return new Refusal(
    refusal.code,
    refusal.message,
    1,
    first === undefined
      ? { path: root, ...(seat === undefined ? {} : { identity: seat }) }
      : { path: first.path, line: first.line, identity: first.declaredOn },
    nextAfter(refusal, context, rooted, reader),
  );
}

export function runNext(context: Context): Result {
  const { args, caps, json } = context;
  const supplied = args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`;
  const root = requireRoot(context);
  const session = openSession(root);
  let got: DeliveryResult;
  try {
    got = deliveryView(session.reader, session.reader.resolveScope().token, args.value('seat'));
    // Refused while the workspace is open, so the seat is told apart by what it admits and refuses.
    if (!got.ok) throw nextRefusal(got, context, root, session.reader);
  } finally {
    session.close();
  }
  return json
    ? { exitCode: 0, stdout: JSON.stringify(nextEnvelope(got.view)) + '\n', stderr: '' }
    : { exitCode: 0, stdout: renderNext(got.view, caps, rooted), stderr: '' };
}
