/**
 * The single-repo view (consumer CLI contract §1.2), drawn into a cell grid: a status panel of areas in rows of three; a
 * divider; the offer list on the left, grouped, with its own scroll viewport; the right pane with what the selected
 * offer does, the commands it runs and what it changes (or the diagnostics table, or the keys); a divider; and the
 * key bar. From 80 to 99 columns the pane sits below the list; at 100 or more beside it; below 80×20 a one-line notice
 * replaces everything. The panel and the key bar never move: only the list and the pane scroll. Pure.
 */
import { displayFix } from '../fix.js';
import type { Capabilities, Role, SymbolName } from '../render.js';
import { statusSymbol } from '../render.js';
import { Grid } from './grid.js';
import type { Group, Offer } from './offers.js';
import type { AreaStatus, ConsoleCheck, ConsoleState } from './state.js';
import { stringWidth, truncate } from './width.js';

export type View = 'offers' | 'diagnostics' | 'help';
export interface Prompt {
  readonly label: string;
  readonly value: string;
  readonly error: string | null;
}
export interface LayoutInput {
  readonly state: ConsoleState;
  readonly offers: readonly Offer[];
  readonly selected: number;
  readonly scroll: { readonly list: number; readonly pane: number };
  readonly view: View;
  readonly message: string | null;
  readonly prompt: Prompt | null;
  readonly caps: Capabilities;
  readonly columns: number;
  readonly rows: number;
  /** Opened from the all-workspaces table, to which Escape returns. */
  readonly drilled?: boolean;
}
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 20;
export const SIDE_BY_SIDE = 100;

const AREA_SYMBOL: Readonly<Record<AreaStatus, SymbolName>> = {
  fail: 'error',
  warn: 'warning',
  unknown: 'unknown',
  setup: 'setup',
  ok: 'success',
  absent: 'unreported',
};
const CHECK_SYMBOL: Readonly<Record<ConsoleCheck['status'], SymbolName>> = {
  fail: 'error',
  warn: 'warning',
  unknown: 'unknown',
  info: 'info',
  ok: 'success',
};
const HEADERS: Readonly<Record<Group, string>> = { attention: 'NEEDS ATTENTION', setup: 'SET UP', more: 'MORE' };
const FROM: Readonly<Record<ConsoleCheck['from'], string>> = {
  running: 'running',
  repo: 'repo',
  'in-process': 'local',
};

/** Where each part of the view goes for a terminal size; null when the terminal is too small. */
export interface Geometry {
  readonly panel: number;
  readonly list: { readonly top: number; readonly height: number; readonly width: number };
  readonly pane: { readonly top: number; readonly left: number; readonly height: number; readonly width: number };
  /** The divider column beside the list, or null when the pane sits below it. */
  readonly split: number | null;
}
export function geometry(areas: number, columns: number, rows: number): Geometry | null {
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return null;
  const panel = Math.max(1, Math.ceil(areas / 3));
  const top = panel + 1,
    body = rows - panel - 3;
  if (columns >= SIDE_BY_SIDE) {
    const split = Math.floor(columns * 0.42);
    return {
      panel,
      split,
      list: { top, height: body, width: split },
      pane: { top, left: split + 2, height: body, width: columns - split - 3 },
    };
  }
  const list = Math.floor((body - 1) / 2);
  return {
    panel,
    split: null,
    list: { top, height: list, width: columns },
    pane: { top: top + list + 1, left: 1, height: body - list - 1, width: columns - 2 },
  };
}

interface Line {
  readonly text: string;
  readonly role: Role | null;
  /** The offer this line shows, or null for a header. */
  readonly offer: number | null;
}
/** The list's lines: a header per group present, then its offers. */
export function listLines(offers: readonly Offer[]): readonly Line[] {
  const lines: Line[] = [];
  let group: Group | null = null;
  offers.forEach((offer, index) => {
    if (offer.group !== group) {
      group = offer.group;
      lines.push({ text: HEADERS[group], role: 'bold', offer: null });
    }
    lines.push({ text: offer.title, role: offer.disabled === undefined ? null : 'dim', offer: index });
  });
  return lines;
}
/** The first list line to show so the selected offer is visible, starting from `start` and moving as little as it can. */
export function listScroll(offers: readonly Offer[], selected: number, height: number, start: number): number {
  const lines = listLines(offers);
  const at = lines.findIndex((line) => line.offer === selected);
  let first = Math.max(0, Math.min(start, lines.length - height));
  if (at !== -1) {
    // Show a group's header with its first offer when it fits.
    const wanted = at > 0 && lines[at - 1]!.offer === null ? at - 1 : at;
    if (wanted < first) first = wanted;
    if (at >= first + height) first = at - height + 1;
  }
  return Math.max(0, first);
}

/** Words greedily into lines of at most `width` columns; a word longer than a line is cut. */
export function wrap(text: string, width: number, ascii: boolean): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter((part) => part !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (stringWidth(next) <= width) line = next;
    else {
      if (line !== '') lines.push(line);
      line = stringWidth(word) <= width ? word : truncate(word, width, ascii);
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

function offerSymbol(offer: Offer, state: ConsoleState, ascii: boolean): { text: string; role: Role | null } {
  if (offer.group === 'more') return { text: ascii ? '.' : '·', role: 'dim' };
  if (offer.group === 'setup') return statusSymbol('setup', ascii);
  const failing = offer.answers.some((id) => state.checks.some((row) => row.id === id && row.status === 'fail'));
  return statusSymbol(failing ? 'error' : 'warning', ascii);
}

interface PaneLine {
  readonly text: string;
  readonly role: Role | null;
  readonly symbol?: { readonly text: string; readonly role: Role | null };
}
function offerPane(offer: Offer | undefined, width: number, ascii: boolean): PaneLine[] {
  if (offer === undefined) return [{ text: 'Nothing to do here.', role: 'dim' }];
  const out: PaneLine[] = [{ text: 'WHAT THIS DOES', role: 'bold' }];
  for (const line of wrap(offer.explain, width, ascii)) out.push({ text: line, role: null });
  out.push({ text: '', role: null }, { text: 'RUNS', role: 'bold' });
  if (offer.disabled !== undefined) out.push({ text: 'nothing: not available', role: 'dim' });
  else if (offer.view === 'diagnostics') out.push({ text: 'opens the full doctor table here', role: 'dim' });
  else
    offer.steps.forEach((step, index) => {
      const shown = displayFix(step);
      out.push({ text: offer.steps.length > 1 ? `${index + 1}. ${shown}` : shown, role: 'cyan' });
    });
  if (offer.input !== undefined) out.push({ text: `asks for: ${offer.input.label}`, role: 'dim' });
  out.push({ text: '', role: null }, { text: 'CHANGES', role: 'bold' });
  for (const change of offer.changes) out.push({ text: change, role: null });
  return out;
}
function diagnosticsPane(state: ConsoleState, ascii: boolean): PaneLine[] {
  const width = Math.max(0, ...state.checks.map((row) => stringWidth(row.id)));
  const out: PaneLine[] = [{ text: `DIAGNOSTICS  ${state.checks.length} checks`, role: 'bold' }];
  if (state.repoFailure !== null)
    out.push({ text: `This workspace's ia could not report: ${state.repoFailure}`, role: 'yellow' });
  for (const row of state.checks) {
    const symbol = statusSymbol(row.reported ? CHECK_SYMBOL[row.status] : 'unreported', ascii);
    const id = row.id + ' '.repeat(width - stringWidth(row.id));
    out.push({ text: `${id}  ${FROM[row.from].padEnd(7)}  ${row.detail}`, role: null, symbol });
  }
  return out;
}
const HELP: readonly (readonly [string, string, string])[] = [
  ['↑↓ j k', 'j k', 'move, or scroll the diagnostics'],
  ['enter', 'enter', 'run the selected offer: preview, confirm, apply'],
  ['tab', 'tab', 'switch to all workspaces, or back from the diagnostics'],
  ['r', 'r', 'reload the state'],
  ['?', '?', 'this help'],
  ['esc', 'esc', 'back'],
  ['q', 'q', 'quit'],
];
/** In a workspace opened from the all-workspaces table, `q` and Escape on the offers go back to it (contract §1.2). */
const HELP_DRILLED: readonly (readonly [string, string, string])[] = [
  ...HELP.filter(([key]) => key !== 'esc' && key !== 'q'),
  ['esc', 'esc', 'back; from the offers, back to all workspaces'],
  ['q', 'q', 'from the offers, back to all workspaces; elsewhere quit'],
  ['ctrl-c', 'ctrl-c', 'quit'],
];
function helpPane(ascii: boolean, drilled: boolean): PaneLine[] {
  return [
    { text: 'KEYS', role: 'bold' },
    ...(drilled ? HELP_DRILLED : HELP).map(([unicode, plain, what]) => ({
      text: `${(ascii ? plain : unicode).padEnd(8)} ${what}`,
      role: null,
    })),
  ];
}
function keys(view: View, ascii: boolean, drilled: boolean): string {
  const sep = ascii ? ' | ' : ' · ',
    move = ascii ? 'j/k move' : '↑↓ move';
  if (view === 'diagnostics') return [ascii ? 'j/k scroll' : '↑↓ scroll', 'tab offers', 'esc back', 'q quit'].join(sep);
  if (view === 'help') return ['esc back', 'q quit'].join(sep);
  // A workspace opened from the all-workspaces table goes back to it; the console's own workspace switches to it.
  if (drilled) return [move, 'enter run', 'r refresh', '? help', 'esc back'].join(sep);
  return [move, 'enter run', 'tab workspaces', 'r refresh', '? help', 'q quit'].join(sep);
}

/** In ASCII mode the console's own punctuation is spelled in ASCII, in data as in its own words. */
const ASCII_FORMS: readonly (readonly [string, string])[] = [
  ['…', '...'],
  ['·', '-'],
  ['→', '->'],
  ['—', '-'],
];
/** A grid whose text is spelled for the terminal: unchanged with Unicode, ASCII punctuation with --ascii. */
export function canvas(columns: number, rows: number, ascii: boolean): Grid {
  const grid = new Grid(columns, rows);
  if (!ascii) return grid;
  const put = grid.put.bind(grid);
  grid.put = (x, y, text, role, maxWidth, flag) =>
    put(
      x,
      y,
      ASCII_FORMS.reduce((out, [from, to]) => out.replaceAll(from, to), text),
      role,
      maxWidth,
      flag,
    );
  return grid;
}

export function layoutRepo(input: LayoutInput): Grid {
  const { state, offers, caps, columns, rows } = input;
  const ascii = caps.ascii;
  const grid = canvas(columns, rows, ascii);
  const at = geometry(state.areas.length, columns, rows);
  if (at === null) {
    grid.put(
      0,
      0,
      `Terminal too small (need ${MIN_COLUMNS}${ascii ? 'x' : '×'}${MIN_ROWS})`,
      'yellow',
      undefined,
      ascii,
    );
    return grid;
  }
  // The status panel: rows of three cells, each title padded to its column's widest title.
  const cell = Math.floor((columns - 1) / 3);
  const titleWidth = [0, 1, 2].map((column) =>
    Math.max(0, ...state.areas.filter((_, index) => index % 3 === column).map((area) => stringWidth(area.title))),
  );
  state.areas.forEach((area, index) => {
    const x = 1 + (index % 3) * cell,
      y = Math.floor(index / 3),
      end = x + cell - 1;
    grid.put(x, y, area.title, 'bold', end - x, ascii);
    let cursor = x + titleWidth[index % 3]! + 1;
    const symbol = statusSymbol(AREA_SYMBOL[area.status], ascii);
    cursor += grid.put(cursor, y, symbol.text, symbol.role, end - cursor, ascii) + 1;
    const summary = area.status === 'absent' ? 'not reported' : area.summary;
    grid.put(cursor, y, summary, area.status === 'absent' ? 'dim' : null, end - cursor, ascii);
  });
  const horizontal = ascii ? '-' : '─';
  const divider = (y: number, junction: string): void => {
    grid.put(0, y, horizontal.repeat(columns), 'dim', undefined, ascii);
    if (at.split !== null) grid.put(at.split, y, junction, 'dim', undefined, ascii);
  };
  divider(at.panel, ascii ? '+' : '┬');
  divider(rows - 2, ascii ? '+' : '┴');
  if (at.split !== null)
    for (let y = at.list.top; y < at.list.top + at.list.height; y += 1)
      grid.put(at.split, y, ascii ? '|' : '│', 'dim', undefined, ascii);
  else divider(at.pane.top - 1, '');

  // The list, in its own viewport.
  const lines = listLines(offers);
  const first = listScroll(offers, input.selected, at.list.height, input.scroll.list);
  lines.slice(first, first + at.list.height).forEach((line, index) => {
    const y = at.list.top + index,
      limit = at.list.width - 1;
    if (line.offer === null) {
      grid.put(1, y, line.text, 'bold', limit - 1, ascii);
      return;
    }
    const offer = offers[line.offer]!;
    const chosen = line.offer === input.selected;
    grid.put(1, y, chosen ? (ascii ? '>' : '›') : ' ', chosen ? 'cyan' : null, undefined, ascii);
    const symbol = offerSymbol(offer, state, ascii);
    const width = grid.put(3, y, symbol.text, symbol.role, limit - 3, ascii);
    grid.put(4 + width, y, line.text, chosen ? 'bold' : line.role, limit - 4 - width, ascii);
  });

  // The pane, in its own viewport.
  const pane =
    input.view === 'diagnostics'
      ? diagnosticsPane(state, ascii)
      : input.view === 'help'
        ? helpPane(ascii, input.drilled === true)
        : offerPane(offers[input.selected], at.pane.width, ascii);
  const start = Math.max(0, Math.min(input.scroll.pane, pane.length - at.pane.height));
  pane.slice(start, start + at.pane.height).forEach((line, index) => {
    const y = at.pane.top + index;
    let x = at.pane.left;
    if (line.symbol !== undefined) x += grid.put(x, y, line.symbol.text, line.symbol.role, at.pane.width, ascii) + 1;
    grid.put(x, y, line.text, line.role, at.pane.left + at.pane.width - x, ascii);
  });

  if (input.message !== null) grid.put(2, rows - 2, ` ${input.message} `, 'yellow', columns - 4, ascii);
  if (input.prompt === null)
    grid.put(1, rows - 1, keys(input.view, ascii, input.drilled === true), 'dim', columns - 2, ascii);
  else {
    const { label, value, error } = input.prompt;
    const used = grid.put(1, rows - 1, `${label}: ${value}${ascii ? '_' : '▌'}`, 'bold', columns - 2, ascii);
    const rest = error ?? (ascii ? 'enter accept | esc cancel' : 'enter accept · esc cancel');
    grid.put(3 + used, rows - 1, rest, error === null ? 'dim' : 'red', columns - 4 - used, ascii);
  }
  return grid;
}
