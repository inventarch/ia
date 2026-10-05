/**
 * The runtime both shell analyzers share (#540): bounds, the working directory and variables a command line sets as it goes,
 * glob expansion, and the `Io` each native command sees. An analyzer parses its language and reports effects through
 * a `Session`; `main.ts` places each written path with the file-tool rules.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Unresolved } from './commands.js';
import type { Arg, Io, Target } from './commands.js';

export const LIMITS = Object.freeze({
  depth: 32,
  words: 65_536,
  paths: 4_096,
  globEntries: 10_000,
  reads: 16,
  readBytes: 1024 * 1024,
});
export type Language = 'bash' | 'powershell';
export interface Scope {
  readonly route: 'Bash' | 'PowerShell';
  /** The fixed project root, as the guard opened it. */
  readonly root: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Where a word lands from `cwd`: an absolute word as written, a relative one from the directory as the kernel finds it. */
  resolve(cwd: string, word: string): string;
}
/**
 * A variable as far as the guard can see it: its text when known; each text it takes when it ranges over known words (a `for`
 * loop over literals or a glob); else the paths its value was built from.
 */
export interface Variable {
  readonly value: string | undefined;
  readonly names: readonly Target[];
  readonly values?: readonly string[] | undefined;
}
/** What a command line has set so far. A subshell or command substitution works on a copy (`fork`). */
export class State {
  constructor(
    public cwd: string | undefined,
    public previous: string | undefined = undefined,
    public stack: (string | undefined)[] = [],
    public vars = new Map<string, Variable>(),
  ) {}
  fork(): State {
    return new State(this.cwd, this.previous, [...this.stack], new Map(this.vars));
  }
}
/** The analyzers each language registers with a session (avoids an import cycle). */
export type Analyzer = (text: string, session: Session, state: State, depth: number) => void;

export class Session {
  readonly writes: Target[] = [];
  readonly code: { readonly text: string; readonly cwd: string | undefined; readonly writes: boolean }[] = [];
  private words = 0;
  private globEntries = 0;
  private reads = 0;
  constructor(
    readonly scope: Scope,
    readonly analyzers: Readonly<Record<Language, Analyzer>>,
  ) {}
  fail(detail: string): never {
    throw new Unresolved(detail);
  }
  /** Counts one parsed word against the bound shared by every nested analysis of this event. */
  word(): void {
    if (++this.words > LIMITS.words) this.fail(`has more than ${LIMITS.words} words`);
  }
  /** Bounds nesting: subshells, substitutions, blocks and nested shells all count. */
  enter(depth: number): number {
    if (depth + 1 > LIMITS.depth) this.fail(`nests deeper than ${LIMITS.depth} levels`);
    return depth + 1;
  }
  analyze(language: Language, text: string, state: State, depth: number): void {
    this.analyzers[language](text, this, state, this.enter(depth));
  }
  /** A known variable or environment value; HOME, PWD, OLDPWD and CLAUDE_PROJECT_DIR follow the command line. */
  variable(state: State, name: string): Variable | undefined {
    const own = state.vars.get(name);
    if (own) return own;
    const known = (value: string | undefined): Variable | undefined =>
      value === undefined ? undefined : { value, names: [] };
    switch (name) {
      case 'HOME':
      case 'USERPROFILE':
        return known(this.scope.home);
      case 'PWD':
        return known(state.cwd);
      case 'OLDPWD':
        return known(state.previous);
      case 'CLAUDE_PROJECT_DIR':
        return known(this.scope.root);
      case 'TMPDIR':
      case 'TEMP':
      case 'TMP':
        return known(process.env[name]);
      default:
        return undefined;
    }
  }
  /** The work tree git acts on from `cwd`: the nearest ancestor holding `.git`, else `cwd`. */
  worktree(cwd: string): string {
    for (let current = cwd; ; current = dirname(current)) {
      try {
        lstatSync(join(current, '.git'));
        return current;
      } catch {
        /* keep looking */
      }
      if (dirname(current) === current) return cwd;
    }
  }
  /** A bounded, descriptor-checked read of a data file (a patch); undefined when it is not one readable regular file. */
  read(path: string): string | undefined {
    if (++this.reads > LIMITS.reads) this.fail(`reads more than ${LIMITS.reads} files`);
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > LIMITS.readBytes) return undefined;
      const buffer = Buffer.alloc(stat.size);
      let size = 0;
      while (size < buffer.length) {
        const read = readSync(fd, buffer, size, buffer.length - size, null);
        if (read === 0) break;
        size += read;
      }
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, size));
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  /** Expands one wildcard pattern as bash does (no match: the pattern stays as written), within the shared entry bound. */
  glob(pattern: string, cwd: string, caseless = false): string[] {
    const absolute = isAbsolute(pattern.replaceAll('\\', '/')) || /^[A-Za-z]:[\\/]/.test(pattern);
    const parts = pattern.split(this.scope.platform === 'win32' ? /[\\/]/ : '/');
    let current = [absolute ? (/^[A-Za-z]:/.test(pattern) ? pattern.slice(0, 2) + sep : sep) : cwd];
    for (const part of parts.slice(absolute ? 1 : 0)) {
      if (part === '' || part === '.') continue;
      if (!/(?<!\\)[*?[]/.test(part)) {
        current = current.map((dir) => join(dir, part.replace(/\\(.)/g, '$1')));
        continue;
      }
      // `**` (zsh, and bash with globstar) matches any depth of directories not starting with a dot, itself included.
      if (part === '**') {
        const deep: string[] = [];
        const walk = (dir: string): void => {
          deep.push(dir);
          let entries: Dirent[];
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          this.globEntries += entries.length;
          if (this.globEntries > LIMITS.globEntries) this.fail(`expands a glob past ${LIMITS.globEntries} entries`);
          for (const entry of entries)
            if (entry.isDirectory() && !entry.name.startsWith('.')) walk(join(dir, entry.name));
        };
        current.forEach(walk);
        current = deep;
        continue;
      }
      const matcher = wildcard(part, caseless),
        next: string[] = [];
      for (const dir of current) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        this.globEntries += names.length;
        if (this.globEntries > LIMITS.globEntries) this.fail(`expands a glob past ${LIMITS.globEntries} entries`);
        for (const name of names.sort()) if (matcher.test(name)) next.push(join(dir, name));
      }
      current = next;
      if (!current.length) return [pattern.replace(/\\(.)/g, '$1')];
    }
    return current;
  }
  /** The `Io` one native command sees: its directory and variables from `state`, its input from its redirections. */
  io(
    state: State,
    depth: number,
    input: { readonly text?: string | undefined; readonly file?: Arg | undefined } = {},
  ): Io {
    const session = this,
      scope = this.scope;
    const build = (cwd: () => string | undefined): Io => ({
      paths(arg, tree) {
        if (arg.value === undefined) return arg.names.map((name) => ({ path: name.path, tree: true }));
        const base = cwd(),
          values =
            arg.pattern !== undefined && base !== undefined
              ? session.glob(arg.pattern, base, scope.route === 'PowerShell' && scope.platform === 'win32')
              : [arg.value];
        const out: Target[] = [];
        for (const value of values) {
          const spelled = native(value, scope.platform);
          if (isAbsolute(spelled)) {
            out.push({ path: resolve(spelled), tree });
            continue;
          }
          if (base === undefined) return undefined;
          out.push({ path: scope.resolve(base, spelled), tree });
        }
        return out;
      },
      write(targets) {
        session.writes.push(...targets);
      },
      code(text, writes = false) {
        session.code.push({ text, cwd: cwd(), writes });
      },
      shell(language, text) {
        session.analyze(language, text, state.fork(), depth);
      },
      cwd,
      chdir(mode, operand) {
        const from = state.cwd;
        let next: string | undefined;
        if (mode === 'popd') {
          next = state.stack.length ? state.stack.pop() : undefined;
        } else if (operand === undefined) next = scope.home;
        else if (operand.value === '-') next = state.previous;
        else if (operand.value === undefined) next = undefined;
        else {
          const spelled = native(operand.value, scope.platform);
          next = isAbsolute(spelled) ? resolve(spelled) : from === undefined ? undefined : resolve(from, spelled);
        }
        if (mode === 'pushd') state.stack.push(from);
        state.previous = from;
        state.cwd = next;
      },
      at(other) {
        return build(() => other);
      },
      input: () => input.text,
      inputFile: () => input.file,
      read: (path) => session.read(path),
      exists(path) {
        try {
          lstatSync(path);
          return true;
        } catch {
          return false;
        }
      },
      isDirectory(path) {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      },
      worktree: (dir) => session.worktree(dir),
    });
    return build(() => state.cwd);
  }
}
/** A Git Bash spelling of a Windows drive path (`/c/x`) as Windows spells it; other words as written. */
export function native(word: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return word;
  const drive = /^\/([A-Za-z])(?:\/|$)(.*)$/.exec(word);
  return drive ? `${drive[1]!.toUpperCase()}:\\${drive[2]!.replaceAll('/', '\\')}` : word;
}
/** One path segment's wildcard as a regular expression: `*`, `?` and `[…]`; a leading dot must be matched explicitly. */
function wildcard(part: string, caseless: boolean): RegExp {
  let source = '';
  for (let at = 0; at < part.length; at++) {
    const c = part[at]!;
    if (c === '\\' && at + 1 < part.length) {
      source += part[++at]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      continue;
    }
    if (c === '*') {
      source += at === 0 ? '(?!\\.)[^/]*' : '[^/]*';
      continue;
    }
    if (c === '?') {
      source += at === 0 ? '(?!\\.)[^/]' : '[^/]';
      continue;
    }
    if (c === '[') {
      const end = part.indexOf(']', at + 2);
      if (end > 0) {
        const body = part
          .slice(at + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${body}]`;
        at = end;
        continue;
      }
    }
    source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseless ? 'i' : '');
}
/** Bash brace expansion of the first `{a,b}` group, recursively, bounded to 64 results. */
export function braces(value: string): string[] {
  const open = value.indexOf('{');
  if (open < 0) return [value];
  let depth = 0,
    close = -1;
  const commas: number[] = [];
  for (let at = open; at < value.length; at++) {
    const c = value[at];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      close = at;
      break;
    } else if (c === ',' && depth === 1) commas.push(at);
  }
  if (close < 0 || !commas.length) return [value];
  const bounds = [open, ...commas, close],
    out: string[] = [];
  for (let at = 0; at + 1 < bounds.length && out.length < 64; at++)
    out.push(...braces(value.slice(0, open) + value.slice(bounds[at]! + 1, bounds[at + 1]!) + value.slice(close + 1)));
  return out.slice(0, 64);
}
