/**
 * `ia position`: the position for a scope key, as text or as one JSON value (apps/cli/SPEC.md, Workspace commands).
 *
 * What it tells is the runtime's `position`: body(K), the body's digest and the host note, read through a scope of the
 * whole workspace as the machine operation of the same name reads with no `within`, so a key asked either way gives
 * one body and one digest. The options spell the key part by part, and a value outside a part's domain is the
 * runtime's own refusal, decided before the workspace is read. The text is a rendering of the body, never part of it.
 */
import { normalizeScopeKey, position, SCOPE_KEY_PARTS } from '@inventarch/runtime';
import type { HostNote, Line, NormalizedScopeKey, Position, PositionBody, SeedKey } from '@inventarch/runtime';
import type { Arguments } from './args.js';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { hostFactsOf } from './host-facts.js';
import type { Capabilities, Field, Token } from './render.js';
import {
  atom,
  document,
  entry,
  entryColumn,
  fieldRows,
  headerLine,
  quote,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';
import { codeOf, messageOf, openSession } from './session.js';

/** The codes a scope key is refused with before any record is read: a malformed part, or a value outside its domain. */
const KEY_CODES: ReadonlySet<string> = new Set(['IA-RUNTIME-REQUEST-INVALID', 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN']);
const KEY_NEXT = 'Run "ia position --help" for the scope key parts and the values each accepts.';
const SEAT_NEXT =
  'Run "ia position" without --seat for the workspace seat, or pass a workspace-relative path such as docs/guide.md.';

/** A count option as the integer it spells; any other text stays text, which the runtime refuses for that part. */
const countOf = (text: string): number | string => (/^\d+$/.test(text) ? Number(text) : text);

/** The scope key the options spell, each option its own part, normalized as the runtime normalizes a key. */
export function keyOf(args: Arguments): NormalizedScopeKey {
  const key: Record<string, unknown> = {};
  for (const part of SCOPE_KEY_PARTS) {
    const value = args.value(part);
    if (value !== undefined) key[part] = part === 'depth' || part === 'budget' ? countOf(value) : value;
  }
  try {
    return normalizeScopeKey(key);
  } catch (error) {
    const code = codeOf(error, '');
    if (!KEY_CODES.has(code)) throw error;
    throw new Refusal(code, messageOf(error, code), 2, null, KEY_NEXT);
  }
}

/** The position at `root`, with this CLI's host facts; a seat path that leaves the workspace is refused with a next. */
export function collectPosition(root: string, key: NormalizedScopeKey, version: string): Position {
  const session = openSession(root);
  try {
    return position(session.reader, session.reader.resolveScope().token, key, {
      hostFacts: () => hostFactsOf(root, version),
    });
  } catch (error) {
    const code = codeOf(error, '');
    if (code === 'IA-DB-PATH-UNSAFE') throw new Refusal(code, messageOf(error, code), 1, null, SEAT_NEXT);
    throw error;
  } finally {
    session.close();
  }
}

/** A key as the command that asks for it: every part spelled, the seat and word only when the key has them. */
function spell(key: Omit<SeedKey, 'seat'>, seat: string | null): string {
  return [
    'ia position',
    ...(seat === null ? [] : [`--seat ${quote(seat)}`]),
    `--shape ${key.shape}`,
    `--phase ${key.phase}`,
    `--depth ${String(key.depth)}`,
    `--budget ${String(key.budget)}`,
    ...(key.word === null ? [] : [`--word ${quote(key.word)}`]),
  ].join(' ');
}
/** The key as it was asked: each part's value and how it was supplied, marked K0 when its value is K0. */
function keyText(note: HostNote): string {
  const { key } = note,
    from = key.sources;
  const parts = [
    `seat ${key.seat ?? 'workspace'} (${from.seat})`,
    `shape ${key.shape} (${from.shape})`,
    `phase ${key.phase} (${from.phase})`,
    `primitive ${key.primitive} (${from.primitive})`,
    `depth ${String(key.depth)} (${from.depth})`,
    `budget ${String(key.budget)} (${from.budget})`,
    `word ${key.word ?? 'none'} (${from.word})`,
  ].join(', ');
  return key.k0 ? `K0: ${parts}` : parts;
}
const dim = (text: string): readonly Token[] => words(text, 'dim', 2);
const row = (tokens: readonly Token[], caps: Capabilities): readonly string[] =>
  entry([tokens], { depth: 1, symbol: 'info' }, caps);
/** One record line: its identity and word, then its hop and how it was reached. */
function line(record: Line & { readonly blocking?: boolean }, caps: Capabilities): readonly string[] {
  return row(
    [
      atom(record.identity, 'cyan', 0),
      atom(record.word, null, 2),
      atom(`hop ${String(record.hop)}`, 'dim', 2),
      ...(record.blocking === true ? [atom('blocking', 'yellow', 2)] : []),
      ...(record.via === null ? [] : dim(`via ${record.via.by} ${record.via.spelling}`)),
    ],
    caps,
  );
}
/** A section: its label and count, then its rows; one with nothing to count is left out. */
const section = (
  label: string,
  rows: readonly (readonly string[])[],
  caps: Capabilities,
  counted = rows.length,
): readonly string[] => (counted === 0 ? [] : [sectionLabel(label, caps), ...rows.flat()]);
/** A command is unbreakable prose (§6.4), so it wraps whole. */
const command = (text: string): Token => atom(text, 'dim', 2);
const reach = (read: string | null): readonly Token[] => (read === null ? [] : [command(read)]);

function bodyBlocks(body: PositionBody, caps: Capabilities): readonly (readonly string[])[] {
  const { counts } = body;
  const tallied = body.tallies.reduce((sum, tally) => sum + tally.count, 0),
    captured = body.captured.reduce((sum, tally) => sum + tally.count, 0);
  return [
    section(
      `Loaded  ${String(counts.loaded)}${counts.truncated === 0 ? '' : `, ${String(counts.truncated)} cut by the budget`}`,
      body.loaded.map((record) => line(record, caps)),
      caps,
      counts.loaded,
    ),
    section(
      `Pointers  ${String(body.pointers.length)} of ${String(counts.pointers)}`,
      body.pointers.map((record) => line(record, caps)),
      caps,
      counts.pointers,
    ),
    section(
      `Tallies  ${String(tallied)} pointers past the limit`,
      body.tallies.map((tally) =>
        row(
          [
            atom(String(tally.count), null, 0),
            atom(tally.word, null, 2),
            ...dim(`in ${tally.system}`),
            ...reach(tally.read),
          ],
          caps,
        ),
      ),
      caps,
    ),
    section(
      `Frontier  ${String(counts.frontier)}`,
      body.frontier.map((tally) =>
        row(
          [
            atom(String(tally.count), null, 0),
            atom(tally.kind, null, 2),
            ...dim(`in ${tally.system}`),
            ...reach(tally.read),
          ],
          caps,
        ),
      ),
      caps,
    ),
    section(
      `Systems  ${String(body.systems.length)}`,
      body.systems.map((system) =>
        row([atom(system.system, 'cyan', 0), ...words(system.words.join(', '), null, 2), command(system.read)], caps),
      ),
      caps,
    ),
    section(
      `Captured  ${String(captured)}`,
      body.captured.length === 0
        ? []
        : [row(words(body.captured.map((tally) => `${tally.word} ${String(tally.count)}`).join(', ')), caps)],
      caps,
    ),
    section(
      `Applies by word  ${String(body.appliesByWord.listed.length)} of ${String(body.appliesByWord.count)}`,
      [
        ...body.appliesByWord.listed.map((applies) =>
          row(
            [
              atom(applies.identity, 'cyan', 0),
              atom(applies.word, null, 2),
              ...dim(`by ${applies.by.map((match) => `${match.field} ${match.value}`).join(', ')}`),
            ],
            caps,
          ),
        ),
        ...body.appliesByWord.tallies.map((tally) =>
          row(
            [
              atom(String(tally.count), null, 0),
              atom(tally.word, null, 2),
              ...dim(`in ${tally.system}`),
              ...reach(tally.read),
            ],
            caps,
          ),
        ),
      ],
      caps,
      body.appliesByWord.count,
    ),
    section(
      `Cells  ${String(body.cells.listed.length)} of ${String(body.cells.count)}`,
      body.cells.listed.map((cell) => [
        ...row(
          [
            ...(cell.address === null
              ? [atom(cell.playbook, 'cyan', 0), ...dim(`no cell at ${cell.phase}; nearest ${cell.nearest ?? 'none'}`)]
              : [atom(cell.address, 'cyan', 0), ...dim(cell.selection ?? 'no selection')]),
          ],
          caps,
        ),
        ...(cell.text === null
          ? []
          : entry([words(cell.text)], { column: entryColumn({ depth: 1, symbol: 'info' }, caps.ascii) }, caps)),
      ]),
      caps,
      body.cells.count,
    ),
    section(
      `Rules  ${String(body.rules.listed.length)} of ${String(body.rules.count)}${body.rules.truncated === 0 ? '' : `, ${String(body.rules.truncated)} cut by the budget`}`,
      body.rules.listed.map((rule) =>
        row(
          [
            atom(rule.identity, 'cyan', 0),
            atom(rule.word, null, 2),
            atom(rule.severity ?? 'no severity', null, 2),
            ...(rule.blocking ? [atom('blocking', 'yellow', 2)] : []),
            ...dim(`by ${rule.by.map((match) => `${match.by} ${match.value}`).join(', ')}`),
          ],
          caps,
        ),
      ),
      caps,
      body.rules.count,
    ),
    section(
      `Mandates  ${String(body.mandates.length)}`,
      body.mandates.map((mandate) =>
        row(
          [
            atom(mandate.identity, 'cyan', 0),
            ...dim(`participant ${mandate.participant ?? 'none'}`),
            ...(mandate.refusal === null ? [] : [atom(mandate.refusal.code, 'yellow', 2)]),
            ...(mandate.problem === null ? [] : dim(mandate.problem)),
          ],
          caps,
        ),
      ),
      caps,
    ),
    section(
      `Unknowns  ${String(body.unknowns.length)}`,
      body.unknowns.map((unknown) =>
        row(
          [
            atom(`${unknown.path}:${String(unknown.line)}`, 'cyan', 0),
            atom(unknown.identity, null, 2),
            ...dim(unknown.reason),
          ],
          caps,
        ),
      ),
      caps,
    ),
    [
      sectionLabel('Widen', caps),
      ...entry(
        [
          body.widening.deepen === null
            ? words('At the depth cap; no deeper key.')
            : [atom(spell(body.widening.deepen, body.widening.deepen.seat), null, 0), ...dim('one hop deeper')],
        ],
        { depth: 1, symbol: 'step' },
        caps,
      ),
      ...entry(
        [[atom(spell(body.widening.reseat, '<identity>'), null, 0), ...dim('re-seated at any line above')]],
        { depth: 1, symbol: 'step' },
        caps,
      ),
    ],
  ];
}

function noteBlock(note: HostNote, caps: Capabilities): readonly string[] {
  const digest = (value: string | null, absent: string): readonly Token[] =>
    words(value === null ? absent : truncateDigest(value, caps.ascii));
  const { captured, staleness } = note;
  const fields: Field[] = [
    { label: 'Revision', value: digest(note.revision, 'none') },
    {
      label: 'Captured',
      value: [
        atom(captured.freshness, null, 0),
        ...(captured.revision === null ? [] : dim(truncateDigest(captured.revision, caps.ascii))),
        ...(captured.previousRevision === null
          ? []
          : dim(`previous ${truncateDigest(captured.previousRevision, caps.ascii)}`)),
      ],
    },
    {
      label: 'Staleness',
      value: words(
        staleness === null
          ? 'nothing captured to compare'
          : `changed ${String(staleness.changed)}, new ${String(staleness.new)}, removed ${staleness.removed === null ? 'unknown' : String(staleness.removed)}, unchanged ${String(staleness.unchanged)}`,
      ),
    },
    { label: 'Installed', value: digest(note.installedStateDigest, 'unknown') },
    { label: 'CLI', value: words(note.cli ?? 'unknown') },
    { label: 'Adapter', value: words(note.adapter ?? 'none') },
    ...note.observations.map((observation) => ({
      label: 'Observation',
      symbol: 'warning' as const,
      value: words(`${observation.path}: ${observation.message}`),
    })),
  ];
  return [sectionLabel('Host note', caps), ...fieldRows(fields, { depth: 1 }, caps)];
}

/** The position as text: the seat, key and digest, the body's sections, the widening keys, then the host note. */
export function renderPosition(delivered: Position, caps: Capabilities): string {
  const { body, digest, hostNote } = delivered,
    { seat } = body;
  const at = seat.identity ?? seat.path ?? 'no @workspace';
  return document(
    [
      [
        ...headerLine('Position', at, [{ text: `revision ${truncateDigest(body.revision, caps.ascii)}` }], caps),
        ...fieldRows(
          [
            {
              label: 'Seat',
              value: words(
                [
                  seat.kind,
                  seat.home === null || seat.home === seat.identity ? null : `home ${seat.home}`,
                  seat.unknown,
                ]
                  .filter((part): part is string => part !== null && part !== undefined)
                  .join(', '),
              ),
            },
            { label: 'Key', value: words(keyText(hostNote)) },
            { label: 'Digest', value: [atom(truncateDigest(digest, caps.ascii), 'cyan', 0)] },
          ],
          { depth: 1 },
          caps,
        ),
      ],
      ...bodyBlocks(body, caps),
      noteBlock(hostNote, caps),
      entry(
        [words('Run "ia read <identity>" for one line\'s text, or "ia position --json" for the body as data.', 'dim')],
        { depth: 0 },
        caps,
      ),
    ],
    { leadingBlank: false },
  );
}

export function runPosition(context: Context): Result {
  // A key that cannot be a scope key is refused before any root or workspace is read.
  const key = keyOf(context.args);
  const delivered = collectPosition(requireRoot(context), key, context.host.version);
  if (context.json) {
    const { body, digest, hostNote } = delivered;
    return { exitCode: 0, stdout: JSON.stringify({ version: 1, body, digest, hostNote }) + '\n', stderr: '' };
  }
  return { exitCode: 0, stdout: renderPosition(delivered, context.caps), stderr: '' };
}
