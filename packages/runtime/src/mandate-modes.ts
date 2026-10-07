import type { CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';
import { MOVES as KERNEL_MOVES } from '@inventarch/language';
import { RUNTIME_CODES, RuntimeError } from './errors.js';
import type { RuntimeCode } from './errors.js';

/**
 * Mandate authority as closed moves (position-and-projection design, items 2c and 13).
 *
 * A `@mandate` may declare an `authority` section: the participant it binds, the moves it allows (closed to the five
 * kernel moves), the workspaces it scopes, and the words and path selections it excludes or covers. This module
 * publishes the CLI mode -> move table and the pure refusal check that the authoring verbs will consume. Nothing here
 * is wired into the CLI yet: the authoring verbs land in a later milestone, and until then no command consults a
 * mandate. A mandate adds closed restrictions only; it never grants host permissions, and a mandate without
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
/**
 * The mode of each read operation a position serves: `position`, `read` and `next` only tell what is admitted, so a
 * mandate judges them by the read mode's move. Other commands are assigned a mode with the verbs that consume
 * `mandateRefusal`.
 */
export const OPERATION_MODES = Object.freeze({
  position: 'read',
  read: 'read',
  next: 'read',
} as const satisfies Readonly<Record<string, keyof typeof MODE_MOVES>>);
/** The modes in table order. */
export const MODES: readonly Mode[] = Object.freeze(Object.keys(MODE_MOVES) as Mode[]);
export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && Object.hasOwn(MODE_MOVES, value);
}

export type MandateCode = Extract<RuntimeCode, `IA-RUNTIME-MANDATE-${string}`>;
/** The refusal codes a mandate can return; both are registered in RUNTIME_CODES. */
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

const invalid = (message: string): never => {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message);
};
/** Every value authored under `authority.<key>`: a repeated list key contributes each of its lists' items. */
function authorityValues(record: CompiledRecord, key: string): readonly CompiledValue[] {
  const fields = record.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .filter((child): child is CompiledField => 'key' in child && child.key === key);
  for (const field of fields)
    if (field.when !== undefined || field.fields !== undefined || field.value.kind === 'block')
      invalid(`${record.identity}: authority.${key} must be an unconditional inline value`);
  return fields.flatMap((field) => (field.value.kind === 'list' ? field.value.items : [field.value]));
}
function texts(record: CompiledRecord, key: string): readonly string[] {
  return authorityValues(record, key).map((value) =>
    value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose'
      ? value.text
      : invalid(`${record.identity}: authority.${key} holds a value that is not text`),
  );
}
function names(record: CompiledRecord, key: string, discriminator: string): readonly string[] {
  return authorityValues(record, key).map((value) =>
    value.kind === 'ref' && value.discriminator === discriminator && value.fragment === undefined
      ? value.name
      : invalid(`${record.identity}: authority.${key} holds a value that is not a @${discriminator} reference`),
  );
}
function isMove(value: string): value is Move {
  return (MOVES as readonly string[]).includes(value);
}

/** Read the authority a compiled `@mandate` declares; a non-mandate or a malformed field is IA-RUNTIME-REQUEST-INVALID. */
export function mandateAuthorityOf(record: CompiledRecord): MandateAuthority {
  if (record.discriminator !== 'mandate') invalid(`${record.identity} is not a @mandate`);
  const participants = names(record, 'participant', 'agent');
  if (participants.length > 1) invalid(`${record.identity}: authority.participant names more than one agent`);
  const present = (key: string) => authorityValues(record, key).length > 0;
  const moves = texts(record, 'moves').map((move) =>
    isMove(move) ? move : invalid(`${record.identity}: authority.moves names ${move}, not a kernel move`),
  );
  // Presence is judged by the key: a declared but empty list names no move, which the design's one-or-more refuses
  // rather than reading as a lockout of every mode or as an absent restriction.
  const hasMoves = record.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .some((child) => 'key' in child && child.key === 'moves');
  if (hasMoves && moves.length === 0) invalid(`${record.identity}: authority.moves must name at least one kernel move`);
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
