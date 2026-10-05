/**
 * What a command's words do to files, for the steward guard's shell routes (#540). `shell.ts` (Bash) and `powershell.ts`
 * expand each word as far as its text allows and hand a native command's words to `native`. Nothing here runs a command or
 * follows its data: a path a program works out while it runs stays unseen (SPEC H07).
 */
import { basename, join } from 'node:path';

/** A path a command writes; `tree` when the write reaches everything under it (recursive, or a directory's contents). */
export interface Target {
  readonly path: string;
  readonly tree: boolean;
}
/**
 * One word as far as the guard can see it. `value` is its text when every part is known. `pattern` is set when unquoted
 * wildcards remain, with quoted wildcard characters escaped by a backslash. `names` are the paths that the unknown parts
 * name (a command substitution's operands, or a variable assigned from one).
 */
export interface Arg {
  readonly raw: string;
  readonly value: string | undefined;
  readonly pattern?: string | undefined;
  readonly names: readonly Target[];
}
/** The analyzer's side of one command: its working directory, input and where its effects go. */
export interface Io {
  /** The absolute paths a word stands for, globs expanded; undefined when it is relative and the directory is unknown. */
  paths(arg: Arg, tree: boolean): readonly Target[] | undefined;
  write(targets: readonly Target[]): void;
  /** Code text whose protected paths count as written when it calls a file-writing function; `writes` when that is already known. */
  code(text: string, writes?: boolean): void;
  /** Code in a shell language, analyzed in turn. */
  shell(language: 'bash' | 'powershell', text: string): void;
  cwd(): string | undefined;
  /** `cd`, `pushd`, `popd` (or Set-Location, Push-Location, Pop-Location) with their operand. */
  chdir(mode: 'cd' | 'pushd' | 'popd', operand: Arg | undefined): void;
  /** The same command acting from another directory (`git -C`). */
  at(cwd: string | undefined): Io;
  /** Literal text fed to standard input (a here-document or here-string), if any. */
  input(): string | undefined;
  /** A file redirected to standard input (`< file`), if any. */
  inputFile(): Arg | undefined;
  /** A bounded read of a file the command reads as data (a patch); undefined when it cannot be read. */
  read(path: string): string | undefined;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** The work tree a git command acts on: the nearest ancestor holding `.git`, else the directory itself. */
  worktree(cwd: string): string;
}
/** A refusal to analyze: the command text cannot be judged within the guard's bounds. The message completes "<route> command …". */
export class Unresolved extends Error {}
/** How a command treats files: a reader writes nothing, the others may write what they name (`opaque`: anything it runs). */
export type Kind = 'read' | 'write' | 'code' | 'opaque';
type Handler = (args: readonly Arg[], io: Io, name: string) => Kind;

export const UNKNOWN_CWD = 'writes a relative path after cd to a location the guard cannot resolve';
export const literal = (value: string): Arg => ({ raw: value, value, names: [] });

/** The program a command word names: its file name in lower case, without a Windows executable suffix. */
export function program(arg: Arg | undefined): string | undefined {
  const value = arg?.value;
  return value
    ? basename(value.replaceAll('\\', '/'))
        .replace(/\.(?:exe|cmd|bat|com)$/i, '')
        .toLowerCase()
    : undefined;
}

interface Parsed {
  readonly operands: readonly Arg[];
  readonly options: ReadonlyMap<string, Arg | true>;
}
/** Operands after POSIX-style options; `valued` options take the next word or an attached value (`-tDIR`, `--x=v`). */
export function operands(args: readonly Arg[], valued: ReadonlySet<string> = new Set()): Parsed {
  const out: Arg[] = [],
    options = new Map<string, Arg | true>();
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!,
      value = arg.value;
    if (value === '--') {
      out.push(...args.slice(at + 1));
      break;
    }
    if (value === undefined || value.length < 2 || !value.startsWith('-')) {
      out.push(arg);
      continue;
    }
    const eq = value.indexOf('=');
    if (value.startsWith('--')) {
      if (eq > 0) options.set(value.slice(0, eq), literal(value.slice(eq + 1)));
      else if (valued.has(value)) {
        const next = args[++at];
        if (next) options.set(value, next);
      } else options.set(value, true);
      continue;
    }
    if (valued.has(value)) {
      const next = args[++at];
      if (next) options.set(value, next);
      continue;
    }
    const short = value.slice(0, 2);
    if (valued.has(short)) {
      options.set(short, literal(value.slice(2)));
      continue;
    }
    for (const flag of value.slice(1)) options.set('-' + flag, true);
  }
  return { operands: out, options };
}
const optionValue = (option: Arg | true | undefined): Arg | undefined => (option === true ? undefined : option);
const recursive = (options: ReadonlyMap<string, unknown>): boolean =>
  ['-r', '-R', '--recursive', '-a', '--archive'].some((flag) => options.has(flag));

/** Writes every word as a path; a relative path with no known working directory cannot be placed. */
export function each(io: Io, args: readonly Arg[], tree: boolean): void {
  for (const arg of args) {
    const targets = io.paths(arg, tree);
    if (targets === undefined) throw new Unresolved(UNKNOWN_CWD);
    io.write(targets);
  }
}
/** A command whose behavior the guard cannot see: every word that names a path, and its working directory, count as written. */
export function opaque(args: readonly Arg[], io: Io): Kind {
  for (const arg of args) {
    const value = arg.value,
      option = value === undefined ? undefined : /^--?[A-Za-z][\w-]*[=:](.+)$/.exec(value);
    const targets = io.paths(option ? literal(option[1]!) : arg, false);
    if (targets) io.write(targets);
  }
  const cwd = io.cwd();
  if (cwd !== undefined) io.write([{ path: cwd, tree: false }]);
  return 'opaque';
}

/** Paths a unified or git patch changes, as written in it. */
export function patchTargets(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const git = /^diff --git (\S+) (\S+)$/.exec(line),
      file = /^(?:---|\+\+\+) (?!\/dev\/null)("?)(.+?)\1(?:\t.*)?$/.exec(line),
      named = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    for (const path of git ? [git[1]!, git[2]!] : file ? [file[2]!] : named ? [named[1]!] : []) out.add(path);
  }
  return [...out];
}
/** Every spelling of a patch path after stripping leading components (`-p0`, `-p1`, …), so any strip level is covered. */
function stripped(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, at) => parts.slice(at).join('/'));
}
function patchWrites(io: Io, text: string, root: string): void {
  for (const path of patchTargets(text))
    for (const spelling of stripped(path)) io.write([{ path: join(root, spelling), tree: false }]);
}
function readArg(io: Io, arg: Arg | undefined): string | undefined {
  if (arg === undefined) return undefined;
  const paths = io.paths(arg, false);
  return paths?.length === 1 ? io.read(paths[0]!.path) : undefined;
}

const READS = [
  'cat',
  'tac',
  'nl',
  'head',
  'tail',
  'less',
  'more',
  'most',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'wc',
  'ls',
  'dir',
  'vdir',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'diff',
  'diff3',
  'sdiff',
  'cmp',
  'comm',
  'cut',
  'tr',
  'paste',
  'join',
  'fold',
  'fmt',
  'column',
  'expand',
  'unexpand',
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'rg',
  'ag',
  'ack',
  'fd',
  'fdfind',
  'jq',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  '[[',
  ':',
  'which',
  'type',
  'whereis',
  'hash',
  'date',
  'id',
  'whoami',
  'uname',
  'hostname',
  'sleep',
  'seq',
  'md5',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
  'cksum',
  'b2sum',
  'sum',
  'yes',
  'printenv',
  'locale',
  'tty',
  'nproc',
  'getconf',
  'lsof',
  'ps',
  'pgrep',
  'uptime',
  'free',
  'vm_stat',
  'sw_vers',
  'groups',
  'users',
  'who',
  'last',
  'history',
  'jobs',
  'wait',
  'alias',
  'unalias',
  'set',
  'unset',
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'shift',
  'read',
  'return',
  'exit',
  'break',
  'continue',
  'umask',
  'ulimit',
  'shopt',
  'setopt',
  'unsetopt',
  'let',
  'getopts',
  'nslookup',
  'dig',
  'host',
  'ping',
  'whatis',
  'apropos',
  'man',
  'info',
  'help',
  'tldr',
];
const H: Record<string, Handler> = Object.create(null);
for (const name of READS) H[name] = () => 'read';
for (const name of ['cd', 'chdir', 'pushd', 'popd'] as const)
  H[name] = (args, io) => {
    io.chdir(name === 'chdir' ? 'cd' : name, operands(args).operands[0]);
    return 'read';
  };

for (const name of ['rm', 'unlink', 'shred', 'srm', 'trash'])
  H[name] = (args, io) => {
    const { operands: files, options } = operands(args);
    each(io, files, recursive(options));
    return 'write';
  };
H['rmdir'] = (args, io) => {
  each(io, operands(args).operands, true);
  return 'write';
};
H['touch'] = (args, io) => {
  each(io, operands(args, new Set(['-d', '-r', '-t', '--date', '--reference'])).operands, false);
  return 'write';
};
H['mkdir'] = (args, io) => {
  each(io, operands(args, new Set(['-m', '--mode'])).operands, false);
  return 'write';
};
H['truncate'] = (args, io) => {
  each(io, operands(args, new Set(['-s', '--size', '-r', '--reference'])).operands, false);
  return 'write';
};
for (const name of ['chmod', 'chown', 'chgrp', 'chflags', 'chattr', 'setfacl', 'xattr', 'setfattr'])
  H[name] = (args, io) => {
    const { operands: files, options } = operands(args, new Set(['--reference']));
    each(io, files, recursive(options));
    return 'write';
  };
H['tee'] = (args, io) => {
  each(io, operands(args).operands, false);
  return 'write';
};
H['dd'] = (args, io) => {
  for (const arg of args) if (arg.value?.startsWith('of=')) each(io, [literal(arg.value.slice(3))], false);
  return 'write';
};
/** cp, mv and friends: the destination (or each source's name inside it) is written; mv also removes its sources. */
function copy(move: boolean, valued: readonly string[]): Handler {
  return (args, io) => {
    const { operands: files, options } = operands(
      args,
      new Set(['-t', '--target-directory', '-S', '--suffix', ...valued]),
    );
    const directory = optionValue(options.get('-t') ?? options.get('--target-directory'));
    const dest = directory ?? files.at(-1),
      sources = directory ? files : files.slice(0, -1),
      tree = move || recursive(options);
    if (dest === undefined) return 'write';
    const destinations = io.paths(dest, tree);
    if (destinations === undefined) throw new Unresolved(UNKNOWN_CWD);
    for (const destination of destinations) {
      if (sources.length && (io.isDirectory(destination.path) || dest.value?.endsWith('/') === true)) {
        for (const source of sources)
          io.write([
            source.value === undefined
              ? { path: destination.path, tree: true }
              : { path: join(destination.path, basename(source.value.replaceAll('\\', '/'))), tree },
          ]);
      } else io.write([destination]);
    }
    if (move) each(io, sources, true);
    return 'write';
  };
}
for (const name of ['cp', 'gcp', 'install', 'ditto'])
  H[name] = copy(false, ['-m', '--mode', '-o', '--owner', '-g', '--group']);
// A link to a protected file is a way to write it under another name, so the files a link names count as written too.
for (const name of ['ln', 'link'])
  H[name] = (args, io, name) => {
    const kind = copy(false, ['-t', '--target-directory', '-S', '--suffix'])(args, io, name);
    each(io, operands(args, new Set(['-t', '--target-directory', '-S', '--suffix'])).operands, false);
    return kind;
  };
for (const name of ['mv', 'gmv']) H[name] = copy(true, []);
for (const name of ['rsync', 'scp'])
  H[name] = copy(false, [
    '-e',
    '--rsh',
    '-i',
    '-P',
    '-F',
    '-o',
    '-c',
    '-l',
    '-J',
    '--exclude',
    '--include',
    '--filter',
    '--rsync-path',
    '--log-file',
    '--files-from',
    '--exclude-from',
    '--include-from',
    '--password-file',
    '--chmod',
    '--chown',
  ]);
for (const name of ['sed', 'gsed'])
  H[name] = (args, io) => {
    const { operands: files, options } = operands(
      args,
      new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']),
    );
    if (!options.has('-i') && !options.has('--in-place')) return 'read';
    // Every operand is written: the first may be the script, which names no path the guard protects.
    each(io, files, false);
    return 'write';
  };
for (const name of ['awk', 'gawk', 'mawk', 'nawk'])
  H[name] = (args, io) => {
    const { operands: files, options } = operands(
      args,
      new Set(['-F', '-v', '-f', '--file', '-i', '--include', '-l', '--load', '-E', '--exec']),
    );
    const program = options.has('-f') || options.has('--file') || options.has('-E') ? undefined : files[0];
    if (['-i', '--include'].some((flag) => optionValue(options.get(flag))?.value === 'inplace')) {
      each(io, program ? files.slice(1) : files, false);
      return 'write';
    }
    const text = program?.value ?? program?.raw ?? '';
    if (!/system\s*\(|\|\s*"|\bprintf?\b[^;}]*[^<>=!]>[^=]|\bgetline\b/.test(text)) return 'read';
    // A program that writes can write its own input files (`print > FILENAME`).
    io.code(text, true);
    each(io, program ? files.slice(1) : files, false);
    return 'code';
  };
for (const name of ['perl', 'ruby'])
  H[name] = (args, io) => {
    let inline = false,
      inPlace = false;
    const files: Arg[] = [];
    for (let at = 0; at < args.length; at++) {
      const value = args[at]!.value ?? '';
      if (/^-[A-Za-z0-9]*[eE]$/.test(value)) {
        const code = args[++at];
        if (code) io.code(code.value ?? code.raw);
        inline = true;
        if (value.slice(1, -1).includes('i')) inPlace = true;
        continue;
      }
      if (/^-[A-Za-z0-9]*i/.test(value)) {
        inPlace = true;
        continue;
      }
      if (value.startsWith('-')) continue;
      files.push(args[at]!);
    }
    if (!inline) {
      if (files.length) return opaque(args, io);
      const input = io.input();
      if (input !== undefined) io.code(input);
      return 'code';
    }
    if (inPlace) {
      each(io, files, false);
      return 'write';
    }
    return 'code';
  };
/** Words handed to inline code (`node -e '…' path`): the code may write what they name, so they count as written. */
function handed(args: readonly Arg[], io: Io): Kind {
  for (const arg of args) {
    const targets = io.paths(arg, false);
    if (targets) io.write(targets);
  }
  return 'code';
}
/** An interpreter: inline code is scanned; a script file is run unseen (G6, #540). */
function interpreter(flags: readonly string[], valued: readonly string[]): Handler {
  return (args, io) => {
    for (let at = 0; at < args.length; at++) {
      const value = args[at]!.value;
      if (value === undefined) return opaque(args, io);
      if (flags.includes(value)) {
        const code = args[at + 1];
        if (code) io.code(code.value ?? code.raw);
        return handed(args.slice(at + 2), io);
      }
      const attached = flags.find((flag) => flag.startsWith('--') && value.startsWith(flag + '='));
      if (attached) {
        io.code(value.slice(attached.length + 1));
        return handed(args.slice(at + 1), io);
      }
      if (value === '-') break;
      if (valued.includes(value)) {
        at++;
        continue;
      }
      if (value.startsWith('-')) continue;
      return opaque(args, io);
    }
    const input = io.input();
    if (input === undefined) return opaque(args, io);
    io.code(input);
    return handed(
      args.filter((arg) => arg.value !== '-' && !arg.value?.startsWith('-')),
      io,
    );
  };
}
for (const name of ['node', 'nodejs', 'bun', 'tsx', 'ts-node', 'esno', 'vite-node'])
  H[name] = interpreter(
    ['-e', '--eval', '-p', '--print'],
    [
      '-r',
      '--require',
      '--import',
      '--loader',
      '--experimental-loader',
      '-C',
      '--conditions',
      '--env-file',
      '--input-type',
      '--title',
      '--test-name-pattern',
      '--test-reporter',
      '--test-reporter-destination',
    ],
  );
for (const name of ['python', 'python3', 'python2', 'pypy', 'pypy3', 'py'])
  H[name] = interpreter(['-c'], ['-W', '-X', '--check-hash-based-pycs']);
for (const name of ['php']) H[name] = interpreter(['-r'], ['-c', '-d', '-f']);
for (const name of ['osascript', 'lua', 'rscript', 'julia']) H[name] = interpreter(['-e'], ['-l', '-s']);
H['deno'] = (args, io) => {
  if (args[0]?.value === 'eval') {
    const code = args[1];
    if (code) io.code(code.value ?? code.raw);
    return 'code';
  }
  return opaque(args, io);
};
for (const name of ['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])
  H[name] = (args, io) => {
    for (let at = 0; at < args.length; at++) {
      const value = args[at]!.value;
      if (value === undefined) return opaque(args, io);
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(value)) {
        const code = args[at + 1];
        if (code?.value !== undefined) io.shell('bash', code.value);
        else if (code) io.code(code.raw);
        return 'code';
      }
      if (value === '-s' || value === '--') break;
      if (value === '-o' || value === '+o' || value === '-O' || value === '+O') {
        at++;
        continue;
      }
      if (value.startsWith('-') || value.startsWith('+')) continue;
      return opaque(args, io);
    }
    const input = io.input();
    if (input === undefined) return opaque(args, io);
    io.shell('bash', input);
    return 'code';
  };
const PWSH_VALUED =
  /^[-/](?:ex|executionpolicy|ep|windowstyle|w|wi|win|workingdirectory|wd|inputformat|if|inp|outputformat|of|o|configurationname|config|custompipename|settingsfile|settings)$/;
for (const name of ['pwsh', 'powershell', 'pwsh-preview'])
  H[name] = (args, io) => {
    for (let at = 0; at < args.length; at++) {
      const value = args[at]!.value;
      if (value === undefined) return opaque(args, io);
      const flag = value.toLowerCase(),
        rest = () =>
          args
            .slice(at + 1)
            .map((arg) => arg.value ?? arg.raw)
            .join(' ');
      if (/^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(flag)) {
        io.shell('powershell', rest());
        return 'code';
      }
      if (/^[-/](?:e|ec|en|enc\w*)$/.test(flag)) {
        const encoded = args[at + 1]?.value;
        if (encoded === undefined) return opaque(args, io);
        io.shell('powershell', Buffer.from(encoded, 'base64').toString('utf16le'));
        return 'code';
      }
      if (/^[-/]f(?:i(?:l(?:e)?)?)?$/.test(flag)) return opaque(args, io);
      if (PWSH_VALUED.test(flag)) {
        at++;
        continue;
      }
      if (/^[-/]/.test(flag) && flag.length > 1) continue;
      if (/\.ps1$/i.test(value)) return opaque(args, io);
      io.shell(
        'powershell',
        args
          .slice(at)
          .map((arg) => arg.value ?? arg.raw)
          .join(' '),
      );
      return 'code';
    }
    const input = io.input();
    if (input === undefined) return opaque(args, io);
    io.shell('powershell', input);
    return 'code';
  };
H['cmd'] = (args, io) => {
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg.value ?? ''));
  if (at < 0) return opaque(args, io);
  // cmd.exe text is shell text (del, copy, move, `>`): every protected path it names counts as written.
  io.code(
    args
      .slice(at + 1)
      .map((arg) => arg.value ?? arg.raw)
      .join(' '),
    true,
  );
  return 'code';
};
H['eval'] = (args, io) => {
  const text = args.map((arg) => arg.value ?? arg.raw).join(' ');
  if (args.every((arg) => arg.value !== undefined)) io.shell('bash', text);
  else io.code(text);
  return 'code';
};
H['trap'] = (args, io) => {
  const handler = operands(args).operands[0];
  if (handler?.value !== undefined && handler.value !== '-') io.shell('bash', handler.value);
  return 'code';
};
H['find'] = H['gfind'] = (args, io) => {
  let at = 0;
  const roots: Arg[] = [];
  while (at < args.length && ['-H', '-L', '-P'].includes(args[at]!.value ?? '')) at++;
  for (; at < args.length; at++) {
    const value = args[at]!.value;
    if (value !== undefined && ((value.startsWith('-') && value.length > 1) || ['(', '!', ','].includes(value))) break;
    roots.push(args[at]!);
  }
  const where = roots.length ? roots : [literal('.')];
  let kind: Kind = 'read';
  for (; at < args.length; at++) {
    const value = args[at]!.value ?? '';
    if (value === '-delete') {
      each(io, where, true);
      kind = 'write';
    } else if (['-exec', '-execdir', '-ok', '-okdir'].includes(value)) {
      const end = args.findIndex((arg, index) => index > at && (arg.value === ';' || arg.value === '+'));
      const inner = args.slice(at + 1, end < 0 ? args.length : end);
      at = end < 0 ? args.length : end;
      // What the inner command does to each file found is done to the roots' contents.
      if (native(inner, quiet(io)) !== 'read') {
        each(io, where, true);
        native(
          inner.filter((arg) => arg.value !== '{}'),
          io,
        );
        kind = 'write';
      }
    } else if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(value)) {
      const file = args[++at];
      if (file) each(io, [file], false);
      if (value === '-fprintf') at++;
      kind = 'write';
    }
  }
  return kind;
};
/** An Io that records nothing: used to classify a command without counting its effects twice. */
function quiet(io: Io): Io {
  return {
    ...io,
    paths: () => [],
    write: () => {},
    code: () => {},
    shell: () => {},
    chdir: () => {},
    at: () => quiet(io),
  };
}
H['patch'] = (args, io) => {
  const { operands: files, options } = operands(
    args,
    new Set([
      '-i',
      '--input',
      '-p',
      '--strip',
      '-d',
      '--directory',
      '-o',
      '--output',
      '-r',
      '--reject-file',
      '-D',
      '--ifdef',
      '-F',
      '--fuzz',
      '-z',
      '--suffix',
      '-B',
      '--prefix',
      '-V',
      '--version-control',
      '-Y',
      '--basename-prefix',
      '-g',
      '--get',
    ]),
  );
  if (options.has('--dry-run')) return 'read';
  const output = optionValue(options.get('-o') ?? options.get('--output'));
  if (output) each(io, [output], false);
  if (files[0]) each(io, [files[0]], false);
  const directory = optionValue(options.get('-d') ?? options.get('--directory')),
    base = directory ? io.paths(directory, false)?.[0]?.path : io.cwd();
  const text =
    readArg(io, optionValue(options.get('-i') ?? options.get('--input')) ?? files[1] ?? io.inputFile()) ?? io.input();
  if (base === undefined) throw new Unresolved(UNKNOWN_CWD);
  if (text === undefined) io.write([{ path: base, tree: true }]);
  else patchWrites(io, text, base);
  return 'write';
};
H['tar'] =
  H['gtar'] =
  H['bsdtar'] =
    (args, io) => {
      const first = args[0]?.value ?? '',
        bundled = /^[A-Za-z]+$/.test(first) ? first : '';
      const { operands: files, options } = operands(
        bundled ? args.slice(1) : args,
        new Set([
          '-f',
          '--file',
          '-C',
          '--directory',
          '-T',
          '--files-from',
          '-X',
          '--exclude-from',
          '-b',
          '--blocking-factor',
          '-I',
          '--use-compress-program',
          '--exclude',
          '-s',
        ]),
      );
      const has = (flag: string, long: string) =>
        bundled.includes(flag) || options.has('-' + flag) || options.has(long);
      if (has('x', '--extract') || options.has('--get')) {
        const directory = optionValue(options.get('-C') ?? options.get('--directory')),
          where = directory
            ? io.paths(directory, true)
            : io.cwd() === undefined
              ? undefined
              : [{ path: io.cwd()!, tree: true }];
        if (where === undefined) throw new Unresolved(UNKNOWN_CWD);
        io.write(where);
        return 'write';
      }
      if (has('c', '--create') || has('r', '--append') || has('u', '--update')) {
        const archive =
          optionValue(options.get('-f') ?? options.get('--file')) ?? (bundled.includes('f') ? files[0] : undefined);
        if (archive) each(io, [archive], false);
        return 'write';
      }
      return 'read';
    };
H['unzip'] = (args, io) => {
  const { options } = operands(args, new Set(['-d', '-x', '-P']));
  if (['-l', '-t', '-Z', '-v', '-p'].some((flag) => options.has(flag))) return 'read';
  const directory = optionValue(options.get('-d')),
    where = directory
      ? io.paths(directory, true)
      : io.cwd() === undefined
        ? undefined
        : [{ path: io.cwd()!, tree: true }];
  if (where === undefined) throw new Unresolved(UNKNOWN_CWD);
  io.write(where);
  return 'write';
};
H['curl'] = (args, io) => {
  const { operands: urls, options } = operands(
    args,
    new Set([
      '-o',
      '--output',
      '-D',
      '--dump-header',
      '-c',
      '--cookie-jar',
      '--trace',
      '--trace-ascii',
      '--stderr',
      '--output-dir',
      '-d',
      '--data',
      '-H',
      '--header',
      '-X',
      '--request',
      '-u',
      '--user',
      '-b',
      '--cookie',
      '-F',
      '--form',
      '-T',
      '--upload-file',
      '-A',
      '--user-agent',
      '-e',
      '--referer',
      '-m',
      '--max-time',
      '--connect-timeout',
      '-x',
      '--proxy',
      '-w',
      '--write-out',
      '--data-raw',
      '--data-binary',
      '--data-urlencode',
      '-K',
      '--config',
      '--cacert',
      '--cert',
      '--key',
      '-E',
      '-r',
      '--range',
      '-Y',
      '-y',
      '-z',
      '--retry',
    ]),
  );
  let kind: Kind = 'read';
  for (const flag of [
    '-o',
    '--output',
    '-D',
    '--dump-header',
    '-c',
    '--cookie-jar',
    '--trace',
    '--trace-ascii',
    '--stderr',
  ]) {
    const file = optionValue(options.get(flag));
    if (file) {
      each(io, [file], false);
      kind = 'write';
    }
  }
  if (options.has('-O') || options.has('--remote-name')) {
    const directory = optionValue(options.get('--output-dir'));
    for (const url of urls) {
      const name = url.value?.split(/[?#]/)[0]?.split('/').at(-1);
      if (name) {
        each(io, [directory?.value !== undefined ? literal(join(directory.value, name)) : literal(name)], false);
        kind = 'write';
      }
    }
  }
  return kind;
};
H['wget'] = (args, io) => {
  const { operands: urls, options } = operands(
    args,
    new Set([
      '-O',
      '--output-document',
      '-P',
      '--directory-prefix',
      '-o',
      '--output-file',
      '-a',
      '--append-output',
      '-i',
      '--input-file',
      '-U',
      '--user-agent',
      '-t',
      '--tries',
      '-T',
      '--timeout',
      '--header',
      '--user',
      '--password',
    ]),
  );
  for (const flag of ['-o', '--output-file', '-a', '--append-output']) {
    const file = optionValue(options.get(flag));
    if (file) each(io, [file], false);
  }
  const document = optionValue(options.get('-O') ?? options.get('--output-document'));
  if (document) {
    if (document.value !== '-') each(io, [document], false);
    return 'write';
  }
  const prefix = optionValue(options.get('-P') ?? options.get('--directory-prefix'));
  if (prefix) {
    each(io, [prefix], true);
    return 'write';
  }
  for (const url of urls) {
    const name = url.value?.split(/[?#]/)[0]?.split('/').at(-1);
    each(io, [literal(name || 'index.html')], false);
  }
  return 'write';
};
H['sort'] = (args, io) => {
  const { options } = operands(
    args,
    new Set([
      '-o',
      '--output',
      '-k',
      '--key',
      '-t',
      '--field-separator',
      '-T',
      '--temporary-directory',
      '-S',
      '--buffer-size',
      '--files0-from',
      '--parallel',
      '--batch-size',
      '--compress-program',
      '--random-source',
    ]),
  );
  const file = optionValue(options.get('-o') ?? options.get('--output'));
  if (!file) return 'read';
  each(io, [file], false);
  return 'write';
};
H['uniq'] = (args, io) => {
  const files = operands(args, new Set(['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'])).operands;
  if (files.length < 2) return 'read';
  each(io, [files[1]!], false);
  return 'write';
};
H['xxd'] = (args, io) => {
  const files = operands(args, new Set(['-c', '-g', '-l', '-o', '-s', '-n', '-C', '-cols', '-len', '-seek'])).operands;
  if (files.length < 2) return 'read';
  each(io, [files[1]!], false);
  return 'write';
};
H['base64'] = (args, io) => {
  const { options } = operands(args, new Set(['-i', '--input', '-o', '--output', '-w', '--wrap', '-b', '--break']));
  const file = optionValue(options.get('-o') ?? options.get('--output'));
  if (!file) return 'read';
  each(io, [file], false);
  return 'write';
};
H['yq'] = (args, io) => {
  const { operands: files, options } = operands(
    args,
    new Set(['-o', '--output-format', '-p', '--input-format', '--from-file', '--indent', '-I', '--expression']),
  );
  if (!options.has('-i') && !options.has('--inplace')) return 'read';
  each(io, files, false);
  return 'write';
};

const GIT_READS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'grep',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'check-ignore',
  'check-attr',
  'check-mailmap',
  'check-ref-format',
  'merge-base',
  'reflog',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'symbolic-ref',
  'show-branch',
  'whatchanged',
  'range-diff',
  'cherry',
  'count-objects',
  'fsck',
  'verify-commit',
  'verify-tag',
  'verify-pack',
  'help',
  'version',
  'var',
  'remote',
  'fetch',
  'push',
  'add',
  'commit',
  'tag',
  'branch',
  'notes',
  'merge',
  'pull',
  'rebase',
  'cherry-pick',
  'revert',
  'bisect',
  'submodule',
  'gc',
  'prune',
  'repack',
  'maintenance',
  'pack-refs',
  'update-ref',
  'update-index',
  'write-tree',
  'commit-tree',
  'mktree',
  'hash-object',
  'fast-export',
  'request-pull',
  'credential',
  'lfs',
  'config',
  'sparse-checkout',
  'replace',
  'stage',
  'difftool',
  'mergetool',
  'shortlog',
  'archive',
  'bundle',
  'format-patch',
]);
H['git'] = (args, io) => {
  let at = 0,
    cwd = io.cwd(),
    work: string | undefined;
  for (; at < args.length; at++) {
    const value = args[at]!.value;
    if (value === undefined) return opaque(args, io);
    if (value === '-C') {
      const dir = args[++at];
      cwd = dir === undefined ? cwd : io.at(cwd).paths(dir, false)?.[0]?.path;
      continue;
    }
    if (value.startsWith('--work-tree=') || value === '--work-tree') {
      const tree = value === '--work-tree' ? args[++at] : literal(value.slice(12));
      work = tree ? io.at(cwd).paths(tree, false)?.[0]?.path : undefined;
      continue;
    }
    if (['-c', '--git-dir', '--namespace', '--config-env', '--exec-path', '--super-prefix'].includes(value)) {
      at++;
      continue;
    }
    if (value.startsWith('-')) continue;
    break;
  }
  const sub = args[at]?.value,
    rest = args.slice(at + 1),
    scoped = io.at(cwd);
  if (sub === undefined) return args[at] ? opaque(args, io) : 'read';
  const whole = (): Kind => {
    const root = work ?? (cwd === undefined ? undefined : io.worktree(cwd));
    if (root === undefined) throw new Unresolved(UNKNOWN_CWD);
    io.write([{ path: root, tree: true }]);
    return 'write';
  };
  switch (sub) {
    case 'checkout': {
      const dash = rest.findIndex((arg) => arg.value === '--');
      const { operands: named, options } = operands(
        dash < 0 ? rest : rest.slice(0, dash),
        new Set([
          '-b',
          '-B',
          '--orphan',
          '-t',
          '--track',
          '--conflict',
          '--pathspec-from-file',
          '--recurse-submodules',
        ]),
      );
      if (options.has('--pathspec-from-file')) return whole();
      if (dash >= 0) {
        each(scoped, rest.slice(dash + 1), true);
        return 'write';
      }
      const force = options.has('-f') || options.has('--force');
      // Without `--`, git takes an operand that names an existing path as a path; anything else is the commit to switch to.
      const paths = named.filter((arg) => {
        const found = scoped.paths(arg, false);
        return found === undefined || found.some((target) => scoped.exists(target.path));
      });
      if (paths.length) {
        each(scoped, paths, true);
        return 'write';
      }
      return force ? whole() : 'read';
    }
    case 'restore': {
      const { operands: paths, options } = operands(
        rest,
        new Set(['-s', '--source', '--pathspec-from-file', '--conflict']),
      );
      if (!(options.has('-W') || options.has('--worktree')) && (options.has('-S') || options.has('--staged')))
        return 'read';
      if (options.has('--pathspec-from-file') || !paths.length) return whole();
      each(scoped, paths, true);
      return 'write';
    }
    case 'rm': {
      const { operands: paths, options } = operands(rest, new Set(['--pathspec-from-file']));
      if (options.has('--cached')) return 'read';
      if (options.has('--pathspec-from-file')) return whole();
      each(scoped, paths, true);
      return 'write';
    }
    case 'mv': {
      each(scoped, operands(rest).operands, true);
      return 'write';
    }
    case 'clean': {
      const { operands: paths, options } = operands(rest, new Set(['-e', '--exclude']));
      if (options.has('-n') || options.has('--dry-run')) return 'read';
      if (!paths.length) return whole();
      each(scoped, paths, true);
      return 'write';
    }
    case 'reset': {
      const { options } = operands(rest, new Set(['--pathspec-from-file']));
      return ['--hard', '--merge', '--keep'].some((flag) => options.has(flag)) ? whole() : 'read';
    }
    case 'stash': {
      const verb = rest[0]?.value;
      if (['list', 'show', 'drop', 'clear', 'create', 'store'].includes(verb ?? '')) return 'read';
      if (['pop', 'apply', 'branch', 'save'].includes(verb ?? '')) return whole();
      const { operands: paths } = operands(
        verb === 'push' ? rest.slice(1) : rest,
        new Set(['-m', '--message', '--pathspec-from-file']),
      );
      if (!paths.length) return whole();
      each(scoped, paths, true);
      return 'write';
    }
    case 'apply':
    case 'am': {
      const { operands: files, options } = operands(
        rest,
        new Set([
          '-p',
          '-C',
          '--directory',
          '--exclude',
          '--include',
          '--whitespace',
          '--build-fake-ancestor',
          '-S',
          '--patch-format',
          '--resolvemsg',
        ]),
      );
      if (
        sub === 'apply' &&
        ['--check', '--stat', '--numstat', '--summary'].some((flag) => options.has(flag)) &&
        !options.has('--apply')
      )
        return 'read';
      if (sub === 'am' && ['--abort', '--quit', '--show-current-patch'].some((flag) => options.has(flag)))
        return 'read';
      const root = work ?? (cwd === undefined ? undefined : io.worktree(cwd));
      if (root === undefined) throw new Unresolved(UNKNOWN_CWD);
      const texts = files.length
        ? files.map((file) => readArg(scoped, file))
        : [readArg(scoped, io.inputFile()) ?? io.input()];
      // A patch the guard cannot read could change any file in the work tree.
      if (texts.some((text) => text === undefined)) return whole();
      for (const text of texts) patchWrites(io, text!, root);
      return 'write';
    }
    case 'checkout-index': {
      const { operands: paths, options } = operands(rest, new Set(['--prefix', '--stage']));
      if (options.has('-a') || options.has('--all')) return whole();
      each(scoped, paths, false);
      return 'write';
    }
    case 'read-tree':
      return operands(rest, new Set(['--prefix', '--index-output'])).options.has('-u') ? whole() : 'read';
    case 'switch': {
      const { options } = operands(
        rest,
        new Set(['-c', '-C', '--create', '--force-create', '--orphan', '-t', '--track']),
      );
      return ['-f', '--force', '--discard-changes'].some((flag) => options.has(flag)) ? whole() : 'read';
    }
    case 'worktree': {
      const verb = rest[0]?.value;
      if (verb !== 'add' && verb !== 'remove' && verb !== 'move') return 'read';
      const { operands: paths } = operands(rest.slice(1), new Set(['-b', '-B', '--reason']));
      each(scoped, verb === 'add' ? paths.slice(0, 1) : paths, true);
      return 'write';
    }
    case 'clone':
    case 'init': {
      const { operands: parts } = operands(
        rest,
        new Set([
          '-o',
          '--origin',
          '-b',
          '--branch',
          '-u',
          '--upload-pack',
          '--reference',
          '--separate-git-dir',
          '--depth',
          '--shallow-since',
          '--shallow-exclude',
          '-c',
          '--config',
          '--filter',
          '-j',
          '--jobs',
          '--template',
          '--bundle-uri',
          '--initial-branch',
          '--object-format',
          '--ref-format',
          '--shared',
        ]),
      );
      const directory = sub === 'clone' ? parts[1] : parts[0];
      if (directory) {
        each(scoped, [directory], true);
        return 'write';
      }
      return sub === 'init' ? whole() : 'read';
    }
    case 'diff':
    case 'show':
    case 'log':
    case 'format-patch':
    case 'archive':
    case 'bundle': {
      const { operands: parts, options } = operands(rest, new Set(['--output', '-o', '--output-directory']));
      const out = optionValue(options.get('--output') ?? (sub === 'archive' ? options.get('-o') : undefined));
      if (out) {
        each(scoped, [out], false);
        return 'write';
      }
      const directory =
        sub === 'format-patch' ? optionValue(options.get('-o') ?? options.get('--output-directory')) : undefined;
      if (directory) {
        each(scoped, [directory], true);
        return 'write';
      }
      if (sub === 'bundle' && parts[0]?.value === 'create' && parts[1]) {
        each(scoped, [parts[1]], false);
        return 'write';
      }
      return 'read';
    }
    default:
      return GIT_READS.has(sub) ? 'read' : opaque(rest, scoped);
  }
};

/** Options each wrapper takes before the command it runs; `skip` covers the operands that come before it. */
const WRAPPERS: Readonly<
  Record<string, { readonly valued: readonly string[]; readonly skip?: number; readonly sub?: readonly string[] }>
> = {
  sudo: {
    valued: [
      '-u',
      '-g',
      '-C',
      '-h',
      '-p',
      '-D',
      '-R',
      '-T',
      '-U',
      '-r',
      '-t',
      '--user',
      '--group',
      '--host',
      '--prompt',
      '--chdir',
      '--chroot',
      '--command-timeout',
      '--other-user',
      '--role',
      '--type',
      '--close-from',
    ],
  },
  doas: { valued: ['-u', '-C'] },
  builtin: { valued: [] },
  exec: { valued: ['-a'] },
  nohup: { valued: [] },
  caffeinate: { valued: ['-t', '-w'] },
  unbuffer: { valued: [] },
  stdbuf: { valued: ['-i', '-o', '-e'] },
  ionice: { valued: ['-c', '-n', '-p'] },
  noglob: { valued: [] },
  nocorrect: { valued: [] },
  time: { valued: ['-o', '--output', '-f', '--format'] },
  nice: { valued: ['-n', '--adjustment'] },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], skip: 1 },
  watch: { valued: ['-n', '--interval', '-d'] },
  command: { valued: [] },
  npx: { valued: ['-p', '--package', '-c', '--call'] },
  bunx: { valued: ['-p', '--package'] },
  pnpx: { valued: [] },
  uvx: { valued: ['--from', '--with', '-p', '--python'] },
  xargs: {
    valued: [
      '-a',
      '--arg-file',
      '-d',
      '--delimiter',
      '-E',
      '-e',
      '--eof',
      '-I',
      '-i',
      '--replace',
      '-L',
      '-l',
      '--max-lines',
      '-n',
      '--max-args',
      '-P',
      '--max-procs',
      '-s',
      '--max-chars',
      '--process-slot-var',
    ],
  },
  pnpm: { valued: ['-C', '--dir', '--filter', '-F', '-c', '--package'], sub: ['exec', 'dlx'] },
  npm: { valued: ['-c', '--package', '-w', '--workspace'], sub: ['exec', 'x'] },
  yarn: { valued: ['-p', '--package'], sub: ['exec', 'dlx'] },
  uv: { valued: ['--with', '--python', '-p', '--directory', '--project', '--package'], sub: ['run'] },
  poetry: { valued: [], sub: ['run'] },
  pipenv: { valued: [], sub: ['run'] },
};
/** The command a wrapper runs; a wrapper that only reports (`command -v`, `env` alone) runs nothing. */
function unwrap(argv: readonly Arg[], io: Io): readonly Arg[] {
  let words = argv;
  for (let hop = 0; hop < 16; hop++) {
    const name = program(words[0]),
      args = words.slice(1);
    if (name === 'env') {
      let at = 0;
      for (; at < args.length; at++) {
        const value = args[at]!.value;
        if (value === undefined) break;
        if (['-u', '--unset', '-S', '--split-string', '-P', '-C', '--chdir'].includes(value)) {
          at++;
          continue;
        }
        if (value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
        break;
      }
      words = args.slice(at);
      continue;
    }
    const wrapper = name === undefined ? undefined : WRAPPERS[name];
    if (!wrapper) return words;
    if (name === 'command' && ['-v', '-V'].includes(args[0]?.value ?? '')) return [];
    let rest = args;
    if (wrapper.sub) {
      if (!wrapper.sub.includes(args[0]?.value ?? '')) return words;
      rest = args.slice(1);
    }
    let at = 0;
    for (; at < rest.length; at++) {
      const value = rest[at]!.value;
      if (value === undefined || !value.startsWith('-') || value === '-') break;
      if (value === '--') {
        at++;
        break;
      }
      if (wrapper.valued.includes(value)) {
        if (name === 'time' && (value === '-o' || value === '--output') && rest[at + 1])
          each(io, [rest[at + 1]!], false);
        at++;
      }
    }
    words = rest.slice(at + (wrapper.skip ?? 0));
    if (name === 'xargs' && !words.length) return [literal('echo')];
  }
  return words;
}

/** What one native command does to files: its kind, with its writes and code already reported to `io`. */
export function native(argv: readonly Arg[], io: Io): Kind {
  const words = unwrap(argv, io);
  if (!words.length) return 'read';
  const name = program(words[0]),
    handler = name === undefined ? undefined : H[name];
  return handler ? handler(words.slice(1), io, name!) : opaque(words, io);
}
/**
 * Commands whose output is the file names their operands lead to: a pipe or a command substitution from them carries those
 * paths to the next command. Another program's output is its own data, unseen like the rest of what it works out.
 */
export const PRODUCERS = new Set([
  'find',
  'gfind',
  'fd',
  'fdfind',
  'ls',
  'dir',
  'vdir',
  'tree',
  'du',
  'echo',
  'printf',
  'realpath',
  'readlink',
  'dirname',
  'basename',
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'rg',
  'ag',
  'ack',
  'git',
  'xargs',
  'get-childitem',
  'gci',
  'resolve-path',
  'rvpa',
  'get-item',
  'gi',
  'select-string',
  'sls',
  'write-output',
  'join-path',
  'split-path',
]);
/** Git subcommands whose output is content, not file names (an archive, an object, history metadata). */
const GIT_CONTENT = new Set([
  'archive',
  'cat-file',
  'bundle',
  'fast-export',
  'blame',
  'annotate',
  'shortlog',
  'describe',
  'rev-list',
  'count-objects',
  'version',
  'config',
  'remote',
  'branch',
  'tag',
  'reflog',
  'for-each-ref',
  'show-ref',
  'symbolic-ref',
  'name-rev',
  'merge-base',
  'var',
  'help',
  'hash-object',
]);
/** Whether a command's output carries the file names its operands lead to (`PRODUCERS`; for git, by subcommand). */
export function producesPaths(argv: readonly Arg[]): boolean {
  const name = program(argv[0]);
  if (name !== 'git') return PRODUCERS.has(name ?? '');
  let at = 1;
  while (at < argv.length && argv[at]!.value?.startsWith('-'))
    at += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(argv[at]!.value!) ? 2 : 1;
  return !GIT_CONTENT.has(argv[at]?.value ?? '');
}
/** Commands whose output is file content rather than file names: a pipe from them carries no paths to the next command. */
export const CONTENT = new Set([
  'cat',
  'tac',
  'nl',
  'head',
  'tail',
  'less',
  'more',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'jq',
  'yq',
  'sort',
  'uniq',
  'wc',
  'sed',
  'awk',
  'gawk',
  'cut',
  'tr',
  'diff',
  'cmp',
  'base64',
  'md5sum',
  'sha256sum',
  'shasum',
  'curl',
  'wget',
  'get-content',
  'gc',
  'type',
  'select-string',
  'sls',
  'convertfrom-json',
  'convertto-json',
  'measure-object',
]);
