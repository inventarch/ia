import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MethodError } from './errors.js';

/**
 * The workspace registry: `<IA home>/workspace-locations.json`, the workspace roots one person keeps. Format 2 is
 * `{ format: "ia-workspace-locations-2", workspaces: [{ id, root, label?, added }] }`. Readers also accept the two
 * earlier files and normalise them: `personal-workspace-locations-1`, whose `workspaces` object maps an id to
 * `{ root, ... }`, and Studio's `format: 1`, whose `locations` object maps an id to `{ path, ... }`. Writers write
 * format 2 only. User-facing workspaces default to `~/Documents/ia/<domain>`; the IA home holds the registry, never a
 * workspace.
 */
export const REGISTRY_FORMAT = 'ia-workspace-locations-2';
export const REGISTRY_FILE = 'workspace-locations.json';

export interface RegisteredWorkspace {
  readonly id: string;
  readonly root: string;
  readonly label?: string;
  readonly added: string;
}
export interface WorkspaceRegistry {
  readonly format: typeof REGISTRY_FORMAT;
  readonly workspaces: readonly RegisteredWorkspace[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const registryPath = (home: string): string => join(home, REGISTRY_FILE);
/** The default root of a user-facing workspace for a domain: `~/Documents/ia/<domain>`. */
export const defaultWorkspaceRoot = (domain: string, home: string = homedir()): string => {
  if (!ID.test(domain)) throw new MethodError(`a workspace domain must be a slug: ${domain}`, 'IA-CORE-USAGE');
  return join(home, 'Documents', 'ia', domain);
};

const malformed = (path: string, why: string): MethodError =>
  new MethodError(`${path} is not a workspace registry: ${why}`, 'IA-CORE-REGISTRY');

/** The registry, normalised to format 2 whichever format the file holds; an empty one when there is no file. */
export function readRegistry(home: string): WorkspaceRegistry {
  const path = registryPath(home);
  if (!existsSync(path)) return { format: REGISTRY_FORMAT, workspaces: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw malformed(path, (error as Error).message);
  }
  const fallback = statSync(path).mtime.toISOString();
  const entry = (id: string, value: unknown, rootKey: 'root' | 'path'): RegisteredWorkspace => {
    const row = (value ?? {}) as Record<string, unknown>;
    const root = row[rootKey];
    if (typeof root !== 'string' || !isAbsolute(root)) throw malformed(path, `${id} names no absolute ${rootKey}`);
    const label = typeof row['label'] === 'string' ? row['label'] : undefined;
    const added = typeof row['added'] === 'string' ? row['added'] : fallback;
    return { id, root, ...(label === undefined ? {} : { label }), added };
  };
  const keyed = (value: unknown, rootKey: 'root' | 'path'): RegisteredWorkspace[] => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed(path, 'no object of ids');
    return Object.entries(value as Record<string, unknown>).map(([id, row]) => entry(id, row, rootKey));
  };
  let workspaces: RegisteredWorkspace[];
  if (parsed['format'] === REGISTRY_FORMAT) {
    if (!Array.isArray(parsed['workspaces'])) throw malformed(path, 'format 2 needs a workspaces list');
    workspaces = (parsed['workspaces'] as Record<string, unknown>[]).map((row) => {
      if (typeof row?.['id'] !== 'string') throw malformed(path, 'a workspace has no id');
      return entry(row['id'], row, 'root');
    });
  } else if (parsed['format'] === 'personal-workspace-locations-1') workspaces = keyed(parsed['workspaces'], 'root');
  else if (parsed['format'] === 1) workspaces = keyed(parsed['locations'], 'path');
  else throw malformed(path, `unknown format ${JSON.stringify(parsed['format'])}`);
  const ids = new Set<string>();
  for (const workspace of workspaces) {
    if (ids.has(workspace.id)) throw malformed(path, `${workspace.id} is listed twice`);
    ids.add(workspace.id);
  }
  return { format: REGISTRY_FORMAT, workspaces };
}

/** Writes the registry as format 2, atomically. */
export function writeRegistry(home: string, registry: Pick<WorkspaceRegistry, 'workspaces'>): string {
  const path = registryPath(home);
  mkdirSync(home, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body: WorkspaceRegistry = { format: REGISTRY_FORMAT, workspaces: registry.workspaces };
  try {
    writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

/**
 * Adds or replaces one workspace and writes the registry as format 2, keeping every other row. A root inside the IA
 * home is refused: the home holds configuration and state, never a workspace.
 */
export function registerWorkspace(
  home: string,
  workspace: { readonly id: string; readonly root: string; readonly label?: string },
  now: Date = new Date(),
): RegisteredWorkspace {
  if (!ID.test(workspace.id)) throw new MethodError(`a workspace id must be a slug: ${workspace.id}`, 'IA-CORE-USAGE');
  if (!isAbsolute(workspace.root))
    throw new MethodError(`a workspace root must be absolute: ${workspace.root}`, 'IA-CORE-USAGE');
  const root = resolve(workspace.root);
  if (sameOrInside(root, home))
    throw new MethodError(`${root} is inside the IA home ${home}; a workspace lives elsewhere`, 'IA-CORE-USAGE');
  const current = readRegistry(home);
  const prior = current.workspaces.find((row) => row.id === workspace.id);
  const row: RegisteredWorkspace = {
    id: workspace.id,
    root,
    ...(workspace.label === undefined ? {} : { label: workspace.label }),
    added: prior?.added ?? now.toISOString(),
  };
  writeRegistry(home, {
    workspaces: [...current.workspaces.filter((other) => other.id !== workspace.id), row],
  });
  return row;
}

const key = (path: string): string => {
  const plain = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? plain.toLowerCase() : plain;
};
/** Whether two paths name one folder, case folded where the platform folds it. */
export const samePath = (a: string, b: string): boolean => key(a) === key(b);
const sameOrInside = (path: string, parent: string): boolean =>
  samePath(path, parent) || key(path).startsWith(key(parent) + '/');
