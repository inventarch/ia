/**
 * The tracked list: docs/specs/consumer-cli-contract/README.md §2.16. `<IA home>/tracked-workspaces.json` is one
 * person's list of the workspaces they keep current, `{format: 'ia-tracked-workspaces-1', workspaces: [{id, root,
 * label?, added}]}`. It is not the MCP door's `workspace-locations.json`, which this module never reads or writes:
 * tracking a workspace admits nothing to the door.
 *
 * Every write goes through `writeHomeFile` (atomic, fsynced) and keeps the keys it does not know, at the top level and
 * on each row, so a hand-edited file survives. A file that does not parse, or names another format, is refused as
 * `IA-CLI-TRACKED-INVALID` and never overwritten. A root is stored as its real path and compared by device and inode
 * (`sameFile`), so a junction, a trailing separator or another case on Windows is the same row. A row whose root is gone
 * stays in the list as `missing` until it is removed by name.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathKey, sameFile, within } from '@inventarch/db/internal/paths';
import { readHomeFile, writeHomeFile } from '@inventarch/distribution/ia-home';
import { UsageError } from './args.js';
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
const isFile = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
};
/** One root, whichever way it is spelled: by device and inode while it exists, by its folded spelling once it is gone. */
const sameRoot = (a: string, b: string): boolean => sameFile(a, b) || pathKey(resolve(a)) === pathKey(resolve(b));

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
  if (real === undefined || !isDirectory(join(real, '.ia/src')))
    throw new Refusal(
      'IA-DB-ROOT-INVALID',
      `${absolute} is not a workspace: it holds no .ia/src`,
      3,
      { path: absolute },
      `Run "ia init ${quote(absolute)}" to see what a new workspace there would contain.`,
    );
  return real;
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
 * Adds one workspace, or reports it `already` tracked with its row unchanged. The root is its real path and must hold
 * `.ia/src` outside the IA home. The id defaults to `defaultTrackId`. A root already tracked under another id or label
 * refuses as `IA-CLI-TRACKED-EXISTS`, and an id another root holds as `IA-CLI-TRACKED-ID`, naming both roots.
 */
export function trackWorkspace(
  home: string,
  input: { readonly root: string; readonly id?: string | undefined; readonly label?: string | undefined },
  now: Date = new Date(),
): { readonly status: 'added' | 'already'; readonly row: TrackedWorkspace } {
  if (input.id !== undefined && !TRACK_ID.test(input.id))
    throw new UsageError(
      `--id must start with a letter or digit and hold only letters, digits, ".", "_" or "-" (at most 128); got ${input.id}`,
    );
  const root = workspaceRoot(input.root);
  // Host plugin distribution spec §3: the IA home holds configuration and state, never a workspace.
  if (within(home, root) || sameFile(join(root, '.ia'), home))
    throw new Refusal(
      'IA-DIST-PATH-UNSAFE',
      `${root} is inside the IA home ${home}; a workspace there is never tracked`,
      3,
      { path: root },
      `Move the workspace out of the IA home, then run "ia workspaces add <directory>" with its new location.`,
    );
  const loaded = load(home);
  const held = loaded.rows.find((entry) => sameRoot(entry.row.root, root))?.row;
  if (held !== undefined) {
    if ((input.id !== undefined && input.id !== held.id) || (input.label !== undefined && input.label !== held.label))
      throw new Refusal(
        'IA-CLI-TRACKED-EXISTS',
        `${root} is already tracked as ${held.id}; its id and label are changed only by removing it and adding it again`,
        3,
        { path: loaded.path },
        `Run "ia workspaces remove ${held.id}" first, then add the workspace again with the id or label you want.`,
      );
    return { status: 'already', row: held };
  }
  const id = input.id ?? defaultTrackId(root);
  const other = loaded.rows.find((entry) => entry.row.id === id)?.row;
  if (other !== undefined) {
    const suggestion = freeId(new Set(loaded.rows.map((entry) => entry.row.id)), id, root);
    throw new Refusal(
      'IA-CLI-TRACKED-ID',
      `The id ${id} is already tracked for ${other.root}, so ${root} needs another id, given with --id`,
      3,
      { path: loaded.path },
      `Run "ia workspaces add ${quote(root)} --id ${suggestion}" to track it under another id.`,
    );
  }
  const row: TrackedWorkspace = {
    id,
    root,
    ...(input.label === undefined ? {} : { label: input.label }),
    added: now.toISOString(),
  };
  save(home, loaded, [...loaded.rows.map((entry) => entry.raw), row]);
  return { status: 'added', row };
}

/**
 * Removes the row with this id, or else the row whose root this is, read against `cwd`; a gone root still matches by
 * its spelling. Refuses as `IA-CLI-TRACKED-UNKNOWN` when no row matches.
 */
export function untrackWorkspace(home: string, idOrRoot: string, cwd: string): TrackedWorkspace {
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
}

/** Never walked into: package installs, git's own folder, and the worktrees `ia` keeps beside a repository. */
const SKIPPED: ReadonlySet<string> = new Set(['node_modules', '.git', '.ia-worktrees']);
/**
 * The workspace roots under `folder`, real paths sorted, to `depth` levels below it (default 4). The walk skips the
 * names in `SKIPPED`, every folder whose name starts with `.`, the IA home, a link or junction, and a folder whose
 * `.git` is a file (a linked worktree or a submodule). It does not descend into a workspace it found, so fixtures
 * inside a repository are not listed. Refuses a folder that is not a directory as `IA-DB-ROOT-INVALID`.
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
  const home = (path: string): boolean => iaHome !== undefined && sameFile(path, iaHome);
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
  walk(realpathSync(absolute), 0);
  return found.sort();
}
