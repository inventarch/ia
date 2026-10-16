import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  admissionReport,
  inertCommandRoot,
  evaluateMandateGuard,
  evaluateSteward,
  isAdmissionRefusal,
  isEntry,
  mandateGuardSelects,
  openDatabase,
  refusedDependencies,
  refusedMandates,
  requireMandatesAdmitted,
} from '@inventarch/runtime';
import type { HookCode } from '@inventarch/runtime';
import { pathKey, sameFile, unaliased } from '@inventarch/db';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { hookDeclaration, registrableHook } from '@inventarch/workspace-runtime/internal/generate';

export interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'deny';
    readonly permissionDecisionReason: string;
  };
}
export function deny(code: HookCode, message: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: printable(`${code}: ${message}`),
    },
  };
}
// Built from strings: the classes name the control characters themselves.
const ESCAPES = new RegExp('\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?|[@-_])', 'g'),
  CONTROLS = new RegExp(
    '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
    'g',
  );
/**
 * A refusal as the host may display it: authored text (a `@hook`'s message) and paths reach the reason, so terminal
 * escape sequences are removed and every other C0 or C1 control, line or paragraph separator and bidirectional control
 * becomes a space; the reason is bounded.
 */
export function printable(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, ' ').slice(0, 4096);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Rules key names with db `pathKey`: case on win32; normalization and full case folding on darwin (crowncodes/ia#315, crowncodes/ia#323). It folds
 * by platform, whatever the volume, so on a case-sensitive directory there a sibling spelled in another case matches too.
 */
const fold = pathKey;
function local(root: string, target: string): string | undefined {
  const rel = relative(fold(root), fold(target));
  return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ? undefined : rel.replaceAll('\\', '/');
}
function physical(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physical(parent), relative(parent, path));
  }
  // An existing link whose target is absent is not an ordinary missing component. Its realpath failure must refuse
  // the edit, including when this is an ancestor of a missing leaf or another link; never rebuild its lexical name.
  return realpathSync.native(path);
}
type Rule = { projection?: true; system?: string; invalid?: true };
/** Consumer-mode ownership: the files a projection state owns (folded) and whether a Codex registration exists. */
interface Ownership {
  readonly files: ReadonlySet<string>;
  readonly codex: boolean;
}
/** Paths every workspace protects: the native installation state. */
function installation(path: string): boolean {
  return (
    path === '.ia/distributions.lock.json' || path === '.ia/distributions' || path.startsWith('.ia/distributions/')
  );
}
/**
 * The projection list written for this repository; in a consumer workspace only its owned subset stays protected. The
 * position packet's files: `CLAUDE.md` and both `ia-authoring` skills here, and a consumer's
 * `.claude/rules/ia-workspace.md`, `AGENTS.md` and skills; its receipt sits under `.ia/distributions/`.
 */
function projectionCandidate(path: string): boolean {
  return (
    path === '.codex/config.toml' ||
    /^\.codex\/agents\//.test(path) ||
    /^\.(?:agents|claude)\/skills\//.test(path) ||
    path === 'claude.md' ||
    path === 'CLAUDE.md' ||
    ['.agents/skills/ia-authoring/SKILL.md', '.claude/skills/ia-authoring/SKILL.md'].some((p) => fold(p) === path) ||
    fold('.claude/rules/ia-workspace.md') === path ||
    fold('AGENTS.md') === path
  );
}
/**
 * A 1.x per-system steward file. No projection writes one any more, so one stays protected only until it is removed:
 * in a consumer workspace while its projection state lists it, and elsewhere while it carries a 1.x renderer's marker,
 * which `pnpm projections:generate` or the next projection apply deletes. Any other agent file is the user's.
 */
const LEGACY_STEWARD = /^\.claude\/agents\/[^/]+\.md$/;
/** The markers compliance's retired 1.x renderers wrote: this repository's and `ia host`'s. */
const LEGACY_MARKERS: readonly string[] = [
  '<!-- Generated by tools/projections/generate.ts; edit the cited native records. -->',
  '<!-- Generated by ia host; edit the cited native records. -->',
];
/**
 * Whether the file at the absolute `target` is a 1.x steward file still: a regular file within the projection bound
 * that carries a legacy marker line. A missing file, or one no renderer wrote, is not.
 */
function legacySteward(target: string): boolean {
  let fd: number;
  try {
    // Open first: a pathname stat cannot authorize a later pathname read. Do not follow a leaf link, or block on a FIFO.
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true }),
      limit = 1024 * 1024;
    if (!stat.isFile() || stat.size > BigInt(limit)) return false;
    const same = (value: BigIntStats): boolean =>
      value.isFile() &&
      value.dev === stat.dev &&
      value.ino === stat.ino &&
      value.nlink === stat.nlink &&
      value.size === stat.size &&
      value.mtimeNs === stat.mtimeNs &&
      value.ctimeNs === stat.ctimeNs;
    if (!same(lstatSync(target, { bigint: true })) || !unaliased(target, physical(target)))
      throw new Error('Legacy steward changed while opening');
    const content = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, content, size, content.length - size, null);
      size += count;
      if (count === 0 || size === content.length) break;
    }
    if (
      size > limit ||
      BigInt(size) !== stat.size ||
      !same(fstatSync(fd, { bigint: true })) ||
      !same(lstatSync(target, { bigint: true })) ||
      !unaliased(target, physical(target))
    )
      throw new Error('Legacy steward changed while reading');
    const lines = content.subarray(0, size).toString('utf8').split(/\r?\n/);
    return LEGACY_MARKERS.some((marker) => lines.includes(marker));
  } finally {
    closeSync(fd);
  }
}
/** The bound of an ownership state, the actor map and a context ownership marker other than a pending journal. */
const STATE_LIMIT = 1024 * 1024;
/**
 * The bytes of the ownership state at the absolute `path`, or undefined when there is none. A state must be a plain,
 * unaliased, single-link file within `limit` bytes. It is opened before it is judged, so the checks and the read are of
 * one file (CodeQL js/file-system-race), and it must still be that file after the read. Anything else throws `unsafe`,
 * and the caller fails closed; an open that fails other than for a missing file throws its own error.
 */
function readState(path: string, unsafe: string, limit = STATE_LIMIT): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    const same = (value: BigIntStats): boolean =>
      value.isFile() &&
      value.nlink === 1n &&
      value.dev === stat.dev &&
      value.ino === stat.ino &&
      value.size === stat.size &&
      value.mtimeNs === stat.mtimeNs &&
      value.ctimeNs === stat.ctimeNs;
    if (
      !same(stat) ||
      stat.size > BigInt(limit) ||
      !same(lstatSync(path, { bigint: true })) ||
      !unaliased(path, physical(path))
    )
      throw new Error(unsafe);
    // The opened size plus one byte: growth during the read shows, and nothing past the bound is ever read.
    const content = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, content, size, content.length - size, null);
      size += count;
      if (count === 0 || size === content.length) break;
    }
    if (
      size > limit ||
      BigInt(size) !== stat.size ||
      !same(fstatSync(fd, { bigint: true })) ||
      !same(lstatSync(path, { bigint: true }))
    )
      throw new Error(unsafe);
    return content.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
/**
 * `readState` for a reader that refuses as `unsafe` whatever is not a plain single-link file within `limit` bytes, also
 * when the open finds it: a failed open has the name examined, so a link (`O_NOFOLLOW`), a socket, or a directory
 * Windows will not open, gets the refusal an opened one does. Any other failed open throws its own error, as before.
 */
function stateBytes(path: string, unsafe: string, limit = STATE_LIMIT): Buffer | undefined {
  try {
    return readState(path, unsafe, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).syscall !== 'open') throw error;
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile() || named.nlink !== 1n || named.size > BigInt(limit)) throw new Error(unsafe);
    throw error;
  }
}

/**
 * `ownership` is undefined in a legacy workspace (no projection state) and is read only when a candidate path needs it;
 * `steward` says whether the edited file, at a legacy-mode agent path, is still a 1.x steward file. `systems` locates the
 * retired steward rule's system folders, which only the legacy mode enforces.
 */
function protection(
  path: string | undefined,
  ownership: () => Ownership | undefined,
  steward: () => boolean,
  systems = true,
): Rule | undefined {
  if (path === undefined) return undefined;
  if (installation(path)) return { projection: true };
  if (projectionCandidate(path)) {
    const owned = ownership();
    if (owned === undefined || owned.files.has(path) || (path === '.codex/config.toml' && owned.codex))
      return { projection: true };
  }
  if (LEGACY_STEWARD.test(path)) {
    const owned = ownership();
    if (owned === undefined ? steward() : owned.files.has(path)) return { projection: true };
  }
  if (systems && (path === '.ia/src/systems' || path.startsWith('.ia/src/systems/'))) {
    const system = path.split('/')[3];
    return system !== undefined && /^[a-z][a-z0-9-]*$/.test(system) ? { system } : { invalid: true };
  }
  return undefined;
}
/** The hosts area, or undefined when absent; an aliased area is refused. */
function hostsArea(root: string): string | undefined {
  const directory = resolve(root, '.ia/distributions/hosts');
  try {
    if (!unaliased(directory, physical(directory))) throw new Error('Host ownership directory is aliased');
    lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return directory;
}
/**
 * The same projection allowlist `@inventarch/distribution` validates a state against (projection.ts), so a state cannot
 * claim other paths: the packet's two files per host, the agents and skills authored generation writes (claude agents
 * and skills, codex skills), and for claude a 1.x steward file a state still lists until the next apply removes it. The
 * state format name is unchanged.
 */
const PROJECTION_OWNED: Readonly<Record<'claude' | 'codex', (path: string) => boolean>> = {
  claude: (path) =>
    path === '.claude/rules/ia-workspace.md' ||
    path === '.claude/skills/ia-authoring/SKILL.md' ||
    /^\.claude\/agents\/[a-z][a-z0-9-]*\.md$/.test(path) ||
    // A generated skill (distribution's GENERATED_PATHS); a generated agent is the pattern above.
    /^\.claude\/skills\/[a-z][a-z0-9-]*\/SKILL\.md$/.test(path),
  codex: (path) =>
    path === 'AGENTS.md' ||
    path === '.agents/skills/ia-authoring/SKILL.md' ||
    /^\.agents\/skills\/[a-z][a-z0-9-]*\/SKILL\.md$/.test(path),
};
/**
 * A bounded read of the projection ownership states, not a validation of the projected bytes. Undefined when neither
 * state exists (legacy mode); a state that is not a plain, unaliased, well-formed file throws, so the caller fails closed.
 */
function projectionOwnership(root: string): Ownership | undefined {
  const directory = hostsArea(root);
  if (directory === undefined) return undefined;
  const files = new Set<string>();
  let found = false;
  for (const host of ['claude', 'codex'] as const) {
    const content = readState(resolve(directory, `${host}-projection.json`), 'Unsafe projection ownership state');
    if (content === undefined) continue;
    const row: unknown = decodeDistributionJson(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (
      !object(row) ||
      Object.keys(row).sort().join('|') !== 'files|format|host' ||
      row['format'] !== 'ia.host-projection-state.v1' ||
      row['host'] !== host ||
      !object(row['files'])
    )
      throw new Error('Invalid projection ownership state');
    for (const [owned, value] of Object.entries(row['files'])) {
      const hashes: unknown[] = Array.isArray(value) ? value : [value];
      if (
        !PROJECTION_OWNED[host](owned) ||
        !hashes.length ||
        hashes.length > 2 ||
        hashes.some((h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) ||
        new Set(hashes).size !== hashes.length
      )
        throw new Error('Invalid projection ownership state');
      files.add(fold(owned));
    }
    found = true;
  }
  if (!found) return undefined;
  let codex = true;
  try {
    lstatSync(resolve(directory, 'codex-workspace.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    codex = false;
  }
  return { files, codex };
}
/**
 * The selection a hook ownership state (`claude-hooks-<id>.json`) recorded for `hook` when its group was registered, or
 * undefined when none records one. The state is read as the other ownership states are: a plain, unaliased, single-link,
 * bounded file of the expected format, else this throws and the caller refuses.
 */
function registeredSelection(root: string, hook: string): readonly string[] | undefined {
  const directory = hostsArea(root);
  if (directory === undefined) return undefined;
  for (const name of readdirSync(directory).sort()) {
    if (!/^claude-hooks-[a-z][a-z0-9-]{0,63}\.json$/.test(name)) continue;
    let row: unknown;
    try {
      // A state the listing named that is gone by the read refuses, as one that changed does.
      const content = readState(resolve(directory, name), 'Unsafe hook ownership state');
      if (content === undefined) throw new Error('Hook ownership state disappeared while read');
      row = decodeDistributionJson(new TextDecoder('utf-8', { fatal: true }).decode(content));
      if (!object(row) || row['format'] !== 'ia.hook-registration-state.v1' || !Array.isArray(row['groups']))
        throw new Error('Invalid hook ownership state');
    } catch (error) {
      // The state file that could not be read, root-relative, so a refusal can name its repair.
      throw new UnreadableHookState(`.ia/distributions/hosts/${name}`, error);
    }
    for (const group of row['groups'] as unknown[])
      if (
        object(group) &&
        group['hook'] === hook &&
        Array.isArray(group['paths']) &&
        group['paths'].length > 0 &&
        group['paths'].every((path) => typeof path === 'string')
      )
        return group['paths'] as string[];
  }
  return undefined;
}
/** A hook ownership state the guard could not read, by its root-relative path. */
class UnreadableHookState extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`${path} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
/** A bounded ownership-marker check, not registration validation or a grant of host authority. */
interface GuardControls {
  readonly settings: boolean;
  readonly guard: boolean;
  readonly launchers: readonly string[];
}
function contextSettingsManaged(root: string, includeContext = true): GuardControls {
  const directory = resolve(root, '.ia/distributions/hosts');
  let names: string[];
  try {
    if (!unaliased(directory, physical(directory))) throw new Error('Context ownership directory is aliased');
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: false, guard: false, launchers: [] };
    throw error;
  }
  if (names.length > 4096) throw new Error('Context ownership inventory exceeds its bound');
  let managed = false,
    guardManaged = false;
  const launchers: string[] = [];
  for (const name of names) {
    const match = /^claude-context-([a-z][a-z0-9-]{0,63})\.json$/.exec(fold(name)),
      pending = fold(name) === 'lifecycle-pending.json';
    const guard = /^claude-guard-([a-z][a-z0-9-]{0,63})\.json$/.exec(fold(name)),
      guardPending = fold(name) === 'guard-pending.json',
      hooks = /^claude-hooks-([a-z][a-z0-9-]{0,63})\.json$/.exec(fold(name));
    if (!guard && !guardPending && !hooks && (!includeContext || (!match && !pending))) continue;
    // A marker is a plain, unaliased, single-link file of at most 1 MiB, or 8 MiB for a pending journal, read through
    // the descriptor that judged it; one named in another case, or gone since the listing, is as unsafe.
    if (name !== name.toLowerCase()) throw new Error('Unsafe context ownership marker');
    const content = stateBytes(
      resolve(directory, name),
      'Unsafe context ownership marker',
      pending || guardPending ? 8 * 1024 * 1024 : STATE_LIMIT,
    );
    if (content === undefined) throw new Error('Unsafe context ownership marker');
    const row: unknown = decodeDistributionJson(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (!object(row) || typeof row['id'] !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row['id']))
      throw new Error('Invalid context ownership marker');
    if (pending) {
      if (
        Object.keys(row).sort().join('|') !== 'after|before|format|id' ||
        row['format'] !== 'ia.lifecycle-registration-pending.v1'
      )
        throw new Error('Invalid pending context ownership');
      for (const key of ['before', 'after']) {
        const side = row[key];
        if (
          !object(side) ||
          Object.keys(side).sort().join('|') !== 'binding|config|state' ||
          Object.values(side).some((value) => value !== null && typeof value !== 'string')
        )
          throw new Error('Invalid pending context bytes');
      }
    } else if (guardPending) {
      // One journal serves the retired steward guard's registration and the `@hook` groups' (distribution
      // guard-registration.ts): each names its own state format.
      const hookJournal = row['format'] === 'ia.hook-registration-pending.v1';
      if (
        Object.keys(row).sort().join('|') !== 'after|before|format|id' ||
        (row['format'] !== 'ia.guard-registration-pending.v1' && !hookJournal)
      )
        throw new Error('Invalid pending guard ownership');
      for (const key of ['before', 'after']) {
        const side = row[key];
        if (
          !object(side) ||
          Object.keys(side).sort().join('|') !== 'config|state' ||
          Object.values(side).some((value) => value !== null && typeof value !== 'string')
        )
          throw new Error('Invalid pending guard bytes');
        guardManaged = true;
        if (typeof side['state'] === 'string') {
          const state: unknown = decodeDistributionJson(side['state']);
          if (
            !object(state) ||
            state['format'] !== (hookJournal ? 'ia.hook-registration-state.v1' : 'ia.guard-registration-state.v1') ||
            state['id'] !== row['id'] ||
            typeof state['cache'] !== 'string' ||
            !isAbsolute(state['cache'])
          )
            throw new Error('Invalid pending guard owner');
          launchers.push(resolve(state['cache'], 'scripts/ia.mjs'));
        }
      }
    } else if (hooks) {
      // The `@hook` groups' ownership state: the settings that hold them, and the launcher they run, are managed as the
      // retired guard's were.
      if (
        Object.keys(row)
          .filter((key) => key !== 'existing')
          .sort()
          .join('|') !== 'cache|created|format|groups|id|release' ||
        (row['existing'] !== undefined && !Array.isArray(row['existing'])) ||
        row['format'] !== 'ia.hook-registration-state.v1' ||
        row['id'] !== hooks[1] ||
        typeof row['cache'] !== 'string' ||
        !isAbsolute(row['cache']) ||
        typeof row['created'] !== 'boolean' ||
        !Array.isArray(row['groups']) ||
        typeof row['release'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row['release'])
      )
        throw new Error('Invalid hook ownership state');
      guardManaged = true;
      launchers.push(resolve(row['cache'] as string, 'scripts/ia.mjs'));
    } else if (guard) {
      if (
        Object.keys(row)
          .filter((key) => key !== 'existing')
          .sort()
          .join('|') !== 'cache|created|format|group|id|release' ||
        (row['existing'] !== undefined && !Array.isArray(row['existing'])) ||
        row['format'] !== 'ia.guard-registration-state.v1' ||
        row['id'] !== guard[1] ||
        typeof row['cache'] !== 'string' ||
        !isAbsolute(row['cache']) ||
        typeof row['created'] !== 'boolean' ||
        !object(row['group']) ||
        typeof row['release'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row['release'])
      )
        throw new Error('Invalid guard ownership state');
      guardManaged = true;
      launchers.push(resolve(row['cache'] as string, 'scripts/ia.mjs'));
    } else if (
      Object.keys(row)
        .filter((key) => key !== 'existing')
        .sort()
        .join('|') !== 'binding|cache|created|format|groups|id|release|revision' ||
      (row['existing'] !== undefined && !Array.isArray(row['existing'])) ||
      !['ia.lifecycle-registration-state.v1', 'ia.lifecycle-registration-state.v2'].includes(row['format'] as string) ||
      row['id'] !== match![1] ||
      !Number.isSafeInteger(row['revision']) ||
      (row['revision'] as number) < 1 ||
      typeof row['cache'] !== 'string' ||
      !isAbsolute(row['cache']) ||
      typeof row['created'] !== 'boolean' ||
      !object(row['groups']) ||
      Object.keys(row['groups']).sort().join('|') !== 'SessionStart|UserPromptSubmit' ||
      !['binding', 'release'].every((key) => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]))
    )
      throw new Error('Invalid context ownership state');
    managed = true;
  }
  return { settings: managed, guard: guardManaged, launchers };
}
/** Descriptor-bounded read; configuration changes during ownership detection refuse. */
function sourceGuardSettings(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      lstatSync(path, { bigint: true, throwIfNoEntry: false }) === undefined
    )
      return undefined;
    throw error;
  }
  const limit = 1024 * 1024;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(limit))
      throw new Error('Unsafe source guard registration');
    const same = (value: BigIntStats): boolean =>
      value.isFile() &&
      value.nlink === 1n &&
      value.dev === opened.dev &&
      value.ino === opened.ino &&
      value.size === opened.size &&
      value.mtimeNs === opened.mtimeNs &&
      value.ctimeNs === opened.ctimeNs;
    if (!same(lstatSync(path, { bigint: true })) || !unaliased(path, physical(path)))
      throw new Error('Source guard registration changed before read');
    const content = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = readSync(fd, content, size, content.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (
      size > limit ||
      BigInt(size) !== opened.size ||
      !same(fstatSync(fd, { bigint: true })) ||
      !same(lstatSync(path, { bigint: true })) ||
      !unaliased(path, physical(path))
    )
      throw new Error('Source guard registration changed while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}
/** Recognize only the fixed source-launcher registration; an unrelated hook or filename establishes no ownership. */
function sourceGuardRegistered(root: string): boolean {
  const launcher = resolve(root, '.claude/hooks/steward-write.mjs');
  try {
    lstatSync(launcher);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
    const content = sourceGuardSettings(resolve(root, name));
    if (content === undefined || !content.includes('steward-write.mjs')) continue;
    const value: unknown = decodeDistributionJson(content);
    if (!object(value) || !object(value['hooks']) || !Array.isArray(value['hooks']['PreToolUse'])) continue;
    for (const group of value['hooks']['PreToolUse']) {
      if (!object(group) || group['matcher'] !== 'Write|Edit|MultiEdit' || !Array.isArray(group['hooks'])) continue;
      for (const hook of group['hooks']) {
        if (
          !object(hook) ||
          hook['type'] !== 'command' ||
          typeof hook['command'] !== 'string' ||
          !hook['command'] ||
          !Array.isArray(hook['args']) ||
          hook['args'].length !== 3
        )
          continue;
        if (
          hook['command'] !== 'node' &&
          !(isAbsolute(hook['command']) && ['node', 'node.exe'].includes(fold(basename(hook['command']))))
        )
          continue;
        const [entry, flag, selectedRoot] = hook['args'];
        const samePath = (input: unknown, expected: string): boolean =>
          typeof input === 'string' && isAbsolute(input) && fold(resolve(input)) === fold(expected);
        if (
          flag === '--root' &&
          (entry === `\${CLAUDE_PROJECT_DIR}/.claude/hooks/steward-write.mjs` || samePath(entry, launcher)) &&
          (selectedRoot === `\${CLAUDE_PROJECT_DIR}` || samePath(selectedRoot, root))
        )
          return true;
      }
    }
  }
  return false;
}
function actorMap(path: string, revision: string): ReadonlyMap<string, string> {
  if (!isAbsolute(path) || !unaliased(path, physical(path)))
    throw new Error('Actor map must be an absolute unaliased file');
  // A plain single-link file of at most 1 MiB, read through the descriptor that judged it; a missing map is as invalid.
  const content = stateBytes(path, 'Invalid actor map file');
  if (content === undefined) throw new Error('Invalid actor map file');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  if (
    !object(value) ||
    Object.keys(value).sort().join('|') !== 'actors|format|revision' ||
    value['format'] !== 'ia.steward-actors.v1' ||
    value['revision'] !== revision ||
    !Array.isArray(value['actors']) ||
    value['actors'].length > 256
  )
    throw new Error('Actor map is malformed or stale');
  const entries = new Map<string, string>();
  for (const entry of value['actors']) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join('|') !== 'host|identity' ||
      typeof entry['host'] !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}(?::[a-z][a-z0-9-]{0,63})?$/.test(entry['host']) ||
      typeof entry['identity'] !== 'string' ||
      entry['identity'].length > 512 ||
      entries.has(entry['host'])
    )
      throw new Error('Invalid or duplicate actor mapping');
    entries.set(entry['host'], entry['identity']);
  }
  return entries;
}
/**
 * `target` under `root` placed by identity rather than spelling: from the nearest ancestor that is the root's own directory
 * (`sameFile`, by device and inode), the rest of the path. It places a spelling in another namespace that
 * `realpathSync.native` keeps, such as the loopback admin share `\\localhost\C$\…` or a root registered in that form, which
 * no string comparison puts under the root.
 */
function anchored(root: string, target: string): string | undefined {
  for (let current = target; ; ) {
    if (sameFile(current, root)) return local(current, target);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
/**
 * Whether a win32 path holds a `:` other than its drive designator's: after an optional `\\?\` or `\\.\` prefix and an
 * optional `X:` drive, any further `:` names a stream or a drive-relative spelling.
 */
export function streamed(path: string): boolean {
  const rest = path.replace(/^[\\/]{2}[?.][\\/]/, '').replace(/^[A-Za-z]:/, '');
  return rest.includes(':');
}
/** A PreToolUse event for one file edit, as both modes accept it. */
interface EditEvent extends Record<string, unknown> {
  readonly tool_name: 'Write' | 'Edit' | 'MultiEdit';
  readonly tool_input: Record<string, unknown> & { readonly file_path: string };
}
function editEvent(event: unknown): event is EditEvent {
  return (
    object(event) &&
    event['hook_event_name'] === 'PreToolUse' &&
    ['Write', 'Edit', 'MultiEdit'].includes(String(event['tool_name'])) &&
    object(event['tool_input']) &&
    typeof event['tool_input']['file_path'] === 'string' &&
    !!event['tool_input']['file_path'].trim() &&
    !event['tool_input']['file_path'].includes('\0') &&
    !(event['tool_name'] === 'MultiEdit' && !Array.isArray(event['tool_input']['edits']))
  );
}
/** Where an edit lands: the fixed root, the target as spelled and as the volume resolves it, and its root-relative spellings. */
interface EditTarget {
  readonly base: string;
  readonly target: string;
  readonly actual: string;
  /** The folded root-relative spellings (`local`), the typed one first; undefined where one does not lie under the root. */
  readonly spellings: readonly (string | undefined)[];
  readonly rule: Rule | undefined;
}
/**
 * The path safety and managed-state protection both modes share. Throws, for IA-HOOK-PATH-UNSAFE, on an unusable root,
 * a relative path without a cwd inside it, unreadable ownership, and a protected path reached through an alias. With
 * `systems`, the retired steward rule's `.ia/src/systems/<name>/` folders are located too (the legacy mode only).
 */
function editTarget(root: string, event: EditEvent, systems: boolean): EditTarget {
  let rule: Rule | undefined, base: string;
  {
    if (!isAbsolute(root)) throw new Error('Binding requires an absolute fixed project root');
    // The registered root as the volume stores it: another case or normalization of the same directory is the same
    // project, and every rule below compares against this spelling; a link or junction anywhere in it is still refused.
    base = resolve(root);
    const real = realpathSync.native(base);
    if (!unaliased(base, real)) throw new Error('Project root is aliased');
    base = real;
    const path = event['tool_input']['file_path'];
    // On win32 a `:` after the drive designator names an alternate data stream (`x.md::$DATA`, `x.md:s`) or a
    // drive-relative path: the write lands on a file the typed spelling does not name, so it is refused before any rule
    // or selection reads it.
    if (process.platform === 'win32' && streamed(path))
      throw new Error('A path naming an alternate data stream or a drive-relative path is refused');
    if (
      !isAbsolute(path) &&
      (typeof event['cwd'] !== 'string' ||
        !isAbsolute(event['cwd']) ||
        local(base, physical(resolve(event['cwd']))) === undefined)
    )
      throw new Error('Relative input requires cwd inside the fixed root');
    // A relative path lands where the kernel puts it: POSIX follows the cwd's links before `..`, Windows removes `..` first.
    const target = isAbsolute(path)
        ? resolve(path)
        : resolve(
            process.platform === 'win32' ? resolve(event['cwd'] as string) : physical(resolve(event['cwd'] as string)),
            path,
          ),
      actual = physical(target);
    // With neither spelling under the root as a string, either may still reach it through another namespace, so both are
    // placed by identity too (`anchored`); a rule found that way is held to the same alias check as any other.
    const lexical = local(base, target),
      physicalPath = local(base, actual),
      spellings = [lexical, physicalPath];
    if (lexical === undefined && physicalPath === undefined)
      spellings.push(anchored(base, target), anchored(base, actual));
    let read = false,
      owned: Ownership | undefined;
    const ownership = (): Ownership | undefined => {
      if (!read) {
        owned = projectionOwnership(base);
        read = true;
      }
      return owned;
    };
    rule = spellings.reduce<Rule | undefined>(
      (found, spelling) => found ?? protection(spelling, ownership, () => legacySteward(actual), systems),
      undefined,
    );
    const localSettings = spellings.includes('.claude/settings.local.json'),
      projectSettings = spellings.includes('.claude/settings.json');
    const sourceLauncher = spellings.includes('.claude/hooks/steward-write.mjs');
    // A cached launcher can be outside the consumer root. Only the exact path in its owned guard marker is managed.
    const possibleCacheLauncher = [target, actual].some((path) =>
      fold(path).replaceAll('\\', '/').endsWith('/scripts/ia.mjs'),
    );
    if (localSettings || projectSettings || sourceLauncher || possibleCacheLauncher) {
      const controls = contextSettingsManaged(base, localSettings),
        sourceGuard = (localSettings || projectSettings || sourceLauncher) && sourceGuardRegistered(base);
      const cacheLauncher =
        possibleCacheLauncher &&
        controls.launchers.some((path) =>
          [target, actual].some((value) => fold(resolve(value)) === fold(resolve(path))),
        );
      if (
        (localSettings && controls.settings) ||
        ((localSettings || projectSettings) && (controls.guard || sourceGuard)) ||
        (sourceLauncher && sourceGuard) ||
        cacheLauncher
      )
        rule = { projection: true };
    }
    if (rule !== undefined && !unaliased(target, actual))
      throw new Error('Protected path has an aliased ancestor or target');
    if (rule?.invalid) throw new Error('Cannot identify the owning system');
    return { base, target, actual, spellings, rule };
  }
}
const MANAGED =
  'Use the owning command for generated state. Guard settings require a trusted operator edit outside intercepted assistant tools, preserving the guard, followed by registration qualification';
/** The legacy guard: managed-state protection and the retired steward rule for `.ia/src/systems/<name>/`. */
export function evaluateHook(root: string, event: unknown, actorsPath?: string): HookOutput {
  if (!editEvent(event)) return deny('IA-HOOK-INPUT-INVALID', 'Expected a PreToolUse file edit event');
  let edit: EditTarget;
  try {
    edit = editTarget(root, event, true);
  } catch (error) {
    return deny('IA-HOOK-PATH-UNSAFE', error instanceof Error ? error.message : String(error));
  }
  const { base, rule } = edit;
  if (rule?.projection) return deny('IA-HOOK-PROJECTION-MANAGED', MANAGED);
  if (rule?.system === undefined) return {};
  try {
    const db = openDatabase(base, { cache: false });
    try {
      const records = db.records();
      const mapping = actorsPath === undefined ? undefined : actorMap(actorsPath, db.revision);
      const host = event['agent_type'],
        identity = typeof host === 'string' ? mapping?.get(host) : undefined;
      const actors =
        typeof host === 'string'
          ? records.filter(
              (r) =>
                r.discriminator === 'agent' &&
                (mapping === undefined ? r.name === host : identity !== undefined && r.identity === identity),
            )
          : [];
      const decision = evaluateSteward(
        records,
        rule.system,
        actors.length === 1 ? { kind: 'agent', identity: actors[0]!.identity } : undefined,
      );
      return decision.allowed ? {} : deny(decision.code!, decision.message);
    } finally {
      db.close();
    }
  } catch (error) {
    return deny('IA-HOOK-STEWARD-UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }
}
/**
 * Whether the workspace admits; when it does not, whether what admission refused fails the mandate resolvers closed: an
 * authored `@mandate`, or a record an admitted mandate or workspace depends on.
 */
type Admission = 'admits' | 'refuses' | 'mandate';
/** The workspace's admission as `recovery` names it, read from an open database. */
const admissionOf = (db: ReturnType<typeof openDatabase>): Admission =>
  !db.report.findings.some((finding) => finding.severity === 'error')
    ? 'admits'
    : refusedMandates(db).length > 0 || refusedDependencies(db).length > 0
      ? 'mandate'
      : 'refuses';
/**
 * The commands that bring a registration whose hook or records cannot be read back in step, each runnable from a shell
 * in that very state: removing the host registration, which restores editing and needs neither an admitting workspace
 * nor readable records; and, only where the workspace admits, re-registering its current hooks, which removes a group
 * whose record is gone. Where it does not admit, `ia validate` shows why; where an authored `@mandate`, or a record a
 * mandate resolution reads, failed admission, `ia validate` refuses like every mandate-gated command, so the admission
 * report, the version 1 machine route `ia report`, shows it instead, its root spelled only when inert unquoted, else
 * run from the workspace root (runtime `admissionReport`).
 */
const rootCommand = (command: string, root: string, tail = ''): string =>
  inertCommandRoot(root)
    ? `"${command} --root ${JSON.stringify(root)}${tail}"`
    : `"${command} --root .${tail}" from the workspace root`;
const recovery = (root: string, admission: Admission): string => {
  const remove = rootCommand('ia host claude', root, ' --remove --apply --yes');
  if (admission === 'admits')
    return `run ${rootCommand('ia host claude', root, ' --apply --yes')} from a shell to register the workspace's current hooks, or ${remove} to remove the registration and restore editing`;
  if (admission === 'mandate') {
    const report = admissionReport(root);
    return `run ${remove} from a shell to remove the registration and restore editing, and "${report.command}"${report.fromRoot ? ' from the workspace root' : ''} for the admission findings, the refused record's among them, before registering again`;
  }
  return `run ${remove} from a shell to remove the registration and restore editing, and ${rootCommand('ia validate', root)} to see why the workspace does not admit before registering again`;
};
/**
 * The `@mandate` guard: one authored `@hook`'s group runs `guard --root <root> --hook <identity>` for every edit tool.
 * The same input checks, path safety and managed-state protection as the legacy guard run first, whatever tools the
 * hook names, so no hook leaves the guard's own registration, the installation state or the owned projection open (the
 * retired steward rule is not one of them). Then the admitted authored `@hook` the registration names is read as hook
 * generation declares it, and runtime's evaluateMandateGuard decides the edit: allowed unless the hook selects it (its
 * paths select the file and its tools name the tool) and the actor is unknown or holds no governing mandate that grants
 * Synthesis there. A selected path reached through an alias is refused. What cannot be read refuses with a code;
 * nothing is allowed because something was unreadable once the hook is known to select the edit. When the hook's
 * record, or the workspace's records at all, cannot be read, the registration refuses only the edits under the
 * selection last registered for it, or every edit under the root when none is recorded.
 */
export function evaluateMandateHook(root: string, hook: string, event: unknown): HookOutput {
  if (!editEvent(event)) return deny('IA-HOOK-INPUT-INVALID', 'Expected a PreToolUse file edit event');
  if (!registrableHook(hook)) return deny('IA-HOOK-INPUT-INVALID', 'Expected --hook <canonical @hook identity>');
  let edit: EditTarget;
  try {
    edit = editTarget(root, event, false);
  } catch (error) {
    return deny('IA-HOOK-PATH-UNSAFE', error instanceof Error ? error.message : String(error));
  }
  if (edit.rule?.projection) return deny('IA-HOOK-PROJECTION-MANAGED', MANAGED);
  // Folded root-relative spellings, the physical one first: its existing components are the names on disk (the deepest
  // existing ancestor through realpathSync.native, which also expands a Windows 8.3 short name), its missing tail as
  // typed. Selections and claims fold too (`fold`), so on win32 and darwin, whatever the volume, `DOCS/x.md` is under
  // `docs/**` and `Docs/**` alike, and on other platforms each case is its own path. A selected file typed any other way than its on-disk name
  // but by case (an 8.3 short name) fails the alias check below and is refused, never decided as typed.
  const paths = [...new Set([edit.spellings[1], edit.spellings[0], ...edit.spellings.slice(2)])].filter(
    (spelling): spelling is string => spelling !== undefined,
  );
  if (paths.length === 0) return {};
  // A file with more than one link has another name a hook may select, which the guard cannot find: the edit is refused
  // wherever it is under the root rather than decided by the name it was typed with (a pnpm store link is such a file).
  try {
    const linked = lstatSync(edit.actual, { throwIfNoEntry: false });
    if (linked !== undefined && linked.isFile() && linked.nlink > 1)
      return deny(
        'IA-HOOK-PATH-UNSAFE',
        'A file with more than one link is refused: another of its names may be guarded',
      );
  } catch (error) {
    return deny('IA-HOOK-PATH-UNSAFE', error instanceof Error ? error.message : String(error));
  }
  // What cannot be read refuses no more than the selection the hook was registered with, which the hook ownership state
  // recorded: edits elsewhere, the repair among them unless that selection holds it, proceed. With no recorded
  // selection, every edit under the root is refused.
  const unavailable = (code: HookCode, why: string, admission: Admission): HookOutput => {
    let selection: readonly string[] | undefined, unreadable: string | undefined;
    try {
      selection = registeredSelection(edit.base, hook);
    } catch (error) {
      selection = undefined;
      unreadable =
        error instanceof UnreadableHookState ? error.path : '.ia/distributions/hosts/claude-hooks-workspace.json';
    }
    if (
      selection !== undefined &&
      !mandateGuardSelects({
        hook: { identity: hook, tools: ['Write', 'Edit', 'MultiEdit'], paths: selection, message: '' },
        tool: event.tool_name,
        paths,
        fold,
      })
    )
      return {};
    // An unreadable state is one the removal refuses too: its repair, from a shell, is deleting the state and the
    // groups it owns, which restores editing; the removal then takes the rest of the registration.
    if (unreadable !== undefined)
      return deny(
        code,
        `${why}; the hook ownership state ${unreadable} cannot be read, so every edit under the root is refused; from a shell, delete ${unreadable} and every IA hook group in .claude/settings.local.json (each runs the guard for one authored @hook) to restore editing, then run ${rootCommand('ia host claude', edit.base, ' --remove --apply --yes')} to remove the rest of the registration`,
      );
    return deny(
      code,
      `${why}; ${selection === undefined ? 'no registered selection is recorded, so every edit under the root is refused' : 'this edit is under its last registered selection'}; ${recovery(edit.base, admission)}`,
    );
  };
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(edit.base, { cache: false });
  } catch (error) {
    return unavailable(
      'IA-HOOK-MANDATE-UNAVAILABLE',
      `The workspace's records cannot be read: ${message(error)}`,
      'refuses',
    );
  }
  try {
    let within: string, nodes: ReturnType<typeof db.records>;
    // The admission is read first, so records that then cannot be read still name what runs there.
    let admission: Admission = 'refuses';
    try {
      admission = admissionOf(db);
      within = db.resolveScope().token;
      nodes = db
        .records({ within })
        .filter((node) => node.discriminator === 'hook' && node.band === 100 && node.identity === hook);
    } catch (error) {
      return unavailable(
        'IA-HOOK-MANDATE-UNAVAILABLE',
        `The workspace's records cannot be read: ${message(error)}`,
        admission,
      );
    }
    /**
     * A hook that cannot be decided while a record a mandate resolution reads failed admission (the hook in the refused
     * mandate's own file, say) fails closed at that record, as a decided edit would.
     */
    const undecided = (why: string): HookOutput => {
      try {
        requireMandatesAdmitted(db, within);
      } catch (error) {
        if (isAdmissionRefusal(error))
          return unavailable(
            'IA-HOOK-MANDATE-UNAVAILABLE',
            `${why}, and the mandates that would decide it cannot be read: ${error.message}`,
            admission,
          );
        throw error;
      }
      return unavailable('IA-HOOK-DECLARATION-UNAVAILABLE', why, admission);
    };
    if (nodes.length !== 1) return undecided(`${hook} is not an admitted authored @hook`);
    let declaration: ReturnType<typeof hookDeclaration>;
    try {
      declaration = hookDeclaration(nodes[0]!);
    } catch (error) {
      return undecided(message(error));
    }
    // `root` spells the registration's root into a next command that cannot find it (`ia report`).
    const request = {
      hook: declaration,
      tool: event.tool_name,
      paths,
      agentId: event['agent_id'],
      agentType: event['agent_type'],
      fold,
      root: edit.base,
    };
    if (!mandateGuardSelects(request)) return {};
    if (!unaliased(edit.target, edit.actual))
      return deny('IA-HOOK-PATH-UNSAFE', 'Selected path has an aliased ancestor or target');
    const decision = evaluateMandateGuard(db, within, request);
    if (decision.allowed) return {};
    // A refusal of the main session names the shell command that lifts every hook, which needs neither an admitting
    // workspace nor readable records; a subagent's refusal is the main session's to resolve.
    const lift =
      event['agent_id'] === undefined
        ? `; the main session can lift every hook from a shell with ${rootCommand('ia host claude', edit.base, ' --remove --apply --yes')}`
        : '';
    return deny(decision.code!, decision.message + lift);
  } catch (error) {
    // `ia validate` is mandate-gated and may refuse in the very state that failed here; the admission report, the
    // version 1 machine route, never is. Its root is spelled only when inert unquoted.
    const report = admissionReport(edit.base);
    return deny(
      'IA-HOOK-MANDATE-UNAVAILABLE',
      `The records that decide this edit cannot be read: ${message(error)}. Next: ${report.command}${report.fromRoot ? ', run from the workspace root' : ''}`,
    );
  } finally {
    db.close();
  }
}
const USAGE =
  'Usage: steward-hook --root <fixed absolute root> [--actors <trusted absolute mapping> | --hook <@hook identity>] (input limit 1 MiB)';
export function runHook(args: readonly string[], input: string): HookOutput {
  try {
    const mode = args.length === 4 ? args[2] : undefined;
    if (
      !(args.length === 2 || ((mode === '--actors' || mode === '--hook') && args[3])) ||
      args[0] !== '--root' ||
      !args[1] ||
      Buffer.byteLength(input) > 1024 * 1024
    )
      return deny('IA-HOOK-INPUT-INVALID', USAGE);
    const event = JSON.parse(input) as unknown;
    return mode === '--hook' ? evaluateMandateHook(args[1], args[3]!, event) : evaluateHook(args[1], event, args[3]);
  } catch {
    return deny('IA-HOOK-INPUT-INVALID', 'Invalid JSON input');
  }
}
if (isEntry(process.argv[1], import.meta.url)) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) break;
    chunks.push(Buffer.from(chunk));
  }
  process.stdout.write(
    JSON.stringify(
      size > 1024 * 1024
        ? deny('IA-HOOK-INPUT-INVALID', 'Input exceeds 1 MiB')
        : runHook(process.argv.slice(2), Buffer.concat(chunks).toString('utf8')),
    ) + '\n',
  );
}
