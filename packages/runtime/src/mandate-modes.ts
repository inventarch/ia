import type { CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';
import { MOVES as KERNEL_MOVES } from '@inventarch/language';
import type { ReadHandle, UnadmittedRecord } from '@inventarch/db';
import { reaches, selects } from '@inventarch/graph';
import { RUNTIME_CODES, RuntimeError } from './errors.js';
import type { RuntimeCode, RuntimeWhere } from './errors.js';
import { freeze } from './types.js';

/**
 * Mandate authority as closed moves (position-and-projection design, items 2c and 13).
 *
 * A `@mandate` may declare an `authority` section: the participant it binds, the moves it allows (closed to the five
 * kernel moves), the workspaces it scopes, and the words and path selections it excludes or covers. This module
 * publishes the CLI mode -> move table and the pure refusal check that the authoring verbs will consume, and resolves
 * the authored mandates that govern an actor at a workspace or path, the actor a command acts as when none is named and
 * the refusal profile those mandates give a mode (plan amendment C1). The CLI's profile module and the generated
 * mandate guard consume these checks for their gated commands and host events. A mandate adds closed restrictions
 * only; it never grants host permissions, and a mandate without
 * `authority.moves` restricts no move.
 */

/** The five kernel moves, in kernel order. */
export const MOVES = KERNEL_MOVES;
export type Move = (typeof MOVES)[number];

/** One kernel move per CLI mode (design item 13). */
export const MODE_MOVES = Object.freeze({
  read: 'Observation',
  validate: 'Verification',
  author: 'Synthesis',
  effect: 'Execution',
  're-seat': 'Delegation',
} as const satisfies Readonly<Record<string, Move>>);
export type Mode = keyof typeof MODE_MOVES;
/** The modes in table order. */
export const MODES: readonly Mode[] = Object.freeze(Object.keys(MODE_MOVES) as Mode[]);
export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && Object.hasOwn(MODE_MOVES, value);
}

export type MandateCode = Extract<RuntimeCode, `IA-RUNTIME-MANDATE-${string}`>;
/** The refusal codes a mandate, a profile or the default actor can return; each is registered in RUNTIME_CODES. */
export const MANDATE_CODES: readonly MandateCode[] = Object.freeze(
  RUNTIME_CODES.filter((code): code is MandateCode => code.startsWith('IA-RUNTIME-MANDATE-')),
);

/** The `authority` section of one compiled `@mandate`; an absent field is an absent restriction. */
export interface MandateAuthority {
  readonly identity: string;
  /** The name of the `@agent` the mandate binds (`authority.participant`). */
  readonly participant?: string;
  /** The moves the mandate allows (`authority.moves`); absent, it allows every move. */
  readonly moves?: readonly Move[];
  /** Words the participant may not author (`authority.excluded-words`). */
  readonly excludedWords?: readonly string[];
  /** The names of the `@workspace` records the mandate applies in (`authority.scope`). */
  readonly scope?: readonly string[];
  /** Path selections the mandate claims (`authority.covers`). */
  readonly covers?: readonly string[];
}

export interface MandateRefusal {
  readonly code: MandateCode;
  readonly message: string;
  /** Exactly one catalog command with closed arguments. */
  readonly next: string;
}

const invalid = (message: string, where?: RuntimeWhere): never => {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message, undefined, where);
};
/** Where a compiled record is authored, for a refusal of its authority (RuntimeError `where`). */
const sourceOf = (record: CompiledRecord): RuntimeWhere => ({
  path: record.source.path,
  line: record.source.line,
  identity: record.identity,
});
/** Every value authored under `authority.<key>`: a repeated list key contributes each of its lists' items. */
function authorityValues(record: CompiledRecord, key: string): readonly CompiledValue[] {
  const fields = record.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .filter((child): child is CompiledField => 'key' in child && child.key === key);
  for (const field of fields)
    if (field.when !== undefined || field.fields !== undefined || field.value.kind === 'block')
      invalid(`${record.identity}: authority.${key} must be an unconditional inline value`, sourceOf(record));
  return fields.flatMap((field) => (field.value.kind === 'list' ? field.value.items : [field.value]));
}
function texts(record: CompiledRecord, key: string): readonly string[] {
  return authorityValues(record, key).map((value) =>
    value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose'
      ? value.text
      : invalid(`${record.identity}: authority.${key} holds a value that is not text`, sourceOf(record)),
  );
}
function names(record: CompiledRecord, key: string, discriminator: string): readonly string[] {
  return authorityValues(record, key).map((value) =>
    value.kind === 'ref' && value.discriminator === discriminator && value.fragment === undefined
      ? value.name
      : invalid(
          `${record.identity}: authority.${key} holds a value that is not a @${discriminator} reference`,
          sourceOf(record),
        ),
  );
}
function isMove(value: string): value is Move {
  return (MOVES as readonly string[]).includes(value);
}
/** Whether `record` states `section.key` at all: a declared empty list is stated, an absent key is not. */
function states(record: CompiledRecord, section: string, key: string): boolean {
  return record.sections
    .filter((candidate) => candidate.name === section)
    .flatMap((candidate) => candidate.fields)
    .some((child) => 'key' in child && child.key === key);
}
/**
 * Whether `record` states `section.key` with a value: a declared empty list locates nothing, so a mandate whose
 * `scope []` or `covers []` is its only location stays located by its participant, and an empty list never lifts a
 * restriction (a mandate only adds restrictions).
 */
function statesValue(record: CompiledRecord, section: string, key: string): boolean {
  return record.sections
    .filter((candidate) => candidate.name === section)
    .flatMap((candidate) => candidate.fields)
    .some(
      (child) =>
        'key' in child &&
        child.key === key &&
        !('value' in child && child.value.kind === 'list' && child.value.items.length === 0),
    );
}

/** The text values `record` states at `authority.covers`, a list's items one by one, as db's G06c claimant index reads them. */
function coversOf(record: CompiledRecord): readonly string[] {
  return record.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .flatMap((child) =>
      'key' in child && child.key === 'covers'
        ? (child.value.kind === 'list' ? child.value.items : [child.value]).flatMap((value) =>
            'text' in value ? [value.text] : [],
          )
        : [],
    );
}

/** Read the authority a compiled `@mandate` declares; a non-mandate or a malformed field is IA-RUNTIME-REQUEST-INVALID. */
export function mandateAuthorityOf(record: CompiledRecord): MandateAuthority {
  if (record.discriminator !== 'mandate') invalid(`${record.identity} is not a @mandate`, sourceOf(record));
  const participants = names(record, 'participant', 'agent');
  if (participants.length > 1)
    invalid(`${record.identity}: authority.participant names more than one agent`, sourceOf(record));
  const present = (key: string) => authorityValues(record, key).length > 0;
  const moves = texts(record, 'moves').map((move) =>
    isMove(move)
      ? move
      : invalid(`${record.identity}: authority.moves names ${move}, not a kernel move`, sourceOf(record)),
  );
  // Presence is judged by the key: a declared but empty list names no move, which the design's one-or-more refuses
  // rather than reading as a lockout of every mode or as an absent restriction. Admission refuses such a list since lane
  // D (compliance C05), so a record a reader admitted never reaches this; it stays as defence in depth.
  const hasMoves = states(record, 'authority', 'moves');
  if (hasMoves && moves.length === 0)
    invalid(`${record.identity}: authority.moves must name at least one kernel move`, sourceOf(record));
  return Object.freeze({
    identity: record.identity,
    ...(participants.length === 1 ? { participant: participants[0]! } : {}),
    ...(hasMoves ? { moves: Object.freeze(moves) } : {}),
    ...(present('excluded-words') ? { excludedWords: Object.freeze(texts(record, 'excluded-words')) } : {}),
    ...(present('scope') ? { scope: Object.freeze(names(record, 'scope', 'workspace')) } : {}),
    ...(present('covers') ? { covers: Object.freeze(texts(record, 'covers')) } : {}),
  });
}

/**
 * Undefined when the mandate permits `mode` for `words`, else one refusal. The move is judged first: a declared move
 * list admits only the moves it lists and must name at least one (an empty list is IA-RUNTIME-REQUEST-INVALID); a
 * mandate without moves restricts no move. Then any word in `excluded-words` is refused, whatever the moves. `next`
 * names the one catalog command that shows the mandate.
 */
export function mandateRefusal(
  mandate: MandateAuthority | CompiledRecord,
  mode: Mode,
  words: readonly string[] = [],
): MandateRefusal | undefined {
  if (!isMode(mode)) invalid(`Mode must be one of ${MODES.join(', ')}`);
  const authority = 'sections' in mandate ? mandateAuthorityOf(mandate) : mandate;
  if (authority.moves !== undefined && authority.moves.length === 0)
    invalid(`${authority.identity}: authority.moves must name at least one kernel move`);
  const move = MODE_MOVES[mode];
  const next = `ia inspect ${authority.identity} --edges both`;
  if (authority.moves !== undefined && !authority.moves.includes(move))
    return Object.freeze({
      code: 'IA-RUNTIME-MANDATE-MOVE',
      message: `${authority.identity} allows ${authority.moves.join(', ')}; ${mode} needs ${move}`,
      next,
    });
  const excluded = words.filter((word) => authority.excludedWords?.includes(word));
  if (excluded.length > 0)
    return Object.freeze({
      code: 'IA-RUNTIME-MANDATE-WORD',
      message: `${authority.identity} excludes ${excluded.join(', ')}`,
      next,
    });
  return undefined;
}

/**
 * Mandate resolution (plan amendment C1; operator decision OD1): one answer to "which `@mandate` governs this actor
 * here" for the CLI's refusal profile and the edit guard. Every read goes through the scope token `within` and none
 * needs a clean scope: a workspace with admission errors resolves the records admission admitted, except that an
 * authored `@mandate` that failed admission fails every resolver closed (`refusedMandates`; lane D, operator ruling
 * 2026-10-12). Only authored mandates (band 100) govern, only those of the workspace's closure as position reads it
 * (plan amendment A8), and a record at runtime placement is never read.
 */

/** Lane D, D1: one authored `@mandate` that failed admission, and the admission finding that refused it. */
export interface RefusedMandate {
  /**
   * Its canonical identity, when db compiled the record or spec 3.1 names its parsed header; absent for a header only
   * the source text shows.
   */
  readonly identity?: string;
  readonly path: string;
  /** Its header line. */
  readonly line: number;
  /** The code and message of its own admission finding, as db records it (`UnadmittedRecord.finding`). */
  readonly code: string;
  readonly message: string;
  /**
   * Present when db cannot tell what the line declares (an error line of a file refused whole that no identified record
   * accounts for; review D2-R2): it may be a mandate, so it counts as one.
   */
  readonly unidentified?: true;
}
/**
 * Lane D, D1: every `@mandate` of the workspace's own authored sources (band 100) that failed admission, frozen, by path
 * then line, each with its own admission finding as db records it (db `unadmitted`): (a) one admission refused,
 * `refused` naming it; (b) both occurrences of a mandate identity that ties at band 100; (c) one a file refused whole
 * declares, by a language error or a duplicate requirement id, as db's own parse of the file reads its headers, or as
 * its captured text shows a header the parse could not read, or a `@mandate` token on a line no parsed record spans; and
 * (d) review D2-R2: every record db cannot identify (db D15 lists it with no word, by the rules and limits D15 states),
 * which may be a mandate, so it counts as one, marked `unidentified`, except at a line db also lists a mandate at, which
 * is counted once, as that mandate (review D2 recheck F3). A record is a mandate when its word is `mandate` or its
 * identity's facet is, or when db names no word. The band is the one db reads from the source's placement, as capture
 * membership and governingMandates read it, so a mandate refused inside an installed base (band 90) never counts: it
 * never governs.
 *
 * It reads db's root view, not a scope: a record admission refused belongs to no scope, and its scope, covers and
 * participant cannot be trusted, so what it fails closed (D2) it fails closed workspace-wide.
 */
export function refusedMandates(reader: ReadHandle): readonly RefusedMandate[] {
  const authored = reader.unadmitted.filter((entry) => entry.band === 100),
    mandated = (entry: UnadmittedRecord): boolean =>
      entry.word === 'mandate' || entry.identity?.split('/')[2] === 'mandate',
    at = new Set(authored.filter(mandated).map((entry) => JSON.stringify([entry.path, entry.line])));
  return freeze(
    authored
      .filter((entry) =>
        entry.word === undefined ? !at.has(JSON.stringify([entry.path, entry.line])) : mandated(entry),
      )
      .map(
        (entry): RefusedMandate => ({
          ...(entry.identity === undefined ? {} : { identity: entry.identity }),
          path: entry.path,
          line: entry.line,
          code: entry.finding.code,
          message: entry.finding.message,
          ...(entry.word === undefined ? { unidentified: true as const } : {}),
        }),
      ),
  );
}
/**
 * Lane D, D9: one admitted authored record a `@mandate` resolution reads whose typed reference names an authored record
 * that failed admission: a `@mandate` whose `authority.participant` names a refused `@agent` (whom it binds) or whose
 * `authority.scope` names a refused `@workspace` (where it governs), or a `@workspace` whose `composition.steward`
 * names a refused `@agent` (the default actor every mandate there judges).
 */
export interface RefusedDependency {
  /** The admitted authored record whose field names the refused one, a `@mandate` or a `@workspace`, by identity. */
  readonly dependent: string;
  readonly field: 'authority.participant' | 'authority.scope' | 'composition.steward';
  /** The reference as authored, `@agent <name>` or `@workspace <name>`. */
  readonly reference: string;
  /** The refused record's identity, when db names one. */
  readonly identity?: string;
  /** Where the refused record is authored: its path and header line. */
  readonly path: string;
  readonly line: number;
  /** The code and message of the refused record's own admission finding. */
  readonly code: string;
  readonly message: string;
}
/** The references D9 follows: the holder's word, the field, and the word the field's references name. */
const DEPENDENCIES = [
  { holder: 'mandate', section: 'authority', key: 'participant', word: 'agent' },
  { holder: 'mandate', section: 'authority', key: 'scope', word: 'workspace' },
  { holder: 'workspace', section: 'composition', key: 'steward', word: 'agent' },
] as const;
/** The names, as authored, of the `@<word>` references `record` states at `section.key`, list items one by one. */
function referenced(record: CompiledRecord, section: string, key: string, word: string): readonly string[] {
  return record.sections
    .filter((candidate) => candidate.name === section)
    .flatMap((candidate) => candidate.fields)
    .flatMap((child) =>
      'key' in child && child.key === key
        ? (child.value.kind === 'list' ? child.value.items : [child.value]).flatMap((value) =>
            value.kind === 'ref' && value.discriminator === word ? [value.name] : [],
          )
        : [],
    );
}
/**
 * Lane D, D9: every admitted authored (band 100) record whose resolution a refused authored record would change, frozen,
 * by dependent identity, field, path and line: a `@mandate` whose `authority.participant` or `authority.scope`, or a
 * `@workspace` whose `composition.steward`, names, as authored, an authored `@agent` or `@workspace` that failed
 * admission (db `unadmitted`, band 100), matched by word and name, lowercased, so a tie, a schema refusal and a file
 * refused whole all count. Admission drops the refused record, so that reference resolves to nothing, or to a record of
 * another band, and the mandate silently binds no one, governs nowhere, or judges another default actor; the D8 probes
 * showed each lifting a restriction. A reference no authored record answers at all, or one to a record refused in an
 * installed base (band 90), is no dependency: it keeps today's reading. Neither is a refused `@agent` or `@workspace` no
 * admitted mandate or workspace names. Like refusedMandates it reads db's root view, not a scope.
 */
export function refusedDependencies(reader: ReadHandle): readonly RefusedDependency[] {
  const refused = reader.unadmitted.filter(
    (entry) => entry.band === 100 && (entry.word === 'agent' || entry.word === 'workspace'),
  );
  if (refused.length === 0) return freeze([]);
  const found = new Map<string, RefusedDependency>();
  for (const node of reader.records())
    for (const { holder, section, key, word } of DEPENDENCIES) {
      if (node.band !== 100 || node.discriminator !== holder) continue;
      for (const name of referenced(node, section, key, word))
        for (const entry of refused) {
          if (entry.word !== word || (entry.name ?? entry.identity?.split('/')[3]) !== name.toLowerCase()) continue;
          const field = `${section}.${key}` as RefusedDependency['field'];
          found.set(JSON.stringify([node.identity, field, entry.path, entry.line]), {
            dependent: node.identity,
            field,
            reference: `@${word} ${name}`,
            ...(entry.identity === undefined ? {} : { identity: entry.identity }),
            path: entry.path,
            line: entry.line,
            code: entry.finding.code,
            message: entry.finding.message,
          });
        }
    }
  return freeze(
    [...found.values()].sort(
      (a, b) => order(a.dependent, b.dependent) || order(a.field, b.field) || order(a.path, b.path) || a.line - b.line,
    ),
  );
}
/**
 * Review D-R2: whether `error` is the refusal `requireMandatesAdmitted` raises, an authored record a mandate resolution
 * reads having failed admission, so a caller names the admission report and a hand edit, not a governance position
 * (which, for a refused record that shares its identity with an admitted one of another band, would show that one).
 */
export function isAdmissionRefusal(error: unknown): error is RuntimeError & { readonly admission: 'refused' } {
  return error instanceof RuntimeError && error.admission === 'refused';
}
/**
 * Lane D, D2 and D9: IA-RUNTIME-REQUEST-INVALID, marked `admission: 'refused'` (`isAdmissionRefusal`), when any
 * authored `@mandate` failed admission, or any record a mandate resolution depends on did (`refusedDependencies`). The
 * decision reads db's root view, whatever `within` binds; what the error discloses does not (review D-N4, db PT5): through
 * a whole-workspace token (`isCompleteScope`) it names the first refused mandate db identifies, else the first record
 * db cannot identify (`unidentified`, review D2-R2), else the first dependency, the refused
 * record located on the error as `where`, with its admission code and message; through a narrowed token it names no
 * path, record or finding and carries no `where`. Every public resolver that reads a handle (governingMandates,
 * seatedWorkspace and defaultActor) calls it first, after reading its token, so the CLI's profile and the edit guard fail
 * closed rather than read a workspace whose restrictions a broken record may have lifted. An unknown or stale token keeps
 * its database code.
 */
export function requireMandatesAdmitted(reader: ReadHandle, within: string): void {
  if (typeof within !== 'string' || within.length === 0) invalid('Runtime reads require an explicit scope token');
  reader.snapshot({ within });
  const refused = refusedMandates(reader),
    dependencies = refusedDependencies(reader);
  if (refused.length === 0 && dependencies.length === 0) return;
  const fail = (message: string, where?: RuntimeWhere): never => {
    throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message, undefined, where, 'refused');
  };
  const closed =
    'every mandate-gated decision fails closed across the workspace, since whom a mandate binds, where it governs or who acts by default cannot be trusted';
  if (!reader.isCompleteScope(within))
    fail(
      `an authored @mandate, or a record a mandate resolution reads, failed admission; ${closed}; read it through a whole-workspace scope`,
    );
  const records = (count: number): string => `${count} record${count === 1 ? '' : 's'} a mandate resolution reads`;
  const where = (entry: RefusedMandate | RefusedDependency): RuntimeWhere => ({
    path: entry.path,
    line: entry.line,
    ...(entry.identity === undefined ? {} : { identity: entry.identity }),
  });
  if (refused.length > 0) {
    // Review D2-R2: a mandate db identifies is named first, a record it cannot identify only when there is none; the
    // rest are counted by kind.
    const identified = refused.filter((entry) => entry.unidentified !== true),
      first = identified[0] ?? (refused[0] as RefusedMandate),
      unknown = first.unidentified === true,
      count = (n: number, kind: string): readonly string[] =>
        n === 0 ? [] : [`${n} ${kind} record${n === 1 ? '' : 's'}`],
      counted = [
        ...count(identified.length - (unknown ? 0 : 1), 'more @mandate'),
        ...count(
          refused.length - identified.length - (unknown ? 1 : 0),
          unknown ? 'more unidentified' : 'unidentified',
        ),
      ],
      who = unknown
        ? `an unidentified record at ${first.path}:${first.line}, possibly a @mandate,`
        : first.identity === undefined
          ? `the @mandate at ${first.path}:${first.line}`
          : `${first.identity} (${first.path}:${first.line})`,
      more = counted.length === 0 ? '' : ` (${counted.join(' and ')} failed admission)`,
      also = dependencies.length === 0 ? '' : `, and ${records(dependencies.length)} failed admission`;
    fail(`${who} failed admission: ${first.code} ${first.message}${more}${also}; ${closed}`, where(first));
  }
  const [first] = dependencies as [RefusedDependency],
    rest = dependencies.length - 1,
    more =
      rest === 0 ? '' : ` (${rest} more record${rest === 1 ? '' : 's'} a mandate resolution reads failed admission)`;
  fail(
    `${first.dependent} depends on ${first.reference} through ${first.field}, and ${first.identity ?? first.reference} (${first.path}:${first.line}) failed admission: ${first.code} ${first.message}${more}; ${closed}`,
    where(first),
  );
}

/** Where governingMandates resolves, `workspace` and `path`, and for whom, `actor`. */
export interface GoverningOptions {
  /**
   * An admitted `@agent` identity: each governing mandate then says whether it `binds` the actor, and the actor's own
   * mandates that state neither `authority.scope` nor `authority.covers` govern wherever it acts.
   */
  readonly actor?: string;
  /** A workspace-relative path: a mandate whose `authority.covers` selects it governs there (db D02b claimants). */
  readonly path?: string;
  /**
   * An admitted `@workspace` identity: a mandate whose `authority.scope` names it governs there. Its closure is the one
   * read; without it, that of the workspace position seats `path` in, or with no path the repository's own.
   */
  readonly workspace?: string;
  /**
   * A key applied to `path` and to each `authority.covers` selection before they are matched (db `pathKey`, which the
   * edit guard and the CLI's mandate profile pass): a mandate then claims the path when the G06c dialect selects
   * `fold(path)` with `fold(selection)`. `pathKey` folds case on win32 and darwin whatever the volume, so there
   * `DOCS/x.md` is under `covers ["docs/"]`, and on a case-sensitive directory a sibling spelled in another case is
   * claimed too; on other platforms case is significant. Absent, the claims are db's G06c claimants, matched
   * case-sensitively as the dialect defines them.
   */
  readonly fold?: (text: string) => string;
}
/**
 * One authored `@mandate` that governs, its authority as mandateAuthorityOf reads it with the references resolved;
 * `moves`, `covers` and `excludedWords` are present exactly when the record states the key (a declared empty list is
 * stated), as the position packet renders them.
 */
export interface GoverningMandate {
  readonly identity: string;
  /** Only authored mandates govern. */
  readonly band: 100;
  /** The `@agent` identity `authority.participant` resolves to, or the reference as authored when none answers it. */
  readonly participant?: string;
  /**
   * Present exactly when an `actor` is given: whether the mandate binds it, its participant resolving to the actor or
   * naming none. One that does not governs here for another participant, and profileRefusal leaves it out.
   */
  readonly binds?: boolean;
  /** `authority.moves`; absent, the mandate restricts no move. */
  readonly moves?: readonly Move[];
  /** `authority.scope`: the `@workspace` identity each reference resolves to, or the reference as authored. */
  readonly scope: readonly string[];
  /** `authority.covers`, the path selections it claims. */
  readonly covers?: readonly string[];
  /** `authority.excluded-words`. */
  readonly excludedWords?: readonly string[];
}
/** OD1: the actor a mandate-gated command acts as when none is named. */
export interface DefaultActor {
  /** The `@agent` identity; absent when OD1 names none. */
  readonly actor?: string;
  /**
   * What named it: the workspace's `composition.steward`, an authored `@agent`, or the one participant the workspace's
   * mandates name.
   */
  readonly by?: 'steward' | 'participant';
  /**
   * The authored `@agent` records an authored mandate of the workspace's closure scoped to it names as participant, by
   * identity: the participants the position packet lists when K0 seats at the workspace (B3).
   */
  readonly participants: readonly string[];
  /**
   * The `@agent` identities a command may be told to act as at the workspace, sorted: the participants and, when it is
   * an authored `@agent`, the workspace's `composition.steward`, which may be no participant (review C2-R1).
   */
  readonly actors: readonly string[];
  /** Present exactly when `actor` is absent: why none is named, and the choice that would name one. */
  readonly reason?: string;
  /**
   * Present exactly when several participants leave the choice open: IA-RUNTIME-MANDATE-ACTOR, which a mandate-gated
   * command returns. With no participant there is none: the command's profile is resolved without an actor, every
   * mandate that governs there judged, and it runs unrestricted, with profileRefusal's notice, only when none governs.
   */
  readonly refusal?: MandateRefusal;
}
/**
 * What profileRefusal judges of one governing mandate; a GoverningMandate and a MandateAuthority are both one. A
 * mandate whose `binds` is false governs for another participant: it is left out of the judgement, and `participant`
 * names whom it binds.
 */
export type ProfileMandate = Pick<MandateAuthority, 'identity' | 'participant' | 'moves' | 'excludedWords'> & {
  readonly binds?: boolean;
};
/** profileRefusal's verdict: the mode is allowed exactly when it holds no refusal. */
export interface ProfileVerdict {
  /**
   * Present when the governing mandates bind no actor here or several participants, or refuse the mode's move or a
   * target word.
   */
  readonly refusal?: MandateRefusal;
  /** Present exactly when no mandate governs: nothing is restricted. */
  readonly notice?: string;
}

const UNGOVERNED =
  'no authored @mandate governs here, so no move or word is restricted (a mandate only adds restrictions)';
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Design §11's one next command for a mandate refusal, `ia scope` read as `ia position` (decision scope-verb-dispatch). */
const governance = (seat: string): string => `ia position --seat ${seat} --shape governance`;

/**
 * The records the scope token admits, runtime placement left out, and the reads of them that go through it; first,
 * IA-RUNTIME-REQUEST-INVALID when an authored `@mandate` failed admission (`failClosed`, lane D).
 */
function admitted(reader: ReadHandle, within: string) {
  if (typeof within !== 'string' || within.length === 0) invalid('Runtime reads require an explicit scope token');
  // An unknown or stale token keeps its database code: the scope is read before the workspace is judged.
  const read = { within },
    snapshot = reader.snapshot(read);
  requireMandatesAdmitted(reader, within);
  const nodes = new Map(
      snapshot.records.filter((node) => node.placement.kind !== 'runtime').map((node) => [node.identity, node]),
    ),
    rootOf = new Map(snapshot.membership.map((row) => [row.identity, row.root])),
    roots = reader.roots(read),
    declared = new Set(roots.map((root) => root.root));
  const ownOf = (workspace: string | undefined): ReadonlySet<string> =>
    new Set(roots.filter((root) => root.workspace === workspace).map((root) => root.root));
  const holds = (own: ReadonlySet<string>, identity: string): boolean => {
    const band = nodes.get(identity)!.band,
      root = rootOf.get(identity)!;
    return band === 10 || band === 90 || (own.size > 0 ? own.has(root) : !declared.has(root));
  };
  const repository = (): string | undefined => {
    const at = reader.resolveSeat('', read).seat;
    return at !== undefined && nodes.get(at)?.discriminator === 'workspace' ? at : undefined;
  };
  return {
    read,
    nodes,
    /** The admitted `@<word>` records the typed field references `identity` states at `field` resolve to. */
    targets: (identity: string, field: string, word: string): readonly string[] =>
      reader
        .directedView(identity, read)
        .filter(
          (row) =>
            row.kind === 'field-ref' &&
            row.direction === 'out' &&
            row.field === field &&
            nodes.get(row.counterpart)?.discriminator === word,
        )
        .map((row) => row.counterpart),
    /** IA-RUNTIME-REQUEST-INVALID unless `identity` is an admitted `@<word>` of the scope. */
    admit: (identity: string, word: string): void => {
      if (nodes.get(identity)?.discriminator !== word)
        invalid(`'${identity}' is not an admitted @${word} in this scope`);
    },
    /**
     * Whether a record is in `workspace`'s closure, as position reads one: the floor and adopted bands, and the members
     * of the workspace's own declared roots, or, while it declares none (or no workspace holds the read), of the roots
     * no workspace declares. A record of another workspace's root is never in it.
     */
    closure: (workspace: string | undefined) => {
      const own = ownOf(workspace);
      return (identity: string): boolean => holds(own, identity);
    },
    /**
     * The workspace position seats a record in (its workspaceOf): the record itself when it is a `@workspace`; else, of
     * the repository's own `@workspace` and the one whose declared root holds the record's membership root, the first
     * whose closure holds it; the repository's own for no admitted record.
     */
    workspaceOf: (identity: string | undefined): string | undefined => {
      if (identity === undefined || !nodes.has(identity)) return repository();
      if (nodes.get(identity)!.discriminator === 'workspace') return identity;
      const root = rootOf.get(identity);
      if (root === undefined) return repository();
      const holder = roots.find((candidate) => reaches(candidate.root, root))?.workspace;
      return [repository(), holder].find((at) => at !== undefined && holds(ownOf(at), identity));
    },
  };
}

/**
 * C1: the authored `@mandate` records that govern through the scope token `within`, by identity (each of band 100, so
 * in C1's band-then-identity order). Only the closure of `workspace` is read, or without it that of the workspace
 * position seats `path` in, or with neither the repository's own `@workspace`'s: another workspace's mandate never
 * governs here. Only that closure is position's: for a path alone, the mandates that govern are those that claim it,
 * not every mandate scoped to the seated workspace that position's location-seat governance also lists. With `workspace` or `path`, a mandate governs when its
 * `authority.scope` names the workspace or its `authority.covers` selects the path (db D02b claimants), either one
 * sufficing. One that states neither key with a value (a declared empty list locates nothing) is located by its participant alone and governs wherever that participant
 * acts: with `actor`, when its participant is the actor; without one, whenever it names a participant. With neither
 * `workspace` nor `path`, every one governs. `actor` drops no mandate that governs the workspace or path: each states
 * whether it `binds` the actor, so profileRefusal judges the actor's own and those naming no participant, and refuses an
 * actor that none of them binds rather than read the location as ungoverned. An `actor` or `workspace` that is not an
 * admitted record of its word, or a governing mandate whose authority mandateAuthorityOf refuses, is
 * IA-RUNTIME-REQUEST-INVALID; a mandate that does not govern is never read, however it is authored.
 */
export function governingMandates(
  reader: ReadHandle,
  within: string,
  options: GoverningOptions = {},
): readonly GoverningMandate[] {
  const { read, nodes, targets, admit, closure, workspaceOf } = admitted(reader, within),
    { actor, path, workspace, fold } = options;
  if (actor !== undefined) admit(actor, 'agent');
  if (workspace !== undefined) admit(workspace, 'workspace');
  if (fold !== undefined && typeof fold !== 'function') invalid('fold must be a function');
  // Without `workspace`, the closure is the one position reads for the path's location seat, or for no seat.
  const resolution = path === undefined ? undefined : reader.resolveSeat(path, read),
    inside = closure(workspace ?? workspaceOf(resolution?.seat)),
    located = workspace !== undefined || path !== undefined;
  const claiming = new Set(resolution?.claimants.map((claimant) => claimant.identity));
  // With `fold`, a claim is read from the record as db's claimant index reads it (each text value of `authority.covers`)
  // and matched on both sides folded.
  const claims = (node: CompiledRecord): boolean =>
    fold === undefined
      ? claiming.has(node.identity)
      : path !== undefined &&
        coversOf(node).some((selection) => selects(fold(selection), fold(resolution?.path ?? path)));
  const governs = (node: CompiledRecord): boolean => {
    if (!located) return true;
    if (statesValue(node, 'authority', 'scope') || statesValue(node, 'authority', 'covers'))
      return (
        (workspace !== undefined && targets(node.identity, 'authority.scope', 'workspace').includes(workspace)) ||
        claims(node)
      );
    return actor === undefined
      ? states(node, 'authority', 'participant')
      : targets(node.identity, 'authority.participant', 'agent')[0] === actor;
  };
  return freeze(
    [...nodes.values()]
      .filter((node) => node.discriminator === 'mandate' && node.band === 100 && inside(node.identity) && governs(node))
      .sort((a, b) => order(a.identity, b.identity))
      .map((node): GoverningMandate => {
        const authority = mandateAuthorityOf(node),
          agent = targets(node.identity, 'authority.participant', 'agent')[0],
          scoped = targets(node.identity, 'authority.scope', 'workspace');
        const scope = (authority.scope ?? []).map(
          (name) => scoped.find((identity) => nodes.get(identity)!.name === name.toLowerCase()) ?? `@workspace ${name}`,
        );
        return {
          identity: node.identity,
          band: 100,
          ...(authority.participant === undefined ? {} : { participant: agent ?? `@agent ${authority.participant}` }),
          ...(actor === undefined ? {} : { binds: authority.participant === undefined || agent === actor }),
          ...(authority.moves === undefined ? {} : { moves: authority.moves }),
          scope: [...new Set(scope)],
          ...(states(node, 'authority', 'covers') ? { covers: authority.covers ?? [] } : {}),
          ...(states(node, 'authority', 'excluded-words') ? { excludedWords: authority.excludedWords ?? [] } : {}),
        };
      }),
  );
}

/**
 * The workspace position seats a workspace-relative `path` in (C1's closure for a path): the workspace whose declared root
 * holds the seat's records, else the repository's own `@workspace`; undefined when no admitted `@workspace` holds it.
 * Reads through the scope token `within`, as `governingMandates` does.
 */
export function seatedWorkspace(reader: ReadHandle, within: string, path: string): string | undefined {
  const { read, workspaceOf } = admitted(reader, within);
  return workspaceOf(reader.resolveSeat(path, read).seat);
}

/**
 * OD1: the actor a mandate-gated command acts as at `workspace` when none is named. It is the `@agent` the workspace's
 * `composition.steward` resolves to (ia init names its participant there), when that is an authored (band 100) record;
 * failing that, the workspace's one participant, an authored `@agent` that an authored mandate of its closure scoped to
 * it names. An installed steward names no actor, as if none were stated (review C2-R1). With several participants there
 * is none, and the refusal names the choice; with none, there is no actor and no refusal, and the reason says whether
 * the workspace states no steward, one that resolves to no admitted `@agent`, or one that is no authored `@agent`. A
 * `workspace` that is not an admitted `@workspace` of the scope is IA-RUNTIME-REQUEST-INVALID.
 */
export function defaultActor(reader: ReadHandle, within: string, workspace: string): DefaultActor {
  const { nodes, targets, admit, closure } = admitted(reader, within);
  admit(workspace, 'workspace');
  const inside = closure(workspace);
  const participants = [
    ...new Set(
      [...nodes.values()].flatMap((node) => {
        if (node.discriminator !== 'mandate' || node.band !== 100 || !inside(node.identity)) return [];
        if (!targets(node.identity, 'authority.scope', 'workspace').includes(workspace)) return [];
        const agent = targets(node.identity, 'authority.participant', 'agent')[0];
        return agent !== undefined && nodes.get(agent)!.band === 100 ? [agent] : [];
      }),
    ),
  ].sort(order);
  const named = targets(workspace, 'composition.steward', 'agent')[0],
    steward = named !== undefined && nodes.get(named)!.band === 100 ? named : undefined,
    actors = [...new Set([...participants, ...(steward === undefined ? [] : [steward])])].sort(order);
  if (steward !== undefined) return freeze<DefaultActor>({ actor: steward, by: 'steward', participants, actors });
  if (participants.length === 1)
    return freeze<DefaultActor>({ actor: participants[0]!, by: 'participant', participants, actors });
  const unnamed =
    named !== undefined
      ? `${workspace}'s composition.steward ${named} is no authored @agent`
      : states(nodes.get(workspace)!, 'composition', 'steward')
        ? `${workspace}'s composition.steward resolves to no admitted @agent`
        : `${workspace} states no composition.steward`;
  if (participants.length === 0)
    return freeze<DefaultActor>({
      participants,
      actors,
      reason: `${unnamed}, and no authored @mandate scoped to it names an authored @agent as its participant`,
    });
  const reason = `${unnamed}, and its authored mandates name ${participants.length} participants (${participants.join(', ')}): name one of them as its composition.steward`;
  return freeze<DefaultActor>({
    participants,
    actors,
    reason,
    refusal: { code: 'IA-RUNTIME-MANDATE-ACTOR', message: reason, next: governance(workspace) },
  });
}

/**
 * C1: the refusal profile the governing `mandates` give `mode` and its target `words`. A mandate whose `binds` is false
 * governs for another participant and is left out; when every one is, no mandate here binds the actor, and the mode is
 * IA-RUNTIME-MANDATE-ACTOR, naming whom each binds. The rest are never pooled across participants: when they name more
 * than one, as they may without an actor, the mode is IA-RUNTIME-MANDATE-ACTOR too, naming each. Then the move is
 * judged: the mode is allowed when any mandate grants its move, by listing it or by declaring no moves, else
 * IA-RUNTIME-MANDATE-MOVE. Then, only when words are given, a word any mandate excludes is IA-RUNTIME-MANDATE-WORD.
 * Each refusal's `next` is the governance position of the first mandate it names (design §11), a read, which a command
 * gated on this profile must leave ungated so that the refusal can be followed (an actor no mandate binds is refused
 * every mode, read included). With no governing mandate nothing is restricted and the verdict holds a notice instead.
 * An unknown mode, or a declared empty move list on any mandate, is IA-RUNTIME-REQUEST-INVALID.
 */
export function profileRefusal(
  mandates: readonly (ProfileMandate | CompiledRecord)[],
  mode: Mode,
  words: readonly string[] = [],
): ProfileVerdict {
  if (!isMode(mode)) invalid(`Mode must be one of ${MODES.join(', ')}`);
  if (mandates.length === 0) return freeze({ notice: UNGOVERNED });
  const refuse = (code: MandateCode, message: string, seat: string): ProfileVerdict =>
    freeze({ refusal: { code, message, next: governance(seat) } });
  const all: readonly ProfileMandate[] = mandates.map((mandate) =>
    'sections' in mandate ? mandateAuthorityOf(mandate) : mandate,
  );
  // Each mandate's own move judgement, words aside; every one is judged, so a malformed move list is never skipped.
  const judged = all.map((authority) => mandateRefusal(authority, mode));
  const whom = (authority: ProfileMandate): string =>
    authority.participant === undefined ? authority.identity : `${authority.identity} binds ${authority.participant}`;
  // A mandate that binds another participant grants and excludes nothing for the actor (plan amendment C10).
  const binding = all.flatMap((authority, index) =>
    authority.binds === false ? [] : [{ authority, refusal: judged[index] }],
  );
  if (binding.length === 0)
    return refuse(
      'IA-RUNTIME-MANDATE-ACTOR',
      `no mandate that governs here binds the acting @agent: ${all.map(whom).join('; ')}`,
      all[0]!.identity,
    );
  // Nor are two participants' mandates ever pooled: without an actor to say whom each binds, the choice is open (OD1).
  const named = binding.flatMap(({ authority }) => (authority.participant === undefined ? [] : [authority]));
  const participants = new Set(named.map((authority) => authority.participant));
  if (participants.size > 1)
    return refuse(
      'IA-RUNTIME-MANDATE-ACTOR',
      `the mandates that govern here bind ${participants.size} participants and name no acting @agent: ${named.map(whom).join('; ')}`,
      named[0]!.identity,
    );
  if (binding.every(({ refusal }) => refusal !== undefined))
    return refuse(
      'IA-RUNTIME-MANDATE-MOVE',
      `${binding.map(({ authority }) => `${authority.identity} allows ${authority.moves!.join(', ')}`).join('; ')}; ${mode} needs ${MODE_MOVES[mode]}`,
      binding[0]!.authority.identity,
    );
  const excluding = binding.flatMap(({ authority }) => {
    const excluded = words.filter((word) => authority.excludedWords?.includes(word));
    return excluded.length === 0 ? [] : [{ identity: authority.identity, excluded }];
  });
  if (excluding.length > 0)
    return refuse(
      'IA-RUNTIME-MANDATE-WORD',
      excluding.map(({ identity, excluded }) => `${identity} excludes ${excluded.join(', ')}`).join('; '),
      excluding[0]!.identity,
    );
  return freeze({});
}
