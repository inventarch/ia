/**
 * `ia doctor`: docs/specs/consumer-cli-contract/README.md §2.12.
 *
 * Five statuses, five count keys, one bucket per row, and no implicit repair: where a remedy exists this command
 * prints the exact command, and where the remedy is on the other binary it says so. `unknown` means a check could
 * not be performed and is never reported as `ok` — which is why every installation row is `unknown` without a
 * workspace rather than a cheerful pass.
 *
 * Host state is observed, never assumed (docs/specs/host-registration/README.md §7). `readInstalledState`
 * with `hosts: true` compares each host's ownership state against the files it wrote and against this installation's
 * payload pin: `registered` is `ok` and its detail says "written; not observed answering", because doctor never
 * starts a server and a written registration is not a server that answered; `stale` is `fail`, so doctor exits 1
 * (REQ-HRC-5), and its detail names each reason and the repair that works for it; no host state at all is `info`.
 * Projection drift is one row per managed file. An installation that carries no host payload is a note, not a crash:
 * the release comparison is skipped and the row says so. Observation is total — a malformed state file is a `fail`
 * row, never an exception — and nothing here writes, the host home included. Repairs are worded by `ia host`'s own
 * `stateRepair` and `modifiedRepair`, so the two verbs cannot disagree, and every `ia host` command printed carries
 * `--root` when doctor was given one.
 *
 * The support row compares an observed platform and version against the declaration at
 * docs/reports/open-source-v1/2026-09-30/decisions.md:13. It says "matches the declared target", never "qualified", because
 * that declaration says the minimum must be validated before being advertised. A platform outside it is `warn`,
 * never `fail`, and the word "unsupported" is not used about it.
 *
 * The environment is a parameter rather than a read of the process, so this verb is testable and so the contract's
 * §7 examples can state which machine's Node version and platform they show.
 *
 * docs/specs/host-plugin-distribution/README.md §7.3 adds rows that exist with or without a workspace
 * (`doctor-user.ts`: install channel, IA home, Claude plugin, §11's cached update check and local language
 * compatibility, initialization decision) and, per host, a warning when
 * a registration pins its payload outside the current IA home (§3). `--host <id>` adds §8.2's `session` briefing and
 * §7.3's `nextActions` to the JSON envelope (`briefing.ts`); neither adds a write, so doctor stays read-only
 * (Amendment item 4).
 *
 * docs/specs/registry/README.md §4 ("Doctor") adds a `registry-<provider>` row for each provider the
 * workspace's lock names in its requests and packages: the base §4's precedence chooses and the level that chose it.
 * The portable lock is read on its own, so a fresh clone, or an installation whose activation pointer is missing,
 * unusable or drifted from, keeps its rows. Choosing reads configuration files only, so doctor never contacts a
 * registry.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WORKSPACE_PROJECTION_MARKER } from '@ia/compliance';
// `within` judges nesting on disk, so a home or cache spelled in another case or normalization is still where it is (#315).
import { pathKey, within } from '@ia/db';
import { decodeDistributionJson, INSTALL_PATHS } from '@ia/db/distribution';
import type { DistributionLock } from '@ia/db/distribution';
import { verifyHostCache } from '@ia/distribution/host';
import { hostPayloadPath, legacyHostHome } from '@ia/distribution/host-home';
import { resolveIaHome } from '@ia/distribution/ia-home';
import type { ProjectionDrift } from '@ia/distribution/projection';
import { observeProjection } from '@ia/distribution/projection';
import { registryChooser, registryLocation } from '@ia/distribution/registry';
import type { HostObservation } from '@ia/distribution/services';
import { readInstalledState, readWorkspaceLock, validateWorkspace } from '@ia/distribution/services';
import { brief } from './briefing.js';
import type { BriefInput } from './briefing.js';
import type { Channel } from './channel.js';
import type { Context, Result } from './consumer.js';
import { discoverRoot, iaHomeOf } from './consumer.js';
import { UNMAPPED } from './distribute.js';
import { userRows } from './doctor-user.js';
import type { Artifact, HostName } from './host-projection.js';
import { renderProjectionFor } from './host-projection.js';
import {
  HOST_LOCK,
  HOSTS_AREA,
  JOURNALS,
  MCP_PATH,
  modifiedRepair,
  pinnedRelease,
  projectionRepair,
  recoverCommand,
  refusedPath,
  rootedNext,
  SETTINGS,
  STATE,
  stateRepair,
} from './host.js';
import type { Pinned } from './host.js';
import { codeOf } from './session.js';
import type { Capabilities, Field, SymbolName } from './render.js';
import { atom, document, entry, fieldRows, sectionLabel, words } from './render.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown' | 'info';
export type Section = 'Environment' | 'Workspace' | 'Installation';
export interface Check {
  readonly id: string;
  readonly section: Section;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly remedy: string | null;
}
export interface DoctorView {
  readonly checks: readonly Check[];
  readonly counts: Readonly<Record<CheckStatus, number>>;
  /** Host plugin distribution spec §7.3 and §8.2: present only when `--host` was given. */
  readonly briefing?: ReturnType<typeof brief>;
}
export interface Runtime {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}
export interface DoctorRequest {
  readonly cwd: string;
  /** The supplied `--root`, or undefined to discover one. Absence is a check result, not a refusal (§2.0). */
  readonly root?: string | undefined;
  readonly packageRoot: string;
  readonly runtime: Runtime;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory, used to resolve the IA home when IA_HOME (or its IA_HOST_HOME alias) is unset (host plugin distribution spec §3); the process's by default. */
  readonly home?: string | undefined;
  /** This ia's version, compared with the version the materialized plugin records (host plugin distribution spec §7.3). */
  readonly version?: string;
  /** `--host`: adds the §8.2 session briefing and §7.3 next actions for this host. */
  readonly host?: string | undefined;
  /** The clock a `declined-today` decision is compared against (§9.1); now by default. */
  readonly now?: Date;
  /** The install channel as observed (§5); detected from `packageRoot` when absent. The contract's examples supply it. */
  readonly channel?: Channel | undefined;
}

/** decisions.md:13. Linux and Windows on x64 and macOS on arm64, on Node 22 with 22.22.0 the initial minimum; pnpm is contributor-only. */
export const SUPPORTED_TARGETS: readonly { readonly platform: string; readonly arch: string }[] = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
];
const PLATFORM_NAMES: Readonly<Record<string, string>> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };
/** The declared target in words, built from the list the verdict reads, so the text cannot drift from the check. */
const targetNames = (): string => {
  const names = SUPPORTED_TARGETS.map(
    (target) => `${PLATFORM_NAMES[target.platform] ?? target.platform} ${target.arch}`,
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
};
export const SUPPORTED_MAJOR = 22;
export const MINIMUM_NODE = '22.22.0';
const INSTALL_LOCK = '.ia/distributions/install-lock.json';
const CACHE = '.ia/distributions/cache';
const ARCHIVE = /^[a-f0-9]{64}\.ia\.tgz$/;

const versionOrder = (value: string): readonly number[] =>
  (/^v?\d+\.\d+\.\d+/.exec(value)?.[0] ?? '0.0.0').replace(/^v/, '').split('.').map(Number);
const atLeast = (value: string, minimum: string): boolean => {
  const left = versionOrder(value),
    right = versionOrder(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
};
const count = (entries: readonly Check[]): Readonly<Record<CheckStatus, number>> => ({
  ok: entries.filter((check) => check.status === 'ok').length,
  warn: entries.filter((check) => check.status === 'warn').length,
  fail: entries.filter((check) => check.status === 'fail').length,
  unknown: entries.filter((check) => check.status === 'unknown').length,
  info: entries.filter((check) => check.status === 'info').length,
});

const environment = (request: DoctorRequest): readonly Check[] => {
  const { version, platform, arch } = request.runtime;
  const major = versionOrder(version)[0] ?? 0;
  const supported =
    SUPPORTED_TARGETS.some((target) => target.platform === platform && target.arch === arch) &&
    major === SUPPORTED_MAJOR &&
    atLeast(version, MINIMUM_NODE);
  const checks: Check[] = [
    {
      id: 'node',
      section: 'Environment',
      title: 'Node',
      status: major >= SUPPORTED_MAJOR ? 'ok' : 'fail',
      detail: `${version} on ${platform} ${arch}`,
      remedy: major >= SUPPORTED_MAJOR ? null : `Install Node ${SUPPORTED_MAJOR} (${MINIMUM_NODE} or later)`,
    },
    {
      id: 'support-target',
      section: 'Environment',
      title: 'Support target',
      status: supported ? 'ok' : 'warn',
      detail: supported
        ? `${platform} ${arch} on Node ${major} matches the declared target`
        : `${platform} ${arch} on Node ${version} is outside the declared target of ${targetNames()} on Node ${SUPPORTED_MAJOR} from ${MINIMUM_NODE}; it is not qualified`,
      remedy:
        !supported && platform === 'darwin' && arch === 'x64'
          ? 'If this Mac has Apple silicon, this x64 build of Node runs under Rosetta: install the arm64 build. Intel Macs are outside the declared target.'
          : null,
    },
  ];
  try {
    const catalogue = JSON.parse(readFileSync(resolve(request.packageRoot, 'assets/vocabulary.json'), 'utf8')) as {
      readonly words: readonly unknown[];
      readonly sourceDigest: string;
    };
    checks.push({
      id: 'vocabulary',
      section: 'Environment',
      title: 'Vocabulary',
      status: 'ok',
      detail: `${catalogue.words.length} words, source digest ${catalogue.sourceDigest.slice(0, 12)}`,
      remedy: null,
    });
  } catch {
    checks.push({
      id: 'vocabulary',
      section: 'Environment',
      title: 'Vocabulary',
      status: 'unknown',
      detail: 'The shipped catalogue could not be read from this installation',
      remedy: 'Reinstall the package so assets/vocabulary.json travels with it',
    });
  }
  // pnpm is a contributor requirement, not a consumer one, so its absence is never a verdict about this run.
  const agent = request.env['npm_config_user_agent'];
  const pnpm = agent === undefined ? undefined : /pnpm\/(\S+)/.exec(agent)?.[1];
  checks.push({
    id: 'package-manager',
    section: 'Environment',
    title: 'Package manager',
    status: 'info',
    detail:
      pnpm === undefined
        ? 'Not reported by this invocation; pnpm 10.33.0 is a contributor requirement, not a consumer one'
        : `pnpm ${pnpm} invoked this command`,
    remedy: null,
  });
  return checks;
};

const directory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

// ---- Host rows: host registration spec §7 ----------------------------------------------------------------------

const PAYLOAD = /^[a-f0-9]{64}$/;
const short = (digest: string | null): string => (digest === null ? 'unknown' : digest.slice(0, 12));
/** An installation-section row; every host and projection row is one. */
const installation = (
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  remedy: string | null,
): Check => ({
  id,
  section: 'Installation',
  title,
  status,
  detail,
  remedy,
});

/**
 * How this report names `ia host` commands (the recoveries on the other binary always carry the root, quoted). With `--root` given, every command it prints carries it, in the form
 * `ia init --host` uses (`rootedNext`), so a remedy runs from any cwd; with a discovered root it is left out.
 */
interface Commands {
  /** A remedy: the bare apply command. */
  readonly apply: (host: HostName) => string;
  /** Prose that quotes `"ia host <host> ..."` commands. */
  readonly prose: (host: HostName, text: string) => string;
}
const commandsFor = (root: string | undefined): Commands => {
  const prose = (host: HostName, text: string): string => (root === undefined ? text : rootedNext(text, host, root));
  return { prose, apply: (host) => prose(host, `"ia host ${host} --apply"`).slice(1, -1) };
};

/**
 * §3.3: the payload this installation pins, and whether the host home holds it. Cheap on purpose — one stat and
 * one directory listing, no verification (each host row verifies the payload its registration uses). A `.stage-*`
 * directory is an unfinished materialization, never a payload, so only 64-hex names are listed.
 */
function payloadRow(request: DoctorRequest, pinned: Pinned): Check {
  if (pinned.release === null)
    return installation(
      'host-payload',
      'Host payload',
      'info',
      `This installation carries no host payload (${pinned.code}); ia host cannot register a host, ` +
        'and registered releases are not compared',
      'Reinstall the package so assets/host travels with it',
    );
  let home: string;
  try {
    home = resolveIaHome(request.env, request.home ?? homedir()).home;
  } catch (error) {
    return installation(
      'host-payload',
      'Host payload',
      'unknown',
      `Not checked; ${codeOf(error, 'the IA home could not be resolved')}: IA_HOME must be absolute`,
      'Set IA_HOME to an absolute directory, or unset it to use ~/.ia.',
    );
  }
  const hosts = join(home, 'hosts');
  let others: string[] = [];
  try {
    others = readdirSync(hosts).filter((name) => PAYLOAD.test(name) && name !== pinned.release);
  } catch {
    others = [];
  }
  const noun = others.length === 1 ? 'payload' : 'payloads';
  const listed =
    others.length === 0 ? '' : `; ${others.length} other ${noun} there: ${others.sort().map(short).join(', ')}`;
  const present = directory(hostPayloadPath(home, pinned.release));
  const state = present ? 'present' : 'not materialized; ia host materializes it on apply';
  return installation(
    'host-payload',
    'Host payload',
    'info',
    `Release ${short(pinned.release)}, ${state} in ${hosts}${listed}`,
    null,
  );
}

/**
 * Spec §8: the host lock and the three host journals, as the install lock and journal have their rows. A held lock is
 * `warn`, because a live run holds it too; its recovery clears only a dead holder's. A journal is `fail`, because
 * every `ia host` plan refuses until its own recovery runs (`assertHostRegistrationIdle`).
 */
function hostTransactionRows(root: string): readonly Check[] {
  const held = existsSync(resolve(root, HOST_LOCK));
  return [
    installation(
      'host-lock',
      'Host lock',
      held ? 'warn' : 'info',
      held
        ? `${HOST_LOCK} is held by another ia host run or was left by a killed one; the remedy clears a dead holder's lock and refuses a live one`
        : 'Not held',
      held ? recoverCommand('recover-host', root) : null,
    ),
    ...JOURNALS.filter(([path]) => existsSync(resolve(root, path))).map(([path, command]) =>
      installation(
        `host-journal:${path}`,
        'Host journal',
        'fail',
        `${path} exists; an ia host transaction was interrupted`,
        recoverCommand(command, root),
      ),
    ),
  ];
}

/** Whether a user-owned JSON file the host set edits still parses; a file that is absent does. */
function parses(root: string, path: string): boolean {
  try {
    decodeDistributionJson(readFileSync(resolve(root, path), 'utf8'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * `launcher-unverified` covers two different facts, told apart here by verifying once more: a payload that fails
 * verification, and one that verifies as another release than the state recorded. Only a stale row pays for it.
 */
function unverified(cache: string | null, recorded: string | null): string {
  if (cache === null) return 'the payload fails verification';
  try {
    const found = verifyHostCache(cache).release;
    return found === recorded
      ? `the payload at ${cache} did not verify when observed`
      : `the payload at ${cache} verifies, but as release ${short(found)} rather than the recorded ${short(recorded)}`;
  } catch (error) {
    return `the payload at ${cache} fails verification (${codeOf(error, 'unreadable')})`;
  }
}

/**
 * Which ownership file `state-invalid` means. `observeHosts` reports an unreadable `<host>-workspace.json` with no
 * elements at all; otherwise it is the guard's state (Claude only) or the projection's, and the elements that were
 * still read tell those apart except when the guard was read and the projection was not.
 */
function unreadableStates(observed: HostObservation): readonly string[] {
  if (observed.elements.length === 0) return [STATE.mcp(observed.host)];
  if (observed.host === 'codex' || !observed.elements.includes('hooks')) return [STATE.projection(observed.host)];
  if (observed.elements.includes('projection')) return [STATE.hooks];
  return [STATE.hooks, STATE.projection(observed.host)];
}

/**
 * The repair a stale host needs before `ia host <host> --apply` can succeed, worded as `ia host` words it
 * (`stateRepair`, `modifiedRepair`), or '' when the remedy alone converges.
 */
function repairOf(root: string, observed: HostObservation): string {
  const host = observed.host,
    apply = `ia host ${host} --apply`;
  if (observed.reasons.includes('state-invalid')) {
    const [first, second] = unreadableStates(observed);
    if (second === undefined) return stateRepair(host, first!, apply) ?? '';
    return (
      `One of ${first} and ${second} cannot be read. ` +
      `If it is the first: ${stateRepair(host, first!, apply)} If it is the second: ${stateRepair(host, second, apply)}`
    );
  }
  // A file that no longer parses is repaired by making it parse; apply then names anything left to do.
  const unparsed = [
    ...(host === 'claude' && observed.reasons.includes('mcp-modified') && !parses(root, MCP_PATH.claude)
      ? [MCP_PATH.claude]
      : []),
    ...(observed.reasons.includes('guard-modified') && !parses(root, SETTINGS) ? [SETTINGS] : []),
  ];
  if (unparsed.length > 0) return `Make ${unparsed.join(' and ')} parse as JSON, then run "${apply}".`;
  const modified = [
    ...(observed.reasons.includes('mcp-modified') ? (['mcp'] as const) : []),
    ...(observed.reasons.includes('guard-modified') ? (['hooks'] as const) : []),
  ];
  return modified.length === 0 ? '' : modifiedRepair(host, modified);
}

/** A stale host: each reason as a fact, then the repair that works first, where the remedy alone would refuse. */
function staleDetail(root: string, observed: HostObservation, pinned: Pinned): string {
  const facts = observed.reasons.map((reason): string => {
    switch (reason) {
      case 'release':
        return `registered for release ${short(observed.release)}; this installation pins ${short(pinned.release)}`;
      case 'launcher-missing':
        return `launcher ${observed.launcher} is missing`;
      case 'launcher-unverified':
        return unverified(observed.cache, observed.release);
      case 'mcp-modified':
        return `${MCP_PATH[observed.host]} does not hold the ia-workspace entry ia host writes for this registration`;
      case 'guard-modified':
        return `${SETTINGS} does not hold the IA guard group ia host writes for this registration`;
      case 'guard-form':
        return `${SETTINGS} holds the IA guard group in a form ia host no longer writes; re-applying rewrites it`;
      case 'node-missing':
        return 'the Node executable the registration runs no longer exists; the remedy records the running one';
      case 'guard-release':
        return 'the guard pins a different release from the MCP entry';
      case 'guard-launcher':
        return "the guard's launcher is missing or fails verification";
      case 'state-invalid':
        return `an ownership file under ${HOSTS_AREA} cannot be read`;
    }
  });
  const repair = repairOf(root, observed);
  return `stale (${observed.reasons.join(', ')}): ${facts.join('; ')}.${repair === '' ? '' : ` ${repair}`}`;
}

function hostRow(root: string, observed: HostObservation, pinned: Pinned, commands: Commands): Check {
  const host = observed.host;
  // Written is all doctor can know: it never starts a server, so it never says one answered (spec §7).
  if (observed.status === 'registered')
    return installation(
      `host-${host}`,
      `Host ${host}`,
      'ok',
      `registered (${observed.elements.join(', ')}); written; not observed answering; cache ${observed.cache}`,
      null,
    );
  const detail = commands.prose(host, staleDetail(root, observed, pinned));
  return installation(`host-${host}`, `Host ${host}`, 'fail', detail, commands.apply(host));
}

/**
 * Spec §7: one row per managed file that drifted. `changed` (a hand edit) and `unmanaged` (a file without the marker
 * where the projection writes) make apply refuse, so they fail and name the same repair `ia host` does; `missing`
 * and `outdated` are what the next apply rewrites; `unowned` is a marked file this workspace's state does not list.
 */
function driftRow(
  host: HostName,
  drift: ProjectionDrift,
  artifacts: readonly Artifact[] | null,
  commands: Commands,
): Check {
  const id = `projection-${host}:${drift.path}`,
    title = `Projection ${host}`,
    apply = commands.apply(host),
    unlisted = `${drift.path} unowned: marked but not listed in this workspace's projection state`;
  switch (drift.drift) {
    case 'changed':
      return installation(
        id,
        title,
        'fail',
        `${drift.path} changed since ia host wrote it; move or delete it, then run the remedy`,
        apply,
      );
    case 'unmanaged':
      return installation(
        id,
        title,
        'fail',
        `${drift.path} unmanaged: it lacks the ia host marker where the projection writes; move or delete it, then run the remedy`,
        apply,
      );
    case 'missing':
      return installation(id, title, 'warn', `${drift.path} missing; the remedy writes it again`, apply);
    case 'outdated':
      return installation(
        id,
        title,
        'warn',
        `${drift.path} outdated: the current records render it differently`,
        apply,
      );
    case 'unowned':
      // A marked file the projection would write is adopted by the next apply; any other one ia host never touches.
      if (artifacts === null) return installation(id, title, 'warn', unlisted, null);
      return artifacts.some((artifact) => artifact.path === drift.path)
        ? installation(id, title, 'warn', `${unlisted}; the remedy adopts it`, apply)
        : installation(
            id,
            title,
            'warn',
            `${unlisted}; ia host leaves it untouched, so delete it if nothing uses it`,
            null,
          );
  }
}

/** The projection rows for one host that owns a projection. Never throws: a failure to observe is itself a row. */
function projectionRows(root: string, host: HostName, commands: Commands): readonly Check[] {
  const title = `Projection ${host}`,
    checks: Check[] = [];
  let artifacts: readonly Artifact[] | null = null;
  try {
    artifacts = renderProjectionFor(root, host);
  } catch (error) {
    // Without a rendering, hand edits and missing files are still observed; only `outdated` cannot be.
    const why = codeOf(error, 'the projection could not be rendered');
    const detail = `Not compared with the current records; ${why}`;
    checks.push(installation(`projection-${host}-render`, title, 'unknown', detail, 'ia validate'));
  }
  try {
    for (const drift of observeProjection({ root, host, artifacts, marker: WORKSPACE_PROJECTION_MARKER }))
      checks.push(driftRow(host, drift, artifacts, commands));
  } catch (error) {
    // The mechanism locates the failure at the file it could not read: the ownership state, or a managed file.
    const state = STATE.projection(host),
      path = refusedPath(error) ?? state,
      repair = projectionRepair(host, path, `ia host ${host} --apply`);
    const detail = commands.prose(host, `${path} cannot be read (${codeOf(error, 'an unexpected error')}). ${repair}`);
    checks.push(
      installation(
        path === state ? `projection-${host}` : `projection-${host}:${path}`,
        title,
        'fail',
        detail,
        commands.apply(host),
      ),
    );
  }
  return checks;
}

/** Spec §7's rows for a workspace whose installed state could be read. */
function hostRows(
  root: string,
  observed: readonly HostObservation[],
  pinned: Pinned,
  commands: Commands,
): readonly Check[] {
  if (observed.length === 0) {
    const none = 'No host registered; run "ia host claude" or "ia host codex" to plan one';
    return [installation('host', 'Host', 'info', commands.prose('codex', commands.prose('claude', none)), null)];
  }
  return observed.flatMap((host) => [
    hostRow(root, host, pinned, commands),
    ...(host.elements.includes('projection') ? projectionRows(root, host.host, commands) : []),
  ]);
}

/**
 * Host plugin distribution spec §3 and §7.3 `ia-home` warn: a registration made before the IA home moved still pins
 * its payload where it was materialized, usually M5.3's per-OS data directory. It keeps working, so the row warns;
 * re-applying materializes the payload in the current home and re-pins it. No command moves or deletes the old one.
 */
function movedRows(request: DoctorRequest, observed: readonly HostObservation[], commands: Commands): readonly Check[] {
  const user = request.home ?? homedir();
  let home: string;
  try {
    home = resolveIaHome(request.env, user).home;
  } catch {
    return []; // The ia-home row already fails with the reason.
  }
  const legacy = legacyHostHome(request.env, process.platform, user);
  return observed.flatMap((host) =>
    host.cache === null || inside(home, host.cache)
      ? []
      : [
          installation(
            `ia-home-moved-${host.host}`,
            'IA home moved',
            'warn',
            `Host ${host.host} pins its payload under ${host.cache}, outside the IA home ${home}${inside(legacy, host.cache) ? ' (the M5.3 per-OS location)' : ''}`,
            commands.apply(host.host),
          ),
        ],
  );
}

// ---- Registry rows: registry spec §4 ---------------------------------------------------------------------------

/**
 * One row per provider the lock names, in provider order. One chooser serves the report, as for any command that
 * chooses for several ids (`registryChooser`), so a configuration file that reads cleanly is read once; a refusal is
 * not cached, so a file that refuses does so again for each provider. A refusal is a warning, not a failure: the
 * installed generation is intact, and only the next install, update or restore that routes through registries
 * refuses. An unmapped provider's remedy is the one `ia install` names, so the two verbs cannot disagree; any other
 * refusal keeps the service's code and message in its detail.
 */
function registryRows(request: DoctorRequest, root: string, lock: DistributionLock): readonly Check[] {
  const choose = registryChooser({ root, env: request.env, cwd: request.cwd, home: request.home ?? homedir() });
  // The first id of each provider stands for it; a refusal names that id.
  const providers = new Map<string, string>();
  for (const id of [
    ...lock.requests.map((dependency) => dependency.id),
    ...lock.packages.map((locked) => locked.id),
  ].sort()) {
    const provider = id.split('/')[0]!;
    if (!providers.has(provider)) providers.set(provider, id);
  }
  return [...providers]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([provider, id]) => {
      try {
        const choice = choose(id);
        const detail = `${registryLocation(choice.base)} (from ${choice.level}: ${choice.source})`;
        return installation(`registry-${provider}`, `Registry ${provider}`, 'info', detail, null);
      } catch (error) {
        const code = codeOf(error, 'IA-CLI-FAILED'),
          message = error instanceof Error ? error.message : String(error);
        // A Node error's message already starts with its code ("EACCES: permission denied, open …").
        const detail = message.startsWith(`${code}: `) ? message : `${code}: ${message}`;
        return installation(
          `registry-${provider}`,
          `Registry ${provider}`,
          'warn',
          detail,
          code === 'IA-DIST-REGISTRY-UNMAPPED' ? UNMAPPED : null,
        );
      }
    });
}

/**
 * The workspace's portable lock, whose requests and packages name the providers. It is read on its own rather than taken
 * from the installed generation, which a fresh clone does not have yet and which cannot be read when the activation
 * pointer is missing or unusable or the lock drifted from it. An absent lock names no provider. A lock that cannot be
 * read names none either and adds no row, as before. The generation row is then `unknown`, but its detail carries only
 * the code of the installed-state read, so nothing in the report names the lock.
 */
function portableLock(root: string): DistributionLock | undefined {
  try {
    return readWorkspaceLock({ root });
  } catch {
    return undefined;
  }
}

export function collectDoctor(request: DoctorRequest): DoctorView {
  const checks: Check[] = [...environment(request)];
  const supplied =
    request.root === undefined
      ? undefined
      : isAbsolute(request.root)
        ? resolve(request.root)
        : resolve(request.cwd, request.root);
  // A supplied or discovered root opens at its real path, as the workspace verbs open it (`requireRoot`).
  const found = supplied ?? discoverRoot(request.cwd, iaHomeOf(request.env, request.home));
  const root = found !== undefined && directory(found) ? realpathSync(found) : found;
  const usable = root !== undefined && directory(root);
  checks.push({
    id: 'root',
    section: 'Workspace',
    title: 'Root',
    status: usable ? 'ok' : 'warn',
    detail: usable
      ? root
      : supplied === undefined
        ? 'No .ia/src directory here or in any parent'
        : `${supplied} is not an existing directory`,
    remedy: usable ? null : 'ia init',
  });
  const pending = usable && existsSync(resolve(root, INSTALL_PATHS.pending));
  const pinned = pinnedRelease(request.packageRoot);
  // The observed hosts, or the code that kept the installed state from being read; undefined until it is read.
  let observed: readonly HostObservation[] | string | undefined;
  const unchecked = (id: string, section: Section, title: string, why: string): Check => ({
    id,
    section,
    title,
    status: 'unknown',
    detail: `Not checked; ${why}`,
    remedy: null,
  });
  if (!usable) checks.push(unchecked('records', 'Workspace', 'Records', 'no workspace'));
  else if (pending)
    checks.push(unchecked('records', 'Workspace', 'Records', 'installation recovery is required first'));
  else {
    try {
      const admission = validateWorkspace({ root });
      const errors = admission.findings.filter((finding) => finding.severity === 'error').length;
      const warnings = admission.findings.filter((finding) => finding.severity === 'warning').length;
      checks.push({
        id: 'records',
        section: 'Workspace',
        title: 'Records',
        status: errors === 0 ? 'ok' : 'fail',
        detail: `${admission.records} records, ${errors} errors, ${warnings} warnings at revision ${admission.revision.slice(0, 12)}`,
        remedy: errors === 0 ? null : 'ia validate',
      });
    } catch (error) {
      checks.push({
        id: 'records',
        section: 'Workspace',
        title: 'Records',
        status: 'unknown',
        detail: `Not checked; ${codeOf(error, 'the workspace could not be read')}`,
        remedy: null,
      });
    }
  }

  if (!usable) {
    for (const [id, title] of [
      ['generation', 'Generation'],
      ['pending', 'Pending state'],
      ['install-lock', 'Install lock'],
      ['cache', 'Cache'],
    ] as const)
      checks.push(unchecked(id, 'Installation', title, 'no workspace'));
  } else {
    if (pending)
      checks.push(unchecked('generation', 'Installation', 'Generation', 'installation recovery is required first'));
    else {
      try {
        // Spec §7: hosts are observed against this installation's pin; without one, the release comparison is skipped.
        const installed = readInstalledState({ root, hosts: true, hostRelease: pinned.release });
        observed = installed.hosts ?? [];
        checks.push({
          id: 'generation',
          section: 'Installation',
          title: 'Generation',
          status: 'info',
          detail:
            installed.pointer === undefined
              ? 'None installed'
              : `${installed.pointer.generation.slice(0, 12)}, counter ${installed.pointer.counter}`,
          remedy: null,
        });
      } catch (error) {
        observed = codeOf(error, 'the installed state could not be read');
        checks.push({
          id: 'generation',
          section: 'Installation',
          title: 'Generation',
          status: 'unknown',
          detail: `Not checked; ${observed}`,
          remedy: `ia-distribution recover --root ${root}`,
        });
      }
      // Registry spec §4: after the generation row, the registry each provider in the workspace's lock routes to. An
      // interrupted apply has none yet, because its recovery may put the previous lock back.
      const lock = portableLock(root);
      if (lock !== undefined) checks.push(...registryRows(request, root, lock));
    }
    checks.push({
      id: 'pending',
      section: 'Installation',
      title: 'Pending state',
      status: pending ? 'fail' : 'ok',
      detail: pending ? `${INSTALL_PATHS.pending} exists; an apply was interrupted` : 'No interrupted transaction',
      remedy: pending ? `ia-distribution recover --root ${root}` : null,
    });
    const held = existsSync(resolve(root, INSTALL_LOCK));
    checks.push({
      id: 'install-lock',
      section: 'Installation',
      title: 'Install lock',
      status: held ? 'warn' : 'info',
      detail: held ? `${INSTALL_LOCK} is held by another installer or was left behind` : 'Not held',
      remedy: held ? `ia-distribution recover --root ${root}` : null,
    });
    const cache = resolve(root, CACHE);
    const archives = directory(cache) ? readdirSync(cache).filter((name) => ARCHIVE.test(name)).length : 0;
    checks.push({
      id: 'cache',
      section: 'Installation',
      title: 'Cache',
      status: 'info',
      detail: `${archives} ${archives === 1 ? 'archive' : 'archives'} in ${CACHE}`,
      remedy: null,
    });
  }
  // Spec §7. Host state is relative to a workspace and is read with the installed state, so it waits on both.
  if (!usable) checks.push(unchecked('host', 'Installation', 'Host', 'no workspace'));
  else if (pending) checks.push(unchecked('host', 'Installation', 'Host', 'installation recovery is required first'));
  else if (observed === undefined || typeof observed === 'string')
    checks.push(unchecked('host', 'Installation', 'Host', observed ?? 'the installed state was not read'));
  else
    checks.push(
      payloadRow(request, pinned),
      ...hostTransactionRows(root),
      ...hostRows(root, observed, pinned, commandsFor(supplied)),
      ...movedRows(request, observed, commandsFor(supplied)),
    );

  // Host plugin distribution spec §7.3 and §8.2: rows that exist with or without a workspace, and the briefing. One
  // report has one root. Without --root it was discovered upward from the cwd, which is how the §8.1 hook runs doctor.
  // A supplied --root is literal, as for every other verb: it is a workspace only when it holds .ia/src itself. When it
  // does not but lies inside a workspace, that workspace is only named (`enclosing`), never described or offered init.
  const workspaceRoot =
    supplied === undefined
      ? usable
        ? root
        : undefined
      : directory(resolve(supplied, '.ia/src'))
        ? supplied
        : undefined;
  const enclosing =
    supplied !== undefined && workspaceRoot === undefined && directory(supplied)
      ? discoverRoot(supplied, iaHomeOf(request.env, request.home))
      : undefined;
  const version = request.version ?? '0.0.0';
  const user = userRows({
    env: request.env,
    home: request.home ?? homedir(),
    packageRoot: request.packageRoot,
    version,
    directory: supplied ?? request.cwd,
    supplied,
    root: workspaceRoot,
    enclosing,
    now: request.now ?? new Date(),
    channel: request.channel,
  });
  checks.push(...user.checks);
  const briefing =
    request.host === undefined
      ? undefined
      : briefingFor(
          request.host,
          checks,
          user,
          { root: workspaceRoot, supplied, enclosing: enclosing ?? null },
          version,
        );
  return { checks, counts: count(checks), ...(briefing === undefined ? {} : { briefing }) };
}

/**
 * §8.2's host state from the rows already collected. `unknown` when the host set was not observed — an interrupted
 * installation, or installed state that could not be read — so the briefing never calls a host missing that doctor did
 * not look at. Stale covers the host row itself, a payload pinned outside the IA home (§3 names re-applying as its
 * remedy) and any failing projection row, which `ia host <host> --apply` also repairs.
 */
function hostState(
  host: string,
  checks: readonly Check[],
): { readonly status: BriefInput['hostStatus']; readonly detail: string | null; readonly recovery: string | null } {
  const pending = checks.find((check) => check.id === 'pending');
  const unobserved = checks.find((check) => check.id === 'host' && check.status === 'unknown');
  if (unobserved !== undefined || pending?.status === 'fail')
    return {
      status: 'unknown',
      detail: unobserved === undefined ? null : unobserved.detail.replace(/^Not checked; /, ''),
      recovery: pending?.status === 'fail' ? pending.remedy : null,
    };
  const hostCheck = checks.find((check) => check.id === `host-${host}`);
  const failing = checks.filter(
    (check) =>
      (check.id === `host-${host}` && check.status !== 'ok') ||
      check.id === `ia-home-moved-${host}` ||
      (check.id.startsWith(`projection-${host}`) && check.status === 'fail'),
  );
  if (failing.length > 0)
    return { status: 'stale', detail: failing.map((check) => check.detail).join('; '), recovery: null };
  return { status: hostCheck === undefined ? 'absent' : 'registered', detail: null, recovery: null };
}

/** §8.2's input from the rows already collected: nothing is observed twice. */
function briefingFor(
  host: string,
  checks: readonly Check[],
  user: ReturnType<typeof userRows>,
  where: Pick<BriefInput, 'root' | 'supplied' | 'enclosing'>,
  version: string,
): ReturnType<typeof brief> {
  const state = hostState(host, checks);
  return brief({
    host,
    version,
    channel: user.facts.channel,
    plugin: user.facts.plugin,
    ...where,
    frameworkSource: user.facts.frameworkSource,
    decision: user.facts.decision,
    records: checks.find((check) => check.id === 'records' && check.status !== 'unknown')?.detail ?? null,
    hostStatus: state.status,
    hostDetail: state.detail,
    recovery: state.recovery,
    // §11.1 and Amendment item 4: the cached check and the refresh argv, both read without writing anything.
    updates: user.facts.updates,
    refresh: user.facts.refresh,
  });
}

/** §2.12: 0 when no check failed. `unknown` and `info` never decide the class; only `fail` does. */
export const doctorExit = (view: DoctorView): 0 | 1 => (view.counts.fail === 0 ? 0 : 1);

export function doctorEnvelope(view: DoctorView): unknown {
  return {
    version: 1,
    checks: view.checks.map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      detail: check.detail,
      remedy: check.remedy,
    })),
    counts: view.counts,
    ...(view.briefing === undefined ? {} : { session: view.briefing.session, nextActions: view.briefing.nextActions }),
  };
}

const SYMBOLS: Readonly<Record<CheckStatus, SymbolName>> = {
  ok: 'success',
  warn: 'warning',
  fail: 'error',
  unknown: 'unknown',
  info: 'info',
};
const plural = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`;

export function renderDoctor(view: DoctorView, caps: Capabilities): string {
  const sections: readonly Section[] = ['Environment', 'Workspace', 'Installation'];
  const blocks = sections.map((section) => {
    const rows: readonly Field[] = view.checks
      .filter((check) => check.section === section)
      .map((check) => ({
        symbol: SYMBOLS[check.status],
        label: check.title,
        value: words(check.detail),
        // A remedy is a command, so it is one unbreakable token run and is never wrapped into an unrunnable line.
        ...(check.remedy === null ? {} : { action: [atom(check.remedy, 'cyan', 0)] }),
      }));
    return [sectionLabel(section, caps), ...fieldRows(rows, { depth: 1 }, caps)];
  });
  const counts = view.counts;
  const totals = `${counts.ok} ok, ${plural(counts.warn, 'warning', 'warnings')}, ${counts.unknown} not checked, ${plural(counts.info, 'note', 'notes')}, ${counts.fail} failed.`;
  return document([...blocks, entry([words(totals, 'dim')], { depth: 0 }, caps)], { leadingBlank: true });
}

export function runDoctor(context: Context): Result {
  const { host, args, caps, json } = context;
  const view = collectDoctor({
    cwd: host.cwd,
    root: args.value('root'),
    packageRoot: host.packageRoot,
    runtime: { version: process.version, platform: process.platform, arch: process.arch },
    env: host.env,
    home: homedir(),
    version: host.version,
    host: args.value('host'),
  });
  const exitCode = doctorExit(view);
  return json
    ? { exitCode, stdout: JSON.stringify(doctorEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderDoctor(view, caps), stderr: '' };
}

/**
 * `within`, except that a path doctor cannot examine (a link loop, no permission) is compared by spelling, so a diagnosis
 * never fails on its subject.
 */
function inside(parent: string, child: string): boolean {
  try {
    return within(parent, child);
  } catch {
    const path = relative(pathKey(resolve(parent)), pathKey(resolve(child)));
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
  }
}
