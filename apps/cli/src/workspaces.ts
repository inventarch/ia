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
import type { Context, Result } from './consumer.js';
import { confirm, discoverRoot, iaHomeOf, Refusal } from './consumer.js';
import { homeSrcRemedy } from './home-remedy.js';
import type { Capabilities, StatusSymbol, Token } from './render.js';
import { atom, document, entry, sectionLabel, statusSymbol, style, words } from './render.js';
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
/** The options only one action reads; any other action refuses them as usage rather than ignoring them. */
const OWNED: Readonly<Record<string, Action>> = { id: 'add', label: 'add', depth: 'find', apply: 'find' };

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
/**
 * Shortened in the middle, so both the volume and the folder name stay readable. Never longer than `width`: below room
 * for the mark and a character either side, the text is cut at the width instead.
 */
function middle(text: string, width: number, ascii: boolean): string {
  if (text.length <= width) return text;
  const mark = markOf(ascii);
  if (width < mark.length + 2) return text.slice(0, Math.max(width, 0));
  const keep = width - mark.length;
  return text.slice(0, Math.ceil(keep / 2)) + mark + text.slice(text.length - Math.floor(keep / 2));
}
/** Shortened at the end, for a word whose start is what identifies it; never longer than `width`. */
function head(text: string, width: number, ascii: boolean): string {
  if (text.length <= width) return text;
  const mark = markOf(ascii);
  return width < mark.length + 1 ? text.slice(0, Math.max(width, 0)) : text.slice(0, width - mark.length) + mark;
}
/** `clash`: a found workspace `find --apply` would refuse, as its id is tracked already or another found one takes it. */
type Row = { readonly id: string; readonly state: TrackedState | 'tracked' | 'new' | 'clash'; readonly root: string };
const SYMBOLS = { present: 'success', missing: 'warning', tracked: 'success', new: 'added', clash: 'warning' } as const;
/**
 * `id  state  root`, two spaces apart. The id and the root share the width the state leaves: the root keeps at least 20
 * columns (or its whole length when shorter) and the id, shortened in the middle, at most what remains, so a long id
 * never pushes a row past the terminal. Where even those minimums do not fit, the rows are stacked instead.
 */
function table(rows: readonly Row[], caps: Capabilities): readonly string[] {
  const symbolWidth = Math.max(...rows.map((row) => statusSymbol(SYMBOLS[row.state], caps.ascii).width));
  const stateWidth = symbolWidth + 1 + Math.max(...rows.map((row) => row.state.length));
  const idBudget = Math.max(caps.width - (2 + 2 + stateWidth + 2 + ROOT_MIN), ID_MIN),
    idWidth = Math.min(Math.max(2, ...rows.map((row) => row.id.length)), idBudget);
  const rootNeed = Math.min(ROOT_MIN, Math.max(...rows.map((row) => row.root.length)));
  if (2 + idWidth + 2 + stateWidth + 2 + rootNeed > caps.width) return stacked(rows, caps);
  const rootWidth = Math.max(caps.width - (2 + idWidth + 2 + stateWidth + 2), ROOT_MIN);
  const header = style(`  ${'id'.padEnd(idWidth)}  ${'state'.padEnd(stateWidth)}  root`, 'dim', caps.color);
  return [
    header,
    ...rows.map((row) => {
      const symbol = statusSymbol(SYMBOLS[row.state], caps.ascii);
      const state = style(symbol.text, symbol.role, caps.color) + ` ${row.state}`.padEnd(stateWidth - symbol.width);
      return `  ${middle(row.id, idWidth, caps.ascii).padEnd(idWidth)}  ${state}  ${middle(row.root, rootWidth, caps.ascii)}`;
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
  const present = rows.filter((row) => row.state === 'present').length;
  return human([
    [sectionLabel('Tracked workspaces', caps), ...table(rows, caps)],
    line(
      words(`${rows.length} tracked: ${present} present, ${rows.length - present} missing.`),
      present === rows.length ? 'success' : 'warning',
      caps,
    ),
  ]);
}

function add(context: Context, home: string, directory: string | undefined): Result {
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
  const { status, row } = trackWorkspace(home, { root, id: args.value('id'), label: args.value('label') });
  if (context.json) return json({ status, workspace: withState(row) });
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
        ...untracked.flatMap((row) => line([atom(row.id, null, 0), atom(row.root, null, 2)], 'info', caps)),
      ],
    ]);
    applied =
      untracked.length === 0 ||
      args.flag('yes') ||
      (await confirm(host.interaction, summary, 'Track these workspaces? [y/N] '));
    if (applied)
      added = trackWorkspaces(
        home,
        untracked.map((row) => row.root),
      );
  }
  if (context.json) return json({ folder: walked, found, applied, added: added.map((row) => row.id) });
  if (found.length === 0)
    return human([
      line([...words('No workspaces found under'), atom(walked), ...words(`to depth ${depth}.`)], 'info', caps),
    ]);
  const now = new Set(added.map((row) => row.id));
  const rows = found.map(
    (row) =>
      ({
        id: row.id,
        root: row.root,
        state: row.tracked || now.has(row.id) ? 'tracked' : clashing.has(row.root) ? 'clash' : 'new',
      }) as const,
  );
  const pending = rows.filter((row) => row.state !== 'tracked').length,
    folderPath = commandPath(walked);
  return human([
    [sectionLabel(`Workspaces under ${middle(walked, caps.width - 17, caps.ascii)}`, caps), ...table(rows, caps)],
    ...clashes.map((clash) => {
      const remedy = clashRemedy(clash);
      return line(
        [
          ...(clash.queued
            ? [
                ...words(`Two found workspaces would both take the id ${clash.id}:`),
                atom(clash.other),
                ...words('and'),
                atom(`${clash.root}.`),
              ]
            : [
                ...words(`The id ${clash.id} is already tracked for`),
                atom(`${clash.other},`),
                ...words('so'),
                atom(clash.root),
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

function remove(context: Context, home: string, target: string): Result {
  const removed = untrackWorkspace(home, target, context.host.cwd);
  if (context.json) return json({ removed: shown(removed) });
  return human([
    line(
      [...words(`Untracked ${removed.id}`), atom(`(${removed.root}).`), ...words('Nothing on disk was changed.')],
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
    if (action === 'add') return add(context, home, target);
    if (action === 'find') return await find(context, home, target!);
    return remove(context, home, target!);
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
