/**
 * PowerShell command analysis for the steward guard (#540). The parser splits statements, pipelines, commands and their
 * arguments as PowerShell does (quotes, here-strings, variables, subexpressions, script blocks, redirections) within the
 * shared bounds, and reports what each command's text shows it writes. Nothing is run; a path a program works out while it
 * runs stays unseen (SPEC H07).
 */
import { basename, join } from 'node:path';
import { each, literal, native, opaque, producesPaths, UNKNOWN_CWD, Unresolved } from './commands.js';
import type { Arg, Io, Kind, Target } from './commands.js';
import type { Analyzer, Session, State } from './analysis.js';

type Part =
  | { readonly t: 'text'; readonly value: string }
  | { readonly t: 'var'; readonly name: string }
  | { readonly t: 'sub'; readonly body: Statement[] }
  | { readonly t: 'unknown' };
interface Word {
  readonly parts: readonly Part[];
  readonly raw: string;
  readonly bare: boolean;
  readonly block?: Statement[] | undefined;
  readonly code: boolean;
}
interface Redirect {
  readonly target: Word;
}
interface Element {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly call: boolean;
  readonly assign?: { readonly name: string } | undefined;
  readonly keyword?: { readonly blocks: readonly Statement[][] } | undefined;
}
type Statement = readonly Element[];

const KEYWORDS = new Set([
  'if',
  'elseif',
  'else',
  'foreach',
  'for',
  'while',
  'do',
  'until',
  'switch',
  'try',
  'catch',
  'finally',
  'function',
  'filter',
  'param',
  'begin',
  'process',
  'end',
  'trap',
  'data',
  'return',
  'throw',
  'exit',
  'break',
  'continue',
]);
const OPEN: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };

class Parser {
  private at = 0;
  constructor(
    private readonly text: string,
    private readonly session: Session,
    private depth: number,
  ) {}
  script(): Statement[] {
    const body = this.statements('');
    if (this.at < this.text.length) this.session.fail('cannot be parsed');
    return body;
  }
  private peek(offset = 0): string {
    return this.text[this.at + offset] ?? '';
  }
  private nested<T>(parse: () => T): T {
    const depth = this.depth;
    this.depth = this.session.enter(depth);
    try {
      return parse();
    } finally {
      this.depth = depth;
    }
  }
  private blank(newlines: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) this.at++;
      else if (c === '`' && this.peek(1) === '\n') this.at += 2;
      else if (c === '`' && this.peek(1) === '\r' && this.peek(2) === '\n') this.at += 3;
      else if (c === '<' && this.peek(1) === '#') {
        const end = this.text.indexOf('#>', this.at + 2);
        if (end < 0) this.session.fail('cannot be parsed');
        this.at = end + 2;
      } else if (c === '#') {
        const end = this.text.indexOf('\n', this.at);
        this.at = end < 0 ? this.text.length : end;
      } else return;
    }
  }
  /** Statements until `close` (or the end, for the top level). */
  private statements(close: string): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      this.blank(true);
      if (this.at >= this.text.length) {
        if (close) this.session.fail(close === '"' ? 'has an unterminated quote' : 'cannot be parsed');
        return out;
      }
      const c = this.peek();
      if (close && c === close) return out;
      if (c === ';') {
        this.at++;
        continue;
      }
      if (this.text.startsWith('&&', this.at) || this.text.startsWith('||', this.at)) {
        this.at += 2;
        continue;
      }
      const before = this.at;
      out.push(this.pipeline(close));
      if (this.at === before) this.session.fail('cannot be parsed');
    }
  }
  private pipeline(close: string): Element[] {
    const out: Element[] = [];
    for (;;) {
      out.push(this.element(close));
      this.blank(false);
      if (this.peek() === '|' && this.peek(1) !== '|') {
        this.at++;
        this.blank(true);
        continue;
      }
      return out;
    }
  }
  private element(close: string): Element {
    this.blank(false);
    const words: Word[] = [],
      redirects: Redirect[] = [];
    let call = false,
      assign: { name: string } | undefined;
    if ((this.peek() === '&' || this.peek() === '.') && /[\s'"$({]/.test(this.peek(1))) {
      call = true;
      this.at++;
    }
    const keyword = /^[A-Za-z]+/.exec(this.text.slice(this.at, this.at + 12))?.[0]?.toLowerCase();
    if (
      !call &&
      keyword !== undefined &&
      KEYWORDS.has(keyword) &&
      /^(?:$|[\s({;])/.test(this.text.slice(this.at + keyword.length, this.at + keyword.length + 1))
    ) {
      // A keyword statement: its conditions and blocks are statements in turn.
      this.at += keyword.length;
      const blocks: Statement[][] = [];
      for (;;) {
        this.blank(true);
        const c = this.peek();
        if (c === '(' || c === '{') {
          this.at++;
          blocks.push(this.nested(() => this.statements(OPEN[c]!)));
          this.at++;
          continue;
        }
        const next = /^[A-Za-z]+/.exec(this.text.slice(this.at, this.at + 12))?.[0]?.toLowerCase();
        if (next !== undefined && ['elseif', 'else', 'catch', 'finally', 'while', 'until'].includes(next)) {
          this.at += next.length;
          continue;
        }
        if (!c || c === ';' || c === '\n' || c === '|' || c === close || c === '}' || c === ')') break;
        words.push(this.word(close));
      }
      return { words, redirects, call, keyword: { blocks } };
    }
    for (;;) {
      this.blank(false);
      const c = this.peek();
      if (
        !c ||
        c === ';' ||
        c === '\n' ||
        (c === '|' && this.peek(1) !== '|') ||
        c === close ||
        c === ')' ||
        c === '}' ||
        this.text.startsWith('&&', this.at) ||
        this.text.startsWith('||', this.at)
      )
        break;
      const redirect = /^(?:[1-6*]?>>?)(?:&[12])?/.exec(this.text.slice(this.at, this.at + 5));
      if (redirect && (redirect[0].startsWith('>') || /^[1-6*]>/.test(redirect[0]))) {
        this.at += redirect[0].length;
        if (redirect[0].includes('&')) continue;
        this.blank(false);
        redirects.push({ target: this.word(close) });
        continue;
      }
      if (!words.length && !assign && c === '$') {
        const match = /^\$(?:\{([^}]+)\}|((?:[A-Za-z_][\w]*:)?[A-Za-z_][\w]*))\s*(?:[+\-*/]?=)(?!=)/.exec(
          this.text.slice(this.at, this.at + 300),
        );
        if (match) {
          assign = { name: (match[1] ?? match[2]!).toLowerCase() };
          this.at += match[0].length;
          continue;
        }
      }
      words.push(this.word(close));
    }
    return { words, redirects, call, assign };
  }
  private word(close: string): Word {
    this.session.word();
    const start = this.at,
      parts: Part[] = [];
    let text = '',
      code = false,
      block: Statement[] | undefined;
    const flush = (): void => {
      if (text) parts.push({ t: 'text', value: text });
      text = '';
    };
    const c0 = this.peek();
    if (c0 === '{') {
      this.at++;
      block = this.nested(() => this.statements('}'));
      this.at++;
      return { parts: [{ t: 'unknown' }], raw: this.text.slice(start, this.at), bare: false, block, code: false };
    }
    if (
      c0 === '@' &&
      (this.peek(1) === "'" || this.peek(1) === '"') &&
      /^@['"][ \t]*\r?\n/.test(this.text.slice(this.at, this.at + 4))
    )
      return this.herestring(start);
    for (;;) {
      const c = this.peek();
      if (!c || ' \t\r\n;|'.includes(c) || c === close || c === ')' || c === '}' || (c === ',' && false)) break;
      if (c === '>' || ((c === '2' || c === '*') && this.peek(1) === '>' && this.at === start)) break;
      if (c === '`') {
        const next = this.peek(1);
        if (next === '\n') {
          this.at += 2;
          continue;
        }
        text += next;
        this.at += next ? 2 : 1;
        continue;
      }
      if (c === "'") {
        let value = '';
        for (this.at++; ; ) {
          const end = this.text.indexOf("'", this.at);
          if (end < 0) this.session.fail('has an unterminated quote');
          value += this.text.slice(this.at, end);
          this.at = end + 1;
          if (this.peek() === "'") {
            value += "'";
            this.at++;
            continue;
          }
          break;
        }
        text += value;
        continue;
      }
      if (c === '"') {
        this.at++;
        this.expandable('"', flush, parts, (value) => {
          text += value;
        });
        continue;
      }
      if (c === '$') {
        const part = this.dollar();
        if (part) {
          flush();
          parts.push(part);
        } else {
          text += '$';
          this.at++;
        }
        continue;
      }
      if (c === '@' && (this.peek(1) === '(' || this.peek(1) === '{')) {
        this.at += 2;
        const body = this.nested(() => this.statements(this.text[this.at - 1] === '(' ? ')' : '}'));
        this.at++;
        flush();
        parts.push({ t: 'sub', body });
        continue;
      }
      if (c === '(') {
        this.at++;
        const body = this.nested(() => this.statements(')'));
        this.at++;
        flush();
        parts.push({ t: 'sub', body });
        code = true;
        continue;
      }
      if (c === '[') {
        const end = this.balanced('[', ']');
        text += this.text.slice(this.at, end);
        this.at = end;
        code = true;
        continue;
      }
      if (c === '{') {
        this.at++;
        this.nested(() => this.statements('}'));
        this.at++;
        code = true;
        continue;
      }
      if (c === ':' && this.peek(1) === ':') code = true;
      if (c === '.' && /[A-Za-z_]/.test(this.peek(1)) && (parts.length || /[\])]$/.test(text))) code = true;
      text += c;
      this.at++;
    }
    flush();
    const raw = this.text.slice(start, this.at);
    return { parts, raw, bare: !/^['"$@([]/.test(raw), code };
  }
  private balanced(open: string, close: string): number {
    for (let at = this.at, depth = 0; at < this.text.length; at++) {
      const c = this.text[at];
      if (c === open) depth++;
      else if (c === close && --depth === 0) return at + 1;
    }
    return this.session.fail('cannot be parsed');
  }
  /** A double-quoted string: backtick escapes, `$name`, `${name}`, `$(…)`. */
  private expandable(close: string, flush: () => void, parts: Part[], add: (value: string) => void): void {
    for (;;) {
      const c = this.peek();
      if (!c) this.session.fail('has an unterminated quote');
      if (c === close) {
        if (this.peek(1) === close) {
          add(close);
          this.at += 2;
          continue;
        }
        this.at++;
        return;
      }
      if (c === '`') {
        const next = this.peek(1);
        add(({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[next] ?? next);
        this.at += next ? 2 : 1;
        continue;
      }
      if (c === '$') {
        const part = this.dollar();
        if (part) {
          flush();
          parts.push(part);
        } else {
          add('$');
          this.at++;
        }
        continue;
      }
      add(c);
      this.at++;
    }
  }
  private herestring(start: number): Word {
    const quote = this.peek(1),
      close = '\n' + quote + '@';
    const begin = this.text.indexOf('\n', this.at) + 1,
      end = this.text.indexOf(close, begin - 1);
    if (begin <= 0 || end < 0) this.session.fail('has an unterminated quote');
    const body = this.text.slice(begin, Math.max(begin, end)).replace(/\r$/, '');
    this.at = end + close.length;
    return {
      parts: [{ t: quote === "'" ? 'text' : 'unknown', value: body } as Part],
      raw: this.text.slice(start, this.at),
      bare: false,
      code: false,
    };
  }
  private dollar(): Part | undefined {
    const next = this.peek(1);
    if (next === '(') {
      this.at += 2;
      const body = this.nested(() => this.statements(')'));
      this.at++;
      return { t: 'sub', body };
    }
    if (next === '{') {
      const end = this.text.indexOf('}', this.at);
      if (end < 0) this.session.fail('cannot be parsed');
      const name = this.text.slice(this.at + 2, end);
      this.at = end + 1;
      return { t: 'var', name: name.toLowerCase() };
    }
    const name = /^(?:[A-Za-z_][\w]*:)?[A-Za-z_][\w]*|^[_?^$]/.exec(this.text.slice(this.at + 1, this.at + 257))?.[0];
    if (name === undefined) return undefined;
    this.at += 1 + name.length;
    return { t: 'var', name: name.toLowerCase() };
  }
}

/** A value as PowerShell's file system provider reads it: a provider prefix dropped; `\` a separator on every platform. */
function spelled(value: string, session: Session): string {
  const plain = value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
  return session.scope.platform === 'win32' ? plain : plain.replaceAll('\\', '/');
}
function variable(
  name: string,
  session: Session,
  state: State,
): { value: string | undefined; names: readonly Target[] } | undefined {
  const known = state.vars.get(name);
  if (known) return known;
  const env = /^env:(.+)$/.exec(name)?.[1];
  if (env !== undefined)
    return session.variable(state, env.toUpperCase() === 'USERPROFILE' ? 'HOME' : env.toUpperCase());
  if (name === 'home') return session.variable(state, 'HOME');
  if (name === 'pwd') return session.variable(state, 'PWD');
  return undefined;
}
interface Outcome {
  readonly kind: Kind;
  readonly names: readonly Target[];
  readonly produces: boolean;
}
const merge = (outcomes: readonly Outcome[]): Outcome => ({
  kind: outcomes.some((outcome) => outcome.kind !== 'read') ? 'write' : 'read',
  names: outcomes.flatMap((outcome) => outcome.names),
  produces: false,
});

export const analyzePowerShell: Analyzer = (text, session, state, depth) => {
  statements(new Parser(text, session, depth).script(), session, state, depth, []);
};

function statements(
  body: readonly Statement[],
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
): Outcome {
  return merge(body.map((statement) => pipeline(statement, session, state, depth, piped)));
}
function pipeline(
  statement: Statement,
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
): Outcome {
  let carried = piped;
  const outcomes: Outcome[] = [];
  for (const element of statement) {
    const outcome = command(element, session, state, depth, carried);
    if (outcome.kind !== 'read' && carried.length)
      session.writes.push(...carried.map((target) => ({ path: target.path, tree: true })));
    if (outcome.produces) carried = [...carried, ...outcome.names];
    outcomes.push(outcome);
  }
  return merge(outcomes);
}
/** A word's Arg; a subexpression runs here, so its effects count. */
function arg(word: Word, session: Session, state: State, depth: number): Arg {
  let value = '',
    known = true;
  const names: Target[] = [];
  for (const part of word.parts) {
    if (part.t === 'text') {
      value += part.value;
      continue;
    }
    if (part.t === 'unknown') {
      known = false;
      continue;
    }
    if (part.t === 'sub') {
      const outcome = statements(part.body, session, state, depth, []);
      known = false;
      names.push(...outcome.names);
      continue;
    }
    const found = variable(part.name, session, state);
    if (found?.value !== undefined) value += found.value;
    else {
      known = false;
      names.push(...(found?.names ?? []));
    }
  }
  if (word.raw.startsWith('~') && known) value = session.scope.home + value.slice(1);
  if (!known) return { raw: word.raw, value: undefined, names };
  const path = spelled(value, session);
  return { raw: word.raw, value: path, pattern: /[*?[]/.test(path) ? path : undefined, names: [] };
}
const READ_CMDLETS = new Set([
  'get-content',
  'gc',
  'cat',
  'type',
  'select-string',
  'sls',
  'get-childitem',
  'gci',
  'ls',
  'dir',
  'get-item',
  'gi',
  'get-itemproperty',
  'gp',
  'test-path',
  'resolve-path',
  'rvpa',
  'get-filehash',
  'measure-object',
  'measure',
  'select-object',
  'select',
  'sort-object',
  'sort',
  'group-object',
  'group',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'format-wide',
  'fw',
  'out-string',
  'out-host',
  'oh',
  'out-null',
  'write-output',
  'echo',
  'write',
  'write-host',
  'write-verbose',
  'write-warning',
  'write-error',
  'write-debug',
  'write-information',
  'get-location',
  'gl',
  'pwd',
  'get-date',
  'get-command',
  'gcm',
  'get-help',
  'help',
  'man',
  'get-process',
  'gps',
  'ps',
  'convertfrom-json',
  'convertto-json',
  'convertfrom-csv',
  'convertto-csv',
  'import-csv',
  'ipcsv',
  'import-clixml',
  'compare-object',
  'compare',
  'diff',
  'get-unique',
  'join-path',
  'split-path',
  'get-variable',
  'gv',
  'get-member',
  'gm',
  'start-sleep',
  'sleep',
  'get-acl',
  'get-alias',
  'get-module',
  'import-module',
  'set-strictmode',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
  'get-psdrive',
  'gdr',
  'get-service',
  'gsv',
  'test-connection',
  'get-filehash',
  'get-random',
  'get-host',
  'get-history',
  'h',
  'history',
  'clear-host',
  'cls',
  'clear',
]);
const SWITCHES = new Set([
  'force',
  'recurse',
  'whatif',
  'confirm',
  'nonewline',
  'append',
  'passthru',
  'raw',
  'noclobber',
  'container',
  'asbytestream',
  'verbose',
  'debug',
  'wait',
  'notypeinformation',
  'r',
  'fo',
  'useculture',
  'compress',
  'update',
  'unique',
  'descending',
  'simplematch',
  'list',
  'allmatches',
  'casesensitive',
  'quiet',
  'notmatch',
  'directory',
  'file',
  'hidden',
  'name',
]);
const PATH_PARAMS = [
  'path',
  'literalpath',
  'filepath',
  'destination',
  'destinationpath',
  'outfile',
  'newname',
  'name',
  'target',
];
const KNOWN_PARAMS = [
  ...PATH_PARAMS,
  'value',
  'inputobject',
  'encoding',
  'filter',
  'include',
  'exclude',
  'itemtype',
  'stream',
  'credential',
  'delimiter',
  'pattern',
  'erroraction',
  'warningaction',
  'outvariable',
  'errorvariable',
  'scriptblock',
  'argumentlist',
  'command',
  'uri',
  'method',
  'headers',
  'body',
  'width',
  'depth',
  'first',
  'last',
  'skip',
  'property',
  'totalcount',
  'tail',
  'readcount',
  'type',
];
/** A cmdlet's named parameters (unambiguous prefixes resolved) and its positional arguments; switches take no value. */
function parameters(
  args: readonly Word[],
  values: readonly Arg[],
): {
  readonly named: ReadonlyMap<string, Arg>;
  readonly switches: ReadonlySet<string>;
  readonly positional: readonly Arg[];
} {
  const named = new Map<string, Arg>(),
    switches = new Set<string>(),
    positional: Arg[] = [];
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!,
      raw = word.bare ? (values[at]!.value ?? '') : '';
    const match = /^-([A-Za-z][\w]*)(?::(.*))?$/.exec(raw);
    if (!match) {
      positional.push(values[at]!);
      continue;
    }
    const typed = match[1]!.toLowerCase(),
      candidates = [...KNOWN_PARAMS, ...SWITCHES].filter((name) => name.startsWith(typed)),
      name = candidates.includes(typed) ? typed : candidates.length === 1 ? candidates[0]! : typed;
    if (match[2] !== undefined) {
      named.set(name, literal(match[2]));
      continue;
    }
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    const next = values[at + 1];
    if (next) {
      named.set(name, next);
      at++;
    }
  }
  return { named, switches, positional };
}
/** Comma-separated values (`a,b`) are one argument holding several paths. */
function split(value: Arg | undefined): Arg[] {
  if (!value) return [];
  if (value.value === undefined || !value.value.includes(',')) return [value];
  return value.value
    .split(',')
    .filter(Boolean)
    .map((part) => ({ ...literal(part), pattern: /[*?[]/.test(part) ? part : undefined }));
}
function targets(named: ReadonlyMap<string, Arg>, names: readonly string[]): Arg[] {
  return names.flatMap((name) => split(named.get(name)));
}
function cmdlet(
  name: string,
  args: readonly Word[],
  values: readonly Arg[],
  io: Io,
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
): Kind | undefined {
  const { named, switches, positional } = parameters(args, values),
    tree = switches.has('recurse');
  const path = (): Arg[] => [...targets(named, ['path', 'literalpath', 'filepath']), ...split(positional[0])];
  switch (name) {
    case 'set-location':
    case 'sl':
    case 'cd':
    case 'chdir':
      io.chdir('cd', named.get('path') ?? named.get('literalpath') ?? positional[0]);
      return 'read';
    case 'push-location':
    case 'pushd':
      io.chdir('pushd', named.get('path') ?? named.get('literalpath') ?? positional[0]);
      return 'read';
    case 'pop-location':
    case 'popd':
      io.chdir('popd', undefined);
      return 'read';
    case 'set-content':
    case 'sc':
    case 'add-content':
    case 'ac':
    case 'clear-content':
    case 'clc':
    case 'out-file':
    case 'tee-object':
    case 'tee':
    case 'set-item':
    case 'si':
    case 'clear-item':
    case 'cli':
    case 'set-itemproperty':
    case 'sp':
    case 'export-csv':
    case 'epcsv':
    case 'export-clixml':
    case 'set-acl':
    case 'unblock-file':
      each(io, path(), false);
      return 'write';
    case 'new-item':
    case 'ni':
    case 'mkdir':
    case 'md': {
      const base = path(),
        child = named.get('name');
      each(
        io,
        child?.value !== undefined && base.length
          ? base.map((dir) => literal(join(dir.value ?? '.', child.value!)))
          : base.length
            ? base
            : child
              ? [child]
              : [],
        false,
      );
      return 'write';
    }
    case 'remove-item':
    case 'ri':
    case 'rm':
    case 'rmdir':
    case 'rd':
    case 'del':
    case 'erase':
      each(io, [...targets(named, ['path', 'literalpath']), ...positional.flatMap(split)], true);
      return 'write';
    case 'rename-item':
    case 'ren':
    case 'rni': {
      const sources = path(),
        next = named.get('newname') ?? positional[1];
      each(io, sources, true);
      for (const source of sources)
        if (next?.value !== undefined && source.value !== undefined)
          each(io, [literal(join(source.value, '..', basename(next.value)))], false);
      return 'write';
    }
    case 'copy-item':
    case 'copy':
    case 'cpi':
    case 'cp':
    case 'move-item':
    case 'move':
    case 'mi':
    case 'mv': {
      const move = !name.startsWith('c'),
        sources = [...targets(named, ['path', 'literalpath']), ...split(positional[0])],
        dest = named.get('destination') ?? positional[1];
      if (move) each(io, sources, true);
      if (!dest) return 'write';
      const destinations = io.paths(dest, tree || move);
      if (destinations === undefined) throw new Unresolved(UNKNOWN_CWD);
      for (const destination of destinations) {
        if (sources.length && io.isDirectory(destination.path))
          for (const source of sources)
            io.write([
              source.value === undefined
                ? { path: destination.path, tree: true }
                : { path: join(destination.path, basename(source.value)), tree: tree || move },
            ]);
        else io.write([destination]);
      }
      return 'write';
    }
    case 'expand-archive': {
      const dest = named.get('destinationpath') ?? positional[1];
      if (dest) each(io, [dest], true);
      else {
        const cwd = io.cwd();
        if (cwd === undefined) throw new Unresolved(UNKNOWN_CWD);
        io.write([{ path: cwd, tree: true }]);
      }
      return 'write';
    }
    case 'compress-archive':
      each(io, targets(named, ['destinationpath']).concat(split(positional[1])), false);
      return 'write';
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
    case 'start-bitstransfer': {
      const out = targets(named, ['outfile', 'destination']);
      if (!out.length) return 'read';
      each(io, out, false);
      return 'write';
    }
    case 'foreach-object':
    case '%':
    case 'foreach':
    case 'where-object':
    case 'where':
    case '?': {
      // The block runs once per piped item; `$_` and `$PSItem` carry the paths the pipe brought.
      const item = { value: undefined, names: piped };
      state.vars.set('_', item);
      state.vars.set('psitem', item);
      return merge(
        args.filter((word) => word.block).map((word) => statements(word.block!, session, state, depth, piped)),
      ).kind;
    }
    case 'invoke-expression':
    case 'iex': {
      const code = named.get('command') ?? positional[0];
      if (code?.value !== undefined) session.analyze('powershell', code.value, state.fork(), depth);
      else if (code) io.code(code.raw);
      return 'code';
    }
    case 'invoke-command':
    case 'icm':
    case 'start-job':
    case 'sajb':
    case 'start-threadjob': {
      const blocks = args.filter((word) => word.block);
      if (!blocks.length) return opaque(values, io);
      return merge(blocks.map((word) => statements(word.block!, session, state.fork(), depth, piped))).kind === 'read'
        ? 'read'
        : 'code';
    }
    default:
      return READ_CMDLETS.has(name) ? 'read' : undefined;
  }
}
function command(element: Element, session: Session, state: State, depth: number, piped: readonly Target[]): Outcome {
  if (element.keyword) {
    for (const word of element.words) arg(word, session, state, depth);
    return {
      ...merge(element.keyword.blocks.map((block) => statements(block, session, state, depth, piped))),
      produces: false,
    };
  }
  const values = element.words.map((word) => arg(word, session, state, depth));
  const io = session.io(state, depth);
  for (const redirect of element.redirects) {
    const target = arg(redirect.target, session, state, depth);
    if (/^\$null$/i.test(redirect.target.raw)) continue;
    const paths = io.paths(target, false);
    if (paths === undefined) session.fail(UNKNOWN_CWD);
    session.writes.push(...paths);
  }
  if (element.assign) {
    // `$x = <pipeline>`: a literal value is the variable's value; a command's named paths stand in for its output.
    const only = element.words.length === 1 && !element.words[0]!.code ? values[0] : undefined;
    const rest = only
      ? { kind: 'read' as const, names: [] as Target[], produces: false }
      : command({ ...element, assign: undefined }, session, state, depth, piped);
    state.vars.set(element.assign.name, { value: only?.value, names: only ? only.names : rest.names });
    return rest;
  }
  const first = element.words[0];
  if (!first) return { kind: 'read', names: [], produces: false };
  // `& { … }` and `. { … }` run their block here.
  if (first.block) return { ...statements(first.block, session, state, depth, piped), produces: false };
  // An expression: a .NET or member call is code whose protected paths count as written; a plain value writes nothing.
  if (!element.call && !first.bare) {
    if (element.words.some((word) => word.code)) io.code(element.words.map((word) => word.raw).join(' '));
    return {
      kind: 'read',
      names: values.flatMap((value) => (value.value === undefined ? value.names : [])),
      produces: true,
    };
  }
  const name = first.bare && !element.call ? (values[0]!.value ?? '').toLowerCase() : undefined;
  const kind =
    name !== undefined
      ? cmdlet(name, element.words.slice(1), values.slice(1), io, session, state, depth, piped)
      : undefined;
  if (kind !== undefined) return { kind, names: names(values.slice(1), io), produces: producesPaths([literal(name!)]) };
  // A script file run by `&` or `.`, or by name, is run unseen (G6, #540).
  if (/\.ps1$/i.test(values[0]!.value ?? '')) return { kind: opaque(values, io), names: [], produces: false };
  const native_ = native(values, io);
  return {
    kind: native_,
    names: producesPaths(values) ? names(values.slice(1), io) : [],
    produces: producesPaths(values),
  };
}
/** The paths a command's operands name, for a pipe to carry. */
function names(values: readonly Arg[], io: Io): Target[] {
  return values
    .filter((value) => !value.value?.startsWith('-'))
    .flatMap((value) =>
      value.value === undefined
        ? value.names.map((name) => ({ path: name.path, tree: true }))
        : (io.paths({ ...value, pattern: undefined }, true) ?? []),
    );
}
