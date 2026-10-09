import {
  FLOOR_REGISTRATIONS,
  PHASES,
  PRIMITIVE_ANCHORS,
  PRIMITIVES,
  SHAPES,
  SHAPE_ROWS,
  isKind,
} from '@inventarch/language';
import type {
  Band,
  Category,
  CompiledField,
  CompiledRecord,
  CompiledValue,
  Kind,
  Lane,
  Phase,
  Predicate,
  Primitive,
  Shape,
} from '@inventarch/language';
import { digest, laneOf } from '@inventarch/graph';
import type { DirectedRow, Node } from '@inventarch/graph';
import type { ReadHandle } from '@inventarch/db';
import { MOVES } from './mandate-modes.js';
import type { Mode, Move } from './mandate-modes.js';
import { position } from './position.js';
import type { HostNote } from './position.js';
import { statedText, valueText } from './render.js';
import { freeze } from './types.js';

/**
 * The position packet: position-and-projection §4 and items 11 and 12; plan amendments B1 to B5 and B8 (milestone
 * position-packet). One host-neutral packet a host adapter renders: body(K0)'s digest, the seat, the participants and
 * their mandates, the N system pointer lines, the captured-record tallies, the intent and phase tables, the command
 * catalog the caller passes in, the three SPEC lines and provenance. The host note sits beside it, never digested.
 *
 * It is a pure function of the admitted records the scope token reads and the catalog: like body(K) it carries no
 * absolute path, token, time, capture state or CLI version, and nothing is written. Every read goes through `within`,
 * position's K0 included, and a record at runtime placement (band 0) is no part of it, as it is no part of a body (R15).
 */

/** One command of the catalog (B5): the CLI passes them in, as data, from its COMMANDS rows. */
export interface PacketCatalogRow {
  /** `ia <verb>`. */
  readonly command: string;
  readonly mode: Mode;
  /** The move its mode maps to (MODE_MOVES, design item 13). */
  readonly move: Move;
  /** A one-line summary of the command's main refusal. */
  readonly refuses: string;
  /** The one command that refusal names (design row 27). */
  readonly next: string;
}
/** The seat line: the repository's own @workspace, K0's seat. */
export interface PacketSeat {
  /** Absent when no admitted @workspace is declared at the repository root (K0's seat unknown, R14). */
  readonly identity?: string;
  /** Its `composition.sources` entries as authored, `<root> @<placement>`. */
  readonly sources: readonly string[];
  /** N, the systems its `composition.systems` names: one system pointer line each. */
  readonly systems: number;
  /** Its `composition.steward` when it states one: the @agent the reference resolves to, or the reference as authored. */
  readonly steward?: string;
  /** Present exactly when no participant is rendered (P = 0, B3): no refusal. */
  readonly participants?: 'none (no authored @mandate names an @agent)';
}
/** An authored @agent that an authored @mandate of `mandates` names as its `authority.participant` (B3). */
export interface PacketParticipant {
  readonly identity: string;
  /** Its `meaning.says`. */
  readonly says?: string;
}
/**
 * An authored @mandate of body(K0)'s `mandates` whose participant resolves to an authored @agent (B3), each optional
 * field present exactly when the record states its key, as authored.
 */
export interface PacketMandate {
  readonly identity: string;
  /** The participant @agent's identity. */
  readonly participant: string;
  /** `authority.moves`; absent, the mandate restricts no move. */
  readonly moves?: readonly Move[];
  /** `authority.scope`: each @workspace the reference resolves to, or the reference as authored. */
  readonly scope: readonly string[];
  /** `authority.excluded-words`. */
  readonly excludedWords?: readonly string[];
  /** `authority.covers`, the path selections it claims. */
  readonly covers?: readonly string[];
}
/**
 * One system pointer line (B4) per `composition.systems` reference of the seat: the admitted @system it resolves to,
 * the words its discriminators lower, its band, its steward and the key that seats at it; or, for a reference no
 * admitted record answers, the reference as authored with `unresolved` in place of the words and steward.
 */
export type PacketSystem =
  | {
      readonly identity: string;
      /** The words the record's `discriminators` lowering rows register, sorted. */
      readonly words: readonly string[];
      readonly band: Band;
      /** Its `head.steward`, when it resolves to an admitted record. */
      readonly steward?: string;
      /** `ia position --seat <identity>`. */
      readonly reach: string;
    }
  | { readonly identity: string; readonly words: 'unresolved'; readonly steward: 'unresolved' };
/**
 * A captured-record tally: the band-100 capture members of one word under the seat's own declared roots, none while
 * it declares none (R15's capture members, not its fallback closure).
 */
export interface PacketTally {
  readonly word: string;
  readonly count: number;
}
/** One row of the intent table: a SHAPE_ROWS shape, in table order. */
export interface PacketIntent {
  readonly shape: Shape;
  readonly category: Category;
  readonly primitive: Primitive;
  /** PRIMITIVE_ANCHORS of the primitive: the phase a key that names the shape alone takes. */
  readonly phase: Phase;
  readonly kinds: readonly Kind[];
  readonly lanes: readonly Lane[];
  readonly predicates: readonly Predicate[];
  readonly priming: readonly Predicate[];
  /** The registered words a position seeds under the shape: those whose lowered kind or lane is in its focus. */
  readonly words: readonly string[];
}
/** One row of the phase table: a phase, in cycle order. */
export interface PacketPhase {
  readonly phase: Phase;
  /** The primitives PRIMITIVE_ANCHORS anchors at it. */
  readonly primitives: readonly Primitive[];
  /** What `--phase` changes. */
  readonly changes: string;
}
export interface PacketProvenance {
  readonly revision: string;
  /** The seat @workspace's name (decision identity-namespace: the repository slug lives here, not in identities). */
  readonly slug?: string;
}
export interface PositionPacket {
  readonly format: 'ia.position-packet.v1';
  /** The revision of the view the scope reads, position(K0)'s. */
  readonly revision: string;
  /** The digest of body(K0), position(K0)'s `digest`. */
  readonly body: string;
  readonly seat: PacketSeat;
  readonly participants: readonly PacketParticipant[];
  readonly mandates: readonly PacketMandate[];
  readonly systems: readonly PacketSystem[];
  readonly tallies: readonly PacketTally[];
  readonly intents: readonly PacketIntent[];
  readonly phases: readonly PacketPhase[];
  readonly commands: readonly PacketCatalogRow[];
  readonly lines: readonly string[];
  readonly provenance: PacketProvenance;
}
/** position's host note (R16) and the installed state, which no join checks before milestone generation-binding. */
export interface PacketHostNote extends HostNote {
  readonly installed: 'unknown (no join checked here)';
}
/** The packet, its digest and the host note: printed together, never merged. */
export interface PacketOutput {
  readonly packet: PositionPacket;
  /** Graph's codec digest of `packet`, its canonical JSON text's SHA-256. */
  readonly digest: string;
  readonly hostNote: PacketHostNote;
}

const NO_PARTICIPANT = 'none (no authored @mandate names an @agent)' as const;
const UNRESOLVED = 'unresolved' as const;
const INSTALLED = 'unknown (no join checked here)' as const;
const PHASE_CHANGES =
  '--phase selects the playbook cell delivered and decides conditional relation rows (decision conditional-relations-in-delivery)';
/** Design §4's three SPEC-owned lines, `ia scope` read as `ia position` (decision scope-verb-dispatch). */
const LINES: readonly string[] = [
  'run ia position; if it refuses, run the command it names',
  'state intent to the CLI as shape + optional phase + optional seat + optional word; the CLI never receives free text',
  "when a word's owner is not this workspace, delegate by re-seating at the owning system; a steward pointer is readable, not an invocation",
];
const LOWERS = /^lowers to ([a-z]+)$/;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One `<word> lowers to <kind>` row of a registration, with its facets. */
interface Lowering {
  readonly word: string;
  readonly kind: Kind;
  readonly facets: readonly string[];
}
/** The fields `node` states unconditionally at `field`, a `section.key` path. */
function fieldsAt(node: CompiledRecord, field: string): readonly CompiledField[] {
  const [section, key] = field.split('.');
  return node.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.key === key && f.when === undefined);
}
/** The values `node` states unconditionally at `field`, a list's items one by one. */
const valuesAt = (node: CompiledRecord, field: string): readonly CompiledValue[] =>
  fieldsAt(node, field).flatMap((f) => (f.value.kind === 'list' ? f.value.items : [f.value]));
const textsAt = (node: CompiledRecord, field: string): readonly string[] =>
  valuesAt(node, field).flatMap((value) => ('text' in value ? [value.text] : []));
/** Whether `node` states `field` at all: a declared empty list is stated, an absent key is not. */
const stated = (node: CompiledRecord, field: string): boolean => fieldsAt(node, field).length > 0;
const isMove = (text: string): text is Move => (MOVES as readonly string[]).includes(text);
/** The `discriminators` rows a @system record states: each word, the kind it lowers to and its facets. */
function loweringsOf(node: CompiledRecord): readonly Lowering[] {
  return node.sections
    .filter((s) => s.name === 'discriminators')
    .flatMap((s) => s.fields)
    .flatMap((f) => {
      if (!('key' in f) || f.value.kind !== 'scalar') return [];
      const kind = LOWERS.exec(f.value.text)?.[1];
      if (kind === undefined || !isKind(kind)) return [];
      const facets = (f.fields ?? [])
        .filter((child): child is CompiledField => 'key' in child && child.key === 'facets')
        .flatMap((child) => (child.value.kind === 'list' ? child.value.items : [child.value]))
        .flatMap((value) => ('text' in value ? [value.text] : []));
      return [{ word: f.key, kind, facets }];
    });
}

/**
 * R19: the position packet through the scope token `within`, with its digest and host note. It calls position once,
 * at K0, and reads the rest through the same token. `catalog` is copied in its order, each row's five fields only. A
 * workspace with no participant renders none (B3). The refusals are position's alone: the packet renders the records
 * admission admitted and gates none of them (design §4, LS-30).
 */
export function renderPacket(handle: ReadHandle, within: string, catalog: readonly PacketCatalogRow[]): PacketOutput {
  const k0 = position(handle, within),
    body = k0.body,
    read = { within },
    snapshot = handle.snapshot(read),
    records = snapshot.records.filter((node) => node.placement.kind !== 'runtime'),
    nodes = new Map(records.map((node) => [node.identity, node]));
  const viewed = new Map<string, readonly DirectedRow[]>();
  const rowsOf = (identity: string): readonly DirectedRow[] => {
    let rows = viewed.get(identity);
    if (rows === undefined)
      viewed.set(identity, (rows = handle.directedView(identity, read).filter((row) => nodes.has(row.counterpart))));
    return rows;
  };
  /** The admitted records `identity`'s typed field references at `field` resolve to. */
  const targetsOf = (identity: string, field: string): readonly string[] =>
    rowsOf(identity)
      .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.field === field)
      .map((row) => row.counterpart);
  /** Each reference `node` states at `field`, once: the admitted record it resolves to, or the reference as authored. */
  const refsAt = (node: Node, field: string): readonly string[] => {
    const targets = targetsOf(node.identity, field);
    return [
      ...new Set(
        valuesAt(node, field).flatMap((value) =>
          value.kind !== 'ref'
            ? []
            : [
                targets.find((target) => {
                  const counterpart = nodes.get(target)!;
                  return (
                    counterpart.discriminator === value.discriminator && counterpart.name === value.name.toLowerCase()
                  );
                }) ?? valueText(value),
              ],
        ),
      ),
    ];
  };
  const seatId = body.seat.identity,
    seat = seatId === undefined ? undefined : nodes.get(seatId);

  // Participants and mandates (B3): the authored mandates body(K0) lists whose participant resolves to an authored
  // @agent, each read through the same token; an @agent once however many mandates name it. Each authority field is
  // rendered as admitted, never judged: a declared `moves []` is `moves: []`, an absent key no field, and a reference
  // with a fragment the record it resolves to.
  const mandates: PacketMandate[] = [],
    agents = new Map<string, PacketParticipant>();
  for (const pointer of body.mandates) {
    const node = nodes.get(pointer.identity)!,
      participant = targetsOf(node.identity, 'authority.participant')[0],
      agent = participant === undefined ? undefined : nodes.get(participant);
    if (node.band !== 100 || agent?.discriminator !== 'agent' || agent.band !== 100) continue;
    const says = statedText(agent, 'meaning.says');
    mandates.push({
      identity: node.identity,
      participant: agent.identity,
      ...(stated(node, 'authority.moves') ? { moves: textsAt(node, 'authority.moves').filter(isMove) } : {}),
      scope: refsAt(node, 'authority.scope'),
      ...(stated(node, 'authority.excluded-words') ? { excludedWords: textsAt(node, 'authority.excluded-words') } : {}),
      ...(stated(node, 'authority.covers') ? { covers: textsAt(node, 'authority.covers') } : {}),
    });
    agents.set(agent.identity, { identity: agent.identity, ...(says === undefined ? {} : { says }) });
  }
  mandates.sort((a, b) => order(a.identity, b.identity));
  const participants = [...agents.values()].sort((a, b) => order(a.identity, b.identity));

  // System pointer lines (B4): one per `composition.systems` reference of the seat, by identity.
  const systems: PacketSystem[] = (seat === undefined ? [] : refsAt(seat, 'composition.systems'))
    .map((identity): PacketSystem => {
      const node = nodes.get(identity);
      if (node === undefined) return { identity, words: UNRESOLVED, steward: UNRESOLVED };
      const steward = targetsOf(identity, 'head.steward')[0];
      return {
        identity,
        words: [...new Set(loweringsOf(node).map((row) => row.word))].sort(order),
        band: node.band,
        ...(steward === undefined ? {} : { steward }),
        reach: `ia position --seat ${identity}`,
      };
    })
    .sort((a, b) => order(a.identity, b.identity));
  const steward = seat === undefined ? undefined : refsAt(seat, 'composition.steward')[0];

  // Captured-record tallies, per word: the band-100 capture members (db D02a) under the seat's own declared roots, as
  // position composes a workspace seat's (R15). A seat that declares no root has none, which body(K0)'s `sources`
  // unknown says; its fallback closure is what position may enter, not what the workspace captures.
  const roots = handle.roots(read),
    own = new Set(roots.filter((r) => r.workspace === seatId).map((r) => r.root));
  const counts = new Map<string, number>();
  for (const row of snapshot.membership) {
    const node = nodes.get(row.identity);
    if (node?.band !== 100 || !own.has(row.root)) continue;
    counts.set(node.discriminator, (counts.get(node.discriminator) ?? 0) + 1);
  }
  const tallies = [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => order(a.word, b.word));

  // The intent table: the five shapes, each with the registered words it seeds, read from the floor's two
  // registrations and the admitted @system records' lowering rows (the first by identity, should two lower one word).
  const registered = new Set(handle.words(read)),
    lowered = new Map<string, Lowering>(
      FLOOR_REGISTRATIONS.map((r) => [r.keyword, { word: r.keyword, kind: r.kind, facets: r.facets }]),
    );
  for (const node of [...records].sort((a, b) => order(a.identity, b.identity)))
    if (node.discriminator === 'system')
      for (const row of loweringsOf(node)) if (!lowered.has(row.word)) lowered.set(row.word, row);
  const words = [...lowered.values()].filter((row) => registered.has(row.word)).sort((a, b) => order(a.word, b.word));
  const intents = SHAPES.map((shape): PacketIntent => {
    const row = SHAPE_ROWS[shape],
      kinds: readonly Kind[] = row.kinds,
      lanes: readonly Lane[] = row.lanes;
    return {
      shape,
      category: row.category,
      primitive: row.primitive,
      phase: PRIMITIVE_ANCHORS[row.primitive],
      // Copies: the packet is frozen whole, and the kernel's rows are not this packet's to freeze.
      kinds: [...kinds],
      lanes: [...lanes],
      predicates: [...row.predicates],
      priming: [...row.priming],
      words: words
        .filter(
          ({ kind, facets }) =>
            kinds.includes(kind) ||
            (facets.length > 0 ? facets : ['']).some((facet) => lanes.includes(laneOf({ kind, facet }))),
        )
        .map(({ word }) => word),
    };
  });
  const phases = PHASES.map(
    (phase): PacketPhase => ({
      phase,
      primitives: PRIMITIVES.filter((primitive) => PRIMITIVE_ANCHORS[primitive] === phase),
      changes: PHASE_CHANGES,
    }),
  );

  const packet: PositionPacket = {
    format: 'ia.position-packet.v1',
    revision: body.revision,
    body: k0.digest,
    seat: {
      ...(seatId === undefined ? {} : { identity: seatId }),
      sources: seat === undefined ? [] : textsAt(seat, 'composition.sources'),
      systems: systems.length,
      ...(steward === undefined ? {} : { steward }),
      ...(participants.length === 0 ? { participants: NO_PARTICIPANT } : {}),
    },
    participants,
    mandates,
    systems,
    tallies,
    intents,
    phases,
    commands: catalog.map(({ command, mode, move, refuses, next }) => ({ command, mode, move, refuses, next })),
    lines: [...LINES],
    provenance: { revision: body.revision, ...(seat === undefined ? {} : { slug: seat.name }) },
  };
  return freeze({ packet, digest: digest(packet), hostNote: { ...k0.hostNote, installed: INSTALLED } });
}

/**
 * B1: the packet's entries, design §4's formula. P participants + M mandates + 1 seat + N system lines + T tallies + 5
 * intent rows + 4 phase rows + C catalog rows + 1 provenance + 3 SPEC lines; the host note is no entry.
 */
export function entryCount(packet: PositionPacket): number {
  return (
    packet.participants.length +
    packet.mandates.length +
    1 +
    packet.systems.length +
    packet.tallies.length +
    packet.intents.length +
    packet.phases.length +
    packet.commands.length +
    1 +
    packet.lines.length
  );
}
