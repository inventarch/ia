import { CHECK_IDS } from './check-ids.js';
import { compareText, deepFreeze, exactKeys, record, sanitized, sha256 } from './shape.js';
import { assess } from './types.js';
import type { Assessment, EvidenceCode, Finding } from './types.js';

/**
 * Current catalog format (C25): `{format: 'ia-evaluator-catalog', formatVersion: 2, entries}`. The version is an
 * integer field, never part of the name; an unsupported version is refused, and it is part of the catalog digest.
 */
export const EVALUATOR_CATALOG_FORMAT = 'ia-evaluator-catalog';
/** The catalog format versions this package reads in the current shape. */
export const EVALUATOR_CATALOG_FORMAT_VERSIONS = Object.freeze([2] as const);
/** The catalog format version new catalogs declare. */
export const EVALUATOR_CATALOG_FORMAT_VERSION = 2;
/**
 * The legacy catalog format: `{format: 'ia-evaluator-catalog/1.<minor>', entries}`, whose entries name their codecs
 * with `inputSchemaId` / `outputSchemaId` strings `name@major`. It is still read, by the explicit legacy reader
 * below, and converted to the current entry shape; its digest stays the one computed over the declared legacy entries.
 */
export const LEGACY_EVALUATOR_CATALOG_FORMAT = 'ia-evaluator-catalog/1.0';
/** Evaluator invocation-contract majors this package understands. */
export const EVALUATOR_CONTRACT_MAJORS = Object.freeze([1] as const);

export interface EvaluatorLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly outputBytes: number;
  readonly concurrency: number;
}
export type EvidencePolicy =
  | { readonly kind: 'fresh-run' }
  | { readonly kind: 'reusable'; readonly maxAgeMs: number; readonly environmentSensitive: boolean };
export type EvaluatorAvailability =
  | { readonly status: 'supported' }
  | { readonly status: 'unavailable' | 'revoked'; readonly reason: string };
export interface EnvironmentProfile {
  readonly id: string;
  readonly credentials: 'none' | 'scoped';
}
/** A codec reference: a codec id and its integer version. The pair, never a joined string, names a codec. */
export interface CodecRef {
  readonly id: string;
  readonly version: number;
}
export interface EvaluatorEntry {
  readonly id: string;
  /** The version of the evaluator's invocation contract. */
  readonly contractVersion: string;
  readonly implementationVersion: string;
  readonly implementationDigest: string;
  readonly inputCodec: CodecRef;
  readonly outputCodec: CodecRef;
  readonly supportedScopes: readonly string[];
  readonly effects: readonly string[];
  readonly environmentProfile: EnvironmentProfile;
  readonly limits: EvaluatorLimits;
  readonly evidencePolicy: EvidencePolicy;
  readonly availability: EvaluatorAvailability;
}
/**
 * A host-registered codec. `validate` and optional `normalize` are trusted host code; they never come from catalog
 * text. The input codec validates and normalizes obligation inputs (C27); the output codec validates evidence (C28).
 */
export interface EvaluatorCodec {
  readonly id: string;
  readonly version: number;
  readonly validate: (value: unknown) => boolean;
  readonly normalize?: (value: unknown) => unknown;
}
export interface CatalogInput {
  readonly format: string;
  /** Required in the current shape; absent in the legacy `ia-evaluator-catalog/1.x` shape. */
  readonly formatVersion?: number;
  readonly entries: readonly unknown[];
}
export interface CatalogOptions {
  readonly codecs: readonly EvaluatorCodec[];
  /**
   * Additional host-reserved ids (D4). They only block catalog overrides; they never pass COMP-CHECK and never
   * resolve as evaluators. Only CHECK_IDS are built in.
   */
  readonly builtins?: readonly string[];
}
export interface EvaluatorCatalog {
  readonly format: string;
  /** 2 for the current shape; 1 for a catalog read from the legacy `ia-evaluator-catalog/1.x` shape. */
  readonly formatVersion: number;
  readonly digest: string;
  readonly entries: readonly EvaluatorEntry[];
  /** Always exactly CHECK_IDS. */
  readonly builtins: readonly string[];
  /** Host-reserved ids from options.builtins, excluding CHECK_IDS, sorted. */
  readonly reserved: readonly string[];
}
export type CatalogResult =
  | { readonly ok: true; readonly catalog: EvaluatorCatalog; readonly assessment: Assessment }
  | { readonly ok: false; readonly assessment: Assessment };
export interface EvaluatorBinding<T> {
  readonly assessment: Assessment;
  /** The host implementation for an exact supported id and implementation digest, or undefined. */
  readonly implementation: (id: string, implementationDigest: string) => T | undefined;
}

const ENTRY_KEYS = [
  'id',
  'contractVersion',
  'implementationVersion',
  'implementationDigest',
  'inputCodec',
  'outputCodec',
  'supportedScopes',
  'effects',
  'environmentProfile',
  'limits',
  'evidencePolicy',
  'availability',
] as const;
export const EVALUATOR_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** A codec id: a plain token. The version is a separate field, so an id never carries `@`. */
const CODEC_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** The legacy codec id, read only by `legacyCodecRef`. */
const LEGACY_CODEC_ID = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)@([1-9][0-9]*)$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FORMAT = /^ia-evaluator-catalog\/([0-9]+)\.([0-9]+)$/;
const RESERVED_ID = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/;
const catalogs = new WeakSet<object>();
const catalogCodecs = new WeakMap<object, ReadonlyMap<string, EvaluatorCodec>>();
const codecKey = (id: string, version: number): string => `${id}#${version}`;
/** True for a `{id, version}` codec reference: a plain-token id and a positive safe-integer version. */
export function isCodecRef(value: unknown): value is CodecRef {
  return (
    exactKeys(value, ['id', 'version']) &&
    typeof value.id === 'string' &&
    CODEC_ID.test(value.id) &&
    positive(value.version)
  );
}
/**
 * The legacy reader for a codec id written `name@major` (catalogs `ia-evaluator-catalog/1.x`, evidence that
 * recorded such ids): the one place that parses it. Returns undefined for anything else.
 */
export function legacyCodecRef(legacyId: unknown): CodecRef | undefined {
  const match = typeof legacyId === 'string' ? LEGACY_CODEC_ID.exec(legacyId) : null;
  if (match === null) return undefined;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? Object.freeze({ id: match[1] as string, version }) : undefined;
}
const legacyCodecId = (ref: CodecRef): string => `${ref.id}@${ref.version}`;

export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function tokens(value: unknown, nonempty: boolean): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    (nonempty && value.length === 0) ||
    !value.every((t) => typeof t === 'string' && TOKEN.test(t)) ||
    new Set(value).size !== value.length
  )
    return undefined;
  return [...(value as string[])].sort(compareText);
}
function note(code: EvidenceCode, line: number, message: string, path = '<catalog>'): Finding {
  return { code, severity: 'error', path, line, message: `${path}:${line}: ${message}` };
}
type Checked = { entry: EvaluatorEntry } | { finding: Finding };
function checkEntry(
  raw: unknown,
  line: number,
  reserved: ReadonlySet<string>,
  codecs: ReadonlyMap<string, EvaluatorCodec>,
  legacy: boolean,
): Checked {
  const invalid = (message: string, code: EvidenceCode = 'IA-COMP-CATALOG-ENTRY-INVALID'): Checked => ({
    finding: note(code, line, message),
  });
  if (!record(raw)) return invalid('Catalog entry must be an object');
  const keys = ENTRY_KEYS.map((k) =>
    legacy ? (k === 'inputCodec' ? 'inputSchemaId' : k === 'outputCodec' ? 'outputSchemaId' : k) : k,
  );
  const unknown = Object.keys(raw)
      .filter((k) => !keys.includes(k as never))
      .sort(compareText),
    missing = keys.filter((k) => !Object.hasOwn(raw, k));
  if (unknown.length > 0 || missing.length > 0)
    return invalid(
      `Catalog entry fields must be exactly the v1 set${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`,
    );
  const e = raw as Record<(typeof ENTRY_KEYS)[number] | 'inputSchemaId' | 'outputSchemaId', unknown>,
    { id } = e;
  if (typeof id !== 'string') return invalid('Catalog entry id must be text');
  if (reserved.has(id.toUpperCase()) || id.toLowerCase().startsWith('comp-'))
    return invalid(
      `Catalog entry ${sanitized(id, 80) ? id : '<id>'} would override a built-in check id or the reserved comp namespace`,
      'IA-COMP-CATALOG-BUILTIN-OVERRIDE',
    );
  if (!EVALUATOR_ID.test(id))
    return invalid('Catalog entry id must be a lowercase namespaced id such as acme-strict-typing');
  for (const key of ['contractVersion', 'implementationVersion'] as const)
    if (typeof e[key] !== 'string' || !SEMVER.test(e[key] as string))
      return invalid(`${id}: ${key} must be MAJOR.MINOR.PATCH`);
  const major = Number((e.contractVersion as string).split('.')[0]);
  if (!(EVALUATOR_CONTRACT_MAJORS as readonly number[]).includes(major))
    return invalid(
      `${id}: evaluator contract major ${major} is not supported (supported: ${EVALUATOR_CONTRACT_MAJORS.join(', ')})`,
      'IA-COMP-CATALOG-VERSION',
    );
  if (typeof e.implementationDigest !== 'string' || !DIGEST.test(e.implementationDigest))
    return invalid(`${id}: implementationDigest must be sha256:<64 lowercase hex>`);
  const refs: CodecRef[] = [];
  for (const key of legacy
    ? (['inputSchemaId', 'outputSchemaId'] as const)
    : (['inputCodec', 'outputCodec'] as const)) {
    const declared = e[key],
      ref = legacy ? legacyCodecRef(declared) : isCodecRef(declared) ? declared : undefined;
    if (ref === undefined)
      return invalid(
        legacy
          ? `${id}: ${key} must be a legacy codec id such as name@1`
          : `${id}: ${key} must be {id, version}: a plain codec id and a positive integer version`,
      );
    if (!codecs.has(codecKey(ref.id, ref.version)))
      return invalid(
        `${id}: ${key} ${legacyCodecId(ref)} is not a host-registered codec`,
        'IA-COMP-CATALOG-CODEC-UNKNOWN',
      );
    refs.push(Object.freeze({ id: ref.id, version: ref.version }));
  }
  const supportedScopes = tokens(e.supportedScopes, true),
    effects = tokens(e.effects, false);
  if (supportedScopes === undefined) return invalid(`${id}: supportedScopes must be a nonempty list of unique ids`);
  if (effects === undefined) return invalid(`${id}: effects must be a list of unique ids`);
  const profile = e.environmentProfile;
  if (
    !exactKeys(profile, ['id', 'credentials']) ||
    typeof profile.id !== 'string' ||
    !TOKEN.test(profile.id) ||
    (profile.credentials !== 'none' && profile.credentials !== 'scoped')
  )
    return invalid(
      `${id}: environmentProfile must be {id, credentials: none | scoped}; ambient credentials are never declared`,
    );
  const limits = e.limits;
  if (
    !exactKeys(limits, ['timeoutMs', 'memoryBytes', 'outputBytes', 'concurrency']) ||
    !Object.values(limits).every(positive)
  )
    return invalid(
      `${id}: limits require positive integer timeoutMs, memoryBytes, outputBytes and concurrency`,
      'IA-COMP-CATALOG-LIMITS',
    );
  const policy = e.evidencePolicy;
  let evidencePolicy: EvidencePolicy;
  if (exactKeys(policy, ['kind']) && policy.kind === 'fresh-run') evidencePolicy = { kind: 'fresh-run' };
  else if (
    exactKeys(policy, ['kind', 'maxAgeMs', 'environmentSensitive']) &&
    policy.kind === 'reusable' &&
    positive(policy.maxAgeMs) &&
    typeof policy.environmentSensitive === 'boolean'
  )
    evidencePolicy = { kind: 'reusable', maxAgeMs: policy.maxAgeMs, environmentSensitive: policy.environmentSensitive };
  else
    return invalid(
      `${id}: evidencePolicy must be {kind: fresh-run} or {kind: reusable, maxAgeMs, environmentSensitive}`,
    );
  const availability = e.availability;
  let status: EvaluatorAvailability;
  if (exactKeys(availability, ['status']) && availability.status === 'supported') status = { status: 'supported' };
  else if (
    exactKeys(availability, ['status', 'reason']) &&
    (availability.status === 'unavailable' || availability.status === 'revoked') &&
    sanitized(availability.reason)
  )
    status = { status: availability.status, reason: availability.reason };
  else
    return invalid(
      `${id}: availability must be {status: supported} or {status: unavailable | revoked, reason} with a sanitized single-line reason`,
    );
  return {
    entry: {
      id,
      contractVersion: e.contractVersion as string,
      implementationVersion: e.implementationVersion as string,
      implementationDigest: e.implementationDigest,
      inputCodec: refs[0] as CodecRef,
      outputCodec: refs[1] as CodecRef,
      supportedScopes,
      effects,
      environmentProfile: { id: profile.id, credentials: profile.credentials },
      limits: {
        timeoutMs: limits.timeoutMs as number,
        memoryBytes: limits.memoryBytes as number,
        outputBytes: limits.outputBytes as number,
        concurrency: limits.concurrency as number,
      },
      evidencePolicy,
      availability: status,
    },
  };
}
function codecMap(codecs: CatalogOptions['codecs']): ReadonlyMap<string, EvaluatorCodec> {
  const map = new Map<string, EvaluatorCodec>();
  if (!Array.isArray(codecs)) throw new TypeError('options.codecs must be a list of {id, version, validate} codecs');
  for (const codec of codecs as readonly EvaluatorCodec[]) {
    const key =
      codec !== null && typeof codec === 'object' && isCodecRef({ id: codec.id, version: codec.version })
        ? codecKey(codec.id, codec.version)
        : undefined;
    if (
      key === undefined ||
      typeof codec.validate !== 'function' ||
      (codec.normalize !== undefined && typeof codec.normalize !== 'function') ||
      map.has(key)
    )
      throw new TypeError(
        `Invalid or duplicate host codec registration ${sanitized(String(codec?.id), 80) ? String(codec?.id) : '<id>'}`,
      );
    map.set(
      key,
      Object.freeze({
        id: codec.id,
        version: codec.version,
        validate: codec.validate,
        ...(codec.normalize === undefined ? {} : { normalize: codec.normalize }),
      }),
    );
  }
  return map;
}
/**
 * Pure v1 catalog constructor (C25). Refuses unknown format majors, malformed entries, invalid limits,
 * unknown codecs, built-in overrides, duplicate id/version, digest disagreement and more than one
 * supported implementation of an id. The result is frozen and carries a deterministic digest.
 */
export function createEvaluatorCatalog(input: CatalogInput, options: CatalogOptions): CatalogResult {
  const codecs = codecMap(options.codecs),
    extra: unknown = options.builtins;
  if (
    extra !== undefined &&
    (!Array.isArray(extra) || !extra.every((id) => typeof id === 'string' && RESERVED_ID.test(id)))
  )
    throw new TypeError('options.builtins must be a list of reserved ids such as APPS-CHECK');
  const builtins = Object.freeze([...CHECK_IDS]);
  const reserved = Object.freeze(
    [...new Set((extra ?? []) as string[])]
      .filter((id) => !(CHECK_IDS as readonly string[]).includes(id))
      .sort(compareText),
  );
  const refuse = (findings: readonly Finding[]): CatalogResult =>
    Object.freeze({ ok: false as const, assessment: assess('COMP-CATALOG', 'catalog', findings) });
  const raw: unknown = input;
  // The current shape declares `format` and an integer `formatVersion`; the legacy shape is `ia-evaluator-catalog/1.x`.
  let legacy: boolean | undefined;
  if (
    exactKeys(raw, ['format', 'formatVersion', 'entries']) &&
    raw.format === EVALUATOR_CATALOG_FORMAT &&
    (EVALUATOR_CATALOG_FORMAT_VERSIONS as readonly unknown[]).includes(raw.formatVersion)
  )
    legacy = false;
  else if (exactKeys(raw, ['format', 'entries']) && typeof raw.format === 'string') {
    const match = FORMAT.exec(raw.format);
    if (match !== null && match[1] === '1') legacy = true;
  }
  if (legacy === undefined || !Array.isArray(input.entries))
    return refuse([
      note(
        'IA-COMP-CATALOG-VERSION',
        1,
        `Unsupported evaluator catalog; expected exactly {format: ${EVALUATOR_CATALOG_FORMAT}, formatVersion: ${EVALUATOR_CATALOG_FORMAT_VERSIONS.join(' | ')}, entries: [...]} or the legacy {format: ia-evaluator-catalog/1.x, entries: [...]}`,
      ),
    ]);
  const reservedUpper = new Set([...builtins, ...reserved].map((id) => id.toUpperCase())),
    findings: Finding[] = [],
    entries: { entry: EvaluatorEntry; line: number }[] = [];
  input.entries.forEach((item, index) => {
    const checked = checkEntry(item, index + 1, reservedUpper, codecs, legacy);
    if ('finding' in checked) findings.push(checked.finding);
    else entries.push({ entry: checked.entry, line: index + 1 });
  });
  const byVersion = new Map<string, EvaluatorEntry>(),
    supported = new Map<string, EvaluatorEntry>();
  for (const { entry, line } of entries) {
    const key = `${entry.id}@${entry.implementationVersion}`,
      previous = byVersion.get(key);
    if (previous !== undefined) {
      findings.push(
        previous.implementationDigest === entry.implementationDigest
          ? note('IA-COMP-CATALOG-DUPLICATE', line, `Duplicate catalog entry ${key}`)
          : note(
              'IA-COMP-CATALOG-DIGEST-CONFLICT',
              line,
              `Catalog entries for ${key} disagree on implementationDigest`,
            ),
      );
      continue;
    }
    byVersion.set(key, entry);
    if (entry.availability.status !== 'supported') continue;
    if (supported.has(entry.id))
      findings.push(
        note(
          'IA-COMP-CATALOG-DUPLICATE',
          line,
          `More than one supported implementation of ${entry.id}; revoke or mark the others unavailable`,
        ),
      );
    supported.set(entry.id, entry);
  }
  if (findings.length > 0) return refuse(findings.sort((a, b) => a.line - b.line || compareText(a.code, b.code)));
  const sorted = [...byVersion.values()].sort(
    (a, b) => compareText(a.id, b.id) || compareVersions(a.implementationVersion, b.implementationVersion),
  );
  // A legacy catalog keeps the digest over the entries as declared (`name@major` codec ids), so receipts and joins
  // that recorded it still match; a current catalog's digest covers its format version and `{id, version}` codecs.
  const digested = legacy
    ? sha256({
        format: input.format,
        entries: sorted.map(({ inputCodec, outputCodec, ...rest }) => ({
          ...rest,
          inputSchemaId: legacyCodecId(inputCodec),
          outputSchemaId: legacyCodecId(outputCodec),
        })),
        builtins,
        reserved,
      })
    : sha256({ format: input.format, formatVersion: input.formatVersion, entries: sorted, builtins, reserved });
  const catalog: EvaluatorCatalog = deepFreeze({
    format: input.format,
    formatVersion: legacy ? 1 : (input.formatVersion as number),
    digest: digested,
    entries: sorted,
    builtins,
    reserved,
  });
  catalogs.add(catalog);
  catalogCodecs.set(catalog, codecs);
  return Object.freeze({ ok: true as const, catalog, assessment: assess('COMP-CATALOG', 'catalog', []) });
}
/** True only for a catalog returned by createEvaluatorCatalog in this module instance. */
export function isEvaluatorCatalog(value: unknown): value is EvaluatorCatalog {
  return typeof value === 'object' && value !== null && catalogs.has(value);
}
export function assertCatalog(value: unknown): asserts value is EvaluatorCatalog {
  if (!isEvaluatorCatalog(value))
    throw new TypeError('An evaluator catalog must be constructed by createEvaluatorCatalog');
}
/** The host codec registered for exactly this `{id, version}` pair, or undefined. */
export function codecOf(catalog: EvaluatorCatalog, ref: CodecRef): EvaluatorCodec | undefined {
  return catalogCodecs.get(catalog)?.get(codecKey(ref.id, ref.version));
}
/** The entry a check's evaluator id (checkRunner: check.implementation, else check.runs) selects: the supported implementation, else the highest listed version. */
export function selectEvaluator(catalog: EvaluatorCatalog, id: string): EvaluatorEntry | undefined {
  assertCatalog(catalog);
  const listed = catalog.entries.filter((e) => e.id === id);
  return listed.find((e) => e.availability.status === 'supported') ?? listed.at(-1);
}
export function catalogEntry(
  catalog: EvaluatorCatalog,
  id: string,
  implementationVersion: string,
): EvaluatorEntry | undefined {
  return catalog.entries.find((e) => e.id === id && e.implementationVersion === implementationVersion);
}
/**
 * Associate trusted host implementations with supported entries, keyed `${id}@${implementationDigest}` (C26).
 * Any key naming an unknown, substituted, unavailable or revoked implementation refuses the whole binding. The host
 * must bind before it invokes anything; binding invokes nothing, and admission separately checks every receipt's
 * evaluator id, version and digest against the catalog (C28), so an unbound or substituted run cannot pass.
 */
export function bindEvaluators<T>(
  catalog: EvaluatorCatalog,
  implementations: ReadonlyMap<string, T>,
): EvaluatorBinding<T> {
  assertCatalog(catalog);
  const findings: Finding[] = [],
    bound = new Map<string, T>();
  for (const [key, implementation] of [...implementations].sort(([a], [b]) => compareText(a, b))) {
    const at = key.lastIndexOf('@'),
      id = key.slice(0, at),
      digest = key.slice(at + 1);
    const entry = catalog.entries.find((e) => e.id === id && e.implementationDigest === digest);
    if (at <= 0 || entry === undefined || entry.availability.status !== 'supported')
      findings.push(
        note(
          'IA-COMP-EVALUATOR-SUBSTITUTED',
          1,
          `Host implementation ${sanitized(key, 120) ? key : '<key>'} does not match a supported catalog id and implementation digest`,
          '<bindings>',
        ),
      );
    else bound.set(key, implementation);
  }
  if (findings.length > 0) bound.clear();
  return Object.freeze({
    assessment: assess('COMP-CATALOG', 'bindings', findings),
    implementation: (id: string, digest: string) => bound.get(`${id}@${digest}`),
  });
}
