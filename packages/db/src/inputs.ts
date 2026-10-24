import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { BAND_OF, KERNEL_SOURCES, isPlacementKind, isProvenance } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { canonicalRoot, stableSerialize } from '@inventarch/graph';
import type { RevisionSource } from '@inventarch/graph';
import { DbError } from './errors.js';
import { OPENED_READ_FLAGS, OPENS_THROUGH_LINKS, lstatNamed, readOpened } from './named.js';
import { pathKey, sameFile } from './paths.js';
import { decodeActivationPointer } from './distribution/contracts.js';
import type { ActivationPointer, LockedPackage } from './distribution/contracts.js';
import { readInstalledGeneration } from './distribution/reader.js';

export interface FloorSource {
  readonly path: string;
  readonly text: string;
}
export interface AdoptedSource {
  readonly placement?: 'open';
  readonly reach?: string;
  readonly id: string;
  readonly revision: string;
  readonly sources: readonly FloorSource[];
}
export interface InputOptions {
  /** Explicit repository-relative package directories. Their authored instances join root-owned systems; no recursive adoption. */
  readonly authoredRoots?: readonly string[];
  /** Host-only candidate admission; null captures authored/bound sources before installation. */
  readonly candidateInstallation?: ActivationPointer | null;
  readonly floor?: readonly FloorSource[];
  readonly locations?: Readonly<Record<string, Location>>;
  /** Explicit captures replace .ia/workspace.json bindings; [] selects local sources only. */
  readonly adopted?: readonly AdoptedSource[];
  /** Host-selected project instance targets; adopted definitions remain read-only. */
  readonly writableSystems?: readonly string[];
  /**
   * D14: list the runtime evidence files under `.ia/work/evidence` as candidates, of which a view reads and admits only
   * the one named after its own authored revision. Absent or false, as for every existing reader, none is listed. A
   * reader opened with it never writes a cache (`open`).
   */
  readonly evidence?: boolean;
}
export interface InputSnapshot {
  readonly authoredRoots?: readonly string[];
  readonly activation?: ActivationPointer;
  /** Locked packages of the read installation; the activation pointer already fixes these bytes. */
  readonly installed?: readonly LockedPackage[];
  readonly root: string;
  readonly sources: readonly RevisionSource[];
  readonly folders: readonly string[];
  readonly floorOrigin: 'explicit' | 'local' | 'embedded';
  /**
   * D14: the evidence files listed when `evidence` was asked for, by path, size and modification time; never in
   * `sources`, and none is read here: a view reads only its own authored revision's file.
   */
  readonly evidence?: readonly EvidenceCandidate[];
  /** Bounded runner journal receipts, listed only when evidence was requested. */
  readonly runnerEvidence?: readonly EvidenceCandidate[];
  readonly fingerprint: string;
}
/** D14: where the validate effect writes runtime evidence, one file per authored revision. */
export const EVIDENCE_DIRECTORY = '.ia/work/evidence';
/** D14: an evidence file's name, `<authored revision>.ia`; anything else in the directory is not evidence. */
export const EVIDENCE_FILE = /^[0-9a-f]{64}\.ia$/;
/** Runner journal receipts are data, never native sources supplied by a caller. */
export const RUNNER_EVIDENCE_DIRECTORY = '.ia/work/runner-evidence';
export const RUNNER_EVIDENCE_FILE = /^[0-9a-f]{64}-[0-9a-f]{64}\.json$/;
const EVIDENCE_BYTES = 4 * 1024 * 1024;
/** One listed evidence file: its path, and the size and modification time the fingerprint covers. */
export interface EvidenceCandidate {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}
const RUNTIME = Object.freeze({
  placement: Object.freeze({ kind: 'runtime' as const, band: 0 as const, reach: '' }),
  provenance: 'runtime' as const,
});
/**
 * D14: the evidence files at `.ia/work/evidence`, listed and never read. Nothing is ever listed or read through a link:
 * the directories from the root are contained the D01 way, and a link, junction or entry of the wrong kind at `.ia`,
 * `.ia/work` or the directory itself means there is no evidence, as a missing one does; evidence is optional, so a
 * workspace a released reader validated is never refused for its `.ia/work`. A link, a hard-linked file or anything but
 * a regular file is not listed. The writer refuses where it would have to write through any of these.
 */
function evidenceSources(
  root: string,
  directory = EVIDENCE_DIRECTORY,
  pattern = EVIDENCE_FILE,
  limit = Number.MAX_SAFE_INTEGER,
): readonly EvidenceCandidate[] {
  for (const folder of ['.ia', '.ia/work', directory]) {
    let stat: Stats | undefined;
    try {
      stat = lstatSync(safePath(root, folder), { throwIfNoEntry: false });
    } catch (error) {
      if (error instanceof DbError && error.code === 'IA-DB-PATH-UNSAFE') return [];
      throw error;
    }
    if (stat === undefined || !stat.isDirectory()) return [];
  }
  const found: EvidenceCandidate[] = [];
  for (const name of readdirSync(safePath(root, directory)).sort(compare)) {
    if (!pattern.test(name)) continue;
    const path = `${directory}/${name}`;
    let stat: Stats | undefined;
    try {
      stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    } catch (error) {
      if (directory === RUNNER_EVIDENCE_DIRECTORY && error instanceof DbError && error.code === 'IA-DB-PATH-UNSAFE')
        continue;
      throw error;
    }
    if (stat?.isFile() === true && stat.nlink === 1)
      found.push(Object.freeze({ path, bytes: stat.size, mtimeMs: stat.mtimeMs }));
    if (found.length > limit) return Object.freeze([]);
  }
  return Object.freeze(found);
}
/**
 * D14: the listed evidence file at `path` as a source at runtime placement band 0, read through `readWorkspaceBytes`
 * (so a link, hard link or nonregular file is refused) within its bound; undefined for one that cannot be read or is not
 * exact UTF-8, which is then not evidence.
 */
export function evidenceSource(root: string, path: string): RevisionSource | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      readWorkspaceBytes(root, path, EVIDENCE_BYTES),
    );
    return Object.freeze({ path, text, location: RUNTIME });
  } catch {
    return undefined;
  }
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export { pathKey };
function relativePath(path: string): string {
  try {
    return canonicalRoot(path);
  } catch (error) {
    throw new DbError('IA-DB-PATH-UNSAFE', `Unsafe workspace path '${path}': ${String(error)}`);
  }
}
export function safePath(root: string, path: string): string {
  const canonical = relativePath(path);
  let current = root;
  for (const segment of canonical.split('/').filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new DbError(
          'IA-DB-PATH-UNSAFE',
          `Symlink/junction traversal is not admitted: ${current}`,
          relative(root, current).replaceAll('\\', '/'),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return current;
}
/**
 * The portable path rule the distribution workspace file reader (`ia read`'s) applies, over a canonical workspace-relative
 * path, so the two readers admit the same paths: NFC text of at most 1024 code units, with no backslash, control character
 * or any of `<>:"|?*` (on Windows a colon names a file's alternate data stream), and no segment that ends in a dot or a
 * space or names a reserved device.
 */
const portable = (path: string): boolean =>
  path !== '' &&
  path === path.normalize('NFC') &&
  path.length <= 1024 &&
  !/[\\\u0000-\u001f<>:"|?*]/.test(path) &&
  path.split('/').every((part) => !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
/**
 * D01a: the bytes of the workspace file at the workspace-relative `path`, bounded and checked as package source capture
 * reads a source file. A path that escapes the workspace is IA-DB-PATH-UNSAFE with no `path`, as it has no canonical one;
 * a nonportable path, a symbolic link or junction on the way, or anything but a regular file with one link is
 * IA-DB-PATH-UNSAFE; a missing or unreadable file, or one of more than `limit` bytes, is IA-DB-SOURCE-UNAVAILABLE, and one
 * replaced or resized while it is read IA-DB-SOURCE-CHANGED. Each of those errors' `path` is the canonical path, the only
 * path its message names; an invalid root is IA-DB-ROOT-INVALID. It reads one file a host names, such as the document a
 * record's source locator names (runtime `Door` `read`), and admits nothing.
 */
export function readWorkspaceBytes(root: string, path: string, limit: number): Uint8Array {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('A byte limit is a nonnegative safe integer');
  const relative = relativePath(path);
  if (!portable(relative)) throw new DbError('IA-DB-PATH-UNSAFE', `Nonportable workspace path: ${relative}`, relative);
  const canonical = workspaceRoot(root);
  try {
    let file: string;
    try {
      file = safePath(canonical, relative);
    } catch (error) {
      // safePath's refusal names the link by its absolute location; this one names the canonical path alone.
      if (error instanceof DbError)
        throw new DbError(error.code, `Symlink/junction traversal is not admitted: ${relative}`, relative);
      throw error;
    }
    const unsafe = () => new DbError('IA-DB-PATH-UNSAFE', `Expected an unaliased regular file: ${relative}`, relative);
    const changed = () => new DbError('IA-DB-SOURCE-CHANGED', `File changed during read: ${relative}`, relative);
    // Keep each containing directory's identity, not just the spelling of the file name.
    // Inode numbers can exceed Number.MAX_SAFE_INTEGER on Windows; retain their full width throughout.
    const parents = [canonical];
    for (const segment of relative.split('/').slice(0, -1)) parents.push(join(parents.at(-1)!, segment));
    const directories = parents.map((path) => ({ path, stat: lstatSync(path, { bigint: true }) }));
    if (directories.some(({ stat }) => stat.isSymbolicLink()))
      throw new DbError('IA-DB-PATH-UNSAFE', `Symlink/junction traversal is not admitted: ${relative}`, relative);
    if (directories.some(({ stat }) => !stat.isDirectory()))
      throw new DbError('IA-DB-SOURCE-UNAVAILABLE', `Missing file ${relative}`, relative);
    // Still the opened file at its name, under the same directories.
    const assertNamed = (opened: BigIntStats) => {
      try {
        const named = lstatSync(file, { bigint: true });
        if (!named.isFile() || named.nlink !== 1n || named.dev !== opened.dev || named.ino !== opened.ino)
          throw changed();
        for (const { path, stat } of directories) {
          const now = lstatSync(path, { bigint: true });
          if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino)
            throw changed();
        }
      } catch {
        throw changed();
      }
    };
    // Open before deciding the file's type, link count, size or allocation; allocation and reading are bounded to the
    // opened file's size plus one, even if a concurrent writer grows it.
    return readOpened(file, {
      unopened: (error) => {
        // A link the open refused, a socket, or anything else whose open fails is judged by its name: refuse it as an
        // opened one is refused.
        const named = lstatSync(file, { bigint: true });
        if (!named.isFile() || named.nlink !== 1n) throw unsafe();
        throw error;
      },
      opened: (opened) => {
        if (!opened.isFile() || opened.nlink !== 1n) throw unsafe();
        if (opened.size > BigInt(limit))
          throw new DbError('IA-DB-SOURCE-UNAVAILABLE', `File exceeds ${limit} bytes: ${relative}`, relative);
        assertNamed(opened);
      },
      read: ({ opened, bytes, after }) => {
        if (
          BigInt(bytes.length) !== opened.size ||
          after.size !== opened.size ||
          after.nlink !== 1n ||
          after.mtimeNs !== opened.mtimeNs ||
          after.ctimeNs !== opened.ctimeNs
        )
          throw changed();
        assertNamed(opened);
        return bytes;
      },
    });
  } catch (error) {
    if (error instanceof DbError) throw error;
    // A path through a file is missing too: ENOENT on Windows, ENOTDIR on POSIX. Only the error code is kept, as a
    // filesystem message names the absolute path.
    const code = (error as NodeJS.ErrnoException).code;
    throw new DbError(
      'IA-DB-SOURCE-UNAVAILABLE',
      code === 'ENOENT' || code === 'ENOTDIR'
        ? `Missing file ${relative}`
        : `Cannot read ${relative}${typeof code === 'string' ? ` (${code})` : ''}`,
      relative,
    );
  }
}
function location(value: Location): Location {
  if (
    !isPlacementKind(value.placement.kind) ||
    BAND_OF[value.placement.kind] !== value.placement.band ||
    !isProvenance(value.provenance)
  )
    throw new DbError('IA-DB-PATH-UNSAFE', 'Location needs a closed placement/band pair and provenance');
  return Object.freeze({
    placement: Object.freeze({ ...value.placement, reach: relativePath(value.placement.reach) }),
    provenance: value.provenance,
  });
}
export function inputOptions(options: InputOptions): InputOptions {
  if (
    options.authoredRoots !== undefined &&
    (!Array.isArray(options.authoredRoots) || options.authoredRoots.some((root) => typeof root !== 'string'))
  )
    throw new DbError('IA-DB-PATH-UNSAFE', 'Authored package roots must be an array of directory paths');
  const authoredRoots: string[] | undefined =
    options.authoredRoots === undefined ? undefined : [...options.authoredRoots].sort(compare);
  if (authoredRoots) {
    if (authoredRoots.length > 1000)
      throw new DbError('IA-DB-PATH-UNSAFE', 'At most 1000 authored package roots are supported');
    const keys = new Set<string>();
    for (const path of authoredRoots) {
      const key = path.normalize('NFC').toLowerCase();
      if (
        !path ||
        relativePath(path) !== path ||
        path !== path.normalize('NFC') ||
        /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
        path
          .split('/')
          .some(
            (part) =>
              part.startsWith('.') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
          ) ||
        [...keys].some((other) => key === other || key.startsWith(other + '/') || other.startsWith(key + '/'))
      )
        throw new DbError(
          'IA-DB-PATH-UNSAFE',
          'Authored package roots must be distinct nonoverlapping portable directories outside .ia',
        );
      keys.add(key);
    }
  }
  const candidateInstallation =
    options.candidateInstallation === undefined
      ? undefined
      : options.candidateInstallation === null
        ? null
        : decodeActivationPointer(options.candidateInstallation);
  const ids = new Set<string>();
  const adopted = options.adopted?.map((mount) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(mount.id) || ids.has(mount.id) || !/^[a-f0-9]{64}$/.test(mount.revision))
      throw new DbError('IA-DB-PATH-UNSAFE', 'Invalid/duplicate adopted source identity');
    ids.add(mount.id);
    const paths = new Set<string>();
    const sources = mount.sources.map((source) => {
      const path = relativePath(source.path),
        key = path.normalize('NFC').toLowerCase();
      if (
        path !== source.path ||
        path !== path.normalize('NFC') ||
        !path.startsWith('.ia/src/') ||
        path.startsWith('.ia/src/floor/') ||
        !path.endsWith('.ia') ||
        paths.has(key) ||
        /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
        path.split('/').some((p) => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) ||
        Buffer.from(source.text).toString('utf8') !== source.text
      )
        throw new DbError('IA-DB-PATH-UNSAFE', 'Unsafe adopted source path/bytes');
      paths.add(key);
      return Object.freeze({ path, text: source.text });
    });
    const revision = createHash('sha256').update(stableSerialize(sources)).digest('hex');
    if (revision !== mount.revision)
      throw new DbError('IA-DB-SOURCE-CHANGED', 'Adopted source revision does not match exact bytes');
    if (mount.placement !== undefined && mount.placement !== 'open')
      throw new DbError('IA-DB-PATH-UNSAFE', 'Invalid bound source placement');
    return Object.freeze({
      id: mount.id,
      revision,
      sources: Object.freeze(sources),
      ...(mount.placement === 'open' ? { placement: 'open' as const, reach: relativePath(mount.reach ?? '') } : {}),
    });
  });
  const writableSystems =
    options.writableSystems === undefined ? undefined : Object.freeze([...options.writableSystems]);
  if (writableSystems?.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)))
    throw new DbError('IA-DB-PATH-UNSAFE', 'Invalid project instance target');
  const locations: Record<string, Location> = {};
  for (const [path, value] of Object.entries(options.locations ?? {})) {
    const key = pathKey(relativePath(path));
    if (!key.startsWith('.ia/src/'))
      throw new DbError('IA-DB-PATH-UNSAFE', `Location override is outside .ia/src: ${path}`);
    if (Object.hasOwn(locations, key))
      throw new DbError('IA-DB-PATH-UNSAFE', `Duplicate source location alias: ${path}`);
    locations[key] = location(value);
  }
  const floor = options.floor?.map((source) => {
    const path = relativePath(source.path);
    if (!pathKey(path).startsWith('.ia/src/floor/') || !path.endsWith('.ia'))
      throw new DbError('IA-DB-PATH-UNSAFE', `Floor source needs a .ia/src/floor/*.ia path: ${source.path}`);
    return Object.freeze({ path, text: source.text });
  });
  if (floor !== undefined && new Set(floor.map((s) => pathKey(s.path))).size !== floor.length)
    throw new DbError('IA-DB-PATH-UNSAFE', 'Duplicate floor source aliases');
  return Object.freeze({
    locations: Object.freeze(locations),
    ...(options.evidence === true ? { evidence: true } : {}),
    ...(authoredRoots === undefined ? {} : { authoredRoots: Object.freeze(authoredRoots) }),
    ...(candidateInstallation === undefined ? {} : { candidateInstallation }),
    ...(floor === undefined ? {} : { floor: Object.freeze(floor) }),
    ...(adopted === undefined ? {} : { adopted: Object.freeze(adopted) }),
    ...(writableSystems === undefined ? {} : { writableSystems }),
  });
}
/** A read of the workspace's inputs, refusing a filesystem failure with a db code. */
function discovering<T>(root: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'IA-DB-SOURCE-CHANGED' : 'IA-DB-SOURCE-UNAVAILABLE',
      `Source discovery failed in ${root}: ${String(error)}`,
    );
  }
}
export function readInputs(root: string, supplied: InputOptions = {}): InputSnapshot {
  return discovering(root, () => discover(root, supplied));
}
export interface AdoptedBinding {
  readonly id: string;
  /** The canonical workspace-relative directory whose `.ia/src` the binding captures. */
  readonly path: string;
  readonly revision: string;
  /** The qualified source label: virtual for adopted bindings and the immutable on-disk tree for open bindings. */
  readonly tree: string;
  readonly placement?: 'open';
  readonly reach?: string;
}
const adoptedTree = (id: string, revision: string): string => `.ia/adopted/${id}/${revision}`;
/**
 * The bindings `.ia/workspace.json` declares, validated as discovery validates them but without reading or verifying the
 * bound sources; [] when there is no manifest. A host maps a mount's tree label back to its directory with them.
 */
export function adoptedBindings(root: string): readonly AdoptedBinding[] {
  return discovering(root, () =>
    Object.freeze(
      bindings(workspaceRoot(root)).map((binding) =>
        Object.freeze({
          ...binding,
          tree:
            binding.placement === 'open'
              ? `.ia/open/${binding.id}/${binding.revision}`
              : adoptedTree(binding.id, binding.revision),
        }),
      ),
    ),
  );
}
/** A `.ia/workspace.json` binding discovery refuses. */
const invalid = (message: string): never => {
  throw new DbError('IA-DB-SOURCE-UNAVAILABLE', `.ia/workspace.json: ${message}`);
};
interface Binding {
  readonly placement?: 'open';
  readonly reach?: string;
  readonly id: string;
  readonly path: string;
  readonly revision: string;
}
/**
 * Local, pinned source bindings. This is host data, never a code loader or a write grant. `each` runs on every binding
 * as soon as it is validated, before the next one is, so a caller that reads a binding's sources there refuses with the
 * first faulty binding's own fault, read-time ones included, exactly as 1.x discovery did; the frozen Door routes and
 * `ia scope` report that refusal, so the order is part of their output.
 */
function bindings<T = Binding>(root: string, each: (binding: Binding) => T = (binding) => binding as T): readonly T[] {
  const path = safePath(root, '.ia/workspace.json'),
    irregular = (): never => invalid('Expected a regular manifest of at most 64 KiB'),
    undecodable = (): never => invalid('Expected UTF-8 JSON');
  // The manifest is opened before it is judged, so the judgment and the bytes are of one file (CodeQL
  // js/file-system-race), and a final link put in place after safePath is refused by the open where the platform has
  // the flag. A missing manifest declares no bindings.
  const bytes = readOpened(path, {
    unopened: (error) => {
      if (error.code === 'ENOENT') return null;
      // A link the open refused, a socket, or anything else whose open fails is judged by its name: refuse it as an
      // opened one is refused. A regular manifest that cannot be opened is unreadable, as one that cannot be read is.
      const named = lstatSync(path, { bigint: true });
      if (!named.isFile() || named.size > 65_536n) irregular();
      return undecodable();
    },
    opened: (opened) => {
      if (!opened.isFile() || opened.size > 65_536n) irregular();
    },
    unread: undecodable,
    read: ({ opened, bytes, after }) => {
      // The bytes are the manifest's only if it kept its size and still has that name; on Windows, which opens through
      // a link, the name's identity is the only guard against a link placed after the path check.
      const named = lstatNamed(path);
      if (
        BigInt(bytes.length) !== opened.size ||
        after.size !== opened.size ||
        named?.isFile() !== true ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        irregular();
      return bytes;
    },
  });
  if (bytes === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    undecodable();
  }
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (
    !object(value) ||
    value['version'] !== 1 ||
    Object.keys(value).some((k) => !['version', 'adopted', 'open'].includes(k)) ||
    (value['adopted'] !== undefined && !Array.isArray(value['adopted'])) ||
    (value['open'] !== undefined && !Array.isArray(value['open'])) ||
    ((value['adopted'] as unknown[]) ?? []).length + ((value['open'] as unknown[]) ?? []).length > 16
  )
    invalid('Expected version 1 and at most 16 adopted bindings');
  const ids = new Set<string>(),
    paths = new Set<string>();
  return [
    ...((value as { adopted?: unknown[] }).adopted ?? []).map((entry) => ({ entry, open: false })),
    ...((value as { open?: unknown[] }).open ?? []).map((entry) => ({ entry, open: true })),
  ].map(({ entry, open }) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (k) => !(open ? ['id', 'path', 'revision', 'reach'] : ['id', 'path', 'revision']).includes(k),
      ) ||
      typeof entry['id'] !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(entry['id']) ||
      typeof entry['path'] !== 'string' ||
      typeof entry['revision'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry['revision'])
    )
      invalid('Invalid adopted id, path or revision');
    const binding = entry as { id: string; path: string; revision: string },
      local = binding.path;
    if (
      !local ||
      relativePath(local) !== local ||
      local !== local.normalize('NFC') ||
      /[\\\u0000-\u001f<>:"|?*]/.test(local) ||
      local.split('/').some((p) => !p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) ||
      (open
        ? local !== `.ia/open/${binding.id}/${binding.revision}`
        : local.toLowerCase() === '.ia' || local.toLowerCase().startsWith('.ia/'))
    )
      invalid(
        open
          ? 'Open sources must use their exact .ia/open/<id>/<revision> tree'
          : 'Source roots must be canonical workspace-relative directories outside .ia',
      );
    const key = local.toLowerCase();
    if (ids.has(binding.id) || paths.has(key)) invalid('Duplicate source identity or directory');
    ids.add(binding.id);
    paths.add(key);
    const reach =
      open && (entry as Record<string, unknown>)['reach'] !== undefined
        ? (entry as Record<string, unknown>)['reach']
        : '';
    if (typeof reach !== 'string' || relativePath(reach) !== reach) invalid('Invalid open source reach');
    return each({
      id: binding.id,
      path: local,
      revision: binding.revision,
      ...(open ? { placement: 'open' as const, reach: reach as string } : {}),
    });
  });
}
function workspaceSources(root: string): readonly AdoptedSource[] {
  return bindings(root, (binding) => {
    const directory = safePath(root, binding.path),
      sourceRoot = safePath(directory, '.ia/src');
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory())
      invalid(`Missing source tree for ${binding.id}`);
    // Bind only this physical source tree; no recursive manifest expansion or extra floor.
    const sources = discover(directory, { adopted: [], candidateInstallation: null })
      .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text }));
    const revision = createHash('sha256').update(stableSerialize(sources)).digest('hex');
    if (revision !== binding.revision)
      invalid(`Pinned source revision differs for ${binding.id}; refresh the binding with the intended source bytes`);
    return {
      id: binding.id,
      revision,
      sources,
      ...(binding.placement === 'open' ? { placement: 'open' as const, reach: binding.reach ?? '' } : {}),
    };
  });
}
/** The canonical directory of a workspace root, refused with IA-DB-ROOT-INVALID when it is none. */
function workspaceRoot(root: string): string {
  try {
    const canonical = realpathSync(resolve(root));
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory');
    return canonical;
  } catch (error) {
    throw new DbError('IA-DB-ROOT-INVALID', `Cannot open workspace ${root}: ${String(error)}`);
  }
}
/**
 * The bytes of the corpus source the walk listed at `child` as a regular file. Its name is opened before what it names
 * is judged, with `OPENED_READ_FLAGS`, and read through that descriptor as `readFileSync` reads a file, so the bytes are
 * of the file judged: a FIFO put at the name since the listing is not waited on, a terminal there does not become the
 * process's controlling terminal, and a final link is not followed where the platform has the no-follow flag. What
 * opens is read only if it is a regular file; when the open fails, the name is judged instead, a link as the listing
 * refuses one and anything else but a regular file as one that opens. A name that is gone, a regular file that does not
 * open, and a read that fails answer with the filesystem's error, which the walk refuses as before. Where the open
 * follows a final link (`OPENS_THROUGH_LINKS`, Windows), the name must still name the file read once it is read, as
 * package source capture checks: a link there is refused as the listing refuses one, a link to what is not a regular
 * file included, and a name that names nothing or another file is IA-DB-SOURCE-CHANGED.
 */
function readSource(root: string, child: string): Buffer {
  const file = safePath(root, child),
    irregular = () =>
      new DbError('IA-DB-SOURCE-UNAVAILABLE', `Cannot read exact UTF-8 source ${child}: not a regular file`),
    alias = () => new DbError('IA-DB-PATH-UNSAFE', `Source alias is not admitted: ${child}`);
  let fd: number;
  try {
    fd = openSync(file, OPENED_READ_FLAGS);
  } catch (error) {
    let named: Stats | undefined;
    try {
      named = lstatSync(file, { throwIfNoEntry: false });
    } catch {
      throw error;
    }
    if (named?.isSymbolicLink()) throw alias();
    if (named !== undefined && !named.isFile()) throw irregular();
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) {
      // Where the open follows a final link, what opened may be what a link at the name names: refuse the link.
      if (OPENS_THROUGH_LINKS && lstatNamed(file)?.isSymbolicLink()) throw alias();
      throw irregular();
    }
    const bytes = readFileSync(fd);
    if (OPENS_THROUGH_LINKS) {
      const named = lstatNamed(file);
      if (named?.isSymbolicLink()) throw alias();
      if (named?.isFile() !== true || named.dev !== opened.dev || named.ino !== opened.ino)
        throw new DbError('IA-DB-SOURCE-CHANGED', `Source replaced during read: ${child}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function discover(root: string, supplied: InputOptions): InputSnapshot {
  const canonical = workspaceRoot(root);
  const options = inputOptions({ ...supplied, adopted: supplied.adopted ?? workspaceSources(canonical) }),
    sourceRoot = safePath(canonical, '.ia/src'),
    floorRoot = safePath(canonical, '.ia/src/floor');
  const floorOrigin = options.floor !== undefined ? 'explicit' : existsSync(floorRoot) ? 'local' : 'embedded';
  if (floorOrigin === 'local' && !statSync(floorRoot).isDirectory())
    throw new DbError('IA-DB-SOURCE-UNAVAILABLE', 'The local floor path must be a directory');
  const sources: RevisionSource[] = [],
    names = new Set<string>();
  const add = (source: FloorSource): void => {
    const key = pathKey(source.path);
    if (names.has(key)) throw new DbError('IA-DB-PATH-UNSAFE', `Duplicate source alias ${source.path}`);
    names.add(key);
    const fallback: Location = key.startsWith('.ia/src/floor/')
      ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
      : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    sources.push(Object.freeze({ ...source, location: options.locations?.[key] ?? location(fallback) }));
  };
  const walk = (path: string): void => {
    for (const entry of readdirSync(safePath(canonical, path), { withFileTypes: true }).sort((a, b) =>
      compare(a.name, b.name),
    )) {
      // Colocated executable systems contain package artifacts, never corpus sources.
      if (['node_modules', 'dist', '.git'].includes(entry.name.toLowerCase())) continue;
      // Where the volume opens `.ia/src/systems` as `Systems`, that is the systems folder; its members keep their names.
      const folded = pathKey(entry.name),
        name =
          path === '.ia/src' &&
          ['floor', 'systems'].includes(folded) &&
          sameFile(safePath(canonical, `${path}/${entry.name}`), safePath(canonical, `${path}/${folded}`))
            ? folded
            : entry.name;
      const child = `${path}/${name}`;
      if (pathKey(child) === '.ia/src/floor' && floorOrigin !== 'local') continue;
      if (entry.isSymbolicLink()) throw new DbError('IA-DB-PATH-UNSAFE', `Source alias is not admitted: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.ia')) {
        try {
          add({
            path: child,
            text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readSource(canonical, child)),
          });
        } catch (error) {
          if (error instanceof DbError) throw error;
          throw new DbError(
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'IA-DB-SOURCE-CHANGED' : 'IA-DB-SOURCE-UNAVAILABLE',
            `Cannot read exact UTF-8 source ${child}: ${String(error)}`,
          );
        }
      }
    }
  };
  if (existsSync(sourceRoot)) walk('.ia/src');
  // Selected package trees contribute original physical paths at authored precedence.
  // The repository still owns each system declaration and its sole steward/definition closure.
  let packageFiles = 0,
    packageBytes = 0;
  for (const packageRoot of options.authoredRoots ?? []) {
    let parent = '';
    for (const segment of packageRoot.split('/')) {
      const siblings = readdirSync(safePath(canonical, parent));
      if (
        !siblings.includes(segment) ||
        siblings.filter((name) => name.normalize('NFC').toLowerCase() === segment.toLowerCase()).length !== 1
      )
        throw new DbError('IA-DB-PATH-UNSAFE', `Authored package path spelling/alias differs: ${packageRoot}`);
      parent = parent ? `${parent}/${segment}` : segment;
      if (!lstatSync(safePath(canonical, parent)).isDirectory())
        throw new DbError('IA-DB-PATH-UNSAFE', `Authored package root is not a directory: ${parent}`);
    }
    const packageMembers = readdirSync(safePath(canonical, packageRoot));
    if (!packageMembers.includes('.ia') || packageMembers.filter((name) => name.toLowerCase() === '.ia').length !== 1)
      throw new DbError('IA-DB-PATH-UNSAFE', `Package .ia path is missing or aliased: ${packageRoot}`);
    const nativeRoot = `${packageRoot}/.ia`,
      members = readdirSync(safePath(canonical, nativeRoot));
    if (
      !members.includes('src') ||
      members.filter((name) => name.toLowerCase() === 'src').length !== 1 ||
      members.some((name) =>
        ['monorepo.json', 'workspace.json', 'package.json', 'distributions.lock.json', 'release.json'].includes(
          name.toLowerCase(),
        ),
      )
    )
      throw new DbError(
        'IA-DB-PATH-UNSAFE',
        `Package source has an independent root or legacy authority: ${nativeRoot}`,
      );
    const tree = `${nativeRoot}/src`;
    if (readdirSync(safePath(canonical, tree)).some((name) => name !== 'systems'))
      throw new DbError('IA-DB-PATH-UNSAFE', `Package sources must be instances under root-owned systems: ${tree}`);
    const visit = (path: string): void => {
      const entries = readdirSync(safePath(canonical, path), { withFileTypes: true }).sort((a, b) =>
        compare(a.name, b.name),
      );
      const aliases = new Set<string>();
      for (const entry of entries) {
        const key = entry.name.normalize('NFC').toLowerCase();
        if (
          aliases.has(key) ||
          entry.name !== entry.name.normalize('NFC') ||
          /[\\\u0000-\u001f<>:"|?*]/.test(entry.name) ||
          /[. ]$/.test(entry.name)
        )
          throw new DbError('IA-DB-PATH-UNSAFE', `Nonportable package source path: ${path}/${entry.name}`);
        aliases.add(key);
        if (entry.name === '.ia' || entry.isSymbolicLink())
          throw new DbError('IA-DB-PATH-UNSAFE', `Nested root or alias: ${path}/${entry.name}`);
        const child = `${path}/${entry.name}`,
          file = safePath(canonical, child);
        if (!entry.isDirectory() && !entry.isFile())
          throw new DbError('IA-DB-PATH-UNSAFE', `Nonregular package source: ${child}`);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && entry.name.endsWith('.ia')) {
          const owner = systemMember(child);
          if (
            !owner ||
            child === `${owner.root}/system.ia` ||
            !existsSync(safePath(canonical, `.ia/src/systems/${owner.name}/system.ia`))
          )
            throw new DbError('IA-DB-PATH-UNSAFE', `Package instance lacks a root-owned system declaration: ${child}`);
          const replaced = () => new DbError('IA-DB-SOURCE-CHANGED', `Package source replaced during read: ${child}`);
          // Still the regular file the listing named, with one link and within the capture bounds, before any byte is read.
          const admit = (stat: BigIntStats): void => {
            if (!stat.isFile()) throw replaced();
            if (stat.nlink !== 1n) throw new DbError('IA-DB-PATH-UNSAFE', `Hard-linked package source: ${child}`);
            if (++packageFiles > 20000 || stat.size > 1048576n || (packageBytes += Number(stat.size)) > 67108864)
              throw new DbError('IA-DB-SOURCE-UNAVAILABLE', 'Authored package source capture limit exceeded');
          };
          // The file is opened before it is judged, so the judgment and the bytes are of one file (CodeQL
          // js/file-system-race), and a link put in place since the listing is refused by the open where the platform
          // has the flag. Allocation and reading are bounded even if a concurrent writer grows the file.
          const bytes = readOpened(file, {
            unopened: (error) => {
              // A link the open refused, a socket, or anything else whose open fails: judge the name as the opened
              // file would be.
              admit(lstatSync(file, { bigint: true }));
              throw error;
            },
            opened: admit,
            read: ({ opened, bytes, after }) => {
              if (
                BigInt(bytes.length) !== opened.size ||
                after.size !== opened.size ||
                after.mtimeNs !== opened.mtimeNs ||
                after.ctimeNs !== opened.ctimeNs
              )
                throw new DbError('IA-DB-SOURCE-CHANGED', `Package source changed during read: ${child}`);
              // On Windows, which opens through a link, the name's identity is the only guard against a link placed
              // after the listing.
              const named = lstatNamed(file);
              if (named?.isFile() !== true || named.dev !== opened.dev || named.ino !== opened.ino) throw replaced();
              return bytes;
            },
          });
          add({ path: child, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) });
        }
      }
    };
    visit(tree);
  }
  if (floorOrigin !== 'local') for (const source of options.floor ?? KERNEL_SOURCES) add(source);
  const installed =
    options.candidateInstallation === null
      ? undefined
      : readInstalledGeneration(canonical, options.candidateInstallation);
  if (installed) sources.push(...installed.sources);
  for (const mount of options.adopted ?? [])
    for (const source of mount.sources) {
      const tree =
        mount.placement === 'open' ? `.ia/open/${mount.id}/${mount.revision}` : adoptedTree(mount.id, mount.revision);
      const path = `${tree}/${source.path}`;
      sources.push(
        Object.freeze({
          path,
          text: source.text,
          location: location({
            placement:
              mount.placement === 'open'
                ? { kind: 'open', band: 50, reach: mount.reach ?? '' }
                : { kind: 'adopted', band: 90, reach: '' },
            provenance: 'methodology',
          }),
        }),
      );
    }
  const systemRoot = safePath(canonical, '.ia/src/systems');
  const folders = [
    ...new Set([
      ...(existsSync(systemRoot)
        ? readdirSync(systemRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : []),
      ...sources.flatMap((source) => {
        const member = systemMember(source.path);
        return member ? [member.name] : [];
      }),
    ]),
  ].sort(compare);
  sources.sort((a, b) => compare(a.path, b.path));
  const activation = installed ? { activation: installed.pointer } : {};
  const authored = options.authoredRoots === undefined ? {} : { authoredRoots: options.authoredRoots };
  // D14: only a reader that asks reads evidence, and its fingerprint then covers it, so a concurrent write is seen.
  const evidence =
    options.evidence === true
      ? {
          evidence: evidenceSources(canonical),
          runnerEvidence: evidenceSources(canonical, RUNNER_EVIDENCE_DIRECTORY, RUNNER_EVIDENCE_FILE, 128),
        }
      : {};
  return Object.freeze({
    root: canonical,
    sources: Object.freeze(sources),
    folders: Object.freeze(folders),
    floorOrigin,
    ...activation,
    ...authored,
    ...evidence,
    ...(installed ? { installed: installed.lock.packages } : {}),
    fingerprint: createHash('sha256')
      .update(stableSerialize({ sources, folders, floorOrigin, ...activation, ...authored, ...evidence }))
      .digest('hex'),
  });
}
/** Shared membership for local and qualified adopted sources. */
export function systemMember(path: string): { name: string; root: string } | undefined {
  const match =
    /^(\.ia\/(?:(?:(?:adopted|open)\/[a-z][a-z0-9-]*|distributions\/store)\/[a-f0-9]{64}\/\.ia\/)?src\/systems\/([^/]+))\//.exec(
      path,
    ) ?? /^((?!\.ia\/)(?:[^/]+\/)+\.ia\/src\/systems\/([^/]+))\//.exec(path);
  return match ? { name: match[2]!, root: match[1]! } : undefined;
}
