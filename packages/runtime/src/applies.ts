import { PHASES, SHAPE_ROWS } from '@inventarch/language';
import type { Band, CompiledField, CompiledRecord, CompiledValue, Kind, Phase, Primitive } from '@inventarch/language';
import type { ReadHandle } from '@inventarch/db';
import { cell, effectiveSeverity } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { RuntimeError } from './errors.js';
import { OPERATION_MODES, mandateAuthorityOf, mandateRefusal } from './mandate-modes.js';
import type { MandateRefusal, Move } from './mandate-modes.js';
import { SCOPE_BODY_LIMITS } from './scope-key.js';
import type { NormalizedScopeKey } from './scope-key.js';
import type { Seat } from './seed.js';

/**
 * The on-demand sections of body(K), read beside the seeding and never feeding it: `applies by word` (rules and
 * playbooks whose subject names a loaded record's word or kind: a field match, no row, no hop, no consent claimed),
 * playbook cells at the key's phase and the shape's primitive, the governance rules that apply to the seat, and the
 * mandates that govern it. Each is a pure function of the key's value and the admitted revision, read through the
 * body's scope token; none moves what the body loads.
 *
 * `applies by word` follows the position design's meaning: a field match on `subject.subject-word` and
 * `subject.subject-kind`. The steward reading of the same name, the words an @agent's `governance.applies` names, is
 * carried beside it as an attribution per word. Swapping one meaning for the other changes only `appliesByWord`.
 */

/** The fields of a record line, without the hop and reach a pointer has: an on-demand line is no row. */
export interface Described {
  readonly identity: string;
  readonly word: string;
  readonly kind: Kind;
  readonly lane: string;
  readonly system: string;
  readonly steward: string | null;
  readonly band: Band;
}
/** Where a tally reaches out, as for pointer tallies. */
export interface Owner {
  readonly steward: string | null;
  readonly seat: string | null;
  readonly read: string | null;
}
export interface AppliesTally extends Owner {
  readonly word: string;
  readonly system: string;
  readonly count: number;
}
/** The subject field and value a rule or playbook matched by. */
export interface SubjectMatch {
  readonly field: 'subject-word' | 'subject-kind';
  readonly value: string;
}
export interface AppliesLine extends Described {
  /** The words of loaded records it applies to. */
  readonly words: readonly string[];
  readonly by: readonly SubjectMatch[];
}
/** One word of the loaded records, with the @agent records whose unconditioned `governance.applies` names it. */
export interface WordAttribution {
  readonly word: string;
  readonly stewards: readonly string[];
}
export interface AppliesByWord {
  /** Each word of the loaded records once, in word order. */
  readonly words: readonly WordAttribution[];
  /** The first `SCOPE_BODY_LIMITS.pointers` matches, by band then identity. */
  readonly listed: readonly AppliesLine[];
  /** The rest, per word and owner system; the key's word keeps only its own word, as in every tally. */
  readonly tallies: readonly AppliesTally[];
  /** Every match, listed or tallied. */
  readonly count: number;
}
/** Why a playbook's cell is offered: it applies by word, or it is loaded or composed at the seat. */
export type CellSource = 'applies' | 'seat';
export interface CellLine {
  readonly playbook: string;
  readonly via: readonly CellSource[];
  /** `identity#phase/Primitive` of the delivered cell; null when the playbook has none at the key's phase. */
  readonly address: string | null;
  /** `exact` at the shape's primitive, else the phase's `primary` cell; null when there is none. */
  readonly selection: 'exact' | 'primary' | null;
  readonly phase: Phase;
  readonly primitive: Primitive;
  readonly text: string | null;
  /** When no cell is delivered: the nearest phase that has one for this coordinate, else null. */
  readonly nearest: Phase | null;
}
export interface Cells {
  /** At most `SCOPE_BODY_LIMITS.cells` playbooks, by band then identity. */
  readonly listed: readonly CellLine[];
  /** Every playbook offered, listed or not. */
  readonly count: number;
}
/** How a rule applies: a selection that claims the seat's path, a governance row at the seat, or its subject. */
export interface RuleMatch {
  readonly by: 'covers' | 'row' | 'subject-word' | 'subject-kind';
  readonly value: string;
  /** Matched against the seat, or against the key's word. */
  readonly of: 'seat' | 'word';
}
export interface RuleLine extends Described {
  /** The effective severity at the key's coordinate. */
  readonly severity: string | null;
  /** Listed outside the budget. */
  readonly blocking: boolean;
  readonly by: readonly RuleMatch[];
}
export interface Rules {
  /** Every blocking rule, then the others by band and identity up to the key's budget. */
  readonly listed: readonly RuleLine[];
  readonly count: number;
  /** Rules the budget cut; a blocking rule is never cut. */
  readonly truncated: number;
}
export interface MandateMatch {
  readonly by: 'covers' | 'participant';
  /** The claiming selection, or the participant @agent. */
  readonly value: string;
}
export interface MandateLine extends Described {
  readonly by: readonly MandateMatch[];
  /** `authority.participant`, as the @agent it resolves to. */
  readonly participant: string | null;
  readonly moves: readonly Move[] | null;
  /** `authority.scope`, as the @workspace records it resolves to. */
  readonly scope: readonly string[] | null;
  readonly excludedWords: readonly string[] | null;
  readonly covers: readonly string[] | null;
  /** The refusal a position (a read) gets under this mandate; null when it permits one. */
  readonly refusal: MandateRefusal | null;
  /** Why the authority could not be read; its fields are then null. */
  readonly problem: string | null;
}
export interface OnDemand {
  readonly appliesByWord: AppliesByWord;
  readonly cells: Cells;
  readonly rules: Rules;
  readonly mandates: readonly MandateLine[];
}
/** What the body already read: the records in scope, the seat, the loaded and composed records, and its helpers. */
export interface BodyReading {
  readonly handle: ReadHandle;
  readonly within: string;
  readonly key: NormalizedScopeKey;
  readonly seat: Seat;
  readonly nodes: ReadonlyMap<string, Node>;
  /** The seat (when it is a record), then the loaded records. */
  readonly loaded: readonly string[];
  /** C0 after the word filter, without held records. */
  readonly composition: readonly string[];
  readonly describe: (node: Node) => Described;
  readonly owner: (system: string) => Owner;
  readonly view: (identity: string) => ReturnType<ReadHandle['directedView']>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byBand = (a: Node, b: Node): number => b.band - a.band || compare(a.identity, b.identity);
const textOf = (value: CompiledValue): readonly string[] =>
  value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose' ? [value.text] : [];
/** Every text value of `<section>.<key>`, inline or listed, in source order. */
function fieldTexts(record: CompiledRecord, section: string, key: string): readonly string[] {
  return record.sections
    .filter((entry) => entry.name === section)
    .flatMap((entry) => entry.fields)
    .filter((field): field is CompiledField => 'key' in field && field.key === key)
    .flatMap((field) => (field.value.kind === 'list' ? field.value.items.flatMap(textOf) : textOf(field.value)));
}
/**
 * The words an @agent's `governance.applies` names, as the compliance steward check reads them: unconditioned
 * `applies` clauses only, each a list of words; a conditioned clause attributes nothing.
 */
export function stewardApplies(record: CompiledRecord): readonly string[] {
  return Object.freeze([
    ...new Set(
      record.variants
        .filter((variant) => variant.key === 'applies' && variant.condition === undefined)
        .flatMap((variant) =>
          variant.value.kind === 'list'
            ? variant.value.items.flatMap((item) =>
                item.kind === 'scalar' || item.kind === 'string' ? [item.text] : [],
              )
            : [],
        ),
    ),
  ]);
}
const subjectWords = (node: Node) => fieldTexts(node, 'subject', 'subject-word'),
  subjectKinds = (node: Node) => fieldTexts(node, 'subject', 'subject-kind');

interface Matched {
  readonly section: AppliesByWord;
  /** Every match, listed or tallied, by band then identity. */
  readonly nodes: readonly Node[];
}
function appliesByWord(read: BodyReading): Matched {
  const loaded = read.loaded.map((identity) => read.nodes.get(identity)!);
  const kindOf = new Map(loaded.map((node) => [node.discriminator, node.kind] as const));
  const words = [...kindOf.keys()].sort(compare);
  const agents = [...read.nodes.values()].filter((node) => node.discriminator === 'agent');
  const attributed = words.map((word) => ({
    word,
    stewards: agents
      .filter((agent) => stewardApplies(agent).includes(word))
      .map((agent) => agent.identity)
      .sort(compare),
  }));
  const matches: { node: Node; words: string[]; by: SubjectMatch[] }[] = [];
  for (const node of [...read.nodes.values()].sort(byBand)) {
    const named = subjectWords(node),
      kinds = subjectKinds(node);
    if (named.length === 0 && kinds.length === 0) continue;
    const applied = words.filter((word) => named.includes(word) || kinds.includes(kindOf.get(word)!));
    if (applied.length === 0) continue;
    const by: SubjectMatch[] = [
      ...[...new Set(named)]
        .filter((word) => kindOf.has(word))
        .map((value) => ({ field: 'subject-word' as const, value })),
      ...[...new Set(kinds)]
        .filter((kind) => loaded.some((record) => record.kind === kind))
        .map((value) => ({ field: 'subject-kind' as const, value })),
    ];
    matches.push({ node, words: applied, by });
  }
  const limit = SCOPE_BODY_LIMITS.pointers;
  const tallies = new Map<string, AppliesTally>();
  for (const { node } of matches.slice(limit)) {
    if (read.key.word !== null && node.discriminator !== read.key.word) continue;
    const at = `${node.discriminator}\u0000${node.system}`,
      known = tallies.get(at);
    tallies.set(
      at,
      known === undefined
        ? { word: node.discriminator, system: node.system, count: 1, ...read.owner(node.system) }
        : { ...known, count: known.count + 1 },
    );
  }
  return {
    section: {
      words: attributed,
      listed: matches.slice(0, limit).map(({ node, words, by }) => ({ ...read.describe(node), words, by })),
      tallies: [...tallies.values()].sort((a, b) => compare(a.word, b.word) || compare(a.system, b.system)),
      count: matches.length,
    },
    nodes: matches.map(({ node }) => node),
  };
}

/** The phase nearest to `phase` in phase order whose cell the coordinate selects; the earlier phase on a tie. */
function nearestPhase(node: Node, key: NormalizedScopeKey): Phase | null {
  const at = PHASES.indexOf(key.phase),
    others = PHASES.map((phase, index) => ({ phase, distance: Math.abs(index - at), index }))
      .filter((entry) => entry.phase !== key.phase)
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
  for (const { phase } of others) if (cell(node, { ...key.coordinate, phase }) !== undefined) return phase as Phase;
  return null;
}
function cellsOf(read: BodyReading, applies: readonly string[]): Cells {
  const offered = new Map<string, Set<CellSource>>();
  const offer = (identity: string, source: CellSource) => {
    const node = read.nodes.get(identity);
    if (node?.discriminator !== 'playbook') return;
    const sources = offered.get(identity) ?? new Set<CellSource>();
    sources.add(source);
    offered.set(identity, sources);
  };
  for (const identity of applies) offer(identity, 'applies');
  for (const identity of [...read.loaded, ...read.composition]) offer(identity, 'seat');
  const playbooks = [...offered.keys()].map((identity) => read.nodes.get(identity)!).sort(byBand);
  const { key } = read;
  return {
    listed: playbooks.slice(0, SCOPE_BODY_LIMITS.cells).map((node): CellLine => {
      const via = (['applies', 'seat'] as const).filter((source) => offered.get(node.identity)!.has(source)),
        selected = cell(node, key.coordinate);
      return selected === undefined
        ? {
            playbook: node.identity,
            via,
            address: null,
            selection: null,
            phase: key.phase,
            primitive: key.primitive,
            text: null,
            nearest: nearestPhase(node, key),
          }
        : {
            playbook: node.identity,
            via,
            address: `${node.identity}#${selected.cell.phase}/${selected.cell.primitive}`,
            selection: selected.kind,
            phase: selected.cell.phase,
            primitive: selected.cell.primitive,
            text: selected.cell.text,
            nearest: null,
          };
    }),
    count: playbooks.length,
  };
}

/** The path a seat stands at: a location seat's path, else the seat record's source path. */
function seatPath(read: BodyReading): string | null {
  if (read.seat.path !== null) return read.seat.path;
  return read.seat.identity === null ? null : (read.nodes.get(read.seat.identity)?.source.path ?? null);
}
/** The records whose path selection in `field` claims the seat's path, with the claiming selections. */
function claimants(read: BodyReading, field: string): ReadonlyMap<string, readonly string[]> {
  const path = seatPath(read),
    claims = new Map<string, string[]>();
  if (path === null) return claims;
  for (const claim of read.handle.resolveSeat(path, { within: read.within }).claimants)
    if (claim.field === field && read.nodes.has(claim.identity))
      claims.set(claim.identity, [...(claims.get(claim.identity) ?? []), claim.selection]);
  return claims;
}

function rulesOf(read: BodyReading): Rules {
  const { key, nodes } = read,
    reasons = new Map<string, RuleMatch[]>();
  const reason = (identity: string, match: RuleMatch) => {
    const node = nodes.get(identity);
    if (node?.kind !== 'governance') return;
    const known = reasons.get(identity) ?? [];
    if (!known.some((entry) => entry.by === match.by && entry.value === match.value && entry.of === match.of))
      known.push(match);
    reasons.set(identity, known);
  };
  for (const [identity, selections] of claimants(read, 'subject.covers'))
    for (const value of selections) reason(identity, { by: 'covers', value, of: 'seat' });
  const focus: readonly string[] = SHAPE_ROWS.governance.predicates;
  const seatNode = read.seat.identity === null ? undefined : nodes.get(read.seat.identity);
  if (seatNode !== undefined)
    for (const row of read.view(seatNode.identity))
      if (row.consented && row.other !== null && row.predicate !== null && focus.includes(row.predicate))
        reason(row.other, { by: 'row', value: row.spelling, of: 'seat' });
  // The key's word stands for its kind through the records of that word in scope.
  const wordKind =
    key.word === null ? undefined : [...nodes.values()].find((node) => node.discriminator === key.word)?.kind;
  for (const node of [...nodes.values()].sort(byBand)) {
    if (node.kind !== 'governance') continue;
    const named = subjectWords(node),
      kinds = subjectKinds(node);
    if (seatNode !== undefined) {
      if (named.includes(seatNode.discriminator))
        reason(node.identity, { by: 'subject-word', value: seatNode.discriminator, of: 'seat' });
      if (kinds.includes(seatNode.kind))
        reason(node.identity, { by: 'subject-kind', value: seatNode.kind, of: 'seat' });
    }
    if (key.word !== null) {
      if (named.includes(key.word)) reason(node.identity, { by: 'subject-word', value: key.word, of: 'word' });
      if (wordKind !== undefined && kinds.includes(wordKind))
        reason(node.identity, { by: 'subject-kind', value: wordKind, of: 'word' });
    }
  }
  const lines = [...reasons].map(([identity, by]): RuleLine => {
    const node = nodes.get(identity)!,
      severity = effectiveSeverity(node.dimensions, key.coordinate) ?? null;
    return { ...read.describe(node), severity, blocking: severity === 'blocking', by };
  });
  const order = (a: RuleLine, b: RuleLine) => b.band - a.band || compare(a.identity, b.identity);
  const blocking = lines.filter((line) => line.blocking).sort(order),
    others = lines.filter((line) => !line.blocking).sort(order);
  return {
    listed: [...blocking, ...others.slice(0, key.budget)],
    count: lines.length,
    truncated: Math.max(0, others.length - key.budget),
  };
}

/** The other ends of a record's outgoing field references in `spelling`, in row order. */
const referenced = (read: BodyReading, identity: string, spelling: string): readonly string[] =>
  read
    .view(identity)
    .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.spelling === spelling && row.other)
    .map((row) => row.other!);

function mandatesOf(read: BodyReading): readonly MandateLine[] {
  const { nodes, seat } = read,
    reasons = new Map<string, MandateMatch[]>();
  const reason = (identity: string, match: MandateMatch) => {
    if (nodes.get(identity)?.discriminator !== 'mandate') return;
    reasons.set(identity, [...(reasons.get(identity) ?? []), match]);
  };
  for (const [identity, selections] of claimants(read, 'authority.covers'))
    for (const value of selections) reason(identity, { by: 'covers', value });
  // The participant a seat answers for is its home workspace's steward (`composition.steward`).
  const participants = seat.home === null ? [] : referenced(read, seat.home, 'composition.steward');
  for (const node of [...nodes.values()].sort(byBand))
    if (node.discriminator === 'mandate')
      for (const participant of referenced(read, node.identity, 'authority.participant'))
        if (participants.includes(participant)) reason(node.identity, { by: 'participant', value: participant });
  const lines: MandateLine[] = [];
  for (const [identity, by] of reasons) {
    const node = nodes.get(identity)!;
    // A declared scope names the workspaces a mandate applies in; a seat outside all of them is outside it.
    const scope = referenced(read, identity, 'authority.scope'),
      scoped = node.sections.some(
        (section) =>
          section.name === 'authority' && section.fields.some((field) => 'key' in field && field.key === 'scope'),
      );
    if (scoped && (seat.home === null || !scope.includes(seat.home))) continue;
    let line: MandateLine;
    try {
      const authority = mandateAuthorityOf(node);
      line = {
        ...read.describe(node),
        by,
        participant: referenced(read, identity, 'authority.participant')[0] ?? null,
        moves: authority.moves ?? null,
        scope: scoped ? scope : null,
        excludedWords: authority.excludedWords ?? null,
        covers: authority.covers ?? null,
        refusal: mandateRefusal(authority, OPERATION_MODES.position) ?? null,
        problem: null,
      };
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      line = {
        ...read.describe(node),
        by,
        participant: null,
        moves: null,
        scope: null,
        excludedWords: null,
        covers: null,
        refusal: null,
        problem: error.message,
      };
    }
    lines.push(line);
  }
  return lines.sort((a, b) => b.band - a.band || compare(a.identity, b.identity));
}

/** The four on-demand sections of a body, from what the body read. */
export function onDemand(read: BodyReading): OnDemand {
  const applies = appliesByWord(read);
  // Cells come from every playbook that applies by word, listed or tallied, and the playbooks at the seat.
  return {
    appliesByWord: applies.section,
    cells: cellsOf(
      read,
      applies.nodes.map((node) => node.identity),
    ),
    rules: rulesOf(read),
    mandates: mandatesOf(read),
  };
}
