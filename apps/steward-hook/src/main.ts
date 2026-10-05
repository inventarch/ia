import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { evaluateSteward, isEntry, openDatabase } from '@inventarch/runtime';
import type { HookCode, StewardDecision } from '@inventarch/runtime';
import { pathKey, sameFile, unaliased } from '@inventarch/db';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { LIMITS, Session, State } from './analysis.js';
import type { Scope } from './analysis.js';
import { Unresolved } from './commands.js';
import type { Target } from './commands.js';
import { analyzePowerShell } from './powershell.js';
import { analyzeBash } from './shell.js';

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
      permissionDecisionReason: `${code}: ${message}`,
    },
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Rules match names as the volume does: case on win32; normalization and full case folding on darwin (#315, #323). */
const fold = pathKey;
function local(root: string, target: string): string | undefined {
  const rel = relative(fold(root), fold(target));
  return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ? undefined : rel.replaceAll('\\', '/');
}
function physical(path: string): string {
  try {
    lstatSync(path);
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physical(parent), relative(parent, path));
  }
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
/** The projection list written for this repository; in a consumer workspace only its owned subset stays protected. */
function projectionCandidate(path: string): boolean {
  return (
    path === '.codex/config.toml' ||
    /^\.codex\/agents\//.test(path) ||
    /^\.(?:agents|claude)\/skills\//.test(path) ||
    path === 'claude.md' ||
    path === 'CLAUDE.md' ||
    /^\.claude\/agents\/[^/]+\.md$/.test(path) ||
    ['.agents/skills/ia-authoring/SKILL.md', '.claude/skills/ia-authoring/SKILL.md'].some((p) => fold(p) === path) ||
    fold('.claude/rules/ia-workspace.md') === path ||
    fold('AGENTS.md') === path
  );
}
/** `ownership` is undefined in a legacy workspace (no projection state) and is read only when a candidate path needs it. */
function protection(path: string | undefined, ownership: () => Ownership | undefined): Rule | undefined {
  if (path === undefined) return undefined;
  if (installation(path)) return { projection: true };
  if (projectionCandidate(path)) {
    const owned = ownership();
    if (owned === undefined || owned.files.has(path) || (path === '.codex/config.toml' && owned.codex))
      return { projection: true };
  }
  if (path === '.ia/src/systems' || path.startsWith('.ia/src/systems/')) {
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
/** The same projection allowlist `@inventarch/distribution` writes (projection.ts), so a state cannot claim other paths. */
const PROJECTION_OWNED: Readonly<Record<'claude' | 'codex', (path: string) => boolean>> = {
  claude: (path) =>
    path === '.claude/rules/ia-workspace.md' ||
    path === '.claude/skills/ia-authoring/SKILL.md' ||
    /^\.claude\/agents\/[a-z][a-z0-9-]*\.md$/.test(path),
  codex: (path) => path === 'AGENTS.md' || path === '.agents/skills/ia-authoring/SKILL.md',
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
    const path = resolve(directory, `${host}-projection.json`);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || !unaliased(path, physical(path)))
      throw new Error('Unsafe projection ownership state');
    const content = readFileSync(path);
    if (content.length > 1024 * 1024) throw new Error('Projection ownership state exceeds its bound');
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
      guardPending = fold(name) === 'guard-pending.json';
    if (!guard && !guardPending && (!includeContext || (!match && !pending))) continue;
    const path = resolve(directory, name),
      stat = lstatSync(path),
      limit = pending || guardPending ? 8 * 1024 * 1024 : 1024 * 1024;
    if (
      name !== name.toLowerCase() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      !unaliased(path, physical(path))
    )
      throw new Error('Unsafe context ownership marker');
    const content = readFileSync(path);
    if (content.length > limit) throw new Error('Context ownership marker exceeds its bound');
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
      if (
        Object.keys(row).sort().join('|') !== 'after|before|format|id' ||
        row['format'] !== 'ia.guard-registration-pending.v1'
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
            state['format'] !== 'ia.guard-registration-state.v1' ||
            state['id'] !== row['id'] ||
            typeof state['cache'] !== 'string' ||
            !isAbsolute(state['cache'])
          )
            throw new Error('Invalid pending guard owner');
          launchers.push(resolve(state['cache'], 'scripts/ia.mjs'));
        }
      }
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
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const limit = 1024 * 1024;
  if (!before.isFile() || before.nlink !== 1 || before.size > limit || !unaliased(path, physical(path)))
    throw new Error('Unsafe source guard registration');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd),
      same = (value: Stats): boolean =>
        value.isFile() &&
        value.nlink === 1 &&
        value.dev === before.dev &&
        value.ino === before.ino &&
        value.size === before.size &&
        value.mtimeMs === before.mtimeMs &&
        value.ctimeMs === before.ctimeMs;
    if (!same(opened)) throw new Error('Source guard registration changed before read');
    const content = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = readSync(fd, content, size, content.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > limit || !same(fstatSync(fd)) || !same(lstatSync(path)) || !unaliased(path, physical(path)))
      throw new Error('Source guard registration changed while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}
/**
 * The matchers a registration of this guard carries: `ia host claude` writes the first (`GUARD_MATCHER` in
 * `apps/distribution/src/guard-registration.ts`), and a registration made before #540 routes only the file tools.
 */
const GUARD_MATCHERS: readonly string[] = ['Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell', 'Write|Edit|MultiEdit'];
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
      if (!object(group) || !GUARD_MATCHERS.includes(String(group['matcher'])) || !Array.isArray(group['hooks']))
        continue;
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
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Invalid actor map file');
  const content = readFileSync(path);
  if (content.length > 1024 * 1024) throw new Error('Actor map exceeds 1 MiB');
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
/** Ownership facts for one event, read once and only when a path needs them; every path the event names shares them. */
interface Place {
  readonly base: string;
  ownership(): Ownership | undefined;
  controls(includeContext: boolean): GuardControls;
  sourceGuard(): boolean;
}
function placer(base: string): Place {
  let owned: { readonly value: Ownership | undefined } | undefined, source: boolean | undefined;
  const controls = new Map<boolean, GuardControls>();
  return {
    base,
    ownership() {
      if (owned === undefined) owned = { value: projectionOwnership(base) };
      return owned.value;
    },
    controls(includeContext) {
      let found = controls.get(includeContext);
      if (!found) {
        found = contextSettingsManaged(base, includeContext);
        controls.set(includeContext, found);
      }
      return found;
    },
    sourceGuard() {
      if (source === undefined) source = sourceGuardRegistered(base);
      return source;
    },
  };
}
/** The rule that protects one absolute path; a protected path with an aliased ancestor or target throws. */
function place(context: Place, target: string): Rule | undefined {
  const { base } = context,
    actual = physical(target);
  // With neither spelling under the root as a string, either may still reach it through another namespace, so both are
  // placed by identity too (`anchored`); a rule found that way is held to the same alias check as any other.
  const lexical = local(base, target),
    physicalPath = local(base, actual),
    spellings = [lexical, physicalPath];
  if (lexical === undefined && physicalPath === undefined)
    spellings.push(anchored(base, target), anchored(base, actual));
  let rule = spellings.reduce<Rule | undefined>(
    (found, spelling) => found ?? protection(spelling, context.ownership),
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
    const controls = context.controls(localSettings),
      sourceGuard = (localSettings || projectSettings || sourceLauncher) && context.sourceGuard();
    const cacheLauncher =
      possibleCacheLauncher &&
      controls.launchers.some((path) => [target, actual].some((value) => fold(resolve(value)) === fold(resolve(path))));
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
  return rule;
}
/** The registered root as the volume stores it; a link or junction anywhere in it is refused. */
function fixedRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('Binding requires an absolute fixed project root');
  // Another case or normalization of the same directory is the same project, and every rule compares against this spelling.
  const base = resolve(root),
    real = realpathSync.native(base);
  if (!unaliased(base, real)) throw new Error('Project root is aliased');
  return real;
}
/** The steward decision for each system, from one fresh cache-disabled snapshot and the event's host identity. */
function stewards(
  base: string,
  event: Record<string, unknown>,
  actorsPath: string | undefined,
): (system: string) => StewardDecision {
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
    const actor = actors.length === 1 ? { kind: 'agent' as const, identity: actors[0]!.identity } : undefined;
    return (system) => evaluateSteward(records, system, actor);
  } finally {
    db.close();
  }
}
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export function evaluateHook(root: string, event: unknown, actorsPath?: string): HookOutput {
  if (
    object(event) &&
    event['hook_event_name'] === 'PreToolUse' &&
    object(event['tool_input']) &&
    (event['tool_name'] === 'Bash' || event['tool_name'] === 'PowerShell')
  )
    return evaluateShell(root, event, event['tool_name'], actorsPath);
  // NotebookEdit names its file `notebook_path`; it is judged exactly as the file tools are (#540).
  const key = object(event) && event['tool_name'] === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  if (
    !object(event) ||
    event['hook_event_name'] !== 'PreToolUse' ||
    !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(event['tool_name'])) ||
    !object(event['tool_input']) ||
    typeof event['tool_input'][key] !== 'string' ||
    !event['tool_input'][key].trim() ||
    event['tool_input'][key].includes('\0') ||
    (event['tool_name'] === 'MultiEdit' && !Array.isArray(event['tool_input']['edits']))
  )
    return deny('IA-HOOK-INPUT-INVALID', 'Expected a PreToolUse file edit event');
  let rule: Rule | undefined, base: string;
  try {
    base = fixedRoot(root);
    const path = event['tool_input'][key] as string;
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
        );
    rule = place(placer(base), target);
    if (rule?.invalid) throw new Error('Cannot identify the owning system');
  } catch (error) {
    return deny('IA-HOOK-PATH-UNSAFE', reason(error));
  }
  if (rule?.projection)
    return deny(
      'IA-HOOK-PROJECTION-MANAGED',
      'Use the owning command for generated state. Guard settings require a trusted operator edit outside intercepted assistant tools, preserving the guard, followed by registration qualification',
    );
  if (rule?.system === undefined) return {};
  try {
    const decision = stewards(base, event, actorsPath)(rule.system);
    return decision.allowed ? {} : deny(decision.code!, decision.message);
  } catch (error) {
    return deny('IA-HOOK-STEWARD-UNAVAILABLE', reason(error));
  }
}

/** Locations a tree write (recursive, or a directory's contents) reaches when they sit inside the directory it names. */
const ANCHORS = [
  '.ia/src/systems',
  '.ia/distributions.lock.json',
  '.ia/distributions',
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/rules/ia-workspace.md',
  '.claude/agents/steward.md',
  '.claude/skills/ia-authoring/SKILL.md',
  '.agents/skills/ia-authoring/SKILL.md',
  '.codex/agents/steward.toml',
  '.codex/config.toml',
  '.claude/settings.local.json',
  '.claude/settings.json',
  '.claude/hooks/steward-write.mjs',
];
function within(dir: string, path: string): boolean {
  const rel = relative(fold(resolve(dir)), fold(resolve(path)));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
/** A path that cannot exist (a component is a file, or a name is too long) cannot be written: no rule applies to it. */
function placeable(context: Place, path: string): Rule | undefined {
  try {
    return place(context, path);
  } catch (error) {
    if (['ENAMETOOLONG', 'ENOTDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}
/** The rules a written path falls under: its own, or, for a tree write, those of every protected location inside it. */
function protectedBy(context: Place, target: Target): { readonly rule: Rule; readonly path: string }[] {
  const own = placeable(context, target.path);
  if (own || !target.tree) return own ? [{ rule: own, path: target.path }] : [];
  let real: string;
  try {
    real = physical(target.path);
  } catch {
    real = target.path;
  }
  // A tree that holds the whole project (`rm -rf ..`, a git work tree around it) reaches every protected location in it.
  const prefixes =
    within(target.path, context.base) || within(real, context.base)
      ? ['']
      : [local(context.base, target.path), local(context.base, real)].filter(
          (path): path is string => path !== undefined,
        );
  const anchors = prefixes.length
    ? [...ANCHORS, ...(context.ownership()?.files ?? [])]
        .filter((anchor) =>
          prefixes.some((prefix) => prefix === '' || fold(anchor) === prefix || fold(anchor).startsWith(prefix + '/')),
        )
        .map((anchor) => resolve(context.base, anchor))
    : [];
  anchors.push(...context.controls(true).launchers.filter((launcher) => within(target.path, launcher)));
  return anchors.flatMap((anchor) => {
    const rule = placeable(context, anchor);
    return rule ? [{ rule, path: anchor }] : [];
  });
}
/**
 * File-writing calls the guard recognizes in inline code (Node, Python, Perl, Ruby, PowerShell and .NET), and calls that run
 * other programs. Code with none of them is taken to read what it names.
 */
const WRITES =
  /writeFile|appendFile|writeSync|createWriteStream|copyFile|cpSync|\bfs\.(?:rm|cp|rename|unlink|mkdir|truncate|chmod|chown|symlink|link|utimes)\b|rmSync|rmdir|unlinkSync|renameSync|mkdirSync|truncateSync|symlinkSync|(?<!std(?:out|err))\.write\s*\(|write_(?:text|bytes)|\bopen\s*\([^)]*['"](?:[wax]|r\+|>{1,2}|\+<)|os\.(?:remove|unlink|rename|replace|rmdir|removedirs|makedirs|mkdir|symlink|link|truncate|chmod)|shutil\.|\.(?:unlink|rename|touch|mkdir|rmdir)\s*\(|(?:json|pickle|yaml|toml)\.dump\s*\(|File\.(?:write|open|delete|rename|unlink)|\bunlink\b|WriteAll|AppendAll|\]::(?:Delete|Move|Copy|Replace|Create)|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content|\.(?:Delete|MoveTo|CopyTo|Create)\s*\(|execSync|execFileSync|spawnSync|\bexec\s*\(|\bspawn\s*\(|\bsystem\s*\(|subprocess\.|child_process/i;
/**
 * Paths that code text (inline interpreter code) names, when the code writes files: path-like tokens; a protected location
 * cut off by a computed prefix (`${root}/.ia/…`); and `.ia`, `src`, `systems` given as separate strings to be joined at run
 * time, which name every system's records.
 */
function mentions(text: string, cwd: string | undefined, scope: Scope, writes: boolean): Target[] {
  if (!writes && !WRITES.test(text)) return [];
  const out: Target[] = [],
    from = cwd ?? scope.root,
    separator = scope.platform === 'win32' ? '[\\\\/]' : '/';
  const cut = new RegExp(`^${separator}((?:\\.ia|\\.claude|\\.agents|\\.codex)${separator}.*)$`);
  for (const [token] of text.matchAll(/[^\s'"`,;(){}[\]<>|=+*?!&$]+/g)) {
    const path = token.replaceAll('\\\\', '/');
    if (!/[\\/]/.test(path) && !/^(?:CLAUDE|AGENTS)\.md$/i.test(path)) continue;
    out.push({ path: scope.resolve(from, path), tree: false });
    const tail = cut.exec(path)?.[1];
    if (tail !== undefined) out.push({ path: join(scope.root, tail), tree: false });
  }
  for (const [piece] of text.matchAll(
    /\.ia(?:['"`]\s*[,+]\s*['"`]|[\\/])src(?:['"`]\s*[,+]\s*['"`]|[\\/])systems|\.ia['"`]\s*[,+]\s*['"`]distributions/gi,
  )) {
    if (/['"`]/.test(piece))
      out.push({
        path: join(scope.root, /systems$/i.test(piece) ? '.ia/src/systems' : '.ia/distributions'),
        tree: false,
      });
  }
  return out;
}
const shown = (base: string, path: string): string => {
  const rel = relative(base, path);
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) ? rel.replaceAll('\\', '/') : path;
};
/**
 * Bash and PowerShell (#540): the command text is analyzed, never run (`shell.ts`, `powershell.ts`). Every path it shows
 * written is placed as a file-tool edit of that path would be. Generated state is refused to everyone; a system's records
 * only to anyone but its steward.
 */
function evaluateShell(
  root: string,
  event: Record<string, unknown>,
  route: 'Bash' | 'PowerShell',
  actorsPath: string | undefined,
): HookOutput {
  const command = (event['tool_input'] as Record<string, unknown>)['command'],
    cwd = event['cwd'];
  if (typeof command !== 'string' || !command.trim() || command.includes('\0'))
    return deny('IA-HOOK-INPUT-INVALID', 'Expected a Bash or PowerShell command string');
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    return deny('IA-HOOK-INPUT-INVALID', 'Shell input requires an absolute cwd');
  let base: string;
  try {
    base = fixedRoot(root);
  } catch (error) {
    return deny('IA-HOOK-PATH-UNSAFE', reason(error));
  }
  // A relative word lands where the kernel puts it, as for a file-tool path: from the directory's physical path on POSIX.
  const real = new Map<string, string>();
  const scope: Scope = {
    route,
    root: base,
    platform: process.platform,
    home: homedir(),
    resolve(from, word) {
      if (isAbsolute(word)) return resolve(word);
      if (process.platform === 'win32') return resolve(from, word);
      let directory = real.get(from);
      if (directory === undefined) {
        try {
          directory = physical(resolve(from));
        } catch {
          directory = resolve(from);
        }
        real.set(from, directory);
      }
      return resolve(directory, word);
    },
  };
  const session = new Session(scope, { bash: analyzeBash, powershell: analyzePowerShell });
  try {
    session.analyze(route === 'Bash' ? 'bash' : 'powershell', command, new State(resolve(cwd)), -1);
  } catch (error) {
    return deny(
      'IA-HOOK-SHELL-UNRESOLVED',
      `${route} command ${error instanceof Unresolved ? error.message : 'cannot be analyzed'}`,
    );
  }
  const context = placer(base),
    systems = new Map<string, string>(),
    seen = new Set<string>();
  for (const target of [
    ...session.writes,
    ...session.code.flatMap(({ text, cwd: from, writes }) => mentions(text, from, scope, writes)),
  ]) {
    const key = (target.tree ? '*' : '-') + target.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > LIMITS.paths)
      return deny('IA-HOOK-SHELL-UNRESOLVED', `${route} command names more than ${LIMITS.paths} paths`);
    let rules: { readonly rule: Rule; readonly path: string }[];
    try {
      rules = protectedBy(context, target);
    } catch (error) {
      return deny('IA-HOOK-PATH-UNSAFE', reason(error));
    }
    for (const { rule, path } of rules) {
      const writes = `${route} command writes ${shown(base, path)}`;
      if (rule.projection) return deny('IA-HOOK-SHELL-WRITE', `${writes}: Use the owning command for generated state`);
      if (rule.system === undefined) return deny('IA-HOOK-SHELL-WRITE', `${writes}: Cannot identify the owning system`);
      if (!systems.has(rule.system)) systems.set(rule.system, path);
    }
  }
  if (!systems.size) return {};
  try {
    const decide = stewards(base, event, actorsPath);
    for (const [system, path] of systems) {
      const decision = decide(system);
      if (!decision.allowed)
        return deny('IA-HOOK-SHELL-WRITE', `${route} command writes ${shown(base, path)}: ${decision.message}`);
    }
    return {};
  } catch (error) {
    return deny('IA-HOOK-STEWARD-UNAVAILABLE', reason(error));
  }
}
export function runHook(args: readonly string[], input: string): HookOutput {
  try {
    if (
      !(args.length === 2 || (args.length === 4 && args[2] === '--actors' && args[3])) ||
      args[0] !== '--root' ||
      !args[1] ||
      Buffer.byteLength(input) > 1024 * 1024
    )
      return deny(
        'IA-HOOK-INPUT-INVALID',
        'Usage: steward-hook --root <fixed absolute root> [--actors <trusted absolute mapping>] (input limit 1 MiB)',
      );
    return evaluateHook(args[1], JSON.parse(input) as unknown, args[3]);
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
