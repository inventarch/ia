/**
 * The machine protocol's one description (docs/specs/command-discoverability/README.md §2). For each Door operation:
 * its purpose, parameter schema, result, refusals with a next action, and an example that returns `ok: true` on
 * packages/compliance/fixtures/loop, or for `next`, as that fixture authors no @plan, on the delivery fixture
 * packages/runtime/tests/fixtures/delivery/base laid over the conformance corpus. `ia <operation> --help` (the version
 * 1 operations, which are the CLI's machine routes), the MCP door's tools/list and docs/reference/cli/machine-protocol.md
 * are projections of this table. It describes the frozen wire format and changes none of it: the Door validates every
 * request itself, and tests/select-door.test.ts, tests/door-read.test.ts, tests/next.test.ts,
 * tests/door-position.test.ts and apps/cli/tests/cli.test.ts hold this table to what the Door admits and refuses. A
 * later version only appends operations (`since`), so the version 1 rows stay byte-identical to 1.1.0's
 * (tests/golden/machine-protocol-v1.json).
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
   * The protocol version that added the operation, absent on the version 1 operations, whose rows are unchanged. The
   * CLI's machine routes are the version 1 operations; a later one is served by the Door and the MCP door.
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

/** Frozen deeply, so a projection that shares its schema objects (the MCP tools) cannot change it. */
export const MACHINE_PROTOCOL: MachineProtocol = freeze({
  version: 2,
  flow: [
    'scope issues a token that bounds later reads by phase or identities, and by root only where sources declare a reach. It is optional: without within, a call reads the initial boundary.',
    'context delivers the cited procedure cells and governance that apply to a coordinate; select chooses exactly one binding among candidates, or refuses.',
    'get, records, resolve, search and traverse read admitted records inside the scope; pass within to stay inside a narrowed one.',
    'A token lives as long as the process that issued it: one CLI invocation, or the MCP server process. A CLI invocation performs one operation, so its reads always cover the initial boundary; narrowing takes scope, then within, in one MCP session.',
    "report is privileged inspection of the whole workspace's admission, served by the CLI only.",
    'Version 2 adds read: the body behind one locator inside the scope, with its digest. The Door and the MCP door serve it; on the CLI the consumer verb ia read returns the same body and digest, and the machine routes stay the version 1 operations.',
    "Version 2 also adds next: one plan's delivery view inside the scope, its tasks in prerequisite order with their verdicts, computed per call and never stored. The Door and the MCP door serve it, and on the CLI the consumer verb ia next prints the same view. Its refusals carry next, the one command to run, and the plans or the cycle they name.",
    'Version 2 also adds position: body(K), what a scope key (seat, shape, phase, depth, budget, word) loads inside the scope, with its digest and a host note beside it. The body is a pure function of the key and the admitted revision, so one key reads one body and digest wherever the workspace is, and nothing text-driven runs. The Door and the MCP door serve it, and the machine routes stay the version 1 operations. A refusal of the key carries next, the one command to run.',
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
      name: 'read',
      summary: 'Read the body behind one locator inside the scope, with its digest.',
      description:
        "Read the body behind one locator inside the scope: a cell's or requirement's text for a fragment, else the document the record's source locator names (the section under its markdown anchor), else the record's own body. digest is the SHA-256 of the body's UTF-8 bytes; a read certifies nothing. A locator outside the scope is refused without naming what lies outside it.",
      params: object(
        {
          within: read.within,
          locator: text(
            '<identity>, <identity>#<phase>/<Primitive>, <identity>#<REQ-ID> or <path>:<line>, the path relative to the workspace root.',
          ),
          includeRuntime: {
            type: 'boolean',
            description: 'Read a record at runtime placement (band 0), which is refused otherwise; default false.',
          },
        },
        ['locator'],
      ),
      result:
        "The body: {locator, identity, kind, path?, digest, body, certified: false}. kind is record for a record's own body or a fragment's text, and document for the file its source locator names, at the workspace-relative path.",
      refusals: [
        REQUEST_INVALID,
        SCOPE_UNAVAILABLE,
        {
          code: 'IA-RUNTIME-READ-UNADMITTED',
          when: "No admitted record inside the scope answers the locator. In a scope narrower than the whole workspace the refusal names no path, line, identity or refused record; on the whole workspace's scope it says what the workspace's sources hold there, a record admission refused with its path, line and reason.",
          next: 'Read a locator that records or search returns in this scope, or widen the scope.',
        },
        {
          code: 'IA-RUNTIME-READ-FRAGMENT',
          when: 'The record has no cell at the phase/Primitive address, or no requirement with the id.',
          next: 'Read a cell address or requirement id that get returns for the record, or the record without a fragment.',
        },
        {
          code: 'IA-RUNTIME-READ-UNREACHABLE',
          when: "The document the record's source locator names cannot be read: a URL, a path outside the workspace or the record's tree, an adopted mount bound to no directory, a nonportable path, a missing, linked or oversized file, bytes that are not UTF-8, or an anchor no markdown heading has.",
          next: "Restore the file the refusal's path names, or correct the record's source locator, which get shows with its source line.",
        },
        {
          code: 'IA-RUNTIME-READ-PLACEMENT',
          when: 'The record is at runtime placement (band 0) and includeRuntime is not true.',
          next: 'Pass includeRuntime: true to read it.',
        },
      ],
      example: { locator: `${EXAMPLE_IDENTITY}#act/Decision` },
      mcp: 'ia_read',
      since: 2,
    },
    {
      name: 'next',
      summary: "Read one plan's delivery view inside the scope: its tasks in order, each with a verdict.",
      description:
        "Read one plan's delivery view inside the scope, computed per call and never stored: its milestones and tasks in one prerequisites-first order, each task with a basis line per requirement (its own and its milestone's), one verdict (exit evidence recorded, no declared blocker, or blocked), its work.status as self-declared, which is never a basis, and five state lines; then review items and the next task. Exit evidence is a success @observation on the task whose subject-revision is its current digest. What the scope does not read is never counted as met, and a relation row that carries a condition counts only where it holds at the coordinate the scope binds, as graph traversal decides it: a term that coordinate leaves undecided, such as a phase where none is bound or a severity the stating record's own does not decide, leaves the row conditional, its basis unknown, never met.",
      params: object({
        within: read.within,
        seat: text(
          "A @plan, @milestone or @task identity; the view is that plan's, or the plan of that milestone or task. Omitted, the only admitted @plan at authored placement (band 100).",
        ),
      }),
      result:
        'The view: {format: ia.delivery-view.v1, revision, plan, milestones, tasks, review, next, summary}. Each task is {identity, milestone, status, prerequisites, verdict, line, evidence?, states}; next is the command for the first task with no declared blocker, or null when every task has exit evidence or every other one is blocked, which summary says.',
      refusals: [
        REQUEST_INVALID,
        SCOPE_UNAVAILABLE,
        {
          code: 'IA-RUNTIME-NEXT-SEAT',
          when: 'seat is not an admitted record in the scope, or is not a @plan, @milestone or @task.',
          next: "Run the command the refusal's next names: the view without a seat for a seat no admitted record answers (ia next, the first authored plan's, or ia next --help when none is authored), or the position of a record of another word.",
        },
        {
          code: 'IA-RUNTIME-NEXT-NO-PLAN',
          when: 'seat belongs to no admitted @plan, or no seat is given and no @plan is authored at band 100.',
          next: "Author a @plan, @milestone records that name it in work.plan and @task records that name those in work.milestone; the refusal's next names the help that says so.",
        },
        {
          code: 'IA-RUNTIME-NEXT-AMBIGUOUS',
          when: 'No seat is given and several @plan records are authored at band 100; the refusal lists them in plans.',
          next: "Pass one of plans as seat, as the refusal's next does with the first.",
        },
        {
          code: 'IA-RUNTIME-NEXT-CYCLE',
          when: "The plan's require rows form a cycle among its tasks, milestones or both, so no order exists; the refusal lists the cycle's declared rows in cycle.",
          next: "Remove one of the require rows in cycle; the refusal's next names the position of its first task, or else its first milestone.",
        },
      ],
      example: {},
      mcp: 'ia_next',
      since: 2,
    },
    {
      name: 'position',
      summary: 'Read body(K), what a scope key loads inside the scope, with its digest and host note.',
      description:
        "Read the position a scope key K = (seat, shape, phase, depth, budget, word) names inside the scope: body(K), the seat, the records the key loads in the shape's order, the blocking governance reserved outside the budget, pointers and their tallies, the rules and playbooks that apply by word with their tallies and the playbook cells they deliver, the mandates that govern the seat, the frontier one hop past it, what is unknown and the keys that widen it; its digest; and the host note beside it. A key naming no part is K0 (the repository's @workspace, context, orient, depth 0, budget 0); one naming any part takes context, the anchor phase of its shape's primitive, depth 1 and budget 16 for the rest. A relation row with a condition is followed only where the condition holds at the key's coordinate. The body is a pure function of the key and the admitted records the scope reads: it names no root path, token, time or capture, nothing text-driven runs, and no record body enters it, only the cells delivered; read fetches a body. A refusal of the key carries next, the one command to run.",
      params: object({
        within: read.within,
        seat: {
          anyOf: [
            { type: 'string' },
            object(
              { path: text('Workspace-relative, or an absolute path inside the workspace root.') },
              ['path'],
              'A location.',
            ),
          ],
          description:
            "S: an identity the scope admits, or {path} for a location inside the workspace. Omitted, the repository's own @workspace.",
        },
        shape: {
          type: 'string',
          enum: COORDINATE_DOMAINS.shape,
          description: 'H, the intent shape; omitted, context.',
        },
        phase: {
          type: 'string',
          enum: COORDINATE_DOMAINS.phase,
          description: "P; omitted, the anchor phase of the shape's primitive.",
        },
        depth: {
          type: 'integer',
          minimum: 0,
          maximum: SCOPE_KEY_CAPS.depth,
          description:
            "d, the rows a body hops along the shape's predicate focus; omitted, 1, or 0 when no part is named (K0).",
        },
        budget: {
          type: 'integer',
          minimum: 0,
          maximum: SCOPE_KEY_CAPS.budget,
          description:
            'n, the entries loaded beyond the seat, blocking governance reserved outside it; omitted, 16, or 0 when no part is named (K0).',
        },
        word: text(
          'w, a word the closure registers: only records of it load, are pointers or are tallied as pointers or frontier; the reserved rules, the rules and playbooks that apply by word with their tallies and cells, and the mandates are listed whatever their word. Omitted, none.',
        ),
      }),
      result:
        "The position: {body, digest, hostNote}. body is body(K) in the format ia.position-body.v1, its key the one resolved and its revision that of the view the scope reads; digest is the SHA-256 of the body's canonical JSON text; hostNote is {revision, capturedRevision?, previousRevision?, freshness, key}, host state never digested, freshness current, stale or no-capture against the last capture and key the key as completed.",
      refusals: [
        {
          code: 'IA-RUNTIME-REQUEST-INVALID',
          when: 'A parameter is unknown or within is not a string, or the key breaks a bound: a shape or phase outside its closed set, a depth outside 0..2 or a budget outside 0..64, a seat that is neither an identity nor {path}, one the scope does not admit or at runtime placement, a path outside the workspace, or a word the closure does not register.',
          next: "Run the command a refusal of the key names as next: the part's closed set or cap, ia vocabulary for a word, or the position without the seat. Otherwise match the parameters to this operation's schema.",
        },
        SCOPE_UNAVAILABLE,
      ],
      example: { seat: EXAMPLE_IDENTITY, shape: 'governance' },
      mcp: 'ia_position',
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
