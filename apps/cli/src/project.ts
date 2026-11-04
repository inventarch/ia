/**
 * `ia project`: the project effect (SPEC `project`; runtime R19 and R20).
 *
 * The workspace projection alone: the position packet of the workspace's admitted records (runtime R19), rendered by
 * the host's adapter for the consumer target (R20) through `renderProjectionFor`, the render `ia host`, `ia doctor` and
 * the install refresh read. It plans by default, as `ia host` and `ia install` do, and the plan writes nothing: it is
 * `ia host`'s projection element (`projectionElement`), the steward-guard retirement and the file plan an apply would
 * make, beside the packet's entry count and digest. `--apply` re-plans through the same element (`replanProjection`)
 * and writes through `applyHostProjection`, the one writer of projection files, which retires a steward guard an
 * earlier release registered before any file changes, deletes the owned 1.x steward files, leaves foreign ones and
 * writes the receipt. It writes the generated agents and skills of the workspace's authored records with the packet,
 * and keeps the hook groups an `ia host` registration owns in step with the authored `@hook` records, against the
 * payload that registration recorded; it registers no MCP server and no hook group of its own, so a hook with no
 * registration to join is reported as not taken. `ia host`'s projection element is this same plan and apply. The packet
 * reads the live admitted revision, so no capture is required. A plan with a conflict is a successful report naming the
 * file, as `ia host`'s is (host registration §5); only `--apply` refuses it, before anything is asked or written,
 * naming the plan to run once the file is out of the way. The `ia project`, `ia validate` and `ia init` commands a next
 * action names carry the root as the invocation typed it; the `ia recover` command a pending host journal or a held
 * host lock names carries the resolved root, because its distribution mechanism takes only an absolute root, and a
 * workspace whose sources cannot be opened names the resolved root, as for every workspace verb (`openSession`).
 */
import { workspaceRow } from '@inventarch/distribution/hosts';
import type { HostOutput, PacketReceipt } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, requireRoot } from './consumer.js';
import type { HostName } from './host-projection.js';
import { applyHostProjection, renderProjectionFor } from './host-projection.js';
import { sessionGate } from './profile.js';
import { runPluginProduct } from './plugin-product.js';
import type { Conflict, Element } from './host.js';
import {
  GUARD_RETIRE,
  GUARD_RETIRED,
  GUARD_SCOPE,
  projectionElement,
  projectionFailure,
  projectionFileRows,
  projectionHookRows,
  projectionRepair,
  replanProjection,
  requireIdle,
  requireWorkspace,
  rootedNext,
  folderRepair,
  printedConflict,
  hookRepair,
  STATE,
  unsupportedRows,
} from './host.js';
import type { AdviceContext, Capabilities, Field } from './render.js';
import {
  atom,
  commandFacts,
  document,
  entry,
  fieldRows,
  headerLine,
  indentOf,
  quote,
  safeRootAdvice,
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
  /** The entry count of the packet the plan renders, and its digest. */
  readonly entries: number;
  readonly packetDigest: string;
  /** `ia host`'s projection element for that rendering: its file plan, its guard step, or the conflict it found. */
  readonly projection: Element;
  /** That rendering, made on the session the mandate gate judged; the apply writes exactly it. */
  readonly rendered: HostOutput;
}

/** The repair a conflict needs, worded as `ia host` words it, then this plan, which shows the file. */
const conflictNext = (view: ProjectView, conflict: Conflict): string => {
  // A hook refusal's repair names `ia host`; with `--root` given it carries it as typed, as the plan does.
  if (conflict.hook !== undefined)
    return view.given === undefined
      ? hookRepair(conflict.hook)
      : rootedNext(hookRepair(conflict.hook), view.host, view.given);
  if (conflict.folder !== undefined) return folderRepair(conflict.folder, view.invocation);
  return projectionRepair(view.host, conflict.path, view.invocation, conflict.code);
};
const conflictRefusal = (view: ProjectView, conflict: Conflict): Refusal =>
  new Refusal(conflict.code, conflict.reason, 3, { path: conflict.path }, conflictNext(view, conflict));

/**
 * The plan. A host outside the adapters is usage, refused before anything is read (consumer CLI contract §1.2); then
 * the root is resolved and must be initialized and free of a pending host journal, as for `ia host`, and admit, as
 * `renderProjectionFor` requires. It reads the workspace and writes nothing.
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
  requireWorkspace(root, given ?? root);
  // The journal's recovery names the resolved root: the distribution mechanism takes only an absolute one.
  requireIdle(root, root);
  // The effect mode (Execution) under the participant's mandate profile, a plan included, judged on the rendering session
  // before the packet is read from it.
  const rendered = renderProjectionFor(root, host, sessionGate(context, 'effect'));
  return {
    root,
    host,
    given,
    invocation: `ia project ${host}${option}`,
    entries: rendered.receipt.entries,
    packetDigest: rendered.receipt.packetDigest,
    projection: projectionElement(root, host, rendered),
    rendered,
  };
}

/**
 * A failed apply, named as `ia host` names one: a pending host journal's recovery, a held host lock's, or else the
 * apply again, which converges whatever it found written (`applyHostProjection`).
 */
function applyFailure(error: unknown, view: ProjectView): Refusal {
  return projectionFailure(error, view.root, view.host, `${view.invocation} --apply`);
}
/**
 * The apply: the rendering the plan made on its gated session, re-planned through `ia host`'s projection element
 * against the files as they are now, so a file that changed since the plan refuses before anything is written, then
 * `applyHostProjection`, which returns the receipt it wrote.
 */
export function applyProject(view: ProjectView): PacketReceipt {
  const { rendered } = view;
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
    hooks: view.projection.hooks ?? [],
    unsupported: view.projection.unsupported ?? [],
    conflict: printedConflict(view.projection.conflict),
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
/** The packet, the retirement and any conflict, then the file plan in `ia host`'s words, then the guard's note. */
function planBlocks(view: ProjectView, caps: Capabilities): readonly (readonly string[])[] {
  const { conflict, files, guard, hooks, unsupported } = view.projection;
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
            action: remedyWords(safeRootAdvice(conflictNext(view, conflict), [view.root, view.given])),
          },
        ]),
  ];
  return [
    [sectionLabel('Projection', caps), ...fieldRows(fields, { depth: 1 }, caps)],
    files === undefined ? [] : [sectionLabel('Files', caps), ...projectionFileRows(files, indentOf(1), caps)],
    hooks === undefined || hooks.length === 0
      ? []
      : [sectionLabel('Hook groups', caps), ...projectionHookRows(hooks, indentOf(1), caps)],
    unsupported === undefined || unsupported.length === 0
      ? []
      : [sectionLabel('Not taken', caps), ...unsupportedRows(unsupported, indentOf(1), caps)],
    guard === 'retire' ? entry([words(GUARD_SCOPE)], { depth: 1, symbol: 'info' }, caps) : [],
  ];
}
const applyFacts = (view: ProjectView, caps: Capabilities) =>
  commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps, [view.root, view.given]);

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
/** Consumer CLI contract §2.0's summary: the plan without its note or footer, because the question is the action. */
const renderProjectSummary = (view: ProjectView, caps: Capabilities): string =>
  document([headerBlock('Plan', `project ${view.host}`, view, view.packetDigest, caps), ...planBlocks(view, caps)], {
    leadingBlank: true,
  });

/**
 * An apply's report, read from the receipt it wrote: the files with their digests, the legacy files deleted, the
 * foreign files left in place and the guard's retirement. It says what was written, never that the host read it.
 */
export function renderProjectApplied(
  view: ProjectView,
  receipt: PacketReceipt,
  caps: Capabilities,
  advice?: AdviceContext,
): string {
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
      listed(
        'Hook groups',
        (receipt.hooks ?? []).map((row) => ({ path: row.identity, sha256: row.sha256 })),
        'added',
      ),
      (receipt.unsupported ?? []).length === 0
        ? []
        : [sectionLabel('Not taken', caps), ...unsupportedRows(receipt.unsupported ?? [], indentOf(1), caps)],
      entry(
        [
          remedyWords(
            safeRootAdvice(`Run "${doctor}" for the observed projection state.`, [view.root, view.given], advice),
          ),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
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
  return new Refusal(
    error.code,
    error.message,
    error.exit,
    error.where,
    rootedNext(error.next, host, given),
    error.at,
    undefined,
    error.details,
  );
}

/** `--out`, `--check` and `--compare` belong to the plugin form; without `--product plugin` each is usage (exit 2). */
function requirePluginProduct(context: Context): void {
  const { args } = context;
  const stray = ['out', 'check', 'compare'].find((name) =>
    name === 'check' ? args.flag(name) : args.value(name) !== undefined,
  );
  if (stray === undefined) return;
  const given = args.value('root'),
    named = projectHost(args.positionals[0]) ?? 'claude';
  throw new Refusal(
    'IA-CLI-USAGE',
    `--${stray} belongs to the plugin form, ia project <host> --product plugin; the workspace projection takes none of --out, --check or --compare`,
    2,
    null,
    `Run "ia project ${named} --product plugin --check${given === undefined ? '' : ` --root ${quote(given)}`}" to check the plugin a lowered workspace renders.`,
  );
}

export async function runProject(context: Context): Promise<Result> {
  const { args, caps, host, json } = context;
  if (args.value('product') === 'plugin') return runPluginProduct(context);
  requirePluginProduct(context);
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
          stdout: applied === null ? renderProjectPlan(view, caps) : renderProjectApplied(view, applied, caps, host),
          stderr: '',
        };
  // Host registration §5: a plan with a conflict is a successful report; only --apply refuses it, before it asks
  // anything.
  if (!args.flag('apply')) return report(null);
  if (view.projection.conflict !== null) throw conflictRefusal(view, view.projection.conflict);
  // Contract §2.0. Parsing has already refused every --apply whose question cannot be asked or answered.
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
