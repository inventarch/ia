/**
 * `ia next`: the delivery view of a plan, a milestone or a task, as text or as one JSON value (apps/cli/SPEC.md,
 * Workspace commands).
 *
 * What it tells is the Door's `next` operation, asked through a Door over the whole workspace as the machine route asks
 * it with no `within`, so one seat gives one view on either route, the snapshot the capture store holds as current
 * included. The view is computed on each call and stores nothing; the text is a rendering of it, never part of it.
 */
import { Door } from '@inventarch/runtime';
import type { DeliveryEntry, DeliveryView, StateLine } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import type { Capabilities, Field, Token } from './render.js';
import { atom, document, entry, fieldRows, headerLine, sectionLabel, truncateDigest, words } from './render.js';
import { openRefusal } from './session.js';

/** The delivery view at `root`: the Door's `next` answer, its refusal kept with the next command the Door gives it. */
export function collectNext(root: string, seat: string | undefined): DeliveryView {
  let door: Door;
  try {
    door = new Door(root, { cache: false });
  } catch (error) {
    throw openRefusal(error, root);
  }
  try {
    const got = door.request({ operation: 'next', params: seat === undefined ? {} : { seat } });
    // A refusal decided after reading the workspace: the request was well formed and the workspace answers no.
    if (!got.ok) throw new Refusal(got.code, got.message, 1, null, got.next ?? 'Run "ia next --help".');
    return got.result as DeliveryView;
  } finally {
    door.close();
  }
}

const LABELS: Readonly<Record<StateLine, string>> = {
  accepted: 'Accepted',
  admitted: 'Admitted',
  realizable: 'Realizable',
  realized: 'Realized',
  worked: 'Worked',
};
const dim = (text: string): readonly Token[] => words(text, 'dim', 2);
/** A command is unbreakable prose (§6.4), so it wraps whole. */
const command = (text: string): Token => atom(text, null, 0);

/** One listed record: its identity, word and status, then its verdict, five state lines and requirements. */
function entryBlock(item: DeliveryEntry, caps: Capabilities): readonly string[] {
  const symbol = item.verdict.kind === 'blocked' ? 'warning' : item.verdict.kind === 'evidence' ? 'success' : 'info';
  const fields: Field[] = [
    {
      label: 'Verdict',
      value: words(item.verdict.text, item.verdict.kind === 'blocked' ? 'yellow' : null),
    },
    ...item.lines.map((line) => ({ label: LABELS[line.line], value: [atom(line.value, null, 0), ...dim(line.basis)] })),
    ...item.basis.map((basis) => ({
      label: 'Requires',
      value: [
        atom(basis.target, 'cyan', 0),
        ...(basis.word === null ? [] : [atom(basis.word, null, 2)]),
        ...words(basis.standing, basis.blocking ? 'yellow' : 'dim', 2),
      ],
    })),
  ];
  return [
    ...entry(
      [
        [
          atom(item.identity, 'cyan', 0),
          atom(item.word, null, 2),
          ...(item.status === null ? [] : dim(`status ${item.status}`)),
          ...(item.owner === null ? [] : dim(`owner ${item.owner}`)),
        ],
      ],
      { depth: 0, symbol },
      caps,
    ),
    ...fieldRows(fields, { depth: 2 }, caps),
  ];
}

/** The view as text: the seat and what it was read against, each listed record in order, review items, then next. */
export function renderNext(view: DeliveryView, caps: Capabilities): string {
  const { seat, evidence } = view;
  return document(
    [
      [
        ...headerLine('Next', seat.identity, [{ text: `revision ${truncateDigest(view.revision, caps.ascii)}` }], caps),
        ...fieldRows(
          [
            {
              label: 'Seat',
              value: words(seat.declared ? `${seat.word}, declared` : `${seat.word}, the scope's only authored plan`),
            },
            { label: 'Participant', value: words(view.participant ?? 'none') },
            {
              label: 'Snapshot',
              value: words(
                view.snapshot === null
                  ? 'none retained; run "ia capture" to keep one'
                  : `${truncateDigest(view.snapshot, caps.ascii)}, the captured current snapshot`,
              ),
            },
            {
              label: 'Evidence',
              value: words(
                evidence.overlay === null
                  ? `${evidence.reader} observations`
                  : `${evidence.reader} observations, overlay ${truncateDigest(evidence.overlay, caps.ascii)}`,
              ),
            },
            {
              label: 'Order',
              value: words(view.ordered ? 'require order' : 'none claimed: a require cycle (see Review)'),
            },
          ],
          { depth: 1 },
          caps,
        ),
      ],
      ...view.entries.map((item) => entryBlock(item, caps)),
      view.review.length === 0
        ? []
        : [
            sectionLabel('Review', caps),
            ...view.review.flatMap((item) =>
              entry(
                [
                  [
                    ...words(`${item.kind}:`, null, 0),
                    ...item.records.map((record) => atom(record, 'cyan', 1)),
                    ...dim(`owner ${item.owner ?? 'unknown'}`),
                  ],
                ],
                { depth: 1, symbol: 'warning' },
                caps,
              ),
            ),
          ],
      [
        sectionLabel('Next', caps),
        ...entry(
          [view.next === null ? words('No task is clear of declared blockers.') : [command(view.next)]],
          { depth: 1, symbol: 'step' },
          caps,
        ),
      ],
      entry([words('Run "ia next --json" for the view as data.', 'dim')], { depth: 0 }, caps),
    ],
    { leadingBlank: false },
  );
}

export function runNext(context: Context): Result {
  const view = collectNext(requireRoot(context), context.args.value('seat'));
  if (context.json) return { exitCode: 0, stdout: JSON.stringify({ version: 1, ...view }) + '\n', stderr: '' };
  return { exitCode: 0, stdout: renderNext(view, context.caps), stderr: '' };
}
