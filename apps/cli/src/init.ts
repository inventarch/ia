/**
 * `ia init`: docs/specs/consumer-cli-contract/README.md §2.1, implementing
 * docs/specs/workspace-initialization-apply/README.md (M5.2) to reach the end state
 * docs/specs/workspace-initialization/README.md (M5.1) fixes.
 *
 * Without `--apply` it prints the reviewable plan: the five owned paths, the target's classification (M5.2 §4.1),
 * the conflicts detected now, the starter it would write, the bundled base pin and the four steps. It exits 0
 * whether or not conflicts were found, because reporting them is the command's job.
 *
 * With `--apply` it runs M5.2 §3.1 in order — verify the pin, install the bundled base unless it is already
 * installed as planned, write `system.ia`, write `records/workspace.ia`, admit and read the `@distribution`
 * identity from the compiled graph, write `.ia/release.json` last — through the shared install services and
 * `createFile`. No journal is written: a rerun derives from the workspace which steps are done (§4.2). No step
 * performs a network request. `<directory>` is the only way to name the target: this verb never performs root
 * discovery, and `--root` is refused by the grammar rather than silently ignored.
 *
 * `--host claude` or `--host codex` (docs/specs/host-registration/README.md §4 "init --host") adds one
 * step after the four: once the workspace is initialized, the `ia host <host> --apply` path runs under the question
 * already answered here, so it never asks a second one. The plan names that step and writes nothing for it — the
 * host plan needs `.ia/release.json`, which only the apply writes. A host step that refuses leaves the workspace
 * initialized: the refusal keeps the service's code, message and location, and its next action names the rerun.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DISTRIBUTION_ENGINE_VERSION, INSTALL_PATHS } from '@ia/db/distribution';
import type { DistributionLock } from '@ia/db/distribution';
import { verifyArchive } from '@ia/distribution/archive';
import { assertHomeOutsideWorkspace } from '@ia/distribution/host-home';
import type { DeclineKind } from '@ia/distribution/decisions';
import { applyInstallation, cacheArchive, planInstallation } from '@ia/distribution/install';
import { resolveReleases } from '@ia/distribution/resolve';
import { createFile, openWorkspaceSession, readInstalledState, resolveCatalog } from '@ia/distribution/services';
import { parseArguments, UsageError } from './args.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { confirm, iaHomeOf, Interrupted, Refusal, refusalOf } from './consumer.js';
import { clearDecline, runDecline } from './decline.js';
import { CONFIRMATION } from './distribute.js';
import type { HostApplied } from './host.js';
import { applyHostSet, collectHost, hostNotes, rootedNext } from './host.js';
import { located } from './home-remedy.js';
import { codeOf } from './session.js';
import type { Capabilities, Field, SymbolName } from './render.js';
import { atom, document, entry, fieldRows, headerLine, quote, sectionLabel, truncateDigest, words } from './render.js';

export type HostSelection = 'claude' | 'codex' | 'none';
/** M5.2 §4.1. `recovery-required` is never rendered as a plan: it refuses before anything reasons about the target. */
export type TargetState = 'fresh' | 'resumable' | 'recovery-required' | 'conflict';
export type StepId = 'install' | 'system' | 'records' | 'descriptor';
export interface Conflict {
  readonly path: string;
  readonly reason: string;
}
export interface Step {
  readonly id: StepId;
  readonly status: 'pending' | 'done';
  readonly path: string;
}
/** M5.1 §3.2: the pin is the only authority for the bundled bytes. */
export interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}
export interface Base {
  readonly pin: BasePin;
  readonly bytes: Buffer;
  /** The systems the bundled manifest carries, sorted, which the starter composes and the descriptor externalizes. */
  readonly systems: readonly string[];
}
/** M5.1 §2.3's provenance, and which fact was missing when it is the unpublished local form. */
export type Missing = 'git' | 'checkout' | 'commit' | 'https-remote';
export interface Source {
  readonly repository: string | null;
  readonly commit: string | null;
  readonly recipe: 'ustar-v1';
  readonly epoch: number;
}
export interface Provenance {
  readonly source: Source;
  readonly missing: Missing | null;
}
export interface Descriptor {
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  /** Null in a plan: M5.1 §2.3 reads it from the compiled record at apply time and never constructs it. */
  readonly distribution: string | null;
  readonly engine: string;
  readonly language: readonly string[];
  readonly dependencies: readonly {
    readonly id: string;
    readonly range: string;
    readonly systems: readonly string[];
  }[];
  readonly assets: readonly never[];
  readonly license: string;
  readonly description: string;
  readonly source: Source;
}
export interface Starter {
  /** Null when neither `--id` nor the directory name yields a valid name; a conflict then asks for `--id`. */
  readonly name: string | null;
  readonly id: string | null;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly descriptor: Descriptor | null;
  readonly base: BasePin;
  readonly systems: readonly string[];
  readonly provenance: Provenance;
}
export interface InitView {
  readonly root: string;
  readonly owns: readonly { readonly path: string; readonly purpose: string }[];
  readonly state: TargetState;
  readonly conflicts: readonly Conflict[];
  /** M5.2 §4.3: temporary files a killed `createFile` left, which apply removes before writing. */
  readonly leftovers: readonly string[];
  readonly steps: readonly Step[];
  readonly starter: Starter;
  readonly host: HostSelection;
  /** What the target looked like, so the "no conflicts" line states a fact rather than a reassurance. */
  readonly directory: 'absent' | 'empty' | 'populated';
  readonly entries: number;
  /** The command that would apply this plan, rebuilt from what was parsed. */
  readonly invocation: string;
}
/** M5.2 §7: `generation` and `counter` are the base install's, whether it ran now or in an earlier invocation. */
export interface Applied {
  readonly status: 'initialized';
  readonly resumed: boolean;
  readonly id: string;
  readonly distribution: string;
  readonly generation: string;
  readonly counter: number;
  /** Host registration spec §4 "init --host": the host step's own result, present only when a host was selected. */
  readonly host?: HostApplied;
}

/**
 * Relative to the `@ia/cli` package root, as `assets/vocabulary.json` is (vocabulary.ts CATALOGUE_PATH). The base
 * package's id is read from this pin and appears nowhere in this source: M5.1 §3.2 makes the pin the only authority.
 */
export const PIN_PATH = 'assets/base.json';
export const baseArchivePath = (digest: string): string => `assets/base/${digest}.ia.tgz`;
export const DESCRIPTOR_PATH = '.ia/release.json';
export const STARTER_VERSION = '0.1.0';
/** The installer's lock, `acquire()` at apps/distribution/src/install.ts:70; `INSTALL_PATHS` does not name it. */
export const INSTALL_LOCK = '.ia/distributions/install-lock.json';
const cachePath = (digest: string): string => `.ia/distributions/cache/${digest}.ia.tgz`;
const systemFolder = (name: string): string => `.ia/src/systems/${name}`;
const systemPath = (name: string): string => `${systemFolder(name)}/system.ia`;
const recordsPath = (name: string): string => `${systemFolder(name)}/records/workspace.ia`;
/** `packages/db/src/distribution/codec.ts` packageId and identifier: the id rule and the system-name ceiling. */
export const PACKAGE_ID = /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*$/;
const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_LIMIT = 64;
/** M5.2 §4.3: `createFile`'s temporary name, `<target>.<randomUUID()>.tmp` (apps/distribution/src/files.ts:76). */
export const LEFTOVER =
  /^(system\.ia|workspace\.ia|release\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const DAMAGED = 'The ia installation is damaged; reinstall @ia/cli.';

/** M5.1 §2.1: the three M4 paths plus the starter system folder and the release descriptor. */
export function ownedPaths(name: string | null): readonly { readonly path: string; readonly purpose: string }[] {
  return [
    { path: '.ia/src/', purpose: 'authored records' },
    { path: `${systemFolder(name ?? '<name>')}/`, purpose: 'the starter system, written once' },
    { path: DESCRIPTOR_PATH, purpose: 'the release descriptor, written once' },
    { path: INSTALL_PATHS.lock, purpose: 'direct requests and resolved versions' },
    { path: '.ia/distributions/', purpose: 'install state, store and generations' },
  ];
}

/** §2.1: an existing directory, or a single new segment under an existing directory. Anything else is usage. */
export function resolveTarget(cwd: string, supplied: string | undefined): string {
  const target =
    supplied === undefined ? resolve(cwd) : isAbsolute(supplied) ? resolve(supplied) : resolve(cwd, supplied);
  const here = statSync(target, { throwIfNoEntry: false });
  if (here !== undefined && !here.isDirectory())
    throw new Refusal(
      'IA-CLI-USAGE',
      `${target} is not a directory`,
      2,
      { path: target },
      'Name an existing directory, or one new directory inside an existing one.',
    );
  if (here === undefined) {
    const parent = statSync(dirname(target), { throwIfNoEntry: false });
    if (parent === undefined || !parent.isDirectory())
      throw new Refusal(
        'IA-CLI-USAGE',
        `${dirname(target)} is not an existing directory`,
        2,
        { path: target },
        'Create the parent directory first, or name one that exists.',
      );
  }
  // The directory the user chose may be reached through links (macOS /tmp, a linked checkout); it is initialized at
  // its real path, as every other verb opens a supplied --root (`requireRoot`). Links below it stay refused.
  return here === undefined ? join(realpathSync(dirname(target)), basename(target)) : realpathSync(target);
}

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * M5.1 §3.2 and §5: read the pin and verify the bytes against it, never falling back to another file. A missing
 * archive is read as no bytes, so the archive verifier's own refusal reports it; a pin that cannot be read at all
 * has no digest to verify against and is the CLI's own failure. Either way the next action says the installation is
 * damaged, because nothing the user did to the target can cause it.
 */
export function readBase(packageRoot: string): Base {
  const pinPath = resolve(packageRoot, PIN_PATH);
  let pin: BasePin;
  try {
    const value = JSON.parse(readFileSync(pinPath, 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (
      keys !== 'archive,id,manifest,version' ||
      !Object.values(value).every((item) => typeof item === 'string') ||
      !PACKAGE_ID.test(String(value['id']))
    )
      throw new Error('unexpected fields');
    if (!/^[a-f0-9]{64}$/.test(String(value['archive'])) || !/^[a-f0-9]{64}$/.test(String(value['manifest'])))
      throw new Error('malformed digest');
    pin = value as unknown as BasePin;
  } catch (error) {
    throw new Refusal(
      'IA-CLI-FAILED',
      `The bundled base package pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { path: pinPath },
      DAMAGED,
    );
  }
  const archivePath = resolve(packageRoot, baseArchivePath(pin.archive));
  const bytes = existsSync(archivePath) ? readFileSync(archivePath) : Buffer.alloc(0);
  try {
    const verified = verifyArchive(bytes, pin.archive);
    if (
      verified.manifestDigest !== pin.manifest ||
      verified.manifest.id !== pin.id ||
      verified.manifest.version !== pin.version
    )
      throw new Refusal(
        'IA-CLI-FAILED',
        'The bundled base archive does not carry the pinned manifest',
        3,
        { path: archivePath },
        DAMAGED,
      );
    return { pin, bytes, systems: verified.manifest.systems.map((system) => system.name) };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(
      codeOf(error, 'IA-CLI-FAILED'),
      error instanceof Error ? error.message : String(error),
      3,
      { path: archivePath },
      DAMAGED,
    );
  }
}

/** M5.1 §2.3's normalization: lowercase, every run outside `[a-z0-9-]` becomes `-`, no leading or trailing `-`. */
export const normalizeName = (directory: string): string =>
  directory
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** M5.1 §2.3: valid only if the name, the full id and the public-system rule all hold. Nothing is invented. */
export function starterIdentity(
  root: string,
  supplied: string | undefined,
  systems: readonly string[],
): { readonly name: string | null; readonly id: string | null; readonly conflict: Conflict | null } {
  const name = supplied === undefined ? normalizeName(basename(root)) : supplied.slice(supplied.indexOf('/') + 1);
  const id = supplied ?? `local/${name}`;
  const ask = supplied === undefined ? 'pass --id <provider/name>' : 'pass another --id';
  const refused = (reason: string) => ({ name: null, id: null, conflict: { path: root, reason } });
  if (!NAME.test(name) || !PACKAGE_ID.test(id) || id.includes('..'))
    return refused(`The directory name "${basename(root)}" does not normalize to a package name; ${ask}`);
  if (name.length > NAME_LIMIT) return refused(`The name "${name}" is longer than a system name may be; ${ask}`);
  if (systems.includes(name))
    return refused(`"${name}" is the name of a public system the base package installs; ${ask}`);
  return { name, id, conflict: null };
}

/**
 * M5.1 §2.2, verbatim in shape: the steward needs `agent-system`, and `governance` is required. `work-system` is
 * required so a fresh workspace can author `@plan`, `@milestone`, `@task` and `@decision` records with no edit: a
 * system may use only words owned by systems it directly requires (operator decision, 2026-09-25).
 */
export function starterSystem(name: string): string {
  return [
    '#! ia 1.0',
    '',
    `@system ${name}`,
    '  provider "local"',
    `  version "${STARTER_VERSION}"`,
    `  describes "The authored records of the ${name} workspace."`,
    `  steward @agent ${name}-steward`,
    '  requires',
    '    - agent-system',
    '    - work-system',
    '    - workspace-system',
    '',
    `@agent ${name}-steward`,
    '  meaning',
    `    says "Owns the ${name} system and its records."`,
    '    answers "Who owns this system?"',
    '  governance',
    '    applies []',
    '',
  ].join('\n');
}
/** M5.1 §2.2: the workspace composes every installed system, so nothing installed is unreachable. */
export function starterRecords(name: string, systems: readonly string[]): string {
  return [
    '#! ia 1.0',
    '',
    `@workspace ${name}`,
    '  meaning',
    `    says "The ${name} workspace and the public systems it composes."`,
    '    answers "Which systems does this workspace compose?"',
    '  composition',
    `    systems [${systems.map((system) => `@system ${system}`).join(', ')}]`,
    '',
    `@distribution ${name}-distribution`,
    '  meaning',
    `    says "The release root of the ${name} workspace."`,
    '    answers "Which records does this release ship?"',
    '  distribution',
    `    records [@workspace ${name}]`,
    '',
  ].join('\n');
}

export type Git = (args: readonly string[]) => { readonly status: number | null; readonly stdout: string } | null;
/**
 * Git as a child process, with the host's environment rather than this process's, so the probe is a function of the
 * same explicit host every verb receives. `core.fsmonitor` is disabled because it is the configured command a
 * read-only query could otherwise start. A missing executable is `null`, which is not the same fact as "no checkout".
 */
export const gitIn =
  (cwd: string, env: Readonly<Record<string, string | undefined>>): Git =>
  (args) => {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return gitAnswer(result);
  };
/** `packages/db/src/distribution/contracts.ts` url(): canonical, credential-free HTTPS without query or fragment. */
const canonicalHttps = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.href === value
    );
  } catch {
    return false;
  }
};
const LOCAL: Source = { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 };
/**
 * M5.1 §2.3. Sourced only from a Git checkout with a commit and an HTTPS remote: `origin` when it exists, else the
 * first remote Git lists. The remote's configured URL is read as written, so an SSH remote is "no HTTPS remote" and
 * is never rewritten into a guessed HTTPS one; a URL carrying credentials is refused the same way rather than copied
 * into a file meant to be committed.
 */
export function readProvenance(git: Git): Provenance {
  const local = (missing: Missing): Provenance => ({ source: LOCAL, missing });
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside === null) return local('git');
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return local('checkout');
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const commit = head?.stdout.trim() ?? '';
  if (head?.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return local('commit');
  const remotes = (git(['remote'])?.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (remote === undefined) return local('https-remote');
  const repository = git(['config', '--get', `remote.${remote}.url`])?.stdout.trim() ?? '';
  if (!canonicalHttps(repository)) return local('https-remote');
  const epoch = Number(git(['log', '-1', '--format=%ct', commit])?.stdout.trim());
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8_589_934_591) return local('commit');
  return { source: { repository, commit, recipe: 'ustar-v1', epoch }, missing: null };
}
const MISSING: Readonly<Record<Missing, string>> = {
  git: 'Git is not available to this process',
  checkout: 'the target is not a Git checkout',
  commit: 'the checkout has no commit',
  'https-remote': 'the checkout has no HTTPS remote',
};

/** M5.1 §2.3's table. `distribution` stays null until the compiled record is read (§3.1 step 6). */
export function starterDescriptor(
  id: string,
  name: string,
  base: Base,
  provenance: Provenance,
  distribution: string | null = null,
): Descriptor {
  return {
    formatVersion: 1,
    id,
    version: STARTER_VERSION,
    distribution,
    engine: `^${DISTRIBUTION_ENGINE_VERSION}`,
    language: ['1.0'],
    dependencies: [{ id: base.pin.id, range: `^${base.pin.version}`, systems: base.systems }],
    assets: [],
    license: 'UNLICENSED',
    description: `The ${name} workspace.`,
    source: provenance.source,
  };
}
/** Two-space JSON with a final newline; `decodeReleaseDescriptor` requires the dependency rows sorted, as they are. */
export const descriptorText = (descriptor: Descriptor): string => JSON.stringify(descriptor, null, 2) + '\n';

/** M5.2 §4.1: exactly the one request and the one package the pin describes. */
export const locksBase = (lock: DistributionLock | undefined, pin: BasePin): boolean =>
  lock !== undefined &&
  lock.requests.length === 1 &&
  lock.requests[0]!.id === pin.id &&
  lock.requests[0]!.range === `^${pin.version}` &&
  lock.packages.length === 1 &&
  lock.packages[0]!.id === pin.id &&
  lock.packages[0]!.version === pin.version &&
  lock.packages[0]!.archive === pin.archive &&
  lock.packages[0]!.manifest === pin.manifest;

/** Every regular file, link or other entry below `path`, root-relative with `/`, in sorted order. */
function filesBelow(root: string, path: string): readonly string[] {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(resolve(root, relative)).sort()) {
      const child = `${relative}/${name}`;
      const stat = lstatSync(resolve(root, child));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
      else found.push(child);
    }
  };
  walk(path);
  return found;
}

export interface InitRequest {
  readonly root: string;
  readonly host: HostSelection;
  readonly id?: string | undefined;
  readonly packageRoot: string;
  readonly git: Git;
  readonly invocation?: string;
}
/**
 * M5.2 §4.1. The starter bytes compared are what this invocation would write for its resolved id: they depend only
 * on the name and the bundled manifest, so they are recomputed on every run instead of being journaled.
 */
export function collectInit(request: InitRequest): InitView {
  const { root, host } = request;
  const base = readBase(request.packageRoot);
  const conflicts: Conflict[] = [];
  const present = existsSync(root);
  const entries = present ? readdirSync(root).length : 0;
  const identity = starterIdentity(root, request.id, base.systems);
  if (identity.conflict !== null) conflicts.push(identity.conflict);
  const { name, id } = identity;
  const provenance = readProvenance(request.git);
  const files =
    name === null
      ? []
      : [
          { path: systemPath(name), text: starterSystem(name) },
          { path: recordsPath(name), text: starterRecords(name, base.systems) },
        ];
  const leftovers: string[] = [];
  const written = new Set<string>();
  let lock = false,
    installed = false;
  if (present) {
    // readInstalledState refuses while `.ia/distributions/pending.json` exists, which is M5.2 §4.1's
    // recovery-required: an interrupted apply must be recovered before anything reasons about this workspace.
    // Its rows are held back so the plan lists authored source, then the lock, then install state, as M4 did.
    const installation: Conflict[] = [];
    // M5.2 §4.1: a held or abandoned install lock is recovery-required too. A process killed inside
    // applyInstallation skips the `finally` that releases it (apps/distribution/src/install.ts:67-97), before
    // `pending` exists and after it is removed. `ia-distribution recover` clears a dead holder's lock and refuses a
    // live one (`acquire(root, true)`, install.ts:71), so it is the remedy whether or not a journal exists; the
    // journal case keeps the reader's own refusal below.
    if (!existsSync(resolve(root, INSTALL_PATHS.pending)) && existsSync(resolve(root, INSTALL_LOCK)))
      throw new Refusal(
        'IA-CLI-RECOVERY-REQUIRED',
        `An installer holds or left the install lock ${INSTALL_LOCK}`,
        3,
        { path: root },
        `If no installer is running, run "ia-distribution recover --root ${root}" before initializing this directory.`,
      );
    try {
      const state = readInstalledState({ root });
      if (state.status === 'installed') {
        if (locksBase(state.lock, base.pin)) installed = true;
        else installation.push({ path: INSTALL_PATHS.active, reason: 'A generation is already installed and active' });
      }
    } catch (error) {
      const code = codeOf(error, 'IA-CLI-FAILED');
      if (code !== 'IA-DB-SOURCE-UNAVAILABLE') throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (existsSync(resolve(root, INSTALL_PATHS.pending)))
        throw new Refusal(
          code,
          message,
          3,
          { path: root },
          `Run "ia-distribution recover --root ${root}" before initializing this directory.`,
        );
      // Any other unreadable installation state is a conflict the plan reports, with the reader's own words.
      installation.push({ path: '.ia/distributions/', reason: message });
    }
    const leftoverDirectories = new Set([
      '.ia',
      ...(name === null ? [] : [systemFolder(name), `${systemFolder(name)}/records`]),
    ]);
    const leftover = (path: string): boolean => leftoverDirectories.has(dirname(path)) && LEFTOVER.test(basename(path));
    if (existsSync(resolve(root, '.ia')))
      for (const entry of readdirSync(resolve(root, '.ia')).sort())
        if (leftover(`.ia/${entry}`)) leftovers.push(`.ia/${entry}`);
    const foreign: string[] = [];
    for (const path of filesBelow(root, '.ia/src')) {
      const planned = files.find((file) => file.path === path);
      if (planned !== undefined) {
        const stat = lstatSync(resolve(root, path));
        if (stat.isFile() && readFileSync(resolve(root, path)).equals(Buffer.from(planned.text))) written.add(path);
        else conflicts.push({ path, reason: 'Differs from the starter this initialization writes' });
      } else if (leftover(path)) leftovers.push(path);
      else if (name !== null && path.startsWith(`${systemFolder(name)}/`))
        conflicts.push({ path, reason: 'A file this initialization does not write' });
      else foreign.push(path);
    }
    if (foreign.length > 0)
      conflicts.push({
        path: '.ia/src',
        reason: `The target already holds authored records this initialization did not write, starting with ${foreign[0]}`,
      });
    lock = existsSync(resolve(root, INSTALL_PATHS.lock));
    if (lock && !installed)
      conflicts.push({
        path: INSTALL_PATHS.lock,
        reason: 'A lock already names direct requests and resolved versions',
      });
    conflicts.push(...installation);
    // M5.2 §4.1: a completed initialization is a conflict, because the starter now belongs to the user (band 100).
    if (existsSync(resolve(root, DESCRIPTOR_PATH)))
      conflicts.push({ path: DESCRIPTOR_PATH, reason: 'The target is already initialized' });
  }
  if (!writable(present ? root : dirname(root)))
    conflicts.push({
      path: present ? root : dirname(root),
      reason: 'The directory that would be written is not writable by this process',
    });
  const untouched =
    !existsSync(resolve(root, '.ia/src')) && !lock && !installed && !existsSync(resolve(root, DESCRIPTOR_PATH));
  const state: TargetState =
    conflicts.length > 0 ? 'conflict' : untouched && leftovers.length === 0 ? 'fresh' : 'resumable';
  const steps: readonly Step[] = [
    { id: 'install', status: installed ? 'done' : 'pending', path: INSTALL_PATHS.lock },
    {
      id: 'system',
      status: name !== null && written.has(systemPath(name)) ? 'done' : 'pending',
      path: name === null ? '' : systemPath(name),
    },
    {
      id: 'records',
      status: name !== null && written.has(recordsPath(name)) ? 'done' : 'pending',
      path: name === null ? '' : recordsPath(name),
    },
    { id: 'descriptor', status: 'pending', path: DESCRIPTOR_PATH },
  ];
  return {
    root,
    owns: ownedPaths(name),
    state,
    conflicts,
    leftovers: leftovers.sort(),
    steps,
    starter: {
      name,
      id,
      files,
      descriptor: id === null || name === null ? null : starterDescriptor(id, name, base, provenance),
      base: base.pin,
      systems: base.systems,
      provenance,
    },
    host,
    directory: present ? (entries === 0 ? 'empty' : 'populated') : 'absent',
    entries,
    invocation: request.invocation ?? 'ia init',
  };
}

export interface ApplyOptions {
  readonly packageRoot: string;
  readonly signal?: AbortSignal | undefined;
  /**
   * Called with every `applyInstallation` checkpoint name (`store:*`, `manifest:*`, `generation:*`, `pending`,
   * `portable-lock`, `active`, `complete`) and with `init:<step>` after each of the four steps completes, so a test
   * can interrupt at exactly the boundaries M5.2 §8 item 2 names.
   */
  readonly checkpoint?: (name: string) => void;
}
/**
 * M5.2 §3.1 steps 2–7, in that order. Each step either completes or leaves a state `collectInit` classifies as
 * resumable or recovery-required. The signal is observed at step boundaries (§5): before the first write it is the
 * plain interruption and the target is byte-identical; after one, the interruption names the rerun that finishes.
 */
export async function applyInit(view: InitView, options: ApplyOptions): Promise<Applied> {
  const { root, starter } = view;
  if (view.state !== 'fresh' && view.state !== 'resumable') throw conflictRefusal(view);
  const { name, id } = starter;
  if (name === null || id === null) throw conflictRefusal(view);
  const checkpoint = options.checkpoint ?? (() => {});
  const resume = new Interrupted(`Run "${view.invocation} --apply --yes" again to finish initializing.`);
  const boundary = (step: StepId): void => {
    checkpoint(`init:${step}`);
    if (options.signal?.aborted) throw resume;
  };
  // Step 2. The pin is read again rather than trusted from the plan, and must still be the one the plan showed.
  const base = readBase(options.packageRoot);
  if (base.pin.archive !== starter.base.archive || base.pin.manifest !== starter.base.manifest)
    throw new Refusal(
      'IA-CLI-FAILED',
      'The bundled base package changed while planning',
      3,
      { path: resolve(options.packageRoot, PIN_PATH) },
      DAMAGED,
    );
  options.signal?.throwIfAborted();
  // The last point at which the target is byte-identical to its state before the command (§5).
  mkdirSync(root, { recursive: true });
  for (const path of view.leftovers) unlinkSync(resolve(root, path));
  const step = (id: StepId): Step => view.steps.find((row) => row.id === id)!;
  // Step 3: M5.1 §4's three calls, offline, resolved the way `ia install` resolves (distribute.ts collectPlan).
  if (step('install').status === 'pending') {
    try {
      cacheArchive(root, base.bytes, base.pin.archive);
      const choices = await resolveCatalog({
        root,
        entries: [{ path: cachePath(base.pin.archive), withdrawn: false }],
        offline: true,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      const lock = resolveReleases(
        [{ id: base.pin.id, range: `^${base.pin.version}` }],
        choices,
        DISTRIBUTION_ENGINE_VERSION,
      ).lock;
      applyInstallation(planInstallation(root, lock, 'install'), { checkpoint });
    } catch (error) {
      if (options.signal?.aborted) throw resume;
      // collectInit already refuses a lock present at planning time; this is another installer taking it between
      // planning and apply. The installer's code is kept (§4.1 of the contract); the next action names the recovery
      // that clears the lock if that installer has since died.
      if (codeOf(error, '') === 'IA-DIST-INSTALL-BUSY')
        throw new Refusal(
          'IA-DIST-INSTALL-BUSY',
          error instanceof Error ? error.message : String(error),
          3,
          { path: root },
          `If no installer is running, an interrupted one left its lock: run "ia-distribution recover --root ${root}", then "${view.invocation} --apply --yes" again.`,
        );
      throw error;
    }
  }
  boundary('install');
  // Steps 4 and 5: create-only, so an existing byte-equal file is skipped and nothing is ever rewritten.
  for (const [id, text] of [
    ['system', starter.files[0]!.text],
    ['records', starter.files[1]!.text],
  ] as const) {
    if (step(id).status === 'pending') createFile(root, step(id).path, Buffer.from(text));
    boundary(id);
  }
  // Step 6: the identity is read from the compiled graph, never string-constructed (M5.1 §2.3).
  const session = openWorkspaceSession({ root });
  let distribution: string;
  try {
    const errors = session.admission().findings.filter((finding) => finding.severity === 'error');
    if (errors.length > 0)
      throw new Refusal(
        'IA-CLI-FAILED',
        `The initialized workspace failed admission with ${errors.length} error findings; first: ${errors[0]!.code}`,
        3,
        { path: root },
        `Run "ia validate --root ${root}" for the findings.`,
      );
    const record = session.reader
      .records()
      .find(
        (node) =>
          node.discriminator === 'distribution' &&
          node.name === `${name}-distribution` &&
          node.source.path === recordsPath(name),
      );
    if (record === undefined)
      throw new Refusal(
        'IA-CLI-FAILED',
        `The compiled workspace has no @distribution ${name}-distribution in ${recordsPath(name)}`,
        3,
        { path: root },
      );
    distribution = record.identity;
  } finally {
    session.close();
  }
  // Step 7, the completion point (§4.1).
  createFile(
    root,
    DESCRIPTOR_PATH,
    Buffer.from(descriptorText(starterDescriptor(id, name, base, starter.provenance, distribution))),
  );
  checkpoint('init:descriptor');
  const installed = readInstalledState({ root });
  return {
    status: 'initialized',
    resumed: view.state === 'resumable',
    id,
    distribution,
    generation: installed.pointer!.generation,
    counter: installed.pointer!.counter,
  };
}

/** M5.2 §4.1: every conflict is listed; `--apply` refuses at class 3 and writes nothing. */
function conflictRefusal(view: InitView): Refusal {
  const message =
    view.conflicts.length === 1
      ? `${view.conflicts[0]!.reason}: ${view.conflicts[0]!.path}`
      : `${view.conflicts.length} conflicts block initialization: ${view.conflicts.map((row) => `${row.path} (${row.reason})`).join('; ')}`;
  return new Refusal(
    'IA-CLI-CONFLICT',
    message,
    3,
    { path: view.root },
    `Run "${view.invocation}" without --apply to review the plan and its conflicts.`,
  );
}

export function initEnvelope(view: InitView, apply: boolean, applied: Applied | null = null): unknown {
  const { starter } = view;
  return {
    version: 1,
    command: 'init',
    root: view.root,
    apply,
    plan: {
      state: view.state,
      owns: view.owns.map((row) => row.path),
      conflicts: view.conflicts.map((row) => ({ path: row.path, reason: row.reason })),
      leftovers: view.leftovers.map((path) => ({ path, reason: 'leftover temporary file' })),
      steps: view.steps.map((row) => ({ id: row.id, status: row.status })),
      starter: {
        id: starter.id,
        paths: [...starter.files.map((file) => file.path), ...(starter.descriptor === null ? [] : [DESCRIPTOR_PATH])],
        descriptor: starter.descriptor,
        base: starter.base,
        provenance: {
          status: starter.provenance.missing === null ? 'sourced' : 'local',
          missing: starter.provenance.missing,
        },
      },
      // `planned`: the host step runs after initialization, so its own plan cannot be shown before the workspace exists.
      host: { selected: view.host, status: view.host === 'none' ? 'none' : 'planned' },
    },
    ...(applied === null ? {} : { applied }),
  };
}

const settled = (view: InitView): string =>
  view.directory === 'absent'
    ? 'None. The target directory does not exist yet.'
    : view.directory === 'empty'
      ? 'None. The target directory is empty.'
      : `None. The target directory holds ${view.entries} ${view.entries === 1 ? 'entry' : 'entries'}, none of them conflicting.`;

const STEP_LABEL: Readonly<Record<StepId, string>> = {
  install: 'Install',
  system: 'System',
  records: 'Records',
  descriptor: 'Descriptor',
};
const stepValue = (view: InitView, step: Step): string => {
  const pin = view.starter.base;
  const what =
    step.id === 'install'
      ? `${pin.id} ${pin.version} from the bundled archive`
      : step.path === ''
        ? 'needs a valid name'
        : step.path;
  return step.status === 'done' ? `${what}; already present` : what;
};
const stepRows = (view: InitView, symbol: (step: Step) => SymbolName, caps: Capabilities): readonly string[] => [
  sectionLabel('Steps', caps),
  ...fieldRows(
    view.steps.map((step) => ({
      symbol: symbol(step),
      label: STEP_LABEL[step.id],
      value: words(stepValue(view, step)),
    })),
    { depth: 1 },
    caps,
  ),
];
const provenanceText = (provenance: Provenance): string =>
  provenance.missing === null
    ? `${provenance.source.repository} at ${provenance.source.commit!.slice(0, 12)}`
    : `Unpublished local; ${MISSING[provenance.missing]}`;
/** M5.1 §7 item 4: the starter row carries the real contents rather than the plan task that specified them. */
const starterRows = (view: InitView, caps: Capabilities): readonly string[] => {
  const { starter } = view,
    pin = starter.base;
  const rows: Field[] =
    starter.name === null || starter.id === null
      ? [{ symbol: 'info', label: 'Starter records', value: words('Not planned until the target has a valid name') }]
      : [
          {
            symbol: 'info',
            label: 'Starter records',
            value: words(
              `@system ${starter.name} and its steward; @workspace ${starter.name} composing ${starter.systems.length} systems; @distribution ${starter.name}-distribution`,
            ),
          },
          {
            symbol: 'info',
            label: 'Release',
            value: words(`${starter.id} ${STARTER_VERSION}, requiring ${pin.id} ^${pin.version}`),
          },
          { symbol: 'info', label: 'Provenance', value: words(provenanceText(starter.provenance)) },
        ];
  return [
    sectionLabel('Starter', caps),
    ...fieldRows(
      [
        ...rows,
        {
          symbol: 'info',
          label: 'Base package',
          value: [atom(`${pin.id} ${pin.version}`), atom(`sha256 ${truncateDigest(pin.archive, caps.ascii)}`, null, 2)],
        },
      ],
      { depth: 1 },
      caps,
    ),
  ];
};
const planBlocks = (view: InitView, caps: Capabilities): readonly (readonly string[])[] => {
  const conflicts: readonly Field[] = view.conflicts.map((row) => ({
    symbol: 'warning' as const,
    label: row.path,
    value: words(row.reason),
  }));
  return [
    [
      sectionLabel('Would own', caps),
      ...fieldRows(
        view.owns.map((row) => ({ symbol: 'added' as const, label: row.path, value: words(row.purpose) })),
        { depth: 1 },
        caps,
      ),
    ],
    [
      sectionLabel('Conflicts', caps),
      ...(conflicts.length === 0
        ? entry([words(settled(view))], { depth: 1, symbol: 'success' }, caps)
        : fieldRows(conflicts, { depth: 1 }, caps)),
    ],
    ...(view.leftovers.length === 0
      ? []
      : [
          [
            sectionLabel('Leftovers', caps),
            ...fieldRows(
              view.leftovers.map((path) => ({
                symbol: 'removed' as const,
                label: path,
                value: words('leftover temporary file; removed before writing'),
              })),
              { depth: 1 },
              caps,
            ),
          ],
        ]),
    starterRows(view, caps),
    stepRows(view, (step) => (step.status === 'done' ? 'success' : 'added'), caps),
    [
      sectionLabel('Host', caps),
      ...fieldRows(
        [
          view.host === 'none'
            ? { symbol: 'info', label: 'Host integration', value: words('--host none selected; no host is registered') }
            : {
                symbol: 'added',
                label: 'Host integration',
                value: words(`--host ${view.host} selected; registered after initialization by ia host`),
              },
        ],
        { depth: 1 },
        caps,
      ),
    ],
  ];
};

export function renderInit(view: InitView, caps: Capabilities): string {
  const next =
    view.state === 'conflict'
      ? `Resolve the conflicts above, then run "${view.invocation} --apply --yes".`
      : `Apply with "${view.invocation} --apply --yes".${view.state === 'resumable' ? ' Completed steps are skipped.' : ''}`;
  return document(
    [
      headerLine('Plan', 'init', [{ text: view.root, column: 50 }], caps),
      entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps),
      ...planBlocks(view, caps),
      entry([words(next)], { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );
}
/** §2.8 rule 3's change summary for `init`: the plan's own blocks without the preview note or the footer. */
export const renderInitSummary = (view: InitView, caps: Capabilities): string =>
  document([headerLine('Plan', 'init', [{ text: view.root, column: 50 }], caps), ...planBlocks(view, caps)], {
    leadingBlank: true,
  });

export function renderApplied(view: InitView, applied: Applied, caps: Capabilities): string {
  return document(
    [
      headerLine('Init', applied.id, [{ text: view.root, column: 50 }], caps),
      entry(
        [
          words(
            `${applied.resumed ? 'Finished initializing' : 'Initialized'} ${applied.id}; release descriptor ${DESCRIPTOR_PATH}.`,
          ),
          words(`Installed generation ${truncateDigest(applied.generation, caps.ascii)}, counter ${applied.counter}.`),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      // Host registration spec §4: written is all this can say; `ia doctor` reports what is observed.
      ...(applied.host === undefined
        ? []
        : [
            entry(
              [words(`Registered with ${view.host}; written, not observed answering.`)],
              { depth: 1, symbol: 'success' },
              caps,
            ),
          ]),
      stepRows(view, () => 'success', caps),
      // Spec §5.3 and §5.4: the notes `ia host` prints after a registration, from the same function.
      ...(applied.host === undefined || view.host === 'none' ? [] : hostNotes(view.host, caps)),
      entry(
        [
          words(
            'Run "ia validate" to check the workspace, or "ia pack --descriptor .ia/release.json" to build its release.',
          ),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}
const renderDeclined = (view: InitView, caps: Capabilities): string =>
  document(
    [
      entry([words('Nothing was applied.')], { depth: 0, symbol: 'info' }, caps),
      entry([words(`Apply with "${view.invocation} --apply --yes".`)], { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );

function invocationOf(context: Context): string {
  const { args } = context;
  const parts = ['ia init', ...args.positionals.map(quote)];
  const id = args.value('id'),
    host = args.value('host');
  if (id !== undefined) parts.push('--id', quote(id));
  if (host !== undefined && host !== 'none') parts.push('--host', host);
  return parts.join(' ');
}

export async function runInit(context: Context): Promise<Result> {
  const { args, caps, json, host } = context;
  const id = args.value('id');
  // A malformed identity is usage (§3), decided before the target is read.
  if (id !== undefined && (!PACKAGE_ID.test(id) || id.includes('..')))
    throw new UsageError(`--id must be <provider/name>; got ${id}`);
  const root = resolveTarget(host.cwd, args.positionals[0]);
  // Host plugin distribution spec §7.2: a decline is recorded before anything about the target is written or git is run.
  // It reports the target as typed, resolved to an absolute path; its decision key resolves links itself.
  const decline = args.value('decline') as DeclineKind | undefined;
  if (decline !== undefined || args.flag('forget-decline'))
    return runDecline(context, resolve(host.cwd, args.positionals[0] ?? '.'), decline);
  // Host plugin distribution spec §3: a workspace is never created in, around or inside the IA home, and the service
  // raises IA-DIST-PATH-UNSAFE for either nesting, as `ia host` does. A malformed IA_HOME is left to the verbs that
  // need the home, so `ia init --host none` behaves as before (contract §2.1).
  const iaHome = iaHomeOf(host.env);
  if (iaHome !== undefined)
    located(root, 'Initialize a different directory, or set IA_HOME to an absolute directory outside it.', () =>
      assertHomeOutsideWorkspace(iaHome, root),
    );
  const selected = (args.value('host') ?? 'none') as HostSelection;
  const apply = args.flag('apply');
  const existing = statSync(root, { throwIfNoEntry: false }) === undefined ? dirname(root) : root;
  const view = collectInit({
    root,
    host: selected,
    id,
    packageRoot: host.packageRoot,
    git: gitIn(existing, host.env),
    invocation: invocationOf(context),
  });
  const rendered = (applied: Applied | null): Result =>
    json
      ? { exitCode: 0, stdout: JSON.stringify(initEnvelope(view, apply, applied)) + '\n', stderr: '' }
      : {
          exitCode: 0,
          stdout: applied === null ? renderInit(view, caps) : renderApplied(view, applied, caps),
          stderr: '',
        };
  // §2.1: conflicts are reported inside the plan and are not an error class, so a plan is always exit 0.
  if (!apply) return rendered(null);
  if (view.state !== 'fresh' && view.state !== 'resumable') throw conflictRefusal(view);
  // §2.8 rule 3, as `ia install` asks it: parsing already refused every `--apply` whose question cannot be answered.
  if (!args.flag('yes') && !(await confirm(host.interaction, renderInitSummary(view, caps), CONFIRMATION)))
    return { exitCode: 0, stdout: renderDeclined(view, caps), stderr: '' };
  const initialized = await applyInit(view, { packageRoot: host.packageRoot, signal: host.signal });
  clearDecline(host.env, root);
  if (selected === 'none') return rendered(initialized);
  return rendered({ ...initialized, host: registerHost(context, selected, root) });
}

/**
 * Host registration spec §4 "init --host": the `ia host <host> --apply` path over the workspace just initialized.
 * Its arguments come from `ia host`'s own grammar rather than a hand-built object, so the host step reads exactly
 * what `ia host` would. `--yes` stands for the answer this invocation already gave, by flag or at the prompt, so
 * the step never asks a second question. Every failure here happens after initialization completed: the workspace
 * stays initialized, and each refusal keeps the service's code, message and location (contract §4.1).
 *
 * Its next action is `ia host`'s own remedy for that refusal, after a sentence saying initialization completed. Every
 * `ia host` command the remedy names gains `--root <root>`, because `<directory>` may be relative to a cwd that
 * is not the workspace, and `ia host` would otherwise discover a different root or none. A failure `ia host` gives
 * no remedy for falls back to the rerun that finishes registration.
 */
function registerHost(context: Context, selected: 'claude' | 'codex', root: string): HostApplied {
  const finish = `Run "ia host ${selected} --root ${quote(root)} --apply" to finish host registration.`;
  const composed = (next: string | null): string =>
    `The workspace is initialized. ${next === null ? finish : rootedNext(next, selected, root)}`;
  // M5.2 §5: a signal observed after the last init write interrupts a command that has written, so it names the rerun.
  if (context.host.signal?.aborted) throw new Interrupted(composed(null));
  const command = findCommand('host')!;
  const args = parseArguments([selected, '--root', root, '--apply', '--yes'], command.grammar);
  try {
    return applyHostSet(collectHost({ ...context, command, args }), context.host.packageRoot, context.host.signal);
  } catch (error) {
    if (error instanceof Interrupted) throw new Interrupted(composed(error.next));
    const refusal = refusalOf(error);
    throw new Refusal(refusal.code, refusal.message, refusal.exit, refusal.where, composed(refusal.next));
  }
}
/**
 * A finished git run's answer, or null when git is not really there: it could not start, or it is the macOS stub
 * `/usr/bin/git`, which only asks for the Xcode Command Line Tools and fails; reading that as "not a Git checkout" would
 * send the user after the wrong fix (#323).
 */
export function gitAnswer(result: {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): ReturnType<Git> {
  if (result.error !== undefined) return null;
  if (
    result.status !== 0 &&
    /^xcrun: error:|^xcode-select: (?:note|error): No developer tools were found/m.test(result.stderr ?? '')
  )
    return null;
  return { status: result.status, stdout: result.stdout };
}
