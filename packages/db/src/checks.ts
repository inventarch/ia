import {
  bindEvaluators,
  CHECK_IDS,
  checkRunner,
  createEvaluatorCatalog,
  isCodecRef,
  legacyCodecRef,
  selectEvaluator,
} from '@inventarch/compliance';
import type { CodecRef, EvaluatorCodec, Report, Verdict } from '@inventarch/compliance';
import type { Node } from '@inventarch/graph';
import type { CompiledField } from '@inventarch/language';

/**
 * D13: binding each `@check` at validate. A check names its evaluator (`check.implementation`, else `check.runs`;
 * compliance `checkRunner`) and selects what it covers with the text `check.scope`. Binding decides which
 * implementation serves the evaluator and reads the verdicts it produced; it runs nothing and writes nothing.
 *
 * - A built-in evaluator (compliance CHECK_IDS) is always bound: built-ins are implicit, whatever the host carries. Its
 *   result is the aggregate of that evaluator's verdicts in the admission report that `check.scope` selects: every one
 *   when the scope is the whole-workspace token `*`, else exactly those whose scope equals it (record identities,
 *   system folders, `graph`, `sources`, as the evaluator reports them). Fail dominates, then not-evaluated, then pass.
 *   A scope that selects nothing (prose, an unknown scope, or an evaluator that reported nothing) is not-evaluated,
 *   never an empty pass. COMP-CHECK's pass for a check only structural admission admits counts as not-evaluated.
 * - Any other evaluator is looked up in the evaluator catalog the host payload carries (compliance
 *   `createEvaluatorCatalog`, `selectEvaluator`): `supported` is bound, but no host implementation is bound to run it in
 *   this release (`bindEvaluators` with none), so its result is not-evaluated; `unavailable`, an entry the catalog does
 *   not list, a catalog that is not valid, or no catalog at all is unavailable, not-evaluated; `revoked`, or a catalog
 *   that failed verification, is revoked, an error. The host registers no evaluator codec in this release, so each codec
 *   the catalog's entries declare is given one that accepts nothing (`inertCodecs`): the catalog's structure and
 *   statuses are checked as compliance checks them, and nothing it lists can validate an input or produce evidence.
 */
export const WHOLE_WORKSPACE_SCOPE = '*';
/** The evaluator catalog a check binds against: the host payload's, or why there is none. */
export type CheckCatalog =
  | {
      readonly status: 'present';
      readonly evaluators: {
        readonly format: string;
        readonly formatVersion?: number;
        readonly entries: readonly unknown[];
      };
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'damaged'; readonly reason: string };
export type CheckBindingStatus = 'bound' | 'unavailable' | 'revoked';
export type CheckOutcome = 'pass' | 'fail' | 'not-evaluated';
export interface CheckBinding {
  readonly identity: string;
  readonly name: string;
  /** The evaluator the check names; null when it names none. */
  readonly runner: string | null;
  readonly scope: string | null;
  readonly status: CheckBindingStatus;
  /** `built-in`, or the catalog entry's `<id>@<implementation version>`; null when nothing is bound. */
  readonly implementation: string | null;
  /** The aggregate of the selected verdicts; not-evaluated whenever nothing bound produced one. */
  readonly outcome: CheckOutcome;
  /** How many of the evaluator's verdicts the scope selected. */
  readonly selected: number;
  /** One line: why the check has this binding and outcome. */
  readonly reason: string;
}

const fieldText = (node: Node, section: string, key: string): string | null => {
  for (const candidate of node.sections)
    if (candidate.name === section)
      for (const field of candidate.fields)
        if ('key' in field && field.key === key && (field as CompiledField).when === undefined) {
          const value = (field as CompiledField).value;
          return 'text' in value && typeof value.text === 'string' ? value.text : null;
        }
  return null;
};
/**
 * One codec per `{id, version}` `entries` declare, each refusing every value (see the module comment). Entries name
 * codecs as `inputCodec` / `outputCodec` references in the current shape, or as `inputSchemaId` / `outputSchemaId`
 * `name@major` strings in the legacy `ia-evaluator-catalog/1.x` shape, which compliance's `legacyCodecRef` reads. A
 * value that is neither gets no codec, so compliance refuses that entry as unknown.
 */
function inertCodecs(entries: readonly unknown[]): readonly EvaluatorCodec[] {
  const refs = new Map<string, CodecRef>();
  for (const entry of entries)
    if (entry !== null && typeof entry === 'object')
      for (const [current, legacy] of [
        ['inputCodec', 'inputSchemaId'],
        ['outputCodec', 'outputSchemaId'],
      ] as const) {
        const fields = entry as Record<string, unknown>,
          declared = fields[current] ?? fields[legacy],
          ref = isCodecRef(declared) ? declared : legacyCodecRef(declared);
        if (ref !== undefined) refs.set(`${ref.id}#${ref.version}`, ref);
      }
  return [...refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, ref]) => Object.freeze({ id: ref.id, version: ref.version, validate: () => false }));
}
const RANK: Readonly<Record<CheckOutcome, number>> = { pass: 0, 'not-evaluated': 1, fail: 2 };
/**
 * The evaluator's verdicts `scope` selects (D13), and their aggregate: fail, then not-evaluated, then pass. A verdict
 * about a record in `excluded` (the runtime evidence) is never selected, so a check's result does not depend on its
 * own evidence.
 */
export function checkVerdicts(
  verdicts: readonly Verdict[],
  runner: string,
  scope: string | null,
  excluded: ReadonlySet<string> = new Set(),
): { readonly outcome: CheckOutcome; readonly selected: readonly Verdict[] } {
  const selected = verdicts.filter(
    (verdict) =>
      verdict.check === runner &&
      !excluded.has(verdict.scope) &&
      (scope === WHOLE_WORKSPACE_SCOPE || verdict.scope === scope),
  );
  if (selected.length === 0) return { outcome: 'not-evaluated', selected };
  const outcome = selected.reduce<CheckOutcome>(
    (worst, verdict) => (RANK[verdict.outcome] > RANK[worst] ? verdict.outcome : worst),
    'pass',
  );
  return { outcome, selected };
}

/** Every admitted `@check` among `records`, by identity, bound against `catalog` with `report`'s verdicts. */
export function bindChecks(
  records: readonly Node[],
  report: Pick<Report, 'verdicts'>,
  catalog: CheckCatalog,
): readonly CheckBinding[] {
  let evaluators:
    | ReturnType<typeof createEvaluatorCatalog>
    | { readonly ok: 'refused'; readonly reason: string }
    | undefined;
  // Records at runtime placement are evidence, not what a check covers.
  const runtime = new Set(records.filter((record) => record.band === 0).map((record) => record.identity));
  // COMP-CHECK passes a check naming an evaluator that is not built in only under structural admission, while every
  // strict reader fails it at the same revision; its verdict there is not-evaluated, never a pass.
  const structural = new Set(
    records
      .filter((record) => record.discriminator === 'check' && record.band !== 0)
      .filter((record) => {
        const runner = checkRunner(record);
        return runner !== undefined && !(CHECK_IDS as readonly string[]).includes(runner);
      })
      .map((record) => record.identity),
  );
  const verdicts =
    structural.size === 0
      ? report.verdicts
      : report.verdicts.map((verdict) =>
          verdict.check === 'COMP-CHECK' && structural.has(verdict.scope) && verdict.outcome === 'pass'
            ? ({ ...verdict, outcome: 'not-evaluated' } as Verdict)
            : verdict,
        );
  const catalogOf = () => {
    if (catalog.status !== 'present') return undefined;
    if (evaluators === undefined)
      try {
        evaluators = createEvaluatorCatalog(catalog.evaluators as never, {
          codecs: inertCodecs(catalog.evaluators.entries),
        });
      } catch (error) {
        // A refused registration: compliance refuses the catalog itself.
        evaluators = { ok: 'refused', reason: error instanceof Error ? error.message : String(error) };
      }
    return evaluators;
  };
  return Object.freeze(
    records
      .filter((record) => record.discriminator === 'check' && record.band !== 0)
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
      .map((record): CheckBinding => {
        const runner = checkRunner(record) ?? null,
          scope = fieldText(record, 'check', 'scope');
        const result = (
          status: CheckBindingStatus,
          reason: string,
          rest: Partial<Pick<CheckBinding, 'implementation' | 'outcome' | 'selected'>> = {},
        ): CheckBinding =>
          Object.freeze({
            identity: record.identity,
            name: record.name,
            runner,
            scope,
            status,
            implementation: null,
            outcome: 'not-evaluated',
            selected: 0,
            reason,
            ...rest,
          });
        if (runner === null) return result('unavailable', 'the check names no evaluator');
        if ((CHECK_IDS as readonly string[]).includes(runner)) {
          const { outcome, selected } = checkVerdicts(verdicts, runner, scope, runtime);
          const reason =
            selected.length > 0
              ? `built-in ${runner}: ${selected.length} selected ${selected.length === 1 ? 'verdict' : 'verdicts'}, ${outcome}`
              : scope === WHOLE_WORKSPACE_SCOPE
                ? `built-in ${runner} reported no verdict in this workspace, so nothing was evaluated`
                : `check.scope "${scope ?? ''}" selects no ${runner} verdict; name "${WHOLE_WORKSPACE_SCOPE}" or a scope ${runner} reports, so nothing was evaluated`;
          return result('bound', reason, { implementation: 'built-in', outcome, selected: selected.length });
        }
        if (catalog.status === 'damaged')
          return result('revoked', `the installed evaluator catalog failed verification: ${catalog.reason}`);
        if (catalog.status === 'unavailable') return result('unavailable', catalog.reason);
        const checked = catalogOf()!;
        if (checked.ok !== true)
          return result(
            'unavailable',
            `the installed evaluator catalog is not valid: ${
              checked.ok === 'refused' ? checked.reason : (checked.assessment.findings[0]?.message ?? 'no reason given')
            }`,
          );
        const entry = selectEvaluator(checked.catalog, runner);
        if (entry === undefined)
          return result('unavailable', `the installed evaluator catalog lists no evaluator ${runner}`);
        const implementation = `${entry.id}@${entry.implementationVersion}`;
        if (entry.availability.status === 'revoked')
          return result(
            'revoked',
            `the installed evaluator catalog revokes ${implementation}: ${entry.availability.reason}`,
          );
        if (entry.availability.status === 'unavailable')
          return result('unavailable', `${implementation} is unavailable on this host: ${entry.availability.reason}`);
        // Supported, but no host implementation is bound to run it in this release, so it was never invoked.
        const ran = bindEvaluators(checked.catalog, new Map()).implementation(entry.id, entry.implementationDigest);
        return result(
          'bound',
          ran === undefined
            ? `${implementation} is supported, but no host implementation ran it, so nothing was evaluated`
            : `${implementation} is supported`,
          { implementation },
        );
      }),
  );
}
