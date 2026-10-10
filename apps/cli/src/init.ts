import { readBase, PIN_PATH, PACKAGE_ID, DAMAGED } from './bundled-base.js';
import type { Base, BasePin } from './bundled-base.js';
export { readBase, PIN_PATH, baseArchivePath, PACKAGE_ID } from './bundled-base.js';
export type { Base, BasePin } from './bundled-base.js';
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
 *
 * `--migrate` (milestone position-packet task init-migrate-flag; plan amendments B7, B9 and B11) takes a workspace a
 * 1.1.0 `ia init` wrote instead: one local system folder, `.ia/src/systems/<name>/`, whose `system.ia` holds exactly the
 * starter `@system <name>`, registering no word, and `@agent <name>-steward`, and whose `records/workspace.ia` holds
 * exactly `@workspace <name>` and `@distribution <name>-distribution`. It rewrites it into the three starter records:
 * each other record file moves from the folder's `records/` to `.ia/src/`, where a record's word, not its folder,
 * decides its system, so its identity is unchanged; the local system folder goes and the descriptor names no
 * distribution, unless `--system` keeps the `@system` and its steward and re-roots the `@distribution` at the system.
 * It plans by default, and plan and apply alike refuse a workspace of any other shape before anything is written. The
 * three records use fields only the base this CLI bundles declares, so the apply first installs that base where the
 * workspace has another, as `ia init` installs it; it then captures and re-projects each host whose projection the
 * workspace owns through `applyHostProjection`, which retires the 1.x steward guard and deletes the owned steward agent
 * files (`collectMigration`, `applyMigration`).
 */
import {
  readMigrationJournal,
  beginMigrationJournal,
  applyMigrationFiles,
  finishMigrationJournal,
  completeMigrationProjection,
  reopenMigrationProjection,
} from './migration-journal.js';
import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
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
import {
  decodeReleaseDescriptor,
  deriveGenerationInputs,
  generationDigest,
  installationWorkspace,
  readExpandedBundle,
  DISTRIBUTION_ENGINE_VERSION,
  INSTALL_PATHS,
  sha256,
} from '@inventarch/db/distribution';
import type { DistributionLock, ReleaseDescriptor } from '@inventarch/db/distribution';
import { verifyArchive } from '@inventarch/distribution/archive';
import { assertHostRegistrationIdle } from '@inventarch/distribution/host';
import { assertHomeOutsideWorkspace } from '@inventarch/distribution/host-home';
import type { DeclineKind } from '@inventarch/distribution/decisions';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import type { ProjectionAction } from '@inventarch/distribution/projection';
import { resolveReleases } from '@inventarch/distribution/resolve';
import {
  createFile,
  openWorkspaceSession,
  readInstalledState,
  readWorkspaceFile,
  readWorkspaceJson,
  resolveCatalog,
} from '@inventarch/distribution/services';
import { parseArguments, UsageError } from './args.js';
import { captureFailure, collectCapture, CURRENT } from './capture.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { confirm, iaHomeOf, Interrupted, Refusal, refusalOf, respell } from './consumer.js';
import { clearDecline, runDecline } from './decline.js';
import { CONFIRMATION, registeredProjections } from './distribute.js';
import type { HostApplied } from './host.js';
import {
  applyHostSet,
  collectHost,
  GUARD_RETIRED,
  hostNotes,
  JOURNALS,
  projectionRepair,
  recoverCommand,
  refusedPath,
  rootedNext,
  SETTINGS,
  STATE,
  THEN_RERUN,
} from './host.js';
import type { HostName } from './host-projection.js';
import { applyHostProjection, planFiles, planRetirement, readReceipt, renderProjectionFor } from './host-projection.js';
import { located } from './home-remedy.js';
import { findProgram, programEnv, programHome } from './program.js';
import type { Session } from './session.js';
import { codeOf, openSession } from './session.js';
import type { Capabilities, Field, SymbolName } from './render.js';
import {
  atom,
  blockSymbolWidth,
  document,
  entry,
  fieldRows,
  headerLine,
  quote,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';

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
export function migrationIgnoreText(root: string): string {
  const result = gitIn(root, process.env)(['ls-files', '-z', '--', '.ia/distributions']);
  return result === null || result.status === null || (result.status === 0 && result.stdout.length > 0)
    ? 'work/\n'
    : IGNORE_TEXT;
}
/** Enumerate the exact store and generation inventory the installer will make active, without caching or writing. */
function migrationPayloadPaths(root: string, base: Base, current: DistributionLock): readonly string[] {
  const replacing = current.packages.find((pkg) => pkg.id === base.pin.id)!.archive !== base.pin.archive;
  const resolved = replacing
    ? resolveReleases(
        [{ id: base.pin.id, range: `^${base.pin.version}` }],
        [
          {
            release: verifyArchive(base.bytes, base.pin.archive),
            location: `sha256:${base.pin.archive}`,
            withdrawn: false,
          },
        ],
        DISTRIBUTION_ENGINE_VERSION,
      )
    : null;
  const lock = resolved?.lock ?? current;
  const releases = resolved?.releases ?? new Map(lock.packages.map((pkg) => [pkg.id, readExpandedBundle(root, pkg)]));
  const inputs = deriveGenerationInputs(lock, releases);
  const workspace = installationWorkspace(lock, inputs, releases);
  const generation = `${INSTALL_PATHS.generations}/${generationDigest(lock, inputs, workspace)}`;
  return [
    INSTALL_PATHS.lock,
    INSTALL_PATHS.active,
    `${generation}/lock.json`,
    `${generation}/inputs.json`,
    ...(workspace === null ? [] : [`${generation}/workspace.ia`]),
    ...lock.packages.flatMap((pkg) => [
      `${INSTALL_PATHS.store}/${pkg.archive}/distribution.json`,
      ...releases.get(pkg.id)!.manifest.files.map((file) => `${INSTALL_PATHS.store}/${pkg.archive}/${file.path}`),
    ]),
  ];
}
function migrationGitConflict(root: string, base: Base, lock: DistributionLock): MigrationConflict | null {
  const git = gitIn(root, process.env);
  const tracked = git(['ls-files', '-z', '--', '.ia/distributions']);
  if (tracked === null || tracked.status === null || tracked.status !== 0) {
    for (let at = root; ; at = dirname(at)) {
      if (existsSync(resolve(at, '.git')))
        return {
          path: '.ia/distributions',
          reason: 'Git tracking could not be verified; make Git available before migrating this checkout',
        };
      if (dirname(at) === at) break;
    }
    return null;
  }
  if (tracked.status !== 0 || tracked.stdout.length === 0) return null;
  const probes = migrationPayloadPaths(root, base, lock);
  // NUL-delimited bounded batches preserve exact paths and avoid Windows argument/output limits.
  const query = (args: readonly string[]): ReturnType<Git> => {
    let stdout = '',
      status = 1;
    for (let at = 0; at < probes.length; at += 128) {
      const result = git(args, probes.slice(at, at + 128).join('\0') + '\0');
      if (result === null || result.status === null || result.status > 1) return result;
      stdout += result.stdout;
      if (result.status === 0) status = 0;
    }
    return { status, stdout };
  };
  const attributes = query(['check-attr', '-z', '--stdin', 'text', 'eol', 'filter', 'working-tree-encoding']);
  const conversion = git(['config', '--get', 'core.autocrlf']);
  if (attributes?.status !== 0 || conversion === null)
    return {
      path: '.gitattributes',
      reason:
        'Git byte-conversion rules could not be verified for tracked installation payload; repair Git before migrating',
    };
  const fields = attributes.stdout.split('\0');
  const settings = new Map<string, Record<string, string>>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const values = settings.get(fields[index]!) ?? {};
    values[fields[index + 1]!] = fields[index + 2]!;
    settings.set(fields[index]!, values);
  }
  const transforms = [...settings.values()].some(
    (values) =>
      (values['filter'] !== 'unspecified' && values['filter'] !== 'unset') ||
      (values['working-tree-encoding'] !== 'unspecified' && values['working-tree-encoding'] !== 'unset') ||
      (values['text'] !== 'unset' &&
        (values['text'] !== 'unspecified' ||
          values['eol'] !== 'unspecified' ||
          ['true', 'input'].includes(conversion.stdout.trim()))),
  );
  if (settings.size !== probes.length || transforms)
    return {
      path: '.gitattributes',
      reason:
        'Git may rewrite tracked immutable installation bytes; add .ia/distributions/** -text and .ia/distributions.lock.json -text to .gitattributes and remove any filters or encoding conversion for those paths before migrating',
    };
  const ignored = query(['check-ignore', '-v', '-z', '--no-index', '--stdin']);
  if (ignored?.status === 1) return null;
  if (ignored?.status === 0) {
    const fields = ignored.stdout.split('\0');
    for (let at = 0; at + 3 < fields.length; at += 4) {
      const [source, line, pattern, path] = fields.slice(at, at + 4);
      if (pattern!.startsWith('!')) continue;
      return {
        path: '.ia/distributions',
        reason: `Tracked installation payload ${path} would be hidden by an existing Git ignore rule: ${source}:${line}:${pattern}; adjust that rule to include this required file before migrating`,
      };
    }
    return null;
  }
  return {
    path: '.ia/distributions',
    reason: 'Git ignore rules could not be verified for tracked installation payload; repair Git before migrating',
  };
}
/** `packages/db/src/distribution/codec.ts` packageId and identifier: the id rule and the system-name ceiling. */
const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_LIMIT = 64;
/** M5.2 §4.3: `createFile`'s temporary name, `<target>.<randomUUID()>.tmp` (apps/distribution/src/files.ts:76). */
export const LEFTOVER =
  /^(system\.ia|workspace\.ia|distribution\.ia|release\.json|\.gitignore)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** The installation, not the target, is at fault; `ia doctor` names the channel a reinstall goes through. */

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
/**
 * The authored files in the order the author step writes them, and the records they hold, in file order. With
 * `--system` the `@workspace` composes the local system after `systems` (position-and-projection §2 case 2: a
 * repository that owns vocabulary composes its own system), so the packet renders a pointer line for it.
 */
export function starterFiles(
  name: string,
  systems: readonly string[],
  system: boolean,
): Pick<Starter, 'files' | 'records'> {
  return {
    files: [
      { path: WORKSPACE_PATH, text: starterRecords(name, system ? [...systems, name] : systems) },
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

export type Git = (
  args: readonly string[],
  input?: string,
) => { readonly status: number | null; readonly stdout: string } | null;
/**
 * Git as a child process, with the host's environment rather than this process's, so the probe is a function of the
 * same explicit host every verb receives. `core.fsmonitor` is disabled because it is the configured command a
 * read-only query could otherwise start. A missing executable is `null`, which is not the same fact as "no checkout".
 * The target is a repository the user may not trust, so git is found on the host's qualified PATH entries only
 * and runs by absolute path from the home directory, with `-C` naming the target (src/program.ts).
 */
export const gitIn =
  (cwd: string, env: Readonly<Record<string, string | undefined>>): Git =>
  (args, input) => {
    const git = findProgram('git', env);
    if (git === null) return null;
    const result = spawnSync(git, ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
      cwd: programHome(),
      env: programEnv(env),
      encoding: 'utf8',
      input,
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

/** The descriptor's one dependency row: the bundled base, at a caret range of its version, and the systems it carries. */
const baseDependencies = (base: Base): Descriptor['dependencies'] => [
  { id: base.pin.id, range: `^${base.pin.version}`, systems: base.systems },
];
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
    dependencies: baseDependencies(base),
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
    // `pending` exists and after it is removed. `ia recover installation` clears a dead holder's lock and refuses a
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
  // Step 3: the bundled base, installed as the workspace's one request.
  if (step('install').status === 'pending')
    await installBase(root, base, 'install', { signal: options.signal, checkpoint }, resume);
  boundary('install');
  // Step 4, author: create-only, so a starter file already present with these bytes is skipped and nothing is ever
  // rewritten. The ignore file is written only where none exists; one the target already holds is its own.
  for (const file of starter.files)
    if (!view.present.includes(file.path)) createFile(root, file.path, Buffer.from(file.text));
  const ignore = existsSync(resolve(root, IGNORE_PATH)) ? 'present' : 'written';
  if (ignore === 'written') createFile(root, IGNORE_PATH, Buffer.from(IGNORE_TEXT));
  boundary('author');
  // Step 5, admission: the identities are read from the compiled graph, never string-constructed (M5.1 §2.3).
  const { compiled } = admitStarter(root, starter.records, 'initialized', '');
  const authored = compiled.map((record) => record.identity),
    distribution = compiled.find((record) => record.discriminator === 'distribution')?.identity ?? null;
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

/**
 * M5.1 §4's three calls, offline, resolved the way `ia install` resolves (distribute.ts collectPlan): the bundled base
 * is cached, resolved from that one archive and installed as the workspace's one request, by `ia init` into a new
 * workspace and by `ia init --migrate` in place of a 1.x base. A signal during it is `resume`.
 */
async function installBase(
  root: string,
  base: Base,
  operation: 'install' | 'update',
  options: { readonly signal?: AbortSignal | undefined; readonly checkpoint: (name: string) => void },
  resume: Interrupted,
): Promise<void> {
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
    applyInstallation(planInstallation(root, lock, operation), { checkpoint: options.checkpoint });
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

/** The refusal's message for `conflicts`: the one conflict at its path, or every conflict with its reason. */
const conflictMessage = (conflicts: readonly Conflict[], blocked: string): string =>
  conflicts.length === 1
    ? `${conflicts[0]!.reason}: ${conflicts[0]!.path}`
    : `${conflicts.length} conflicts block ${blocked}: ${conflicts.map((row) => `${row.path} (${row.reason})`).join('; ')}`;
/** M5.2 §4.1: every conflict is listed; `--apply` refuses at class 3 and writes nothing. */
function initializedNext(view: InitView): string | null {
  if (!view.conflicts.some((row) => row.path === DESCRIPTOR_PATH && row.reason === 'The target is already initialized'))
    return null;
  return `${existsSync(resolve(view.root, WORKSPACE_PATH)) || existsSync(resolve(view.root, SYSTEMS)) ? '' : 'Restore the authored .ia/src/workspace.ia from source control first. '}Run "ia position --root ${quote(view.root)}" to inspect this initialized workspace.`;
}
function conflictRefusal(view: InitView): Refusal {
  return new Refusal(
    'IA-CLI-CONFLICT',
    conflictMessage(view.conflicts, 'initialization'),
    3,
    { path: view.root },
    initializedNext(view) ?? `Run "${view.invocation}" to review the plan and its conflicts.`,
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
      ...(initializedNext(view) === null ? {} : { next: initializedNext(view) }),
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
              `@workspace ${starter.name} composing ${starter.systems.length} systems${starter.system ? ` and @system ${starter.name}` : ''}; its participant @agent ${starter.name}; @mandate ${starter.name}-mandate`,
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
      ? (initializedNext(view) ?? `Resolve the conflicts above, then run "${view.invocation} --apply --yes".`)
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

/**
 * The report rows `ia init` and `ia init --migrate` share, each from one function so the two verbs word them alike:
 * the records authored and the ignore file, the capture effect, and the closing next step.
 */
const authoredEntry = (
  applied: Pick<Applied, 'authored' | 'ignore'>,
  caps: Capabilities,
  ignored = 'work/ and distributions/',
): readonly string[] =>
  entry(
    [
      words(`Authored ${applied.authored.length} records:`),
      ...applied.authored.map((identity) => [atom(identity, null, 0)]),
      words(
        applied.ignore === 'written'
          ? `Wrote ${IGNORE_PATH}, ignoring ${ignored}.`
          : `${IGNORE_PATH} already exists and is left as it is.`,
      ),
    ],
    { depth: 1, symbol: 'success' },
    caps,
  );
const capturedEntry = (capture: CaptureEffect, caps: Capabilities): readonly string[] =>
  entry(
    [
      words(
        `Captured ${capture.records} records at revision ${truncateDigest(capture.revision, caps.ascii)} to ${CURRENT}.`,
      ),
    ],
    { depth: 1, symbol: 'success' },
    caps,
  );
const closingEntry = (distribution: string | null, caps: Capabilities): readonly string[] =>
  entry(
    [
      words(
        distribution === null
          ? 'Run "ia validate" to check the workspace, or "ia position" for the position body an agent starts from.'
          : 'Run "ia validate" to check the workspace, or "ia pack --descriptor .ia/release.json" to build its release.',
      ),
    ],
    { depth: 0, symbol: 'step' },
    caps,
  );
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
      authoredEntry(applied, caps),
      capturedEntry(applied.effects.capture, caps),
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
      closingEntry(applied.distribution, caps),
    ],
    { leadingBlank: true },
  );
}
const renderDeclined = (view: Pick<InitView, 'invocation'>, caps: Capabilities): string =>
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
  if (args.flag('migrate')) parts.push('--migrate');
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
  if (args.flag('migrate')) return migrate(context, root);
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
/** The release whose starter `ia init --migrate` rewrites. */
export const MIGRATES_FROM = '1.1.0';
const SYSTEMS = '.ia/src/systems';
/** The 1.x starter file beside the user's record files: its `@workspace` and the `@distribution` rooted at it. */
const legacyRecordsPath = (name: string): string => `${systemFolder(name)}/records/workspace.ia`;
/** One user record file the migration moves out of the local system folder, and the identities it holds. */
export interface MigrationMove {
  readonly from: string;
  readonly to: string;
  /** Read from the compiled graph: at `from` in a plan, at `to` once applied. */
  readonly identities: readonly string[];
}
/** A 1.x starter file the migration deletes, with the identities it holds, or a folder it leaves empty (`/`, none). */
export interface MigrationRemoval {
  readonly path: string;
  readonly identities: readonly string[];
}
/**
 * What `--apply` refuses: a destination that already exists, a record holding the word and name of a starter record
 * the migration authors anew, or, with `host`, a registered projection whose planner refuses, with the planner's code.
 */
export interface MigrationConflict {
  readonly path: string;
  readonly reason: string;
  readonly host?: HostName;
  readonly code?: string;
}
/** A host whose projection this workspace owns, and what `applyHostProjection` plans for it (B9, B11). */
export interface MigrationHost {
  readonly host: HostName;
  readonly guard: 'retire' | 'none';
  /**
   * The file plan for the migrated records' render: every file the adapter renders carries the workspace revision,
   * which the migration changes, so none of them is `unchanged`.
   */
  readonly files: readonly ProjectionAction[];
}
/**
 * The apply's steps in order: the base install, only when the installed base is not the one this CLI bundles, the
 * file steps, then admission, then the two effects.
 */
export type MigrationStepId =
  | 'install'
  | 'move'
  | 'author'
  | 'remove'
  | 'descriptor'
  | 'admission'
  | 'capture'
  | 'project';
export interface MigrationView {
  readonly root: string;
  /** The release descriptor's id, unchanged. */
  readonly id: string;
  /** The 1.x workspace's name, which is its system folder's, its records' and the new starter's. */
  readonly name: string;
  /** `--system`: the `@system` and its steward stay, and the `@distribution` is re-rooted at the system. */
  readonly system: boolean;
  /**
   * The bundled base the three records are written against (M5.1 §3.2), and the base the workspace has installed,
   * which the install step replaces when it is another archive: a 1.x base declares none of their new fields.
   */
  readonly base: { readonly pin: BasePin; readonly installed: { readonly version: string; readonly archive: string } };
  readonly conflicts: readonly MigrationConflict[];
  readonly moves: readonly MigrationMove[];
  /** The files the author step writes, create-only: `.ia/src/workspace.ia`, and with `--system` the distribution. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** The starter records the migrated workspace holds, in file order: three, or six with `--system`. */
  readonly records: readonly StarterRecord[];
  /** The new `@workspace`'s `composition.systems`: the 1.x one's, the local system only with `--system`. */
  readonly systems: readonly string[];
  /** In delete order: the 1.x starter files, then without `--system` the three folders they leave empty. */
  readonly removes: readonly MigrationRemoval[];
  readonly ignore: 'create' | 'present';
  /**
   * The descriptor's distribution before and after the migration, null after when it is dropped, and its dependency
   * rows before and after: after, the bundled base's row, as `ia init` writes it, in place of the installed base's, and
   * every other row as it was.
   */
  readonly descriptor: {
    readonly before: string;
    readonly after: string | null;
    readonly dependencies: { readonly before: Descriptor['dependencies']; readonly after: Descriptor['dependencies'] };
  };
  /**
   * The descriptor bytes the descriptor step writes, or null when it keeps them: with `--system`, when its rows are
   * already the ones it would write, whatever the file's formatting.
   */
  readonly rewrite: string | null;
  readonly hosts: readonly MigrationHost[];
  readonly steps: readonly MigrationStepId[];
  /** The command that would apply this plan, rebuilt from what was parsed. */
  readonly invocation: string;
}
export interface MigrationRequest {
  readonly root: string;
  readonly system?: boolean | undefined;
  /** The `@inventarch/cli` package root, whose bundled base the migrated workspace installs. */
  readonly packageRoot: string;
  readonly invocation?: string;
}
/** One registered host's project effect: the receipt's files, the guard retirement and the 1.x files it deleted. */
export interface MigratedProjection extends ProjectEffect {
  readonly guard: 'retired' | 'none';
  readonly removed: readonly string[];
}
export interface Migrated {
  readonly status: 'migrated';
  readonly id: string;
  /** The bundled base: `installed` by this apply, or `present`, already the workspace's. */
  readonly base: 'installed' | 'present';
  /** The `@distribution` the descriptor names, read from the compiled graph; null without `--system`. */
  readonly distribution: string | null;
  /** The starter records' identities, in file order, as admission compiled them. */
  readonly authored: readonly string[];
  /** Each moved file with the identities the compiled graph holds at its new path. */
  readonly moved: readonly MigrationMove[];
  /** The plan's removals, as deleted: the 1.x starter files, and without `--system` the folders they leave empty. */
  readonly removed: readonly string[];
  readonly ignore: 'written' | 'present';
  readonly effects: {
    readonly capture: CaptureEffect;
    /** One per registered host, in host order; empty when the workspace owns no projection. */
    readonly project: readonly MigratedProjection[];
  };
}

type Compiled = ReturnType<Session['reader']['records']>[number];
const spelled = (record: Pick<Compiled, 'discriminator' | 'name'>): string => `@${record.discriminator} ${record.name}`;
/** A descriptor's dependency rows, compared as text: each id, range and the systems it externalizes. */
const spelledRows = (rows: Descriptor['dependencies']): string =>
  rows.map((row) => `${row.id} ${row.range} ${row.systems.join(',')}`).join('; ');
/**
 * The one refusal for a target `--migrate` does not recognize. Its message names what was found and the shape a 1.1.0
 * starter has there; its next action names the help for the forms the verb takes.
 */
const unshaped = (reason: string, path: string): Refusal =>
  new Refusal(
    'IA-CLI-CONFLICT',
    `The target is not a ${MIGRATES_FROM} starter workspace: ${reason}`,
    3,
    { path },
    'Run "ia init --help" for the forms this verb takes.',
  );
const entriesOf = (root: string, path: string): readonly Dirent[] =>
  readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
const directory = (root: string, path: string): boolean =>
  lstatSync(resolve(root, path), { throwIfNoEntry: false })?.isDirectory() === true;
/**
 * The preflight's folder half, read without following a link: `.ia/src/systems/` holds one folder, the local system,
 * and it holds only `system.ia` and `records/*.ia`, with `records/workspace.ia` among them. Its name and the user's
 * record files beside the starter's, sorted.
 */
function starterFolder(root: string): { readonly name: string; readonly files: readonly string[] } {
  if (!directory(root, SYSTEMS)) throw unshaped(`${SYSTEMS}/ is absent, so it has no local system`, root);
  const folders = entriesOf(root, SYSTEMS);
  if (folders.length !== 1 || !folders[0]!.isDirectory() || !NAME.test(folders[0]!.name))
    throw unshaped(
      `${SYSTEMS}/ holds ${folders.length === 0 ? 'nothing' : folders.map((entry) => entry.name).join(', ')}, where a ${MIGRATES_FROM} starter holds one folder, its local system`,
      SYSTEMS,
    );
  const name = folders[0]!.name,
    folder = systemFolder(name);
  const foreign = (path: string): Refusal =>
    unshaped(`${path} is not part of one, whose system folder holds only system.ia and records/*.ia`, path);
  for (const entry of entriesOf(root, folder))
    if (!(entry.name === 'system.ia' && entry.isFile()) && !(entry.name === 'records' && entry.isDirectory()))
      throw foreign(`${folder}/${entry.name}`);
  if (!existsSync(resolve(root, systemPath(name)))) throw unshaped(`${systemPath(name)} is absent`, folder);
  if (!directory(root, `${folder}/records`)) throw unshaped(`${legacyRecordsPath(name)} is absent`, folder);
  const files: string[] = [];
  for (const entry of entriesOf(root, `${folder}/records`)) {
    if (!entry.isFile() || !entry.name.endsWith('.ia')) throw foreign(`${folder}/records/${entry.name}`);
    if (entry.name !== 'workspace.ia') files.push(entry.name);
  }
  if (!existsSync(resolve(root, legacyRecordsPath(name))))
    throw unshaped(`${legacyRecordsPath(name)} is absent`, folder);
  return { name, files };
}
/**
 * The preflight (plan and `--apply` alike), before anything is written. Unrecognized, it refuses naming
 * `ia init --help`: no descriptor naming the starter's distribution, a system folder holding anything else, a
 * `system.ia` or `records/workspace.ia` holding any record but the starter's, a local `@system` that registers words,
 * or a base to replace in a lock that holds more than that base. A workspace that does not admit is refused naming
 * `ia validate`, because the migrated one must admit for its effects; so is a pending host journal, naming its
 * recovery. A destination that already exists, a record that already holds the word and name of a starter record the
 * migration authors anew, and a registered projection whose guard retirement or file plan the planners refuse, are
 * listed as conflicts, which the plan reports and `--apply` refuses. The three records use fields only the base this
 * CLI bundles declares, so the apply installs it first unless the workspace has it installed already, as `ia init`
 * does. The registered hosts are the ones the install refresh re-projects after an update, as the base install is
 * (`registeredProjections`): those whose projection state exists, as `ia host` and `ia doctor` read ownership.
 */
export function collectMigration(request: MigrationRequest): MigrationView {
  const { root } = request,
    system = request.system === true;
  if (!existsSync(resolve(root, DESCRIPTOR_PATH)))
    throw unshaped(`${DESCRIPTOR_PATH} is absent, so no initialization completed here`, root);
  const recovery = readMigrationJournal(root, system, readBase(request.packageRoot).pin);
  if (recovery !== null) {
    const installed = readInstalledState({ root }).lock?.packages.find((row) => row.id === recovery.view.base.pin.id);
    return {
      ...recovery.view,
      steps:
        installed?.archive === recovery.view.base.pin.archive
          ? recovery.view.steps.filter((step) => step !== 'install')
          : recovery.view.steps,
      invocation: request.invocation ?? recovery.view.invocation,
    };
  }
  const { name, files: others } = starterFolder(root);
  let raw: Readonly<Record<string, unknown>>, descriptor: ReleaseDescriptor;
  try {
    raw = readWorkspaceJson({ root, path: DESCRIPTOR_PATH }) as Readonly<Record<string, unknown>>;
    descriptor = decodeReleaseDescriptor(raw);
  } catch (error) {
    throw unshaped(
      `${DESCRIPTOR_PATH} is not a release descriptor (${error instanceof Error ? error.message : String(error)})`,
      DESCRIPTOR_PATH,
    );
  }
  if (descriptor.distribution === undefined)
    throw unshaped(
      `${DESCRIPTOR_PATH} names no distribution, where a ${MIGRATES_FROM} starter's names its own`,
      DESCRIPTOR_PATH,
    );
  const session = openSession(root);
  let records: readonly Compiled[], admitted: boolean;
  try {
    records = session.reader.records();
    admitted = session.admission().status === 'admitted';
  } finally {
    session.close();
  }
  if (!admitted)
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The workspace does not admit; migrating it needs zero error findings',
      3,
      { path: root },
      `Run "ia validate --root ${quote(root)}" and fix the reported errors.`,
    );
  const at = (path: string): readonly Compiled[] => records.filter((record) => record.source.path === path);
  const identities = (path: string): readonly string[] =>
    at(path)
      .map((record) => record.identity)
      .sort();
  /** The records `path` holds, which must be exactly `expected`. */
  const holds = (path: string, expected: readonly (readonly [string, string])[]): readonly Compiled[] => {
    const found = at(path);
    if (
      found.length !== expected.length ||
      !expected.every(([word, named]) => found.some((record) => record.discriminator === word && record.name === named))
    )
      throw unshaped(
        `${path} holds ${found.length === 0 ? 'no record' : found.map(spelled).join(', ')}, where a ${MIGRATES_FROM} starter's holds exactly ${expected.map(([word, named]) => `@${word} ${named}`).join(' and ')}`,
        path,
      );
    return found;
  };
  const local = holds(systemPath(name), [
    ['system', name],
    ['agent', `${name}-steward`],
  ]);
  const starter = holds(legacyRecordsPath(name), [
    ['workspace', name],
    ['distribution', `${name}-distribution`],
  ]);
  const registered = local
    .find((record) => record.discriminator === 'system')!
    .sections.find((section) => section.name === 'discriminators')
    ?.fields.flatMap((child) => ('key' in child ? [child.key] : []));
  if (registered !== undefined && registered.length > 0)
    throw unshaped(
      `its local @system ${name} registers ${registered.join(', ')}, where a ${MIGRATES_FROM} starter's registers no word`,
      systemPath(name),
    );
  const distribution = starter.find((record) => record.discriminator === 'distribution')!.identity;
  if (descriptor.distribution !== distribution)
    throw unshaped(
      `${DESCRIPTOR_PATH} names ${descriptor.distribution}, where a ${MIGRATES_FROM} starter's names ${distribution}`,
      DESCRIPTOR_PATH,
    );
  // The base the three records need. A 1.x base declares neither `composition.sources` and `composition.steward` nor
  // the `@mandate`'s `authority`, so another archive than the bundled one is replaced, which only a lock holding that
  // one base allows: a replacement resolved from the bundled archive alone would drop every other package.
  const base = readBase(request.packageRoot);
  const state = readInstalledState({ root });
  const lock = state.status === 'installed' ? state.lock : undefined;
  const locked = lock?.packages.find((pkg) => pkg.id === base.pin.id);
  const bundled = (pkg: { readonly archive: string; readonly manifest: string }): boolean =>
    pkg.archive === base.pin.archive && pkg.manifest === base.pin.manifest;
  if (
    locked === undefined ||
    (!bundled(locked) &&
      (lock!.packages.length !== 1 || lock!.requests.length !== 1 || lock!.requests[0]!.id !== base.pin.id))
  )
    throw unshaped(
      `${INSTALL_PATHS.lock} locks ${lock === undefined || lock.packages.length === 0 ? 'nothing' : lock.packages.map((pkg) => `${pkg.id} ${pkg.version}`).join(', ')}, where a ${MIGRATES_FROM} starter's locks only ${base.pin.id}, which the migration replaces with the archive this CLI bundles`,
      INSTALL_PATHS.lock,
    );
  // The new @workspace keeps the 1.x one's composition, less the local system, which only `--system` composes.
  const field = starter
    .find((record) => record.discriminator === 'workspace')!
    .sections.find((section) => section.name === 'composition')
    ?.fields.find((child) => 'key' in child && child.key === 'systems');
  const value = field === undefined || !('value' in field) ? undefined : field.value;
  const kept = (value === undefined ? [] : value.kind === 'list' ? value.items : [value]).flatMap((item) =>
    item.kind === 'ref' && item.discriminator === 'system' && item.name !== name ? [item.name] : [],
  );
  const planned = starterFiles(name, kept, system);
  const moves = others.map((file): MigrationMove => {
    const from = `${systemFolder(name)}/records/${file}`;
    return { from, to: `.ia/src/${file}`, identities: identities(from) };
  });
  const removes: readonly MigrationRemoval[] = [
    { path: legacyRecordsPath(name), identities: identities(legacyRecordsPath(name)) },
    ...(system
      ? []
      : [
          { path: systemPath(name), identities: identities(systemPath(name)) },
          ...[`${systemFolder(name)}/records/`, `${systemFolder(name)}/`, `${SYSTEMS}/`].map((path) => ({
            path,
            identities: [],
          })),
        ]),
  ];
  // The preflight's destination half: neither the starter file nor any moved file's destination may exist.
  const gitConflict = migrationGitConflict(root, base, lock!);
  const conflicts: MigrationConflict[] = gitConflict === null ? [] : [gitConflict];
  const legacyText = readWorkspaceFile({ root, path: legacyRecordsPath(name) })
    .toString('utf8')
    .replace(/\r\n/g, '\n');
  const stockWorkspace = starterRecords(name, kept)
    .split(`\n@agent ${name}\n`)[0]!
    .replace('    sources [".ia/src @authored"]\n', '')
    .replace(`    steward @agent ${name}\n`, '');
  const stockDistribution = starterDistribution(name)
    .replace('#! ia 1.0\n\n', '')
    .replace(`The release root of the ${name} system.`, `The release root of the ${name} workspace.`)
    .replace(`records [@system ${name}]`, `records [@workspace ${name}]`);
  const normalizeSystems = (text: string): string => text.replace(/^    systems \[[^\n]*\]$/m, '    systems []');
  if (normalizeSystems(legacyText) !== normalizeSystems(stockWorkspace + '\n' + stockDistribution))
    conflicts.push({
      path: legacyRecordsPath(name),
      reason:
        'Authored workspace or distribution text differs from the 1.1.0 starter; preserve these edits in an explicit migration before removing this file',
    });
  const occupied = (path: string): boolean => lstatSync(resolve(root, path), { throwIfNoEntry: false }) !== undefined;
  if (occupied(WORKSPACE_PATH))
    conflicts.push({ path: WORKSPACE_PATH, reason: 'Exists where the migration writes the three starter records' });
  for (const move of moves)
    if (occupied(move.to)) conflicts.push({ path: move.to, reason: `Exists where the migration moves ${move.from}` });
  // Its identity half: a word and name compile to one identity wherever they are written, so a record the workspace
  // keeps with a starter record's word and name would tie with the one the migration authors. A starter record found
  // at a path the migration deletes is the one it replaces; one at the planned record's own path, `--system`'s
  // `system.ia`, is kept.
  const deleted = new Set(removes.map((removal) => removal.path));
  for (const record of planned.records)
    for (const found of records)
      if (
        found.discriminator === record.word &&
        found.name === record.name &&
        found.source.path !== record.path &&
        !deleted.has(found.source.path)
      )
        conflicts.push({
          path: found.source.path,
          reason: `Holds @${record.word} ${record.name}, which the migration authors in ${record.path}`,
        });
  // Spec §8: a pending host journal refuses the whole verb and names the recovery that clears it, as `ia host` does.
  if (!system) {
    const removedRecords = [...local, ...starter.filter((record) => record.discriminator === 'distribution')];
    const references = (value: unknown, word: string, name: string, identity: string): boolean => {
      if (value === null || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some((child) => references(child, word, name, identity));
      const item = value as Record<string, unknown>;
      if (item['kind'] === 'ref' && item['discriminator'] === word && item['name'] === name) return true;
      if (item['kind'] === 'identity' && item['identity'] === identity) return true;
      return Object.values(item).some((child) => references(child, word, name, identity));
    };
    for (const record of records)
      if (!deleted.has(record.source.path))
        for (const removed of removedRecords)
          if (references(record, removed.discriminator, removed.name, removed.identity))
            conflicts.push({
              path: record.source.path,
              reason: `${spelled(record)} references ${removed.identity}, which the migration deletes; use --system to retain it`,
            });
  }
  const hosts: MigrationHost[] = [],
    projected = registeredProjections(root, 'update');
  if (projected.length > 0)
    try {
      assertHostRegistrationIdle(root);
    } catch (error) {
      const refusal = refusalOf(error),
        [journal, command] = JOURNALS.find(([path]) => existsSync(resolve(root, path))) ?? JOURNALS[0]!;
      throw new Refusal(
        refusal.code,
        refusal.message,
        3,
        { path: journal },
        `Run "${recoverCommand(command, root)}"${THEN_RERUN}`,
      );
    }
  for (const host of projected)
    try {
      const guard = planRetirement(root, host) === null ? 'none' : 'retire';
      hosts.push({ host, guard, files: migratedFiles(root, host) });
    } catch (error) {
      const refusal = refusalOf(error);
      conflicts.push({
        path: refusedPath(error) ?? STATE.projection(host),
        reason: refusal.message,
        host,
        code: refusal.code,
      });
    }
  // The descriptor depends on the bundled base, as `ia init` writes it, in place of its row for the installed base, and
  // keeps every other row; it names no distribution without `--system`. Rows stay sorted by id, as the decoder requires.
  const dependencies = [
    ...descriptor.dependencies.filter((row) => row.id !== base.pin.id),
    ...baseDependencies(base),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  const text = `${JSON.stringify(
    Object.fromEntries(
      Object.entries(raw)
        .filter(([key]) => system || key !== 'distribution')
        .map(([key, item]) => [key, key === 'dependencies' ? dependencies : item]),
    ),
    null,
    2,
  )}\n`;
  return {
    root,
    id: descriptor.id,
    name,
    system,
    base: { pin: base.pin, installed: { version: locked.version, archive: locked.archive } },
    conflicts,
    moves,
    files: planned.files.filter((file) => file.path !== systemPath(name)),
    records: planned.records,
    systems: system ? [...kept, name] : kept,
    removes,
    ignore: existsSync(resolve(root, IGNORE_PATH)) ? 'present' : 'create',
    descriptor: {
      before: distribution,
      after: system ? distribution : null,
      dependencies: { before: descriptor.dependencies, after: dependencies },
    },
    // Without `--system` the distribution goes, so the descriptor is always rewritten; with it, only a new base row
    // rewrites it, so one that differs from these bytes in formatting alone, such as its line endings, is left as it is.
    rewrite: system && spelledRows(descriptor.dependencies) === spelledRows(dependencies) ? null : text,
    hosts,
    steps: [
      ...(bundled(locked) ? [] : ['install' as const]),
      'move',
      'author',
      'remove',
      'descriptor',
      'admission',
      'capture',
      ...(hosts.length === 0 ? [] : ['project' as const]),
    ],
    invocation: request.invocation ?? `ia init ${quote(root)} --migrate${system ? ' --system' : ''}`,
  };
}
/**
 * A registered host's file plan for the migrated records, before they exist. Every file the adapter renders carries
 * the workspace revision, which the migration changes, so the apply rewrites each one this render leaves unchanged:
 * that one is planned with a text that differs from its bytes, as the apply's will, which the planner reads as an
 * update of an owned file or refuses as one this workspace does not own. Every other action, and every refusal,
 * depends on the files on disk alone.
 */
function migratedFiles(root: string, host: HostName): readonly ProjectionAction[] {
  const rendered = renderProjectionFor(root, host),
    { actions } = planFiles(root, host, rendered),
    unchanged = new Set(actions.filter((row) => row.action === 'unchanged').map((row) => row.path));
  if (unchanged.size === 0) return actions;
  return planFiles(root, host, {
    ...rendered,
    files: rendered.files.map((file) => (unchanged.has(file.path) ? { ...file, text: `${file.text}\n` } : file)),
  }).actions;
}

/**
 * `--apply`'s refusal of a plan with conflicts, before anything is written. A file in a destination's way, or a record
 * holding a starter record's word and name, is the migration's own conflict, so it names the plan, which lists each
 * one; a registered projection the planner refuses alone names that host's plan, which names each file it refuses
 * with its repair.
 */
function migrationRefusal(view: MigrationView): Refusal {
  const collisions = view.conflicts.filter((row) => row.host === undefined);
  if (collisions.length === 0) {
    const first = view.conflicts[0]!;
    return new Refusal(
      first.code ?? 'IA-CLI-CONFLICT',
      first.reason,
      3,
      { path: first.path },
      `Run "ia host ${first.host!} --root ${quote(view.root)}" for its projection plan, which names each file it refuses.`,
    );
  }
  return new Refusal(
    'IA-CLI-CONFLICT',
    conflictMessage(view.conflicts, 'the migration'),
    3,
    { path: view.root },
    `Run "${view.invocation}" to review the plan and its conflicts.`,
  );
}

export interface MigrationOptions {
  /** The `@inventarch/cli` package root: its bundled base is read again and must be the one the plan showed. */
  readonly packageRoot: string;
  readonly signal?: AbortSignal | undefined;
  /**
   * Called with every `applyInstallation` checkpoint name when the base is installed, and with `migrate:<step>` after
   * each step completes, which is where a failure test cuts.
   */
  readonly checkpoint?: ((name: string) => void) | undefined;
}
/**
 * The sentence each refusal after the file steps opens its next action with: the records are in the new shape, and,
 * once the capture effect has run or failed, whether it was taken, as `ia init`'s say it.
 */
const MIGRATED = 'The workspace is migrated.';
const MIGRATED_CAPTURED = 'The workspace is migrated and captured.';
const MIGRATED_UNCAPTURED = 'The workspace is migrated but not captured.';
/**
 * The admission step `ia init` and `ia init --migrate` share: zero error findings, then each planned starter record as
 * the compiled graph holds it at its path, never string-constructed (M5.1 §2.3), with every record the graph holds.
 * `done` opens each refusal's next action with what the command completed before it, if anything.
 */
function admitStarter(
  root: string,
  planned: readonly StarterRecord[],
  what: 'initialized' | 'migrated',
  done: string,
): { readonly compiled: readonly Compiled[]; readonly records: readonly Compiled[] } {
  const session = openWorkspaceSession({ root });
  try {
    const errors = session.admission().findings.filter((finding) => finding.severity === 'error');
    if (errors.length > 0)
      throw new Refusal(
        'IA-CLI-FAILED',
        `The ${what} workspace failed admission with ${errors.length} error findings; first: ${errors[0]!.code}`,
        3,
        { path: root },
        `${done}Run "ia validate --root ${quote(root)}" for the findings.`,
      );
    const records = session.reader.records();
    const compiled = planned.map((starter) => {
      const record = records.find(
        (node) =>
          node.discriminator === starter.word && node.name === starter.name && node.source.path === starter.path,
      );
      if (record === undefined)
        throw new Refusal(
          'IA-CLI-FAILED',
          `The compiled workspace has no @${starter.word} ${starter.name} in ${starter.path}`,
          3,
          { path: root },
          `${done}Run "ia inspect --path ${starter.path} --root ${quote(root)}" for the records that file admitted.`,
        );
      return record;
    });
    return { compiled, records };
  } finally {
    session.close();
  }
}

/**
 * Apply the exact migration plan through a durable operation journal. File mutations are resumed only from their
 * recorded before/after digests. Capture and each host projection follow admission; a completed host receipt is
 * verified and retained on resume, including the window before its journal completion marker was published.
 * Every interrupted effect names the same migration command, after a pending host transaction is recovered.
 */
export async function applyMigration(view: MigrationView, options: MigrationOptions): Promise<Migrated> {
  if (view.conflicts.length > 0) throw migrationRefusal(view);
  const { root } = view;
  // Rebuild from the verified operation options so the retry is rooted even when the original target was relative.
  const resume = `ia init ${quote(root)} --migrate${view.system ? ' --system' : ''} --apply --yes`;
  const checkpoint = (name: string): void => {
    try {
      options.checkpoint?.(name);
    } catch (error) {
      const refusal = refusalOf(error);
      throw new Refusal(
        refusal.code,
        refusal.message,
        3,
        refusal.where,
        `The migration is recorded in .ia/migration.json. Run "${resume}" again to finish migrating.`,
      );
    }
  };
  const base = readBase(options.packageRoot);
  if (base.pin.archive !== view.base.pin.archive || base.pin.manifest !== view.base.pin.manifest)
    throw new Refusal(
      'IA-CLI-FAILED',
      'The bundled base package changed while planning',
      3,
      { path: resolve(options.packageRoot, PIN_PATH) },
      DAMAGED,
    );
  options.signal?.throwIfAborted();
  const existingJournal = readMigrationJournal(root, view.system, base.pin);
  if (existingJournal === null) {
    const fresh = collectMigration({
      root,
      system: view.system,
      packageRoot: options.packageRoot,
      invocation: view.invocation,
    });
    if (fresh.conflicts.length > 0) throw migrationRefusal(fresh);
    if (JSON.stringify(fresh) !== JSON.stringify(view))
      throw new Refusal(
        'IA-CLI-CONFLICT',
        'The migration inputs changed after planning',
        3,
        { path: root },
        `Run "${view.invocation}" again to review the current plan.`,
      );
  }
  const journal = existingJournal ?? beginMigrationJournal(view, migrationIgnoreText(root));
  const install = view.steps.includes('install');
  if (
    install &&
    readInstalledState({ root }).lock?.packages.find((row) => row.id === base.pin.id)?.archive !== base.pin.archive
  ) {
    const interrupted = new Interrupted(`Run "${resume}" again to finish migrating.`);
    await installBase(root, base, 'update', { signal: options.signal, checkpoint }, interrupted);
    checkpoint('migrate:install');
    if (options.signal?.aborted) throw interrupted;
  }
  const ignore = view.ignore === 'create' ? 'written' : 'present';
  const removed = view.removes.map((row) => row.path);
  try {
    applyMigrationFiles(journal, checkpoint, options.signal);
  } catch (error) {
    const refusal = refusalOf(error);
    throw new Refusal(
      refusal.code,
      refusal.message,
      3,
      refusal.where ?? { path: root },
      `The migration is recorded in .ia/migration.json; nothing was rolled back. Repair the reported filesystem problem, then run "${resume}" again to finish migrating.`,
    );
  }
  // Neither effect has run, so the refusal says so before the one command it names.
  const { compiled, records } = admitStarter(
    root,
    view.records,
    'migrated',
    view.hosts.length === 0
      ? `${MIGRATED_UNCAPTURED} `
      : 'The workspace is migrated but neither captured nor projected. ',
  );
  const moved = view.moves.map(
    (move): MigrationMove => ({
      ...move,
      identities: records
        .filter((record) => record.source.path === move.to)
        .map((record) => record.identity)
        .sort(),
    }),
  );
  checkpoint('migrate:admission');
  // The capture effect, as `ia init` takes it: refused as `ia capture` refuses, with its repair, for this root.
  const recapture = `ia capture --root ${quote(root)}`;
  let capture: CaptureEffect | undefined, failed: Refusal | undefined;
  if (options.signal?.aborted) {
    if (view.hosts.length === 0) throw new Interrupted(`${MIGRATED} Run "${resume}" to finish migrating.`);
  } else
    try {
      const written = collectCapture(root, root);
      capture = { revision: written.snapshot.revision, records: written.snapshot.counts.records };
    } catch (error) {
      failed = refusalOf(captureFailure(error, root, recapture));
    }
  if (capture !== undefined) checkpoint('migrate:capture');
  // The project effect: each registered host, through the one writer of projection files.
  const captured = capture === undefined ? MIGRATED_UNCAPTURED : MIGRATED_CAPTURED;
  const projected: MigratedProjection[] = [],
    refused: Refusal[] = [];
  for (const { host } of view.hosts) {
    const finish = resume;
    if (options.signal?.aborted) throw new Interrupted(`${captured} Run "${finish}" to finish migrating.`);
    try {
      const rendered = renderProjectionFor(root, host);
      const prior = readReceipt(root, host);
      const priorDigest = prior === null ? null : sha256(readWorkspaceFile({ root, path: STATE.receipt(host) }));
      const completed =
        prior !== null &&
        priorDigest !== journal.receiptsBefore[host] &&
        prior.packetDigest === rendered.receipt.packetDigest &&
        prior.revision === rendered.receipt.revision &&
        prior.bodyDigest === rendered.receipt.bodyDigest &&
        prior.guard ===
          (journal.view.hosts.find((row) => row.host === host)!.guard === 'retire' ? 'retired' : 'none') &&
        JSON.stringify(prior.removed) === JSON.stringify(journal.removals[host]) &&
        prior.adapter === rendered.receipt.adapter &&
        JSON.stringify(prior.files.map((file) => file.path)) ===
          JSON.stringify(rendered.receipt.files.map((file) => file.path)) &&
        prior.files.every((file) => sha256(readWorkspaceFile({ root, path: file.path })) === file.sha256) &&
        prior.removed.every((file) => !existsSync(resolve(root, file.path))) &&
        planRetirement(root, host) === null &&
        planFiles(root, host, {
          ...rendered,
          files: prior.files.map((file) => ({
            path: file.path,
            text: readWorkspaceFile({ root, path: file.path }).toString('utf8'),
          })),
        }).actions.every((action) => action.action === 'unchanged' || action.action === 'foreign');
      if (journal.completed[host] !== undefined && !completed)
        throw new Refusal(
          'IA-CLI-CONFLICT',
          'Completed migration projection differs from its receipt',
          3,
          { path: STATE.receipt(host) },
          `Restore the projected files to their receipt digests, then run "${resume}".`,
        );
      const refresh = completed && JSON.stringify(prior!.files) !== JSON.stringify(rendered.receipt.files);
      if (refresh) reopenMigrationProjection(journal, host);
      const applied =
        completed && !refresh
          ? { receipt: prior!, guard: prior!.guard }
          : applyHostProjection(root, host, rendered, undefined, refresh ? prior! : undefined);
      // Receipt publication is itself recoverable before the journal completion marker advances.
      checkpoint(`migrate:project:${host}:receipt`);
      completeMigrationProjection(journal, host);
      const receipt = applied.receipt!;
      projected.push({
        host,
        files: receipt.files,
        receipt: STATE.receipt(host),
        guard: applied.guard,
        removed: receipt.removed.map((file) => file.path),
      });
      checkpoint(`migrate:project:${host}`);
    } catch (error) {
      const refusal = refusalOf(error),
        path = refusedPath(error);
      refused.push(
        new Refusal(
          refusal.code,
          refusal.message,
          3,
          path === null ? refusal.where : { path },
          `${captured} ${JOURNALS.some(([journal]) => existsSync(resolve(root, journal))) ? `Run "${recoverCommand(JOURNALS.find(([journal]) => existsSync(resolve(root, journal)))![1], root)}" first, then rerun this migration with the same target and options to finish.` : path === null ? `Repair the reported filesystem problem, then run "${resume}" to finish migrating.` : projectionRepair(host, path, resume, refusal.code)}`,
        ),
      );
    }
  }
  if (projected.length > 0) checkpoint('migrate:project');
  const first = refused[0];
  if (first !== undefined)
    throw new Refusal(
      first.code,
      refused.length > 1
        ? `${first.message}. ${refused.length} registered host projections were not written; this is the first.`
        : first.message,
      3,
      first.where,
      first.next,
    );
  if (failed !== undefined)
    throw new Refusal(
      failed.code,
      failed.message,
      3,
      failed.where,
      `${
        projected.length === 0
          ? MIGRATED
          : `The workspace is migrated and its ${projected.map((row) => row.host).join(' and ')} ${projected.length === 1 ? 'projection is' : 'projections are'} written.`
      } ${failed.next?.replace(`"${recapture}"`, `"${resume}"`) ?? `Run "${resume}" to finish migrating.`}`,
    );
  if (capture === undefined) throw new Interrupted(`${MIGRATED} Run "${resume}" to finish migrating.`);
  checkpoint('migrate:complete');
  finishMigrationJournal(root);
  return {
    status: 'migrated',
    id: view.id,
    base: install ? 'installed' : 'present',
    distribution: compiled.find((record) => record.discriminator === 'distribution')?.identity ?? null,
    authored: compiled.map((record) => record.identity),
    moved,
    removed,
    ignore,
    effects: { capture, project: projected },
  };
}

export function migrationEnvelope(view: MigrationView, apply: boolean, applied: Migrated | null = null): unknown {
  return {
    version: 1,
    command: 'init',
    root: view.root,
    apply,
    plan: {
      migrate: MIGRATES_FROM,
      id: view.id,
      name: view.name,
      system: view.system,
      base: {
        id: view.base.pin.id,
        installed: view.base.installed,
        bundled: { version: view.base.pin.version, archive: view.base.pin.archive },
      },
      conflicts: view.conflicts,
      steps: view.steps,
      moves: view.moves,
      writes: view.files.map((file) => file.path),
      records: view.records.map((record) => `@${record.word} ${record.name}`),
      systems: view.systems,
      removes: view.removes,
      ignore: { path: IGNORE_PATH, status: view.ignore },
      descriptor: { path: DESCRIPTOR_PATH, ...view.descriptor },
      hosts: view.hosts,
    },
    ...(applied === null ? {} : { applied }),
  };
}

/** One row per file: its path, then what the migration does to it, each row on one content column (§6.4 rule 2). */
const fileRows = (
  rows: readonly { readonly symbol: SymbolName; readonly path: string; readonly text: string }[],
  caps: Capabilities,
): readonly string[] => {
  const symbolWidth = blockSymbolWidth(
    rows.map((row) => row.symbol),
    caps.ascii,
  );
  return rows.flatMap((row) =>
    entry(
      [[atom(row.path, 'cyan', 0), ...words(row.text, null, 2)]],
      { depth: 1, symbol: row.symbol, symbolWidth },
      caps,
    ),
  );
};
const migrationBlocks = (view: MigrationView, caps: Capabilities): readonly (readonly string[])[] => {
  const { name } = view,
    { pin } = view.base,
    { dependencies } = view.descriptor;
  // Only the base's row changes; every other row is kept as it is.
  const was = dependencies.before.find((row) => row.id === pin.id),
    now = dependencies.after.find((row) => row.id === pin.id)!;
  const conflicts: readonly Field[] = view.conflicts.map((row) => ({
    symbol: 'warning' as const,
    label: row.path,
    value: words(row.host === undefined ? row.reason : `the ${row.host} projection: ${row.code} ${row.reason}`),
  }));
  const project = view.hosts.map((planned) => ({
    symbol: 'added' as const,
    label: `Project ${planned.host}`,
    value: words(
      [
        ...(planned.guard === 'retire' ? [`first retires the steward guard registered in ${SETTINGS}`] : []),
        ...planned.files.map(
          (file) => `${file.path} ${file.action === 'foreign' ? 'foreign, left in place' : file.action}`,
        ),
      ].join('; '),
    ),
  }));
  return [
    [
      sectionLabel('Conflicts', caps),
      ...(conflicts.length === 0
        ? entry(
            [
              words(
                "None. No destination exists, no record holds a starter record's word and name, and every registered projection plans.",
              ),
            ],
            { depth: 1, symbol: 'success' },
            caps,
          )
        : fieldRows(conflicts, { depth: 1 }, caps)),
    ],
    [
      sectionLabel('Base', caps),
      ...fieldRows(
        [
          view.steps.includes('install')
            ? {
                symbol: 'added',
                label: 'Install',
                value: words(
                  `${pin.id} ${pin.version} from the bundled archive, sha256 ${truncateDigest(pin.archive, caps.ascii)}, in place of the installed ${view.base.installed.version}, sha256 ${truncateDigest(view.base.installed.archive, caps.ascii)}, which may not declare the fields the three records use`,
                ),
              }
            : {
                symbol: 'info',
                label: 'Base package',
                value: words(`${pin.id} ${pin.version} from the bundled archive, already installed`),
              },
        ],
        { depth: 1 },
        caps,
      ),
    ],
    [
      sectionLabel('Records', caps),
      ...fileRows(
        [
          ...view.moves.map((move) => ({
            symbol: 'updated' as const,
            path: move.from,
            text: `moves to ${move.to}${move.identities.length === 0 ? '' : `, holding ${move.identities.join(', ')}`}`,
          })),
          {
            symbol: 'added',
            path: WORKSPACE_PATH,
            text: `@workspace ${name} composing ${view.systems.length} systems; its participant @agent ${name}; @mandate ${name}-mandate`,
          },
          ...(view.system
            ? [
                {
                  symbol: 'added' as const,
                  path: distributionPath(name),
                  text: `@distribution ${name}-distribution rooted at @system ${name}, in place of the one rooted at @workspace ${name}`,
                },
                { symbol: 'info' as const, path: systemPath(name), text: `kept: @system ${name} and its steward` },
              ]
            : []),
          {
            symbol: view.ignore === 'create' ? 'added' : 'info',
            path: IGNORE_PATH,
            text:
              view.ignore === 'create'
                ? migrationIgnoreText(view.root) === IGNORE_TEXT
                  ? 'ignores work/ and distributions/'
                  : 'ignores work/; tracked distributions remain visible to Git'
                : 'exists and is left as it is',
          },
          ...view.removes.map((removal) => ({
            symbol: 'removed' as const,
            path: removal.path,
            text: removal.path.endsWith('/') ? 'deleted once empty' : `deleted, with ${removal.identities.join(', ')}`,
          })),
          {
            symbol: view.rewrite === null ? 'info' : 'updated',
            path: DESCRIPTOR_PATH,
            text: `${
              view.descriptor.after === null
                ? `drops distribution ${view.descriptor.before}, so ia pack refuses until one is authored`
                : `keeps distribution ${view.descriptor.before}`
            }${
              spelledRows(dependencies.before) === spelledRows(dependencies.after)
                ? ''
                : `; depends on ${now.id} ${now.range}, the bundled base, ${was === undefined ? 'which it did not name' : `in place of ${was.id} ${was.range}`}`
            }`,
          },
        ],
        caps,
      ),
    ],
    [
      sectionLabel('Effects', caps),
      ...fieldRows(
        [
          { symbol: 'added', label: 'Capture', value: words(`${CURRENT}, as ia capture writes it`) },
          ...(project.length === 0
            ? [
                {
                  symbol: 'info' as const,
                  label: 'Project',
                  value: words(
                    view.conflicts.some((row) => row.host !== undefined)
                      ? 'Not planned: each registered projection conflicts, as listed above'
                      : 'No host projection is registered',
                  ),
                },
              ]
            : project),
        ],
        { depth: 1 },
        caps,
      ),
    ],
  ];
};
const migrationHeader = (view: MigrationView, caps: Capabilities): readonly string[] =>
  headerLine('Plan', `init --migrate from ${MIGRATES_FROM}`, [{ text: view.root, column: 50 }], caps);
export function renderMigration(view: MigrationView, caps: Capabilities): string {
  const next =
    view.conflicts.length > 0
      ? `Resolve the conflicts above, then run "${view.invocation} --apply --yes".`
      : `Apply with "${view.invocation} --apply --yes".`;
  return document(
    [
      migrationHeader(view, caps),
      entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps),
      ...migrationBlocks(view, caps),
      entry([words(next)], { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );
}
/** §2.8 rule 3's change summary: the plan's own blocks without the preview note or the footer. */
const renderMigrationSummary = (view: MigrationView, caps: Capabilities): string =>
  document([migrationHeader(view, caps), ...migrationBlocks(view, caps)], { leadingBlank: true });
export function renderMigrated(view: MigrationView, applied: Migrated, caps: Capabilities): string {
  return document(
    [
      headerLine('Init', applied.id, [{ text: view.root, column: 50 }], caps),
      entry(
        [
          words(
            `Migrated ${applied.id} from the ${MIGRATES_FROM} starter; release descriptor ${DESCRIPTOR_PATH}${applied.distribution === null ? ', which names no distribution' : `, naming ${applied.distribution}`}.`,
          ),
          words(
            applied.base === 'installed'
              ? `Installed ${view.base.pin.id} ${view.base.pin.version} from the bundled archive.`
              : `${view.base.pin.id} ${view.base.pin.version} from the bundled archive was already installed.`,
          ),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      authoredEntry(
        applied,
        caps,
        readFileSync(resolve(view.root, IGNORE_PATH), 'utf8').includes('distributions/')
          ? 'work/ and distributions/'
          : 'work/',
      ),
      ...applied.moved.map((move) =>
        entry(
          [
            [atom(move.from, 'cyan', 0), ...words(`moved to ${move.to}`, null, 1)],
            ...(move.identities.length === 0 ? [] : [words(`It holds ${move.identities.join(', ')}.`)]),
          ],
          { depth: 1, symbol: 'success' },
          caps,
        ),
      ),
      entry(
        [
          words(`Deleted ${applied.removed.join(', ')}.`),
          ...(view.system ? [words(`Kept @system ${view.name} and its steward in ${systemPath(view.name)}.`)] : []),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      capturedEntry(applied.effects.capture, caps),
      ...(applied.effects.project.length === 0
        ? [entry([words('Project skipped: no host projection is registered.')], { depth: 1, symbol: 'info' }, caps)]
        : applied.effects.project.map((projection) =>
            entry(
              [
                words(`Projected the position packet for ${projection.host}:`),
                ...projection.files.map((file) => [atom(file.path, 'cyan', 0)]),
                words(`Receipt ${projection.receipt}.`),
                ...(projection.removed.length === 0
                  ? []
                  : [words(`Deleted the 1.x projection files ${projection.removed.join(', ')}.`)]),
                ...(projection.guard === 'retired' ? [words(GUARD_RETIRED)] : []),
              ],
              { depth: 1, symbol: 'success' },
              caps,
            ),
          )),
      closingEntry(applied.distribution, caps),
    ],
    { leadingBlank: true },
  );
}

/** `ia init --migrate`: the plan, which reports its conflicts, or once confirmed its apply. */
async function migrate(context: Context, root: string): Promise<Result> {
  const { args, caps, json, host } = context;
  const apply = args.flag('apply');
  const view = collectMigration({
    root,
    system: args.flag('system'),
    packageRoot: host.packageRoot,
    invocation: invocationOf(context),
  });
  const rendered = (applied: Migrated | null): Result =>
    json
      ? { exitCode: 0, stdout: JSON.stringify(migrationEnvelope(view, apply, applied)) + '\n', stderr: '' }
      : {
          exitCode: 0,
          stdout: applied === null ? renderMigration(view, caps) : renderMigrated(view, applied, caps),
          stderr: '',
        };
  if (!apply) return rendered(null);
  if (view.conflicts.length > 0) throw migrationRefusal(view);
  if (!args.flag('yes') && !(await confirm(host.interaction, renderMigrationSummary(view, caps), CONFIRMATION)))
    return { exitCode: 0, stdout: renderDeclined(view, caps), stderr: '' };
  return rendered(await applyMigration(view, { packageRoot: host.packageRoot, signal: host.signal }));
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
