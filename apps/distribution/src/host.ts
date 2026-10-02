import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeDistributionJson, platformDebris } from '@ia/db/distribution';
import {
  bytes,
  contained,
  digest,
  fail,
  json,
  locate,
  object,
  portable,
  replace,
  sha256,
  syncDirectory,
  unaliased,
  utf8,
  workspace,
} from './files.js';
import { reconcileConfig } from './config.js';
import { editJson, emptyJson, keptPaths, presentJson } from './json-edit.js';
import type { JsonPath } from './json-edit.js';
import type { Stats } from 'node:fs';
import type { WorkspaceHost as Host } from './hosts.js';
import { asWorkspaceHost } from './hosts.js';

interface Cache {
  directory: string;
  release: string;
  name: string;
  host: Host | null;
  launcher: string;
  format: 1 | 2;
}
/** What the pure planners need of a cache: a verified one, or the v2 payload a caller is about to materialize. */
export type HostCacheTarget = Pick<Cache, 'directory' | 'release' | 'name' | 'host' | 'launcher'>;
interface State {
  format: 'ia.host-state.v1';
  host: Host;
  id: string;
  cache: string;
  release: string;
  owned: string;
  created: boolean;
  existing?: readonly JsonPath[];
}
export interface HostPlan {
  format: 'ia.host-plan.v1';
  root: string;
  host: Host;
  id: string;
  operation: 'activate' | 'remove';
  cache: string | null;
  release: string | null;
  before: { config: string | null; state: string | null; nativeLock: string | null };
  after: { config: string | null; state: string | null };
  digest: string;
}
interface Pending {
  format: 'ia.host-pending.v1';
  host: Host;
  id: string;
  before: { config: string | null; state: string | null };
  after: { config: string | null; state: string | null };
}
const area = '.ia/distributions/hosts',
  pendingFile = area + '/pending.json',
  lockFile = area + '/lock.json';
const asHost = (v: unknown): Host => asWorkspaceHost(v);
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v))
    fail('INPUT-INVALID', 'Invalid host registration identifier');
  return v;
};
const hash = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('INPUT-INVALID', 'Invalid host release pin');
  return v;
};
const stateFile = (host: Host, name: string): string => `${area}/${host}-${id(name)}.json`;
/** The Claude container on the owned path; retained as `existing` when it predates the registration and never pruned. */
const containers: readonly JsonPath[] = [['mcpServers']];
/**
 * Spec §4: each workspace host's MCP configuration file and its format. Keyed by `WorkspaceHost`, so a new workspace
 * row in hosts.ts does not compile until it has an entry here, instead of taking another host's file or format.
 */
export const HOST_CONFIG: Readonly<Record<Host, { readonly file: string; readonly format: 'json' | 'toml' }>> = {
  claude: { file: '.mcp.json', format: 'json' },
  codex: { file: '.codex/config.toml', format: 'toml' },
};
const configFile = (host: Host): string => HOST_CONFIG[host].file;
/** Spec §5.1: one registration id per workspace and host for the v2 consumer payload. */
export const HOST_REGISTRATION = 'workspace';
/** REQ-HRC-2: the only constructor of an IA server's command and arguments, durable or ephemeral. */
export function doorServer(entrypoint: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: nodeCommand(), args: [entrypoint, ...args] };
}
/** The owned MCP text `planHostWith` records and writes for one server: Claude's canonical entry, or Codex's TOML role. */
function ownedText(host: Host, name: string, server: { command: string; args: readonly string[] }): string {
  return HOST_CONFIG[host].format === 'toml'
    ? `[mcp_servers.${JSON.stringify('ia-' + name)}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`
    : json(server);
}
/**
 * The Node executable a registration recorded, as it reads now: an absolute path that is a file, whatever the file is called
 * (Fedora's Node is `/usr/bin/node-22`), as the context groups accept it. Anything else is not what `doorServer` writes
 * (`modified`); a well-formed path with nothing there is `missing`, which re-applying repairs by recording the running Node.
 */
export function recordedNode(command: unknown): 'ok' | 'modified' | 'missing' {
  if (typeof command !== 'string' || !isAbsolute(command)) return 'modified';
  try {
    return statSync(command).isFile() ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}
/**
 * The recorded server's command when the state's `owned` text is exactly the one `planHostWith` derives for that
 * state's own cache and this root, with the recorded command kept as written; null otherwise. The ownership shape
 * alone (`saved`) cannot tell a forged state, whose owned entry runs an arbitrary command, from a real one.
 */
export function derivedCommand(state: Pick<State, 'host' | 'id' | 'cache' | 'owned'>, root: string): string | null {
  let command: unknown;
  try {
    if (state.host === 'claude') command = plain(decodeDistributionJson(state.owned))['command'];
    else {
      const found = /^\[mcp_servers\."[a-z0-9-]+"\]\ncommand = ("(?:[^"\\\n]|\\.)*")\n/.exec(state.owned);
      command = found === null ? null : JSON.parse(found[1]!);
    }
  } catch {
    return null;
  }
  if (typeof command !== 'string') return null;
  const { args } = doorServer(join(state.cache, 'scripts/ia.mjs'), ['mcp', '--root', root]);
  return ownedText(state.host, state.id, { command, args }) === state.owned ? command : null;
}
const text = (value: Buffer | null): string | null => (value === null ? null : utf8(value));
const pin = (value: string | null): string | null => (value === null ? null : sha256(value));
function read(root: string, path: string, limit = 1024 * 1024): string | null {
  return text(bytes(root, path, limit));
}
/** `work`'s bytes, or null when the file is gone by the time it is read, as `bytes` reports a missing file. */
function present(work: () => Buffer): Buffer | null {
  try {
    return work();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INPUT-INVALID', 'Expected host metadata object');
  return value as Record<string, unknown>;
}
/** Exported for `host-observe.ts`: the one real ownership-shape validator for `{host}-workspace.json`, reused rather than duplicated so observation can never drift from what `planHost`/`applyHost` themselves accept. */
export function saved(value: string | null, host: Host, name: string): State | null {
  if (value === null) return null;
  const data = plain(decodeDistributionJson(value)),
    row = object(data, [
      'format',
      'host',
      'id',
      'cache',
      'release',
      'owned',
      'created',
      ...(Object.hasOwn(data, 'existing') ? ['existing'] : []),
    ]);
  if (
    row['format'] !== 'ia.host-state.v1' ||
    row['host'] !== host ||
    row['id'] !== name ||
    typeof row['cache'] !== 'string' ||
    typeof row['owned'] !== 'string' ||
    typeof row['created'] !== 'boolean'
  )
    fail('INPUT-INVALID', 'Malformed host ownership state');
  hash(row['release']);
  keptPaths(row['existing'], containers);
  return row as unknown as State;
}
/** Verify the whole selected artifact before installing a command that can launch it. */
export function verifyHostCache(input: string): Cache {
  const directory = workspace(input),
    releaseBytes = read(directory, 'release.json');
  if (releaseBytes === null) fail('ARTIFACT-UNAVAILABLE', 'Missing host release');
  const release = object(decodeDistributionJson(releaseBytes), ['format', 'inventory', 'launcher']),
    v2 = release['format'] === 'ia.host-release.v2';
  if (!v2 && release['format'] !== 'ia.host-release.v1') fail('INPUT-INVALID', 'Unknown host release');
  const inventoryText = read(directory, 'inventory.json', 4 * 1024 * 1024),
    launcher = bytes(directory, 'scripts/ia.mjs');
  if (
    inventoryText === null ||
    !launcher ||
    sha256(inventoryText) !== hash(release['inventory']) ||
    sha256(launcher) !== hash(release['launcher'])
  )
    fail('INTEGRITY-MISMATCH', 'Host release inventory/launcher changed');
  const inventory = object(
    decodeDistributionJson(inventoryText),
    v2
      ? ['format', 'version', 'packages', 'files']
      : ['format', 'host', 'name', 'version', 'native', 'packages', 'files'],
  );
  if (
    inventory['format'] !== (v2 ? 'ia.host-cache.v2' : 'ia.host-cache.v1') ||
    typeof inventory['version'] !== 'string' ||
    inventory['version'].length > 128 ||
    !Array.isArray(inventory['packages']) ||
    inventory['packages'].length > 64 ||
    !Array.isArray(inventory['files']) ||
    inventory['files'].length > 10000
  )
    fail('INPUT-INVALID', 'Invalid host cache inventory');
  if (!v2) hash(inventory['native']);
  const host = v2 ? null : asHost(inventory['host']),
    name = v2 ? HOST_REGISTRATION : id(inventory['name']),
    expected = new Map<string, { bytes: number; hash: string }>(),
    folded = new Set<string>();
  let total = 0;
  /** v1 names that would share a state file with the guard, context, v2 or projection registrations; removal of an existing id stays open. */
  if (!v2 && (/^(?:context|guard)-/.test(name) || ['workspace', 'projection'].includes(name)))
    fail('HOST-UNSUPPORTED', 'Reserved host registration name');
  const packageNames = new Set<string>();
  for (const entry of inventory['packages']) {
    const pkg = object(entry, ['name', 'version', 'manifestDigest', 'license', 'notices']);
    if (
      typeof pkg['name'] !== 'string' ||
      !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg['name']) ||
      packageNames.has(pkg['name']) ||
      typeof pkg['version'] !== 'string' ||
      pkg['version'].length > 128 ||
      typeof pkg['license'] !== 'string' ||
      pkg['license'].length > 1024 ||
      !Array.isArray(pkg['notices']) ||
      pkg['notices'].length > 64
    )
      fail('INPUT-INVALID', 'Invalid host runtime package');
    packageNames.add(pkg['name']);
    hash(pkg['manifestDigest']);
    for (const notice of pkg['notices']) {
      if (typeof notice !== 'string') fail('INPUT-INVALID', 'Invalid notice path');
      portable(notice);
    }
  }
  for (const item of inventory['files']) {
    const file = object(item, ['path', 'bytes', 'sha256']);
    if (
      typeof file['path'] !== 'string' ||
      !Number.isSafeInteger(file['bytes']) ||
      (file['bytes'] as number) < 0 ||
      (file['bytes'] as number) > 64 * 1024 * 1024
    )
      fail('INPUT-INVALID', 'Invalid host payload file');
    const path = portable(file['path']);
    if (['release.json', 'inventory.json', 'scripts/ia.mjs'].includes(path) || folded.has(path.toLowerCase()))
      fail('PATH-UNSAFE', 'Host payload paths collide');
    folded.add(path.toLowerCase());
    expected.set(path, { bytes: file['bytes'] as number, hash: hash(file['sha256']) });
  }
  let entries = 0;
  /**
   * One lstat per entry, not a walk to the volume root per file (LKI-33). `workspace` refused a link at `directory` and at
   * every ancestor of it, and the walk descends only into an entry its own lstat reports as a directory, which a link or
   * junction never is; so refusing a link at each entry keeps every level link-free, and a payload file is read on the
   * lstat that admitted it. Each directory is lstat'd again once its entries are read, and `directory` with its
   * ancestors once after the walk, so a directory swapped for a link mid-walk is refused as one found on entry would be.
   */
  const linkFree = (target: string, stat: Stats = lstatSync(target)): Stats => {
    if (stat.isSymbolicLink()) fail('PATH-UNSAFE', `Link/junction is not allowed: ${target}`);
    return stat;
  };
  const visit = (relative = '', depth = 0): void => {
    if (depth > 32) fail('LIMIT-EXCEEDED', 'Host cache directory depth exceeds 32');
    const folder = join(directory, ...relative.split('/'));
    for (const entry of readdirSync(folder)) {
      if (++entries > 20000) fail('LIMIT-EXCEEDED', 'Host cache filesystem inventory exceeds its bound');
      const path = portable(relative ? relative + '/' + entry : entry),
        target = join(folder, entry),
        stat = linkFree(target);
      if (stat.isDirectory()) visit(path, depth + 1);
      else {
        if (['release.json', 'inventory.json', 'scripts/ia.mjs'].includes(path)) continue;
        const file = expected.get(path);
        if (!file && stat.isFile() && platformDebris(entry)) continue;
        if (!file || stat.size !== file.bytes || (total += file.bytes) > 256 * 1024 * 1024)
          fail('INTEGRITY-MISMATCH', 'Unexpected host payload');
        const content = present(() => unaliased(target, path, stat, 64 * 1024 * 1024));
        if (!content || sha256(content) !== file.hash) fail('INTEGRITY-MISMATCH', 'Host payload changed');
        expected.delete(path);
      }
    }
    if (relative) linkFree(folder);
  };
  visit();
  contained(directory);
  if (expected.size) fail('ARTIFACT-UNAVAILABLE', 'Host payload is incomplete');
  return {
    directory,
    release: sha256(releaseBytes),
    host,
    name,
    launcher: join(directory, 'scripts/ia.mjs'),
    format: v2 ? 2 : 1,
  };
}
export function assertHostRegistrationIdle(root: string): void {
  if (
    read(root, pendingFile, 8 * 1024 * 1024) !== null ||
    read(root, area + '/lifecycle-pending.json', 8 * 1024 * 1024) !== null ||
    read(root, area + '/guard-pending.json', 8 * 1024 * 1024) !== null
  )
    fail(
      'RECOVERY-REQUIRED',
      'Run recover-host, recover-lifecycle or recover-guard before changing host registrations',
    );
}
/** An absolute path with its existing prefix resolved as `workspace()` resolves it, so an expected directory equals the verified one once it exists. */
function settled(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(contained(head)), ...tail);
}
/**
 * The v2 payload a caller will materialize at `directory` with release digest `release`, described without reading it.
 * Planning against it yields the plan `planHost` yields once that payload exists there and verifies; apply always
 * re-plans with verification, so an expectation never reaches a written registration unverified.
 */
export function expectedHostCache(directory: string, release: string): HostCacheTarget {
  if (!isAbsolute(directory)) fail('INPUT-INVALID', 'An absolute host cache directory is required');
  const settledDirectory = settled(directory);
  return {
    directory: settledDirectory,
    release: hash(release),
    name: HOST_REGISTRATION,
    host: null,
    launcher: join(settledDirectory, 'scripts/ia.mjs'),
  };
}
/** Descriptive plan: configuration and ownership bytes are always rederived on apply. */
export function planHost(rootInput: string, hostInput: Host, cacheInput: string | null, removeId?: string): HostPlan {
  const root = workspace(rootInput),
    host = asHost(hostInput);
  assertHostRegistrationIdle(root);
  return planHostWith(root, host, cacheInput === null ? null : verifyHostCache(cacheInput), removeId);
}
/** `planHost` against an expected, unverified cache (`expectedHostCache`), or against none for a removal. Never reads the cache. */
export function planHostFor(
  rootInput: string,
  hostInput: Host,
  expected: HostCacheTarget | null,
  removeId?: string,
): HostPlan {
  const root = workspace(rootInput),
    host = asHost(hostInput);
  assertHostRegistrationIdle(root);
  return planHostWith(root, host, expected, removeId);
}
function planHostWith(root: string, host: Host, cache: HostCacheTarget | null, removeId?: string): HostPlan {
  if (cache && cache.host !== null && cache.host !== host)
    fail('HOST-UNSUPPORTED', 'Host artifact targets a different host');
  if (cache) {
    const path = relative(cache.directory, root);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
      fail('PATH-UNSAFE', 'Consumer workspace cannot be inside the immutable plugin cache');
  }
  const name = cache ? cache.name : id(removeId),
    currentState = locate(stateFile(host, name), () => read(root, stateFile(host, name))),
    prior = locate(stateFile(host, name), () => saved(currentState, host, name)),
    current = read(root, configFile(host));
  if (!cache && !prior) fail('INPUT-INVALID', 'Host registration is not owned');
  const key = 'ia-' + name,
    server = cache ? doorServer(cache.launcher, ['mcp', '--root', root]) : null;
  let next: string | null,
    owned: string,
    existing: JsonPath[] = [];
  if (HOST_CONFIG[host].format === 'toml') {
    owned = server ? ownedText(host, name, server) : '';
    // A removal whose owned block the user already deleted (neither marker remains) removes only the ownership state.
    const gone =
      !server &&
      prior !== null &&
      !(current ?? '').includes(`# BEGIN IA PROJECTION host-${name}\n`) &&
      !(current ?? '').includes(`# END IA PROJECTION host-${name}\n`);
    next = gone
      ? current
      : reconcileConfig(current ?? '', 'host-' + name, prior?.owned ?? null, server ? owned : null, 'mcp_servers');
    if (!gone && next === '' && prior?.created) next = null;
  } else {
    const config = current === null ? {} : plain(decodeDistributionJson(current)),
      servers = config['mcpServers'] === undefined ? {} : plain(config['mcpServers']);
    // A removal whose owned entry the user already deleted removes only the ownership state; every other shape is checked.
    const gone = !server && prior !== null && !Object.hasOwn(servers, key);
    if (!gone && (prior ? json(servers[key]) !== prior.owned : Object.hasOwn(servers, key)))
      fail('LOCAL-MODIFICATION', 'MCP registration changed or collides with an unmanaged server');
    // In place (spec §5.1): only the owned member changes; every other byte of the file is kept.
    existing = prior ? keptPaths(prior.existing, containers) : presentJson(current, containers);
    if (gone) next = current;
    else {
      next = editJson(current, ['mcpServers', key], server ?? undefined, existing);
      if (prior?.created && emptyJson(next)) next = null;
    }
    owned = server ? ownedText(host, name, server) : '';
  }
  const afterState = cache
    ? json({
        format: 'ia.host-state.v1',
        host,
        id: name,
        cache: cache.directory,
        release: cache.release,
        owned,
        created: prior?.created ?? current === null,
        ...(existing.length ? { existing } : {}),
      })
    : null;
  if (Buffer.byteLength(next ?? '') > 1024 * 1024) fail('LIMIT-EXCEEDED', 'Host configuration exceeds 1 MiB');
  const body = {
    format: 'ia.host-plan.v1' as const,
    root,
    host,
    id: name,
    operation: cache ? ('activate' as const) : ('remove' as const),
    cache: cache?.directory ?? null,
    release: cache?.release ?? null,
    before: {
      config: pin(current),
      state: pin(currentState),
      nativeLock: pin(read(root, '.ia/distributions.lock.json', 4 * 1024 * 1024)),
    },
    after: { config: next, state: afterState },
  };
  return { ...body, digest: digest(body) };
}
export function acquireHostRegistrationLock(root: string, recovery = false): () => void {
  const target = contained(root, lockFile);
  mkdirSync(dirname(target), { recursive: true });
  if (recovery && existsSync(target)) {
    const row = object(decodeDistributionJson(read(root, lockFile)!), ['pid']);
    if (!Number.isSafeInteger(row['pid']) || (row['pid'] as number) <= 0) fail('INSTALL-BUSY', 'Invalid host lock');
    try {
      process.kill(row['pid'] as number, 0);
      fail('INSTALL-BUSY', 'Host transaction is still running');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    unlinkSync(target);
  }
  let fd: number;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch {
    return fail('INSTALL-BUSY', 'Another host transaction holds the lock');
  }
  try {
    writeFileSync(fd, json({ pid: process.pid }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    unlinkSync(target);
    syncDirectory(dirname(target));
  };
}
function same(root: string, path: string, expected: string | null): void {
  if (read(root, path) !== expected) fail('LOCAL-MODIFICATION', 'Host configuration/state changed during transaction');
}
export function applyHost(
  value: unknown,
  checkpoint: (name: string) => void = () => {},
): { status: 'host-active' | 'host-removed'; id: string; host: Host } {
  const input = object(value, [
    'format',
    'root',
    'host',
    'id',
    'operation',
    'cache',
    'release',
    'before',
    'after',
    'digest',
  ]);
  if (
    input['format'] !== 'ia.host-plan.v1' ||
    typeof input['root'] !== 'string' ||
    !(input['cache'] === null || typeof input['cache'] === 'string')
  )
    fail('INPUT-INVALID', 'Invalid host plan');
  const root = workspace(input['root']),
    host = asHost(input['host']),
    name = id(input['id']),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planHost(root, host, input['cache'], name);
    if (json(plan) !== json(value)) fail('PLAN-STALE', 'Host plan no longer matches selected inputs');
    const before = { config: read(root, configFile(host)), state: read(root, stateFile(host, name)) },
      pending: Pending = { format: 'ia.host-pending.v1', host, id: name, before, after: plan.after };
    replace(root, pendingFile, Buffer.from(json(pending)));
    checkpoint('pending');
    same(root, configFile(host), before.config);
    same(root, stateFile(host, name), before.state);
    replace(root, configFile(host), plan.after.config === null ? null : Buffer.from(plan.after.config));
    checkpoint('config');
    same(root, configFile(host), plan.after.config);
    same(root, stateFile(host, name), before.state);
    if (
      (plan.cache && verifyHostCache(plan.cache).release !== plan.release) ||
      pin(read(root, '.ia/distributions.lock.json', 4 * 1024 * 1024)) !== plan.before.nativeLock
    )
      fail('PLAN-STALE', 'Host cache or native lock changed before activation');
    replace(root, stateFile(host, name), plan.after.state === null ? null : Buffer.from(plan.after.state));
    checkpoint('state');
    replace(root, pendingFile, null);
    checkpoint('complete');
    return { status: plan.operation === 'activate' ? 'host-active' : 'host-removed', id: name, host };
  } finally {
    unlock();
  }
}
export function recoverHost(rootInput: string): { status: 'host-recovered' | 'current' } {
  const root = workspace(rootInput),
    unlock = acquireHostRegistrationLock(root, true);
  try {
    if (read(root, area + '/lifecycle-pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-lifecycle for the pending context registration');
    if (read(root, area + '/guard-pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-guard for the pending guard registration');
    const content = read(root, pendingFile, 8 * 1024 * 1024);
    if (content === null) return { status: 'current' };
    const row = object(decodeDistributionJson(content), ['format', 'host', 'id', 'before', 'after']);
    if (row['format'] !== 'ia.host-pending.v1') fail('INPUT-INVALID', 'Unknown host recovery');
    const host = asHost(row['host']),
      name = id(row['id']);
    const side = (value: unknown): Pending['before'] => {
      const s = object(value, ['config', 'state']);
      for (const v of Object.values(s))
        if (!(v === null || (typeof v === 'string' && Buffer.byteLength(v) <= 1024 * 1024)))
          fail('INPUT-INVALID', 'Invalid host recovery bytes');
      saved(s['state'] as string | null, host, name);
      return s as unknown as Pending['before'];
    };
    const before = side(row['before']),
      after = side(row['after']),
      currentConfig = read(root, configFile(host)),
      currentState = read(root, stateFile(host, name));
    if (![before.config, after.config].includes(currentConfig) || ![before.state, after.state].includes(currentState))
      fail('LOCAL-MODIFICATION', 'Unexpected host edit must be reconciled');
    const desired = currentState === after.state ? after : before;
    replace(root, configFile(host), desired.config === null ? null : Buffer.from(desired.config));
    replace(root, stateFile(host, name), desired.state === null ? null : Buffer.from(desired.state));
    replace(root, pendingFile, null);
    return { status: 'host-recovered' };
  } finally {
    unlock();
  }
}
/**
 * The Node executable a registration records: the running one, except that a Homebrew keg's versioned path
 * (`<prefix>/Cellar/<formula>/<version>/bin/node`), which `brew upgrade` and cleanup delete, is recorded as the formula's
 * stable `<prefix>/opt/<formula>/bin/node` link while that link reaches the same executable (#323).
 */
export function nodeCommand(execPath: string = process.execPath): string {
  const keg = /^(.+)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/](node(?:\.exe)?)$/.exec(execPath);
  if (keg === null) return execPath;
  const stable = join(keg[1]!, 'opt', keg[2]!, 'bin', keg[3]!);
  try {
    return realpathSync(stable) === realpathSync(execPath) ? stable : execPath;
  } catch {
    return execPath;
  }
}
