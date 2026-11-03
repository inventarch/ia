/**
 * Terminal presentation primitives for the consumer CLI: docs/specs/consumer-cli-contract/README.md §6.
 * The environment is a parameter; platform-specific path spelling follows the running platform. No function reads
 * process.env, process.stdout or a clock.
 */

import { inertCommandRoot } from '@inventarch/runtime';
import { parseRegistryBase } from '@inventarch/distribution/registry';
import { isAbsolute, relative, resolve } from 'node:path';
import { stringWidth } from './console/width.js';

export type Role = 'bold' | 'dim' | 'red' | 'yellow' | 'green' | 'cyan';
export type SymbolName =
  | 'success'
  | 'error'
  | 'warning'
  | 'unknown'
  | 'info'
  | 'step'
  | 'added'
  | 'removed'
  | 'updated'
  | 'setup'
  | 'unreported';
export type Depth = 0 | 1 | 2;

export interface Terminal {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  /** undefined whenever stdout is not a TTY; measured on Windows for pipes, file redirection and a real console. */
  readonly columns?: number | undefined;
}
export interface RenderFlags {
  readonly color?: boolean | undefined;
  readonly ascii?: boolean | undefined;
  readonly json?: boolean | undefined;
}
export interface Capabilities {
  readonly color: boolean;
  readonly ascii: boolean;
  readonly width: number;
}

/** 80 is the ceiling; below 40 a label/value block drops its value column; below 60 header pairs split. */
export const MAX_WIDTH = 80;
export const NARROW_WIDTH = 40;
export const HEADER_WIDTH = 60;
/** A bare digest field shows 12 hex characters and an explicit ellipsis. */
export const DIGEST_CHARACTERS = 12;

const UTF8 = /utf-?8/i;
const LOCALE_NAMES = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const;

/** §6's colour precedence and ASCII rule, resolved from an explicit environment rather than from the process. */
export function resolveCapabilities(terminal: Terminal, flags: RenderFlags = {}): Capabilities {
  const env = terminal.env,
    force = env['FORCE_COLOR'];
  const color =
    env['NO_COLOR'] !== undefined
      ? false
      : flags.color === false
        ? false
        : flags.json === true
          ? false
          : flags.color === true || (force !== undefined && force !== '0')
            ? true
            : terminal.isTTY && env['TERM'] !== 'dumb';
  const locales = LOCALE_NAMES.map((name) => env[name]).filter((value): value is string => value !== undefined);
  const ascii =
    flags.ascii === true ||
    env['IA_ASCII'] !== undefined ||
    (locales.length > 0 && !locales.some((value) => UTF8.test(value)));
  const columns = terminal.columns;
  const sized = terminal.isTTY && typeof columns === 'number' && Number.isInteger(columns) && columns > 0;
  return { color, ascii, width: sized ? Math.min(columns as number, MAX_WIDTH) : MAX_WIDTH };
}

const SGR: Readonly<Record<Role, string>> = { bold: '1', dim: '2', red: '31', yellow: '33', green: '32', cyan: '36' };

/** A styled run is reset at its end and never left open across a newline, so each line is styled on its own. */
export function style(text: string, role: Role | null | undefined, color: boolean): string {
  if (!color || !role) return text;
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `\u001b[${SGR[role]}m${line}\u001b[0m`))
    .join('\n');
}

export interface StatusSymbol {
  readonly text: string;
  readonly width: number;
  readonly role: Role | null;
}
interface SymbolDefinition {
  readonly unicode: string;
  readonly ascii: string;
  readonly role: Role | null;
}
const SYMBOLS: Readonly<Record<SymbolName, SymbolDefinition>> = {
  success: { unicode: '✔', ascii: '[ok]', role: 'green' },
  error: { unicode: '✖', ascii: '[error]', role: 'red' },
  warning: { unicode: '▲', ascii: '[warn]', role: 'yellow' },
  unknown: { unicode: '?', ascii: '[?]', role: null },
  info: { unicode: '•', ascii: '*', role: null },
  step: { unicode: '→', ascii: '->', role: null },
  added: { unicode: '+', ascii: '+', role: 'green' },
  removed: { unicode: '-', ascii: '-', role: null },
  updated: { unicode: '~', ascii: '~', role: null },
  // The console's area states: not set up, and a row a copy does not report.
  setup: { unicode: '○', ascii: 'o', role: null },
  unreported: { unicode: '—', ascii: '-', role: 'dim' },
};
/** Every symbol is one UTF-16 unit per display column, so length is its display width; no emoji is admitted. */
export function statusSymbol(name: SymbolName, ascii: boolean): StatusSymbol {
  const definition = SYMBOLS[name],
    text = ascii ? definition.ascii : definition.unicode;
  return { text, width: text.length, role: definition.role };
}

/** A wrap unit. `gap` is the spacing that precedes it when it stays on the current line; a line start drops the gap. */
export interface Token {
  readonly text: string;
  readonly gap: number;
  readonly role: Role | null;
}
/** One unbreakable run: an identity, path, package id, digest, URL or a command that must stay copy-pasteable. */
export const atom = (text: string, role: Role | null = null, gap = 1): Token => ({ text, gap, role });
/** Prose, split at word boundaries; runs of spaces inside the text are preserved as wider gaps. */
export function words(text: string, role: Role | null = null, gap = 1): readonly Token[] {
  const tokens: Token[] = [];
  let pending = 0;
  for (const part of text.split(' ')) {
    if (part === '') {
      if (tokens.length > 0) pending += 1;
      continue;
    }
    tokens.push({ text: part, gap: tokens.length === 0 ? gap : pending + 1, role });
    pending = 0;
  }
  return tokens;
}
/** A command quoted in prose: a program this CLI names and its arguments, one with a space JSON-quoted (`quote`). */
const QUOTED_COMMAND = /"(?:ia|ia-distribution|pnpm)(?: (?:"(?:[^"\\]|\\.)*"|[^\s"]+))*"/g;
/**
 * For prose that quotes a command, such as a refusal's next action: the words wrap as `words` splits them, and
 * each quoted command, with the punctuation touching it, is one `atom`, so a line break never falls inside the command
 * and it stays copy-pasteable, overrunning the width when it must.
 */
export function remedyWords(text: string, role: Role | null = null, gap = 1): readonly Token[] {
  const tokens: Token[] = [];
  const lead = (): number => (tokens.length === 0 ? gap : 1);
  let at = 0;
  for (const match of text.matchAll(QUOTED_COMMAND)) {
    if (match.index < at) continue;
    const start = Math.max(text.lastIndexOf(' ', match.index) + 1, at),
      space = text.indexOf(' ', match.index + match[0].length),
      end = space === -1 ? text.length : space;
    tokens.push(...words(text.slice(at, start), role, lead()));
    tokens.push(atom(text.slice(start, end), role, lead()));
    at = end;
  }
  tokens.push(...words(text.slice(at), role, lead()));
  return tokens;
}

/**
 * Words wrap at the effective width, measured in display columns (console/width.ts); a token is never split, so an over-wide identifier overruns its line whole.
 * `firstColumn` differs from `column` only where a value starts past its label and then hangs back at the entry's
 * content column.
 */
export function wrapTokens(
  tokens: readonly Token[],
  column: number,
  caps: Capabilities,
  firstColumn = column,
): readonly string[] {
  const lines: string[] = [];
  let plain = '',
    styled = '',
    open = false;
  for (const token of tokens) {
    const text = style(token.text, token.role, caps.color);
    if (!open) {
      plain = token.text;
      styled = text;
      open = true;
      continue;
    }
    const gap = ' '.repeat(token.gap);
    if (
      (lines.length === 0 ? firstColumn : column) + stringWidth(plain) + gap.length + stringWidth(token.text) <=
      caps.width
    ) {
      plain += gap + token.text;
      styled += gap + text;
      continue;
    }
    lines.push(styled);
    plain = token.text;
    styled = text;
  }
  if (open) lines.push(styled);
  return lines;
}

export interface Placement {
  readonly depth?: Depth | undefined;
  /** An explicit symbol column, used for an action nested at its parent's content column. Overrides `depth`. */
  readonly column?: number | undefined;
}
export interface EntryOptions extends Placement {
  readonly symbol?: SymbolName | undefined;
  /**
   * The width of the widest symbol in this block, so every row of a block shares one content column.
   * It never reaches a nested action, whose column is `parent + width(its own symbol) + 2`.
   */
  readonly symbolWidth?: number | undefined;
}

/** A block's indent: two spaces per depth. */
export const indentOf = (depth: Depth): number => 2 * depth;
/** The widest symbol of a block, which the whole block's content column is measured from. */
export const blockSymbolWidth = (names: readonly (SymbolName | undefined)[], ascii: boolean): number =>
  Math.max(0, ...names.map((name) => (name === undefined ? 0 : statusSymbol(name, ascii).width)));
/** Content column: `2·d + width + 2`, where width is the block's widest symbol and never less than this row's own. */
export const contentColumn = (base: number, symbol: StatusSymbol | null, symbolWidth = 0): number =>
  base + (symbol === null ? 0 : Math.max(symbolWidth, symbol.width) + 2);
export const entryColumn = (options: EntryOptions, ascii: boolean): number =>
  contentColumn(
    options.column ?? indentOf(options.depth ?? 0),
    options.symbol === undefined ? null : statusSymbol(options.symbol, ascii),
    options.symbolWidth ?? 0,
  );

/**
 * One entry: block indent, the status symbol, two spaces, then its facts. Every continuation — a wrapped line
 * or a further fact — hangs at the entry's content column.
 */
export function entry(
  facts: readonly (readonly Token[])[],
  options: EntryOptions,
  caps: Capabilities,
): readonly string[] {
  const base = options.column ?? indentOf(options.depth ?? 0);
  const symbol = options.symbol === undefined ? null : statusSymbol(options.symbol, caps.ascii);
  const column = contentColumn(base, symbol, options.symbolWidth ?? 0);
  const prefix =
    ' '.repeat(base) +
    (symbol === null ? '' : style(symbol.text, symbol.role, caps.color) + ' '.repeat(column - base - symbol.width));
  const hanging = ' '.repeat(column);
  const lines = facts.flatMap((fact) => wrapTokens(fact, column, caps));
  return lines.map((line, index) => (index === 0 ? prefix : hanging) + line);
}

export interface Field {
  readonly label: string;
  readonly value: readonly Token[];
  readonly symbol?: SymbolName | undefined;
  /** A next action nested under this row, at the row's content column. */
  readonly action?: readonly Token[] | null | undefined;
  /**
   * Further prose about this row, on its own lines under it and hanging at the block's value column (two past the
   * content column when the block drops its value column), so it never starts where labels start.
   */
  readonly note?: readonly Token[] | null | undefined;
}
/**
 * One value column per block at `max(len(label)) + 2`, never shared across a blank line, over the block's one
 * content column. A value that wraps hangs at the entry's content column, not the value column. Below 40 columns,
 * or when the padding would leave no room for a value, the block drops the
 * value column and each field renders as `label  value`.
 */
export function fieldRows(fields: readonly Field[], options: Placement, caps: Capabilities): readonly string[] {
  const pad = Math.max(0, ...fields.map((field) => field.label.length)) + 2;
  const base = options.column ?? indentOf(options.depth ?? 0);
  const symbolWidth = blockSymbolWidth(
    fields.map((field) => field.symbol),
    caps.ascii,
  );
  const column = base + (symbolWidth === 0 ? 0 : symbolWidth + 2);
  const degraded = caps.width < NARROW_WIDTH || column + pad >= caps.width;
  return fields.flatMap((field) => {
    const placement: EntryOptions = { ...options, symbol: field.symbol, symbolWidth };
    const symbol = field.symbol === undefined ? null : statusSymbol(field.symbol, caps.ascii);
    const prefix =
      ' '.repeat(base) +
      (symbol === null ? '' : style(symbol.text, symbol.role, caps.color) + ' '.repeat(column - base - symbol.width));
    const value = degraded ? [] : wrapTokens(field.value, column, caps, column + pad);
    const rows = degraded
      ? entry(
          [
            [
              atom(field.label, null, 0),
              ...field.value.map((token, index) => (index === 0 ? { ...token, gap: 2 } : token)),
            ],
          ],
          placement,
          caps,
        )
      : value.length === 0
        ? [prefix + field.label]
        : value.map((line, index) => (index === 0 ? prefix + field.label.padEnd(pad) : ' '.repeat(column)) + line);
    const noteColumn = degraded ? column + 2 : column + pad;
    const notes = field.note
      ? wrapTokens(field.note, noteColumn, caps).map((line) => ' '.repeat(noteColumn) + line)
      : [];
    const noted = [...rows, ...notes];
    return field.action ? [...noted, ...entry([field.action], { column, symbol: 'step' }, caps)] : noted;
  });
}

export interface HeaderItem {
  readonly text: string;
  /** The column this item starts at; only the minimum gap of four spaces is fixed. */
  readonly column?: number | undefined;
}
/** Bold label, two spaces, value; further pairs share the line until the width drops below 60. */
export function headerLine(
  label: string,
  value: string,
  trailing: readonly HeaderItem[],
  caps: Capabilities,
): readonly string[] {
  const head = style(label, 'bold', caps.color) + '  ' + value;
  if (caps.width < HEADER_WIDTH) return [head, ...trailing.map((item) => item.text)];
  let visible = label.length + 2 + value.length,
    line = head;
  for (const item of trailing) {
    const start = Math.max(item.column ?? visible + 4, visible + 4);
    line += ' '.repeat(start - visible) + item.text;
    visible = start + item.text.length;
  }
  return [line];
}

export const sectionLabel = (text: string, caps: Capabilities): string => style(text, 'bold', caps.color);

export interface DocumentOptions {
  /** Report blocks open with one blank line; the standalone error blocks do not. */
  readonly leadingBlank?: boolean | undefined;
}
/** Exactly one blank line between blocks, never two, and no trailing blank before the process exits. */
export function document(blocks: readonly (readonly string[])[], options: DocumentOptions = {}): string {
  const body = blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n');
  if (body === '') return '';
  return (options.leadingBlank === true ? '\n' : '') + body + '\n';
}

/**
 * One argument of a printed command, quoted only when a space or a quote would split or end it, so an invocation
 * rebuilt from parsed arguments is the one a reader can paste back.
 */
export const quote = (value: string): string => (/[ "]/.test(value) ? JSON.stringify(value) : value);
/** A generated, quoted next command, whose argument strings use JSON quoting rather than shell escapes. */
export const ADVICE_COMMAND = /"(ia(?: (?:"(?:[^"\\]|\\.)*"|[^\s"]+))*)"/;
/** Decode generated command arguments in one pass, avoiding repeated regex scans over escaped quotes. */
export function commandArguments(body: string): string[] {
  const argv: string[] = [];
  let at = 0;
  while (at < body.length) {
    if (/\s/.test(body[at]!)) at += 1;
    else if (body[at] === '"') {
      let end = at + 1;
      while (end < body.length && body[end] !== '"') end += body[end] === '\\' ? 2 : 1;
      argv.push(JSON.parse(body.slice(at, end + 1)) as string);
      at = end + 1;
    } else {
      let end = at;
      while (end < body.length && body[end] !== '"' && !/\s/.test(body[end]!)) end += 1;
      argv.push(body.slice(at, end));
      at = end;
    }
  }
  return argv;
}
/** Only printed guidance uses this context; invocation inputs and machine argument vectors remain unchanged. */
export interface AdviceContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The remedy deliberately asks the caller to choose a different registry. */
  readonly registryIntent?: 'reselect' | undefined;
}
function registryAdvice(
  command: string,
  destinations: readonly string[],
  context: AdviceContext,
): { readonly command: string; readonly manual?: string } {
  const argv = commandArguments(command),
    verb = argv[1],
    end = argv.indexOf('--'),
    options = argv.slice(2, end === -1 ? undefined : end),
    option = (name: string): string | undefined => {
      const at = options.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
      return at === -1
        ? undefined
        : options[at] === `--${name}`
          ? options[at + 1]
          : options[at]!.slice(name.length + 3);
    };
  if (
    context.registryIntent === 'reselect' ||
    options.includes('--help') ||
    options.includes('-h') ||
    !(
      verb === 'doctor' ||
      verb === 'adopt' ||
      (verb === 'init' &&
        option('adopt') !== undefined &&
        !options.includes('--migrate') &&
        !options.includes('--forget-decline') &&
        option('decline') === undefined) ||
      (['install', 'update', 'restore'].includes(verb ?? '') &&
        option('catalog') === undefined &&
        !options.includes('--offline'))
    )
  )
    return { command };
  const flag = option('registry'),
    value = flag ?? context.env['IA_REGISTRY'];
  if (!value || value === '<url|dir>') return { command };
  let selected: ReturnType<typeof parseRegistryBase>;
  try {
    selected = parseRegistryBase(value, context.cwd);
  } catch {
    return { command };
  } // Advice must not replace the original refusal or repair an invalid input by choosing another source.
  if (selected.kind !== 'dir' || isAbsolute(value)) return { command };
  if (destinations.every((destination) => resolve(destination) === resolve(context.cwd))) return { command };
  const spellings = [
      selected.path,
      ...(destinations.length === 1 ? [relative(destinations[0]!, selected.path) || '.'] : []),
    ],
    safe = spellings
      .map((path) => (path.startsWith('-') ? `./${path}` : path))
      .map((path) => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path))
      .find(inertCommandRoot);
  if (verb === 'doctor' || safe === undefined)
    return {
      command: `ia ${verb} --help`,
      manual: `Before retrying from the workspace root, preserve the selected registry directory ${JSON.stringify(selected.path)} using ${verb === 'doctor' || flag === undefined ? 'IA_REGISTRY' : 'the registry option'} with an absolute location or a safe alias to that same directory. The operation is omitted until that setting is restored.`,
    };
  const at = argv.findIndex(
    (arg, index) => index > 1 && (end === -1 || index < end) && (arg === '--registry' || arg.startsWith('--registry=')),
  );
  if (at === -1) argv.splice(end === -1 ? argv.length : end, 0, '--registry', safe);
  else argv.splice(at, argv[at] === '--registry' ? 2 : 1, '--registry', safe);
  return { command: argv.map(quote).join(' ') };
}
const replaceArgument = (text: string, from: string, to: string): string => {
  let result = '',
    start = 0;
  for (;;) {
    const at = text.indexOf(from, start);
    if (at === -1) return result + text.slice(start);
    const end = at + from.length;
    const complete =
      end === text.length ||
      /[\s"]/.test(text[end]!) ||
      (text[end] === '.' && (end + 1 === text.length || /[\s"]/.test(text[end + 1]!)));
    result += text.slice(start, at) + (complete ? to : from);
    start = end;
  }
};
/**
 * Repair root arguments from known input, not by parsing shell text. JSON quoting does not neutralize shell syntax.
 * The root stays available as diagnostic data; only command suggestions use `.` and name its required cwd.
 */
function rewriteRootCommand(
  text: string,
  roots: readonly (string | undefined)[],
  context?: AdviceContext,
  plain = false,
): { readonly text: string; readonly rootOmitted: boolean; readonly manual: readonly string[] } {
  let next = text,
    rootOmitted = false;
  const omitted: string[] = [];
  for (const root of [...new Set(roots)]
    .filter((root): root is string => root !== undefined)
    .sort((a, b) => b.length - a.length)) {
    const inert = inertCommandRoot(root),
      target = commandRootTarget(root),
      before = next;
    if (target === root) continue;
    for (const value of new Set([quote(root), JSON.stringify(root)])) {
      next = replaceArgument(
        replaceArgument(next, `--root ${value}`, `--root ${quote(target)}`),
        `ia init ${value}`,
        `ia init ${quote(target)}`,
      );
      next = replaceArgument(next, `ia init -- ${value}`, `ia init -- ${quote(target)}`);
    }
    if (root.startsWith('-'))
      next = replaceArgument(
        next,
        `ia init ${quote(`./${root}`)}`,
        `ia init ${quote(target.startsWith('-') ? `./${target}` : target)}`,
      );
    if (!inert && next !== before) {
      rootOmitted = true;
      omitted.push(root);
    }
  }
  const manual: string[] = [];
  if (rootOmitted && context !== undefined) {
    const destinations = [...new Set(omitted.map((root) => resolve(context.cwd, root)))],
      repair = (command: string): string => {
        const repaired = registryAdvice(command, destinations, context);
        if (repaired.manual !== undefined) manual.push(repaired.manual);
        return repaired.command;
      };
    next = plain
      ? repair(next)
      : next.replace(new RegExp(ADVICE_COMMAND.source, 'g'), (_match, command: string) => `"${repair(command)}"`);
  }
  return { text: next, rootOmitted, manual };
}
/**
 * The spelling `root` takes in a printed command: itself, with forward slashes on Windows, while every character in it
 * is inert unquoted; otherwise `.`, and the command is run from the workspace root.
 */
const commandRootTarget = (root: string): string =>
  inertCommandRoot(root) ? (process.platform === 'win32' ? root.replaceAll('\\', '/') : root) : '.';
/**
 * `rewriteRootCommand` over an argv rather than text: each root in it (a `--root` value, or `ia init`'s directory)
 * spelled as `commandRootTarget` spells it, so a fix runs the command its remedy prints.
 */
export function safeRootArgv(argv: readonly string[], roots: readonly (string | undefined)[]): readonly string[] {
  const known = [...new Set(roots)]
    .filter((root): root is string => root !== undefined)
    .sort((a, b) => b.length - a.length);
  const map = (token: string, dotted: boolean): string => {
    for (const root of known) {
      const target = commandRootTarget(root);
      if (token === root) return target;
      if (dotted && root.startsWith('-') && token === `./${root}`)
        return target.startsWith('-') ? `./${target}` : target;
    }
    return token;
  };
  const init = argv[0] === 'init',
    separator = argv.indexOf('--');
  return argv.map((token, index) => {
    if (index > 0 && argv[index - 1] === '--root') return map(token, false);
    if (token.startsWith('--root=')) return `--root=${map(token.slice('--root='.length), false)}`;
    if (init && token !== '--' && (index === 1 || (separator === 1 && index === 2))) return map(token, true);
    return token;
  });
}
export function safeRootCommand(text: string, roots: readonly (string | undefined)[], context?: AdviceContext): string {
  return rewriteRootCommand(text, roots, context, true).text;
}
export function safeRootAdvice(text: string, roots: readonly (string | undefined)[], context?: AdviceContext): string {
  const next = rewriteRootCommand(text, roots, context);
  return [next.text, ...(next.rootOmitted ? [ROOT_CWD] : []), ...next.manual].join(' ');
}
const ROOT_CWD =
  'Run the suggested commands from the workspace root; its path is omitted because it contains shell syntax.';
/**
 * Scalar terminal controls (C0, DEL and C1) in source-derived text, escaped as `\uXXXX` before layout and colour, so an
 * authored string cannot move the cursor, clear the screen or forge colour; generated newlines and SGR remain
 * presentation-owned.
 */
export const terminalText = (text: string): string =>
  text.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
/** `value` with every string in it, at any depth, escaped as `terminalText` escapes one, for a renderer to lay out. */
export function terminalSafe<T>(value: T): T {
  if (typeof value === 'string') return terminalText(value) as T;
  if (Array.isArray(value)) return value.map(terminalSafe) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, terminalSafe(child)])) as T;
  return value;
}

/** A command is unbreakable prose. The caller chooses the `\` break so every line stays runnable. */
export function commandFacts(
  lead: string,
  command: string,
  tail: string,
  column: number,
  caps: Capabilities,
  roots: readonly (string | undefined)[] = [],
  context?: AdviceContext,
): readonly (readonly Token[])[] {
  const safe = rewriteRootCommand(command, roots, context, true);
  const lines: string[] = [];
  let current = '';
  for (const piece of safe.text.split(' ')) {
    // The lead is glued to the first word, so the quoted command starts where the quote ends.
    const candidate = current === '' ? lead + piece : `${current} ${piece}`;
    if (current !== '' && column + candidate.length + 2 > caps.width) {
      lines.push(`${current} \\`);
      current = piece;
    } else current = candidate;
  }
  lines.push(current + tail);
  return [
    ...lines.map((line) => [atom(line, null, 0)]),
    ...(safe.rootOmitted ? [words(ROOT_CWD)] : []),
    ...safe.manual.map((line) => words(line)),
  ];
}

const BARE_DIGEST = /^[0-9a-f]+$/i;
/**
 * Only a bare digest field is truncated. A value carrying a path, URL or any other separator is returned whole,
 * because truncating a digest inside an identifier destroys the identifier.
 */
export const truncateDigest = (value: string, ascii: boolean): string =>
  value.length > DIGEST_CHARACTERS && BARE_DIGEST.test(value)
    ? value.slice(0, DIGEST_CHARACTERS) + (ascii ? '...' : '…')
    : value;

export interface MessageContext {
  readonly code?: string | undefined;
  readonly location?: string | null | undefined;
  readonly identity?: string | null | undefined;
}
/**
 * Strip what the block already shows. Findings embed `path:line: identity: `; RuntimeError and DbError embed
 * `code: `; DistributionError embeds nothing. Without this, two of the three families print their code twice.
 */
export function stripMessage(message: string, context: MessageContext): string {
  let text = message;
  for (const prefix of [context.location, context.identity, context.code]) {
    if (prefix && text.startsWith(prefix + ': ')) text = text.slice(prefix.length + 2);
  }
  return text;
}

export interface ErrorElements {
  /** A path, `path:line`, package id or workspace root. Null or empty renders as `(whole workspace)` — never `:1`. */
  readonly location: string | null;
  /** The originating check name, printed beside a location the finding does not have. */
  readonly check?: string | null | undefined;
  readonly identity?: string | null | undefined;
  readonly code: string;
  readonly message: string;
  /** One imperative next action. Omitted on every member of a group but the one that carries the shared action. */
  readonly next?: readonly Token[] | null | undefined;
  /** A warning finding carries the same four elements under the warning symbol; the default is an error. */
  readonly severity?: 'error' | 'warning' | undefined;
  /** The block's widest symbol, when this finding shares a block with wider ones. */
  readonly symbolWidth?: number | undefined;
}
/** Location, identity, cause, next action, in that order, with nothing interleaved. */
export function errorBlock(error: ErrorElements, options: Placement, caps: Capabilities): readonly string[] {
  const placement: EntryOptions = {
    ...options,
    symbol: error.severity ?? 'error',
    ...(error.symbolWidth === undefined ? {} : { symbolWidth: error.symbolWidth }),
  };
  const location = error.location === null || error.location === '' ? '(whole workspace)' : error.location;
  const head: Token[] = [atom(location, 'cyan', 0)];
  if (error.check) head.push(atom(error.check, null, 2));
  const facts: (readonly Token[])[] = [head];
  if (error.identity) facts.push([atom(error.identity, 'cyan', 0)]);
  // A warning code is yellow and an error code red; the element order is the same either way.
  const codeRole: Role = error.severity === 'warning' ? 'yellow' : 'red';
  facts.push([atom(error.code, codeRole, 0), ...words(stripMessage(error.message, error), null, 2)]);
  const lines = [...entry(facts, placement, caps)];
  if (error.next)
    lines.push(...entry([error.next], { column: entryColumn(placement, caps.ascii), symbol: 'step' }, caps));
  return lines;
}

export interface ProgressSink {
  readonly write: (text: string) => void;
  readonly isTTY: boolean;
}
export interface Progress {
  readonly phase: (text: string) => void;
  readonly clear: () => void;
  readonly done: (text: string) => void;
}
/**
 * §6: progress lives on the sink the caller supplies, which is stderr — never structured stdout. It is rewritten in
 * place only on a TTY, degrades to one appended line per phase otherwise, is erased before the result is written, and
 * never carries the completion: `done` always emits a terminal state line as text.
 */
export function createProgress(sink: ProgressSink, options: { readonly enabled: boolean }): Progress {
  let pending = false;
  const clear = (): void => {
    if (pending && sink.isTTY) sink.write('\r\u001b[K');
    pending = false;
  };
  return {
    phase: (text: string): void => {
      if (!options.enabled) return;
      if (!sink.isTTY) {
        sink.write(text + '\n');
        return;
      }
      clear();
      sink.write(text);
      pending = true;
    },
    clear,
    done: (text: string): void => {
      clear();
      if (options.enabled) sink.write(text + '\n');
    },
  };
}
