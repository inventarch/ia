/**
 * Bash command analysis for the steward guard (#540). The parser splits a command as bash and zsh do (quotes, expansions,
 * redirections, here-documents, compound commands) within the shared bounds, and reports what each command's text shows it
 * writes. Nothing is run; a path a program works out while it runs stays unseen (SPEC H07).
 */
import { dirname, join, resolve } from 'node:path';
import { literal, native, producesPaths, program, UNKNOWN_CWD } from './commands.js';
import type { Arg, Kind, Target } from './commands.js';
import { braces } from './analysis.js';
import type { Analyzer, Session, State } from './analysis.js';

type Part =
  | { readonly t: 'text'; readonly value: string; readonly quoted: boolean }
  | { readonly t: 'tilde' }
  | { readonly t: 'var'; readonly name: string }
  | { readonly t: 'sub'; readonly list: List }
  | { readonly t: 'unknown' };
interface Word {
  readonly parts: readonly Part[];
  readonly raw: string;
  readonly glob: boolean;
  readonly brace: boolean;
}
interface Redirect {
  readonly op: string;
  readonly target: Word | undefined;
  body: string | undefined;
}
interface Assign {
  readonly name: string;
  readonly value: Word | undefined;
  readonly items: readonly Word[] | undefined;
}
interface Simple {
  readonly kind: 'simple';
  readonly assigns: readonly Assign[];
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
}
interface Compound {
  readonly kind: 'compound';
  readonly type: 'subshell' | 'group' | 'block' | 'for' | 'function' | 'arith';
  readonly lists: readonly List[];
  readonly variable: string | undefined;
  readonly items: readonly Word[] | undefined;
  readonly redirects: readonly Redirect[];
}
type Command = Simple | Compound;
type List = readonly (readonly Command[])[];

const PLAIN = /[^\s;&|()<>\\'"`$*?[{~]+/y,
  QUOTED = /[^"\\$`]+/y;
const RESERVED =
  /^(?:[{}!]|\[\[|if|then|elif|else|fi|do|done|case|esac|while|until|for|select|in|function|time)(?=$|[\s;&|()<>])/;
const escaped = (value: string): string => value.replace(/[*?[\]\\]/g, '\\$&');
/** The most alternatives one word expands to through variables that range over known words. */
const ALTERNATIVES = 64;

class Parser {
  private at = 0;
  private readonly pending: { readonly redirect: Redirect; readonly delimiter: string; readonly strip: boolean }[] = [];
  constructor(
    private readonly text: string,
    private readonly session: Session,
    private depth: number,
  ) {}
  script(): List {
    const list = this.list(new Set(), false);
    if (this.at < this.text.length) this.session.fail('cannot be parsed');
    if (this.pending.length) this.session.fail('has an unterminated here-document');
    return list;
  }
  private peek(offset = 0): string {
    return this.text[this.at + offset] ?? '';
  }
  private starts(token: string): boolean {
    return this.text.startsWith(token, this.at);
  }
  private reserved(): string | undefined {
    return RESERVED.exec(this.text.slice(this.at, this.at + 9))?.[0];
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
  private blank(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.at++;
      else if (c === '\\' && this.peek(1) === '\n') this.at += 2;
      else if (c === '#') {
        const end = this.text.indexOf('\n', this.at);
        this.at = end < 0 ? this.text.length : end;
      } else return;
    }
  }
  /** A newline ends the line; the here-documents it opened follow it. */
  private newline(): void {
    this.at++;
    for (const { redirect, delimiter, strip } of this.pending.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (this.at >= this.text.length) this.session.fail('has an unterminated here-document');
        const end = this.text.indexOf('\n', this.at),
          raw = this.text.slice(this.at, end < 0 ? this.text.length : end),
          line = strip ? raw.replace(/^\t+/, '') : raw;
        this.at = end < 0 ? this.text.length : end + 1;
        if (line.replace(/\r$/, '') === delimiter) break;
        lines.push(line);
        if (end < 0) this.session.fail('has an unterminated here-document');
      }
      redirect.body = lines.join('\n');
    }
  }
  private skipNewlines(): void {
    for (;;) {
      this.blank();
      if (this.peek() !== '\n') return;
      this.newline();
    }
  }
  private expect(word: string): void {
    this.skipNewlines();
    if (this.reserved() !== word) this.session.fail('cannot be parsed');
    this.at += word.length;
  }
  private list(stop: ReadonlySet<string>, paren: boolean, item = false): List {
    const out: Command[][] = [];
    for (;;) {
      this.blank();
      if (this.at >= this.text.length) return out;
      const c = this.peek();
      if (c === '\n') {
        this.newline();
        continue;
      }
      if (c === ';') {
        if (item && /^;(?:;&?|&|\|)/.test(this.text.slice(this.at, this.at + 3))) return out;
        this.at++;
        continue;
      }
      if (c === '&' && !this.starts('&&') && !this.starts('&>')) {
        this.at++;
        continue;
      }
      if (c === ')' && (paren || item)) return out;
      const word = this.reserved();
      if (word !== undefined && stop.has(word)) return out;
      const before = this.at;
      out.push(this.pipeline());
      if (this.at === before) this.session.fail('cannot be parsed');
      this.blank();
      if (this.starts('&&') || this.starts('||')) this.at += 2;
    }
  }
  private pipeline(): Command[] {
    if (this.reserved() === '!') {
      this.at++;
      this.blank();
    }
    if (this.reserved() === 'time') {
      this.at += 4;
      this.blank();
      if (this.starts('-p') && /\s/.test(this.peek(2))) this.at += 2;
      this.blank();
    }
    const commands: Command[] = [];
    for (;;) {
      commands.push(this.command());
      this.blank();
      if (this.peek() !== '|' || this.peek(1) === '|') return commands;
      this.at += this.peek(1) === '&' ? 2 : 1;
      this.skipNewlines();
    }
  }
  private compound(
    type: Compound['type'],
    lists: readonly List[],
    variable?: string,
    items?: readonly Word[],
  ): Compound {
    return { kind: 'compound', type, lists, variable, items, redirects: this.redirects() };
  }
  private command(): Command {
    this.blank();
    if (this.starts('((')) {
      this.arithmetic();
      return this.compound('arith', []);
    }
    if (this.peek() === '(') {
      this.at++;
      const list = this.nested(() => this.list(new Set(), true));
      if (this.peek() !== ')') this.session.fail('cannot be parsed');
      this.at++;
      return this.compound('subshell', [list]);
    }
    const word = this.reserved();
    switch (word) {
      case '{': {
        this.at++;
        const list = this.nested(() => this.list(new Set(['}']), false));
        this.expect('}');
        return this.compound('group', [list]);
      }
      case 'if':
        return this.nested(() => {
          this.at += 2;
          const lists: List[] = [this.list(new Set(['then']), false)];
          this.expect('then');
          lists.push(this.list(new Set(['elif', 'else', 'fi']), false));
          for (let next = this.reserved(); next === 'elif' || next === 'else'; next = this.reserved()) {
            this.at += 4;
            if (next === 'elif') {
              lists.push(this.list(new Set(['then']), false));
              this.expect('then');
              lists.push(this.list(new Set(['elif', 'else', 'fi']), false));
            } else {
              lists.push(this.list(new Set(['fi']), false));
              break;
            }
          }
          this.expect('fi');
          return this.compound('block', lists);
        });
      case 'while':
      case 'until':
        return this.nested(() => {
          this.at += word.length;
          const condition = this.list(new Set(['do']), false);
          this.expect('do');
          const body = this.list(new Set(['done']), false);
          this.expect('done');
          return this.compound('block', [condition, body]);
        });
      case 'for':
      case 'select':
        return this.nested(() => {
          this.at += word.length;
          this.blank();
          let variable: string | undefined, items: Word[] | undefined;
          if (this.starts('((')) this.arithmetic();
          else {
            variable = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.at, this.at + 256))?.[0];
            if (variable === undefined) this.session.fail('cannot be parsed');
            this.at += variable.length;
            this.skipNewlines();
            if (this.reserved() === 'in') {
              this.at += 2;
              items = [];
              for (;;) {
                this.blank();
                const c = this.peek();
                if (!c || c === '\n' || c === ';') break;
                items.push(this.word());
              }
            }
          }
          this.blank();
          if (this.peek() === ';') this.at++;
          this.skipNewlines();
          const close = this.reserved() === '{' ? '}' : 'done';
          this.at += close === '}' ? 1 : 0;
          if (close === 'done') this.expect('do');
          const body = this.list(new Set([close]), false);
          this.expect(close);
          return this.compound('for', [body], variable, items);
        });
      case 'case':
        return this.nested(() => {
          this.at += 4;
          this.blank();
          const items: Word[] = [this.word()],
            lists: List[] = [];
          this.expect('in');
          for (;;) {
            this.skipNewlines();
            if (this.reserved() === 'esac') {
              this.at += 4;
              break;
            }
            if (this.at >= this.text.length) this.session.fail('cannot be parsed');
            if (this.peek() === '(') this.at++;
            for (;;) {
              this.blank();
              items.push(this.word());
              this.blank();
              if (this.peek() !== '|') break;
              this.at++;
            }
            if (this.peek() !== ')') this.session.fail('cannot be parsed');
            this.at++;
            lists.push(this.list(new Set(['esac']), false, true));
            this.blank();
            const end = /^;(?:;&|;|&|\|)/.exec(this.text.slice(this.at, this.at + 3));
            if (end) this.at += end[0].length;
          }
          return this.compound('block', lists, undefined, items);
        });
      case 'function': {
        this.at += 8;
        this.blank();
        this.word();
        this.blank();
        if (this.starts('()')) this.at += 2;
        this.skipNewlines();
        const body = this.nested(() => this.command());
        return {
          kind: 'compound',
          type: 'function',
          lists: [[[body]]],
          variable: undefined,
          items: undefined,
          redirects: [],
        };
      }
      case '[[':
        return this.conditional();
      case 'then':
      case 'elif':
      case 'else':
      case 'fi':
      case 'do':
      case 'done':
      case 'esac':
      case '}':
      case 'in':
        return this.session.fail('cannot be parsed');
      default:
        break;
    }
    const simple = this.simple();
    if (simple.words.length === 1 && !simple.assigns.length && !simple.redirects.length && this.starts('()')) {
      this.at += 2;
      this.skipNewlines();
      const body = this.nested(() => this.command());
      return {
        kind: 'compound',
        type: 'function',
        lists: [[[body]]],
        variable: undefined,
        items: undefined,
        redirects: [],
      };
    }
    return simple;
  }
  /** `[[ … ]]`: its words are operands; `<`, `>` and `(` inside it are operators, not redirections or subshells. */
  private conditional(): Command {
    this.at += 2;
    const words: Word[] = [
      { parts: [{ t: 'text', value: '[[', quoted: false }], raw: '[[', glob: false, brace: false },
    ];
    for (;;) {
      this.blank();
      if (this.at >= this.text.length) this.session.fail('cannot be parsed');
      if (this.starts(']]') && /^(?:$|[\s;&|)])/.test(this.text.slice(this.at + 2, this.at + 3))) {
        this.at += 2;
        break;
      }
      const c = this.peek();
      if (c === '\n') {
        this.newline();
        continue;
      }
      if ('()<>!&|'.includes(c)) {
        this.at += this.starts('&&') || this.starts('||') ? 2 : 1;
        continue;
      }
      words.push(this.word());
    }
    return { kind: 'simple', assigns: [], words, redirects: this.redirects() };
  }
  private arithmetic(): void {
    this.at += 2;
    for (let depth = 1; this.at < this.text.length; this.at++) {
      const c = this.peek();
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 1 && this.peek(1) === ')') {
          this.at += 2;
          return;
        }
        depth--;
      }
    }
    this.session.fail('cannot be parsed');
  }
  private redirects(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      this.blank();
      const redirect = this.redirect();
      if (!redirect) return out;
      out.push(redirect);
    }
  }
  private simple(): Simple {
    const assigns: Assign[] = [],
      words: Word[] = [],
      redirects: Redirect[] = [];
    for (;;) {
      this.blank();
      const c = this.peek();
      if (!c || c === '\n' || c === ';' || c === ')' || c === '|' || (c === '&' && !this.starts('&>'))) break;
      if (c === '(') {
        if (words.length === 1 && !assigns.length) break;
        this.session.fail('cannot be parsed');
      }
      const redirect = this.redirect();
      if (redirect) {
        redirects.push(redirect);
        continue;
      }
      const word = this.word();
      const assign = words.length ? undefined : this.assignment(word);
      if (assign) assigns.push(assign);
      else words.push(word);
    }
    return { kind: 'simple', assigns, words, redirects };
  }
  private assignment(word: Word): Assign | undefined {
    const first = word.parts[0],
      match = first?.t === 'text' && !first.quoted ? /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.value) : null;
    if (!match || first?.t !== 'text') return undefined;
    if (word.raw === match[0] && this.peek() === '(') {
      this.at++;
      const items: Word[] = [];
      for (;;) {
        this.skipNewlines();
        if (this.peek() === ')') {
          this.at++;
          break;
        }
        if (this.at >= this.text.length) this.session.fail('cannot be parsed');
        items.push(this.word());
      }
      return { name: match[1]!, value: undefined, items };
    }
    // Bash expands a `~` that starts an assignment's value, as it does at the start of a word.
    const rest = first.value.slice(match[0].length),
      head: Part[] = /^~(?:\/|$)/.test(rest)
        ? [{ t: 'tilde' }, { t: 'text', value: rest.slice(1), quoted: false }]
        : [{ t: 'text', value: rest, quoted: false }];
    const parts: Part[] = [...head, ...word.parts.slice(1)];
    return { name: match[1]!, value: { ...word, parts, raw: word.raw.slice(match[0].length) }, items: undefined };
  }
  private redirect(): Redirect | undefined {
    const match = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/.exec(
      this.text.slice(this.at, this.at + 48),
    );
    if (!match) return undefined;
    const op = match[1]!;
    if ((op === '<' || op === '>') && this.text[this.at + match[0].length] === '(') return undefined;
    this.at += match[0].length;
    this.blank();
    const target = this.word();
    if (!target.raw) this.session.fail('cannot be parsed');
    if (op !== '<<' && op !== '<<-') return { op, target, body: undefined };
    const redirect: Redirect = { op, target: undefined, body: undefined };
    this.pending.push({
      redirect,
      delimiter: target.parts.map((part) => (part.t === 'text' ? part.value : '')).join(''),
      strip: op === '<<-',
    });
    return redirect;
  }
  private word(): Word {
    this.session.word();
    const start = this.at,
      parts: Part[] = [];
    let text = '',
      quoted = false,
      glob = false,
      brace = false;
    const flush = (): void => {
      if (text) parts.push({ t: 'text', value: text, quoted });
      text = '';
    };
    const add = (value: string, isQuoted: boolean): void => {
      if (text && isQuoted !== quoted) flush();
      quoted = isQuoted;
      text += value;
    };
    const push = (part: Part): void => {
      flush();
      parts.push(part);
    };
    for (;;) {
      PLAIN.lastIndex = this.at;
      const plain = PLAIN.exec(this.text);
      if (plain) {
        add(plain[0], false);
        this.at += plain[0].length;
        continue;
      }
      const c = this.peek();
      if (!c) break;
      if (' \t\r\n;&|)<>('.includes(c)) {
        if ((c === '<' || c === '>') && this.peek(1) === '(') {
          this.at += 2;
          push(this.substitution());
          continue;
        }
        if (c === '(' && !quoted && /[@!?*+]$/.test(text)) {
          const end = this.balanced();
          add(this.text.slice(this.at, end), false);
          this.at = end;
          glob = true;
          continue;
        }
        break;
      }
      if (c === '\\') {
        if (this.peek(1) === '\n') {
          this.at += 2;
          continue;
        }
        add(this.peek(1), true);
        this.at += this.peek(1) ? 2 : 1;
        continue;
      }
      if (c === "'") {
        const end = this.text.indexOf("'", this.at + 1);
        if (end < 0) this.session.fail('has an unterminated quote');
        add(this.text.slice(this.at + 1, end), true);
        this.at = end + 1;
        continue;
      }
      if (c === '"') {
        this.doubleQuoted(add, push);
        continue;
      }
      if (c === '$' && this.peek(1) === "'") {
        add(this.ansi(), true);
        continue;
      }
      if (c === '$' && this.peek(1) === '"') {
        this.at++;
        continue;
      }
      if (c === '$') {
        const part = this.dollar();
        if (part) push(part);
        else {
          add('$', false);
          this.at++;
        }
        continue;
      }
      if (c === '`') {
        push(this.backtick());
        continue;
      }
      if (c === '~' && this.at === start && /^(?:$|[/\s;&|)<>])/.test(this.peek(1))) {
        push({ t: 'tilde' });
        this.at++;
        continue;
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      if (c === '{') brace = true;
      add(c, false);
      this.at++;
    }
    flush();
    return { parts, raw: this.text.slice(start, this.at), glob, brace };
  }
  private balanced(): number {
    for (let at = this.at, depth = 0; at < this.text.length; at++) {
      const c = this.text[at];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return at + 1;
    }
    return this.session.fail('cannot be parsed');
  }
  private doubleQuoted(add: (value: string, quoted: boolean) => void, push: (part: Part) => void): void {
    this.at++;
    for (;;) {
      const c = this.peek();
      if (!c) this.session.fail('has an unterminated quote');
      if (c === '"') {
        this.at++;
        return;
      }
      if (c === '\\') {
        const next = this.peek(1);
        if (next === '\n') {
          this.at += 2;
          continue;
        }
        if (next && '$`"\\'.includes(next)) {
          add(next, true);
          this.at += 2;
          continue;
        }
        add('\\', true);
        this.at++;
        continue;
      }
      if (c === '$') {
        const part = this.dollar();
        if (part) push(part);
        else {
          add('$', true);
          this.at++;
        }
        continue;
      }
      if (c === '`') {
        push(this.backtick());
        continue;
      }
      QUOTED.lastIndex = this.at;
      const run = QUOTED.exec(this.text)![0];
      add(run, true);
      this.at += run.length;
    }
  }
  /** `$'…'`: ANSI-C quoting, with the escapes bash reads. */
  private ansi(): string {
    let out = '';
    for (this.at += 2; ; ) {
      const c = this.peek();
      if (!c) this.session.fail('has an unterminated quote');
      this.at++;
      if (c === "'") return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const next = this.peek();
      this.at++;
      out +=
        (
          {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
            a: '\u0007',
            b: '\b',
            e: '\u001b',
            f: '\f',
            v: '\v',
          } as Record<string, string>
        )[next] ?? '\\' + next;
    }
  }
  private dollar(): Part | undefined {
    const next = this.peek(1);
    if (next === '(' && this.peek(2) === '(') {
      this.at++;
      this.arithmetic();
      return { t: 'unknown' };
    }
    if (next === '(') {
      this.at += 2;
      return this.substitution();
    }
    if (next === '[') {
      const end = this.text.indexOf(']', this.at);
      if (end < 0) this.session.fail('cannot be parsed');
      this.at = end + 1;
      return { t: 'unknown' };
    }
    if (next === '{') {
      let depth = 0,
        end = this.at + 1;
      for (; end < this.text.length; end++) {
        const c = this.text[end];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      if (end >= this.text.length) this.session.fail('has an unterminated quote');
      const inner = this.text.slice(this.at + 2, end);
      this.at = end + 1;
      const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:$|:?[-=?+])/.exec(inner)?.[1];
      return name === undefined ? { t: 'unknown' } : { t: 'var', name };
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(this.text.slice(this.at + 1, this.at + 257))?.[0];
    if (name === undefined) return undefined;
    this.at += 1 + name.length;
    return { t: 'var', name };
  }
  private substitution(): Part {
    const list = this.nested(() => this.list(new Set(), true));
    if (this.peek() !== ')') this.session.fail('has an unterminated command substitution');
    this.at++;
    return { t: 'sub', list };
  }
  private backtick(): Part {
    let inner = '';
    for (this.at++; ; ) {
      const c = this.peek();
      if (!c) this.session.fail('has an unterminated command substitution');
      if (c === '`') {
        this.at++;
        break;
      }
      if (c === '\\' && this.peek(1) && '$`\\'.includes(this.peek(1))) {
        inner += this.peek(1);
        this.at += 2;
        continue;
      }
      inner += c;
      this.at++;
    }
    return { t: 'sub', list: this.nested(() => new Parser(inner, this.session, this.depth).script()) };
  }
}

/** What a command or list did: whether anything in it may write, and the paths its commands name (for pipes and substitutions). */
interface Outcome {
  readonly kind: Kind;
  readonly names: readonly Target[];
  readonly output?: string | undefined;
  readonly produces?: boolean;
}
const merge = (outcomes: readonly Outcome[]): Outcome => ({
  kind: outcomes.some((outcome) => outcome.kind !== 'read') ? 'write' : 'read',
  names: outcomes.flatMap((outcome) => outcome.names),
});

export const analyzeBash: Analyzer = (text, session, state, depth) => {
  run(new Parser(text, session, depth).script(), session, state, depth, [], false);
};

/** `want`: whether the caller uses the paths the commands name (a pipe or a substitution reads them); else they are not placed. */
function run(
  list: List,
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
  want: boolean,
): Outcome {
  return merge(list.map((pipeline) => line(pipeline, session, state, depth, piped, want)));
}
/** One pipeline: paths an element names reach the later elements; a writer among them is taken to write those paths. */
function line(
  pipeline: readonly Command[],
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
  want: boolean,
): Outcome {
  let carried: readonly Target[] = piped,
    text: string | undefined;
  const outcomes: Outcome[] = [];
  for (const [index, command] of pipeline.entries()) {
    const last = index === pipeline.length - 1,
      own = pipeline.length > 1 && !last ? state.fork() : state;
    const outcome = element(command, session, own, depth, carried, index > 0 ? text : undefined, want || !last);
    if (outcome.kind !== 'read' && carried.length)
      session.writes.push(...carried.map((target) => ({ path: target.path, tree: true })));
    if (command.kind === 'compound' || outcome.produces) carried = [...carried, ...outcome.names];
    text = outcome.output;
    outcomes.push(outcome);
  }
  return merge(outcomes);
}
const literalWord = (word: Word | undefined): Arg | undefined => {
  if (!word || word.parts.some((part) => part.t !== 'text')) return undefined;
  const value = word.parts.map((part) => (part.t === 'text' ? part.value : '')).join('');
  return literal(value);
};
function element(
  command: Command,
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
  text: string | undefined,
  want: boolean,
): Outcome {
  if (command.kind === 'simple') return simple(command, session, state, depth, piped, text, want);
  redirects(command.redirects, session, state, depth);
  switch (command.type) {
    case 'arith':
      return { kind: 'read', names: [] };
    case 'subshell':
      return run(command.lists[0] ?? [], session, state.fork(), depth, piped, want);
    case 'for': {
      if (command.variable !== undefined) {
        // Known words (globs expanded as bash expands them) give the variable each value; a word built at run time, its names.
        const args = (command.items ?? []).flatMap((word) => expand(word, session, state, depth));
        const values = args.every((arg) => arg.value !== undefined)
          ? args.flatMap((arg) =>
              arg.pattern !== undefined && state.cwd !== undefined
                ? session.glob(arg.pattern, state.cwd)
                : [arg.value!],
            )
          : undefined;
        state.vars.set(
          command.variable,
          values !== undefined && values.length <= ALTERNATIVES
            ? { value: values.length === 1 ? values[0] : undefined, names: [], values }
            : { value: undefined, names: args.flatMap((arg) => named(arg, session, state, depth)) },
        );
      }
      return run(command.lists[0] ?? [], session, state, depth, piped, want);
    }
    default:
      for (const word of command.items ?? []) expand(word, session, state, depth);
      return merge(command.lists.map((list) => run(list, session, state, depth, piped, want)));
  }
}
/** Output redirections are writes; input ones feed the command. Each target word is expanded where it stands. */
function redirects(
  list: readonly Redirect[],
  session: Session,
  state: State,
  depth: number,
): { text?: string | undefined; file?: Arg | undefined } {
  let input: { text?: string | undefined; file?: Arg | undefined } = {};
  for (const redirect of list) {
    if (redirect.target === undefined) {
      input = { text: redirect.body ?? '' };
      continue;
    }
    const [target] = expand(redirect.target, session, state, depth);
    if (target === undefined) continue;
    if (redirect.op === '<<<') {
      input = { text: target.value ?? target.raw };
      continue;
    }
    if (redirect.op === '<') {
      input = { file: target };
      continue;
    }
    if (redirect.op === '<&' || (redirect.op === '>&' && /^(?:\d+-?|-)$/.test(target.value ?? ''))) continue;
    const paths = session.io(state, depth).paths(target, false);
    if (paths === undefined) session.fail(UNKNOWN_CWD);
    session.writes.push(...paths);
  }
  return input;
}
function simple(
  command: Simple,
  session: Session,
  state: State,
  depth: number,
  piped: readonly Target[],
  text: string | undefined,
  want: boolean,
): Outcome {
  for (const assign of command.assigns) {
    if (assign.items) {
      state.vars.set(assign.name, {
        value: undefined,
        names: assign.items
          .flatMap((word) => expand(word, session, state, depth))
          .flatMap((arg) => named(arg, session, state, depth)),
      });
      continue;
    }
    const [arg] = assign.value ? expand(assign.value, session, state, depth) : [literal('')];
    state.vars.set(assign.name, { value: arg?.value, names: arg ? (arg.value === undefined ? arg.names : []) : [] });
  }
  const args = command.words.flatMap((word) => expand(word, session, state, depth));
  const input = redirects(command.redirects, session, state, depth);
  const name = program(args[0]);
  if (name === undefined && !args.length) return { kind: 'read', names: [] };
  if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'readonly') {
    for (const arg of args.slice(1)) {
      const match = arg.value === undefined ? null : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg.value);
      if (match) state.vars.set(match[1]!, { value: match[2], names: [] });
    }
  }
  if (name === 'read')
    for (const arg of args.slice(1))
      if (arg.value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.value))
        state.vars.set(arg.value, { value: undefined, names: piped });
  const io = session.io(state, depth, input.text !== undefined || input.file ? input : { text, file: undefined });
  const kind = native(args, io);
  const produces = producesPaths(args),
    names =
      !want || !produces
        ? []
        : args
            .slice(1)
            .filter((arg) => !arg.value?.startsWith('-'))
            .flatMap((arg) => named(arg, session, state, depth));
  return { kind, names, output: output(name, args, session, state), produces };
}
/** The output of a command whose output the guard can tell: pwd, echo, printf %s, dirname, basename, realpath, git's top level. */
function output(name: string | undefined, args: readonly Arg[], session: Session, state: State): string | undefined {
  const values = args.slice(1).map((arg) => arg.value);
  if (values.some((value) => value === undefined)) return undefined;
  const known = values as string[];
  switch (name) {
    case 'pwd':
      return state.cwd;
    case 'echo':
      return known.filter((value) => !/^-[neE]+$/.test(value)).join(' ');
    case 'printf':
      return known[0] === '%s' || known[0] === '%s\\n'
        ? known.slice(1).join('')
        : known.length === 1 && !known[0]!.includes('%')
          ? known[0]
          : undefined;
    case 'dirname':
      return known.length === 1 ? dirname(known[0]!) : undefined;
    case 'realpath':
    case 'readlink': {
      const path = known.filter((value) => !value.startsWith('-')).at(-1);
      return path === undefined || state.cwd === undefined ? undefined : resolve(state.cwd, path);
    }
    case 'git':
      return known.includes('rev-parse') && known.includes('--show-toplevel') && state.cwd !== undefined
        ? session.worktree(state.cwd)
        : undefined;
    default:
      return undefined;
  }
}
/** The paths one word names, as a tree when it was built at run time; nothing for a relative word with no known directory. */
function named(arg: Arg, session: Session, state: State, depth: number): Target[] {
  if (arg.value === undefined) return arg.names.map((name) => ({ path: name.path, tree: true }));
  const prefix =
    arg.pattern === undefined ? arg.value : arg.value.slice(0, arg.value.search(/[*?[]/)).replace(/[^/\\]*$/, '');
  return [...(session.io(state, depth).paths(literal(prefix || '.'), true) ?? [])];
}
/** A word after expansion: one Arg per brace alternative. Command substitutions run here, so their effects count. */
function expand(word: Word, session: Session, state: State, depth: number): Arg[] {
  // One alternative per value of a variable that ranges over known words, within the shared bound.
  let alternatives = [{ value: '', pattern: '' }],
    known = true,
    computed = false;
  const names: Target[] = [];
  const append = (value: string, pattern = escaped(value)): void => {
    for (const alternative of alternatives) {
      alternative.value += value;
      alternative.pattern += pattern;
    }
  };
  for (const part of word.parts) {
    if (part.t === 'text') {
      append(part.value, part.quoted ? escaped(part.value) : part.value);
      continue;
    }
    if (part.t === 'tilde') {
      append(session.scope.home);
      continue;
    }
    const result =
      part.t === 'unknown'
        ? undefined
        : part.t === 'var'
          ? session.variable(state, part.name)
          : substitute(part.list, session, state, depth);
    if (result?.value !== undefined) {
      append(result.value);
      continue;
    }
    const values = result !== undefined && 'values' in result ? result.values : undefined;
    if (values?.length && alternatives.length * values.length <= ALTERNATIVES) {
      alternatives = alternatives.flatMap((alternative) =>
        values.map((each) => ({ value: alternative.value + each, pattern: alternative.pattern + escaped(each) })),
      );
      continue;
    }
    if (alternatives.every((alternative) => alternative.value === '')) computed = true;
    known = false;
    names.push(
      ...(result?.names ?? []),
      ...(values ?? []).flatMap((each) => named(literal(each), session, state, depth)),
    );
  }
  if (!known) {
    // A word that starts with a part known only at run time (`$ROOT/.ia/…`) and goes on to spell a protected location is
    // taken as that location in the project.
    const tail = computed
      ? /^[\\/]?((?:\.ia|\.claude|\.agents|\.codex)(?:[\\/].*)?|CLAUDE\.md|AGENTS\.md)$/.exec(
          alternatives[0]!.value,
        )?.[1]
      : undefined;
    if (tail !== undefined) names.push({ path: join(session.scope.root, tail), tree: false });
    return [{ raw: word.raw, value: undefined, names }];
  }
  return alternatives.flatMap(({ value, pattern }) => {
    const values = word.brace ? braces(value) : [value],
      patterns = word.brace ? braces(pattern) : [pattern];
    return values.map((each, at) => ({
      raw: word.raw,
      value: each,
      pattern: word.glob ? (patterns[at] ?? each) : undefined,
      names: [],
    }));
  });
}
/** A command substitution: it runs (its effects count) in a copy of the state; its output is known only for simple commands. */
function substitute(
  list: List,
  session: Session,
  state: State,
  depth: number,
): { value: string | undefined; names: readonly Target[] } {
  const inner = state.fork(),
    outcome = run(list, session, inner, depth, [], true);
  // The output is known for one simple command, or for a list ending in `pwd` (as in `$(cd x && pwd)`).
  const last = list.at(-1)?.at(-1),
    single = list.length === 1 && list[0]?.length === 1;
  const value =
    last?.kind === 'simple' && (single || (last.words.length === 1 && literalWord(last.words[0])?.value === 'pwd'))
      ? simpleOutput(last, session, inner, depth)
      : undefined;
  return { value, names: outcome.names };
}
function simpleOutput(command: Simple, session: Session, state: State, depth: number): string | undefined {
  if (command.words.some((word) => word.parts.some((part) => part.t === 'sub'))) return undefined;
  const args = command.words.flatMap((word) => expand(word, session, state, depth));
  return output(program(args[0]), args, session, state);
}
