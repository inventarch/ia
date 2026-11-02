import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MethodError } from './errors.js';

/**
 * Bindings: which kit and capability answer an entry point's activity in a repository, read from the interim sidecar
 * `<repo>/.ia/bindings.json`:
 * `{ format: 1, bindings: { "<entry>.<activity>": binding | [binding, ...] }, precedence?: [kit id, ...], defaults?: { <entry>: binding } }`,
 * where a binding is `{ kit, capability, profile? }`. `<entry>.*` answers every activity of the entry without an exact
 * key, and `defaults.<entry>` answers when neither does. Several candidates for one key conflict unless `precedence`
 * orders them. The entry points are Work, Delivery and Knowledge; Delivery took Development's place.
 */
export const ENTRIES = ['work', 'delivery', 'knowledge'] as const;
export type Entry = (typeof ENTRIES)[number];
export const RENAMED: Readonly<Record<string, string>> = { development: 'delivery' };
export const renamedMessage = (entry: string): string =>
  `the ${entry} entry point is now ${RENAMED[entry]}: write ${RENAMED[entry]} where ${entry} was written`;

export interface Binding {
  readonly kit: string;
  readonly capability: string;
  readonly profile?: string;
}
export interface Bindings {
  readonly format: 1;
  readonly path: string;
  readonly bindings: Readonly<Record<string, readonly Binding[]>>;
  readonly precedence: readonly string[];
  readonly defaults: Readonly<Record<string, Binding>>;
}
export interface SelectedBinding extends Binding {
  readonly key: string;
  readonly via: string;
}

export const bindingsPath = (root: string): string => join(root, '.ia', 'bindings.json');

function checkBinding(value: unknown, where: string): Binding {
  const row = value as Record<string, unknown> | null;
  if (
    typeof row !== 'object' ||
    row === null ||
    typeof row['kit'] !== 'string' ||
    typeof row['capability'] !== 'string'
  )
    throw new MethodError(`${where} needs { kit, capability }`, 'IA-CORE-BINDINGS-MALFORMED');
  return {
    kit: row['kit'],
    capability: row['capability'],
    ...(row['profile'] ? { profile: row['profile'] as string } : {}),
  };
}

/** The parsed sidecar, or null when the repository has none. */
export function readBindings(root: string): Bindings | null {
  const path = bindingsPath(root);
  if (!existsSync(path)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new MethodError(`${path} is not JSON: ${(error as Error).message}`, 'IA-CORE-BINDINGS-MALFORMED');
  }
  const declared = parsed['bindings'];
  if (parsed['format'] !== 1 || typeof declared !== 'object' || declared === null)
    throw new MethodError(`${path} needs format 1 and a bindings object`, 'IA-CORE-BINDINGS-MALFORMED');
  const bindings: Record<string, readonly Binding[]> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (!/^[a-z]+\.(?:[a-z][a-z0-9-]*|\*)$/.test(key))
      throw new MethodError(`${path}: key ${key} is not <entry>.<activity>`, 'IA-CORE-BINDINGS-MALFORMED');
    const entry = key.slice(0, key.indexOf('.'));
    if (RENAMED[entry])
      throw new MethodError(
        `${path}: key ${key}: ${renamedMessage(entry)}, so ${RENAMED[entry]}${key.slice(entry.length)}`,
        'IA-CORE-BINDINGS-MALFORMED',
        { key },
      );
    bindings[key] = (Array.isArray(value) ? value : [value]).map((v, i) => checkBinding(v, `${path}: ${key}[${i}]`));
  }
  const precedence = parsed['precedence'] ?? [];
  if (!Array.isArray(precedence) || !precedence.every((p) => typeof p === 'string'))
    throw new MethodError(`${path}: precedence must be a list of kit ids`, 'IA-CORE-BINDINGS-MALFORMED');
  const defaults: Record<string, Binding> = {};
  for (const [entry, value] of Object.entries((parsed['defaults'] ?? {}) as Record<string, unknown>)) {
    if (RENAMED[entry])
      throw new MethodError(
        `${path}: defaults.${entry}: ${renamedMessage(entry)}, so defaults.${RENAMED[entry]}`,
        'IA-CORE-BINDINGS-MALFORMED',
      );
    defaults[entry] = checkBinding(value, `${path}: defaults.${entry}`);
  }
  return { format: 1, path, bindings, precedence: precedence as string[], defaults };
}

/** The one binding for `<entry>.<activity>`, with how it was chosen: exact, wildcard or default, then precedence. */
export function selectBinding(data: Bindings | null, entry: string, activity: string): SelectedBinding {
  if (RENAMED[entry]) throw new MethodError(renamedMessage(entry), 'IA-CORE-USAGE');
  if (!(ENTRIES as readonly string[]).includes(entry))
    throw new MethodError(`unknown entry point ${entry}; the entry points are ${ENTRIES.join(', ')}`, 'IA-CORE-USAGE');
  const key = `${entry}.${activity}`;
  const none = (): MethodError =>
    new MethodError(
      `no method is bound for ${key} in this repository: .ia/bindings.json names no ${key}, no ${entry}.*, and no defaults.${entry}. List the kits with kit.mjs list and bind one with bind.mjs set ${key} <kit> <capability>`,
      'IA-CORE-NO-METHOD',
      { key },
    );
  if (!data) throw none();
  let candidates: readonly Binding[], via: string;
  const exact = data.bindings[key],
    wildcard = data.bindings[`${entry}.*`],
    fallback = data.defaults[entry];
  if (exact?.length) {
    candidates = exact;
    via = 'exact';
  } else if (wildcard?.length) {
    candidates = wildcard;
    via = 'wildcard';
  } else if (fallback) {
    candidates = [fallback];
    via = 'default';
  } else throw none();
  if (candidates.length === 1) return { ...candidates[0]!, key, via };
  const ranked = candidates
    .map((c) => ({ c, rank: data.precedence.indexOf(c.kit) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0]!.rank === ranked[1]!.rank))
    throw new MethodError(
      `${key} is bound to ${candidates.length} methods and precedence does not order them: ${candidates.map((c) => `${c.kit}#${c.capability}`).join(', ')}. Run bind.mjs precedence <kit...> to rank the kits, or bind.mjs set ${key} <kit> <capability> to keep one`,
      'IA-CORE-CONFLICT',
      { key, candidates: candidates.map((c) => ({ kit: c.kit, capability: c.capability })) },
    );
  return { ...ranked[0]!.c, key, via: `${via}+precedence` };
}

/** The nearest folder at or above `from` that holds `.ia/src`, or null. */
export function findWorkspace(from: string): string | null {
  let dir = resolve(from);
  try {
    dir = realpathSync.native(dir);
  } catch {
    dir = resolve(from);
  }
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.ia', 'src'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The scope key each entry point's activity states to the position: a shape (the intent) and a phase (the moment). An
 * activity the table does not name takes its entry's default; an explicit shape or phase overrides either.
 */
export const SCOPE_KEYS: Readonly<Record<Entry, Readonly<Record<string, readonly [string, string]>>>> = {
  work: {
    default: ['governance', 'plan'],
    task: ['governance', 'plan'],
    decision: ['governance', 'plan'],
    dependencies: ['sequence', 'plan'],
    delegation: ['execution', 'act'],
    progress: ['context', 'orient'],
    completion: ['learning', 'learn'],
  },
  delivery: {
    default: ['execution', 'act'],
    understand: ['context', 'orient'],
    design: ['governance', 'plan'],
    change: ['execution', 'act'],
    diagnose: ['context', 'orient'],
    review: ['learning', 'learn'],
    deliver: ['learning', 'learn'],
  },
  knowledge: {
    default: ['context', 'orient'],
    find: ['context', 'orient'],
    explain: ['context', 'orient'],
    packet: ['context', 'orient'],
    place: ['governance', 'plan'],
    reconcile: ['learning', 'learn'],
    maintain: ['execution', 'act'],
  },
};
export const SHAPES = ['context', 'governance', 'execution', 'sequence', 'learning'] as const;
export const PHASES = ['orient', 'plan', 'act', 'learn'] as const;

export function scopeKey(
  entry: string,
  activity: string,
  overrides: { readonly shape?: string | undefined; readonly phase?: string | undefined } = {},
): { readonly shape: string; readonly phase: string; readonly mapped: boolean } {
  const table = Object.hasOwn(SCOPE_KEYS, entry) ? SCOPE_KEYS[entry as Entry] : null;
  if (!table)
    throw new MethodError(
      `unknown entry point ${entry}; the entry points are ${Object.keys(SCOPE_KEYS).join(', ')}`,
      'IA-CORE-USAGE',
    );
  const mapped = Object.hasOwn(table, activity);
  const [shape, phase] = (mapped ? table[activity] : table['default'])!;
  if (overrides.shape && !(SHAPES as readonly string[]).includes(overrides.shape))
    throw new MethodError(`--shape must be one of ${SHAPES.join(', ')}`, 'IA-CORE-USAGE');
  if (overrides.phase && !(PHASES as readonly string[]).includes(overrides.phase))
    throw new MethodError(`--phase must be one of ${PHASES.join(', ')}`, 'IA-CORE-USAGE');
  return { shape: overrides.shape ?? shape, phase: overrides.phase ?? phase, mapped };
}
