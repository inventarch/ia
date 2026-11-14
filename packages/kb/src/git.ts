import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { portablePath } from '@inventarch/workspace-runtime/resource-format';
import { commitId, fail, hash, LIMITS } from './format.js';
export function committedReader(repository: string, commit: string, timeout = 10000) {
  commitId(commit);
  if (typeof repository !== 'string' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
    fail('Invalid repository timeout or root');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  /** Repository failures and discovery overflow are operational; selected blob limits are request refusals. */
  const git = (args: string[], blob = false, input?: string, maxBuffer = OUTPUT_LIMIT): Buffer => {
    try {
      return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', repository, ...args], {
        maxBuffer,
        timeout,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
        windowsHide: true,
        env,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOBUFS')
        return fail(
          blob ? 'Selected file byte limit exceeded' : 'Repository output byte limit exceeded',
          blob ? 'IA-KB-INVALID' : 'IA-KB-SOURCE-UNAVAILABLE',
        );
      return fail('Selected committed data unavailable or repository command timed out', 'IA-KB-SOURCE-UNAVAILABLE');
    }
  };
  const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const bare = git(['rev-parse', '--is-bare-repository']).toString('utf8').trim() === 'true';
  const declaredRoot = git(['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'])
    .toString('utf8')
    .trim();
  if (fold(realpathSync(repository)) !== fold(realpathSync(declaredRoot)))
    fail('Repository must be its Git working-tree or bare repository root');
  // Batch mode distinguishes a missing object from a failed Git process without parsing localized stderr.
  if (
    git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], false, commit + '\n')
      .toString('utf8')
      .trim() !==
    commit + ' commit'
  )
    fail('Exact existing commit required');
  const read = (path: string) => {
    portablePath(path);
    const rows = git(['ls-tree', '-z', commit, '--', path]).toString('utf8').split('\0').filter(Boolean);
    if (rows.length !== 1 || !rows[0]!.endsWith('\t' + path) || !rows[0]!.startsWith('100644 blob '))
      fail('Selected committed regular non-executable blob unavailable');
    const blob = /^100644 blob ([a-f0-9]{40,64})\t/.exec(rows[0]!)?.[1];
    if (!blob) return fail('Selected committed blob identity unavailable');
    const raw = git(['cat-file', 'blob', blob], true);
    if (raw.length > LIMITS.fileBytes) fail('Selected file byte limit exceeded');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return fail('Selected blob is not UTF-8');
    }
    return { path, text, bytes: raw.length, sha256: hash(raw) };
  };
  /**
   * Every entry under `.ia/src` with its mode, type, id and size, from one listing. The listing is longer than the
   * name-only one this replaced, so it reads with a larger buffer and then refuses exactly when the name-only output
   * would have overflowed its own: the same trees refuse, and no other tree does. Sizes need every blob's object, so a
   * repository missing one (a partial clone, a damaged store) makes the long listing fail where the name-only one did
   * not; then the reader lists names only, as before, and `readMany` reads path by path (`listed` is null).
   */
  let listed: Map<string, readonly Row[]> | null | undefined;
  let names: string[] | undefined;
  const listing = () => {
    if (listed === undefined) {
      let rows: Row[] | undefined;
      try {
        rows = parseRows(git(['ls-tree', '-rlz', commit, '--', '.ia/src'], false, undefined, OUTPUT_LIMIT * 12));
      } catch {
        rows = undefined;
      }
      if (rows === undefined) {
        names = git(['ls-tree', '-rz', '--name-only', commit, '--', '.ia/src']).toString('utf8').split('\0');
        listed = null;
      } else {
        let nameBytes = 0;
        for (const row of rows) nameBytes += row.bytes + 1;
        if (nameBytes > OUTPUT_LIMIT) fail('Repository output byte limit exceeded', 'IA-KB-SOURCE-UNAVAILABLE');
        listed = byPath(rows);
        names = rows.map((row) => row.path);
      }
    }
    return { listed, names: names! };
  };
  const nativePaths = () => {
    const paths = listing().names.filter(
      (path) => path.startsWith('.ia/src/') && path.endsWith('.ia') && !path.startsWith('.ia/src/floor/'),
    );
    if (paths.length > 2000) fail('Native discovery file limit exceeded');
    return paths;
  };
  /**
   * Reads many paths with one listing (for paths outside `.ia/src`, a listing with path arguments) and one
   * `cat-file --batch`, instead of two processes per path. It returns one function per path, in order; calling it
   * returns what `read(path)` would return, or throws what it would throw. Paths are checked in order, and only the
   * prefix up to the first faulty path, or up to and including the one whose bytes carry the running total past
   * `budget`, is fetched: a caller that refuses there never pays for the rest, and any later path falls back to `read`.
   * If a listing or the batch read itself fails, every path is read on its own, so a missing object refuses where and
   * as it always did, after any earlier path's own refusal.
   */
  const readMany = (paths: readonly string[], budget = Number.POSITIVE_INFINITY): (() => File)[] => {
    const perPath = () => paths.map((path) => () => read(path));
    const native = listing().listed;
    if (native === null) return perPath();
    const portable = (path: string) => {
      try {
        portablePath(path);
        return true;
      } catch {
        return false;
      }
    };
    // A path portablePath refuses is never handed to Git; the loop below reports it, in order.
    const outside = [...new Set(paths.filter((path) => !native.has(path) && portable(path)))];
    let other: Map<string, readonly Row[]>;
    try {
      other = outside.length === 0 ? new Map<string, readonly Row[]>() : listPaths(outside);
    } catch {
      return perPath();
    }
    const fetch: Row[] = [];
    let fault: { index: number; error: unknown } | undefined;
    let total = 0;
    for (const [index, path] of paths.entries()) {
      try {
        portablePath(path);
        const rows = native.get(path) ?? other.get(path) ?? [];
        if (rows.length !== 1 || rows[0]!.mode !== '100644' || rows[0]!.type !== 'blob')
          fail('Selected committed regular non-executable blob unavailable');
        if (rows[0]!.size > LIMITS.fileBytes) fail('Selected file byte limit exceeded');
        fetch.push(rows[0]!);
        total += rows[0]!.size;
        if (total > budget) break;
      } catch (error) {
        fault = { index, error };
        break;
      }
    }
    let blobs: Buffer[];
    try {
      blobs = batch(fetch);
    } catch {
      return perPath();
    }
    return paths.map((path, index) => () => {
      if (index < fetch.length) return file(path, blobs[index]!);
      if (fault !== undefined && index === fault.index) throw fault.error;
      return read(path);
    });
  };
  /** Paths outside `.ia/src`, listed with path arguments, in command lines short enough for every platform. */
  const listPaths = (paths: readonly string[]) => {
    const rows: Row[] = [];
    let chunk: string[] = [],
      length = 0;
    const flush = () => {
      if (chunk.length > 0) rows.push(...parseRows(git(['ls-tree', '-lz', commit, '--', ...chunk])));
      chunk = [];
      length = 0;
    };
    for (const path of paths) {
      if (length + path.length + 1 > COMMAND_CHARS) flush();
      chunk.push(path);
      length += path.length + 1;
    }
    flush();
    return byPath(rows);
  };
  /** One `cat-file --batch` for every row, in order; a missing object is as unavailable as a failed process. */
  const batch = (rows: readonly Row[]): Buffer[] => {
    if (rows.length === 0) return [];
    let expected = 1024;
    for (const row of rows) expected += row.size + 128;
    const out = git(['cat-file', '--batch'], true, rows.map((row) => row.id).join('\n') + '\n', expected);
    const blobs: Buffer[] = [];
    let at = 0;
    for (const row of rows) {
      const end = out.indexOf(0x0a, at);
      const header = end < 0 ? '' : out.subarray(at, end).toString('utf8');
      if (header !== `${row.id} blob ${row.size}`)
        fail('Selected committed data unavailable or repository command timed out', 'IA-KB-SOURCE-UNAVAILABLE');
      blobs.push(out.subarray(end + 1, end + 1 + row.size));
      at = end + 1 + row.size + 1;
    }
    return blobs;
  };
  const file = (path: string, raw: Buffer): File => {
    if (raw.length > LIMITS.fileBytes) fail('Selected file byte limit exceeded');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return fail('Selected blob is not UTF-8');
    }
    return { path, text, bytes: raw.length, sha256: hash(raw) };
  };
  return { read, readMany, nativePaths };
}

/** One git call's output limit, as before; the per-file blob limit plus room for Git's framing. */
const OUTPUT_LIMIT = LIMITS.fileBytes + 1024;
/** Characters of path arguments per listing, well inside Windows' 32,767-character command line. */
const COMMAND_CHARS = 16_000;
export interface File {
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Row {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
  readonly size: number;
  readonly path: string;
  /** The path's length in bytes, as Git wrote it. */
  readonly bytes: number;
  /** Whether `path` spells the path's bytes exactly: false when they are not UTF-8 and `path` is their lossy decoding. */
  readonly exact: boolean;
}
/**
 * `ls-tree -lz` rows: `<mode> SP <type> SP <id> SP+ <size or -> TAB <path>`, each ended by NUL. A Git path is bytes. One
 * that is not UTF-8 keeps the lossy name a name-only listing gives it, but is not `exact`, so its blob is never fetched
 * under that name: reading the name gives what reading it path by path gives, a refusal unless another path really has
 * that name.
 */
function parseRows(out: Buffer): Row[] {
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
    rows: Row[] = [];
  for (let at = 0; at < out.length; ) {
    const nul = out.indexOf(0, at),
      end = nul < 0 ? out.length : nul,
      entry = out.subarray(at, end);
    at = end + 1;
    if (entry.length === 0) continue;
    const tab = entry.indexOf(0x09),
      match =
        tab < 0 ? null : /^(\d{6}) (\w+) ([a-f0-9]{40,64}) +(-|\d+)$/.exec(entry.subarray(0, tab).toString('utf8'));
    if (!match) return fail('Selected committed blob identity unavailable');
    const name = entry.subarray(tab + 1);
    let path: string,
      exact = true;
    try {
      path = strict.decode(name);
    } catch {
      path = name.toString('utf8');
      exact = false;
    }
    rows.push({
      mode: match[1]!,
      type: match[2]!,
      id: match[3]!,
      size: match[4] === '-' ? 0 : Number(match[4]),
      path,
      bytes: name.length,
      exact,
    });
  }
  return rows;
}
/** The rows by path. A row whose path is not `exact` is left out, so its lossy name is looked up as `read` looks it up. */
function byPath(rows: readonly Row[]): Map<string, readonly Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.exact) continue;
    const list = map.get(row.path) ?? [];
    list.push(row);
    map.set(row.path, list);
  }
  return map;
}
