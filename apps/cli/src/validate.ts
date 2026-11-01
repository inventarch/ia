/**
 * `ia validate`: docs/specs/consumer-cli-contract/README.md §2.4–2.5 (capture and validation), §4 (refusals) and §6 (terminal rendering).
 *
 * Admission is whole-workspace by construction, so positionals restrict reporting and never admission: the
 * summary always states the true total and the exit class is computed from the unfiltered finding set.
 *
 * Acquisition and presentation are separated: `collectValidation` is the only part of this verb that touches a
 * workspace, and `renderValidation` and `validationEnvelope` render only the view it captured, so the human report and
 * the JSON envelope describe one acquisition and a test can render a captured view without opening a workspace. The
 * display root is the one value the view carries that differs between machines.
 *
 * The report also carries the workspace's execution bindings, each joined against the installed-implementation catalog
 * its host joined, through the same distribution service `ia-distribution validate` reports
 * (`WorkspaceSession.bindings`). A revoked binding is an error and fails the run; an unavailable one is never a pass.
 * Computing them writes nothing and executes nothing; the evidence below is the one write this verb makes. With no
 * `@execution-binding` record the human report is unchanged.
 *
 * A join binds only through this installation's own payload (`validationTrust`), the one its bundled pin names in the
 * IA home it materializes payloads in; a registration of any other payload is unavailable.
 *
 * `ia validate` is the validate request. Its session admits checks structurally (an unknown evaluator is admitted and
 * reported, not refused) and reads no evidence, so its findings, counts, checks and exit are the authored view's alone
 * and its `revision` is the one every other reader reports; it binds every `@check` (`WorkspaceSession.checks`, through
 * the same trust) and records the evidence of the bound ones that passed or failed through `recordValidation`, the one
 * writer of evidence, which `ia-distribution validate` calls too. A revoked check is an error; an unavailable or
 * not-evaluated one is never a pass. With no `@check` record the human report is unchanged.
 *
 * `--verify-conformance` verifies COMP-KERNEL and COMP-FIXTURES in-process (compliance C31) through a second session
 * opened with db `conformance: 'verify'` (db D10a). The report is that session's: its findings, status, outcome and
 * exit, and a Conformance section. Checks, evidence and bindings stay the first session's, bound from the report without
 * verification, so the evidence recorded is what a validation without the flag records, and every reader admits it.
 * Without the flag nothing new runs and the output is unchanged.
 *
 * `--require-verified` (contract C7, opt-in) goes with `--verify-conformance`: the run exits 1 unless COMP-KERNEL and
 * COMP-FIXTURES are both verified passes, and says which is not. Without it the exit is as before.
 */
import { EVIDENCE_DIRECTORY } from '@inventarch/db';
import type { EvidenceWrite } from '@inventarch/db';
import { readHostPin } from '@inventarch/distribution/host-home';
import { installationTrust } from '@inventarch/distribution/implementations';
import type { HostTrust } from '@inventarch/distribution/implementations';
import { recordValidation } from '@inventarch/distribution/services';
import type { ValidationBindings, ValidationChecks } from '@inventarch/distribution/services';
import { UsageError } from './args.js';
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
  safeRootAdvice,
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
type Report = Session['reader']['report'];
export type Severity = 'error' | 'warning';

/** The checks `--verify-conformance` verifies (compliance C31), in the order a report sorts them. */
const CONFORMANCE_CHECKS: readonly string[] = ['COMP-FIXTURES', 'COMP-KERNEL'];
/**
 * What `--verify-conformance` verified: COMP-FIXTURES and COMP-KERNEL as the verifying report judged them, each with
 * the basis the report gave it (`verified`, or null for a result it could not evaluate), and the report's own
 * `conformance` object (profile, toolchain, the kernel's floor and the fixtures' inventory, observed codes and
 * out-of-profile suites), present when at least one of them was verified.
 */
export interface ValidationConformance extends Partial<NonNullable<Report['conformance']>> {
  readonly verdicts: readonly {
    readonly check: string;
    readonly outcome: Report['verdicts'][number]['outcome'];
    readonly basis: NonNullable<Report['verdicts'][number]['basis']> | null;
  }[];
}
const conformanceOf = (report: Report): ValidationConformance => ({
  verdicts: report.verdicts
    .filter((verdict) => CONFORMANCE_CHECKS.includes(verdict.check))
    .map(({ check, outcome, basis }) => ({ check, outcome, basis: basis ?? null }))
    .sort((a, b) => CONFORMANCE_CHECKS.indexOf(a.check) - CONFORMANCE_CHECKS.indexOf(b.check)),
  ...report.conformance,
});

/**
 * Under `--require-verified`, the conformance checks that are not a verified pass: COMP-FIXTURES and COMP-KERNEL each
 * need `basis: 'verified'` and outcome `pass`. Empty when both are; both when the view was not verified.
 */
export function unverifiedConformance(view: Pick<ValidationView, 'conformance'>): readonly string[] {
  const verdicts = view.conformance?.verdicts ?? [];
  return CONFORMANCE_CHECKS.filter(
    (check) =>
      !verdicts.some(
        (verdict) => verdict.check === check && verdict.basis === 'verified' && verdict.outcome === 'pass',
      ),
  );
}
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

/** The next action for a check verification did not evaluate: its evaluator is built in, so there is none to supply. */
const UNVERIFIED =
  'A not-evaluated result is not a pass; the Conformance section says why verification did not evaluate it.';
/** A next action that reruns `ia validate` keeps `--verify-conformance` when this run verified, or a rerun would not. */
const rerun = (view: ValidationView, action: string): string =>
  view.conformance === undefined ? action : action.replaceAll('"ia validate', '"ia validate --verify-conformance');
/** Under `--verify-conformance`, whether `findings` hold not-evaluated ones and each is COMP-KERNEL's or COMP-FIXTURES'. */
const unverifiedOnly = (view: ValidationView, findings: readonly Finding[]): boolean => {
  const unevaluated = findings.filter((finding) => NOT_EVALUATED.has(finding.code));
  return (
    view.conformance !== undefined &&
    unevaluated.length > 0 &&
    unevaluated.every((finding) => CONFORMANCE_CHECKS.includes(view.checks.get(findingKey(finding)) ?? ''))
  );
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

/** A positional selects for reporting by exact file or by directory prefix, relative to the root. */
const selects = (finding: Finding, filters: readonly string[]): boolean => {
  if (filters.length === 0) return true;
  const path = finding.path.replaceAll('\\', '/');
  return filters.some((raw) => {
    const filter = raw.replaceAll('\\', '/').replace(/\/+$/, '');
    return path === filter || path.startsWith(filter + '/');
  });
};

export interface ValidationView {
  /** The path the CLI resolved, never the runtime's own `result.root`, which is always empty. */
  readonly root: string;
  readonly revision: string;
  /** The authored revision, which names the evidence this request records. */
  readonly authoredRevision: string;
  readonly status: 'admitted' | 'refused';
  readonly outcome: ReportOutcome;
  readonly records: number;
  /** Every finding, unfiltered: the counts and the exit class are computed from this. */
  readonly findings: readonly Finding[];
  readonly checks: ReadonlyMap<string, string>;
  /** Every admitted `@execution-binding` joined against the catalog this workspace's host joined, unfiltered. */
  readonly bindings: ValidationBindings;
  /** Every admitted `@check` bound, unfiltered. */
  readonly checkBindings: ValidationChecks;
  /** What this validate request recorded as evidence. */
  readonly evidence: EvidenceWrite;
  /**
   * The admission status the evidence was recorded from: `status` itself, except under `--verify-conformance`, whose
   * verification can refuse a report it never records from.
   */
  readonly evidenceStatus: 'admitted' | 'refused';
  /** Present only under `--verify-conformance`. */
  readonly conformance?: ValidationConformance;
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
/** The checks naming an evaluator that is not built in, which only a structural admission admits. */
const structurallyAdmitted = (checks: ValidationChecks): readonly string[] =>
  checks.results
    .filter((check) => check.runner !== null && check.implementation !== 'built-in')
    .map((check) => check.identity);
/** `identities` as one phrase: `a`, `a and b`, `a, b and c`. */
const listed = (identities: readonly string[]): string =>
  identities.length <= 1 ? (identities[0] ?? '') : `${identities.slice(0, -1).join(', ')} and ${identities.at(-1)}`;
const checkCounts = (checks: ValidationChecks) => ({
  revoked: checks.results.filter((check) => check.status === 'revoked').length,
  /** Checks naming an evaluator that is not built in, which only a structural admission admits. */
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
 * The refusal for evidence that could not be recorded: located at the path the service names, with the repair. The
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
 * The installation a validation trusts a join through: the release this package's bundled host payload pin names,
 * materialized in the IA home `env` resolves. Run from inside a host payload, whose copy of this package carries no
 * pin, it is that payload (`installationTrust`). Null, so nothing binds, when there is neither or the IA home cannot be
 * resolved.
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
 * session before admission is read or any evidence is recorded, so a refused profile writes nothing. `verify` also
 * opens the verifying session the report is read from; its revision must be the first session's, or nothing is recorded.
 */
export function collectValidation(
  root: string,
  trust: HostTrust | null,
  gate?: SessionGate,
  verify = false,
): ValidationView {
  const session: Session = openSession(root, VALIDATING);
  try {
    gate?.(session);
    const verifying = verify ? openSession(root, { ...VALIDATING, conformance: 'verify' }) : undefined;
    try {
      const reported = verifying ?? session;
      // The distribution's one validation service, which `ia-distribution validate` reports as well: admission's
      // findings and the warnings for db D02a/D02b declarations that declare nothing.
      const admission = reported.validation(),
        checkBindings = session.checks(trust);
      if (admission.revision !== session.reader.revision) throw sourceChanged(root);
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
        outcome: reported.reader.report.outcome,
        records: admission.records,
        findings: admission.findings,
        checks: checkNames(reported.reader.report.verdicts),
        bindings: session.bindings(trust),
        checkBindings,
        evidence,
        evidenceStatus: session.admission().status,
        ...(verifying === undefined ? {} : { conformance: conformanceOf(verifying.reader.report) }),
      };
    } finally {
      verifying?.close();
    }
  } finally {
    session.close();
  }
}
/** The refusal for sources that changed between the two sessions of a verifying validation; nothing was recorded. */
const sourceChanged = (root: string): Refusal =>
  new Refusal(
    'IA-DB-SOURCE-CHANGED',
    'The workspace sources changed between the validation and its conformance verification',
    3,
    { path: root },
    `Once nothing is writing the workspace's sources, run "ia validate --root ${quote(root)} --verify-conformance".`,
  );

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
    ...(view.conformance === undefined ? {} : { conformance: view.conformance }),
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
 * One entry per binding or check: the identity on the symbol's line, then the result and the reason each on a line of
 * its own at the entry's content column, so a long identity never squeezes them into a narrow value column.
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
    // db D10a: a check is bound from the report without verification, which never evaluates these two runners.
    reason:
      view.conformance !== undefined && check.runner !== null && CONFORMANCE_CHECKS.includes(check.runner)
        ? `${check.reason}; checks bind from the report without verification, so Conformance above has the verified result`
        : check.reason,
  }));
  const evidence =
    recorded.path === null
      ? view.evidenceStatus === 'refused'
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

/**
 * The Conformance section `--verify-conformance` adds: one entry per check with its outcome and basis, and what it was
 * verified against, or why it is not a pass; then the profile and the suites it does not run.
 */
const conformanceSection = (view: ValidationView, conformance: ValidationConformance, caps: Capabilities) => {
  const reasonOf = (check: string): string => {
    const finding = view.findings.find((candidate) => view.checks.get(findingKey(candidate)) === check);
    return finding === undefined ? '' : finding.message.replace(`${check}: `, '');
  };
  const rows: ResultRow[] = conformance.verdicts.map((verdict) => ({
    symbol: verdict.outcome === 'pass' ? 'success' : verdict.outcome === 'fail' ? 'error' : 'unknown',
    identity: verdict.check,
    result: `${verdict.outcome}, ${verdict.basis === 'verified' ? 'verified' : 'not verified'}`,
    reason:
      verdict.outcome !== 'pass'
        ? reasonOf(verdict.check)
        : verdict.check === 'COMP-KERNEL' && conformance.kernel !== undefined
          ? `Floor ${truncateDigest(conformance.kernel.floorDigest, caps.ascii)} regenerates the running kernel.`
          : verdict.check === 'COMP-FIXTURES' && conformance.fixtures !== undefined
            ? `Inventory ${truncateDigest(conformance.fixtures.inventoryDigest, caps.ascii)}, ${conformance.fixtures.observedCodes.length} codes observed.`
            : '',
  }));
  const suites = conformance.fixtures?.outOfProfile.map((suite) => suite.suite) ?? [];
  const profile =
    conformance.profile === undefined
      ? 'Nothing was verified; a not-evaluated check is not a pass.'
      : suites.length === 0
        ? `Profile ${conformance.profile}.`
        : `Profile ${conformance.profile}, which does not run ${listed(suites)}: a pass says nothing about them.`;
  return [
    sectionLabel('Conformance', caps),
    ...resultRows(rows, caps),
    ...entry([words(profile)], { depth: 1, symbol: 'info' }, caps),
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
  const lines: string[] = [],
    /** The findings of the current run of one code, which its action closes. */
    run: Finding[] = [];
  for (const [index, group] of collapsed.entries()) {
    const column = contentColumn(2, statusSymbol(group.head.severity, caps.ascii), width);
    lines.push(...errorBlock(element(view, group.head, width), { depth: 1 }, caps));
    if (group.rest.length > 0)
      lines.push(...entry([[atom(collapseTail(group.rest), 'dim', 0)]], { column, symbol: 'info' }, caps));
    run.push(group.head, ...group.rest);
    // The action closes the run, so a code that appears several times in a row carries one action, not one each.
    if (collapsed[index + 1]?.head.code === group.head.code) continue;
    const action =
      group.head.code === 'IA-COMP-NOT-EVALUATED' && unverifiedOnly(view, run) ? UNVERIFIED : ACTIONS[group.head.code];
    run.length = 0;
    if (action !== undefined) lines.push(...entry([words(rerun(view, action))], { column, symbol: 'step' }, caps));
  }
  return lines;
};

/**
 * The closing next action. A run that fails only because a binding or check is revoked names the repair rather than
 * errors it does not list: deleting the payload that failed verification and re-applying the host that joined it, or
 * replacing what the intact catalog revokes. A not-evaluated check is never a pass.
 */
function closing(view: ValidationView, errors: number, revoked: number, notEvaluated: number): string {
  return rerun(view, closingAction(view, errors, revoked, notEvaluated));
}
function closingAction(view: ValidationView, errors: number, revoked: number, notEvaluated: number): string {
  const damaged = [view.bindings.catalog, view.checkBindings.catalog].find((catalog) => catalog?.status === 'damaged'),
    structural = structurallyAdmitted(view.checkBindings),
    revokedChecks = view.checkBindings.results
      .filter((check) => check.status === 'revoked')
      .map((check) => check.identity);
  if (errors > 0) return 'Fix the errors above and run "ia validate" again.';
  // ia host admits strictly, so it refuses a workspace holding a check only this structural admission admits; the
  // repair names that check first, so the host's own remedy lands somewhere actionable.
  if (damaged?.status === 'damaged')
    return structural.length > 0
      ? `Remove or replace ${listed(structural)}, which ia validate, ia preview and ia author admit but ia host refuses, then delete ${damaged.payload}, the host payload that failed verification, and run "ia host ${damaged.consumer} --root ${quote(view.root)} --apply".`
      : `Delete ${damaged.payload}, the host payload that failed verification, then run "ia host ${damaged.consumer} --root ${quote(view.root)} --apply".`;
  if (revokedChecks.length > 0)
    return `Remove or replace ${listed(revokedChecks)}, whose evaluator the installed catalog revokes, then run "ia validate --root ${quote(view.root)}" again.`;
  if (revoked > 0)
    return 'Replace each implementation the installed catalog revokes above with one it does not, then run "ia validate" again.';
  if (view.outcome === 'not-evaluated')
    return unverifiedOnly(view, view.findings)
      ? UNVERIFIED
      : 'A not-evaluated result is not a pass. Supply the named evaluator to obtain one.';
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
    // Named, so the refusal ia host or ia project gives, and the error ia capture records, has a place to land.
    // ia preview and ia author admit them as validate does; every other reader is strict.
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
        unverifiedOnly(view, view.findings)
          ? `Admission outcome: not-evaluated. Verification did not evaluate ${total.notEvaluated} checks, so this run is not a pass.`
          : `Admission outcome: not-evaluated. No evaluator was supplied for ${total.notEvaluated} checks, so this run is not a pass.`,
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
  if (view.conformance !== undefined) blocks.push(conformanceSection(view, view.conformance, caps));
  if (view.checkBindings.results.length > 0) blocks.push(checksSection(view, caps));
  if (view.bindings.results.length > 0) blocks.push(bindingsSection(view.bindings, caps));
  blocks.push(
    entry(
      [
        words(
          safeRootAdvice(closing(view, total.errors, bound.revoked + checked.revoked, checked.notEvaluated), [
            view.root,
          ]),
        ),
      ],
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
  const required = args.flag('require-verified');
  if (required && !args.flag('verify-conformance'))
    throw new UsageError('--require-verified goes with --verify-conformance, whose verdicts it requires');
  const root = requireRoot(context);
  // The validate mode (Verification) under the participant's mandate profile, judged on the validation's own session
  // before it reads anything or records evidence.
  const view = collectValidation(
    root,
    validationTrust(context.host),
    sessionGate(context, 'validate'),
    args.flag('verify-conformance'),
  );
  const options: ValidationOptions = {
    filters: args.positionals,
    severity: (args.value('severity') ?? 'warning') as Severity,
    limit: args.integer('max-findings', 50),
  };
  const unverified = required ? unverifiedConformance(view) : [];
  const exitCode = Math.max(validationExit(view), unverified.length > 0 ? 1 : 0);
  return json
    ? {
        exitCode,
        stdout:
          JSON.stringify({
            ...(validationEnvelope(view, options) as Record<string, unknown>),
            ...(required ? { requireVerified: { satisfied: unverified.length === 0, unverified } } : {}),
          }) + '\n',
        stderr: '',
      }
    : {
        exitCode,
        stdout: renderValidation(view, options, caps) + (required ? requiredLine(unverified, caps) : ''),
        stderr: '',
      };
}
/** The line `--require-verified` adds: both checks verified, or which are not and that the run fails for it. */
function requiredLine(unverified: readonly string[], caps: Capabilities): string {
  return document(
    [
      entry(
        [
          words(
            unverified.length === 0
              ? 'Required verified: COMP-KERNEL and COMP-FIXTURES are verified passes.'
              : `Required verified: ${listed(unverified)} ${unverified.length === 1 ? 'is' : 'are'} not a verified pass, so this run fails.`,
          ),
        ],
        { depth: 0, symbol: unverified.length === 0 ? 'success' : 'error' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}
