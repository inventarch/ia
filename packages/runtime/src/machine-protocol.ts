/**
 * The machine protocol's one description (docs/specs/command-discoverability/README.md §2). For each Door operation:
 * its purpose, parameter schema, result, refusals with a next action, and an example that returns `ok: true` on
 * packages/compliance/fixtures/loop (next reads work records loop does not hold: its example answers on a workspace with
 * one authored plan). `ia <operation> --help`, the MCP door's tools/list and
 * docs/reference/cli/machine-protocol.md are projections of this table. It describes the wire format and changes none
 * of it: the Door validates every request itself, and tests/select-door.test.ts and apps/cli/tests/cli.test.ts hold this
 * table to what the Door admits and refuses. Version 1's nine operations come first and stay as version 1 described
 * them; an operation a later version adds follows them and carries `since`.
 */
import { COORDINATE_DOMAINS } from './coordinate.js';
import { SCOPE_KEY_CAPS } from './scope-key.js';
import { freeze } from './types.js';

export type JsonSchema = Readonly<Record<string, unknown>>;
export interface ProtocolRefusal {
  /** The refusal's `code`; for a selection escalation, the escalation's own name. */
  readonly code: string;
  readonly when: string;
  readonly next: string;
}
export interface ProtocolOperation {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly params: JsonSchema;
  readonly result: string;
  readonly refusals: readonly ProtocolRefusal[];
  readonly example: Readonly<Record<string, unknown>>;
  /** The MCP tool that serves it, or null where `differences` says why it is CLI-only. */
  readonly mcp: string | null;
  /**
   * The protocol version that added the operation. Absent on the nine operations version 1 describes, so their rows
   * stay as version 1 printed them.
   */
  readonly since?: number;
}
export interface ProtocolDifference {
  readonly topic: string;
  readonly cli: string;
  readonly mcp: string;
}
export interface MachineProtocol {
  /** Bumped by any change to an operation's params, so a caller can tell which description it holds. */
  readonly version: number;
  readonly flow: readonly string[];
  readonly operations: readonly ProtocolOperation[];
  readonly differences: readonly ProtocolDifference[];
}

const text = (description: string) => ({ type: 'string', description });
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const object = (properties: Record<string, unknown>, required: readonly string[] = [], description?: string) => ({
  type: 'object',
  ...(description === undefined ? {} : { description }),
  properties,
  required,
  additionalProperties: false,
});
const axes = Object.fromEntries(
  Object.entries(COORDINATE_DOMAINS).map(([axis, values]) => [axis, { type: 'string', enum: values }]),
);
const coordinate = (description: string, required?: readonly string[]) => ({
  type: 'object',
  description,
  properties: axes,
  ...(required === undefined ? {} : { required }),
  additionalProperties: false,
});
/**
 * On a read the Door always passes a scope token, the initial one when `within` is omitted, so root, phase and revision
 * assert that scope's own values rather than narrow the read (packages/db/SPEC.md D08).
 */
const read = {
  within: text(
    'Scope token issued earlier in the same process: one CLI invocation, or the MCP server process. Omitted, the call reads the initial boundary.',
  ),
  root: text(
    'Asserts the scope\'s root ("" for the initial scope); a path to any other location refuses with IA-DB-SCOPE-MISMATCH. It does not narrow the read: issue a scope and pass its token as within. Not the workspace path, which is --root on the CLI and the configured root on MCP.',
  ),
  phase: {
    anyOf: [{ type: 'string', enum: COORDINATE_DOMAINS.phase }, { type: 'null' }],
    description:
      "Asserts the scope's phase (null for a scope without one); a different one refuses with IA-DB-SCOPE-MISMATCH, and a value outside the phase set with IA-GRAPH-COORDINATE-VALUE-UNKNOWN. It does not narrow the read.",
  },
  revision: text("Asserts the scope's revision; any other value refuses with IA-DB-SCOPE-MISMATCH."),
};
/** On scope the same keys bind the new scope, which stays inside its parent (packages/db/SPEC.md D07). */
const narrowing = {
  within: text('Parent scope token issued earlier in the same process; omitted, the parent is the initial boundary.'),
  root: text(
    "Workspace-relative location the new scope resolves from: the parent's root or a directory below it. A source is admitted where its declared reach covers this location, and the default empty reach covers every location, so this is not a path filter.",
  ),
  phase: {
    anyOf: [{ type: 'string', enum: COORDINATE_DOMAINS.phase }, { type: 'null' }],
    description: "Phase to bind the new scope to; omitted keeps the parent's phase, and null binds none.",
  },
  revision: text("Asserts the parent scope's revision; any other value refuses with IA-DB-SCOPE-MISMATCH."),
};
const reference = {
  description:
    'A typed reference: {kind: "identity", identity} or {kind: "ref", discriminator, name}, each with an optional fragment.',
  oneOf: [
    object(
      {
        kind: { const: 'identity' },
        identity: text('Admitted identity.'),
        fragment: text('Fragment inside the record.'),
      },
      ['kind', 'identity'],
    ),
    object(
      {
        kind: { const: 'ref' },
        discriminator: text('Record discriminator, such as playbook.'),
        name: text('Record name.'),
        fragment: text('Fragment inside the record.'),
      },
      ['kind', 'discriminator', 'name'],
    ),
  ],
};
const request = {
  within: read.within,
  text: text('The request in plain words; may be empty.'),
  coordinate: coordinate(
    'Where the work stands. phase and primitive are required; each further axis narrows what applies.',
    ['phase', 'primitive'],
  ),
  subject: {
    anyOf: [{ type: 'string' }, reference],
    description: 'The record the request is about: an identity or a typed reference.',
  },
  follow: strings('Relationship verbs to follow from the delivered records.'),
  revision: read.revision,
};

const REQUEST_INVALID: ProtocolRefusal = {
  code: 'IA-RUNTIME-REQUEST-INVALID',
  when: 'A parameter is unknown, missing or of the wrong type.',
  next: "Match the parameters to this operation's schema; the message names what was expected.",
};
const SCOPE_UNAVAILABLE: ProtocolRefusal = {
  code: 'IA-DB-SCOPE-UNAVAILABLE',
  when: 'within is a token this process did not issue.',
  next: 'Omit within, or pass a token issued earlier in the same process; a CLI token ends with its invocation.',
};
const SCOPE_MISMATCH: ProtocolRefusal = {
  code: 'IA-DB-SCOPE-MISMATCH',
  when: "root, phase or revision differs from the scope's own value.",
  next: "Drop the binding or pass the scope's own value. To read a narrower scope, issue one with scope and pass its token as within in the same process; a CLI invocation performs one operation, so its reads cover the initial boundary.",
};
const PARENT_MISMATCH: ProtocolRefusal = {
  code: 'IA-DB-SCOPE-MISMATCH',
  when: "revision differs from the parent scope's, or root lies outside the parent's root.",
  next: "Omit revision or pass the parent's, and choose a root at or below the parent's.",
};
const REVISION_MISMATCH: ProtocolRefusal = {
  code: 'IA-DB-SCOPE-MISMATCH',
  when: "revision differs from the scope's own.",
  next: "Drop revision or pass the scope's own.",
};
const VALUE_UNKNOWN: ProtocolRefusal = {
  code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
  when: 'A phase or coordinate value is outside its closed set, or coordinate names an unknown axis.',
  next: 'Use one of the values or axes the message lists.',
};
const COORDINATE_INCOMPLETE: ProtocolRefusal = {
  code: 'coordinate-incomplete',
  when: 'coordinate lacks an axis this operation needs; missing names each one.',
  next: 'Declare every axis in missing on coordinate.',
};
const VERB_UNKNOWN: ProtocolRefusal = {
  code: 'IA-GRAPH-VERB-UNKNOWN',
  when: 'follow names a verb the language does not define.',
  next: 'Use the verbs the message lists.',
};
/** The refusals every read through the four bindings shares. */
const BOUND = [REQUEST_INVALID, SCOPE_UNAVAILABLE, SCOPE_MISMATCH, VALUE_UNKNOWN];
/** context and select: phase is a coordinate axis there, not a binding, and revision is the only scope assertion. */
const REQUESTED = [REQUEST_INVALID, SCOPE_UNAVAILABLE, REVISION_MISMATCH, COORDINATE_INCOMPLETE, VALUE_UNKNOWN];
const EXAMPLE_IDENTITY = 'governance-system/definition/procedure/sample-procedure';
const count = (part: keyof typeof SCOPE_KEY_CAPS, description: string) => ({
  type: 'integer',
  minimum: 0,
  maximum: SCOPE_KEY_CAPS[part],
  description,
});

/** Frozen deeply, so a projection that shares its schema objects (the MCP tools) cannot change it. */
export const MACHINE_PROTOCOL: MachineProtocol = freeze({
  version: 2,
  flow: [
    'scope issues a token that bounds later reads by phase or identities, and by root only where sources declare a reach. It is optional: without within, a call reads the initial boundary.',
    'context delivers the cited procedure cells and governance that apply to a coordinate; select chooses exactly one binding among candidates, or refuses.',
    'get, records, resolve, search and traverse read admitted records inside the scope; pass within to stay inside a narrowed one.',
    'A token lives as long as the process that issued it: one CLI invocation, or the MCP server process. A CLI invocation performs one operation, so its reads always cover the initial boundary; narrowing takes scope, then within, in one MCP session.',
    "report is privileged inspection of the whole workspace's admission, served by the CLI only.",
    'Since version 2: position delivers the body for a scope key, its digest and a host note, and issues no token; read returns the text behind one locator; next delivers the delivery view of a plan, milestone or task. Their refusals carry a next action. The nine operations above are unchanged, and on the CLI these three take the machine route only with --params or --schema.',
  ],
  operations: [
    {
      name: 'scope',
      summary: 'Issue a read-only scope, or narrow one by phase or identities.',
      description:
        'Issue a read-only scope or narrow an existing scope by phase or identity set; its root narrows only where sources declare a reach. Pass its token as within to later calls in the same process.',
      params: object({
        ...narrowing,
        identities: strings("Identities the new scope admits; it stays inside the parent's boundary."),
      }),
      result: 'The scope: {token, root, revision}, plus phase when one is bound.',
      refusals: [REQUEST_INVALID, SCOPE_UNAVAILABLE, PARENT_MISMATCH, VALUE_UNKNOWN],
      example: { identities: [EXAMPLE_IDENTITY] },
      mcp: 'ia_scope',
    },
    {
      name: 'context',
      summary: 'Deliver the cited procedure cells and governance that apply to a coordinate.',
      description:
        'Deliver cited IA procedure cells and applicable governance for a declared phase and primitive. Budget.tokens counts delivered text and purpose, not the whole JSON response. Blocking obligations cannot be silently budgeted away. Narrow topical context with the search and scope operations.',
      params: object(
        {
          ...request,
          ranking: {
            enum: ['native', 'topical'],
            description:
              'Default native preserves procedure-first ordering. Topical prioritizes scoped search relevance after reserving all blocking governance; it does not affect execution selection.',
          },
          budget: object(
            { tokens: { type: 'integer', minimum: 0 }, records: { type: 'integer', minimum: 0 } },
            ['tokens', 'records'],
            'Delivery limits; default {tokens: 4000, records: 50}.',
          ),
        },
        ['text', 'coordinate'],
      ),
      result:
        'A cited packet: {revision, scope, coordinate, included, omitted, followed, gated, dangling, limits}. included holds the delivered cells with their citations; omitted names what the budget, a disqualifying condition or an unresolved reference left out.',
      refusals: [
        ...REQUESTED,
        VERB_UNKNOWN,
        {
          code: 'IA-RUNTIME-BUDGET-INVALID',
          when: 'budget.tokens or budget.records is negative or not a safe integer.',
          next: 'Pass nonnegative integers, or omit budget for the default.',
        },
        {
          code: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
          when: 'The budget cannot hold every applicable blocking obligation; required gives the minimum.',
          next: 'Raise budget to at least required, or narrow the scope.',
        },
      ],
      example: { text: 'author a record', coordinate: { phase: 'orient', primitive: 'Decision' } },
      mcp: 'ia_context',
    },
    {
      name: 'select',
      summary: 'Choose exactly one binding among candidate identities, or refuse.',
      description:
        'Choose exclusively among supplied identities; ties or missing required coordinates refuse. This grants no execution permission.',
      params: object(
        {
          ...request,
          follow: strings('Accepted for symmetry with context; select ignores it.'),
          candidates: strings('Identities to choose among.'),
          requiredAxes: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(COORDINATE_DOMAINS) },
            description:
              'Further coordinate axes the request must declare; a missing one refuses with coordinate-incomplete.',
          },
        },
        ['text', 'coordinate', 'candidates'],
      ),
      result: 'The chosen binding: {revision, scope, entry}.',
      refusals: [
        ...REQUESTED,
        {
          code: 'no-candidate',
          when: 'No candidate is admitted in this scope and applies to the coordinate.',
          next: 'Pass candidates that apply; context lists the procedures that do.',
        },
        {
          code: 'deny-wins-tie',
          when: 'Candidates tie on step, score and band.',
          next: 'Declare more coordinate axes so one applies more specifically, or pass fewer candidates.',
        },
      ],
      example: {
        text: '',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'process' },
        candidates: [EXAMPLE_IDENTITY],
      },
      mcp: 'ia_select',
    },
    {
      name: 'get',
      summary: 'Read one admitted record inside the scope.',
      description: 'Read one admitted IA record inside the scope.',
      params: object({ ...read, identity: text('Admitted identity to read.') }, ['identity']),
      result:
        'The admitted record: {identity, system, kind, discriminator, name, source, sections, edges, cells, ...}.',
      refusals: [
        ...BOUND,
        {
          code: 'IA-DB-OUT-OF-SCOPE',
          when: 'The identity is outside the scope.',
          next: 'Pick an identity that records or search returns in this scope, or widen the scope.',
        },
      ],
      example: { identity: EXAMPLE_IDENTITY },
      mcp: 'ia_get',
    },
    {
      name: 'records',
      summary: 'Read the whole admitted snapshot inside the scope.',
      description:
        'Read the admitted immutable record snapshot inside the scope. It can be large; search, get and traverse read less.',
      params: object(read),
      result: 'The snapshot: {revision, root, records, systems}, plus phase when the scope binds one.',
      refusals: BOUND,
      example: {},
      mcp: 'ia_records',
    },
    {
      name: 'resolve',
      summary: 'Resolve a typed reference or identity to exactly one record.',
      description:
        'Resolve a typed reference or identity with exact-cardinality refusal. An unresolved reference is still a successful response; its result says why.',
      params: object({ ...read, reference }, ['reference']),
      result:
        '{ok: true, identity} when exactly one record matches; otherwise {ok: false, code, ...}, for example IA-GRAPH-TARGET-MISSING.',
      refusals: BOUND,
      example: { reference: { kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' } },
      mcp: 'ia_resolve',
    },
    {
      name: 'search',
      summary: 'Search decoded record text inside the scope.',
      description: 'Search decoded IA text with statistics restricted to the scope.',
      params: object({ ...read, text: text('Words to find.') }, ['text']),
      result: 'An array of hits inside the scope, each naming an identity.',
      refusals: BOUND,
      example: { text: 'authoring' },
      mcp: 'ia_search',
    },
    {
      name: 'traverse',
      summary: 'Follow typed relationships from start identities.',
      description: 'Follow scoped IA relationships with typed filters and optional conditional gating.',
      params: object(
        {
          ...read,
          start: strings('Identities to start from.'),
          follow: strings('Relationship verbs to follow.'),
          direction: { enum: ['out', 'in', 'both'], description: 'Edge direction.' },
          depth: { type: 'integer', minimum: 0, maximum: 8, description: 'Hops from start.' },
          filter: object(
            {
              kind: { enum: COORDINATE_DOMAINS.kind },
              discriminator: text('Record discriminator.'),
              system: text('Owning system.'),
            },
            [],
            'Keep only records of this kind, discriminator or system.',
          ),
          coordinate: coordinate('Coordinate that conditional relationships are gated by.'),
        },
        ['start'],
      ),
      result: 'The walk: {nodes, via, edges, gated, dangling}; each node carries its depth.',
      refusals: [
        ...BOUND,
        VERB_UNKNOWN,
        {
          code: 'IA-GRAPH-TRAVERSAL-INVALID',
          when: 'depth is not an integer from 0 to 8.',
          next: 'Pass an integer depth from 0 to 8.',
        },
      ],
      example: { start: [EXAMPLE_IDENTITY], depth: 1 },
      mcp: 'ia_traverse',
    },
    {
      name: 'report',
      summary: 'Report admission verdicts and findings for the whole workspace (CLI only).',
      description:
        'Report admission verdicts and findings for the whole workspace. Privileged local inspection: the CLI enables it and the MCP door does not serve it.',
      params: object({}),
      result:
        'The report: {revision, outcome, verdicts, findings, shadows}. On the CLI an outcome of fail exits 1 although the response is ok.',
      refusals: [
        {
          code: 'IA-RUNTIME-REQUEST-INVALID',
          when: 'A parameter was supplied (report takes none), or the host has not enabled report.',
          next: 'Pass {} or omit --params; only the CLI enables report.',
        },
      ],
      example: {},
      mcp: null,
    },
    {
      name: 'position',
      summary: 'Deliver the position body for a scope key, with its digest and a host note.',
      description:
        "Deliver body(K) for the scope key K = (seat, shape, phase, depth, budget, word): the seat, the records loaded around it, pointer lines, tallies, applicable rules, cells and mandates, read through the scope. The body is a pure function of the key's value and the admitted revision, so equal keys give one digest on every host; the host note beside it tells this host's capture freshness and facts and is never part of the body. An empty key is K0. It issues no scope token.",
      params: object({
        within: read.within,
        seat: text('A record identity or a workspace-relative path to seat the body at; omitted, the workspace seat.'),
        shape: {
          type: 'string',
          enum: COORDINATE_DOMAINS.shape,
          description: 'The shape the body is told in; omitted, context. It also fixes the primitive.',
        },
        phase: {
          type: 'string',
          enum: COORDINATE_DOMAINS.phase,
          description: "The phase; omitted, the anchor phase of the shape's primitive.",
        },
        depth: count('depth', 'Hops from the seeds; omitted, 1, or 0 for an empty key.'),
        budget: count('budget', 'Records loaded beyond the seat; omitted, 16, or 0 for an empty key.'),
        word: text('A word that restricts the seeds and tallies, such as law.'),
      }),
      result:
        "{body, digest, hostNote}: body is the position body; digest is the SHA-256 of {format: 'ia-body-1', body} in the canonical codec; hostNote ('ia-host-note-1') carries the revision, the capture store's revisions and freshness, staleness counts, the host's facts and the key used.",
      refusals: [
        REQUEST_INVALID,
        SCOPE_UNAVAILABLE,
        {
          code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
          when: 'shape or phase is outside its closed set.',
          next: 'Use one of the values the message lists.',
        },
        {
          code: 'IA-DB-OUT-OF-SCOPE',
          when: 'seat names an admitted record outside the scope.',
          next: 'Seat the body at a record inside the scope, or omit seat for the workspace seat.',
        },
        {
          code: 'IA-DB-PATH-UNSAFE',
          when: 'seat is a path that leaves the workspace.',
          next: 'Pass a record identity or a workspace-relative path, such as docs/guide.md.',
        },
      ],
      example: { shape: 'context', phase: 'orient' },
      mcp: 'ia_position',
      since: 2,
    },
    {
      name: 'read',
      summary: 'Read the text behind one locator: a record, a cell, a requirement or a source line.',
      description:
        "Read the body behind a locator inside the scope: a record's own text, one cell's or one requirement's text, or the innermost record holding a source line, with that record's per-record digest. Structure is read with get, not here.",
      params: object(
        {
          within: read.within,
          locator: text('identity, identity#phase/Primitive, identity#REQ-ID or path:line.'),
        },
        ['locator'],
      ),
      result: "{identity, fragment, body, digest, source}: the text read, its record's digest and source 'record'.",
      refusals: [
        {
          code: 'IA-RUNTIME-REQUEST-INVALID',
          when: 'locator is missing or is none of the four forms, or a parameter is unknown.',
          next: 'Pass locator as identity, identity#phase/Primitive, identity#REQ-ID or path:line.',
        },
        SCOPE_UNAVAILABLE,
        {
          code: 'IA-DB-OUT-OF-SCOPE',
          when: 'locator names an identity that is not admitted inside the scope.',
          next: 'Pick an identity that records or search returns in this scope.',
        },
        {
          code: 'IA-DB-SOURCE-UNAVAILABLE',
          when: 'Nothing is readable behind the locator: no such cell or requirement, no body text, or no record at that line.',
          next: 'Read the record with get to see its cells and requirements, or name a line a record holds.',
        },
      ],
      example: { locator: EXAMPLE_IDENTITY },
      mcp: 'ia_read',
      since: 2,
    },
    {
      name: 'next',
      summary: 'Tell what is next under a plan, a milestone or a task: the delivery view.',
      description:
        "Deliver the delivery view at a plan, milestone or task, computed on each call and never stored: the plan's milestones and each milestone's tasks in require order, five state lines per record (accepted, admitted, realizable, realized, worked), each with its basis, every requirement's standing, and one verdict per record: no declared blocker, blocked naming its basis, or exit evidence recorded naming the observation and its evaluator. It reads the records the scope admits, never the runtime band, and authored observations as evidence; admitted compares a record with the snapshot the capture store holds as current. Omitted, seat is the scope's only authored plan. It issues no scope token.",
      params: object({
        within: read.within,
        seat: text("A plan, milestone or task identity; omitted, the scope's only authored plan."),
      }),
      result:
        "The delivery view ('ia-next-1'): {format, revision, seat, participant, snapshot, evidence, ordered, entries, review, next}. Each entry carries identity, word, milestone, status, owner, its five lines, its requirements and its verdict; review lists require cycles, and next is the ia position command for the first task with no declared blocker, or null.",
      refusals: [
        {
          code: 'IA-RUNTIME-REQUEST-INVALID',
          when: 'A parameter is unknown or seat is not a string; or without seat the scope admits no authored plan or more than one; or seat names no plan, milestone or task the scope admits.',
          next: 'Pass only within and a seat identity. A refusal about the seat or the plan names its own next command instead: the worked example of a plan, a plan to seat at, or the view without seat.',
        },
        SCOPE_UNAVAILABLE,
      ],
      example: {},
      mcp: 'ia_next',
      since: 2,
    },
  ],
  differences: [
    {
      topic: 'report',
      cli: 'ia report prints the privileged admission report.',
      mcp: 'Not served: the door runs with report disabled.',
    },
    {
      topic: 'vocabulary',
      cli: 'The consumer verb ia vocabulary, with its own options and --json envelope.',
      mcp: 'The tool ia_vocabulary; it is not a Door operation.',
    },
    {
      topic: 'Token lifetime',
      cli: 'One invocation: a token printed by one run cannot be passed to the next, so every CLI read covers the initial boundary.',
      mcp: 'The server process: a token stays valid across calls until the server exits.',
    },
    {
      topic: 'Workspace',
      cli: '--root <path>, default the current directory, with no search upward.',
      mcp: 'The root the host configured when it started the server.',
    },
    {
      topic: 'Context format',
      cli: 'No format parameter; the full packet.',
      mcp: 'ia_context also takes format=full|compact; compact summarizes omissions.',
    },
    {
      topic: 'Refusals',
      cli: 'The refusal object on stdout; exit 2 for IA-RUNTIME-REQUEST-INVALID, otherwise 1. IA-CLI-USAGE (exit 2) for an argument error and IA-DB-ROOT-INVALID (exit 1) for a missing --root belong to the route.',
      mcp: 'The same object as structuredContent and text, with isError true; protocol faults are JSON-RPC errors.',
    },
  ],
});
