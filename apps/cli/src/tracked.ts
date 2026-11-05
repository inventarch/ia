/**
 * The tracked list: docs/specs/consumer-cli-contract/README.md §2.16. `<IA home>/tracked-workspaces.json` is one
 * person's list of the workspaces they keep current, `{format: 'ia-tracked-workspaces-1', workspaces: [{id, root,
 * label?, added}]}`. It is not the MCP door's `workspace-locations.json`, which this module never reads or writes:
 * tracking a workspace admits nothing to the door.
 *
 * Every write goes through `writeHomeFile` (atomic, fsynced) and keeps the keys it does not know, at the top level and
 * on each row, so a hand-edited file survives. A file that does not parse, or names another format, is refused as
 * `IA-CLI-TRACKED-INVALID` and never overwritten. A root is stored as its real path and compared by device and inode
 * (`sameRoot`), so a junction, a trailing separator or another case on Windows is the same row; where the volume
 * reports no inode, by exact real path. A row whose root is gone stays in the list as `missing` until it is removed by
 * name.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathKey, unidentified, within } from '@inventarch/db/internal/paths';
import { readHomeFile, writeHomeFile } from '@inventarch/distribution/ia-home';
import { inertCommandRoot } from '@inventarch/runtime';
import { UsageError } from './args.js';
import { withTrackedLock } from './tracked-lock.js';
import { Refusal } from './consumer.js';
import { quote } from './render.js';

export const TRACKED_FILE = 'tracked-workspaces.json';
export const TRACKED_FORMAT = 'ia-tracked-workspaces-1';
/** The MCP door's id rule, so a later slice could share ids between the two lists. */
export const TRACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `ia workspaces find`'s default depth below the folder, and the most `--depth` may ask for. */
export const FIND_DEPTH = 4;
export const FIND_DEPTH_MAX = 8;

export interface TrackedWorkspace {
  readonly id: string;
  /** An absolute real path. */
  readonly root: string;
  readonly label?: string;
  /** ISO-8601 UTC. */
  readonly added: string;
}
/** `missing`: the root is gone, or no longer holds `.ia/src`. */
export type TrackedState = 'present' | 'missing';

type Raw = Readonly<Record<string, unknown>>;
/** The file as read: the whole document, kept for its unknown keys, and each row beside its own raw object. */
interface Loaded {
  readonly path: string;
  readonly document: Raw | null;
  readonly rows: readonly { readonly raw: Raw; readonly row: TrackedWorkspace }[];
}

const isObject = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
};
/** The entry itself is a symbolic link or a junction (Node reports both as links), whatever it points at. */
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  } catch {
    return false;
  }
};
const isFile = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
};
type Identity = { readonly dev: bigint; readonly ino: bigint };
const identity = (path: string): Identity | undefined => {
  try {
    return statSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};
/** The exact real path; the resolved spelling when even that cannot be read. */
const realOrResolved = (path: string, real: (path: string) => string): string => {
  try {
    return real(path);
  } catch {
    return resolve(path);
  }
};
/**
 * One root, whichever way it is spelled. While both paths exist the answer is their device and inode and nothing else,
 * so two directories whose names differ only by case (on a volume that keeps them apart) are two roots. Where either
 * side reports no identity, their real paths are compared exactly, never folded, so two directories are never one row.
 * Only when one of them is gone is the folded spelling compared, as the volume would fold it.
 */
export function sameRoot(
  a: string,
  b: string,
  stat: (path: string) => Identity | undefined = identity,
  real: (path: string) => string = realpathSync.native,
): boolean {
  const left = stat(a),
    right = stat(b);
  if (left !== undefined && right !== undefined) {
    // An identity the volume did not supply (`unidentified`: an inode of 0, which covers a device and inode both 0, or
    // all ones) never means "the same file".
    if (unidentified(left.ino) || unidentified(right.ino)) return realOrResolved(a, real) === realOrResolved(b, real);
    return left.dev === right.dev && left.ino === right.ino;
  }
  return pathKey(resolve(a)) === pathKey(resolve(b));
}

function load(home: string): Loaded {
  const path = join(home, TRACKED_FILE),
    text = readHomeFile(home, TRACKED_FILE);
  if (text === null) return { path, document: null, rows: [] };
  const invalid = (why: string): Refusal =>
    new Refusal(
      'IA-CLI-TRACKED-INVALID',
      `${path} is not a tracked-workspaces list: ${why}`,
      3,
      { path },
      `Fix or delete ${path}, then run "ia workspaces list".`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (!isObject(parsed)) throw invalid('it is not a JSON object');
  if (parsed['format'] !== TRACKED_FORMAT)
    throw invalid(`its format is ${JSON.stringify(parsed['format'])}, not ${TRACKED_FORMAT}`);
  const listed = parsed['workspaces'];
  if (!Array.isArray(listed)) throw invalid('workspaces is not a list');
  const ids = new Set<string>();
  const rows = listed.map((raw: unknown, index) => {
    if (!isObject(raw)) throw invalid(`workspaces[${index}] is not an object`);
    const { id, root, label, added } = raw;
    if (typeof id !== 'string' || !TRACK_ID.test(id)) throw invalid(`workspaces[${index}] has no valid id`);
    if (typeof root !== 'string' || !isAbsolute(root)) throw invalid(`${id} names no absolute root`);
    if (typeof added !== 'string') throw invalid(`${id} has no added time`);
    if (label !== undefined && typeof label !== 'string') throw invalid(`${id} has a label that is not text`);
    if (ids.has(id)) throw invalid(`${id} is listed twice`);
    ids.add(id);
    return { raw, row: { id, root, ...(label === undefined ? {} : { label }), added } };
  });
  return { path, document: parsed, rows };
}
/** The document with its rows replaced; every other key, and every key of a kept row, as it was read. */
function save(home: string, loaded: Loaded, rows: readonly object[]): void {
  const document = { ...(loaded.document ?? { format: TRACKED_FORMAT }), workspaces: rows };
  writeHomeFile(home, TRACKED_FILE, JSON.stringify(document, null, 2) + '\n');
}

/** The tracked rows in file order; none when the file is absent. Refuses a malformed file as `IA-CLI-TRACKED-INVALID`. */
export function readTracked(home: string): readonly TrackedWorkspace[] {
  return load(home).rows.map((entry) => entry.row);
}
export function trackedState(row: TrackedWorkspace): TrackedState {
  return isDirectory(join(row.root, '.ia/src')) ? 'present' : 'missing';
}

/** Lower-cased, every character outside the id rule a `-`, then trimmed so it starts with a letter or digit. */
function slug(text: string): string {
  const id = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 128)
    .replace(/-+$/, '');
  return id === '' ? 'workspace' : id;
}
const DECLARATION = /^@workspace[ \t]+([a-z0-9][a-z0-9-]*)/gm;
const SCANNED_FILES = 200;
/**
 * The `@workspace` name when `.ia/src` declares exactly one at column 0, otherwise the folder name, as an id. A lexical
 * scan of at most 200 `.ia` files in sorted order: no record is admitted, so a broken workspace still gets an id.
 */
export function defaultTrackId(root: string): string {
  const names: string[] = [];
  let scanned = 0;
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= SCANNED_FILES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ia')) {
        scanned += 1;
        try {
          for (const match of readFileSync(path, 'utf8').matchAll(DECLARATION)) names.push(match[1]!);
        } catch {
          /* An unreadable file declares nothing. */
        }
      }
    }
  };
  visit(join(root, '.ia/src'));
  return slug(names.length === 1 ? names[0]! : basename(root));
}

/** The real path of a directory holding `.ia/src`, or `IA-DB-ROOT-INVALID` as root discovery refuses (§1.2). */
function workspaceRoot(directory: string): string {
  const absolute = resolve(directory);
  let real: string | undefined;
  try {
    real = realpathSync(absolute);
  } catch {
    real = undefined;
  }
  if (real === undefined || !isDirectory(join(real, '.ia/src'))) {
    const path = commandPath(absolute),
      preview = 'to see what a new workspace there would contain';
    throw new Refusal(
      'IA-DB-ROOT-INVALID',
      `${absolute} is not a workspace: it holds no .ia/src`,
      3,
      { path: absolute },
      path !== undefined
        ? `Run "ia init ${path}" ${preview}.`
        : `${isDirectory(absolute) ? 'From that directory, run' : 'Create that directory without pasting its path into a shell, enter it, then run'} "ia init ." ${preview}; ${PATH_OMITTED}.`,
    );
  }
  return real;
}

/** Said beside a suggested command that names `.` in place of a path a shell would act on. */
export const PATH_OMITTED = 'its path is omitted because it contains shell syntax';
/**
 * `path` as a suggested command prints it, or undefined when the command must name `.` instead (apps/cli/SPEC.md): a
 * path is printed only when no shell acts on any character of it (`inertCommandRoot`), since double quotes leave `$(…)`
 * and backticks live, and then with forward slashes on win32, so every shell there reads it alike.
 */
export function commandPath(path: string): string | undefined {
  if (!inertCommandRoot(path)) return undefined;
  return quote(process.platform === 'win32' ? path.replaceAll('\\', '/') : path);
}
/** The first `<id>-<n>` no row holds, preferring the folder name when that is free. */
function freeId(taken: ReadonlySet<string>, id: string, root: string): string {
  const folder = slug(basename(root));
  if (!taken.has(folder)) return folder;
  for (let n = 2; ; n += 1) {
    const candidate = `${id.slice(0, 120)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A root `trackWorkspaces` refuses for its id: `other` is the root that holds the id, a tracked row's, or, when `queued`,
 * another root found in the same `find --apply` that would take it first. `suggestion` is the first id left free.
 */
export interface IdClash {
  readonly root: string;
  readonly id: string;
  readonly other: string;
  readonly queued: boolean;
  readonly suggestion: string;
}
/** `IA-CLI-TRACKED-ID` for a clash, worded for a tracked row or a found root; its next command adds the root under another id. */
export function idTaken(home: string, clash: IdClash): Refusal {
  const { root, id, other, queued } = clash,
    remedy = clashRemedy(clash);
  return new Refusal(
    'IA-CLI-TRACKED-ID',
    queued
      ? `Two found workspaces would both take the id ${id}: ${other} and ${root}`
      : `The id ${id} is already tracked for ${other}, so ${root} needs another id, given with --id`,
    3,
    { path: join(home, TRACKED_FILE) },
    `${remedy.before} "${remedy.command}" ${remedy.after}`,
  );
}
/**
 * A clash's remedy, `ia workspaces add` for its root under the suggested id, split around the command so a renderer
 * keeps the command whole. As apps/cli/SPEC.md has every suggested command do, a root is printed only when no shell
 * acts on any character of it (`inertCommandRoot`), with forward slashes on win32 so every shell there reads it alike.
 * Otherwise the command names `.`, run from that workspace's directory, and the root stays in the message as data.
 */
export function clashRemedy(clash: IdClash): {
  readonly before: string;
  readonly command: string;
  readonly after: string;
} {
  const { root, queued, suggestion } = clash,
    path = commandPath(root);
  if (path !== undefined)
    return {
      before: 'Run',
      command: `ia workspaces add ${path} --id ${suggestion}`,
      after: `to track ${queued ? 'one of them' : 'it'} under another id.`,
    };
  return {
    before: `From ${queued ? "the second workspace's directory" : 'the directory of the workspace that needs another id'}, run`,
    command: `ia workspaces add . --id ${suggestion}`,
    after: `to track it under another id; ${PATH_OMITTED}.`,
  };
}
/**
 * The found roots `trackWorkspaces` would refuse, in its order: each root whose id a tracked row holds, or an earlier
 * found root would take. Each suggestion is an id that neither `rows`, any found root nor an earlier suggestion takes, so
 * following every remedy leaves no clash.
 */
export function idClashes(
  rows: readonly TrackedWorkspace[],
  found: readonly { readonly root: string; readonly id: string }[],
): readonly IdClash[] {
  const taken = new Set([...rows, ...found].map((row) => row.id));
  return found.flatMap(({ root, id }, index) => {
    const held = rows.find((row) => row.id === id),
      other = held ?? found.slice(0, index).find((row) => row.id === id);
    if (other === undefined) return [];
    const suggestion = freeId(taken, id, root);
    taken.add(suggestion);
    return [{ root, id, other: other.root, queued: held === undefined, suggestion }];
  });
}

/** The tracked row for `root`, whichever way it is spelled. */
export const trackedRow = (rows: readonly TrackedWorkspace[], root: string): TrackedWorkspace | undefined =>
  rows.find((row) => sameRoot(row.root, root));

/** `--id` against the id rule, as usage (§1.2): the handler runs it before any state is read, the store again as a guard. */
export function checkTrackId(id: string): void {
  if (!TRACK_ID.test(id))
    throw new UsageError(
      `--id must start with a letter or digit and hold only letters, digits, ".", "_" or "-" (at most 128); got ${id}`,
    );
}

type Input = { readonly root: string; readonly id?: string | undefined; readonly label?: string | undefined };
/** One root checked against `rows` and given its row; nothing is written here. */
function admit(
  home: string,
  path: string,
  rows: readonly TrackedWorkspace[],
  input: Input,
  now: Date,
  queued: readonly TrackedWorkspace[] = [],
): { readonly status: 'added' | 'already'; readonly row: TrackedWorkspace } {
  if (input.id !== undefined) checkTrackId(input.id);
  const root = workspaceRoot(input.root);
  // Host plugin distribution spec §3: the IA home holds configuration and state, never a workspace.
  if (within(home, root) || sameRoot(join(root, '.ia'), home))
    throw new Refusal(
      'IA-DIST-PATH-UNSAFE',
      `${root} is inside the IA home ${home}; a workspace there is never tracked`,
      3,
      { path: root },
      `Move the workspace out of the IA home, then run "ia workspaces add <directory>" with its new location.`,
    );
  const held = trackedRow(rows, root);
  if (held !== undefined) {
    if ((input.id !== undefined && input.id !== held.id) || (input.label !== undefined && input.label !== held.label))
      throw new Refusal(
        'IA-CLI-TRACKED-EXISTS',
        `${root} is already tracked as ${held.id}; its id and label are changed only by removing it and adding it again`,
        3,
        { path },
        `Run "ia workspaces remove ${held.id}" first, then add the workspace again with the id or label you want.`,
      );
    return { status: 'already', row: held };
  }
  const id = input.id ?? defaultTrackId(root);
  const other = rows.find((row) => row.id === id);
  if (other !== undefined)
    throw idTaken(home, {
      root,
      id,
      other: other.root,
      queued: queued.includes(other),
      suggestion: freeId(new Set(rows.map((row) => row.id)), id, root),
    });
  return {
    status: 'added',
    row: { id, root, ...(input.label === undefined ? {} : { label: input.label }), added: now.toISOString() },
  };
}

/**
 * Adds one workspace, or reports it `already` tracked with its row unchanged. The root is its real path and must hold
 * `.ia/src` outside the IA home. The id defaults to `defaultTrackId`. A root already tracked under another id or label
 * refuses as `IA-CLI-TRACKED-EXISTS`, and an id another root holds as `IA-CLI-TRACKED-ID`, naming both roots.
 */
export function trackWorkspace(
  home: string,
  input: Input,
  now: Date = new Date(),
): { readonly status: 'added' | 'already'; readonly row: TrackedWorkspace } {
  return withTrackedLock(home, () => {
    const loaded = load(home);
    const result = admit(
      home,
      loaded.path,
      loaded.rows.map((entry) => entry.row),
      input,
      now,
    );
    if (result.status === 'added') save(home, loaded, [...loaded.rows.map((entry) => entry.raw), result.row]);
    return result;
  });
}
/**
 * `ia workspaces find --apply`: every root not yet tracked, under its default id, in one write. Each root is checked as
 * `trackWorkspace` checks it, against the rows before it too, so an id two of them would share refuses before anything
 * is written, naming both as found rather than tracked. Returns the rows added.
 */
export function trackWorkspaces(
  home: string,
  roots: readonly string[],
  now: Date = new Date(),
): readonly TrackedWorkspace[] {
  return withTrackedLock(home, () => {
    const loaded = load(home);
    const rows = loaded.rows.map((entry) => entry.row),
      added: TrackedWorkspace[] = [];
    for (const root of roots) {
      const result = admit(home, loaded.path, rows, { root }, now, added);
      if (result.status === 'already') continue;
      rows.push(result.row);
      added.push(result.row);
    }
    if (added.length > 0) save(home, loaded, [...loaded.rows.map((entry) => entry.raw), ...added]);
    return added;
  });
}

/**
 * Removes the row with this id, or else the row whose root this is, read against `cwd`; a gone root still matches by
 * its spelling. Refuses as `IA-CLI-TRACKED-UNKNOWN` when no row matches.
 */
export function untrackWorkspace(home: string, idOrRoot: string, cwd: string): TrackedWorkspace {
  return withTrackedLock(home, () => {
    const loaded = load(home);
    let index = loaded.rows.findIndex((entry) => entry.row.id === idOrRoot);
    if (index === -1) {
      const root = resolve(cwd, idOrRoot);
      index = loaded.rows.findIndex((entry) => sameRoot(entry.row.root, root));
    }
    if (index === -1)
      throw new Refusal(
        'IA-CLI-TRACKED-UNKNOWN',
        `No tracked workspace has the id or root ${idOrRoot}`,
        3,
        null,
        'Run "ia workspaces list" for the tracked ids and roots.',
      );
    const removed = loaded.rows[index]!.row;
    save(
      home,
      loaded,
      loaded.rows.filter((_, at) => at !== index).map((entry) => entry.raw),
    );
    return removed;
  });
}

/** Never walked into: package installs, git's own folder, and the worktrees `ia` keeps beside a repository. */
const SKIPPED: ReadonlySet<string> = new Set(['node_modules', '.git', '.ia-worktrees']);
/**
 * The workspace roots under `folder`, real paths sorted, to `depth` levels below it (default 4). The walk skips the
 * names in `SKIPPED`, every folder whose name starts with `.`, the IA home, a link or junction, and a folder whose
 * `.git` is a file (a linked worktree or a submodule). It does not descend into a workspace it found, so fixtures
 * inside a repository are not listed. The folder itself is skipped the same way: a link or junction (judged before it
 * is resolved), named with a leading `.` or in `SKIPPED`, inside the IA home, or a linked worktree, it yields nothing.
 * Refuses a folder that is not a directory as `IA-DB-ROOT-INVALID`.
 */
export function findWorkspaces(
  folder: string,
  options: { readonly depth?: number | undefined; readonly iaHome?: string | undefined },
): readonly string[] {
  const depth = options.depth ?? FIND_DEPTH,
    { iaHome } = options;
  const absolute = resolve(folder);
  if (!isDirectory(absolute))
    throw new Refusal(
      'IA-DB-ROOT-INVALID',
      `${absolute} is not a directory`,
      3,
      { path: absolute },
      'Run "ia workspaces find <folder>" with a folder that exists.',
    );
  const home = (path: string): boolean => iaHome !== undefined && sameRoot(path, iaHome);
  // The folder itself is held to the exclusions its children are: asking to look inside one is not a way around them.
  // Its own name and entry are judged before any link is followed, as the walk judges each entry it reads.
  if (isLink(absolute) || basename(absolute).startsWith('.')) return [];
  const start = realpathSync(absolute);
  if ((iaHome !== undefined && within(iaHome, start)) || SKIPPED.has(basename(start)) || isFile(join(start, '.git')))
    return [];
  const found: string[] = [];
  const walk = (directory: string, level: number): void => {
    if (isDirectory(join(directory, '.ia/src')) && !home(join(directory, '.ia'))) {
      found.push(directory);
      return;
    }
    if (level >= depth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // A link or junction is not a directory entry here, so the walk never loops or leaves the folder.
      if (!entry.isDirectory() || SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = join(directory, entry.name);
      if (home(child) || isFile(join(child, '.git'))) continue;
      walk(child, level + 1);
    }
  };
  walk(start, 0);
  return found.sort();
}
