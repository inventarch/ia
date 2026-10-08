/**
 * `ia position`: position-and-projection §1, §6 and §7 and design item 10; decisions scope-key-caps and
 * scope-verb-dispatch.
 *
 * The consumer verb over the runtime's `position`: body(K) for the scope key the flags name, its digest and the host
 * note. No flag names K0, the repository's workspace with its pointers and tallies only; a key naming any part takes
 * the runtime's defaults for the others (`normalizeScopeKey`). This verb prints the key used and the capture's
 * freshness, then the body's sections and its two widening keys as `ia position` commands, or with `--json` what the
 * Door's `position` operation returns. It is that operation as a consumer verb beside the frozen `ia scope` route,
 * never a machine route (plan amendment A2), and its key is read from closed flags only, so no request text reaches it.
 *
 * The workspace opens as every read verb opens it, without the db cache, and the position is read through the
 * whole-workspace scope, whose body also names the admission findings on loaded records (db PT5). Nothing is written:
 * a position needs no capture (plan amendment A9), whose state is only the note's freshness.
 */
import {
  COORDINATE_DOMAINS,
  RuntimeError,
  SCOPE_KEY_CAPS,
  normalizeScopeKey,
  parseLocator,
  position,
} from '@inventarch/runtime';
import type {
  LoadedEntry,
  PointerTally,
  PositionOutput,
  PositionRecord,
  PositionVia,
  ScopeKey,
} from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import type { Capabilities, Token } from './render.js';
import {
  atom,
  document,
  entry,
  headerLine,
  quote,
  remedyWords,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';
import { openSession } from './session.js';

export function positionEnvelope(output: PositionOutput): unknown {
  return { version: 1, ok: true, body: output.body, digest: output.digest, hostNote: output.hostNote };
}

/**
 * The partial key the flags name, each part as given, so the runtime checks its closed sets and caps and names the
 * command to run when one is outside them. A seat that spells a canonical identity is a record; any other is a
 * workspace path (`./` makes a path that would read as an identity one). A depth or budget of digits is its number;
 * any other text is passed on for the runtime to refuse.
 */
function partialKey(args: Context['args']): Partial<ScopeKey> {
  const seat = args.value('seat'),
    integer = (name: string): unknown => {
      const value = args.value(name);
      return value === undefined || !/^[0-9]+$/.test(value) ? value : Number(value);
    };
  const parts: Record<string, unknown> = {
    seat: seat === undefined ? undefined : parseLocator(seat)?.form === 'identity' ? seat : { path: seat },
    shape: args.value('shape'),
    phase: args.value('phase'),
    depth: integer('depth'),
    budget: integer('budget'),
    word: args.value('word'),
  };
  return Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined)) as Partial<ScopeKey>;
}

/** A location as `--seat` and this output spell it: the workspace root `''` as `.`. */
const spelled = (path: string): string => (path === '' ? '.' : path);
/** A key's seat as `--seat` spells it: a location `''` as `.`, and a path that would read as an identity with `./`. */
function seatFlag(seat: ScopeKey['seat']): string | undefined {
  if (seat === undefined || typeof seat === 'string') return seat;
  const path = spelled(seat.path);
  return parseLocator(path)?.form === 'identity' ? `./${path}` : path;
}
/** The `ia position` command for a key, every part spelled so it runs as the key it names, with the invocation's root. */
function positionCommand(key: Partial<ScopeKey>, rooted: string, seat = seatFlag(key.seat)): string {
  return (
    [
      'ia position',
      ...(seat === undefined ? [] : [`--seat ${quote(seat)}`]),
      ...(['shape', 'phase', 'depth', 'budget', 'word'] as const).flatMap((part) =>
        key[part] === undefined ? [] : [`--${part} ${quote(String(key[part]))}`],
      ),
    ].join(' ') + rooted
  );
}

/** The rule db D02b declares a location at a record by. */
const DECLARED = {
  system: 'its system folder',
  root: 'a root it declares',
  repository: "the repository's own @workspace",
} as const;
/** How an entry was first reached, in words: the row or field from its side, or its composition class. */
function viaText(via: PositionVia | undefined): string {
  if (via === undefined) return 'the seat';
  switch (via.by) {
    case 'row':
      return `${via.spelling} row from ${via.from}, declared by ${via.declaredBy}`;
    case 'field':
      return via.direction === 'out' ? `${via.field} of ${via.from}` : `its ${via.field} names ${via.from}`;
    case 'membership':
      return `captured under ${via.root === '' ? 'the workspace root' : via.root}`;
    case 'word':
      return `word member of ${via.system}`;
    case 'claim':
      return `claims it by ${via.matches.map((match) => `${match.field} ${match.selection}`).join(', ')}`;
    case 'declared-at':
      return `the record it is declared at, by ${DECLARED[via.rule]}`;
    case 'subject':
      return `${via.label}: ${via.matches.map((match) => `${match.field} ${match.value} (${match.record})`).join(', ')}`;
  }
}
/** One record entry: its identity, then its word, owner system, band, hop and reach, then its steward. */
const recordFacts = (record: PositionRecord & { readonly workspace?: string }): readonly (readonly Token[])[] => [
  [atom(record.identity, 'cyan', 0)],
  words(`@${record.word} of ${record.system}, band ${record.band}, hop ${record.hop}, ${viaText(record.via)}`, 'dim'),
  ...(record.steward === undefined ? [] : [[atom('steward', 'dim', 0), atom(record.steward, 'cyan', 2)]]),
  ...(record.workspace === undefined ? [] : [[atom('in workspace', 'dim', 0), atom(record.workspace, 'cyan', 2)]]),
];
const loadedFacts = (loaded: LoadedEntry): readonly (readonly Token[])[] =>
  'identity' in loaded
    ? recordFacts(loaded)
    : [[atom(spelled(loaded.path), 'cyan', 0)], words('a location, not a record', 'dim')];

/** One section: its label and an entry per item, or one dim line when it is empty. */
function section<T>(
  label: string,
  items: readonly T[],
  facts: (item: T) => readonly (readonly Token[])[],
  empty: string,
  caps: Capabilities,
): readonly string[] {
  return [
    sectionLabel(label, caps),
    ...(items.length === 0
      ? entry([words(empty, 'dim')], { depth: 1 }, caps)
      : items.flatMap((item) => entry(facts(item), { depth: 1, symbol: 'info' }, caps))),
  ];
}
/** One tally line: the owner system, the count and what it counts, then that system's steward. */
const tallyText = (
  tally: { readonly system: string; readonly count: number; readonly steward?: string },
  what: string,
) => `${tally.system}: ${tally.count} ${what}${tally.steward === undefined ? '' : `, steward ${tally.steward}`}`;
/** A pointer or applies-by-word tally: the records past the listed ones of one word and owner system. */
const moreFacts = (tally: PointerTally): readonly (readonly Token[])[] => [
  words(tallyText(tally, `more @${tally.word}`)),
];

/** The key as the note names it: each part, the seat as the caller spelled it or the repository's workspace. */
function keyText(key: ScopeKey): string {
  const seat =
    key.seat === undefined
      ? "the repository's workspace"
      : typeof key.seat === 'string'
        ? key.seat
        : spelled(key.seat.path);
  const parts = `seat ${seat}, shape ${key.shape}, phase ${key.phase}, depth ${key.depth}, budget ${key.budget}`;
  return key.word === undefined ? parts : `${parts}, word ${key.word}`;
}

/**
 * The key used and the capture's freshness; the loaded records, the pointers and their tallies; the rules and playbooks
 * that apply by word, with their tallies, and the playbook cells; the rules reserved outside the budget; the mandates;
 * the frontier; the unknowns; then the two widening keys as `ia position` commands, with the root this invocation gave:
 * one hop deeper (absent at depth 2), and the re-seat at any pointer or applies-by-word entry.
 */
export function renderPosition(output: PositionOutput, caps: Capabilities, rooted = ''): string {
  const { body, digest, hostNote } = output,
    seated = body.seat.identity ?? spelled(body.seat.path ?? '');
  const freshness =
    hostNote.freshness === 'stale'
      ? `stale: the capture is at revision ${truncateDigest(hostNote.capturedRevision ?? '', caps.ascii)}`
      : hostNote.freshness === 'current'
        ? 'current: the capture is at this revision'
        : 'no-capture: no capture is written; the body reads the live admitted revision';
  const counts = body.counts;
  const widening: (readonly Token[])[] = [
    ...(body.widening.deeper === undefined
      ? []
      : [remedyWords(`Run "${positionCommand(body.widening.deeper, rooted)}" for one hop deeper.`)]),
    remedyWords(
      `Run "${positionCommand(body.widening.reseat, rooted, '<identity>')}" with a pointer's or an applies-by-word entry's identity to re-seat there.`,
    ),
  ];
  return document(
    [
      headerLine(
        'Position',
        seated,
        [{ text: `revision ${truncateDigest(body.revision, caps.ascii)}`, column: 50 }],
        caps,
      ),
      entry(
        [
          [atom('key', 'dim', 0), ...words(keyText(hostNote.key), null, 2)],
          [atom('freshness', 'dim', 0), ...words(freshness, null, 2)],
          [atom('digest', 'dim', 0), atom(`sha256 ${truncateDigest(digest, caps.ascii)}`, null, 2)],
          words(
            `${counts.loaded} loaded of ${counts.seeds} seeds and ${counts.composition} composition, ${counts.truncatedLoaded} past the budget; ${counts.rules} rules, ${counts.pointers} pointers, ${counts.appliesByWord} applying by word, ${counts.frontier} frontier`,
            'dim',
          ),
        ],
        { depth: 1, symbol: 'info' },
        caps,
      ),
      section('Loaded', body.loaded, loadedFacts, 'Nothing is loaded.', caps),
      section('Pointers', body.pointers, recordFacts, 'No pointer.', caps),
      ...(body.pointerTallies.length === 0
        ? []
        : [section('Pointer tallies', body.pointerTallies, moreFacts, '', caps)]),
      section(
        'Applies by word (field match, not a row)',
        body.appliesByWord,
        recordFacts,
        'No rule or playbook applies by word.',
        caps,
      ),
      ...(body.appliesByWordTallies.length === 0
        ? []
        : [section('Applies-by-word tallies', body.appliesByWordTallies, moreFacts, '', caps)]),
      section(
        'Cells',
        body.cells,
        (cell) =>
          'address' in cell
            ? [[atom(cell.address, 'cyan', 0)], words(cell.text)]
            : [[atom(cell.missing, 'cyan', 0)], words(cell.message, 'dim')],
        'No playbook cell.',
        caps,
      ),
      section('Rules (reserved outside the budget)', body.rules, recordFacts, 'No blocking rule.', caps),
      section('Mandates', body.mandates, recordFacts, 'No mandate governs the seat.', caps),
      section('Frontier', body.frontier, (t) => [words(tallyText(t, `of kind ${t.kind}`))], 'No frontier.', caps),
      section(
        'Unknowns',
        body.unknowns,
        (unknown) => [
          [atom(unknown.kind, null, 0), ...words(unknown.message, null, 2)],
          ...(unknown.path === undefined
            ? []
            : [[atom(`${unknown.path}${unknown.line === undefined ? '' : `:${unknown.line}`}`, 'dim', 0)]]),
        ],
        'No unknown.',
        caps,
      ),
      widening.flatMap((fact) => entry([fact], { depth: 0, symbol: 'step' }, caps)),
    ],
    { leadingBlank: true },
  );
}

/**
 * Design row 27: the one command after a refusal of the key or of its seat, with the root the invocation gave, which
 * the runtime's own `next` (R14, R15) does not carry. The runtime's `next` names the part it corrects, and this verb
 * names that correction as a command it runs (design §11: the same call with the printed closed set): a shape or phase
 * outside its closed set, or a depth or budget past its cap, is this call again with the closed set or the cap in its
 * place; a word the closure does not register is the vocabulary; a seat of another form, one the workspace does not
 * admit, a path outside it and a seat at runtime placement are the position without it, K0, unless that seat is the one
 * K0 takes, which names the overview of what the workspace admits.
 */
function positionNext(error: RuntimeError, context: Pick<Context, 'command' | 'args'>, rooted: string): string {
  const [, , part] = (error.next ?? '').split(' ');
  switch (part) {
    case '--shape':
      return `Run "${respell(context, { options: { shape: [`<${COORDINATE_DOMAINS.shape.join('|')}>`] } })}" with one of the five shapes.`;
    case '--phase':
      return `Run "${respell(context, { options: { phase: [`<${COORDINATE_DOMAINS.phase.join('|')}>`] } })}" with one of the four phases.`;
    case '--depth':
      return `Run "${respell(context, { options: { depth: [String(SCOPE_KEY_CAPS.depth)] } })}" for the deepest position a key admits.`;
    case '--budget':
      return `Run "${respell(context, { options: { budget: [String(SCOPE_KEY_CAPS.budget)] } })}" for the largest budget a key admits.`;
  }
  if (error.next === 'ia vocabulary')
    return 'Run "ia vocabulary" for the words and the systems that own them; the message lists those this workspace registers.';
  if (error.next === 'ia inspect') return `Run "ia inspect${rooted}" for the overview of what the workspace admits.`;
  return `Run "ia position${rooted}" for the position of the repository's workspace, K0.`;
}
/**
 * §4.1: the runtime's refusal with its code and message unchanged. The key's form (its closed sets and caps) is
 * checked before the workspace is read, so its refusal reads nothing and is usage, exit 2; a word or seat the workspace
 * does not answer is exit 1, as `ia inspect` refuses an identity it does not admit, located at the workspace with a
 * seat identity as its identity.
 */
export function positionRefusal(
  error: unknown,
  context: Pick<Context, 'command' | 'args'>,
  root: string | undefined,
): unknown {
  if (!(error instanceof RuntimeError) || error.next === undefined) return error;
  const supplied = context.args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`,
    seat = partialKey(context.args).seat,
    identity = typeof seat === 'string' ? { identity: seat } : {};
  return new Refusal(
    error.code,
    error.message,
    root === undefined ? 2 : 1,
    root === undefined ? null : { path: root, ...identity },
    positionNext(error, context, rooted),
  );
}

export function runPosition(context: Context): Result {
  const { args, caps, json } = context;
  const partial = partialKey(args);
  try {
    normalizeScopeKey(partial);
  } catch (error) {
    throw positionRefusal(error, context, undefined);
  }
  const supplied = args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`;
  const root = requireRoot(context);
  const session = openSession(root);
  let got: PositionOutput;
  try {
    got = position(session.reader, session.reader.resolveScope().token, partial);
  } catch (error) {
    throw positionRefusal(error, context, root);
  } finally {
    session.close();
  }
  return json
    ? { exitCode: 0, stdout: JSON.stringify(positionEnvelope(got)) + '\n', stderr: '' }
    : { exitCode: 0, stdout: renderPosition(got, caps, rooted), stderr: '' };
}
