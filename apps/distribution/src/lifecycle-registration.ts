import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { lifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import { createContextHookBinding } from '@inventarch/steward-hook/context';
import type { ContextHookBindingInput } from '@inventarch/steward-hook/context';
import { acquireHostRegistrationLock, assertHostRegistrationIdle, nodeCommand, verifyHostCache } from './host.js';
import { bytes, digest, fail, json, object, replace, sha256, utf8, workspace } from './files.js';
import { editJson, emptyJson, keptPaths, presentJson } from './json-edit.js';
import type { JsonPath } from './json-edit.js';

export type LifecycleRegistrationRequest =
  | { readonly cache: string; readonly binding: Omit<ContextHookBindingInput, 'implementation'> }
  | { readonly remove: string };
export interface LifecycleRegistrationPorts {
  implementation(cache: ReturnType<typeof verifyHostCache>): string;
}
interface Side {
  readonly config: string | null;
  readonly binding: string | null;
  readonly state: string | null;
}
interface State {
  readonly format: 'ia.lifecycle-registration-state.v1' | 'ia.lifecycle-registration-state.v2';
  readonly revision: number;
  readonly id: string;
  readonly cache: string;
  readonly release: string;
  readonly binding: string;
  readonly created: boolean;
  readonly groups: Readonly<Record<Event, Group>>;
  readonly existing?: readonly JsonPath[];
}
interface Group {
  readonly matcher?: string;
  readonly hooks: readonly {
    readonly type: 'command';
    readonly command: string;
    readonly args: readonly string[];
    readonly timeout: number;
  }[];
}
type Event = 'SessionStart' | 'UserPromptSubmit';
export interface LifecycleRegistrationPlan {
  readonly format: 'ia.lifecycle-registration-plan.v1';
  readonly root: string;
  readonly id: string;
  readonly request: LifecycleRegistrationRequest;
  readonly release: string | null;
  readonly before: {
    readonly config: string | null;
    readonly binding: string | null;
    readonly state: string | null;
    readonly nativeLock: string | null;
    readonly projectConfig: string | null;
  };
  readonly after: Side;
  readonly digest: string;
}
const area = '.ia/distributions/hosts',
  pendingPath = area + '/lifecycle-pending.json',
  configPath = '.claude/settings.local.json',
  projectPath = '.claude/settings.json';
const events = ['SessionStart', 'UserPromptSubmit'] as const;
/** Containers on the owned paths; those that predate the registration are retained as `existing` and never pruned. */
const containers: readonly JsonPath[] = [['hooks'], ...events.map((event) => ['hooks', event])];
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    fail('INPUT-INVALID', 'Invalid lifecycle registration identity');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail('INPUT-INVALID', 'Invalid lifecycle registration digest');
  return value;
};
const bindingPath = (id: string) => `${area}/claude-context-${identity(id)}.binding.json`;
const statePath = (id: string) => `${area}/claude-context-${identity(id)}.json`;
function read(root: string, path: string, maximum = 1024 * 1024): string | null {
  const value = bytes(root, path, maximum);
  return value === null ? null : utf8(value);
}
const pin = (value: string | null): string | null => (value === null ? null : sha256(value));
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INPUT-INVALID', 'Expected host settings object');
  return value as Record<string, unknown>;
}
/** Probe a verified emitted artifact. A caller-supplied digest string is never accepted as executable evidence. */
export function probeContextHookImplementation(cache: ReturnType<typeof verifyHostCache>): string {
  const result = spawnSync(process.execPath, [cache.launcher, 'context', 'identity'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal || Buffer.byteLength(result.stdout ?? '') > 4096)
    fail('HOST-UNSUPPORTED', 'Installed context identity probe failed');
  const row = object(decodeDistributionJson(result.stdout), [
      'format',
      'implementation',
      'profile',
      'slots',
      'characters',
    ]),
    profile = lifecycleProfile('claude-code', '2.1.278');
  if (
    row['format'] !== 'ia.context-hook-identity.v2' ||
    row['profile'] !== profile.digest ||
    row['slots'] !== profile.maxContextParts ||
    row['characters'] !== profile.maxContextCharacters
  )
    fail('HOST-UNSUPPORTED', 'Installed cache has no matching segmented context identity profile');
  return hash(row['implementation']);
}
const defaultPorts: LifecycleRegistrationPorts = { implementation: probeContextHookImplementation };
function groups(
  root: string,
  cache: string,
  id: string,
  timeout: number,
  segmented = true,
  command = nodeCommand(),
): Record<Event, Group> {
  const handler = {
    type: 'command' as const,
    command,
    args: [join(cache, 'scripts/ia.mjs'), 'context', '--root', root, '--binding', join(root, bindingPath(id))],
    timeout,
  };
  const hooks = segmented
    ? Array.from({ length: 12 }, (_, part) => ({ ...handler, args: [...handler.args, '--part', String(part)] }))
    : [handler];
  return { SessionStart: { matcher: 'startup|resume|clear|compact|fork', hooks }, UserPromptSubmit: { hooks } };
}
function saved(content: string | null, root: string, id: string): State | null {
  if (content === null) return null;
  const value = plain(decodeDistributionJson(content)),
    row = object(value, [
      'format',
      'revision',
      'id',
      'cache',
      'release',
      'binding',
      'created',
      'groups',
      ...(Object.hasOwn(value, 'existing') ? ['existing'] : []),
    ]);
  if (
    !['ia.lifecycle-registration-state.v1', 'ia.lifecycle-registration-state.v2'].includes(row['format'] as string) ||
    row['id'] !== id ||
    typeof row['cache'] !== 'string' ||
    !isAbsolute(row['cache']) ||
    typeof row['created'] !== 'boolean'
  )
    fail('INPUT-INVALID', 'Invalid lifecycle ownership state');
  if (!Number.isSafeInteger(row['revision']) || (row['revision'] as number) < 1)
    fail('INPUT-INVALID', 'Invalid lifecycle ownership revision');
  hash(row['release']);
  hash(row['binding']);
  keptPaths(row['existing'], containers);
  const owned = object(row['groups'], events);
  for (const event of events) {
    const group = object(owned[event], event === 'SessionStart' ? ['matcher', 'hooks'] : ['hooks']);
    if (
      !Array.isArray(group['hooks']) ||
      group['hooks'].length !== (row['format'] === 'ia.lifecycle-registration-state.v2' ? 12 : 1)
    )
      fail('INPUT-INVALID', 'Invalid owned hook group');
    const handler = object(group['hooks'][0], ['type', 'command', 'args', 'timeout']);
    if (
      !Number.isSafeInteger(handler['timeout']) ||
      (handler['timeout'] as number) < 1 ||
      (handler['timeout'] as number) > 62
    )
      fail('INPUT-INVALID', 'Invalid owned hook timeout');
    // The recorded Node is kept as written, as the guard's is, so a registration made under another Node (or before the Homebrew
    // `opt` link was recorded) is still owned and re-applying rewrites it; it must still be an absolute path (#323).
    const command = handler['command'];
    if (
      typeof command !== 'string' ||
      !isAbsolute(command) ||
      json(group) !==
        json(
          groups(
            root,
            row['cache'],
            id,
            handler['timeout'] as number,
            row['format'] === 'ia.lifecycle-registration-state.v2',
            command,
          )[event],
        )
    )
      fail('INPUT-INVALID', 'Owned context command differs from its fixed binding');
  }
  return row as unknown as State;
}
function current(root: string, id: string): Side {
  return {
    config: read(root, configPath),
    binding: read(root, bindingPath(id), 64 * 1024),
    state: read(root, statePath(id)),
  };
}
function collision(groups: unknown, target: string): boolean {
  if (!Array.isArray(groups)) fail('INPUT-INVALID', 'Expected hook group array');
  if (groups.length > 256) fail('LIMIT-EXCEEDED', 'Hook group inventory exceeds its bound');
  return groups.some((value) => {
    const row = plain(value);
    if (!Array.isArray(row['hooks']) || row['hooks'].length > 256)
      fail('INPUT-INVALID', 'Expected bounded hook handlers');
    return row['hooks'].some((value) => {
      const handler = plain(value);
      return Array.isArray(handler['args']) && handler['args'].includes(target);
    });
  });
}
/** Explicit project-only plan. Native/resource views stay live and are checked by each invocation. */
export function planLifecycleRegistration(
  rootInput: string,
  input: LifecycleRegistrationRequest,
  ports: LifecycleRegistrationPorts = defaultPorts,
): LifecycleRegistrationPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  const remove = Object.hasOwn(input, 'remove');
  object(input, remove ? ['remove'] : ['cache', 'binding']);
  const cache = remove ? null : verifyHostCache((input as { cache: string }).cache);
  if (cache && cache.host !== null && cache.host !== 'claude')
    fail('HOST-UNSUPPORTED', 'Lifecycle registration requires the supported Claude artifact');
  if (cache) {
    const path = relative(cache.directory, root);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
      fail('PATH-UNSAFE', 'Consumer root cannot be inside its immutable host cache');
  }
  const id = cache?.name ?? identity((input as { remove: string }).remove),
    before = current(root, id),
    prior = saved(before.state, root, id);
  if (!cache && !prior) fail('INPUT-INVALID', 'Lifecycle registration is not owned');
  if (prior ? pin(before.binding) !== prior.binding : before.binding !== null)
    fail('LOCAL-MODIFICATION', 'Context binding changed or collides with unmanaged metadata');
  const config = before.config === null ? {} : plain(decodeDistributionJson(before.config)),
    hooks = config['hooks'] === undefined ? {} : plain(config['hooks']);
  const projectText = read(root, projectPath),
    project = projectText === null ? {} : plain(decodeDistributionJson(projectText));
  if (
    cache &&
    (config['disableAllHooks'] === true ||
      (config['disableAllHooks'] === undefined && project['disableAllHooks'] === true))
  )
    fail('HOST-UNSUPPORTED', 'Project context hooks are explicitly disabled');
  let nextBinding: string | null = null,
    owned: Record<Event, Group> | null = null,
    request: LifecycleRegistrationRequest;
  if (cache) {
    const raw = (input as { binding: Omit<ContextHookBindingInput, 'implementation'> }).binding;
    if (Object.hasOwn(raw, 'implementation') || Object.hasOwn(raw, 'digest') || raw.root !== root)
      fail('INPUT-INVALID', 'Context selection must match the explicit root and cannot claim installed identity');
    const {
      implementation: _placeholder,
      digest: _placeholderDigest,
      ...snapshot
    } = createContextHookBinding({ ...raw, implementation: '0'.repeat(64) });
    const binding = createContextHookBinding({ ...snapshot, implementation: hash(ports.implementation(cache)) });
    nextBinding = json(binding);
    const { implementation: _implementation, digest: _digest, ...retained } = binding;
    request = { cache: cache.directory, binding: retained };
    owned = groups(root, cache.directory, id, Math.ceil(binding.budgets.timeoutMs / 1000) + 2);
  } else request = { remove: id };
  const target = join(root, bindingPath(id)),
    existing = prior ? keptPaths(prior.existing, containers) : presentJson(before.config, containers);
  let edited: string | null = before.config;
  for (const event of events) {
    const rows = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(rows)) fail('INPUT-INVALID', 'Expected hook event array');
    const matching = prior
      ? rows.map((row, at) => (json(row) === json(prior.groups[event]) ? at : -1)).filter((at) => at >= 0)
      : [];
    if (prior && matching.length !== 1)
      fail('LOCAL-MODIFICATION', 'Owned lifecycle hook group changed or was duplicated');
    const remaining = rows.filter((_row, at) => !matching.includes(at));
    if (collision(remaining, target))
      fail('LOCAL-MODIFICATION', 'Lifecycle hook collides with an unmanaged context binding');
    const projectHooks = project['hooks'] === undefined ? {} : plain(project['hooks']);
    if (projectHooks[event] !== undefined && collision(projectHooks[event], target))
      fail('LOCAL-MODIFICATION', 'Context binding already appears in project settings');
    // In place (spec §5.1): replace or append the owned group, or remove it by index; every other byte is kept.
    edited = editJson(edited, ['hooks', event, prior ? matching[0]! : -1], owned ? owned[event] : undefined, existing);
  }
  const nextConfig = prior?.created && emptyJson(edited!) ? null : edited;
  const revision = (prior?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) fail('LIMIT-EXCEEDED', 'Lifecycle ownership revision is exhausted');
  const after: Side = {
    config: nextConfig,
    binding: nextBinding,
    state: cache
      ? json({
          format: 'ia.lifecycle-registration-state.v2',
          revision,
          id,
          cache: cache.directory,
          release: cache.release,
          binding: pin(nextBinding),
          created: prior?.created ?? before.config === null,
          groups: owned,
          ...(existing.length ? { existing } : {}),
        })
      : null,
  };
  if (
    Buffer.byteLength(after.config ?? '') > 1024 * 1024 ||
    Buffer.byteLength(after.binding ?? '') > 64 * 1024 ||
    Buffer.byteLength(after.state ?? '') > 1024 * 1024
  )
    fail('LIMIT-EXCEEDED', 'Lifecycle registration exceeds its publication bounds');
  if (cache && verifyHostCache(cache.directory).release !== cache.release)
    fail('PLAN-STALE', 'Host cache changed during context planning');
  const body = {
    format: 'ia.lifecycle-registration-plan.v1' as const,
    root,
    id,
    request,
    release: cache?.release ?? null,
    before: {
      config: pin(before.config),
      binding: pin(before.binding),
      state: pin(before.state),
      nativeLock: pin(read(root, '.ia/distributions.lock.json', 4 * 1024 * 1024)),
      projectConfig: pin(projectText),
    },
    after,
  };
  return { ...body, digest: digest(body) };
}
function same(root: string, id: string, side: Side): void {
  if (json(current(root, id)) !== json(side))
    fail('LOCAL-MODIFICATION', 'Context configuration or ownership changed during publication');
}
function write(root: string, path: string, content: string | null): void {
  replace(root, path, content === null ? null : Buffer.from(content));
}
export function applyLifecycleRegistration(
  input: unknown,
  ports: LifecycleRegistrationPorts = defaultPorts,
  checkpoint: (stage: string) => void = () => {},
): { status: 'lifecycle-registered' | 'lifecycle-removed'; id: string; delivery: 'unconfirmed' } {
  const row = object(input, ['format', 'root', 'id', 'request', 'release', 'before', 'after', 'digest']);
  if (row['format'] !== 'ia.lifecycle-registration-plan.v1' || typeof row['root'] !== 'string')
    fail('INPUT-INVALID', 'Invalid lifecycle registration plan');
  const root = workspace(row['root']),
    id = identity(row['id']),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planLifecycleRegistration(root, row['request'] as LifecycleRegistrationRequest, ports);
    if (json(plan) !== json(input)) fail('PLAN-STALE', 'Lifecycle plan no longer matches its current inputs');
    const before = current(root, id);
    write(root, pendingPath, json({ format: 'ia.lifecycle-registration-pending.v1', id, before, after: plan.after }));
    checkpoint('pending');
    same(root, id, before);
    write(root, bindingPath(id), plan.after.binding);
    checkpoint('binding');
    same(root, id, { ...before, binding: plan.after.binding });
    write(root, configPath, plan.after.config);
    checkpoint('config');
    same(root, id, { ...before, binding: plan.after.binding, config: plan.after.config });
    if (
      pin(read(root, '.ia/distributions.lock.json', 4 * 1024 * 1024)) !== plan.before.nativeLock ||
      pin(read(root, projectPath)) !== plan.before.projectConfig ||
      ('cache' in plan.request && verifyHostCache(plan.request.cache).release !== plan.release)
    )
      fail('PLAN-STALE', 'Native lock, project settings or host cache changed before registration commit');
    write(root, statePath(id), plan.after.state);
    checkpoint('state');
    write(root, pendingPath, null);
    checkpoint('complete');
    return {
      status: 'cache' in plan.request ? 'lifecycle-registered' : 'lifecycle-removed',
      id,
      delivery: 'unconfirmed',
    };
  } finally {
    unlock();
  }
}
export function recoverLifecycleRegistration(rootInput: string): { status: 'lifecycle-recovered' | 'current' } {
  const root = workspace(rootInput),
    unlock = acquireHostRegistrationLock(root, true);
  try {
    if (read(root, area + '/pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-host for pending MCP registration');
    if (read(root, area + '/guard-pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-guard for the pending guard registration');
    const content = read(root, pendingPath, 8 * 1024 * 1024);
    if (content === null) return { status: 'current' };
    const row = object(decodeDistributionJson(content), ['format', 'id', 'before', 'after']);
    if (row['format'] !== 'ia.lifecycle-registration-pending.v1')
      fail('INPUT-INVALID', 'Unknown context recovery format');
    const id = identity(row['id']);
    const side = (value: unknown): Side => {
      const data = object(value, ['config', 'binding', 'state']);
      for (const key of ['config', 'binding', 'state'])
        if (
          !(
            data[key] === null ||
            (typeof data[key] === 'string' &&
              Buffer.byteLength(data[key]) <= (key === 'binding' ? 64 * 1024 : 1024 * 1024))
          )
        )
          fail('INPUT-INVALID', 'Invalid context recovery bytes');
      const result = data as unknown as Side,
        prior = saved(result.state, root, id);
      if (prior ? pin(result.binding) !== prior.binding : result.binding !== null)
        fail('INPUT-INVALID', 'Recovery binding differs from retained ownership');
      if (result.config !== null) plain(decodeDistributionJson(result.config));
      return result;
    };
    const before = side(row['before']),
      after = side(row['after']),
      actual = current(root, id);
    if (
      ![before.config, after.config].includes(actual.config) ||
      ![before.binding, after.binding].includes(actual.binding) ||
      ![before.state, after.state].includes(actual.state)
    )
      fail('LOCAL-MODIFICATION', 'Unexpected local context edit must be reconciled');
    const desired = actual.state === after.state ? after : before;
    write(root, bindingPath(id), desired.binding);
    write(root, configPath, desired.config);
    write(root, statePath(id), desired.state);
    write(root, pendingPath, null);
    return { status: 'lifecycle-recovered' };
  } finally {
    unlock();
  }
}
