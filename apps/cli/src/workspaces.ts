/**
 * `ia workspaces list | add | find | remove`: docs/specs/consumer-cli-contract/README.md §2.16. The tracked list in the
 * IA home (tracked.ts) from the command line: a user-state command, not an agent one, so it has no catalog row and no
 * mandate gate. It opens no workspace, so `--root` is refused; `add` takes its directory as a positional and defaults to
 * the workspace that holds the cwd. `add` and `remove` write at once, since they change only the user's own list and
 * print exactly what changed; `find` previews and writes only with `--apply`, confirmed as every `--apply` is (§2.0).
 * Nothing here reads or writes the MCP door's `workspace-locations.json`.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError } from './args.js';
import { findCommand, ownedOptions } from './commands.js';
import { clusterWidth, graphemes, stringWidth } from './console/width.js';
import type { Context, Result } from './consumer.js';
import { confirm, discoverRoot, iaHomeOf, Refusal } from './consumer.js';
import { homeSrcRemedy } from './home-remedy.js';
import type { Capabilities, StatusSymbol, Token } from './render.js';
import {
  atom,
  document,
  entry,
  sectionLabel,
  statusSymbol,
  style,
  terminalSafe,
  terminalText,
  words,
} from './render.js';
import type { TrackedState, TrackedWorkspace } from './tracked.js';
import {
  checkTrackId,
  defaultTrackId,
  clashRemedy,
  commandPath,
  FIND_DEPTH,
  findWorkspaces,
  idClashes,
  idTaken,
  PATH_OMITTED,
  readTracked,
  trackedRow,
  trackedState,
  trackWorkspace,
  trackWorkspaces,
  untrackWorkspace,
} from './tracked.js';

const ACTIONS = ['list', 'add', 'find', 'remove'] as const;
type Action = (typeof ACTIONS)[number];
/**
 * The options only one action reads; any other action refuses them as usage rather than ignoring them. Read from the
 * command spec's `actions`, the table a fix's flow reads too (fix.ts).
 */
export const OWNED = ownedOptions(findCommand('workspaces')!) as Readonly<Record<string, Action>>;

/** A row as `--json` prints it: `label` is null rather than absent, so every row has one shape. */
const shown = (row: TrackedWorkspace) => ({ id: row.id, root: row.root, label: row.label ?? null, added: row.added });
const withState = (row: TrackedWorkspace) => ({ ...shown(row), state: trackedState(row) });
const json = (value: object): Result => ({
  exitCode: 0,
  stdout: JSON.stringify({ version: 1, ...value }) + '\n',
  stderr: '',
});
const human = (blocks: readonly (readonly string[])[]): Result => ({
  exitCode: 0,
  stdout: document(blocks, { leadingBlank: true }),
  stderr: '',
});

const ROOT_MIN = 20,
  ID_MIN = 8;
const markOf = (ascii: boolean): string => (ascii ? '...' : '…');
/** The clusters of `text` that fit in `width` columns, from its start; a cluster is kept whole or dropped. */
function leading(text: string, width: number): string {
  let used = 0,
    out = '';
  for (const cluster of graphemes(text)) {
    used += clusterWidth(cluster);
    if (used > width) break;
    out += cluster;
  }
  return out;
}
/** The clusters of `text` that fit in `width` columns, from its end; a cluster is kept whole or dropped. */
function trailing(text: string, width: number): string {
  let used = 0,
    out = '';
  for (const cluster of [...graphemes(text)].reverse()) {
    used += clusterWidth(cluster);
    if (used > width) break;
    out = cluster + out;
  }
  return out;
}
/** `text` followed by the spaces that fill `width` columns. */
const fill = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - stringWidth(text)));
/**
 * Shortened in the middle, so both the volume and the folder name stay readable. Never wider than `width`: below room
 * for the mark and a character either side, the text is cut at the width instead.
 */
function middle(text: string, width: number, ascii: boolean): string {
  if (stringWidth(text) <= width) return text;
  const mark = markOf(ascii);
  if (width < mark.length + 2) return leading(text, width);
  const keep = width - mark.length;
  return leading(text, Math.ceil(keep / 2)) + mark + trailing(text, Math.floor(keep / 2));
}
/** Shortened at the end, for a word whose start is what identifies it; never wider than `width`. */
function head(text: string, width: number, ascii: boolean): string {
  if (stringWidth(text) <= width) return text;
  const mark = markOf(ascii);
  return width < mark.length + 1 ? leading(text, width) : leading(text, width - mark.length) + mark;
}
/** `clash`: a found workspace `find --apply` would refuse, as its id is tracked already or another found one takes it. */
type Row = { readonly id: string; readonly state: TrackedState | 'tracked' | 'new' | 'clash'; readonly root: string };
const SYMBOLS = {
  present: 'success',
  missing: 'warning',
  unreadable: 'warning',
  tracked: 'success',
  new: 'added',
  clash: 'warning',
} as const;
/**
 * `id  state  root`, two spaces apart, measured in display columns. The id and the root share the width the state leaves:
 * the root keeps at least 20 columns (or its whole width when narrower) and the id, shortened in the middle, at most what
 * remains, so a long id never pushes a row past the terminal. Where even those minimums do not fit, the rows are stacked
 * instead.
 */
export function table(rows: readonly Row[], caps: Capabilities): readonly string[] {
  const symbolWidth = Math.max(...rows.map((row) => statusSymbol(SYMBOLS[row.state], caps.ascii).width));
  const stateWidth = symbolWidth + 1 + Math.max(...rows.map((row) => row.state.length));
  const idBudget = Math.max(caps.width - (2 + 2 + stateWidth + 2 + ROOT_MIN), ID_MIN),
    idWidth = Math.min(Math.max(2, ...rows.map((row) => stringWidth(row.id))), idBudget);
  const rootNeed = Math.min(ROOT_MIN, Math.max(...rows.map((row) => stringWidth(row.root))));
  if (2 + idWidth + 2 + stateWidth + 2 + rootNeed > caps.width) return stacked(rows, caps);
  const rootWidth = Math.max(caps.width - (2 + idWidth + 2 + stateWidth + 2), ROOT_MIN);
  const header = style(`  ${'id'.padEnd(idWidth)}  ${'state'.padEnd(stateWidth)}  root`, 'dim', caps.color);
  return [
    header,
    ...rows.map((row) => {
      const symbol = statusSymbol(SYMBOLS[row.state], caps.ascii);
      const state = style(symbol.text, symbol.role, caps.color) + ` ${row.state}`.padEnd(stateWidth - symbol.width);
      return `  ${fill(middle(row.id, idWidth, caps.ascii), idWidth)}  ${state}  ${middle(row.root, rootWidth, caps.ascii)}`;
    }),
  ];
}
/**
 * One block per row, a blank line apart: the id, then the root and the state indented below it. Every line keeps to
 * the width, down to one column. The indents (2, then 4) give way first, so the widest state line stays whole while it
 * can; below that the state word is shortened at its end after the symbol, and without room for the symbol it stands
 * alone. The id and the root are shortened in the middle.
 */
export function stacked(rows: readonly Row[], caps: Capabilities): readonly string[] {
  const { width, ascii } = caps;
  const symbols = rows.map((row) => statusSymbol(SYMBOLS[row.state], ascii));
  const stateWidth = Math.max(...rows.map((row, index) => symbols[index]!.width + 1 + row.state.length));
  const inner = Math.max(Math.min(4, width - stateWidth), 0),
    outer = inner >= 4 ? 2 : 0;
  const state = (row: Row, symbol: StatusSymbol): string => {
    const budget = width - inner;
    if (budget >= symbol.width + 2)
      return `${style(symbol.text, symbol.role, caps.color)} ${head(row.state, budget - symbol.width - 1, ascii)}`;
    return style(head(row.state, budget, ascii), symbol.role, caps.color);
  };
  return rows.flatMap((row, index) => [
    ...(index === 0 ? [] : ['']),
    ' '.repeat(outer) + middle(row.id, width - outer, ascii),
    ' '.repeat(inner) + middle(row.root, width - inner, ascii),
    ' '.repeat(inner) + state(row, symbols[index]!),
  ]);
}
const line = (tokens: readonly Token[], symbol: 'success' | 'info' | 'warning', caps: Capabilities) =>
  entry([tokens], { depth: 0, symbol }, caps);

function list(context: Context, home: string): Result {
  const rows = readTracked(home).map(withState);
  if (context.json) return json({ workspaces: rows });
  const { caps } = context;
  if (rows.length === 0)
    return human([
      line(
        [
          ...words('No workspaces tracked. Add one with:'),
          atom('ia workspaces add <directory>,'),
          ...words('or find them with:'),
          atom('ia workspaces find <folder>'),
        ],
        'info',
        caps,
      ),
    ]);
  return human([
    [sectionLabel('Tracked workspaces', caps), ...table(terminalSafe(rows), caps)],
    line(words(listSummary(rows)), rows.every((row) => row.state === 'present') ? 'success' : 'warning', caps),
  ]);
}
/** `list`'s closing count: every row is one of present, missing or unreadable, and the last is named only when seen. */
export function listSummary(rows: readonly { readonly state: TrackedState }[]): string {
  const count = (state: TrackedState): number => rows.filter((row) => row.state === state).length;
  const unreadable = count('unreadable');
  return `${rows.length} tracked: ${count('present')} present, ${count('missing')} missing${unreadable === 0 ? '' : `, ${unreadable} unreadable`}.`;
}

async function add(context: Context, home: string, directory: string | undefined): Promise<Result> {
  const { args, host, caps } = context;
  const root = directory === undefined ? discoverRoot(host.cwd, home) : resolve(host.cwd, directory);
  if (root === undefined)
    throw new Refusal(
      'IA-DB-ROOT-INVALID',
      `No workspace (.ia/src) holds ${host.cwd}`,
      3,
      null,
      'Run "ia workspaces add <directory>" naming the workspace to track.',
    );
  const { status, row: tracked } = await trackWorkspace(
    home,
    { root, id: args.value('id'), label: args.value('label') },
    new Date(),
    { signal: host.signal },
  );
  if (context.json) return json({ status, workspace: withState(tracked) });
  const row = terminalSafe(tracked);
  return human([
    status === 'added'
      ? line([...words(`Tracked ${row.id} at`), atom(`${row.root}.`)], 'success', caps)
      : line([atom(row.root, null, 0), ...words(`is already tracked as ${row.id}.`)], 'info', caps),
  ]);
}

async function find(context: Context, home: string, folder: string): Promise<Result> {
  const { args, host, caps } = context;
  const depth = args.integer('depth', FIND_DEPTH);
  const given = resolve(host.cwd, folder);
  const roots = findWorkspaces(given, { depth, iaHome: home });
  // The folder as the walk read it, at its real path, or as given when it is a link the walk does not follow;
  // findWorkspaces has refused one that is not a directory.
  const walked = lstatSync(given).isSymbolicLink() ? given : realpathSync(given);
  const tracked = readTracked(home);
  const found = roots.map((root) => {
    const row = trackedRow(tracked, root);
    return { root, tracked: row !== undefined, id: row?.id ?? defaultTrackId(root) };
  });
  const untracked = found.filter((row) => !row.tracked);
  // The roots --apply would refuse for their id; --apply refuses the first before it asks.
  const clashes = idClashes(tracked, untracked);
  const clashing = new Set(clashes.flatMap((clash) => (clash.queued ? [clash.root, clash.other] : [clash.root])));
  if (args.flag('apply') && clashes.length > 0) throw idTaken(home, clashes[0]!);
  let applied = false,
    added: readonly TrackedWorkspace[] = [];
  if (args.flag('apply')) {
    const summary = document([
      [
        sectionLabel('Track', caps),
        ...untracked.flatMap((row) =>
          line([atom(terminalText(row.id), null, 0), atom(terminalText(row.root), null, 2)], 'info', caps),
        ),
      ],
    ]);
    applied =
      untracked.length === 0 ||
      args.flag('yes') ||
      (await confirm(host.interaction, summary, 'Track these workspaces? [y/N] '));
    if (applied)
      added = await trackWorkspaces(
        home,
        untracked.map((row) => row.root),
        new Date(),
        { signal: host.signal },
      );
  }
  if (context.json) return json({ folder: walked, found, applied, added: added.map((row) => row.id) });
  if (found.length === 0)
    return human([
      line(
        [...words('No workspaces found under'), atom(terminalText(walked)), ...words(`to depth ${depth}.`)],
        'info',
        caps,
      ),
    ]);
  const now = new Set(added.map((row) => row.id));
  const rows = found.map(
    (row) =>
      ({
        id: terminalText(row.id),
        root: terminalText(row.root),
        state: row.tracked || now.has(row.id) ? 'tracked' : clashing.has(row.root) ? 'clash' : 'new',
      }) as const,
  );
  const pending = rows.filter((row) => row.state !== 'tracked').length,
    folderPath = commandPath(walked);
  return human([
    [
      sectionLabel(`Workspaces under ${middle(terminalText(walked), caps.width - 17, caps.ascii)}`, caps),
      ...table(rows, caps),
    ],
    ...clashes.map((clash) => {
      const remedy = clashRemedy(clash),
        shownClash = terminalSafe(clash);
      return line(
        [
          ...(clash.queued
            ? [
                ...words(`Two found workspaces would both take the id ${shownClash.id}:`),
                atom(shownClash.other),
                ...words('and'),
                atom(`${shownClash.root}.`),
              ]
            : [
                ...words(`The id ${shownClash.id} is already tracked for`),
                atom(`${shownClash.other},`),
                ...words('so'),
                atom(shownClash.root),
                ...words('needs another id.'),
              ]),
          ...words(remedy.before),
          atom(`"${remedy.command}"`),
          ...words(remedy.after),
        ],
        'warning',
        caps,
      );
    }),
    added.length > 0
      ? line(words(`Tracked ${added.length} of ${found.length} found.`), 'success', caps)
      : pending === 0
        ? line(words(`All ${found.length} found are tracked.`), 'success', caps)
        : clashes.length > 0
          ? line(
              words(`${pending} of ${found.length} found ${pending === 1 ? 'is' : 'are'} not tracked.`),
              'info',
              caps,
            )
          : line(
              [
                ...words(`${pending} of ${found.length} found ${pending === 1 ? 'is' : 'are'} not tracked.`),
                ...(folderPath !== undefined
                  ? [...words('Track them with'), atom(`"ia workspaces find ${folderPath} --apply".`)]
                  : [
                      ...words('From that folder, run'),
                      atom('"ia workspaces find . --apply"'),
                      ...words(`to track them; ${PATH_OMITTED}.`),
                    ]),
              ],
              'info',
              caps,
            ),
  ]);
}

async function remove(context: Context, home: string, target: string): Promise<Result> {
  const removed = await untrackWorkspace(home, target, context.host.cwd, { signal: context.host.signal });
  if (context.json) return json({ removed: shown(removed) });
  const shownRemoved = terminalSafe(removed);
  return human([
    line(
      [
        ...words(`Untracked ${shownRemoved.id}`),
        atom(`(${shownRemoved.root}).`),
        ...words('Nothing on disk was changed.'),
      ],
      'success',
      context.caps,
    ),
  ]);
}

export async function runWorkspaces(context: Context): Promise<Result> {
  const { args, host } = context;
  const [action, target, extra] = args.positionals;
  if (!ACTIONS.includes(action as Action)) throw new UsageError('Workspaces action must be list, add, find or remove');
  for (const [name, owner] of Object.entries(OWNED))
    if (owner !== action && (args.flag(name) || args.value(name) !== undefined))
      throw new UsageError(`--${name} applies only to ia workspaces ${owner}`);
  if (extra !== undefined || (action === 'list' && target !== undefined))
    throw new UsageError(`Unexpected argument ${extra ?? target}`);
  if ((action === 'find' || action === 'remove') && target === undefined)
    throw new UsageError(`Expected ${action === 'find' ? '<folder>' : '<id|directory>'}`);
  // Arguments are judged before any state is read or a root discovered (§1.2), a malformed tracked file included.
  if (action === 'add' && args.value('id') !== undefined) checkTrackId(args.value('id')!);
  const home = iaHomeOf(host.env);
  if (home === undefined)
    throw new Refusal(
      'IA-DIST-INPUT-INVALID',
      'IA_HOME or IA_HOST_HOME is not an absolute path, so there is no IA home to keep the tracked list in',
      3,
      null,
      'Set IA_HOME to an absolute directory, or unset it to use ~/.ia; then run "ia workspaces list".',
    );
  try {
    if (action === 'list') return list(context, home);
    if (action === 'add') return await add(context, home, target);
    if (action === 'find') return await find(context, home, target!);
    return await remove(context, home, target!);
  } catch (error) {
    // writeHomeFile refuses a home that holds src/ (host plugin distribution spec §3); name the move that repairs it.
    if (!(error instanceof Refusal) && (error as { code?: unknown }).code === 'IA-DIST-PATH-UNSAFE')
      throw new Refusal(
        'IA-DIST-PATH-UNSAFE',
        (error as Error).message,
        3,
        null,
        homeSrcRemedy(home, 'ia workspaces list'),
      );
    throw error;
  }
}
