import { isAbsolute, join, relative, sep } from 'node:path';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import {
  acquireHostRegistrationLock,
  assertHostRegistrationIdle,
  doorServer,
  HOST_REGISTRATION,
  verifyHostCache,
} from './host.js';
import type { HostCacheTarget } from './host.js';
import { bytes, digest, fail, json, locate, object, replace, sha256, utf8, workspace } from './files.js';
import { editJson, emptyJson, keptPaths, presentJson } from './json-edit.js';
import type { JsonPath } from './json-edit.js';

const area = '.ia/distributions/hosts',
  pendingPath = area + '/guard-pending.json',
  configPath = '.claude/settings.local.json',
  projectPath = '.claude/settings.json';
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    fail('INPUT-INVALID', 'Invalid guard registration identity');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail('INPUT-INVALID', 'Invalid guard registration digest');
  return value;
};
const statePath = (id: string): string => `${area}/claude-guard-${identity(id)}.json`;
/** Containers on the owned path; those that existed before the first apply are retained as `existing` and never pruned. */
const containers: readonly JsonPath[] = [['hooks'], ['hooks', 'PreToolUse']];
const GUARD_MATCHER = 'Write|Edit|MultiEdit';
export type GuardRequest = { readonly cache: string } | { readonly remove: string };
interface Side {
  readonly config: string | null;
  readonly state: string | null;
}
interface Group {
  readonly matcher: string;
  readonly hooks: readonly {
    readonly type: 'command';
    readonly command: string;
    readonly args: readonly string[];
    readonly timeout: number;
  }[];
}
interface State {
  readonly format: 'ia.guard-registration-state.v1';
  readonly id: string;
  readonly cache: string;
  readonly release: string;
  readonly created: boolean;
  readonly group: Group;
  readonly existing?: readonly JsonPath[];
}
export interface GuardPlan {
  readonly format: 'ia.guard-registration-plan.v1';
  readonly root: string;
  readonly id: string;
  readonly request: GuardRequest;
  readonly release: string | null;
  readonly before: {
    readonly config: string | null;
    readonly state: string | null;
    readonly projectConfig: string | null;
  };
  readonly after: Side;
  readonly digest: string;
}
const read = (root: string, path: string, limit = 1024 * 1024): string | null => {
  const value = bytes(root, path, limit);
  return value === null ? null : utf8(value);
};
const pin = (value: string | null): string | null => (value === null ? null : sha256(value));
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INPUT-INVALID', 'Expected host settings object');
  return value as Record<string, unknown>;
}
/** Spec §5.1: explicit root, not claude-guard's CLAUDE_PROJECT_DIR, so the recorded root is the one run; on POSIX through `/bin/sh`, so a guard that cannot run denies (`FAIL_CLOSED`). */
export function guardGroup(launcher: string, root: string, platform: NodeJS.Platform = process.platform): Group {
  const server = doorServer(launcher, ['guard', '--root', root]);
  return {
    matcher: GUARD_MATCHER,
    hooks: [
      {
        type: 'command',
        ...(platform === 'win32'
          ? server
          : { command: '/bin/sh', args: ['-c', FAIL_CLOSED, server.command, ...server.args] }),
        timeout: 10,
      },
    ],
  };
}
/**
 * The retained group must be the fixed guard derivation for its cache and root, in either form (`guardNode`); the
 * recorded Node executable is kept as written. Exported for `host-observe.ts`, which reuses this real validator rather than a weaker local
 * copy so observation can never drift from what `planGuardRegistration`/`applyGuardRegistration` themselves accept.
 */
export function saved(content: string | null, root: string, id: string): State | null {
  if (content === null) return null;
  const value = plain(decodeDistributionJson(content)),
    row = object(value, [
      'format',
      'id',
      'cache',
      'release',
      'created',
      'group',
      ...(Object.hasOwn(value, 'existing') ? ['existing'] : []),
    ]);
  if (
    row['format'] !== 'ia.guard-registration-state.v1' ||
    row['id'] !== id ||
    typeof row['cache'] !== 'string' ||
    !isAbsolute(row['cache']) ||
    typeof row['created'] !== 'boolean'
  )
    fail('INPUT-INVALID', 'Invalid guard ownership state');
  hash(row['release']);
  const group = object(row['group'], ['matcher', 'hooks']);
  if (group['matcher'] !== GUARD_MATCHER || !Array.isArray(group['hooks']) || group['hooks'].length !== 1)
    fail('INPUT-INVALID', 'Invalid owned guard hook group');
  const handler = object(group['hooks'][0], ['type', 'command', 'args', 'timeout']),
    launcher = join(row['cache'], 'scripts/ia.mjs'),
    node = guardNode(handler, launcher, root);
  if (
    handler['type'] !== 'command' ||
    typeof node !== 'string' ||
    !isAbsolute(node) ||
    handler['timeout'] !== guardGroup(launcher, root).hooks[0]!.timeout
  )
    fail('INPUT-INVALID', 'Owned guard command differs from its fixed root');
  keptPaths(row['existing'], containers);
  return row as unknown as State;
}
export function planGuardRegistration(rootInput: string, request: GuardRequest): GuardPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  const remove = Object.hasOwn(plain(request), 'remove');
  object(request, remove ? ['remove'] : ['cache']);
  return planGuardWith(
    root,
    remove ? null : verifyHostCache((request as { cache: string }).cache),
    remove ? (request as { remove: string }).remove : null,
  );
}
/** `planGuardRegistration` against an expected, unverified cache (`expectedHostCache`); never reads the cache. Apply re-plans with verification. */
export function planGuardFor(rootInput: string, expected: HostCacheTarget): GuardPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  return planGuardWith(root, expected, null);
}
function planGuardWith(root: string, cache: HostCacheTarget | null, removeId: string | null): GuardPlan {
  if (cache && cache.host !== null && cache.host !== 'claude')
    fail('HOST-UNSUPPORTED', 'Guard registration requires a Claude-compatible cache');
  if (cache) {
    const path = relative(cache.directory, root);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
      fail('PATH-UNSAFE', 'Consumer root cannot be inside its immutable host cache');
  }
  const id = cache ? HOST_REGISTRATION : identity(removeId);
  const before: Side = {
      config: read(root, configPath),
      state: locate(statePath(id), () => read(root, statePath(id))),
    },
    prior = locate(statePath(id), () => saved(before.state, root, id));
  if (!cache && !prior) fail('INPUT-INVALID', 'Guard registration is not owned');
  const config = before.config === null ? {} : plain(decodeDistributionJson(before.config)),
    hooks = config['hooks'] === undefined ? {} : plain(config['hooks']);
  const projectText = read(root, projectPath),
    project = projectText === null ? {} : plain(decodeDistributionJson(projectText));
  if (
    cache &&
    (config['disableAllHooks'] === true ||
      (config['disableAllHooks'] === undefined && project['disableAllHooks'] === true))
  )
    fail('HOST-UNSUPPORTED', 'Project hooks are explicitly disabled by disableAllHooks');
  const rows: unknown[] = hooks['PreToolUse'] === undefined ? [] : (hooks['PreToolUse'] as unknown[]);
  if (!Array.isArray(rows) || rows.length > 256) fail('INPUT-INVALID', 'Expected a bounded PreToolUse hook array');
  const matching = prior
    ? rows.map((row, at) => (json(row) === json(prior.group) ? at : -1)).filter((at) => at >= 0)
    : [];
  // A removal whose owned group the user already deleted — no group names this root's guard — removes only the ownership state; a changed or duplicated group still refuses.
  const gone =
    !cache &&
    prior !== null &&
    matching.length === 0 &&
    !rows.some((row) => json(row).includes(JSON.stringify(['guard', '--root', root]).slice(1, -1)));
  if (prior && !gone && matching.length !== 1)
    fail('LOCAL-MODIFICATION', 'Owned guard hook group changed or was duplicated');
  const group = cache ? guardGroup(cache.launcher, root) : null,
    remaining = rows.filter((_row, at) => !matching.includes(at));
  if (group && remaining.some((row) => json(row) === json(group)))
    fail('LOCAL-MODIFICATION', 'An unmanaged identical guard group already exists');
  // In place (spec §5.1): replace or append the owned group, or remove it by index; every other byte is kept.
  const existing = prior ? keptPaths(prior.existing, containers) : presentJson(before.config, containers),
    owned = ['hooks', 'PreToolUse', prior ? matching[0]! : -1];
  const edited = gone ? before.config : editJson(before.config, owned, group ?? undefined, existing),
    nextConfig = !gone && prior?.created && emptyJson(edited!) ? null : edited;
  const after: Side = {
    config: nextConfig,
    state:
      cache && group
        ? json({
            format: 'ia.guard-registration-state.v1',
            id,
            cache: cache.directory,
            release: cache.release,
            created: prior?.created ?? before.config === null,
            group,
            ...(existing.length ? { existing } : {}),
          })
        : null,
  };
  if (Buffer.byteLength(after.config ?? '') > 1024 * 1024 || Buffer.byteLength(after.state ?? '') > 1024 * 1024)
    fail('LIMIT-EXCEEDED', 'Guard registration exceeds its publication bounds');
  const body = {
    format: 'ia.guard-registration-plan.v1' as const,
    root,
    id,
    request: cache ? { cache: cache.directory } : { remove: id },
    release: cache?.release ?? null,
    before: { config: pin(before.config), state: pin(before.state), projectConfig: pin(projectText) },
    after,
  };
  return { ...body, digest: digest(body) };
}
const current = (root: string, id: string): Side => ({
  config: read(root, configPath),
  state: read(root, statePath(id)),
});
function same(root: string, id: string, side: Side): void {
  if (json(current(root, id)) !== json(side))
    fail('LOCAL-MODIFICATION', 'Guard configuration or ownership changed during publication');
}
const write = (root: string, path: string, content: string | null): void =>
  replace(root, path, content === null ? null : Buffer.from(content));
export function applyGuardRegistration(
  input: unknown,
  checkpoint: (stage: string) => void = () => {},
): { status: 'guard-registered' | 'guard-removed'; id: string } {
  const row = object(input, ['format', 'root', 'id', 'request', 'release', 'before', 'after', 'digest']);
  if (row['format'] !== 'ia.guard-registration-plan.v1' || typeof row['root'] !== 'string')
    fail('INPUT-INVALID', 'Invalid guard registration plan');
  const root = workspace(row['root']),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planGuardRegistration(root, row['request'] as GuardRequest);
    if (json(plan) !== json(input)) fail('PLAN-STALE', 'Guard plan no longer matches its current inputs');
    const before = current(root, plan.id);
    write(
      root,
      pendingPath,
      json({ format: 'ia.guard-registration-pending.v1', id: plan.id, before, after: plan.after }),
    );
    checkpoint('pending');
    same(root, plan.id, before);
    write(root, configPath, plan.after.config);
    checkpoint('config');
    same(root, plan.id, { ...before, config: plan.after.config });
    if (
      pin(read(root, projectPath)) !== plan.before.projectConfig ||
      ('cache' in plan.request && verifyHostCache(plan.request.cache).release !== plan.release)
    )
      fail('PLAN-STALE', 'Project settings or host cache changed before registration commit');
    write(root, statePath(plan.id), plan.after.state);
    checkpoint('state');
    write(root, pendingPath, null);
    checkpoint('complete');
    return { status: 'cache' in plan.request ? 'guard-registered' : 'guard-removed', id: plan.id };
  } finally {
    unlock();
  }
}
export function recoverGuardRegistration(rootInput: string): { status: 'guard-recovered' | 'current' } {
  const root = workspace(rootInput),
    unlock = acquireHostRegistrationLock(root, true);
  try {
    if (read(root, area + '/pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-host for pending MCP registration');
    if (read(root, area + '/lifecycle-pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-lifecycle for the pending context registration');
    const content = read(root, pendingPath, 8 * 1024 * 1024);
    if (content === null) return { status: 'current' };
    const row = object(decodeDistributionJson(content), ['format', 'id', 'before', 'after']);
    if (row['format'] !== 'ia.guard-registration-pending.v1') fail('INPUT-INVALID', 'Unknown guard recovery format');
    const id = identity(row['id']);
    const side = (value: unknown): Side => {
      const data = object(value, ['config', 'state']);
      for (const v of Object.values(data))
        if (!(v === null || (typeof v === 'string' && Buffer.byteLength(v) <= 1024 * 1024)))
          fail('INPUT-INVALID', 'Invalid guard recovery bytes');
      const result = data as unknown as Side;
      saved(result.state, root, id);
      if (result.config !== null) plain(decodeDistributionJson(result.config));
      return result;
    };
    const before = side(row['before']),
      after = side(row['after']),
      actual = current(root, id);
    if (![before.config, after.config].includes(actual.config) || ![before.state, after.state].includes(actual.state))
      fail('LOCAL-MODIFICATION', 'Unexpected local guard edit must be reconciled');
    const desired = actual.state === after.state ? after : before;
    write(root, configPath, desired.config);
    write(root, statePath(id), desired.state);
    write(root, pendingPath, null);
    return { status: 'guard-recovered' };
  } finally {
    unlock();
  }
}
/**
 * The script `/bin/sh` runs the guard with, on POSIX: Node and its arguments come in as `$0` and `$@`, never as script text,
 * and any failure to run the guard at all exits 2, naming the remedy on stderr, which Claude Code shows with the block.
 * Claude Code lets a tool call through when a hook command cannot start or fails any other way, and blocks only on exit 2 or
 * a deny (code.claude.com/docs/en/hooks); the guard's own decisions exit 0 and pass through unchanged. win32 has no
 * `/bin/sh` and keeps the direct form, which still fails open (#323).
 */
export const FAIL_CLOSED =
  '"$0" "$@" || { echo "IA steward guard could not run: run ia doctor, then ia host claude --apply" >&2; exit 2; }';
/**
 * Every script a released `guardGroup` has written, the current one first. A registration made with an earlier one stays an
 * owned registration, so plan, remove and doctor still read it and re-applying rewrites it (`currentGuardForm`); a script
 * this list does not hold is not one IA wrote. A change to `FAIL_CLOSED` MUST keep the previous script here.
 */
export const FAIL_CLOSED_ACCEPTED: readonly string[] = [FAIL_CLOSED, '"$0" "$@" || exit 2'];
/**
 * The Node a guard handler runs when its arguments are the fixed derivation for this launcher and root: the direct form's
 * command (win32, and registrations made before the POSIX form), or the POSIX form's `$0` under any accepted script. Null
 * for any other handler.
 */
export function guardNode(
  handler: { readonly command?: unknown; readonly args?: unknown },
  launcher: string,
  root: string,
): unknown {
  const direct = json([launcher, 'guard', '--root', root]),
    args = handler.args;
  if (!Array.isArray(args)) return null;
  if (json(args) === direct) return handler.command;
  return handler.command === '/bin/sh' &&
    args.length === 7 &&
    args[0] === '-c' &&
    FAIL_CLOSED_ACCEPTED.includes(args[1]) &&
    json(args.slice(3)) === direct
    ? args[2]
    : null;
}
/**
 * An owned guard handler is in the form `guardGroup` writes now on this platform: the direct form on win32, and elsewhere the
 * `/bin/sh` form with the current `FAIL_CLOSED` script. The direct form on POSIX fails open when its Node cannot run, and an
 * earlier script lacks what the current one adds; both still work, and re-applying rewrites them.
 */
export function currentGuardForm(
  handler: { readonly command?: unknown; readonly args?: unknown },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return handler.command !== '/bin/sh';
  return handler.command === '/bin/sh' && Array.isArray(handler.args) && handler.args[1] === FAIL_CLOSED;
}
