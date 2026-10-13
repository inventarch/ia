/**
 * `ia validate`: docs/specs/consumer-cli-contract/README.md §2.4–2.5 (capture and validation), §4 (refusals) and §6 (terminal rendering).
 *
 * Admission is whole-workspace by construction, so positionals restrict reporting and never admission: the
 * summary always states the true total and the exit class is computed from the unfiltered finding set.
 *
 * Acquisition and presentation are separated (review finding B2-N9): `collectValidation` is the only part of this
 * verb that touches a workspace, and `renderValidation` and `validationEnvelope` render only the view it captured,
 * so the human report and the JSON envelope describe one acquisition and a test can render a captured view without
 * opening a workspace. The display root is the one value the view carries that differs between machines (§2.5).
 *
 * Task execution-binding-host-entry (plan amendment C24): the report also carries the workspace's execution bindings,
 * each joined against the installed-implementation catalog its host joined, through the same distribution service
 * `ia-distribution validate` reports (`WorkspaceSession.bindings`). A revoked binding is an error and fails the run;
 * an unavailable one is never a pass. Computing them writes nothing and executes nothing (C23; milestone 7 runs
 * operations); the evidence below is the one write this verb makes. With no `@execution-binding` record the human
 * report is unchanged.
 *
 * Review finding B2-R2: a join binds only through this installation's own payload (`validationTrust`), the one its
 * bundled pin names in the IA home it materializes payloads in; a registration of any other payload is unavailable.
 *
 * Task check-runner-join-validate (plan amendments C14, C15, C21, C22 and C23): `ia validate` is the validate request.
 * Its session admits checks structurally (an unknown evaluator is admitted and reported, not refused) and reads no
 * evidence (review finding B3-R4), so its findings, counts, checks and exit are the authored view's alone and its
 * `revision` is the one every other reader reports (B3-N4); it binds every `@check` (`WorkspaceSession.checks`, through the same trust) and records the
 * evidence of the bound ones that passed or failed through `recordValidation`, the one writer of evidence, which
 * `ia-distribution validate` calls too. A revoked check is an error; an unavailable or not-evaluated one is never a
 * pass. With no `@check` record the human report is unchanged.
 */
import { EVIDENCE_DIRECTORY } from '@inventarch/db';
import type { EvidenceWrite } from '@inventarch/db';
import { readHostPin } from '@inventarch/distribution/host-home';
import { installationTrust } from '@inventarch/distribution/implementations';
import type { HostTrust } from '@inventarch/distribution/implementations';
import { recordValidation } from '@inventarch/distribution/services';
import type { ValidationBindings, ValidationChecks } from '@inventarch/distribution/services';
import type { Context, Host, Result } from './consumer.js';
import { iaHomeOf, Refusal, requireRoot } from './consumer.js';
import type { Capabilities, ErrorElements, SymbolName, Token } from './render.js';
import {
  atom,
  blockSymbolWidth,
  contentColumn,
  document,
  entry,
  errorBlock,
  headerLine,
  quote,
  sectionLabel,
  statusSymbol,
  truncateDigest,
  words,
} from './render.js';
import { sessionGate } from './profile.js';
import type { SessionGate } from './profile.js';
import { codeOf, openSession, VALIDATING } from './session.js';
import type { Session } from './session.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];
export type Severity = 'error' | 'warning';

/** §2.5: `fail` on any error, else `not-evaluated` on an unresolved or unevaluated check, else `pass`. */
export type ReportOutcome = 'pass' | 'fail' | 'not-evaluated';
export const NOT_EVALUATED: ReadonlySet<string> = new Set(['IA-COMP-EDGE-UNRESOLVED', 'IA-COMP-NOT-EVALUATED']);

/**
 * The “Refusals” contract requires a runnable repair where one exists. These are the codes for which one
 * sentence is true of every instance; a code that has no such sentence gets none rather than a filler. Nothing
 * here infers a cause across findings — “Both errors come from one edit” is an authoring-history claim the
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
const countsOf = (findings: readonly Finding[]) => ({
  errors: findings.filter((finding) => finding.severity === 'error').length,
  warnings: findings.filter((finding) => finding.severity === 'warning').length,
  notEvaluated: findings.filter((finding) => NOT_EVALUATED.has(finding.code)).length,
});
const findingKey = (finding: Finding): string =>
  JSON.stringify([finding.code, finding.path, finding.line, finding.message]);

/** Terminal rendering: a finding with no location of its own is rendered beside the check that produced it. */
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
  /** The authored revision, which names the evidence this request records (review finding B3-N4). */
  readonly authoredRevision: string;
  readonly status: 'admitted' | 'refused';
  readonly outcome: ReportOutcome;
  readonly records: number;
  /** Every finding, unfiltered: the counts and the exit class are computed from this. */
  readonly findings: readonly Finding[];
  readonly checks: ReadonlyMap<string, string>;
  /** Every admitted `@execution-binding` joined against the catalog this workspace's host joined, unfiltered. */
  readonly bindings: ValidationBindings;
  /** Every admitted `@check` bound, unfiltered (C15, C22). */
  readonly checkBindings: ValidationChecks;
  /** What this validate request recorded as evidence (C14). */
  readonly evidence: EvidenceWrite;
}
export interface ValidationOptions {
  readonly filters: readonly string[];
  readonly severity: Severity;
  readonly limit: number;
}
export const DEFAULT_OPTIONS: ValidationOptions = { filters: [], severity: 'warning', limit: 50 };
const bindingCounts = (bindings: ValidationBindings) => ({
  bound: bindings.results.filter((binding) => binding.status === 'bound').length,
  unavailable: bindings.results.filter((binding) => binding.status === 'unavailable').length,
  revoked: bindings.results.filter((binding) => binding.status === 'revoked').length,
});
/** The checks naming an evaluator that is not built in, which only a structural admission admits (C21). */
const structurallyAdmitted = (checks: ValidationChecks): readonly string[] =>
  checks.results
    .filter((check) => check.runner !== null && check.implementation !== 'built-in')
    .map((check) => check.identity);
/** `identities` as one phrase: `a`, `a and b`, `a, b and c`. */
const listed = (identities: readonly string[]): string =>
  identities.length <= 1 ? (identities[0] ?? '') : `${identities.slice(0, -1).join(', ')} and ${identities.at(-1)}`;
const checkCounts = (checks: ValidationChecks) => ({
  revoked: checks.results.filter((check) => check.status === 'revoked').length,
  /** Checks naming an evaluator that is not built in, which only a structural admission admits (C21). */
  structural: structurallyAdmitted(checks).length,
  notEvaluated: checks.results.filter((check) => check.status !== 'revoked' && check.outcome === 'not-evaluated')
    .length,
});
/** 1 when admission has an error or a binding or check is revoked, an error too; unavailable and not-evaluated are not. */
export const validationExit = (view: ValidationView): 0 | 1 =>
  countsOf(view.findings).errors === 0 &&
  bindingCounts(view.bindings).revoked === 0 &&
  checkCounts(view.checkBindings).revoked === 0
    ? 0
    : 1;
/**
 * The refusal for evidence that could not be recorded (C14): located at the path the service names, with the repair. The
 * validation it reports is discarded, as a refused effect's report is.
 */
function evidenceRefusal(error: unknown, root: string): Refusal {
  const code = codeOf(error, 'IA-CLI-FAILED'),
    message = error instanceof Error ? error.message : String(error),
    located =
      error !== null && typeof error === 'object' && 'path' in error && typeof error.path === 'string'
        ? error.path
        : EVIDENCE_DIRECTORY;
  const rerun = `ia validate --root ${quote(root)}`;
  return new Refusal(
    code,
    message,
    3,
    { path: located },
    code === 'IA-DB-PATH-UNSAFE'
      ? `Replace only the unsafe entry ${located}, without following it or deleting its target, with a plain entry of the required kind inside this workspace, then run "${rerun}".`
      : `Make ${EVIDENCE_DIRECTORY} writable, then run "${rerun}".`,
  );
}

/**
 * The installation a validation trusts a join through (review finding B2-R2): the release this package's bundled host
 * payload pin names, materialized in the IA home `env` resolves. Run from inside a host payload, whose copy of this
 * package carries no pin, it is that payload (`installationTrust`). Null, so nothing binds, when there is neither or
 * the IA home cannot be resolved.
 */
export function validationTrust(host: Pick<Host, 'env' | 'packageRoot'>): HostTrust | null {
  let release: string;
  try {
    release = readHostPin(host.packageRoot).pin.release;
  } catch {
    return installationTrust();
  }
  const home = iaHomeOf(host.env);
  return home === undefined ? null : { home, release };
}
/**
 * Opens the workspace, reads its admission, binds its checks, records their evidence and closes it. The only part of this
 * verb that touches a workspace, and the evidence it records is the one write it makes. `gate`, when given, judges the
 * session before admission is read or any evidence is recorded, so a refused profile writes nothing (review C2-N3).
 */
export function collectValidation(root: string, trust: HostTrust | null, gate?: SessionGate): ValidationView {
  const session: Session = openSession(root, VALIDATING);
  try {
    gate?.(session);
    // The distribution's one validation service, which `ia-distribution validate` reports as well: admission's findings
    // and the warnings for db D02a/D02b declarations that declare nothing.
    const admission = session.validation(),
      checkBindings = session.checks(trust);
    let evidence: EvidenceWrite;
    try {
      evidence = recordValidation(session, checkBindings);
    } catch (error) {
      throw evidenceRefusal(error, root);
    }
    return {
      root,
      revision: admission.revision,
      authoredRevision: admission.authoredRevision,
      status: admission.status,
      outcome: session.reader.report.outcome,
      records: admission.records,
      findings: admission.findings,
      checks: checkNames(session.reader.report.verdicts),
      bindings: session.bindings(trust),
      checkBindings,
      evidence,
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
    authoredRevision: view.authoredRevision,
    status: view.status,
    reportOutcome: view.outcome,
    counts: countsOf(view.findings),
    findings: shown,
    truncated: shown.length < reported.length,
    bindings: view.bindings,
    checks: view.checkBindings,
    evidence: view.evidence,
  };
}
const CHECK_SYMBOL = (check: ValidationChecks['results'][number]): SymbolName =>
  check.status === 'revoked' || check.outcome === 'fail'
    ? 'error'
    : check.status === 'bound' && check.outcome === 'pass'
      ? 'success'
      : 'unknown';
interface ResultRow {
  readonly symbol: SymbolName;
  readonly identity: string;
  readonly result: string;
  readonly reason: string;
}
/**
 * One entry per binding or check (review finding B2-N3): the identity on the symbol's line, then the result and the
 * reason each on a line of its own at the entry's content column, so a long identity never squeezes them into a narrow
 * value column.
 */
const resultRows = (rows: readonly ResultRow[], caps: Capabilities): readonly string[] => {
  const symbolWidth = blockSymbolWidth(
    rows.map((row) => row.symbol),
    caps.ascii,
  );
  return rows.flatMap((row) =>
    entry(
      [[atom(row.identity, null, 0)], words(row.result), words(row.reason, 'dim')],
      { depth: 1, symbol: row.symbol, symbolWidth },
      caps,
    ),
  );
};
/** The Checks section: the catalog any non-built-in check binds against, one entry per check, then what was recorded. */
const checksSection = (view: ValidationView, caps: Capabilities): readonly string[] => {
  const { catalog, results } = view.checkBindings,
    recorded = view.evidence;
  const rows: ResultRow[] = results.map((check) => ({
    symbol: CHECK_SYMBOL(check),
    identity: check.identity,
    result: `${check.runner ?? 'no evaluator'}: ${check.status}, ${check.outcome}`,
    reason: check.reason,
  }));
  const evidence =
    recorded.path === null
      ? view.status === 'refused'
        ? 'No evidence recorded: admission was refused, so nothing is recorded or pruned.'
        : 'No evidence recorded: no bound check passed or failed.'
      : `Recorded ${recorded.observations.length} ${recorded.observations.length === 1 ? 'observation' : 'observations'} in ${recorded.path}${recorded.written ? '' : ', unchanged'}.`;
  return [
    sectionLabel('Checks', caps),
    ...(catalog === null ? [] : entry([words(catalogLine(catalog, caps.ascii))], { depth: 1, symbol: 'info' }, caps)),
    ...resultRows(rows, caps),
    ...entry([words(evidence)], { depth: 1, symbol: 'info' }, caps),
  ];
};

const BINDING_SYMBOL: Readonly<Record<ValidationBindings['results'][number]['status'], SymbolName>> = {
  bound: 'success',
  unavailable: 'unknown',
  revoked: 'error',
};
/** Where the bindings' catalog came from, in one sentence. */
function catalogLine(catalog: NonNullable<ValidationBindings['catalog']>, ascii: boolean): string {
  if (catalog.status === 'unavailable') return `No installed-implementation catalog: ${catalog.reason}.`;
  if (catalog.status === 'damaged')
    return `The catalog host ${catalog.consumer} joined failed verification: ${catalog.reason}.`;
  return `Catalog ${truncateDigest(catalog.digest, ascii)} in release ${truncateDigest(catalog.release, ascii)} (${catalog.version}), joined by host ${catalog.consumer}. Nothing is executed.`;
}
/** The Bindings section: where the catalog came from, then one entry per binding with its result and reason. */
const bindingsSection = (bindings: ValidationBindings, caps: Capabilities): readonly string[] => {
  const rows: ResultRow[] = bindings.results.map((binding) => ({
    symbol: BINDING_SYMBOL[binding.status],
    identity: binding.identity,
    result: `${binding.implementation ?? 'no implementation'}: ${binding.status}`,
    reason: binding.reason,
  }));
  return [
    sectionLabel('Bindings', caps),
    ...(bindings.catalog === null
      ? []
      : entry([words(catalogLine(bindings.catalog, caps.ascii))], { depth: 1, symbol: 'info' }, caps)),
    ...resultRows(rows, caps),
  ];
};

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

/** Terminal rendering: findings differing only in the fragment their message names are one row plus a dim tail. */
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
 * Terminal rendering groups a shared next action once under the findings rather than repeating it per finding.
 * A next action is keyed by finding code, so an adjacent run of one code is
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

/**
 * The closing next action. Review finding B2-N8: a run that fails only because a binding or check is revoked names the
 * repair rather than errors it does not list: deleting the payload that failed verification and re-applying the host
 * that joined it, or replacing what the intact catalog revokes. A not-evaluated check is never a pass.
 */
function closing(view: ValidationView, errors: number, revoked: number, notEvaluated: number): string {
  const damaged = [view.bindings.catalog, view.checkBindings.catalog].find((catalog) => catalog?.status === 'damaged'),
    structural = structurallyAdmitted(view.checkBindings),
    revokedChecks = view.checkBindings.results
      .filter((check) => check.status === 'revoked')
      .map((check) => check.identity);
  if (errors > 0) return 'Fix the errors above and run "ia validate" again.';
  // Review finding B3-R3: ia host admits strictly, so it refuses a workspace holding a check only this structural
  // admission admits; the repair names that check first, so the host's own remedy lands somewhere actionable.
  if (damaged?.status === 'damaged')
    return structural.length > 0
      ? `Remove or replace ${listed(structural)}, which ia validate, ia preview and ia author admit but ia host refuses, then delete ${damaged.payload}, the host payload that failed verification, and run "ia host ${damaged.consumer} --root ${quote(view.root)} --apply".`
      : `Delete ${damaged.payload}, the host payload that failed verification, then run "ia host ${damaged.consumer} --root ${quote(view.root)} --apply".`;
  if (revokedChecks.length > 0)
    return `Remove or replace ${listed(revokedChecks)}, whose evaluator the installed catalog revokes, then run "ia validate --root ${quote(view.root)}" again.`;
  if (revoked > 0)
    return 'Replace each implementation the installed catalog revokes above with one it does not, then run "ia validate" again.';
  if (view.outcome === 'not-evaluated')
    return 'A not-evaluated result is not a pass. Supply the named evaluator to obtain one.';
  if (notEvaluated > 0) return 'A not-evaluated check is not a pass; each check above says why it was not evaluated.';
  return 'Every declared structural obligation is satisfied at this revision.';
}
export function renderValidation(view: ValidationView, options: ValidationOptions, caps: Capabilities): string {
  const total = countsOf(view.findings),
    bound = bindingCounts(view.bindings),
    checked = checkCounts(view.checkBindings);
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
  if (bound.revoked > 0)
    summary.push(
      words(
        `${bound.revoked} execution ${bound.revoked === 1 ? 'binding is' : 'bindings are'} revoked, which is an error.`,
      ),
    );
  if (bound.unavailable > 0)
    summary.push(
      words(
        `${bound.unavailable} execution ${bound.unavailable === 1 ? 'binding is' : 'bindings are'} not bound; an unbound binding is not a pass.`,
      ),
    );
  if (checked.revoked > 0)
    summary.push(
      words(`${checked.revoked} ${checked.revoked === 1 ? 'check is' : 'checks are'} revoked, which is an error.`),
    );
  if (checked.notEvaluated > 0)
    summary.push(
      words(
        `${checked.notEvaluated} ${checked.notEvaluated === 1 ? 'check was' : 'checks were'} not evaluated; a not-evaluated check is not a pass.`,
      ),
    );
  if (checked.structural > 0) {
    // Review finding B3-R3: named, so the refusal ia host or ia project gives, and the error ia capture records, has a
    // place to land. ia preview and ia author admit them as validate does (C21); every other reader is strict.
    const named = listed(structurallyAdmitted(view.checkBindings));
    summary.push(
      words(
        checked.structural === 1
          ? `1 check names an evaluator that is not built in (${named}): ia validate admits it to bind it, as ia preview and ia author do, but every other reader counts it as an IA-COMP-CHECK-UNKNOWN error, so ia host and ia project refuse the workspace and ia capture records it as an error; remove or replace it before ia host or ia project.`
          : `${checked.structural} checks name evaluators that are not built in (${named}): ia validate admits them to bind them, as ia preview and ia author do, but every other reader counts them as IA-COMP-CHECK-UNKNOWN errors, so ia host and ia project refuse the workspace and ia capture records them as errors; remove or replace them before ia host or ia project.`,
      ),
    );
  }
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
    entry(
      summary,
      { depth: 1, symbol: total.errors === 0 && bound.revoked === 0 && checked.revoked === 0 ? 'success' : 'error' },
      caps,
    ),
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
  if (view.checkBindings.results.length > 0) blocks.push(checksSection(view, caps));
  if (view.bindings.results.length > 0) blocks.push(bindingsSection(view.bindings, caps));
  blocks.push(
    entry(
      [words(closing(view, total.errors, bound.revoked + checked.revoked, checked.notEvaluated))],
      {
        depth: 0,
        symbol: 'step',
      },
      caps,
    ),
  );
  return document(blocks, { leadingBlank: true });
}

export function runValidate(context: Context): Result {
  const { args, caps, json } = context;
  const root = requireRoot(context);
  // The validate mode (Verification) under the participant's mandate profile, judged on the validation's own session
  // before it reads anything or records evidence.
  const view = collectValidation(root, validationTrust(context.host), sessionGate(context, 'validate'));
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
