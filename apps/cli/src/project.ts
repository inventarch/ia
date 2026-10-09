/**
 * `ia project`: position-and-projection §5's project effect (design items 11 and 12; plan amendments B1, B5, B8, B11
 * and B12; decision cli-commands-as-operations), milestone position-packet task ia-project-verb.
 *
 * The workspace projection alone: the position packet of the workspace's admitted records (runtime R19), rendered by
 * the host's adapter for the consumer target (R20) through `renderProjectionFor`, the render `ia host`, `ia doctor` and
 * the install refresh read. It plans by default, as `ia host` and `ia install` do (B8), and the plan writes nothing: it
 * is `ia host`'s projection element (`projectionElement`), the steward-guard retirement and the file plan an apply
 * would make, beside the packet's entry count and digest. `--apply` re-plans through the same element
 * (`replanProjection`) and writes through `applyHostProjection`, the one writer of projection files, which retires a
 * steward guard an earlier release registered before any file changes (B11), deletes the owned 1.x steward files,
 * leaves foreign ones and writes the receipt (B12). It registers no MCP server and no hook; those stay `ia host`'s,
 * whose projection element is this same plan and apply. The packet reads the live admitted revision, so no capture is
 * required (B8). A plan with a conflict is a successful report naming the file, as `ia host`'s is (§4); only `--apply`
 * refuses it, before anything is asked or written, naming the plan to run once the file is out of the way. The `ia
 * project`, `ia validate` and `ia init` commands a next action names carry the root as the invocation typed it; the
 * `ia-distribution` recovery a pending host journal or a held host lock names carries the resolved root, because
 * `ia-distribution` takes only an absolute `--root`, and a workspace whose sources cannot be opened names the resolved
 * root, as for every workspace verb (`openSession`).
 */
import { workspaceRow } from '@inventarch/distribution/hosts';
import type { PacketReceipt } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, refusalOf, requireRoot } from './consumer.js';
import type { HostName } from './host-projection.js';
import { applyHostProjection, renderProjectionFor } from './host-projection.js';
import type { Conflict, Element } from './host.js';
import {
  GUARD_RETIRE,
  GUARD_RETIRED,
  GUARD_SCOPE,
  lockRefusal,
  pendingJournal,
  projectionElement,
  projectionFileRows,
  projectionRepair,
  recoverNext,
  replanProjection,
  requireIdle,
  requireInitialized,
  rootedNext,
  STATE,
} from './host.js';
import type { Capabilities, Field } from './render.js';
import {
  atom,
  commandFacts,
  document,
  entry,
  fieldRows,
  headerLine,
  indentOf,
  quote,
  remedyWords,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';

/**
 * The host a positional names, when the host table gives it a workspace set; null for any other. Those are the hosts an
 * adapter renders the packet for (runtime R20), because `renderProjectionFor` takes only a workspace host.
 */
const projectHost = (named: string | undefined): HostName | null =>
  named === undefined ? null : (workspaceRow(named)?.id ?? null);

export interface ProjectView {
  readonly root: string;
  readonly host: HostName;
  /** `--root` as the invocation typed it, or undefined when the root was discovered. */
  readonly given: string | undefined;
  /** This plan rebuilt from the parsed arguments, `--root` as typed: the command every repair runs next. */
  readonly invocation: string;
  /** B1's entry count of the packet the plan renders, and its digest. */
  readonly entries: number;
  readonly packetDigest: string;
  /** `ia host`'s projection element for that rendering: its file plan, its guard step, or the conflict it found. */
  readonly projection: Element;
}

/** Design row 27: the repair a conflict needs, worded as `ia host` words it, then this plan, which shows the file. */
const conflictNext = (view: ProjectView, conflict: Conflict): string =>
  projectionRepair(view.host, conflict.path, view.invocation, conflict.code);
const conflictRefusal = (view: ProjectView, conflict: Conflict): Refusal =>
  new Refusal(conflict.code, conflict.reason, 3, { path: conflict.path }, conflictNext(view, conflict));

/**
 * The plan. A host outside the adapters is usage, refused before anything is read (§3); then the root is resolved and
 * must be initialized and free of a pending host journal, as for `ia host`, and admit, as `renderProjectionFor`
 * requires. It reads the workspace and writes nothing.
 */
export function collectProject(context: Context): ProjectView {
  const { args } = context;
  const given = args.value('root'),
    option = given === undefined ? '' : ` --root ${quote(given)}`,
    named = args.positionals[0] ?? '',
    host = projectHost(named);
  if (host === null)
    throw new Refusal(
      'IA-CLI-USAGE',
      `ia project takes claude or codex; got ${named}`,
      2,
      null,
      `Run "ia project claude${option}" to plan the Claude projection, or name codex in its place.`,
    );
  const root = requireRoot(context);
  requireInitialized(root, given ?? root);
  // The journal's recovery names the resolved root: `ia-distribution` takes only an absolute one.
  requireIdle(root, root);
  const rendered = renderProjectionFor(root, host);
  return {
    root,
    host,
    given,
    invocation: `ia project ${host}${option}`,
    entries: rendered.receipt.entries,
    packetDigest: rendered.receipt.packetDigest,
    projection: projectionElement(root, host, rendered),
  };
}

/**
 * A failed apply, named as `ia host` names one: a pending host journal's recovery, a held host lock's, or else the
 * apply again, which converges whatever it found written (`applyHostProjection`).
 */
function applyFailure(error: unknown, view: ProjectView): Refusal {
  const refusal = refusalOf(error),
    journal = pendingJournal(view.root);
  if (journal !== undefined)
    return new Refusal(refusal.code, refusal.message, 3, { path: journal[0] }, recoverNext(view.root, journal[1]));
  return (
    lockRefusal(error, view.root) ??
    new Refusal(refusal.code, refusal.message, 3, refusal.where, `Run "${view.invocation} --apply" to finish.`)
  );
}
/**
 * The apply: the packet rendered again and re-planned through `ia host`'s projection element, so a file that changed
 * since the plan refuses before anything is written, then `applyHostProjection`, which returns the receipt it wrote.
 */
export function applyProject(view: ProjectView): PacketReceipt {
  const rendered = renderProjectionFor(view.root, view.host);
  replanProjection(view.root, view.host, rendered, (conflict) => conflictRefusal(view, conflict));
  try {
    // A render's apply always writes its receipt; only a removal, which this verb never runs, leaves none.
    return applyHostProjection(view.root, view.host, rendered).receipt!;
  } catch (error) {
    throw applyFailure(error, view);
  }
}

/** `--json`: the plan always, and `applied`, the receipt written, only after an apply. */
export const projectEnvelope = (view: ProjectView, applied: PacketReceipt | null): unknown => ({
  version: 1,
  command: 'project',
  root: view.root,
  host: view.host,
  apply: applied !== null,
  plan: {
    entries: view.entries,
    packetDigest: view.packetDigest,
    // With a conflict `files` is empty and `guard` null: an apply refuses it, so it writes and retires nothing.
    files: view.projection.files ?? [],
    guard: view.projection.guard ?? null,
    conflict: view.projection.conflict,
  },
  ...(applied === null ? {} : { applied }),
});

const headerBlock = (
  label: string,
  value: string,
  view: ProjectView,
  digest: string,
  caps: Capabilities,
): readonly string[] => [
  ...headerLine(label, value, [{ text: `packet ${truncateDigest(digest, caps.ascii)}`, column: 35 }], caps),
  ...headerLine('Root', view.root, [], caps),
];
/** The packet, the B11 step and any conflict, then the file plan in `ia host`'s words, then the guard's note. */
function planBlocks(view: ProjectView, caps: Capabilities): readonly (readonly string[])[] {
  const { conflict, files, guard } = view.projection;
  const fields: Field[] = [
    {
      symbol: 'info',
      label: 'packet',
      value: words(`${view.entries} entries, digest ${truncateDigest(view.packetDigest, caps.ascii)}`),
    },
    ...(guard === undefined
      ? []
      : [
          {
            symbol: guard === 'retire' ? ('success' as const) : ('info' as const),
            label: 'guard',
            value: words(guard === 'retire' ? GUARD_RETIRE : 'no steward guard to retire'),
          },
        ]),
    ...(conflict === null
      ? []
      : [
          {
            symbol: 'error' as const,
            label: 'refused',
            value: words(`${conflict.code} ${conflict.reason}`),
            action: remedyWords(conflictNext(view, conflict)),
          },
        ]),
  ];
  return [
    [sectionLabel('Projection', caps), ...fieldRows(fields, { depth: 1 }, caps)],
    files === undefined ? [] : [sectionLabel('Files', caps), ...projectionFileRows(files, indentOf(1), caps)],
    guard === 'retire' ? entry([words(GUARD_SCOPE)], { depth: 1, symbol: 'info' }, caps) : [],
  ];
}
const applyFacts = (view: ProjectView, caps: Capabilities) =>
  commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps);

/** The plan as a terminal reads it: it says nothing was written, and names the apply only when nothing refuses it. */
export function renderProjectPlan(view: ProjectView, caps: Capabilities): string {
  return document(
    [
      headerBlock('Plan', `project ${view.host}`, view, view.packetDigest, caps),
      entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps),
      ...planBlocks(view, caps),
      view.projection.conflict === null ? entry(applyFacts(view, caps), { depth: 0, symbol: 'step' }, caps) : [],
    ],
    { leadingBlank: true },
  );
}
/** §2.8 rule 3's summary: the plan without its note or footer, because the question is the action. */
const renderProjectSummary = (view: ProjectView, caps: Capabilities): string =>
  document([headerBlock('Plan', `project ${view.host}`, view, view.packetDigest, caps), ...planBlocks(view, caps)], {
    leadingBlank: true,
  });

/**
 * An apply's report, read from the receipt it wrote (B12): the files with their digests, the legacy files deleted, the
 * foreign files left in place and the guard's retirement. It says what was written, never that the host read it
 * (design §4, adapter rule 3).
 */
export function renderProjectApplied(view: ProjectView, receipt: PacketReceipt, caps: Capabilities): string {
  const digest = (value: string): string => truncateDigest(value, caps.ascii);
  const listed = (
    label: string,
    rows: readonly { readonly path: string; readonly sha256?: string }[],
    symbol: 'added' | 'removed' | 'info',
  ): readonly string[] =>
    rows.length === 0
      ? []
      : [
          sectionLabel(label, caps),
          ...rows.flatMap((row) =>
            entry(
              [
                [
                  atom(row.path, 'cyan', 0),
                  ...(row.sha256 === undefined ? [] : words(`sha256 ${digest(row.sha256)}`, 'dim', 2)),
                ],
              ],
              { depth: 1, symbol },
              caps,
            ),
          ),
        ];
  const doctor = `ia doctor${view.given === undefined ? '' : ` --root ${quote(view.given)}`}`;
  return document(
    [
      headerBlock('Project', view.host, view, receipt.packetDigest, caps),
      entry(
        [
          words(`Projected ${receipt.entries} entries for ${view.host}: written; not observed being read.`),
          ...(receipt.guard === 'retired' ? [words(GUARD_RETIRED)] : []),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      [sectionLabel('Receipt', caps), ...entry([[atom(STATE.receipt(view.host), 'cyan', 0)]], { depth: 1 }, caps)],
      listed('Files', receipt.files, 'added'),
      listed('Removed', receipt.removed, 'removed'),
      listed(
        'Foreign, left in place',
        receipt.foreign.map((path) => ({ path })),
        'info',
      ),
      entry([remedyWords(`Run "${doctor}" for the observed projection state.`)], { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );
}

export const CONFIRMATION = 'Apply this projection? [y/N] ';

/** A refusal another module worded, its `ia validate` and `ia project` commands given `--root` as typed. */
function rootedRefusal(context: Context, error: unknown): unknown {
  const given = context.args.value('root'),
    host = projectHost(context.args.positionals[0]);
  if (!(error instanceof Refusal) || error.next === null || given === undefined || host === null) return error;
  return new Refusal(error.code, error.message, error.exit, error.where, rootedNext(error.next, host, given), error.at);
}

export async function runProject(context: Context): Promise<Result> {
  const { args, caps, host, json } = context;
  let view: ProjectView;
  try {
    view = collectProject(context);
  } catch (error) {
    throw rootedRefusal(context, error);
  }
  const report = (applied: PacketReceipt | null): Result =>
    json
      ? { exitCode: 0, stdout: JSON.stringify(projectEnvelope(view, applied)) + '\n', stderr: '' }
      : {
          exitCode: 0,
          stdout: applied === null ? renderProjectPlan(view, caps) : renderProjectApplied(view, applied, caps),
          stderr: '',
        };
  // §4: a plan with a conflict is a successful report; only --apply refuses it, before it asks anything.
  if (!args.flag('apply')) return report(null);
  if (view.projection.conflict !== null) throw conflictRefusal(view, view.projection.conflict);
  // §2.8 rule 3. Parsing has already refused every --apply whose question cannot be asked or answered.
  if (!args.flag('yes') && !(await confirm(host.interaction, renderProjectSummary(view, caps), CONFIRMATION)))
    return {
      exitCode: 0,
      stdout: document(
        [
          entry([words('Nothing was applied.')], { depth: 0, symbol: 'info' }, caps),
          entry(applyFacts(view, caps), { depth: 0, symbol: 'step' }, caps),
        ],
        { leadingBlank: true },
      ),
      stderr: '',
    };
  host.signal?.throwIfAborted();
  let receipt: PacketReceipt;
  try {
    receipt = applyProject(view);
  } catch (error) {
    throw rootedRefusal(context, error);
  }
  return report(receipt);
}
