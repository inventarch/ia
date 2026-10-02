import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { decodeDistributionJson, packageId } from '@ia/db/distribution';
import { bytes, DistributionError, fail, locate, object, utf8, workspace } from './files.js';
import { relabel } from './registry-layout.js';
import { parseRegistryBase } from './registry-source.js';
import type { RegistryBase } from './registry-source.js';

/** Registry spec §4 level 5. */
export const DEFAULT_REGISTRIES: Readonly<Record<string, string>> = Object.freeze({
  inventarch: 'https://api.inventarch.dev/registry',
});
export type RegistryLevel = 'flag' | 'env' | 'workspace' | 'user' | 'default';
/** `source` names what chose the base (`doctor`, §4): the flag, the variable, the file or the built-in default. */
export interface RegistryChoice {
  readonly provider: string;
  readonly base: RegistryBase;
  readonly level: RegistryLevel;
  readonly source: string;
}
/** `cwd` (default `process.cwd()`) anchors relative `--registry` and `IA_REGISTRY` directories; `platform` and `home` pick the user file (§4 level 4). */
export interface RegistryOptions {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flag?: string;
  readonly cwd?: string;
  readonly platform?: string;
  readonly home?: string;
}
type Env = Readonly<Record<string, string | undefined>>;
const WORKSPACE_FILE = '.ia/registries.json';
/** A mapping key is `*` or a provider exactly as `packageId` (packages/db/src/distribution/codec.ts:34) accepts it before the `/`. */
const providerKey = (key: string): boolean => {
  if (key === '*') return true;
  try {
    packageId(`${key}/p`);
    return true;
  } catch {
    return false;
  }
};
/** Registry spec §4 level 4: `IA_CONFIG_HOME`, else the per-OS configuration directory. */
export function userConfigDir(env: Env, platform: string = process.platform, home: string = homedir()): string {
  const configured = env['IA_CONFIG_HOME'];
  if (configured) {
    if (!isAbsolute(configured)) fail('INPUT-INVALID', 'IA_CONFIG_HOME must be absolute');
    return configured;
  }
  if (platform === 'win32') return join(env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'ia');
  if (platform === 'darwin') return join(home, 'Library/Preferences', 'ia');
  // XDG Base Directory: a relative $XDG_CONFIG_HOME is invalid and ignored.
  const xdg = env['XDG_CONFIG_HOME'];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'ia');
}
const FILE_LIMIT = 64 * 1024;
/**
 * The user file, or null when it or its directory is absent. It is operator-owned config outside the workspace, so links
 * and junctions on its path are followed (a redirected profile, macOS `/var`); `bytes` refuses them to guard committed
 * workspace content only. It must resolve to a regular file within the bound; filesystem failures never escape raw.
 */
function userBytes(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(realpathSync(file), 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('INPUT-INVALID', `Expected a regular file: ${file}`);
    if (stat.size > FILE_LIMIT) fail('LIMIT-EXCEEDED', `File exceeds ${FILE_LIMIT} bytes: ${file}`);
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0,
      read: number;
    while (size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
    if (size > FILE_LIMIT) fail('LIMIT-EXCEEDED', `File grew beyond its bound: ${file}`);
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof DistributionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    // A config home that is a file reads as ENOENT on Windows and ENOTDIR elsewhere; both mean the directory is absent.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') fail('PATH-UNSAFE', `Link loop on the path to ${file}`);
    if (code === 'EISDIR') fail('INPUT-INVALID', `Expected a regular file: ${file}`);
    return fail(
      'INPUT-INVALID',
      `Cannot read ${file}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
type Mappings = ReadonlyMap<string, RegistryBase>;
/** One `ia.registries.v1` file, or null when `content` is (the file is absent). Every entry is checked with the level's rule (`check`), not only the one a lookup picks: §4 forbids credentials and escaping directories anywhere in the file. */
function mappings(content: Buffer | null, label: string, check: (value: string) => RegistryBase): Mappings | null {
  if (content === null) return null;
  const row = relabel(
    () => object(decodeDistributionJson(utf8(content)), ['format', 'registries']),
    `Invalid ${label}: `,
  );
  const registries = row['registries'];
  if (row['format'] !== 'ia.registries.v1') fail('INPUT-INVALID', `Invalid ${label}: format must be ia.registries.v1`);
  if (registries === null || typeof registries !== 'object' || Array.isArray(registries))
    fail('INPUT-INVALID', `Invalid ${label}: registries must be an object`);
  const map = new Map<string, RegistryBase>();
  for (const [key, value] of Object.entries(registries)) {
    if (!providerKey(key)) fail('INPUT-INVALID', `Invalid ${label} entry ${key}: expected a provider name or *`);
    if (typeof value !== 'string' || !value)
      fail('INPUT-INVALID', `Invalid ${label} entry ${key}: expected a non-empty URL or directory`);
    map.set(key, Object.freeze(relabel(() => check(value), `${label} ${key}: `)));
  }
  return map;
}
/** Within levels 3 and 4 an exact provider key beats `*` (§4). */
const pick = (map: Mappings | null, provider: string): RegistryBase | undefined => map?.get(provider) ?? map?.get('*');
/** §4 level 3: a committed file, so a directory must stay inside the workspace (and must not be the workspace itself). */
function insideWorkspace(root: string, value: string): RegistryBase {
  const base = parseRegistryBase(value, root);
  if (base.kind === 'https') return base;
  const away = relative(root, base.path);
  const absolute = isAbsolute(value),
    driveQualified = /^[A-Za-z]:/.test(value),
    network = /^[\\/]{2}/.test(value);
  const isRoot = away === '',
    escapes = away === '..' || /^\.\.[\\/]/.test(away) || isAbsolute(away);
  if (absolute || driveQualified || network || isRoot || escapes)
    fail('INPUT-INVALID', `Workspace registry directories must be relative paths inside the workspace: ${value}`);
  return base;
}
/** §4 level 4: a per-user file, so a directory must be absolute. */
function absoluteOnly(dir: string, value: string): RegistryBase {
  const base = parseRegistryBase(value, dir);
  if (base.kind === 'dir' && !isAbsolute(value))
    fail('INPUT-INVALID', `User registry directories must be absolute: ${value}`);
  return base;
}
/** Runs `work` on first use only; a refusal is not cached. */
function once<T>(work: () => T): () => T {
  let done = false,
    value: T;
  return () => {
    if (!done) {
      value = work();
      done = true;
    }
    return value;
  };
}
interface Level {
  readonly level: RegistryLevel;
  readonly source: string;
  readonly base: RegistryBase;
}
/**
 * Registry spec §4 for one command: each level is read and validated at most once, and only when every higher level
 * leaves a provider unanswered, so one command sees one configuration. The returned function picks per id.
 */
export function registryChooser(options: RegistryOptions): (id: string) => RegistryChoice {
  // §4 levels 1-2 are typed on the command line, so a relative directory is relative to the caller's cwd, not the workspace.
  const cwd = options.cwd ?? process.cwd(),
    flag = options.flag,
    variable = options.env['IA_REGISTRY'];
  const commandLine = once((): Level | null => {
    if (flag !== undefined)
      return {
        level: 'flag',
        source: '--registry',
        base: Object.freeze(relabel(() => parseRegistryBase(flag, cwd), '--registry: ')),
      };
    if (variable)
      return {
        level: 'env',
        source: 'IA_REGISTRY',
        base: Object.freeze(relabel(() => parseRegistryBase(variable, cwd), 'IA_REGISTRY: ')),
      };
    return null;
  });
  const root = once(() => workspace(options.root));
  // Links on the workspace file's path refuse (`bytes`), and its refusals are located at the file (`locate`); only the user file follows links (`userBytes`).
  const local = once(() => {
    const at = root();
    return locate(WORKSPACE_FILE, () =>
      mappings(bytes(at, WORKSPACE_FILE, FILE_LIMIT), WORKSPACE_FILE, (value) => insideWorkspace(at, value)),
    );
  });
  const user = once(() => {
    const dir = userConfigDir(options.env, options.platform, options.home),
      file = join(dir, 'registries.json');
    return { file, map: mappings(userBytes(file), file, (value) => absoluteOnly(dir, value)) };
  });
  const defaults = once(
    () =>
      new Map(
        Object.entries(DEFAULT_REGISTRIES).map(([key, value]) => [key, Object.freeze(parseRegistryBase(value, cwd))]),
      ),
  );
  const choose = (id: string): Level => {
    const provider = relabel(() => packageId(id), `Invalid distribution id ${id}: `).split('/')[0]!;
    const fixed = commandLine();
    if (fixed !== null) return fixed;
    const workspaceBase = pick(local(), provider);
    if (workspaceBase !== undefined) return { level: 'workspace', source: WORKSPACE_FILE, base: workspaceBase };
    const { file, map } = user(),
      userBase = pick(map, provider);
    if (userBase !== undefined) return { level: 'user', source: file, base: userBase };
    const fallback = defaults().get(provider);
    if (fallback !== undefined) return { level: 'default', source: 'built-in default', base: fallback };
    // The id is named too: a locked package, not only a requested one, can be the id that needs the provider.
    return fail(
      'REGISTRY-UNMAPPED',
      `No registry is configured for provider ${provider} (needed for ${id}); map it in ${WORKSPACE_FILE} or pass --registry`,
    );
  };
  return (id) => {
    const { level, source, base } = choose(id);
    return Object.freeze({ provider: id.split('/')[0]!, base, level, source });
  };
}
/** Registry spec §4 for one id; a command choosing for several ids uses one `registryChooser`. */
export const registryFor = (id: string, options: RegistryOptions): RegistryChoice => registryChooser(options)(id);
