import { stableSerialize } from '@inventarch/graph';
import { isBuiltinCheck } from './check-ids.js';
import { assertCatalog, codecOf, selectEvaluator } from './catalog.js';
import type { EvaluatorCatalog, EvidencePolicy } from './catalog.js';
import { compareText, deepFreeze, echo, exactKeys, frozenCopy, jsonData, record, sanitized, sha256 } from './shape.js';
import { assess } from './types.js';
import type { Assessment, EvidenceCode, Finding } from './types.js';

export type ScopeFact = string | number | boolean | null | readonly ScopeFact[] | { readonly [key: string]: ScopeFact };
/** Captured package/resource scope facts (JSON data). Predicates receive a deeply frozen copy, never the caller's object. */
export type ScopeFacts = Readonly<Record<string, ScopeFact>>;
/**
 * Applicability. not-applicable always carries resolver evidence (D2): either the trusted predicate `name@version`
 * that returned it, or the package metadata source that disabled a package-adopted obligation.
 */
export type Applicability =
  | { readonly status: 'applicable'; readonly predicate?: string }
  | {
      readonly status: 'not-applicable';
      readonly reason: string;
      readonly basis: 'predicate';
      readonly predicate: string;
    }
  | {
      readonly status: 'not-applicable';
      readonly reason: string;
      readonly basis: 'package-metadata';
      readonly source: string;
    }
  | { readonly status: 'undetermined'; readonly reason: string; readonly predicate?: string };
/** A trusted, versioned host predicate (`name@version`) over captured facts; never native prose or a selector. */
export type ApplicabilityPredicate = (
  facts: ScopeFacts,
) =>
  | { readonly status: 'applicable' }
  | { readonly status: 'not-applicable' | 'undetermined'; readonly reason: string };
export interface ObligationAdoption {
  readonly identity: string;
  readonly source: 'root' | 'package';
  readonly mandatory: boolean;
}
export interface ObligationOccurrence {
  /** The selected law, contract or check occurrence identity. */
  readonly identity: string;
  readonly word: 'law' | 'contract' | 'check';
  /** The adoption that selected this occurrence. */
  readonly adoption: string;
  /** The requirement fragment, e.g. a contract REQ id, a law obligation label or a profile requirement. */
  readonly requirement: string;
  /** The check.runs evaluator id: a built-in CHECK_IDS id or a catalog id. */
  readonly runs: string;
  readonly provenance: { readonly path: string; readonly line: number };
  readonly applicability?: string;
  readonly required?: boolean;
  /** JSON input; validated and normalized by the evaluator's input codec before digesting. */
  readonly input?: unknown;
}
export interface PackageDirective {
  readonly occurrence: string;
  readonly requirement: string;
  readonly action: 'optional' | 'disable';
  readonly source: string;
}
export interface ObligationInput {
  readonly subject: string;
  readonly policyRevision: string;
  readonly catalog: EvaluatorCatalog;
  /** The catalog digest the policy pins; it must equal catalog.digest. */
  readonly catalogDigest: string;
  readonly facts: ScopeFacts;
  readonly adoptions: readonly ObligationAdoption[];
  readonly occurrences: readonly ObligationOccurrence[];
  readonly predicates?: ReadonlyMap<string, ApplicabilityPredicate>;
  readonly packageMetadata?: readonly PackageDirective[];
}
export interface ObligationEvaluator {
  readonly id: string;
  readonly contractVersion: string;
  readonly implementationVersion: string;
  readonly implementationDigest: string;
  readonly builtin: boolean;
  readonly availability: 'supported' | 'unavailable' | 'revoked';
}
export interface Obligation {
  readonly obligationId: string;
  readonly subject: string;
  readonly occurrence: string;
  readonly word: ObligationOccurrence['word'];
  readonly requirement: string;
  readonly runs: string;
  readonly provenance: {
    readonly path: string;
    readonly line: number;
    readonly adoption: string;
    readonly source: 'root' | 'package';
  };
  readonly applicability: Applicability;
  readonly required: boolean;
  readonly evaluator: ObligationEvaluator;
  readonly inputDigest: string;
  readonly evidencePolicy: EvidencePolicy;
}
export interface ObligationResolution {
  readonly status: 'resolved' | 'refused';
  readonly subject: string;
  readonly policyRevision: string;
  readonly catalogDigest: string;
  readonly obligations: readonly Obligation[];
  readonly assessment: Assessment;
  /** resolutionDigest of this resolution (D2); admission recomputes it. */
  readonly digest: string;
}
export interface ObligationRow {
  readonly occurrence: string;
  readonly word: ObligationOccurrence['word'];
  readonly adoption: string;
  readonly requirement: string;
  readonly runs: string;
  readonly support: 'builtin' | 'supported' | 'unavailable' | 'revoked' | 'unknown';
  readonly supportReason?: string;
  readonly contractVersion?: string;
  readonly implementationVersion?: string;
  readonly implementationDigest?: string;
  readonly applicability: Applicability;
  readonly required: boolean;
  readonly obligationId: string;
}
export interface ObligationExplanation {
  readonly subject: string;
  readonly policyRevision: string;
  readonly catalogFormat: string;
  readonly catalogDigest: string;
  readonly rows: readonly ObligationRow[];
  readonly assessment: Assessment;
}

export const PREDICATE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*@[1-9][0-9]*$/;
export const RESOLUTION_FORMAT = 'ia-obligation-resolution/1';
const REFUSING: readonly Finding['code'][] = ['IA-COMP-OBLIGATION-UNRESOLVED', 'IA-COMP-OBLIGATION-CONFLICT'];
const WORDS = ['law', 'contract', 'check'];
const resolutions = new WeakSet<object>();
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 512;
function note(
  code: EvidenceCode,
  path: string,
  line: number,
  message: string,
  warning = false,
  identity?: string,
): Finding {
  const where = echo(path, 200);
  return {
    code,
    severity: warning ? 'warning' : 'error',
    path: where,
    line,
    ...(identity === undefined ? {} : { identity }),
    message: `${where}:${line}: ${message}`,
  };
}
/** The stable obligation id: `obl:` sha256 of subject, occurrence, requirement and runs. */
export function obligationIdOf(subject: string, occurrence: string, requirement: string, runs: string): string {
  return `obl:${sha256({ subject, occurrence, requirement, runs }).slice('sha256:'.length)}`;
}
/** The D2 integrity digest over a resolution's canonical content (every field except `digest`). */
export function resolutionDigest(resolution: Omit<ObligationResolution, 'digest'>): string {
  const { status, subject, policyRevision, catalogDigest, obligations, assessment } = resolution;
  return sha256({ format: RESOLUTION_FORMAT, status, subject, policyRevision, catalogDigest, obligations, assessment });
}
/** True only for a resolution returned by resolveObligations in this module instance (deeply frozen, so unmodified). */
export const isIssuedResolution = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && resolutions.has(value);
function applicabilityOf(occurrence: ObligationOccurrence, input: ObligationInput, facts: ScopeFacts): Applicability {
  const key = occurrence.applicability;
  if (key === undefined) return { status: 'applicable' };
  const known = PREDICATE_ID.test(key),
    predicate = known ? input.predicates?.get(key) : undefined;
  if (predicate === undefined)
    return {
      status: 'undetermined',
      reason: `Applicability predicate ${known ? key : '<invalid>'} is not installed`,
      ...(known ? { predicate: key } : {}),
    };
  let result: unknown;
  try {
    result = predicate(facts);
  } catch {
    return { status: 'undetermined', reason: `Applicability predicate ${key} failed`, predicate: key };
  }
  const shape = record(result) ? result : undefined;
  if (shape?.['status'] === 'applicable') return { status: 'applicable', predicate: key };
  if (shape?.['status'] === 'not-applicable' && sanitized(shape['reason']))
    return { status: 'not-applicable', reason: shape['reason'], basis: 'predicate', predicate: key };
  if (shape?.['status'] === 'undetermined' && sanitized(shape['reason']))
    return { status: 'undetermined', reason: shape['reason'], predicate: key };
  return {
    status: 'undetermined',
    reason: `Applicability predicate ${key} returned an invalid result`,
    predicate: key,
  };
}
function validOccurrence(occurrence: unknown): occurrence is ObligationOccurrence {
  if (!record(occurrence)) return false;
  const provenance = occurrence['provenance'];
  return (
    nonempty(occurrence['identity']) &&
    nonempty(occurrence['requirement']) &&
    nonempty(occurrence['runs']) &&
    nonempty(occurrence['adoption']) &&
    WORDS.includes(occurrence['word'] as string) &&
    exactKeys(provenance, ['path', 'line']) &&
    nonempty(provenance.path) &&
    Number.isSafeInteger(provenance.line) &&
    (provenance.line as number) >= 1 &&
    (occurrence['applicability'] === undefined || typeof occurrence['applicability'] === 'string') &&
    (occurrence['required'] === undefined || typeof occurrence['required'] === 'boolean')
  );
}
const validDirective = (directive: unknown): directive is PackageDirective =>
  exactKeys(directive, ['occurrence', 'requirement', 'action', 'source']) &&
  nonempty(directive.occurrence) &&
  nonempty(directive.requirement) &&
  (directive.action === 'optional' || directive.action === 'disable') &&
  sanitized(directive.source, 160);
/** Validate and codec-normalize an input, returning its digest or a refusal reason. */
function inputDigestOf(
  subject: string,
  occurrence: ObligationOccurrence,
  codecId: string | undefined,
  catalog: EvaluatorCatalog,
): { digest: string } | { reason: string } {
  const value = occurrence.input === undefined ? null : occurrence.input;
  try {
    if (!jsonData(value)) return { reason: 'input is not JSON data' };
    let normalized: unknown = value;
    if (codecId !== undefined) {
      const codec = codecOf(catalog, codecId);
      if (codec === undefined || codec.validate(frozenCopy(value)) !== true)
        return { reason: `input does not satisfy codec ${codecId}` };
      if (codec.normalize !== undefined) normalized = codec.normalize(frozenCopy(value));
      if (!jsonData(normalized)) return { reason: `codec ${codecId} normalized the input to non-JSON data` };
    }
    return {
      digest: sha256({ subject, runs: occurrence.runs, requirement: occurrence.requirement, input: normalized }),
    };
  } catch {
    return { reason: `input codec ${codecId ?? ''} failed` };
  }
}
interface Collected {
  readonly obligations: readonly Obligation[];
  readonly rows: readonly ObligationRow[];
  readonly findings: readonly Finding[];
}
function collect(input: ObligationInput): Collected {
  assertCatalog(input.catalog);
  if (!nonempty(input.subject) || !nonempty(input.policyRevision))
    throw new TypeError('Obligation resolution requires an explicit subject and policy revision');
  if (!jsonData(input.facts) || !record(input.facts)) throw new TypeError('Obligation facts must be a JSON object');
  const { catalog } = input,
    findings: Finding[] = [],
    facts = frozenCopy(input.facts);
  if (input.catalogDigest !== catalog.digest)
    findings.push(
      note(
        'IA-COMP-OBLIGATION-CONFLICT',
        '<policy>',
        1,
        `Policy ${input.policyRevision} pins catalog ${echo(input.catalogDigest, 80)} but ${catalog.digest} was supplied`,
      ),
    );
  const adoptions = new Map<string, ObligationAdoption>();
  for (const [index, adoption] of input.adoptions.entries()) {
    if (
      !exactKeys(adoption, ['identity', 'source', 'mandatory']) ||
      !nonempty(adoption.identity) ||
      (adoption.source !== 'root' && adoption.source !== 'package') ||
      typeof adoption.mandatory !== 'boolean'
    ) {
      findings.push(note('IA-COMP-OBLIGATION-UNRESOLVED', '<policy>', index + 1, 'Malformed adoption'));
      continue;
    }
    const previous = adoptions.get(adoption.identity);
    if (previous !== undefined && (previous.source !== adoption.source || previous.mandatory !== adoption.mandatory))
      findings.push(
        note(
          'IA-COMP-OBLIGATION-CONFLICT',
          '<policy>',
          index + 1,
          `Adoption ${echo(adoption.identity)} is declared with conflicting source or mandatory status; source precedence cannot weaken a root adoption`,
        ),
      );
    else adoptions.set(adoption.identity, adoption);
  }
  const byId = new Map<string, { obligation: Obligation; serial: string }>(),
    rows = new Map<string, ObligationRow>();
  for (const [index, occurrence] of input.occurrences.entries()) {
    if (!validOccurrence(occurrence)) {
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNRESOLVED',
          '<occurrences>',
          index + 1,
          'Malformed obligation occurrence: identity, word, adoption, requirement, runs and provenance {path, line} are required',
        ),
      );
      continue;
    }
    const { path, line } = occurrence.provenance,
      label = `${echo(occurrence.identity)}#${echo(occurrence.requirement)}`;
    const adoption = adoptions.get(occurrence.adoption);
    const obligationId = obligationIdOf(input.subject, occurrence.identity, occurrence.requirement, occurrence.runs);
    // D4: only CHECK_IDS are built in; reserved ids are never entries and so never resolve.
    const builtin = isBuiltinCheck(occurrence.runs),
      entry = builtin ? undefined : selectEvaluator(catalog, occurrence.runs);
    const applicability = applicabilityOf(occurrence, input, facts);
    const required =
      (adoption?.source === 'root' && adoption.mandatory) || (occurrence.required ?? adoption?.mandatory ?? true);
    const support = builtin ? 'builtin' : entry === undefined ? 'unknown' : entry.availability.status;
    rows.set(`${index}`, {
      occurrence: occurrence.identity,
      word: occurrence.word,
      adoption: occurrence.adoption,
      requirement: occurrence.requirement,
      runs: occurrence.runs,
      support,
      ...(entry !== undefined && entry.availability.status !== 'supported'
        ? { supportReason: entry.availability.reason }
        : {}),
      ...(entry === undefined
        ? {}
        : {
            contractVersion: entry.contractVersion,
            implementationVersion: entry.implementationVersion,
            implementationDigest: entry.implementationDigest,
          }),
      applicability,
      required,
      obligationId,
    });
    if (adoption === undefined) {
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNRESOLVED',
          path,
          line,
          `${label}: adoption ${echo(occurrence.adoption)} is not in the root adoption set`,
          false,
          occurrence.identity,
        ),
      );
      continue;
    }
    if (!builtin && entry === undefined) {
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNRESOLVED',
          path,
          line,
          `${label}: check.runs '${echo(occurrence.runs)}' is neither built in nor in catalog ${catalog.digest}`,
          false,
          occurrence.identity,
        ),
      );
      continue;
    }
    const digest = inputDigestOf(input.subject, occurrence, entry?.inputSchemaId, catalog);
    if ('reason' in digest) {
      findings.push(
        note('IA-COMP-OBLIGATION-UNRESOLVED', path, line, `${label}: ${digest.reason}`, false, occurrence.identity),
      );
      continue;
    }
    const obligation: Obligation = {
      obligationId,
      subject: input.subject,
      occurrence: occurrence.identity,
      word: occurrence.word,
      requirement: occurrence.requirement,
      runs: occurrence.runs,
      provenance: { path, line, adoption: adoption.identity, source: adoption.source },
      applicability,
      required,
      evaluator:
        entry === undefined
          ? {
              id: occurrence.runs,
              contractVersion: '1.0.0',
              implementationVersion: 'builtin',
              implementationDigest: `builtin:${occurrence.runs}`,
              builtin: true,
              availability: 'supported',
            }
          : {
              id: entry.id,
              contractVersion: entry.contractVersion,
              implementationVersion: entry.implementationVersion,
              implementationDigest: entry.implementationDigest,
              builtin: false,
              availability: entry.availability.status,
            },
      inputDigest: digest.digest,
      evidencePolicy: entry === undefined ? { kind: 'fresh-run' } : entry.evidencePolicy,
    };
    const serial = stableSerialize(obligation),
      previous = byId.get(obligationId);
    if (previous !== undefined && previous.serial !== serial)
      findings.push(
        note(
          'IA-COMP-OBLIGATION-CONFLICT',
          path,
          line,
          `${label}: selected more than once with different input, applicability or requirement status (occurrence ${index + 1})`,
          false,
          occurrence.identity,
        ),
      );
    else byId.set(obligationId, { obligation, serial });
  }
  for (const [index, directive] of (input.packageMetadata ?? []).entries()) {
    if (!validDirective(directive)) {
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNRESOLVED',
          '<package-metadata>',
          index + 1,
          'Malformed package directive: occurrence, requirement, action optional | disable and a sanitized source are required',
        ),
      );
      continue;
    }
    const matches = [...byId.values()].filter(
      ({ obligation }) =>
        obligation.occurrence === directive.occurrence && obligation.requirement === directive.requirement,
    );
    const label = `${echo(directive.occurrence)}#${echo(directive.requirement)}`;
    if (matches.length === 0) {
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNRESOLVED',
          directive.source,
          index + 1,
          `Package metadata names ${label}, which is not a selected obligation`,
        ),
      );
      continue;
    }
    for (const match of matches) {
      const { obligation } = match;
      // D1: package metadata never changes a root-adopted obligation, whether the root made it mandatory or required.
      if (obligation.provenance.source === 'root') {
        findings.push(
          note(
            'IA-COMP-OBLIGATION-WEAKENED',
            directive.source,
            index + 1,
            `Package metadata cannot ${directive.action === 'disable' ? 'disable' : 'relax'} root-adopted obligation ${label}; it is unchanged`,
            true,
            obligation.occurrence,
          ),
        );
        continue;
      }
      match.obligation =
        directive.action === 'optional'
          ? { ...obligation, required: false }
          : {
              ...obligation,
              applicability: {
                status: 'not-applicable',
                reason: `Disabled by package metadata ${directive.source}`,
                basis: 'package-metadata',
                source: directive.source,
              },
            };
    }
  }
  const obligations = [...byId.values()]
    .map(({ obligation }) => obligation)
    .sort((a, b) => compareText(a.obligationId, b.obligationId));
  for (const obligation of obligations)
    if (obligation.required && obligation.applicability.status === 'undetermined')
      findings.push(
        note(
          'IA-COMP-OBLIGATION-UNDETERMINED',
          obligation.provenance.path,
          obligation.provenance.line,
          `${echo(obligation.occurrence)}#${echo(obligation.requirement)}: required applicability is undetermined (${obligation.applicability.reason})`,
          false,
          obligation.occurrence,
        ),
      );
  const rowList = [...rows.values()]
    .map((row) => {
      const final = byId.get(row.obligationId)?.obligation;
      return final === undefined ? row : { ...row, required: final.required, applicability: final.applicability };
    })
    .sort(
      (a, b) =>
        compareText(a.occurrence, b.occurrence) ||
        compareText(a.requirement, b.requirement) ||
        compareText(a.runs, b.runs) ||
        compareText(a.obligationId, b.obligationId),
    );
  const unique = rowList.filter((row, i) => i === 0 || stableSerialize(row) !== stableSerialize(rowList[i - 1]));
  return { obligations, rows: unique, findings };
}
/**
 * Pure obligation resolver (C27, OBL-01..03): explicit root adoptions, selected occurrences, a trusted catalog,
 * the pinned catalog digest, the policy revision and captured facts yield immutable obligations sorted by id.
 * An unresolved reference or policy conflict refuses with no partial obligations; undetermined required
 * applicability is a blocking finding; package metadata cannot change a root-adopted obligation (D1).
 * The result carries its D2 digest and is recorded as issued by this module.
 */
export function resolveObligations(input: ObligationInput): ObligationResolution {
  const { obligations, findings } = collect(input),
    refused = findings.some((f) => REFUSING.includes(f.code));
  const content = {
    status: refused ? ('refused' as const) : ('resolved' as const),
    subject: input.subject,
    policyRevision: input.policyRevision,
    catalogDigest: input.catalog.digest,
    obligations: refused ? [] : obligations,
    assessment: assess('COMP-OBLIGATION', input.subject, findings),
  };
  const resolution = deepFreeze({ ...content, digest: resolutionDigest(content) });
  resolutions.add(resolution);
  return resolution;
}
/** Inspection (OBL-03): selected definitions, versions, applicability and missing support. Executes no evaluator. */
export function inspectObligations(input: ObligationInput): ObligationExplanation {
  const { rows, findings } = collect(input);
  return deepFreeze({
    subject: input.subject,
    policyRevision: input.policyRevision,
    catalogFormat: input.catalog.format,
    catalogDigest: input.catalog.digest,
    rows,
    assessment: assess('COMP-OBLIGATION', input.subject, findings),
  });
}
