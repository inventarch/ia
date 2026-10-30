import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MethodError } from './errors.js';
import { iaHome } from './kits.js';

/**
 * The task binding (pin): which kit versions and capabilities a task resolved, one entry per activity key, kept at
 * `<IA home>/work-v1/<project>/<task>/binding.json` with every earlier revision as `binding.<n>.json`. Format 3:
 * `{ format: 3, revision, workspace: { root, revision }, task, kits: { <kit id>: { version, archive, sources,
 * implementation, retained } }, keys: { <entry>.<activity>: { kit, capability, profile, records, scopeKey, intent } },
 * createdAt, supersedes }`. A format 1 pin (one kit and capability) reads as format 3 with its one key. A pin belongs
 * to one workspace: a read for another root refuses.
 */
export const PIN_FORMAT = 3;

export interface PinnedKit {
  readonly version: string | null;
  readonly archive?: string | null;
  readonly sources?: string | null;
  readonly implementation?: string | null;
  readonly retained?: string | null;
}
export interface PinnedKey {
  readonly kit: string;
  readonly capability: string;
  readonly profile?: string | null;
  readonly records?: readonly string[];
  readonly scopeKey?: unknown;
  readonly intent?: unknown;
}
export interface Pin {
  readonly format: number;
  readonly revision: number;
  readonly workspace: { readonly root: string; readonly revision?: string };
  readonly task?: string | null;
  readonly kits: Readonly<Record<string, PinnedKit>>;
  readonly keys: Readonly<Record<string, PinnedKey>>;
  readonly createdAt?: string;
  readonly supersedes?: number | null;
  readonly path: string;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The folder that holds the task's binding, or null for a stateless resolve. */
export function pinRootFor(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly project?: string | undefined;
    readonly task?: string | undefined;
    readonly run?: string | undefined;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  for (const [name, value] of [
    ['project', options.project],
    ['task', options.task],
    ['run', options.run],
  ] as const)
    if (value !== undefined && !SLUG.test(value))
      throw new MethodError(`--${name} must be a slug (letters, digits, . _ -): ${value}`, 'IA-CORE-USAGE');
  if (env['IA_CORE_RUN_ROOT']) return resolve(env['IA_CORE_RUN_ROOT']);
  if (!options.project && !options.task) return null;
  if (!options.project || !options.task)
    throw new MethodError(
      'a task binding needs --project and --task together (or IA_CORE_RUN_ROOT); --run only names the run that attaches',
      'IA-CORE-USAGE',
    );
  return join(iaHome(env), 'work-v1', options.project, options.task);
}

const same = (a: string, b: string): boolean =>
  resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase();

function upgrade(pin: Record<string, unknown>): Record<string, unknown> {
  const { kit, capability, records, scopeKey, intent, ...rest } = pin as {
    kit: { id: string; version: string; archive?: string; sources?: string };
    capability: string;
    records?: string[];
    scopeKey?: unknown;
    intent?: { entry?: string; activity?: string };
  } & Record<string, unknown>;
  const key = `${intent?.entry}.${intent?.activity}`;
  return {
    ...rest,
    format: PIN_FORMAT,
    legacyFormat: 1,
    kits: { [kit.id]: { version: kit.version, archive: kit.archive ?? null, sources: kit.sources ?? null } },
    keys: {
      [key]: { kit: kit.id, capability, records: records ?? [], scopeKey: scopeKey ?? null, intent: intent ?? null },
    },
  };
}

/** The current pin in the folder for this workspace, or null; a pin naming another workspace root refuses. */
export function readPin(pinRoot: string | null, workspaceRoot: string): Pin | null {
  if (!pinRoot) return null;
  const path = join(pinRoot, 'binding.json');
  if (!existsSync(path)) return null;
  let pin: Record<string, unknown>;
  try {
    pin = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new MethodError(`${path} is not JSON: ${(error as Error).message}`, 'IA-CORE-PIN-MALFORMED');
  }
  const legacy = pin as {
    workspace?: { root?: string };
    kit?: { id?: string };
    intent?: { entry?: string; activity?: string };
  };
  if (
    pin['format'] === 1 &&
    legacy.workspace?.root &&
    legacy.kit?.id &&
    legacy.intent?.entry &&
    legacy.intent?.activity
  )
    pin = upgrade(pin);
  if (pin['format'] === 2) pin = { ...pin, format: PIN_FORMAT, legacyFormat: 2 };
  const shaped = pin as unknown as Partial<Pin>;
  const kits = shaped.kits,
    keys = shaped.keys;
  const valid =
    shaped.format === PIN_FORMAT &&
    Boolean(shaped.workspace?.root) &&
    kits !== undefined &&
    typeof kits === 'object' &&
    keys !== undefined &&
    typeof keys === 'object' &&
    Object.values(keys).every(
      (k) => k && typeof k.kit === 'string' && typeof k.capability === 'string' && kits[k.kit] !== undefined,
    );
  if (!valid)
    throw new MethodError(
      `${path} is not a format ${PIN_FORMAT} task binding (nor a format 1 one)`,
      'IA-CORE-PIN-MALFORMED',
    );
  const root = shaped.workspace!.root;
  if (!same(root, workspaceRoot))
    throw new MethodError(
      `${path} binds a task in ${root}, not in ${workspaceRoot}: a task belongs to one repository; use that repository or another task folder`,
      'IA-CORE-RUN-MISMATCH',
      { pinnedRoot: root },
    );
  return { ...(pin as unknown as Pin), path };
}

/** Writes the next revision; the previous current file is kept as `binding.<n>.json`. */
export function writePin(
  pinRoot: string,
  record: Pick<Pin, 'workspace' | 'task' | 'kits' | 'keys'>,
  previous: Pin | undefined,
): Pin {
  mkdirSync(pinRoot, { recursive: true });
  const path = join(pinRoot, 'binding.json'),
    lock = join(pinRoot, '.binding.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new MethodError('task pin is locked; retry after its writer completes', 'IA-CORE-PIN-CONFLICT');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const temporary = join(pinRoot, `.binding-${process.pid}-${Date.now()}.tmp`);
  try {
    const currentBytes = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const current = currentBytes ? (JSON.parse(currentBytes) as { revision?: number }) : null;
    if ((current?.revision ?? null) !== (previous?.revision ?? null))
      throw new MethodError(
        'task pin changed during resolution; resolve again against the current revision',
        'IA-CORE-PIN-CONFLICT',
      );
    const revision = (previous?.revision ?? 0) + 1;
    const pin = {
      format: PIN_FORMAT,
      revision,
      ...record,
      createdAt: new Date().toISOString(),
      supersedes: previous ? previous.revision : null,
    };
    writeFileSync(temporary, JSON.stringify(pin, null, 2) + '\n', { flag: 'wx' });
    if (previous) {
      const history = join(pinRoot, `binding.${previous.revision}.json`);
      if (existsSync(history)) {
        if (readFileSync(history, 'utf8') !== currentBytes)
          throw new MethodError('task pin history already contains different bytes', 'IA-CORE-PIN-CONFLICT');
      } else writeFileSync(history, currentBytes ?? '', { flag: 'wx' });
    }
    renameSync(temporary, path);
    return { ...pin, path };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true });
  }
}

/** Null when the pinned kit is the available version, else both. */
export function kitUpdate(
  pinnedKit: PinnedKit | null | undefined,
  available: { readonly version: string | null | undefined; readonly archive: string | null | undefined } | null,
): {
  readonly pinned: { readonly version: string | null; readonly archive: string | null };
  readonly available: { readonly version: string | null | undefined; readonly archive: string | null };
} | null {
  if (!pinnedKit || !available) return null;
  if (pinnedKit.version === available.version && (pinnedKit.archive ?? null) === (available.archive ?? null))
    return null;
  return {
    pinned: { version: pinnedKit.version, archive: pinnedKit.archive ?? null },
    available: { version: available.version, archive: available.archive ?? null },
  };
}
