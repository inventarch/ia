/**
 * `ia validate`: docs/specs/consumer-cli-contract/README.md §2.5, rendered per §6.5 and §7.4/§7.5.
 *
 * Admission is whole-workspace by construction, so positionals restrict reporting and never admission: the
 * summary always states the true total and the exit class is computed from the unfiltered finding set.
 *
 * Acquisition and presentation are separated so that §7's reference blocks can be produced by this verb's own
 * renderer over this verb's own captured data — tools/docs/cli-examples.ts calls `collectValidation` and
 * `renderValidation` rather than recomposing the report from renderer primitives. The only value that tool
 * supplies of its own is the display root, which §2.5 already defines as a CLI-resolved value and which is the
 * one part of this output that differs between machines.
 */
import { openWorkspaceSession } from '@inventarch/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import type { Capabilities, ErrorElements, Token } from './render.js';
import {
  atom,
  blockSymbolWidth,
  contentColumn,
  document,
  entry,
  errorBlock,
  headerLine,
  sectionLabel,
  statusSymbol,
  truncateDigest,
  words,
} from './render.js';

type Session = ReturnType<typeof openWorkspaceSession>;
type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];
export type Severity = 'error' | 'warning';

/** §2.5: `fail` on any error, else `not-evaluated` on an unresolved or unevaluated check, else `pass`. */
export type ReportOutcome = 'pass' | 'fail' | 'not-evaluated';
export const NOT_EVALUATED: ReadonlySet<string> = new Set(['IA-COMP-EDGE-UNRESOLVED', 'IA-COMP-NOT-EVALUATED']);

/**
 * §6.5's next action "names a command, a file, or a specific thing to change". These are the codes for which one
 * sentence is true of every instance; a code that has no such sentence gets none rather than a filler. Nothing
 * here infers a cause across findings — §7.5's "both errors come from one edit" is an authoring-history claim the
 * finding shape cannot support, so it is not reproduced.
 */
const ACTIONS: Readonly<Record<string, string>> = {
  'IA-COMP-NOT-EVALUATED': 'Supply the evaluator each check above names, then run "ia validate" again.',
  'IA-COMP-EDGE-UNRESOLVED': 'Resolve or remove the named relationship target, then run "ia validate" again.',
  'IA-COMP-FRAGMENT-MISSING':
    'Declare the named fragment on the target contract, or correct the reference that names it.',
  'IA-COMP-COVERAGE-MISSING':
    'Add an unconditional implementing case for the named requirement, or withdraw the requirement.',
  'IA-COMP-DISCRIMINATOR-FOREIGN':
    'Declare the owning system as a direct requirement, or move the record to a system that already requires it.',
};

export const locationOf = (finding: Finding): string | null =>
  finding.path === '' ? null : `${finding.path}:${finding.line}`;
/** Error, warning and not-evaluated counts over one finding set; `ia capture` reports admission with the same three. */
export const countsOf = (findings: readonly Finding[]) => ({
  errors: findings.filter((finding) => finding.severity === 'error').length,
  warnings: findings.filter((finding) => finding.severity === 'warning').length,
  notEvaluated: findings.filter((finding) => NOT_EVALUATED.has(finding.code)).length,
});
const findingKey = (finding: Finding): string =>
  JSON.stringify([finding.code, finding.path, finding.line, finding.message]);

/** §6.5 element 1: a finding with no location of its own is rendered beside the check that produced it. */
export const checkNames = (
  verdicts: readonly { readonly check: string; readonly findings: readonly Finding[] }[],
): ReadonlyMap<string, string> => {
  const byFinding = new Map<string, string>();
  for (const verdict of verdicts)
    for (const finding of verdict.findings)
      if (!byFinding.has(findingKey(finding))) byFinding.set(findingKey(finding), verdict.check);
  return byFinding;
};

/** §2.5: a positional selects for reporting by exact file or by directory prefix, relative to the root. */
const selects = (finding: Finding, filters: readonly string[]): boolean => {
  if (filters.length === 0) return true;
  const path = finding.path.replaceAll('\\', '/');
  return filters.some((raw) => {
    const filter = raw.replaceAll('\\', '/').replace(/\/+$/, '');
    return path === filter || path.startsWith(filter + '/');
  });
};

export interface ValidationView {
  /** The path the CLI resolved, never the runtime's own `result.root`, which is always empty (§2.5). */
  readonly root: string;
  readonly revision: string;
  readonly status: 'admitted' | 'refused';
  readonly outcome: ReportOutcome;
  readonly records: number;
  /** Every finding, unfiltered: the counts and the exit class are computed from this. */
  readonly findings: readonly Finding[];
  readonly checks: ReadonlyMap<string, string>;
}
export interface ValidationOptions {
  readonly filters: readonly string[];
  readonly severity: Severity;
  readonly limit: number;
}
export const DEFAULT_OPTIONS: ValidationOptions = { filters: [], severity: 'warning', limit: 50 };
export const validationExit = (view: ValidationView): 0 | 1 => (countsOf(view.findings).errors === 0 ? 0 : 1);

/** Opens the workspace, reads its admission and closes it. The only part of this verb that touches a workspace. */
export function collectValidation(root: string): ValidationView {
  let session: Session;
  try {
    session = openWorkspaceSession({ root });
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'IA-DB-ROOT-INVALID';
    throw new Refusal(
      code,
      error instanceof Error ? error.message : String(error),
      3,
      { path: root },
      code === 'IA-DB-SOURCE-UNAVAILABLE'
        ? `An interrupted installation blocks the read. Run "ia-distribution recover --root ${root}".`
        : 'Pass --root <path> with an existing workspace, or run "ia init" to see what a new one would contain.',
    );
  }
  try {
    const admission = session.admission();
    return {
      root,
      revision: admission.revision,
      status: admission.status,
      outcome: session.reader.report.outcome,
      records: admission.records,
      findings: admission.findings,
      checks: checkNames(session.reader.report.verdicts),
    };
  } finally {
    session.close();
  }
}

interface Selection {
  readonly reported: readonly Finding[];
  readonly shown: readonly Finding[];
  readonly hiddenBySeverity: number;
  readonly hiddenByPath: number;
}
const select = (view: ValidationView, options: ValidationOptions): Selection => {
  const bySeverity = view.findings.filter((finding) => options.severity === 'warning' || finding.severity === 'error');
  const reported = bySeverity.filter((finding) => selects(finding, options.filters));
  return {
    reported,
    shown: reported.slice(0, options.limit),
    hiddenBySeverity: view.findings.length - bySeverity.length,
    hiddenByPath: bySeverity.length - reported.length,
  };
};

export function validationEnvelope(view: ValidationView, options: ValidationOptions): unknown {
  const { reported, shown } = select(view, options);
  return {
    version: 1,
    root: view.root,
    revision: view.revision,
    status: view.status,
    reportOutcome: view.outcome,
    counts: countsOf(view.findings),
    findings: shown,
    truncated: shown.length < reported.length,
  };
}

const element = (view: ValidationView, finding: Finding, width: number): ErrorElements => {
  const location = locationOf(finding);
  const check = view.checks.get(findingKey(finding));
  // The whole-workspace checks embed their own name in the message; elements 1 and 3 already carry it.
  const message =
    check !== undefined && finding.message.startsWith(check + ': ')
      ? finding.message.slice(check.length + 2)
      : finding.message;
  return {
    location,
    ...(location === null && check !== undefined ? { check } : {}),
    ...(finding.identity === undefined ? {} : { identity: finding.identity }),
    code: finding.code,
    message,
    severity: finding.severity,
    symbolWidth: width,
  };
};

/** §7.4's collapse: findings differing only in the fragment their message names are one row plus a dim tail. */
const FRAGMENT = /#[A-Za-z0-9][A-Za-z0-9-]*/;
const recordKey = (finding: Finding): string =>
  JSON.stringify([finding.code, finding.path, finding.line, finding.identity ?? null]);
interface Collapsed {
  readonly head: Finding;
  readonly rest: readonly Finding[];
}
const collapseByRecord = (findings: readonly Finding[]): readonly Collapsed[] => {
  const rows: { head: Finding; rest: Finding[] }[] = [];
  for (const finding of findings) {
    const previous = rows.at(-1);
    // Only an adjacent run collapses, so the document order the compliance layer sorted into is preserved.
    if (previous !== undefined && recordKey(previous.head) === recordKey(finding) && finding.path !== '')
      previous.rest.push(finding);
    else rows.push({ head: finding, rest: [] });
  }
  return rows;
};
const collapseTail = (rest: readonly Finding[]): string => {
  const fragments = rest.map((finding) => FRAGMENT.exec(finding.message)?.[0]);
  const named = fragments.every((fragment) => fragment !== undefined) ? fragments.join(', ') : '';
  return `${rest.length} more on this record${named === '' ? '.' : `: ${named}`}`;
};

/**
 * §6.5's grouping rule: "When several findings share a next action, the action is printed once under the group
 * rather than repeated per finding." A next action is keyed by finding code, so an adjacent run of one code is
 * one group and its action is attached to the group's last rendered entry, where errorBlock places it.
 */
const severitySection = (view: ValidationView, rows: readonly Finding[], caps: Capabilities): readonly string[] => {
  const width = blockSymbolWidth(
    rows.map((finding) => finding.severity),
    caps.ascii,
  );
  const collapsed = collapseByRecord(rows);
  const lines: string[] = [];
  for (const [index, group] of collapsed.entries()) {
    const column = contentColumn(2, statusSymbol(group.head.severity, caps.ascii), width);
    lines.push(...errorBlock(element(view, group.head, width), { depth: 1 }, caps));
    if (group.rest.length > 0)
      lines.push(...entry([[atom(collapseTail(group.rest), 'dim', 0)]], { column, symbol: 'info' }, caps));
    const action = ACTIONS[group.head.code];
    // The action closes the run, so a code that appears several times in a row carries one action, not one each.
    if (action !== undefined && collapsed[index + 1]?.head.code !== group.head.code)
      lines.push(...entry([words(action)], { column, symbol: 'step' }, caps));
  }
  return lines;
};

export function renderValidation(view: ValidationView, options: ValidationOptions, caps: Capabilities): string {
  const total = countsOf(view.findings);
  const { reported, shown, hiddenBySeverity, hiddenByPath } = select(view, options);
  const summary: (readonly Token[])[] = [
    words(
      `${view.status === 'admitted' ? 'Admitted' : 'Refused'}. ${view.records} records, ${total.errors} errors, ${total.warnings} warnings.`,
    ),
  ];
  if (hiddenBySeverity > 0)
    summary.push(words(`${hiddenBySeverity} warnings hidden by --severity ${options.severity}.`));
  if (hiddenByPath > 0)
    summary.push(
      words(
        `${hiddenByPath} ${hiddenByPath === 1 ? 'finding' : 'findings'} elsewhere in the workspace hidden by the path filter; admission is whole-workspace and the counts above are unfiltered.`,
      ),
    );
  if (view.outcome === 'not-evaluated')
    summary.push(
      words(
        `Admission outcome: not-evaluated. No evaluator was supplied for ${total.notEvaluated} checks, so this run is not a pass.`,
      ),
    );
  const blocks: (readonly string[])[] = [
    headerLine(
      'Workspace',
      view.root,
      [{ text: `revision ${truncateDigest(view.revision, caps.ascii)}`, column: 50 }],
      caps,
    ),
    entry(summary, { depth: 1, symbol: total.errors === 0 ? 'success' : 'error' }, caps),
  ];
  for (const group of [
    { label: 'Errors', severity: 'error' as const },
    { label: 'Warnings', severity: 'warning' as const },
  ]) {
    const rows = shown.filter((finding) => finding.severity === group.severity);
    if (rows.length === 0) continue;
    blocks.push([sectionLabel(group.label, caps), ...severitySection(view, rows, caps)]);
  }
  if (shown.length < reported.length)
    blocks.push(
      entry(
        [
          words(
            `${caps.ascii ? '...' : '…'} and ${reported.length - shown.length} more; raise --max-findings to see them.`,
            'dim',
          ),
        ],
        { depth: 0 },
        caps,
      ),
    );
  blocks.push(
    entry(
      [
        words(
          total.errors > 0
            ? 'Fix the errors above and run "ia validate" again.'
            : view.outcome === 'not-evaluated'
              ? 'A not-evaluated result is not a pass. Supply the named evaluator to obtain one.'
              : 'Every declared structural obligation is satisfied at this revision.',
        ),
      ],
      { depth: 0, symbol: 'step' },
      caps,
    ),
  );
  return document(blocks, { leadingBlank: true });
}

export function runValidate(context: Context): Result {
  const { args, caps, json } = context;
  const view = collectValidation(requireRoot(context));
  const options: ValidationOptions = {
    filters: args.positionals,
    severity: (args.value('severity') ?? 'warning') as Severity,
    limit: args.integer('max-findings', 50),
  };
  const exitCode = validationExit(view);
  return json
    ? { exitCode, stdout: JSON.stringify(validationEnvelope(view, options)) + '\n', stderr: '' }
    : { exitCode, stdout: renderValidation(view, options, caps), stderr: '' };
}
