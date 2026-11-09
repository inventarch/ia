import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathKey } from '@inventarch/db';
import { checkInstalledImplementations, decodeDistributionJson } from '@inventarch/db/distribution';
import type {
  AvailableOperation,
  InstalledImplementationsValue,
  InstalledOperation,
  UnavailableOperation,
} from '@inventarch/db/distribution';
import { acquireHostRegistrationLock, assertHostRegistrationIdle, HOST_REGISTRATION, saved } from './host.js';
import { hostPayloadPath } from './host-home.js';
import { verifierOf } from './host-observe.js';
import type { HostVerifier } from './host-observe.js';
import type { WorkspaceHost } from './hosts.js';
import { asWorkspaceHost } from './hosts.js';
import {
  bytes,
  contained,
  fail,
  json,
  locate,
  object,
  replace,
  sha256,
  stamped,
  utf8,
  versionedObject,
  workspace,
} from './files.js';

/**
 * The installed-implementation catalog a v2 host payload carries at its root. The payload builder
 * (tools/distribution/host-payload.mjs) generates it and lists it in the payload inventory, because `verifyHostCache`
 * refuses any file the inventory does not list. It describes implementations no host app may import, so this module
 * reads data only: it never imports, loads or runs a handler. Its value's shape, operation rows included, is
 * `@inventarch/db/distribution`'s (`checkInstalledImplementations`), which binders read too.
 *
 * Nothing is read from a payload that fails `verifyHostCache`: every file under the payload directory must be one the
 * inventory lists, with its bytes, and no entry may be a link or junction, so a module planted inside the payload
 * directory, beside or above the handler's packages, refuses the whole catalog. Only the payload directory is verified,
 * and the closure check follows literal import specifiers only. An unlisted empty directory is not refused: it holds no
 * module, though one where Node's resolution expects a file can keep a handler from loading, which denies service but
 * never substitutes code. An operation is then `available` only when the payload ships its handler: the handler module
 * and the manifest of every package its closure names are in the verified inventory, and the catalog's handler digest
 * is the SHA-256 the inventory pins for the module. What binds is that module digest together with the verified
 * inventory, which pins every other byte of the closure. A declaration whose bytes are not shipped is `unavailable`,
 * never available; a payload that fails verification, or a handler digest that disagrees with its inventory, is a
 * refusal.
 */
export const INSTALLED_IMPLEMENTATIONS = 'implementations.json';
export { INSTALLED_IMPLEMENTATIONS_FORMAT } from '@inventarch/db/distribution';
export type {
  AvailableOperation,
  InstalledImplementationsValue,
  InstalledOperation,
  RevokedOperation,
  UnavailableOperation,
} from '@inventarch/db/distribution';
/** The implementation id a consumer's join names for the catalog itself. */
export const INSTALLED_IMPLEMENTATIONS_ID = 'installed-implementations';
/** The join receipts each consumer records under its own name, beside the host state files. */
export const JOINS = '.ia/distributions/hosts/joins.json';
export const JOINS_FORMAT = 'host-joins';
export const JOINS_FORMAT_VERSION = 1;
/** The literal join files carried before `formatVersion` existed; still read, never written. */
const LEGACY_JOINS_FORMATS: readonly string[] = ['ia.host-joins.v1'];

/** The catalog as `readInstalledImplementations` verified it in one materialized payload. */
export interface InstalledImplementations extends InstalledImplementationsValue {
  readonly status: 'present';
  /** The payload release whose inventory lists the catalog. */
  readonly release: string;
  /** The payload's version (its inventory's `version`). */
  readonly version: string;
  /** The SHA-256 of the catalog's bytes, as the inventory lists it. */
  readonly digest: string;
}
/** A payload that carries no catalog, such as one built before the catalog existed: unavailable, not damaged. */
export interface InstalledImplementationsUnavailable {
  readonly status: 'unavailable';
  readonly release: string;
  readonly reason: string;
}
export type InstalledCatalog = InstalledImplementations | InstalledImplementationsUnavailable;
/**
 * One consumer's join: the catalog it joined (implementation id, payload version, catalog digest and payload release)
 * at its own revision. A workspace host's consumer revision is the workspace's authored revision when it joined.
 */
export interface ImplementationJoin {
  readonly consumer: WorkspaceHost;
  readonly implementation: string;
  readonly version: string;
  readonly digest: string;
  readonly release: string;
  readonly consumerRevision: string;
}
export type JoinResult =
  | { readonly status: 'joined'; readonly join: ImplementationJoin }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'unregistered' };

const ROWS = 1024;
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  HEX = /^[a-f0-9]{64}$/;
const JOIN_KEYS = ['consumer', 'implementation', 'version', 'digest', 'release', 'consumerRevision'] as const;
const prose = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
const text = (value: Buffer | null): string | null => (value === null ? null : utf8(value));
/** The payload directory of an installed package, with its trailing slash. */
const packageDirectory = (name: string): string => `runtime/node_modules/${name}/`;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The value of a catalog, as `@inventarch/db/distribution`'s `checkInstalledImplementations` admits one; any other is
 * IA-DIST-INPUT-INVALID with its reason. The payload builder checks what it writes with it too.
 */
export function installedImplementationsValue(value: unknown): InstalledImplementationsValue {
  const checked = checkInstalledImplementations(value);
  if (!checked.ok) fail('INPUT-INVALID', checked.reason);
  return checked.value;
}

interface Listed {
  readonly bytes: number;
  readonly sha256: string;
}
/**
 * `operation` as this payload ships it, against the inventory of a payload `verifyHostCache` has verified, so
 * every listed file is present with the bytes the inventory pins and nothing else is there. A handler module or closure
 * package the inventory does not list makes the operation unavailable; a handler digest that disagrees with the
 * inventory is IA-DIST-INTEGRITY-MISMATCH.
 */
function shipped(operation: AvailableOperation, inventory: ReadonlyMap<string, Listed>): InstalledOperation {
  const unavailable = (reason: string): UnavailableOperation => ({ id: operation.id, status: 'unavailable', reason });
  const module = inventory.get(operation.module);
  if (module === undefined)
    return unavailable(`its handler module ${operation.module} is not in this payload's inventory`);
  if (module.sha256 !== operation.digest)
    fail('INTEGRITY-MISMATCH', `The catalog's handler digest for ${operation.id} differs from the payload inventory`);
  const missing = operation.packages.find((name) => !inventory.has(packageDirectory(name) + 'package.json'));
  if (missing !== undefined) return unavailable(`its closure package ${missing} is not in this payload`);
  return operation;
}

/**
 * The catalog of the materialized host payload at `directory`. The whole payload is verified first, as `verifyHostCache`
 * verifies it before a registration may launch it, and must verify as `release`: a file anywhere in the payload directory
 * that the inventory does not list, a link or junction, a missing file or changed bytes refuse, with that verification's
 * code (release.json hashing to `release`, inventory.json to the digest release.json names, every listed file to its
 * pin). A release.json that does not hash to `release` refuses as IA-DIST-INTEGRITY-MISMATCH before it is parsed. `given`
 * shares the verification of one report when `hostVerifier` made it; any other value is ignored and the payload is
 * verified afresh. The catalog is the file that verified inventory lists, read again and compared with its pin. Each
 * available operation is checked against the verified inventory (`shipped`). A v1 payload, or a v2 payload whose
 * inventory lists no catalog (one built before the catalog existed), is `unavailable`, not an integrity failure. A
 * missing payload file or release.json is IA-DIST-ARTIFACT-UNAVAILABLE; unexpected or changed bytes are
 * IA-DIST-INTEGRITY-MISMATCH; a link is IA-DIST-PATH-UNSAFE; malformed metadata is IA-DIST-INPUT-INVALID. Nothing is
 * written, imported or executed.
 */
export function readInstalledImplementations(
  directory: string,
  release: string,
  given?: HostVerifier,
): InstalledCatalog {
  // Only a verifier `hostVerifier` made is shared; anything else is replaced by a fresh one.
  const verify = verifierOf(given);
  if (!HEX.test(release)) fail('INPUT-INVALID', 'Invalid host release pin');
  // A release.json that does not hash to the pin is changed bytes, whether or not it still parses.
  const root = workspace(directory),
    pinned = bytes(root, 'release.json');
  if (pinned !== null && sha256(pinned) !== release) fail('INTEGRITY-MISMATCH', 'Host release differs from its pin');
  // Never read a catalog from a payload that fails verification; an uninventoried module could be loaded in place of a
  // shipped one, inside a closure package or outside every one.
  const verified = verify(root);
  if (verified.release !== release) fail('INTEGRITY-MISMATCH', 'Host release differs from its pin');
  if (verified.format === 1)
    return { status: 'unavailable', release, reason: 'a v1 host payload carries no installed-implementation catalog' };
  const catalog = verified.files.get(INSTALLED_IMPLEMENTATIONS);
  if (catalog === undefined)
    return {
      status: 'unavailable',
      release,
      reason:
        'this host payload carries no installed-implementation catalog; payloads built before the catalog existed carry none',
    };
  // Read again through the inventory's pin, so the bytes parsed are the bytes verification hashed.
  const content = bytes(verified.directory, INSTALLED_IMPLEMENTATIONS);
  if (content === null || content.length !== catalog.bytes || sha256(content) !== catalog.sha256)
    fail('INTEGRITY-MISMATCH', 'Installed-implementation catalog is missing or changed');
  const value = installedImplementationsValue(decodeDistributionJson(utf8(content)));
  return {
    status: 'present',
    format: value.format,
    evaluators: value.evaluators,
    operations: value.operations.map((operation) =>
      operation.status === 'available' ? shipped(operation, verified.files) : operation,
    ),
    release,
    version: verified.version,
    digest: catalog.sha256,
  };
}

function joinRow(value: unknown): ImplementationJoin {
  const row = object(value, JOIN_KEYS);
  asWorkspaceHost(row['consumer']);
  if (
    typeof row['implementation'] !== 'string' ||
    !TOKEN.test(row['implementation']) ||
    row['implementation'].length > 128 ||
    !prose(row['version'], 128)
  )
    fail('INPUT-INVALID', 'Invalid join receipt');
  for (const key of ['digest', 'release', 'consumerRevision'] as const)
    if (typeof row[key] !== 'string' || !HEX.test(row[key])) fail('INPUT-INVALID', 'Invalid join receipt digest');
  return row as unknown as ImplementationJoin;
}
/** The joins recorded at `root`, one per consumer, or null when none was ever recorded. Refusals locate at `JOINS`. */
export function readJoins(rootInput: string): readonly ImplementationJoin[] | null {
  const root = workspace(rootInput);
  return locate(JOINS, () => {
    const content = text(bytes(root, JOINS));
    if (content === null) return null;
    const { row } = versionedObject(
      decodeDistributionJson(content),
      { format: JOINS_FORMAT, version: JOINS_FORMAT_VERSION, legacy: LEGACY_JOINS_FORMATS },
      ['joins'],
    );
    if (!Array.isArray(row['joins']) || row['joins'].length > ROWS) fail('INPUT-INVALID', 'Invalid join receipts');
    const joins = row['joins'].map(joinRow);
    if (new Set(joins.map((join) => join.consumer)).size !== joins.length)
      fail('INPUT-INVALID', 'Join receipts repeat a consumer');
    return joins;
  });
}
/** Replace `consumer`'s row with `row` (or drop it for null), keeping every other consumer's; with none left, delete. */
function writeJoin(root: string, consumer: WorkspaceHost, row: ImplementationJoin | null): void {
  const current = readJoins(root);
  const others = (current ?? []).filter((join) => join.consumer !== consumer);
  const joins = [...others, ...(row === null ? [] : [row])].sort((a, b) => byText(a.consumer, b.consumer));
  if (current === null && joins.length === 0) return;
  if (current !== null && json(joins) === json(current)) return;
  replace(
    root,
    JOINS,
    joins.length === 0
      ? null
      : Buffer.from(json({ ...stamped(JOINS_FORMAT, LEGACY_JOINS_FORMATS[0]!, JOINS_FORMAT_VERSION), joins })),
  );
}
/**
 * Run `work` under the host lock, as every host write runs. The lock is taken first and a pending host journal is
 * checked under it, as `applyHost` does, so no journal can appear between the check and the write.
 */
function locked<T>(root: string, work: () => T): T {
  const unlock = acquireHostRegistrationLock(root);
  try {
    assertHostRegistrationIdle(root);
    return work();
  } finally {
    unlock();
  }
}

/**
 * Record `host`'s join from its committed registration, under the host lock: the catalog of the payload
 * that `<host>-workspace.json` names, read and checked by `readInstalledImplementations` at that state's own cache and
 * release, at `consumerRevision`. The row is derived from the registration as written, never from what a caller
 * expected to register, so it cannot name a catalog the registration does not use. With no registration, or a payload
 * that carries no catalog, the host's row is dropped instead, so a stale join never outlives what it described; every
 * other consumer's row is kept. Receipts that cannot be read refuse, located at `JOINS`, rather than be replaced.
 */
export function joinHost(rootInput: string, hostInput: string, consumerRevision: string): JoinResult {
  const root = workspace(rootInput),
    host = asWorkspaceHost(hostInput);
  if (!HEX.test(consumerRevision)) fail('INPUT-INVALID', 'Invalid consumer revision');
  return locked(root, () => {
    const path = `.ia/distributions/hosts/${host}-${HOST_REGISTRATION}.json`;
    const state = locate(path, () => {
      const content = bytes(root, path);
      return saved(content === null ? null : utf8(content), host, HOST_REGISTRATION);
    });
    if (state === null) {
      writeJoin(root, host, null);
      return { status: 'unregistered' };
    }
    const catalog = readInstalledImplementations(state.cache, state.release);
    if (catalog.status === 'unavailable') {
      writeJoin(root, host, null);
      return { status: 'unavailable', reason: catalog.reason };
    }
    const join = joinRow({
      consumer: host,
      implementation: INSTALLED_IMPLEMENTATIONS_ID,
      version: catalog.version,
      digest: catalog.digest,
      release: catalog.release,
      consumerRevision,
    });
    writeJoin(root, host, join);
    return { status: 'joined', join };
  });
}
/** Drop `host`'s join under the host lock, keeping every other consumer's; true when a row was removed. */
export function leaveHost(rootInput: string, hostInput: string): boolean {
  const root = workspace(rootInput),
    host = asWorkspaceHost(hostInput);
  if (!existsSync(contained(root, JOINS))) return false;
  return locked(root, () => {
    const present = (readJoins(root) ?? []).some((join) => join.consumer === host);
    if (present) writeJoin(root, host, null);
    return present;
  });
}

/**
 * Where a workspace's execution bindings find their catalog: the catalog one of its hosts joined, or why there is none.
 */
export type JoinedCatalog =
  | {
      readonly status: 'joined';
      readonly consumer: WorkspaceHost;
      readonly release: string;
      readonly version: string;
      readonly digest: string;
      readonly catalog: InstalledImplementations;
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'damaged';
      readonly consumer: WorkspaceHost;
      readonly release: string;
      /** The payload directory that failed verification, `<home>/hosts/<release>`: deleting it is the repair. */
      readonly payload: string;
      readonly reason: string;
    };
const failure = (error: unknown): { readonly code: string; readonly text: string } => {
  const code =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unreadable',
    message = error instanceof Error ? error.message : String(error);
  // A message that already opens with its code is not prefixed again.
  return { code, text: message.startsWith(code) ? message : `${code}: ${message}` };
};
/**
 * What a validating installation trusts: the IA home it materializes payloads in and the payload release it pins. A
 * join binds only through a registration of exactly that payload, `<home>/hosts/<release>`; nothing a
 * workspace names outside it is ever opened. Null when the running installation pins no payload, and then nothing binds.
 */
export interface HostTrust {
  readonly home: string;
  readonly release: string;
}
/**
 * The trust of this distribution module's own installation: when it runs from inside a materialized host payload, as the
 * payload's launcher runs `ia-distribution` (and `ia` itself, whose payload copy carries no bundled pin), the release
 * that payload's directory is named for and the IA home holding it. Run from a package install or a checkout, it pins no
 * payload: null. Nothing is verified here; `joinedCatalog` verifies the payload, release.json against this name first,
 * before it reads a catalog from it.
 */
export function installationTrust(): HostTrust | null {
  // <home>/hosts/<release>/runtime/node_modules/@inventarch/distribution/dist/implementations.js
  const payload = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
    release = basename(payload);
  return HEX.test(release) && basename(dirname(payload)) === 'hosts' && existsSync(resolve(payload, 'release.json'))
    ? { home: dirname(dirname(payload)), release }
    : null;
}
/**
 * Verification refusals that mean the payload holds other bytes, entries or paths than its pins vouch for: changed or
 * unlisted files, a link or junction, or more entries than a payload may hold. A missing file or payload is not damage.
 */
const DAMAGE = new Set(['IA-DIST-INTEGRITY-MISMATCH', 'IA-DIST-PATH-UNSAFE', 'IA-DIST-LIMIT-EXCEEDED']);

/**
 * The catalog the workspace at `root` joined, as `trust` (the validating installation's IA home and pinned release)
 * allows it. Only one payload is ever opened: `<home>/hosts/<release>`, the one this installation materializes; a join
 * counts only when its consumer's registration (`<host>-workspace.json`) and the join itself name that release and the
 * registration names that payload directory. A registration of another release, or of a payload anywhere else (another
 * IA home, a directory inside the workspace, a network path), is not trusted and never opened: re-applying
 * `ia host <host>` registers the installation's own payload. The payload is then read once, verified as
 * `readInstalledImplementations` verifies it, and the first trusted join, in consumer order, whose catalog digest it
 * carries is the source. A payload that fails verification with changed or unlisted files, a link or exceeded limits is
 * `damaged`, which binders report as revoked, whichever trusted join names it (every trusted join names the same
 * payload, so the order of joins cannot decide it). With no trust, no receipt, or no trusted join that
 * holds (an `ia project`-only workspace, a host registered by another release, a drifted join, a payload without a
 * catalog or not materialized), the catalog is `unavailable`, with the reasons, so nothing binds. Reads only: nothing is
 * written, imported or executed.
 */
/** The one payload a trust opens, `<home>/hosts/<release>`, whether it is materialized, and its spellings. */
export interface TrustedPayload {
  readonly release: string;
  readonly home: string;
  readonly payload: string;
  readonly materialized: boolean;
  readonly spellings: ReadonlySet<string>;
}
/**
 * The payload `trust` opens. `ia host` records a payload as verification resolved it, so its real path is one more
 * spelling of the same entry; nothing a workspace names is ever opened to find out.
 */
export function trustedPayload(trust: HostTrust): TrustedPayload {
  const payload = hostPayloadPath(trust.home, trust.release),
    materialized = existsSync(payload),
    spellings = new Set([pathKey(resolve(payload))]);
  if (materialized)
    try {
      spellings.add(pathKey(realpathSync(payload)));
    } catch {
      // The reader refuses it with its own code.
    }
  return { release: trust.release, home: trust.home, payload, materialized, spellings };
}
/**
 * Why host `host`'s registration (`state`) and its join (at `joined`, or null for no join) do not bind through
 * `trusted`, or null when they do: registered or joined for another release, the payload not materialized, or a
 * registration naming another directory or another spelling of it. Compares spellings only:
 * the registration's own path is never opened.
 */
export function registrationUntrusted(
  trusted: TrustedPayload,
  host: string,
  state: { readonly cache: string; readonly release: string },
  joined: string | null,
): string | null {
  if (state.release !== trusted.release || (joined !== null && joined !== trusted.release))
    return `host ${host} is registered for release ${state.release.slice(0, 12)}, not this installation's ${trusted.release.slice(0, 12)}`;
  if (!trusted.materialized)
    return `this installation's payload for host ${host} is not materialized in ${trusted.home}`;
  if (!trusted.spellings.has(pathKey(resolve(state.cache))))
    return `host ${host}'s registration names a payload other than ${trusted.payload} (another directory or another spelling of it)`;
  return null;
}
export function joinedCatalog(rootInput: string, trust: HostTrust | null): JoinedCatalog {
  const root = workspace(rootInput);
  if (trust !== null && (!HEX.test(trust.release) || !isAbsolute(trust.home)))
    fail('INPUT-INVALID', 'Invalid host trust');
  let joins: readonly ImplementationJoin[] | null;
  try {
    joins = readJoins(root);
  } catch (error) {
    return { status: 'unavailable', reason: `${JOINS} cannot be read (${failure(error).code})` };
  }
  if (joins === null || joins.length === 0)
    return {
      status: 'unavailable',
      reason:
        'no host has joined an installed-implementation catalog in this workspace; "ia host <host> --apply" records a join',
    };
  if (trust === null)
    return {
      status: 'unavailable',
      reason:
        'this installation carries no host payload of its own (or cannot resolve its IA home), so it trusts no join; run the ia that registered the host',
    };
  // The one payload this installation trusts, opened only in its IA home; a workspace's own paths are never followed.
  // `ia host` records the payload as verification resolved it, so its real path is one more spelling of the same entry.
  const trusted = trustedPayload(trust);
  let catalog: InstalledCatalog | { readonly status: 'damaged'; readonly reason: string } | undefined;
  const reasons: string[] = [];
  for (const join of joins) {
    const host = join.consumer,
      path = `.ia/distributions/hosts/${host}-${HOST_REGISTRATION}.json`,
      rerun = `run "ia host ${host} --apply"`;
    let state: ReturnType<typeof saved>;
    try {
      state = locate(path, () => {
        const content = bytes(root, path);
        return saved(content === null ? null : utf8(content), host, HOST_REGISTRATION);
      });
    } catch (error) {
      reasons.push(`host ${host}'s registration cannot be read (${failure(error).code})`);
      continue;
    }
    if (state === null) {
      reasons.push(`host ${host} joined a catalog but is no longer registered`);
      continue;
    }
    const untrusted = registrationUntrusted(trusted, host, state, join.release);
    if (untrusted !== null) {
      reasons.push(`${untrusted}; ${rerun}`);
      continue;
    }
    const expected = trusted.payload;
    if (catalog === undefined)
      try {
        catalog = readInstalledImplementations(expected, trust.release);
      } catch (error) {
        const read = failure(error);
        catalog = DAMAGE.has(read.code)
          ? { status: 'damaged', reason: read.text }
          : {
              status: 'unavailable',
              release: trust.release,
              reason: `its payload catalog cannot be read (${read.text})`,
            };
      }
    if (catalog.status === 'damaged')
      return { status: 'damaged', consumer: host, release: trust.release, payload: expected, reason: catalog.reason };
    if (catalog.status === 'unavailable') {
      reasons.push(`host ${host}'s payload carries no catalog: ${catalog.reason}`);
      continue;
    }
    if (catalog.digest !== join.digest) {
      reasons.push(
        `host ${host}'s join names catalog ${join.digest.slice(0, 12)}, but its payload carries ${catalog.digest.slice(0, 12)}`,
      );
      continue;
    }
    return {
      status: 'joined',
      consumer: host,
      release: catalog.release,
      version: catalog.version,
      digest: catalog.digest,
      catalog,
    };
  }
  return { status: 'unavailable', reason: reasons.join('; ') };
}
