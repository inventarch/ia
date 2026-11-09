/**
 * The installed-implementation catalog's value: the shape a host payload's `implementations.json` holds, shared by the
 * reader that verifies it against the payload (`@inventarch/distribution/implementations`) and by binders that join
 * records with it (`@inventarch/workspace-runtime/bind`), so neither carries its own copy. Pure: it reads, loads and
 * executes nothing.
 *
 * An operation row is one of three:
 * - `available`: the payload ships the implementation's handler. `module` is the payload path of the handler module
 *   and `digest` the SHA-256 of its bytes; `packages` names the installed packages whose shipped files are the
 *   handler's closure (its own package and its declared dependencies). A reader reports a row available only from a
 *   payload that verifies, with `module` and every package in that verified inventory and `digest` its pin there.
 * - `unavailable`, with a reason: the payload does not ship it (a metadata-only declaration, or a handler the payload's
 *   producer could not include). It binds nothing.
 * - `revoked`, with a reason: the payload's producer withdraws it, whatever bytes are present. A binder reports it as an
 *   error. Nothing produces one yet; the format carries it so a withdrawal stays distinct from an absence.
 */
import { deepFreeze, snapshot } from '../descriptors/codec.js';

export const INSTALLED_IMPLEMENTATIONS_FORMAT = 'ia.installed-implementations.v1';

export interface AvailableOperation {
  readonly id: string;
  readonly status: 'available';
  /** The installed descriptor's version. */
  readonly version: number;
  /** The canonical identity of the `@operation` the implementation serves. */
  readonly operation: string;
  readonly handler: string;
  /** The input and output validator ids. */
  readonly input: string;
  readonly output: string;
  /** The payload path of the shipped handler module. */
  readonly module: string;
  /** The SHA-256 of the shipped handler module's bytes. */
  readonly digest: string;
  /** The installed packages whose shipped files are the handler's closure: its own package and its dependencies. */
  readonly packages: readonly string[];
}
export interface UnavailableOperation {
  readonly id: string;
  readonly status: 'unavailable';
  readonly reason: string;
}
export interface RevokedOperation {
  readonly id: string;
  readonly status: 'revoked';
  readonly reason: string;
}
export type InstalledOperation = AvailableOperation | UnavailableOperation | RevokedOperation;
export interface InstalledImplementationsValue {
  readonly format: typeof INSTALLED_IMPLEMENTATIONS_FORMAT;
  /**
   * An evaluator catalog as compliance's `createEvaluatorCatalog` takes it, in the current `{format, formatVersion,
   * entries}` shape or the legacy `ia-evaluator-catalog/1.x` `{format, entries}` shape: its built-ins are implicit.
   */
  readonly evaluators: {
    readonly format: string;
    readonly formatVersion?: number;
    readonly entries: readonly unknown[];
  };
  readonly operations: readonly InstalledOperation[];
}
export type InstalledImplementationsCheck =
  | { readonly ok: true; readonly value: InstalledImplementationsValue }
  | { readonly ok: false; readonly reason: string };

const ROWS = 1024;
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  HANDLER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
  IDENTITY = /^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/,
  PACKAGE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/,
  HEX = /^[a-f0-9]{64}$/,
  EVALUATOR_FORMAT = /^ia-evaluator-catalog\/1\.(?:0|[1-9][0-9]*)$/,
  EVALUATOR_FORMAT_NAME = 'ia-evaluator-catalog';
const AVAILABLE_KEYS = [
    'id',
    'status',
    'version',
    'operation',
    'handler',
    'input',
    'output',
    'module',
    'digest',
    'packages',
  ],
  REASON_KEYS = ['id', 'status', 'reason'];
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> | null =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|')
    ? (value as Record<string, unknown>)
    : null;
const prose = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
/** A relative `/` path inside the payload's runtime packages, portable on every supported platform. */
const modulePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 1024 &&
  value.startsWith('runtime/node_modules/') &&
  /\.[cm]?js$/.test(value) &&
  value === value.normalize('NFC') &&
  !/[\\\u0000-\u001f<>:"|?*]/.test(value) &&
  value
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    );

function operationProblem(item: unknown): string | null {
  const status =
    item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as { status?: unknown }).status : null;
  if (status === 'unavailable' || status === 'revoked') {
    const row = record(item, REASON_KEYS);
    return row !== null &&
      typeof row['id'] === 'string' &&
      TOKEN.test(row['id']) &&
      row['id'].length <= 128 &&
      prose(row['reason'], 512)
      ? null
      : `Invalid ${status} installed operation`;
  }
  if (status !== 'available') return 'An installed operation is available, unavailable or revoked';
  const row = record(item, AVAILABLE_KEYS);
  if (row === null) return 'Invalid available installed operation';
  const packages = row['packages'];
  const valid =
    typeof row['id'] === 'string' &&
    TOKEN.test(row['id']) &&
    row['id'].length <= 128 &&
    Number.isSafeInteger(row['version']) &&
    (row['version'] as number) >= 1 &&
    typeof row['operation'] === 'string' &&
    IDENTITY.test(row['operation']) &&
    row['operation'].length <= 256 &&
    typeof row['handler'] === 'string' &&
    HANDLER.test(row['handler']) &&
    row['handler'].length <= 128 &&
    typeof row['input'] === 'string' &&
    TOKEN.test(row['input']) &&
    typeof row['output'] === 'string' &&
    TOKEN.test(row['output']) &&
    typeof row['digest'] === 'string' &&
    HEX.test(row['digest']) &&
    Array.isArray(packages) &&
    packages.length > 0 &&
    packages.length <= 64 &&
    packages.every(
      (name, index) =>
        typeof name === 'string' &&
        PACKAGE.test(name) &&
        name.length <= 214 &&
        (index === 0 || (packages[index - 1] as string) < name),
    ) &&
    modulePath(row['module']);
  if (!valid) return 'Invalid available installed operation';
  // The handler module belongs to one of the packages its closure names, so its bytes are part of what is shipped.
  return (packages as string[]).some((name) => (row['module'] as string).startsWith(`runtime/node_modules/${name}/`))
    ? null
    : 'An installed handler module lies outside its package closure';
}

/**
 * Whether `value` is a catalog: exactly `format`, `evaluators` (an `ia-evaluator-catalog` format with an integer
 * `formatVersion`, or the legacy `ia-evaluator-catalog/1.x` format without one, and an entry list, whose entries
 * compliance validates when it binds) and `operations`, one row per operation sorted by id and unique,
 * each as the module comment describes. `value` is first copied once as plain data, as the descriptor codec copies
 * host input (`snapshot`: no proxy, accessor, class instance, cycle or excess size), and the checked copy is returned
 * deeply frozen, so what was checked is what every reader of it sees. Returns that copy, or the first reason `value` is
 * not a catalog.
 */
export function checkInstalledImplementations(input: unknown): InstalledImplementationsCheck {
  const refuse = (reason: string): InstalledImplementationsCheck => ({ ok: false, reason });
  let value: unknown;
  try {
    value = snapshot(input, 'DESC-ENVELOPE-INVALID', 'implementations', { depth: 16, nodes: 200_000 });
  } catch {
    return refuse('The installed-implementation catalog is not plain, acyclic, bounded data');
  }
  const row = record(value, ['format', 'evaluators', 'operations']);
  if (row === null) return refuse('Unexpected installed-implementation catalog fields');
  if (row['format'] !== INSTALLED_IMPLEMENTATIONS_FORMAT)
    return refuse('Unknown installed-implementation catalog format');
  const section = row['evaluators'],
    evaluators = record(section, ['format', 'entries']) ?? record(section, ['format', 'formatVersion', 'entries']);
  const shaped =
    evaluators !== null &&
    typeof evaluators['format'] === 'string' &&
    (Object.hasOwn(evaluators, 'formatVersion')
      ? evaluators['format'] === EVALUATOR_FORMAT_NAME &&
        Number.isSafeInteger(evaluators['formatVersion']) &&
        (evaluators['formatVersion'] as number) > 0
      : EVALUATOR_FORMAT.test(evaluators['format']));
  if (evaluators === null || !shaped || !Array.isArray(evaluators['entries']) || evaluators['entries'].length > ROWS)
    return refuse('The evaluators section is not an ia-evaluator-catalog value (format and formatVersion, or 1.x)');
  const operations = row['operations'];
  if (!Array.isArray(operations) || operations.length > ROWS) return refuse('Invalid installed operation list');
  let previous = '';
  for (const item of operations) {
    const problem = operationProblem(item);
    if (problem !== null) return refuse(problem);
    const id = (item as { id: string }).id;
    if (id <= previous) return refuse('Installed operations must be sorted by id and unique');
    previous = id;
  }
  return { ok: true, value: deepFreeze(value as InstalledImplementationsValue) };
}
