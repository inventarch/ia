/**
 * Terminal presentation primitives for the consumer CLI: docs/specs/consumer-cli-contract/README.md §6.
 * Everything here is pure. The environment is a parameter, so no function reads process.env, process.stdout or a clock.
 */

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
  | 'updated';
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

/** §6.4: 80 is the ceiling; below 40 a label/value block drops its value column; below 60 header pairs split. */
export const MAX_WIDTH = 80;
export const NARROW_WIDTH = 40;
export const HEADER_WIDTH = 60;
/** §6.4: a bare digest field shows 12 hex characters and an explicit ellipsis. */
export const DIGEST_CHARACTERS = 12;

const UTF8 = /utf-?8/i;
const LOCALE_NAMES = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const;

/** §6.7 colour precedence and §6.3's ASCII rule, resolved from an explicit environment rather than from the process. */
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

/** §6.1: a styled run is reset at its end and never left open across a newline, so each line is styled on its own. */
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
};
/** Every symbol is one UTF-16 unit per display column, so length is the declared §6.3 width; no emoji is admitted. */
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

/**
 * §6.4: words wrap at the effective width; a token is never split, so an over-wide identifier overruns its line whole.
 * `firstColumn` differs from `column` only where a value starts past its label and then hangs back at rule 3's column.
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
    if ((lines.length === 0 ? firstColumn : column) + plain.length + gap.length + token.text.length <= caps.width) {
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
   * §6.4 rule 2: the width of the widest symbol in this block, so every row of a block shares one content column.
   * It never reaches a nested action, whose column is rule 3's `parent + width(its own symbol) + 2`.
   */
  readonly symbolWidth?: number | undefined;
}

/** §6.4 rule 1. */
export const indentOf = (depth: Depth): number => 2 * depth;
/** The widest symbol of a block, which rule 2 measures the whole block's content column from. */
export const blockSymbolWidth = (names: readonly (SymbolName | undefined)[], ascii: boolean): number =>
  Math.max(0, ...names.map((name) => (name === undefined ? 0 : statusSymbol(name, ascii).width)));
/** §6.4 rule 2: `2·d + width + 2`, where width is the block's widest symbol and never less than this row's own. */
export const contentColumn = (base: number, symbol: StatusSymbol | null, symbolWidth = 0): number =>
  base + (symbol === null ? 0 : Math.max(symbolWidth, symbol.width) + 2);
export const entryColumn = (options: EntryOptions, ascii: boolean): number =>
  contentColumn(
    options.column ?? indentOf(options.depth ?? 0),
    options.symbol === undefined ? null : statusSymbol(options.symbol, ascii),
    options.symbolWidth ?? 0,
  );

/**
 * One entry: block indent, the status symbol, two spaces, then its facts. §6.4 rule 3 hangs every continuation —
 * a wrapped line or a further fact — at the entry's content column.
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
  /** A next action nested under this row, at the row's content column, per rule 3. */
  readonly action?: readonly Token[] | null | undefined;
  /**
   * Further prose about this row, on its own lines under it and hanging at the block's value column (two past the
   * content column when the block drops its value column), so it never starts where labels start.
   */
  readonly note?: readonly Token[] | null | undefined;
}
/**
 * §6.4 rule 4: one value column per block at `max(len(label)) + 2`, never shared across a blank line, over the one
 * content column rule 2 gives the block. A value that wraps hangs at the entry's content column, which is rule 3 and
 * not the value column. Below 40 columns, or when the padding would leave no room for a value, the block drops the
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
  /** The column this item starts at; §6.4 rule 5 only fixes the minimum gap of four spaces. */
  readonly column?: number | undefined;
}
/** §6.4 rule 5: bold label, two spaces, value; further pairs share the line until the width drops below 60. */
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
  /** §7's report blocks open with one blank line; the standalone error blocks do not. */
  readonly leadingBlank?: boolean | undefined;
}
/** §6.4 rule 6: exactly one blank line between blocks, never two, and no trailing blank before the process exits. */
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

/** §6.4: a command is unbreakable prose. The caller chooses the `\` break so every line stays runnable. */
export function commandFacts(
  lead: string,
  command: string,
  tail: string,
  column: number,
  caps: Capabilities,
): readonly (readonly Token[])[] {
  const lines: string[] = [];
  let current = '';
  for (const piece of command.split(' ')) {
    // The lead is glued to the first word, so the quoted command starts where the quote ends.
    const candidate = current === '' ? lead + piece : `${current} ${piece}`;
    if (current !== '' && column + candidate.length + 2 > caps.width) {
      lines.push(`${current} \\`);
      current = piece;
    } else current = candidate;
  }
  lines.push(current + tail);
  return lines.map((line) => [atom(line, null, 0)]);
}

const BARE_DIGEST = /^[0-9a-f]+$/i;
/**
 * §6.4: only a bare digest field is truncated. A value carrying a path, URL or any other separator is returned whole,
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
 * §6.5: strip what the block already shows. Findings embed `path:line: identity: `; RuntimeError and DbError embed
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
/** §6.5: location, identity, cause, next action, in that order, with nothing interleaved. */
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
  // §6.1 colours a warning code yellow and an error code red; the element order is the same either way.
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
 * §6.6: progress lives on the sink the caller supplies, which is stderr — never structured stdout. It is rewritten in
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
