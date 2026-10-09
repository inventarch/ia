/**
 * `ia init`: docs/specs/consumer-cli-contract/README.md §2.1, implementing
 * docs/specs/workspace-initialization-apply/README.md (M5.2) to reach the end state
 * docs/specs/workspace-initialization/README.md (M5.1) fixes.
 *
 * Without `--apply` it prints the reviewable plan: the owned paths, the target's classification (M5.2 §4.1), the
 * conflicts detected now, the starter it would write, the bundled base pin and the steps. It exits 0 whether or not
 * conflicts were found, because reporting them is the command's job.
 *
 * Milestone position-packet task init-three-records (position-and-projection §3; plan amendments B7 and B13;
 * decisions local-system-at-init and identity-namespace): the starter is three authored records in
 * `.ia/src/workspace.ia` — the `@workspace`, its participant `@agent` and that participant's `@mandate` — and a
 * create-only `.ia/.gitignore`. No local `@system` and no `@distribution` are written unless `--system` asks for
 * them, inside `.ia/src/systems/<name>/`, where the packer finds a release's records; without them the release
 * descriptor names no distribution, so `ia pack` refuses until one is authored.
 *
 * With `--apply` it runs the steps in order — verify the pin, install the bundled base unless it is already
 * installed as planned, author the starter create-only, admit and read the authored identities from the compiled
 * graph, write `.ia/release.json`, the completion point — through the shared install services and `createFile`.
 * No journal is written: a rerun derives from the workspace which steps are done (§4.2). No step performs a network
 * request. `<directory>` is the only way to name the target: this verb never performs root discovery, and `--root`
 * is refused by the grammar rather than silently ignored. Two effects follow the completion point and are reported
 * apart (design §3): the capture, through db's `writeCapture` as `ia capture` writes it, and, only with `--host`, the
 * projection. A later step that fails leaves every earlier result in place and says so, naming its own command.
 *
 * `--host claude` or `--host codex` (docs/specs/host-registration/README.md §4 "init --host") is the project effect:
 * once the workspace is initialized, after the capture, the `ia host <host> --apply` path runs under the question
 * already answered here, so it never asks a second one, and its projection is written by `applyHostProjection`, the
 * one writer of projection files. It reads the live revision rather than the capture (plan amendment B8), so a capture
 * that fails does not keep it from running; the capture's refusal then says the projection is written. The plan names
 * that step and writes nothing for it — the host plan needs `.ia/release.json`, which only the apply writes. A host
 * step that refuses leaves the workspace initialized: the refusal keeps the service's code, message and location, and
 * its next action names the rerun.
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
import { DISTRIBUTION_ENGINE_VERSION, INSTALL_PATHS } from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import { verifyArchive } from '@inventarch/distribution/archive';
import { assertHomeOutsideWorkspace } from '@inventarch/distribution/host-home';
import type { DeclineKind } from '@inventarch/distribution/decisions';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import { resolveReleases } from '@inventarch/distribution/resolve';
import {
  createFile,
  openWorkspaceSession,
  readInstalledState,
  resolveCatalog,
} from '@inventarch/distribution/services';
import { parseArguments, UsageError } from './args.js';
import { captureFailure, collectCapture, CURRENT } from './capture.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { confirm, iaHomeOf, Interrupted, Refusal, refusalOf, respell } from './consumer.js';
import { clearDecline, runDecline } from './decline.js';
import { CONFIRMATION } from './distribute.js';
import type { HostApplied } from './host.js';
import { applyHostSet, collectHost, hostNotes, recoverCommand, rootedNext, STATE, THEN_RERUN } from './host.js';
import { readReceipt } from './host-projection.js';
import { located } from './home-remedy.js';
import { findProgram, programEnv, programHome } from './program.js';
import { codeOf } from './session.js';
import type { Capabilities, Field, SymbolName } from './render.js';
import { atom, document, entry, fieldRows, headerLine, quote, sectionLabel, truncateDigest, words } from './render.js';

export type HostSelection = 'claude' | 'codex' | 'none';
/** M5.2 §4.1. `recovery-required` is never rendered as a plan: it refuses before anything reasons about the target. */
export type TargetState = 'fresh' | 'resumable' | 'recovery-required' | 'conflict';
/**
 * The steps in apply order (position-and-projection §3): the base install, the create-only author step, admission,
 * the descriptor (the completion point), then the two effects, capture and, only with `--host`, project.
 */
export type StepId = 'install' | 'author' | 'admission' | 'descriptor' | 'capture' | 'project';
export interface Conflict {
  readonly path: string;
  readonly reason: string;
}
export interface Step {
  readonly id: StepId;
  /** `done` only for a step an earlier run completed as planned: the install, the author step, never an effect. */
  readonly status: 'pending' | 'done';
  /** The files the step writes, root-relative; admission writes none, and project's are the host's (`ia host`). */
  readonly paths: readonly string[];
}
/** A record the author step writes: its word, its name and the starter file that holds it. */
export interface StarterRecord {
  readonly word: string;
  readonly name: string;
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
  /**
   * The `@distribution` a `--system` starter authors: null in a plan, because M5.1 §2.3 reads it from the compiled
   * record at apply time and never constructs it. Absent without `--system`, which authors none (plan amendment B7).
   */
  readonly distribution?: string | null;
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
  /** `--system`: the local `@system`, its steward and the `@distribution` rooted at it are authored too. */
  readonly system: boolean;
  /** The authored files, in the order the author step writes them. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** The records those files hold, in file order: three, or six with `--system`. */
  readonly records: readonly StarterRecord[];
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
  /** Starter files already present with the bytes this initialization writes; the author step leaves them be. */
  readonly present: readonly string[];
  /** `.ia/.gitignore`: `create` when absent; an existing one is left as it is, whatever it holds, and reported. */
  readonly ignore: 'create' | 'present';
  readonly steps: readonly Step[];
  readonly starter: Starter;
  readonly host: HostSelection;
  /** What the target looked like, so the "no conflicts" line states a fact rather than a reassurance. */
  readonly directory: 'absent' | 'empty' | 'populated';
  readonly entries: number;
  /** The command that would apply this plan, rebuilt from what was parsed. */
  readonly invocation: string;
}
/** The capture effect: the revision `current.json` holds and the records it captured. */
export interface CaptureEffect {
  readonly revision: string;
  readonly records: number;
}
/** The project effect: the host, the files its receipt lists with their digests, and the receipt's own path. */
export interface ProjectEffect {
  readonly host: 'claude' | 'codex';
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly receipt: string;
}
/** M5.2 §7: `generation` and `counter` are the base install's, whether it ran now or in an earlier invocation. */
export interface Applied {
  readonly status: 'initialized';
  readonly resumed: boolean;
  readonly id: string;
  /** The `@distribution` the descriptor names, read from the compiled graph; null without `--system` (B7). */
  readonly distribution: string | null;
  readonly generation: string;
  readonly counter: number;
  /** The identities of the starter records, in file order, as admission compiled them. */
  readonly authored: readonly string[];
  /** `.ia/.gitignore`: `written` by this apply, or `present`, already there and left as it is. */
  readonly ignore: 'written' | 'present';
  /** Position-and-projection §3: the two effects after the completion point, each reported apart. */
  readonly effects: {
    readonly capture: CaptureEffect;
    /** `skipped` without `--host`. */
    readonly project: ProjectEffect | 'skipped';
  };
  /** Host registration spec §4 "init --host": the host step's own result, present only when a host was selected. */
  readonly host?: HostApplied;
}

/**
 * Relative to the `@inventarch/cli` package root, as `assets/vocabulary.json` is (vocabulary.ts CATALOGUE_PATH). The base
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
const distributionPath = (name: string): string => `${systemFolder(name)}/records/distribution.ia`;
/** Position-and-projection §3: the one file the three starter records share, at the root of the authored source. */
export const WORKSPACE_PATH = '.ia/src/workspace.ia';
/** Create-only: the local working state each clone makes for itself, never the authored records or the lock. */
export const IGNORE_PATH = '.ia/.gitignore';
export const IGNORE_TEXT = 'work/\ndistributions/\n';
/** `packages/db/src/distribution/codec.ts` packageId and identifier: the id rule and the system-name ceiling. */
export const PACKAGE_ID = /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*$/;
const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_LIMIT = 64;
/** M5.2 §4.3: `createFile`'s temporary name, `<target>.<randomUUID()>.tmp` (apps/distribution/src/files.ts:76). */
export const LEFTOVER =
  /^(system\.ia|workspace\.ia|distribution\.ia|release\.json|\.gitignore)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** The installation, not the target, is at fault; `ia doctor` names the channel a reinstall goes through. */
const DAMAGED =
  'The ia installation is damaged; run "ia doctor" for its install channel and reinstall @inventarch/cli through it.';

/** M5.1 §2.1's paths: the authored source, the ignore file, the descriptor, the install state and the capture. */
export function ownedPaths(
  name: string | null,
  system = false,
): readonly { readonly path: string; readonly purpose: string }[] {
  return [
    { path: '.ia/src/', purpose: 'authored records' },
    ...(system ? [{ path: `${systemFolder(name ?? '<name>')}/`, purpose: 'the local system, written once' }] : []),
    { path: IGNORE_PATH, purpose: 'ignores work/ and distributions/; written once, only if absent' },
    { path: DESCRIPTOR_PATH, purpose: 'the release descriptor, written once' },
    { path: INSTALL_PATHS.lock, purpose: 'direct requests and resolved versions' },
    { path: '.ia/distributions/', purpose: 'install state, store and generations' },
    { path: '.ia/work/snapshot/', purpose: 'the capture taken once the workspace is initialized' },
  ];
}

/**
 * §2.1: an existing directory, or a single new segment under an existing directory. Anything else is usage. `rerun`
 * spells the refused invocation for another target (design row 27); `runInit` keeps every other argument it was given.
 */
export function resolveTarget(
  cwd: string,
  supplied: string | undefined,
  rerun: (target: string) => string = (target) => `ia init ${quote(target)}`,
): string {
  const target =
    supplied === undefined ? resolve(cwd) : isAbsolute(supplied) ? resolve(supplied) : resolve(cwd, supplied);
  const here = statSync(target, { throwIfNoEntry: false });
  if (here !== undefined && !here.isDirectory())
    throw new Refusal(
      'IA-CLI-USAGE',
      `${target} is not a directory`,
      2,
      { path: target },
      `Run "${rerun('<directory>')}" naming an existing directory, or one new directory inside an existing one.`,
    );
  if (here === undefined) {
    const parent = statSync(dirname(target), { throwIfNoEntry: false });
    if (parent === undefined || !parent.isDirectory())
      throw new Refusal(
        'IA-CLI-USAGE',
        `${dirname(target)} is not an existing directory`,
        2,
        { path: target },
        `Create ${dirname(target)} first, then run "${rerun(target)}".`,
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
 * `--system`'s local system, the 1.x starter system unchanged (M5.1 §2.2, verbatim in shape): the steward needs
 * `agent-system`, and `governance` is required. `work-system` is required so the system folder can hold `@plan`,
 * `@milestone`, `@task` and `@decision` records with no edit: a system may use only words owned by systems it directly
 * requires (operator decision, 2026-09-25).
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
/**
 * Position-and-projection §3's three records, at placement authored (band 100), with only the fields their schemas
 * declare (plan amendment B13). The `@workspace` composes every installed system, so nothing installed is unreachable
 * (M5.1 §2.2), declares the authored root its records are captured under and names the participant as its steward.
 * The participant `@agent` implies no host permission, and its `@mandate` grants it closed moves over that workspace;
 * the mandate's one prose clause claims nothing. Every name is the workspace's (decision identity-namespace).
 */
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
    '    sources [".ia/src @authored"]',
    `    steward @agent ${name}`,
    '',
    `@agent ${name}`,
    '  meaning',
    `    says "The IDE agent operating in the ${name} workspace, any vendor."`,
    `    answers "Which participant acts in the ${name} workspace?"`,
    '  governance',
    '    applies []',
    '',
    `@mandate ${name}-mandate`,
    '  meaning',
    `    says "The bounded authority of the ${name} participant in the ${name} workspace."`,
    `    answers "Which moves may the ${name} participant make, and in which workspace?"`,
    '  governance',
    '    requires "Claim no host permission or execution from this mandate."',
    '  authority',
    `    participant @agent ${name}`,
    '    moves [Observation, Verification, Synthesis, Delegation, Execution]',
    `    scope [@workspace ${name}]`,
    '',
  ].join('\n');
}
/**
 * `--system`'s release root (position-and-projection §2 case 3: a distribution's roots are system registrations). It
 * sits in the system folder, so the closure from it stays inside folders the packer can release
 * (apps/distribution/src/snapshot.ts, "Release roots must belong to native system folders").
 */
export function starterDistribution(name: string): string {
  return [
    '#! ia 1.0',
    '',
    `@distribution ${name}-distribution`,
    '  meaning',
    `    says "The release root of the ${name} system."`,
    '    answers "Which records does this release ship?"',
    '  distribution',
    `    records [@system ${name}]`,
    '',
  ].join('\n');
}
/** The authored files in the order the author step writes them, and the records they hold, in file order. */
export function starterFiles(
  name: string,
  systems: readonly string[],
  system: boolean,
): Pick<Starter, 'files' | 'records'> {
  return {
    files: [
      { path: WORKSPACE_PATH, text: starterRecords(name, systems) },
      ...(system
        ? [
            { path: systemPath(name), text: starterSystem(name) },
            { path: distributionPath(name), text: starterDistribution(name) },
          ]
        : []),
    ],
    records: [
      { word: 'workspace', name, path: WORKSPACE_PATH },
      { word: 'agent', name, path: WORKSPACE_PATH },
      { word: 'mandate', name: `${name}-mandate`, path: WORKSPACE_PATH },
      ...(system
        ? [
            { word: 'system', name, path: systemPath(name) },
            { word: 'agent', name: `${name}-steward`, path: systemPath(name) },
            { word: 'distribution', name: `${name}-distribution`, path: distributionPath(name) },
          ]
        : []),
    ],
  };
}

export type Git = (args: readonly string[]) => { readonly status: number | null; readonly stdout: string } | null;
/**
 * Git as a child process, with the host's environment rather than this process's, so the probe is a function of the
 * same explicit host every verb receives. `core.fsmonitor` is disabled because it is the configured command a
 * read-only query could otherwise start. A missing executable is `null`, which is not the same fact as "no checkout".
 * The target is a repository the user may not trust, so git is found on the host's qualified PATH entries only
 * and runs by absolute path from the home directory, with `-C` naming the target (src/program.ts).
 */
export const gitIn =
  (cwd: string, env: Readonly<Record<string, string | undefined>>): Git =>
  (args) => {
    const git = findProgram('git', env);
    if (git === null) return null;
    const result = spawnSync(git, ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
      cwd: programHome(),
      env: programEnv(env),
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

/**
 * M5.1 §2.3's table. With `--system`, `distribution` stays null until the compiled record is read (§3.1 step 6);
 * without it, `undefined` leaves the key out, because a default starter authors no `@distribution` (plan amendment B7).
 */
export function starterDescriptor(
  id: string,
  name: string,
  base: Base,
  provenance: Provenance,
  distribution?: string | null,
): Descriptor {
  return {
    formatVersion: 1,
    id,
    version: STARTER_VERSION,
    ...(distribution === undefined ? {} : { distribution }),
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
  /** `--system`: also author the local `@system`, its steward and the `@distribution` rooted at it. */
  readonly system?: boolean | undefined;
  readonly packageRoot: string;
  readonly git: Git;
  readonly invocation?: string;
}
/**
 * M5.2 §4.1. The starter bytes compared are what this invocation would write for its resolved id: they depend only
 * on the name, `--system` and the bundled manifest, so they are recomputed on every run instead of being journaled.
 */
export function collectInit(request: InitRequest): InitView {
  const { root, host } = request;
  const system = request.system === true;
  const base = readBase(request.packageRoot);
  const conflicts: Conflict[] = [];
  const present = existsSync(root);
  const entries = present ? readdirSync(root).length : 0;
  const identity = starterIdentity(root, request.id, base.systems);
  if (identity.conflict !== null) conflicts.push(identity.conflict);
  const { name, id } = identity;
  const provenance = readProvenance(request.git);
  const { files, records } = name === null ? { files: [], records: [] } : starterFiles(name, base.systems, system);
  // M5.2 §4.3: a temporary file `createFile` left beside one of this initialization's own targets.
  const targets = new Set([...files.map((file) => file.path), IGNORE_PATH, DESCRIPTOR_PATH]);
  // `.<uuid>.tmp` is 41 characters: the dot, a 36-character UUID and `.tmp`.
  const leftover = (path: string): boolean => LEFTOVER.test(basename(path)) && targets.has(path.slice(0, -41));
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
        `If no installer is running, run "${recoverCommand('recover', root)}" before initializing this directory.`,
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
          `Run "${recoverCommand('recover', root)}" before initializing this directory.`,
        );
      // Any other unreadable installation state is a conflict the plan reports, with the reader's own words.
      installation.push({ path: '.ia/distributions/', reason: message });
    }
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
      else if (system && name !== null && path.startsWith(`${systemFolder(name)}/`))
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
  // Create-only and never a conflict: an existing ignore file is the target's own, so it is left and reported.
  const ignore = existsSync(resolve(root, IGNORE_PATH)) ? 'present' : 'create';
  const steps: readonly Step[] = [
    { id: 'install', status: installed ? 'done' : 'pending', paths: [INSTALL_PATHS.lock] },
    {
      id: 'author',
      status:
        name !== null && files.every((file) => written.has(file.path)) && ignore === 'present' ? 'done' : 'pending',
      paths: name === null ? [] : [...files.map((file) => file.path), IGNORE_PATH],
    },
    { id: 'admission', status: 'pending', paths: [] },
    { id: 'descriptor', status: 'pending', paths: [DESCRIPTOR_PATH] },
    { id: 'capture', status: 'pending', paths: [CURRENT] },
    ...(host === 'none' ? [] : [{ id: 'project', status: 'pending', paths: [] } as const]),
  ];
  return {
    root,
    owns: ownedPaths(name, system),
    state,
    conflicts,
    leftovers: leftovers.sort(),
    present: files.filter((file) => written.has(file.path)).map((file) => file.path),
    ignore,
    steps,
    starter: {
      name,
      id,
      system,
      files,
      records,
      descriptor:
        id === null || name === null ? null : starterDescriptor(id, name, base, provenance, system ? null : undefined),
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
   * `portable-lock`, `active`, `complete`) and with `init:<step>` after each of the install, author, admission,
   * descriptor and capture steps completes, so a test can interrupt at exactly the boundaries M5.2 §8 item 2 names.
   */
  readonly checkpoint?: (name: string) => void;
  /**
   * The project effect, given only with `--host`: `runInit`'s `ia host <host> --apply` path (`registerHost`), which
   * needs the invocation's context. `done` is the sentence its refusal's next action opens with, saying what this run
   * completed before it.
   */
  readonly project?: ((done: string) => Projected) | undefined;
}
/** The project effect as `ia init --host` reports it: the effect, and the host step's own result. */
export interface Projected {
  readonly effect: ProjectEffect;
  readonly host: HostApplied;
}
/**
 * The sentence the next action of a step that fails or is interrupted once the descriptor is written opens with:
 * initialization is complete, so running `ia init` again refuses the target, and each effect is finished by its own
 * command (design §3). The project effect's also says whether the capture before it was taken.
 */
const INITIALIZED = 'The workspace is initialized.';
const CAPTURED = 'The workspace is initialized and captured.';
const UNCAPTURED = 'The workspace is initialized but not captured.';
/**
 * M5.2 §3.1's steps, in position-and-projection §3's order. Each step before the descriptor either completes or leaves
 * a state `collectInit` classifies as resumable or recovery-required. The signal is observed at step boundaries (§5):
 * before the first write it is the plain interruption and the target is byte-identical; after one, the interruption
 * names the rerun that finishes. Two effects follow the completion point, each reported apart, and each that fails or
 * is interrupted leaves the workspace initialized and names its own command: the capture, `ia capture`, and, only when
 * `options.project` is given (`--host`), the project effect, `ia host`. The project effect reads the live revision,
 * never the capture (plan amendment B8), so it runs after a capture that failed too, and that failure is then refused
 * with the capture's own repair, after a sentence saying the projection is written.
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
          `If no installer is running, an interrupted one left its lock: run "${recoverCommand('recover', root)}", then apply again.`,
        );
      throw error;
    }
  }
  boundary('install');
  // Step 4, author: create-only, so a starter file already present with these bytes is skipped and nothing is ever
  // rewritten. The ignore file is written only where none exists; one the target already holds is its own.
  for (const file of starter.files)
    if (!view.present.includes(file.path)) createFile(root, file.path, Buffer.from(file.text));
  const ignore = existsSync(resolve(root, IGNORE_PATH)) ? 'present' : 'written';
  if (ignore === 'written') createFile(root, IGNORE_PATH, Buffer.from(IGNORE_TEXT));
  boundary('author');
  // Step 5, admission: the identities are read from the compiled graph, never string-constructed (M5.1 §2.3).
  const session = openWorkspaceSession({ root });
  let authored: readonly string[], distribution: string | null;
  try {
    const errors = session.admission().findings.filter((finding) => finding.severity === 'error');
    if (errors.length > 0)
      throw new Refusal(
        'IA-CLI-FAILED',
        `The initialized workspace failed admission with ${errors.length} error findings; first: ${errors[0]!.code}`,
        3,
        { path: root },
        `Run "ia validate --root ${quote(root)}" for the findings.`,
      );
    const records = session.reader.records();
    const compiled = starter.records.map((planned) => {
      const record = records.find(
        (node) =>
          node.discriminator === planned.word && node.name === planned.name && node.source.path === planned.path,
      );
      if (record === undefined)
        throw new Refusal(
          'IA-CLI-FAILED',
          `The compiled workspace has no @${planned.word} ${planned.name} in ${planned.path}`,
          3,
          { path: root },
          `Run "ia inspect --path ${planned.path} --root ${quote(root)}" for the records that file admitted.`,
        );
      return record;
    });
    authored = compiled.map((record) => record.identity);
    distribution = compiled.find((record) => record.discriminator === 'distribution')?.identity ?? null;
  } finally {
    session.close();
  }
  boundary('admission');
  // Step 6, the completion point (§4.1). A default starter's descriptor names no distribution (plan amendment B7).
  createFile(
    root,
    DESCRIPTOR_PATH,
    Buffer.from(descriptorText(starterDescriptor(id, name, base, starter.provenance, distribution ?? undefined))),
  );
  checkpoint('init:descriptor');
  const installed = readInstalledState({ root });
  // Step 7, the capture effect: `ia capture` on the workspace just initialized, written through db's writeCapture. A
  // failure is refused as `ia capture` refuses it, located and with its repair (`captureFailure`), for this root.
  const recapture = `ia capture --root ${quote(root)}`;
  let capture: CaptureEffect | undefined, failed: Refusal | undefined;
  if (options.signal?.aborted) {
    if (options.project === undefined) throw new Interrupted(`${INITIALIZED} Run "${recapture}" to capture it.`);
  } else
    try {
      const written = collectCapture(root, root);
      capture = { revision: written.snapshot.revision, records: written.snapshot.counts.records };
    } catch (error) {
      failed = refusalOf(captureFailure(error, root, recapture));
    }
  if (capture !== undefined) checkpoint('init:capture');
  // Step 8, the project effect, only with `--host`: after a capture that failed too. A signal the capture stopped for,
  // it observes itself, naming `ia host`, the effect this invocation asked for, after saying the capture was not taken.
  const projected = options.project?.(capture === undefined ? UNCAPTURED : CAPTURED);
  if (failed !== undefined)
    throw new Refusal(
      failed.code,
      failed.message,
      3,
      failed.where,
      `${projected === undefined ? INITIALIZED : `The workspace is initialized and its ${projected.effect.host} projection is written.`} ${failed.next ?? `Run "${recapture}" to capture it.`}`,
    );
  if (capture === undefined) throw new Interrupted(`${INITIALIZED} Run "${recapture}" to capture it.`);
  return {
    status: 'initialized',
    resumed: view.state === 'resumable',
    id,
    distribution,
    generation: installed.pointer!.generation,
    counter: installed.pointer!.counter,
    authored,
    ignore,
    effects: { capture, project: projected?.effect ?? 'skipped' },
    ...(projected === undefined ? {} : { host: projected.host }),
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
    `Run "${view.invocation}" to review the plan and its conflicts.`,
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
        system: starter.system,
        paths: [...starter.files.map((file) => file.path), ...(starter.descriptor === null ? [] : [DESCRIPTOR_PATH])],
        records: starter.records.map((record) => `@${record.word} ${record.name}`),
        ignore: { path: IGNORE_PATH, status: view.ignore },
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
  author: 'Author',
  admission: 'Admission',
  descriptor: 'Descriptor',
  capture: 'Capture',
  project: 'Project',
};
const stepValue = (view: InitView, step: Step): string => {
  const pin = view.starter.base;
  const what =
    step.id === 'install'
      ? `${pin.id} ${pin.version} from the bundled archive`
      : step.id === 'admission'
        ? 'zero error findings before the descriptor is written'
        : step.id === 'project'
          ? `the ${view.host} projection, through ia host ${view.host}`
          : step.paths.length === 0
            ? 'needs a valid name'
            : step.id === 'author' && view.ignore === 'present'
              ? `${step.paths.slice(0, -1).join(', ')}; ${IGNORE_PATH} exists and is left as it is`
              : step.id === 'capture'
                ? `${step.paths[0]}, as ia capture writes it`
                : step.paths.join(', ');
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
              `@workspace ${starter.name} composing ${starter.systems.length} systems; its participant @agent ${starter.name}; @mandate ${starter.name}-mandate`,
            ),
          },
          ...(starter.system
            ? [
                {
                  symbol: 'info' as const,
                  label: 'Local system',
                  value: words(
                    `@system ${starter.name} and its steward; @distribution ${starter.name}-distribution rooted at it`,
                  ),
                },
              ]
            : []),
          {
            symbol: 'info',
            label: 'Release',
            value: words(
              `${starter.id} ${STARTER_VERSION}, requiring ${pin.id} ^${pin.version}${starter.system ? '' : '; no distribution, so ia pack refuses until one is authored'}`,
            ),
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
      // Position-and-projection §3: the records authored, then each effect, reported apart.
      entry(
        [
          words(`Authored ${applied.authored.length} records:`),
          ...applied.authored.map((identity) => [atom(identity, null, 0)]),
          words(
            applied.ignore === 'written'
              ? `Wrote ${IGNORE_PATH}, ignoring work/ and distributions/.`
              : `${IGNORE_PATH} already exists and is left as it is.`,
          ),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      entry(
        [
          words(
            `Captured ${applied.effects.capture.records} records at revision ${truncateDigest(applied.effects.capture.revision, caps.ascii)} to ${CURRENT}.`,
          ),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      applied.effects.project === 'skipped'
        ? entry([words('Project skipped: no host was selected.')], { depth: 1, symbol: 'info' }, caps)
        : entry(
            [
              words(`Projected the position packet for ${applied.effects.project.host}:`),
              ...applied.effects.project.files.map((file) => [atom(file.path, 'cyan', 0)]),
              words(`Receipt ${applied.effects.project.receipt}.`),
              // Host registration spec §4: written is all this can say; `ia doctor` reports what is observed.
              words(`Registered with ${view.host}; written, not observed answering.`),
            ],
            { depth: 1, symbol: 'success' },
            caps,
          ),
      stepRows(view, () => 'success', caps),
      // Spec §5.3 and §5.4: the notes `ia host` prints after a registration, from the same function.
      ...(applied.host === undefined || view.host === 'none' ? [] : hostNotes(view.host, caps)),
      entry(
        [
          words(
            applied.distribution === null
              ? 'Run "ia validate" to check the workspace, or "ia position" for the position body an agent starts from.'
              : 'Run "ia validate" to check the workspace, or "ia pack --descriptor .ia/release.json" to build its release.',
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
  if (args.flag('system')) parts.push('--system');
  if (host !== undefined && host !== 'none') parts.push('--host', host);
  return parts.join(' ');
}

export async function runInit(context: Context): Promise<Result> {
  const { args, host } = context;
  const id = args.value('id');
  // A malformed identity is usage (§3), decided before the target is read.
  if (id !== undefined && (!PACKAGE_ID.test(id) || id.includes('..')))
    throw new UsageError(`--id must be <provider/name>; got ${id}`);
  const root = resolveTarget(host.cwd, args.positionals[0], (target) => respell(context, { positionals: [target] }));
  try {
    return await initialize(context, root, id);
  } catch (error) {
    // Design row 27: this verb's target is `<directory>`, which `--root` cannot carry, so a service refusal with no
    // remedy of its own is given the fallback for that directory rather than for the cwd, which may not be it.
    if (error instanceof Refusal || error instanceof Interrupted || error instanceof UsageError || host.signal?.aborted)
      throw error;
    throw refusalOf(error, { command: 'init', root });
  }
}
/** The verb once its target is resolved: a decline, the plan, or its apply. */
async function initialize(context: Context, root: string, id: string | undefined): Promise<Result> {
  const { args, caps, json, host } = context;
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
    located(root, `Set IA_HOME to an absolute directory outside ${root}, then run "${invocationOf(context)}".`, () =>
      assertHomeOutsideWorkspace(iaHome, root),
    );
  const selected = (args.value('host') ?? 'none') as HostSelection;
  const apply = args.flag('apply');
  const existing = statSync(root, { throwIfNoEntry: false }) === undefined ? dirname(root) : root;
  const view = collectInit({
    root,
    host: selected,
    id,
    system: args.flag('system'),
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
  // The project effect, last (position-and-projection §3): the `ia host` path, whose apply writes the receipt.
  const project = selected === 'none' ? undefined : (done: string) => registerHost(context, selected, root, done);
  try {
    return rendered(await applyInit(view, { packageRoot: host.packageRoot, signal: host.signal, project }));
  } finally {
    // Once the descriptor, the completion point, is written, the target is initialized whatever an effect after it
    // did, so its recorded decline is forgotten (`clearDecline`).
    if (existsSync(resolve(root, DESCRIPTOR_PATH))) clearDecline(host.env, root);
  }
}

/**
 * Host registration spec §4 "init --host": the `ia host <host> --apply` path over the workspace just initialized.
 * Its arguments come from `ia host`'s own grammar rather than a hand-built object, so the host step reads exactly
 * what `ia host` would. `--yes` stands for the answer this invocation already gave, by flag or at the prompt, so
 * the step never asks a second question. Every failure here happens after initialization completed: the workspace
 * stays initialized, and each refusal keeps the service's code, message and location (contract §4.1).
 *
 * Its next action is `ia host`'s own remedy for that refusal, after `done`, the sentence saying what initialization
 * completed, the capture included or not. Every `ia host` command the remedy names gains `--root <root>`, because
 * `<directory>` may be relative to a cwd that is not the workspace, and `ia host` would otherwise discover a different
 * root or none. A failure `ia host` gives no remedy for falls back to the rerun that finishes registration. A recovery
 * followed by "rerun" would send the user back to this init, which now refuses as initialized, so it names `ia host`
 * instead, which names that recovery itself. The effect is read from the receipt the projection apply just wrote.
 */
function registerHost(context: Context, selected: 'claude' | 'codex', root: string, done: string): Projected {
  const host = `ia host ${selected} --root ${quote(root)} --apply`;
  const finish = `Run "${host}" to finish host registration.`,
    recover = `Run "${host}" for the recovery it names, then run it again to finish host registration.`;
  const composed = (next: string | null): string =>
    `${done} ${next === null ? finish : next.endsWith(THEN_RERUN) ? recover : rootedNext(next, selected, root)}`;
  // M5.2 §5: a signal observed after the last init write interrupts a command that has written, so it names the rerun.
  if (context.host.signal?.aborted) throw new Interrupted(composed(null));
  const command = findCommand('host')!;
  const args = parseArguments([selected, '--root', root, '--apply', '--yes'], command.grammar);
  try {
    const applied = applyHostSet(
      collectHost({ ...context, command, args }),
      context.host.packageRoot,
      context.host.signal,
    );
    // A host apply that returns has projected, and `applyHostProjection` wrote the receipt (B12) before it returned.
    const receipt = readReceipt(root, selected)!;
    return { effect: { host: selected, files: receipt.files, receipt: STATE.receipt(selected) }, host: applied };
  } catch (error) {
    if (error instanceof Interrupted) throw new Interrupted(composed(error.next));
    const refusal = refusalOf(error);
    // A service refusal carries only the generic fallback, so the rerun that finishes registration is named instead.
    throw new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      refusal.where,
      composed(error instanceof Refusal ? refusal.next : null),
    );
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
