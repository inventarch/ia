/**
 * The all-workspaces view (consumer CLI contract §1.2), drawn into a cell grid: a one-line summary panel (the cached
 * latest release, the running version, and how many tracked workspaces are healthy, need attention or are missing);
 * a divider; on the left the table of tracked workspaces, each with its class and its `cli · records · lock · kits`
 * columns (and `plugin` from 120 columns), then the batchable offers on the selection and Find; on the right what the
 * row or entry under the cursor holds, or the batch preview; a divider; the key bar. From 80 to 99 columns the pane sits
 * below the list. A row shows `?` until its result arrives. Pure.
 */
import { displayFix } from '../fix.js';
import type { Capabilities, Role, SymbolName } from '../render.js';
import { statusSymbol } from '../render.js';
import type { BatchChoice, RepoPlan } from './batch-plan.js';
import type { Grid } from './grid.js';
import type { Prompt } from './layout-repo.js';
import { canvas, MIN_COLUMNS, MIN_ROWS, SIDE_BY_SIDE, wrap } from './layout-repo.js';
import type { Step } from './offers.js';
import type { AreaStatus } from './state.js';
import type { RepoClass, RepoRow, Summary } from './workspaces-state.js';
import { classify } from './workspaces-state.js';
import { graphemes, pad, stringWidth, truncate, truncateMiddle } from './width.js';

/** The plugin column appears from this many columns. */
export const PLUGIN_COLUMNS = 120;
export interface BatchPreview {
  readonly choice: BatchChoice;
  readonly repos: readonly RepoPlan[];
  readonly deferred: readonly Step[];
}
export interface FoundList {
  readonly folder: string;
  readonly roots: readonly string[];
  /** Roots already tracked; shown, never selectable. */
  readonly tracked: ReadonlySet<number>;
  readonly selected: ReadonlySet<number>;
  readonly cursor: number;
}
export interface AllLayoutInput {
  readonly repos: readonly RepoRow[];
  readonly summary: Summary;
  readonly selected: ReadonlySet<number>;
  /** One cursor over the table rows, then the batch choices, then Find. */
  readonly cursor: number;
  readonly choices: readonly BatchChoice[];
  readonly preview: BatchPreview | null;
  readonly found: FoundList | null;
  readonly message: string | null;
  readonly prompt: Prompt | null;
  /** Tab leads to this workspace's own view. */
  readonly repoTab: boolean;
  readonly caps: Capabilities;
  readonly columns: number;
  readonly rows: number;
}
export const FIND_TITLE = 'Find workspaces in a folder…';

/** Where the cursor is: a table row, a batch choice, or Find. */
export type Item =
  | { readonly kind: 'repo'; readonly index: number }
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'find' };
export function itemAt(cursor: number, repos: number, choices: number): Item {
  if (cursor < repos) return { kind: 'repo', index: cursor };
  if (cursor < repos + choices) return { kind: 'choice', index: cursor - repos };
  return { kind: 'find' };
}
export const itemCount = (repos: number, choices: number): number => repos + choices + 1;

const CLASS_SYMBOL: Readonly<Record<RepoClass, SymbolName>> = {
  healthy: 'success',
  failing: 'warning',
  warning: 'warning',
  unchecked: 'unknown',
  loading: 'unknown',
  failed: 'unknown',
  missing: 'unreported',
  unreadable: 'unknown',
};
const AREA_SYMBOL: Readonly<Record<AreaStatus, SymbolName>> = {
  fail: 'error',
  warn: 'warning',
  unknown: 'unknown',
  setup: 'setup',
  ok: 'success',
  absent: 'unreported',
};
/** One column wide in both symbol sets, so a table column lines up. */
const COMPACT: Readonly<Record<SymbolName, string>> = {
  success: '+',
  error: 'x',
  warning: '!',
  unknown: '?',
  info: '*',
  step: '>',
  added: '+',
  removed: '-',
  updated: '~',
  setup: 'o',
  unreported: '-',
};
const symbol = (name: SymbolName, ascii: boolean): { text: string; role: Role | null } => {
  const found = statusSymbol(name, ascii);
  return { text: ascii ? COMPACT[name] : found.text, role: found.role };
};

interface Cell {
  readonly symbol: SymbolName | null;
  readonly text: string;
}
const UNKNOWN: Cell = { symbol: 'unknown', text: '?' };
/** The table's cells for one row: each an area's symbol and a short value. */
export function cells(row: RepoRow): { cli: Cell; records: Cell; lock: Cell; kits: Cell; plugin: Cell } {
  const state = row.console;
  if (row.state === 'loading' || row.state === 'failed' || state === null)
    return { cli: UNKNOWN, records: UNKNOWN, lock: UNKNOWN, kits: UNKNOWN, plugin: UNKNOWN };
  const area = (id: string) => state.areas.find((entry) => entry.id === id);
  const status = (id: string): SymbolName => AREA_SYMBOL[area(id)?.status ?? 'absent'];
  const check = (id: string) => state.checks.find((entry) => entry.id === id && entry.reported);
  const errors = /(\d+) errors?/.exec(check('records')?.detail ?? '');
  const lockStatus = area('lock')?.status ?? 'absent';
  const kits = check('kits');
  const updates = state.checks.filter(
    (entry) =>
      entry.reported && entry.id.startsWith('kit-update:') && (entry.status === 'warn' || entry.status === 'fail'),
  ).length;
  return {
    cli: { symbol: status('cli'), text: state.repo?.version ?? '—' },
    records: {
      symbol: status('records'),
      text: errors === null ? (check('records') === undefined ? '—' : '0') : errors[1]!,
    },
    lock: {
      symbol: status('lock'),
      text: lockStatus === 'fail' || lockStatus === 'warn' ? 'drift' : lockStatus === 'ok' ? 'ok' : '—',
    },
    kits: {
      symbol: status('kits'),
      text: kits === undefined || kits.status === 'unknown' ? '?' : String(updates),
    },
    plugin: { symbol: status('plugin'), text: area('plugin')?.summary ?? '—' },
  };
}

interface Column {
  readonly title: string;
  readonly width: number;
  readonly pick: (row: ReturnType<typeof cells>) => Cell;
}
const COLUMNS: readonly Column[] = [
  { title: 'cli', width: 8, pick: (row) => row.cli },
  { title: 'records', width: 8, pick: (row) => row.records },
  { title: 'lock', width: 7, pick: (row) => row.lock },
  { title: 'kits', width: 5, pick: (row) => row.kits },
];
const PLUGIN: Column = { title: 'plugin', width: 18, pick: (row) => row.plugin };

/** The summary panel's text: Tracked, Healthy, Attention and Missing always; Unreadable, Unchecked and Loading when not 0. */
export function summaryText(summary: Summary, ascii: boolean): string {
  return summaryParts(summary, ascii).join('  ');
}
function summaryParts(summary: Summary, ascii: boolean): readonly string[] {
  const behind = summary.behind ? ` ${ascii ? '!' : '▲'}` : '';
  return [
    `Latest ${summary.latest ?? '?'}`,
    `Global ${summary.global}${behind}`,
    `Tracked ${summary.tracked}`,
    `Healthy ${summary.healthy}`,
    `Attention ${summary.attention}`,
    `Missing ${summary.missing}`,
    ...(summary.failed + summary.unreadable > 0 ? [`Unreadable ${summary.failed + summary.unreadable}`] : []),
    ...(summary.unchecked > 0 ? [`Unchecked ${summary.unchecked}`] : []),
    ...(summary.loading > 0 ? [`Loading ${summary.loading}`] : []),
  ];
}
/** The summary panel's lines: its parts, two spaces apart, wrapped between parts so no count is ever cut off. */
export function summaryLines(summary: Summary, ascii: boolean, width: number): readonly string[] {
  const lines: string[] = [];
  for (const part of summaryParts(summary, ascii)) {
    const last = lines.at(-1);
    if (last !== undefined && stringWidth(`${last}  ${part}`) <= width) lines[lines.length - 1] = `${last}  ${part}`;
    else lines.push(part);
  }
  return lines;
}

const label = (row: RepoRow): string => row.tracked.label ?? row.tracked.id;
interface PaneLine {
  readonly text: string;
  readonly role: Role | null;
}

function repoPane(row: RepoRow, width: number, ascii: boolean): PaneLine[] {
  const out: PaneLine[] = [
    { text: label(row), role: 'bold' },
    { text: truncateMiddle(row.tracked.root, width, ascii), role: 'dim' },
  ];
  if (row.state === 'loading') return [...out, { text: 'Reading this workspace…', role: 'dim' }];
  if (row.state === 'missing')
    return [...out, { text: 'Missing: the folder is gone or no longer holds .ia/src.', role: 'yellow' }];
  if (row.state === 'unreadable')
    return [...out, { text: 'Unreadable: the folder cannot be examined; check its permissions.', role: 'yellow' }];
  if (row.failure !== null) out.push({ text: `Its ia could not report: ${row.failure}`, role: 'yellow' });
  const state = row.console;
  if (state === null) return out;
  out.push({
    text: state.repo === null ? 'no local copy: read by this ia' : `pins @inventarch/cli ${state.repo.version}`,
    role: null,
  });
  const troubled = state.checks.filter(
    (check) => check.reported && check.from !== 'running' && check.status !== 'ok' && check.status !== 'info',
  );
  for (const check of troubled) {
    const name: SymbolName = check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warning' : 'unknown';
    out.push({ text: `${symbol(name, ascii).text} ${check.title}: ${check.detail}`, role: null });
  }
  const batchable = row.offers.filter((offer) => offer.batchable && offer.group !== 'more');
  if (batchable.length > 0) {
    out.push({ text: '', role: null }, { text: 'CAN BATCH', role: 'bold' });
    for (const offer of batchable) out.push({ text: offer.title, role: null });
  }
  return out;
}
function choicePane(choice: BatchChoice, selected: number, width: number, ascii: boolean): PaneLine[] {
  return [
    { text: `BATCH ${choice.title}`, role: 'bold' },
    ...wrap(
      `On ${choice.repos} of the ${selected} selected workspaces, each in a new worktree on a new branch. Enter shows the worktrees, branches and commands first.`,
      width,
      ascii,
    ).map((text) => ({ text, role: null })),
  ];
}
function previewPane(preview: BatchPreview, repos: readonly RepoRow[], width: number, ascii: boolean): PaneLine[] {
  const out: PaneLine[] = [{ text: `BATCH ${preview.choice.title} WOULD`, role: 'bold' }];
  for (const plan of preview.repos) {
    const row = repos.find((entry) => entry.tracked.root === plan.root);
    out.push({ text: row === undefined ? plan.root : label(row), role: 'bold' });
    if (plan.refused !== null) {
      out.push({ text: `  refused: ${plan.refused}`, role: 'yellow' });
      continue;
    }
    out.push(
      { text: `  worktree ${truncateMiddle(plan.worktree, Math.max(1, width - 11), ascii)}`, role: null },
      { text: `  branch   ${plan.branch}`, role: null },
    );
    // Each command in full, wrapped under its number: the preview is what the confirmation agrees to.
    plan.steps.forEach((step, index) =>
      wrap(`${index + 1}. ${displayFix(step)}`, Math.max(1, width - 11), ascii).forEach((text, line) =>
        out.push({
          text: `  ${index === 0 && line === 0 ? 'run' : '   '}      ${line === 0 ? '' : '   '}${text}`,
          role: 'cyan',
        }),
      ),
    );
  }
  if (preview.deferred.length > 0) {
    out.push({ text: 'LEFT FOR AFTER, ONCE', role: 'bold' });
    for (const step of preview.deferred) out.push({ text: `  ${displayFix(step)}`, role: 'cyan' });
  }
  out.push({ text: 'nothing is pushed; enter runs it', role: 'dim' });
  return out;
}
const FIND_PANE: readonly PaneLine[] = [
  { text: 'FIND WORKSPACES', role: 'bold' },
  { text: 'Walks a folder for workspaces and tracks', role: null },
  { text: 'the ones you choose.', role: null },
];

function keys(input: AllLayoutInput, ascii: boolean): string {
  const sep = ascii ? ' | ' : ' · ';
  if (input.found !== null) return ['space select', 'enter track', 'esc cancel'].join(sep);
  if (input.preview !== null) return ['enter run', 'esc cancel', 'q quit'].join(sep);
  return [
    'space select',
    'a select needing',
    'enter open',
    'b batch',
    'f find',
    ...(input.repoTab ? ['tab this repo'] : []),
    'r refresh',
    'q quit',
  ].join(sep);
}

interface ListLine {
  readonly item: number | null;
  readonly draw: (grid: Grid, x: number, y: number, width: number) => void;
}

export function layoutAll(input: AllLayoutInput): Grid {
  const { caps, columns, rows } = input;
  const ascii = caps.ascii;
  const grid = canvas(columns, rows, ascii);
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
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
  const summary = summaryLines(input.summary, ascii, columns - 2);
  summary.forEach((line, y) => grid.put(1, y, line, 'bold', columns - 2, ascii));
  const panel = summary.length;
  const top = panel + 1,
    body = rows - panel - 3;
  const side = columns >= SIDE_BY_SIDE;
  const split = side ? Math.floor(columns * 0.58) : null;
  const listHeight = side ? body : Math.floor((body - 1) / 2);
  const listWidth = split ?? columns;
  const pane = side
    ? { top, left: split! + 2, height: body, width: columns - split! - 3 }
    : { top: top + listHeight + 1, left: 1, height: body - listHeight - 1, width: columns - 2 };
  const horizontal = ascii ? '-' : '─';
  const divider = (y: number, junction: string): void => {
    grid.put(0, y, horizontal.repeat(columns), 'dim', undefined, ascii);
    if (split !== null) grid.put(split, y, junction, 'dim', undefined, ascii);
  };
  divider(panel, ascii ? '+' : '┬');
  divider(rows - 2, ascii ? '+' : '┴');
  if (split !== null)
    for (let y = top; y < top + body; y += 1) grid.put(split, y, ascii ? '|' : '│', 'dim', undefined, ascii);
  else divider(pane.top - 1, '');

  // The table header stays put; the lines below it scroll together.
  const extra = columns >= PLUGIN_COLUMNS ? [...COLUMNS, PLUGIN] : COLUMNS;
  const fixed = extra.reduce((sum, column) => sum + column.width + 1, 0);
  const nameWidth = Math.max(8, listWidth - 9 - fixed);
  const lines: ListLine[] = [];
  const mark = (grid: Grid, x: number, y: number, chosen: boolean): void => {
    grid.put(x, y, chosen ? (ascii ? '>' : '›') : ' ', chosen ? 'cyan' : null, undefined, ascii);
  };
  const choices = input.choices;
  if (input.found !== null) {
    const found = input.found;
    lines.push({
      item: null,
      draw: (g, x, y, w) => g.put(x, y, `FOUND IN ${truncateMiddle(found.folder, w - 10, ascii)}`, 'bold', w, ascii),
    });
    if (found.roots.length === 0)
      lines.push({ item: null, draw: (g, x, y, w) => g.put(x + 2, y, 'No workspaces here.', 'dim', w - 2, ascii) });
    found.roots.forEach((root, index) =>
      lines.push({
        item: index,
        draw: (g, x, y, w) => {
          mark(g, x, y, index === found.cursor);
          const box = found.tracked.has(index) ? '[=]' : found.selected.has(index) ? '[x]' : '[ ]';
          g.put(x + 2, y, box, null, undefined, ascii);
          const note = found.tracked.has(index) ? '  (tracked)' : '';
          g.put(x + 6, y, truncateMiddle(root, w - 6 - note.length, ascii) + note, null, w - 6, ascii);
        },
      }),
    );
  } else {
    if (input.repos.length === 0)
      lines.push({
        item: null,
        draw: (g, x, y, w) => g.put(x + 2, y, 'No workspaces are tracked yet.', 'dim', w - 2, ascii),
      });
    input.repos.forEach((row, index) =>
      lines.push({
        item: index,
        draw: (g, x, y) => {
          mark(g, x, y, input.cursor === index);
          g.put(x + 2, y, input.selected.has(index) ? '[x]' : '[ ]', null, undefined, ascii);
          const kind = symbol(CLASS_SYMBOL[classify(row)], ascii);
          g.put(x + 6, y, kind.text, kind.role, undefined, ascii);
          g.put(x + 8, y, pad(label(row), nameWidth, ascii), input.cursor === index ? 'bold' : null, nameWidth, ascii);
          let at = x + 8 + nameWidth + 1;
          const values = cells(row);
          for (const column of extra) {
            const cell = column.pick(values);
            if (row.state === 'missing' || row.state === 'unreadable') break;
            const shown = cell.symbol === null ? null : symbol(cell.symbol, ascii);
            if (shown !== null) g.put(at, y, shown.text, shown.role, undefined, ascii);
            if (cell.symbol !== 'unreported' || cell.text !== '—')
              g.put(at + 2, y, cell.text, null, column.width - 2, ascii);
            at += column.width + 1;
          }
          if (row.state === 'missing' || row.state === 'unreadable') g.put(at, y, row.state, 'dim', undefined, ascii);
        },
      }),
    );
    lines.push({ item: null, draw: () => {} });
    const selected = input.selected.size;
    lines.push({
      item: null,
      draw: (g, x, y, w) =>
        g.put(x, y, selected === 0 ? 'BATCH: SELECT WORKSPACES' : `BATCH ON ${selected} SELECTED`, 'bold', w, ascii),
    });
    if (selected > 0 && choices.length === 0)
      lines.push({
        item: null,
        draw: (g, x, y, w) => g.put(x + 2, y, 'Nothing to batch on the selection.', 'dim', w - 2, ascii),
      });
    choices.forEach((choice, index) => {
      const item = input.repos.length + index;
      lines.push({
        item,
        draw: (g, x, y, w) => {
          mark(g, x + 1, y, input.cursor === item);
          const count = `${choice.repos} ${choice.repos === 1 ? 'repo' : 'repos'}`;
          g.put(
            x + 3,
            y,
            truncate(choice.title, w - 6 - count.length, ascii),
            input.cursor === item ? 'bold' : null,
            undefined,
            ascii,
          );
          g.put(x + w - 1 - count.length, y, count, 'dim', undefined, ascii);
        },
      });
    });
    lines.push({ item: null, draw: (g, x, y, w) => g.put(x, y, 'MORE', 'bold', w, ascii) });
    const find = input.repos.length + choices.length;
    lines.push({
      item: find,
      draw: (g, x, y, w) => {
        mark(g, x + 1, y, input.cursor === find);
        g.put(x + 3, y, FIND_TITLE, input.cursor === find ? 'bold' : null, w - 4, ascii);
      },
    });
  }
  // The header row, then the list in its viewport, scrolled just enough to show the cursor.
  if (input.found === null) {
    let at = 9 + nameWidth + 1;
    grid.put(9, top, 'workspace', 'dim', nameWidth, ascii);
    for (const column of extra) {
      grid.put(at, top, column.title, 'dim', column.width, ascii);
      at += column.width + 1;
    }
  }
  const viewport = input.found === null ? listHeight - 1 : listHeight;
  const start = input.found === null ? top + 1 : top;
  const cursor = input.found === null ? input.cursor : input.found.cursor;
  const at = lines.findIndex((line) => line.item === cursor);
  const first = at < viewport ? 0 : Math.min(at - viewport + 1, Math.max(0, lines.length - viewport));
  lines.slice(first, first + viewport).forEach((line, index) => line.draw(grid, 1, start + index, listWidth - 2));

  // The pane.
  let paneLines: PaneLine[];
  if (input.found !== null)
    paneLines = [
      { text: 'TRACK', role: 'bold' },
      { text: `${input.found.selected.size} selected`, role: null },
    ];
  else if (input.preview !== null) paneLines = previewPane(input.preview, input.repos, pane.width, ascii);
  else {
    const item = itemAt(input.cursor, input.repos.length, choices.length);
    paneLines =
      item.kind === 'repo'
        ? repoPane(input.repos[item.index]!, pane.width, ascii)
        : item.kind === 'choice'
          ? choicePane(choices[item.index]!, input.selected.size, pane.width, ascii)
          : [...FIND_PANE];
  }
  paneLines.slice(0, pane.height).forEach((line, index) => {
    grid.put(pane.left, pane.top + index, line.text, line.role, pane.width, ascii);
  });

  if (input.message !== null) grid.put(2, rows - 2, ` ${input.message} `, 'yellow', columns - 4, ascii);
  if (input.prompt === null) grid.put(1, rows - 1, keys(input, ascii), 'dim', columns - 2, ascii);
  else {
    const { label: name, value, error } = input.prompt;
    const rest = error ?? (ascii ? 'enter accept | esc cancel' : 'enter accept · esc cancel');
    // A value too long for the line beside the hint shows its end, where the typing is.
    const room = Math.max(10, columns - 4 - stringWidth(rest));
    const fits = (text: string) => stringWidth(`${name}: ${text}_`) <= room;
    let shown = value;
    if (!fits(shown)) while (shown !== '' && !fits(`...${shown}`)) shown = graphemes(shown).slice(1).join('');
    const line = `${name}: ${shown === value ? '' : ascii ? '...' : '…'}${shown}${ascii ? '_' : '▌'}`;
    const used = grid.put(1, rows - 1, line, 'bold', columns - 2, ascii);
    grid.put(3 + used, rows - 1, rest, error === null ? 'dim' : 'red', columns - 4 - used, ascii);
  }
  return grid;
}
