/**
 * The workspace's own installed `@inventarch/cli` and the dependency that pins it: the facts an `ia` needs to hand a
 * command to the copy the workspace chose. Only the filesystem is consulted, so the `ia` bin decides with this module
 * before any command module loads (bin.ts); every read that fails answers `null`. The package manager that installs
 * the copy, which only doctor reports, is package-manager.ts.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface LocalCli {
  readonly packageRoot: string;
  readonly version: string;
  readonly entry: string;
}
export interface CliDependency {
  readonly manifest: string;
  readonly field: 'dependencies' | 'devDependencies';
  readonly range: string;
}

export const CLI = '@inventarch/cli';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly packageManager?: unknown;
  readonly workspaces?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}
/** The `package.json` at `path` when it parses to an object, or `null`. */
export const readManifest = (path: string): Manifest | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** The CLI dependency of the nearest `package.json` at or above `root`; a nearer manifest without one is the answer. */
export function readCliDependency(root: string): CliDependency | null {
  for (let current = resolve(root); ; current = dirname(current)) {
    const manifest = resolve(current, 'package.json');
    if (existsSync(manifest)) {
      const json = readManifest(manifest);
      if (json === null) return null;
      for (const field of ['dependencies', 'devDependencies'] as const) {
        const table = json[field];
        const range = isRecord(table) ? table[CLI] : undefined;
        if (typeof range === 'string') return { manifest, field, range };
      }
      return null;
    }
    if (dirname(current) === current) return null;
  }
}

const binEntry = (bin: unknown): string | null => {
  if (typeof bin === 'string') return bin;
  const ia = isRecord(bin) ? bin['ia'] : undefined;
  return typeof ia === 'string' ? ia : null;
};

/** The first installed copy from `root` up to `stopAt` decides: a valid one, or `null` when that copy is invalid. */
export function findLocalCli(root: string, stopAt: string): LocalCli | null {
  const stop = resolve(stopAt);
  for (let current = resolve(root); ; current = dirname(current)) {
    const dir = resolve(current, 'node_modules/@inventarch/cli');
    if (existsSync(resolve(dir, 'package.json'))) {
      const json = readManifest(resolve(dir, 'package.json'));
      const bin = json === null ? null : binEntry(json.bin);
      if (json === null || json.name !== CLI || typeof json.version !== 'string' || bin === null) return null;
      try {
        const packageRoot = realpathSync(dir);
        const entry = resolve(packageRoot, bin);
        return existsSync(entry) ? { packageRoot, version: json.version, entry } : null;
      } catch {
        return null;
      }
    }
    if (current === stop || dirname(current) === current) return null;
  }
}

/**
 * Whether one glob segment matches one path segment: `*` is any run of characters and every other character is itself.
 * A single pass that, on a mismatch, moves back only to the last `*`, so the work is bounded by the product of the two
 * lengths whatever the stars; a compiled regular expression backtracks exponentially on a run of them.
 */
const segment = (glob: string, name: string): boolean => {
  let g = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (glob[g] === '*') {
      star = g++;
      resume = n;
    } else if (g < glob.length && glob[g] === name[n]) {
      g++;
      n++;
    } else if (star !== -1) {
      g = star + 1;
      n = ++resume;
    } else return false;
  }
  while (glob[g] === '*') g++;
  return g === glob.length;
};
/** Whether `glob` lists `member` segment by segment; adjacent `**` collapse and each (glob, member) pair is solved once. */
const matches = (glob: readonly string[], member: readonly string[]): boolean => {
  const globs = glob.filter((part, index) => part !== '**' || glob[index - 1] !== '**');
  const seen = new Map<number, boolean>();
  const from = (g: number, m: number): boolean => {
    const key = g * (member.length + 1) + m;
    const known = seen.get(key);
    if (known !== undefined) return known;
    const head = globs[g];
    let answer: boolean;
    if (head === undefined) answer = m === member.length;
    else if (head === '**') answer = from(g + 1, m) || (m < member.length && from(g, m + 1));
    else {
      const name = member[m];
      answer = name !== undefined && segment(head, name) && from(g + 1, m + 1);
    }
    seen.set(key, answer);
    return answer;
  };
  return from(0, 0);
};

/** Glob syntax beyond `*`, `**` and `!` (braces, `?` and character classes), which this module does not read. */
const UNSUPPORTED = /[{}?[\]]/;
/**
 * Whether workspace `globs` list `member`, a `/`-separated path relative to the workspace root. Only `*` (any run of
 * characters within one segment), `**` (any number of segments) and a leading `!` (excludes) are read, and the last
 * matching glob decides, as in npm. An entry that uses `{`, `}`, `?`, `[` or `]` is not read: it owns nothing, and an
 * excluding one may exclude any member, so it ends ownership. Either way hand-off falls back to the member's directory.
 */
export function ownsMember(globs: readonly string[], member: string): boolean {
  const path = member.split('/').filter((part) => part !== '' && part !== '.');
  let owned = false;
  for (const raw of globs) {
    const negated = raw.startsWith('!');
    const body = negated ? raw.slice(1) : raw;
    if (UNSUPPORTED.test(body)) {
      if (negated) owned = false;
      continue;
    }
    const parts = body.split('/').filter((part) => part !== '' && part !== '.');
    if (matches(parts, path)) owned = !negated;
  }
  return owned;
}

const AFTER_SCALAR = /^(\s+#.*)?\s*$/;
/**
 * One block-list entry's scalar, or `null` when the form is unsupported (and so owns nothing): a single-quoted scalar
 * (`''` is a quote), a double-quoted one (`\"` and `\` only), or plain text up to a `#` that follows whitespace. An
 * open quote, text after the closing quote, any other escape or a block scalar or flow collection is unsupported.
 */
const pnpmScalar = (text: string): string | null => {
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    let value = '';
    for (let i = 1; i < text.length; i++) {
      const char = text[i] as string;
      if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          value += "'";
          i++;
        } else return AFTER_SCALAR.test(text.slice(i + 1)) ? value : null;
      } else if (char === '\\' && quote === '"') {
        const next = text[++i];
        if (next !== '"' && next !== '\\') return null;
        value += next;
      } else value += char;
    }
    return null;
  }
  if (/^[|>[{&*]/.test(text)) return null;
  return text.replace(/(^|\s)#.*$/, '').trimEnd();
};

/**
 * The `packages:` block list of a `pnpm-workspace.yaml`, scanned by line (no YAML parser: bin.ts stays cheap). An entry
 * in a form the scanner does not read, such as a plain scalar continued on a more-indented line, is dropped whole.
 */
export const pnpmPackages = (text: string): string[] => {
  const globs: string[] = [];
  let inside = false;
  let entry: { indent: number; index: number | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (entry !== null && indent > entry.indent) {
      if (entry.index !== null) globs.splice(entry.index, 1);
      entry.index = null;
      continue;
    }
    entry = null;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (inside && item?.[2] !== undefined) {
      const glob = pnpmScalar(item[2].trimStart());
      entry = { indent: (item[1] as string).length, index: glob === null || glob === '' ? null : globs.push(glob) - 1 };
    } else if (indent === 0) inside = /^packages\s*:\s*(#.*)?$/.test(line);
  }
  return globs;
};

/**
 * The workspace globs `directory` declares, or `null` when it is not a package-manager workspace root. A
 * `pnpm-workspace.yaml` that exists but cannot be read still marks a root, one that lists nothing.
 */
const workspaceGlobs = (directory: string): string[] | null => {
  const pnpm = resolve(directory, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      return pnpmPackages(readFileSync(pnpm, 'utf8'));
    } catch {
      return [];
    }
  }
  const declared = readManifest(resolve(directory, 'package.json'))?.workspaces;
  const list = Array.isArray(declared) ? declared : isRecord(declared) ? declared['packages'] : undefined;
  return Array.isArray(list) ? list.filter((glob): glob is string => typeof glob === 'string') : null;
};

/**
 * The directory that owns the install for the package at `manifestDirectory`: the nearest directory, itself included,
 * that is a package-manager workspace root (`pnpm-workspace.yaml` or `package.json` `workspaces`). A package that is
 * itself a root owns its install; an ancestor root owns it when its globs list the package, since npm, Yarn and Bun
 * hoist the copy there; otherwise `manifestDirectory`. Only that nearest root is consulted, and nothing above it is the
 * repository's.
 */
export function installRoot(manifestDirectory: string): string {
  const member = resolve(manifestDirectory);
  for (let current = member; ; current = dirname(current)) {
    const globs = workspaceGlobs(current);
    if (globs !== null) {
      return current === member || !ownsMember(globs, relative(current, member).replaceAll('\\', '/'))
        ? member
        : current;
    }
    if (dirname(current) === current) return member;
  }
}
