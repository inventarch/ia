/**
 * The consumer command table: docs/specs/consumer-cli-contract/README.md §1.2 “Dispatch and discovery” and §2 “Commands and arguments”.
 *
 * One row per verb, carrying its help text and its whole argument grammar. The dispatch order is a property of this
 * table and of the dispatcher that reads it; nothing else in the binary enumerates a verb or a flag name.
 */
import type { MODE_MOVES, Mode, PacketCatalogRow } from '@inventarch/runtime';
import type { Grammar, OptionSpec, PositionalSpec } from './args.js';
import { none, positionals } from './args.js';
import { knowledgeCommand, knowledgeCatalog } from './kb-commands.js';

/** The frozen machine routes admitted by `packages/runtime/src/door.ts`; see the contract’s “Exit classes and protocol boundaries”. */
export const LEGACY_OPERATIONS = [
  'scope',
  'context',
  'select',
  'get',
  'records',
  'resolve',
  'search',
  'traverse',
  'report',
] as const;

/** Reserved so a later command can take the name without a rename; see “Dispatch and discovery”. */
export const RESERVED_TOKEN = 'agent';

export type Group = 'workspace' | 'distribution';
/**
 * A command's catalog row without its command: its move is the one MODE_MOVES maps its mode to, so a row whose move is
 * not its mode's fails to typecheck.
 */
export type CatalogTag = {
  readonly [M in Mode]: Omit<PacketCatalogRow, 'command' | 'mode' | 'move'> & {
    readonly mode: M;
    readonly move: (typeof MODE_MOVES)[M];
  };
}[Mode];
export interface CommandSpec {
  readonly name: string;
  readonly group: Group;
  readonly summary: string;
  /** The syntax lines `ia <command> --help` prints; see §2 “Commands and arguments”. */
  readonly syntax: readonly string[];
  readonly grammar: Grammar;
  /**
   * An agent command renders as one row of the position packet's command catalog (runtime R19). `refuses` summarises
   * the command's main refusal and `next` is the one command that refusal names, both as the command's own code builds
   * them.
   */
  readonly catalog?: CatalogTag;
}

const option = (spec: OptionSpec): OptionSpec => spec;
export const ROOT: OptionSpec = option({
  name: 'root',
  kind: 'value',
  placeholder: '<path>',
  summary: 'Workspace root (default: nearest ancestor with .ia/src)',
});
/** §2.0. Shared consumer options; `init` (§2.1) and `vocabulary` (§2.2) refuse `--root`, each with its own reason. */
export const COMMON_OPTIONS: readonly OptionSpec[] = [
  ROOT,
  option({ name: 'json', kind: 'boolean', summary: 'One JSON value on stdout; no color, progress or prompts' }),
  option({ name: 'color', kind: 'boolean', conflicts: ['no-color'], summary: 'Force ANSI styling' }),
  option({ name: 'no-color', kind: 'boolean', summary: 'Disable ANSI styling; NO_COLOR is also honored' }),
  option({ name: 'ascii', kind: 'boolean', summary: 'ASCII status symbols instead of Unicode' }),
  option({ name: 'quiet', kind: 'boolean', short: 'q', summary: 'Suppress progress on stderr' }),
  option({ name: 'yes', kind: 'boolean', short: 'y', summary: 'Assume yes; required for --apply without a terminal' }),
  option({ name: 'help', kind: 'boolean', short: 'h', summary: 'Show help for the binary or for one command' }),
];

/**
 * Registry spec §4 “Selection and doctor”: one registry for every id in the command, whatever its provider. It replaces discovery's
 * per-provider choice, so it cannot stand beside the two sources that replace discovery outright.
 */
const REGISTRY: OptionSpec = option({
  name: 'registry',
  kind: 'value',
  conflicts: ['catalog', 'offline'],
  placeholder: '<url|dir>',
  summary: 'Registry for every id in this command (default: per-provider configuration)',
});

/**
 * The acting participant of a mandate-gated command (profile.ts), a local declaration rather than authentication. Every
 * gated command takes it; `ia position` is never gated.
 */
const ACTOR: OptionSpec = option({
  name: 'actor',
  kind: 'value',
  placeholder: '<agent>',
  summary:
    "The acting participant, an authored @agent of the workspace's mandates (default: its steward, or its one participant)",
});
/** `ia preview`'s and `ia author`'s forms: the parser takes one value per option, so these are mode flags. */
const EDIT_OPTIONS: readonly OptionSpec[] = [
  option({
    name: 'relate',
    kind: 'boolean',
    conflicts: ['set', 'at'],
    summary: 'Add one relationship row <spelling> <target> to the owned record',
  }),
  option({
    name: 'set',
    kind: 'boolean',
    conflicts: ['at'],
    summary: 'Set one field of the owned record; += adds one item to a list field',
  }),
  option({
    name: 'at',
    kind: 'value',
    placeholder: '<path>',
    summary: 'File for a new record, under an authored root in .ia/src (default <first authored root>/<word>.ia)',
  }),
];

const grammar = (options: readonly OptionSpec[], rest: PositionalSpec = none): Grammar => ({
  options: [...COMMON_OPTIONS, ...options],
  positionals: rest,
});

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    group: 'workspace',
    summary: 'Plan or create a new workspace',
    // conflictRefusal (init.ts): the plan, which lists every conflict.
    catalog: {
      mode: 'effect',
      move: 'Execution',
      refuses: 'a target already initialized; --apply writes nothing',
      next: 'ia position --root <directory>',
    },
    syntax: [
      'ia init [<directory>] [--id <provider/name>] [--system] [--host claude|codex|none]',
      '        [--apply] [--json] [--yes]',
      'ia init [<directory>] --from <plugin-directory> [--id <provider/name>] [--apply] [--json] [--yes]',
      'ia init [<directory>] --migrate [--system] [--apply] [--json] [--yes]',
      'ia init [<directory>] --decline today|forever [--host claude|codex|none] [--json]',
      'ia init [<directory>] --forget-decline [--json]',
    ],
    grammar: {
      options: [
        ...COMMON_OPTIONS.filter((entry) => entry.name !== 'root'),
        { ...ROOT, refuse: 'ia init takes its target as <directory>; --root is not accepted for this verb' },
        REGISTRY,
        option({
          name: 'adopt',
          kind: 'value',
          conflicts: ['migrate', 'decline', 'forget-decline'],
          placeholder: '<id>[@version]',
          summary: 'Mount a source-only registry workspace at band 50',
        }),
        // Workspace initialization §2 “Inputs”: the package id, when the directory name does not normalize to the one wanted.
        option({
          name: 'id',
          kind: 'value',
          placeholder: '<provider/name>',
          summary: 'Package id (default: local/<directory name>)',
        }),
        // A repository that will own vocabulary opts in; the default starter authors no local system.
        option({
          name: 'system',
          kind: 'boolean',
          summary: 'Also author a local @system, its steward and a @distribution, so ia pack can release it',
        }),
        option({
          name: 'from',
          kind: 'value',
          placeholder: '<plugin-directory>',
          summary:
            'Lower a Claude, Codex or Grok plugin into the new workspace as a kit; the kit supplies its own system',
          conflicts: ['migrate', 'adopt', 'system', 'decline', 'forget-decline'],
        }),
        // The workspace's own name, and the hosts it already registered, are the ones the migration keeps, so neither
        // --id nor --host applies.
        option({
          name: 'migrate',
          kind: 'boolean',
          conflicts: ['id', 'host', 'decline', 'forget-decline'],
          summary: 'Rewrite a 1.1.0 starter workspace into the three starter records',
        }),
        // Host registration spec §4 "init --host": with --apply, `ia host <host> --apply` runs after initialization.
        option({
          name: 'host',
          kind: 'value',
          values: ['claude', 'codex', 'none'],
          summary: 'Host to register after initialization',
        }),
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan instead of previewing it' }),
        // Host plugin distribution spec §7.2: record the user's answer in the IA home; never writes the repository.
        option({
          name: 'decline',
          kind: 'value',
          values: ['today', 'forever'],
          conflicts: ['apply', 'id', 'system', 'forget-decline'],
          summary: 'Record that this repository should not be initialized',
        }),
        option({
          name: 'forget-decline',
          kind: 'boolean',
          conflicts: ['apply', 'id', 'system', 'decline', 'host'],
          summary: 'Remove a recorded decline for this repository',
        }),
      ],
      positionals: positionals('directory', 0, 1),
    },
  },
  {
    name: 'validate',
    group: 'workspace',
    summary: 'Check records against the language and declared contracts',
    // requireRoot (consumer.ts): findings are a verdict, not a refusal; a root to validate is the one refusal.
    catalog: {
      mode: 'validate',
      move: 'Verification',
      refuses: 'no .ia/src directory at the root or in any parent',
      next: 'ia init',
    },
    syntax: [
      'ia validate [<path>...] [--severity error|warning] [--max-findings <n>] [--verify-conformance [--require-verified]] [--actor <agent>] [--json]',
    ],
    grammar: grammar(
      [
        option({ name: 'severity', kind: 'value', values: ['error', 'warning'], summary: 'Lowest severity to report' }),
        option({
          name: 'max-findings',
          kind: 'value',
          integer: { min: 1 },
          placeholder: '<n>',
          summary: 'Findings to render (default 50)',
        }),
        option({
          name: 'verify-conformance',
          kind: 'boolean',
          summary: 'Verify COMP-KERNEL and COMP-FIXTURES in-process (package-v1 profile)',
        }),
        option({
          name: 'require-verified',
          kind: 'boolean',
          summary: 'With --verify-conformance: exit 1 unless COMP-KERNEL and COMP-FIXTURES are verified passes',
        }),
        ACTOR,
      ],
      positionals('path', 0, Number.POSITIVE_INFINITY),
    ),
  },
  {
    // The read-only half of record authoring. The parser takes one value per option, so --relate and --set are mode
    // flags followed by positionals.
    name: 'preview',
    group: 'workspace',
    summary: 'Show what one new record, field or relationship would compile to',
    // requireProfile (profile.ts): a mode the governing mandates do not allow names their governance position.
    catalog: {
      mode: 'validate',
      move: 'Verification',
      // The refusal its next command answers; the others are in apps/cli/SPEC.md.
      refuses: 'a move or a word the governing mandates do not allow; writes nothing',
      next: 'ia position --seat <mandate> --shape governance',
    },
    syntax: [
      'ia preview <word> [<name> [<field>=<value>...] [--at <path>]] [--actor <agent>] [--json]',
      'ia preview --relate <owned> <spelling> <target> [--actor <agent>] [--json]',
      'ia preview --set <owned> <section.key>=<value> [--actor <agent>] [--json]',
      'ia preview --set <owned> <section.key>+=<item> [--actor <agent>] [--json]',
    ],
    grammar: grammar([...EDIT_OPTIONS, ACTOR], positionals('argument', 1, Number.POSITIVE_INFINITY)),
  },
  {
    // The writing half of record authoring. Each form is the preview form of the same target, bound to the digest that
    // preview printed.
    name: 'author',
    group: 'workspace',
    summary: 'Write one new record, field or relationship that ia preview showed',
    // runAuthor (author.ts): a file changed since its preview names the preview again.
    catalog: {
      mode: 'author',
      move: 'Synthesis',
      // The refusal its next command answers; the others are in apps/cli/SPEC.md.
      refuses: 'a --digest that no longer names the target file; writes nothing',
      next: 'ia preview <the same form>',
    },
    syntax: [
      'ia author <word> <name> [<field>=<value>...] [--at <path>] --digest <sha256> [--actor <agent>] [--json]',
      'ia author --relate <owned> <spelling> <target> --digest <sha256> [--actor <agent>] [--json]',
      'ia author --set <owned> <section.key>=<value> --digest <sha256> [--actor <agent>] [--json]',
      'ia author --set <owned> <section.key>+=<item> --digest <sha256> [--actor <agent>] [--json]',
    ],
    grammar: grammar(
      [
        ...EDIT_OPTIONS,
        option({
          name: 'digest',
          kind: 'value',
          placeholder: '<sha256>',
          summary: "The target file's sha256 that ia preview printed for the same form (required)",
        }),
        ACTOR,
      ],
      positionals('argument', 1, Number.POSITIVE_INFINITY),
    ),
  },
  {
    // SPEC `capture`: the capture effect. It takes no output option, because a snapshot has one place.
    name: 'capture',
    group: 'workspace',
    summary: 'Admit the workspace and write its current and previous snapshot',
    // captureRefusal (capture.ts): this row names the uninitialized, error-free branch only.
    // An initialized root with missing authored source instead restores that source, then inspects its position.
    catalog: {
      mode: 'effect',
      move: 'Execution',
      refuses: 'an uninitialized root with no authored @workspace and no source errors; nothing is written',
      next: 'ia init <directory>',
    },
    syntax: ['ia capture [--preview] [--actor <agent>] [--json]'],
    // Capture writes by default, so its preview is a flag.
    grammar: grammar([
      option({ name: 'preview', kind: 'boolean', summary: 'Report what the capture would write; write nothing' }),
      ACTOR,
    ]),
  },
  {
    name: 'format',
    group: 'workspace',
    summary: 'Check or rewrite record formatting',
    syntax: ['ia format [<path>...] [--check | --write] [--json]'],
    grammar: grammar(
      [
        option({
          name: 'check',
          kind: 'boolean',
          conflicts: ['write'],
          summary: 'Report differing files and write nothing',
        }),
        option({ name: 'write', kind: 'boolean', summary: 'Rewrite differing files in place' }),
      ],
      positionals('path', 0, Number.POSITIVE_INFINITY),
    ),
  },
  {
    name: 'inspect',
    group: 'workspace',
    summary: 'Show an admitted record, its edges, or a workspace overview',
    syntax: ['ia inspect [<identity>] [--path <file>] [--edges in|out|both] [--depth <n>] [--json]'],
    grammar: grammar(
      [
        option({
          name: 'path',
          kind: 'value',
          excludesPositionals: true,
          placeholder: '<file>',
          summary: 'Record source file, relative to --root',
        }),
        option({
          name: 'edges',
          kind: 'value',
          values: ['in', 'out', 'both'],
          summary: 'Edge and typed field reference direction (default out)',
        }),
        option({
          name: 'depth',
          kind: 'value',
          integer: { min: 0, max: 3 },
          placeholder: '<n>',
          summary: 'Traversal depth 0-3 (default 1)',
        }),
      ],
      positionals('identity', 0, 1),
    ),
  },
  {
    // SPEC `read`: the body reader. A body is never structure, which stays in
    // `ia inspect`, and never a certification.
    name: 'read',
    group: 'workspace',
    summary: 'Print the body behind a locator, with its digest',
    // readNext (read.ts): IA-RUNTIME-READ-UNADMITTED names the overview of what the workspace admits.
    catalog: { mode: 'read', move: 'Observation', refuses: 'a locator no admitted record answers', next: 'ia inspect' },
    syntax: [
      'ia read <identity>[#<phase>/<Primitive> | #<REQ-ID>] [--include-runtime] [--actor <agent>] [--json]',
      'ia read <path>:<line> [--include-runtime] [--actor <agent>] [--json]',
    ],
    grammar: grammar(
      [
        option({
          name: 'include-runtime',
          kind: 'boolean',
          summary: 'Also read a record at runtime placement (band 0)',
        }),
        ACTOR,
      ],
      positionals('locator', 1, 1),
    ),
  },
  {
    // SPEC `position` (runtime R14 to R17): body(K) for a scope key, with its digest and host note,
    // the consumer verb beside the frozen `ia scope` route. It is the Door's `position` operation (MACHINE_PROTOCOL
    // version 2) as a consumer verb, never a machine route. The key's closed sets and caps are the runtime's, which
    // refuses a value outside them naming the call to run instead, so no option here declares them.
    name: 'position',
    group: 'workspace',
    summary: 'Show the position body for a scope key and its host note',
    // positionNext (position.ts): the position of the repository's workspace, K0.
    catalog: {
      mode: 'read',
      move: 'Observation',
      refuses: 'a seat the workspace does not admit, or a path outside it',
      next: 'ia position',
    },
    syntax: [
      'ia position [--seat <id|path>] [--shape <H>] [--phase <P>] [--depth <d>]',
      '            [--budget <n>] [--word <w>] [--primitive <primitive>] [--json]',
    ],
    grammar: grammar([
      option({
        name: 'seat',
        kind: 'value',
        placeholder: '<id|path>',
        summary:
          "A record identity, or a workspace path, ./ first for one spelled as an identity (default: the repository's @workspace)",
      }),
      option({
        name: 'shape',
        kind: 'value',
        placeholder: '<H>',
        summary: 'context, governance, execution, sequence or learning (default context)',
      }),
      option({
        name: 'phase',
        kind: 'value',
        placeholder: '<P>',
        summary: 'orient, plan, act or learn (default: the anchor of the selected primitive)',
      }),
      option({
        name: 'primitive',
        kind: 'value',
        placeholder: '<primitive>',
        summary: 'Memory, Attention, Inference, Decision, Escalation or Learning (default: derived from shape)',
      }),
      option({
        name: 'depth',
        kind: 'value',
        placeholder: '<d>',
        summary: "Hops along the shape's predicates, 0-2 (default 1; 0 when no part is named)",
      }),
      option({
        name: 'budget',
        kind: 'value',
        placeholder: '<n>',
        summary: 'Records loaded beyond the seat, 0-64 (default 16; 0 when no part is named)',
      }),
      option({
        name: 'word',
        kind: 'value',
        placeholder: '<w>',
        summary:
          'Load, point at and tally only records of this word; rules, applies-by-word entries, cells and mandates of any word are kept',
      }),
    ]),
  },
  {
    // SPEC `next` (runtime R18): the delivery view, computed per read and never
    // stored. It is the Door's `next` operation (MACHINE_PROTOCOL version 2) as a consumer verb, never a machine route.
    name: 'next',
    group: 'workspace',
    summary: "Show a plan's tasks in delivery order with verdict and basis",
    // nextAfter (next.ts): IA-RUNTIME-NEXT-AMBIGUOUS names the first plan the message lists as the seat.
    catalog: {
      mode: 'read',
      move: 'Observation',
      refuses: 'no --seat while the workspace authors several @plan records, which the message lists',
      next: 'ia next --seat <plan>',
    },
    syntax: ['ia next [--seat <plan|milestone|task>] [--actor <agent>] [--json]'],
    grammar: grammar([
      option({
        name: 'seat',
        kind: 'value',
        placeholder: '<plan|milestone|task>',
        // The help IA-RUNTIME-NEXT-NO-PLAN names says which records make a plan the view can read.
        summary:
          'A @plan, @milestone or @task identity (default: the only @plan authored, with @milestone records that name it in work.plan and @task records that name those in work.milestone)',
      }),
      ACTOR,
    ]),
  },
  {
    // SPEC `project` (runtime R19 and R20): the workspace projection alone, the plan and apply of `ia host`'s
    // projection element. The host is a positional the handler checks against the packet's two adapters, so any other
    // host is still usage (exit 2).
    name: 'project',
    group: 'workspace',
    summary: "Plan or apply the position packet's files for one host",
    // conflictRefusal (project.ts): the plan names the file in the way, and the apply refuses it.
    catalog: {
      mode: 'effect',
      move: 'Execution',
      refuses: 'a file without the generated marker at a path it writes, which its plan names; --apply writes nothing',
      next: 'ia project <host>',
    },
    syntax: [
      'ia project <claude|codex> [--apply] [--actor <agent>] [--json] [--yes]',
      'ia project <claude|codex> --product plugin --out <directory> [--apply] [--json] [--yes]',
      'ia project <claude|codex> --product plugin --check [--compare <plugin-directory>] [--json]',
    ],
    grammar: grammar(
      [
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan rather than previewing it' }),
        ACTOR,
        option({
          name: 'product',
          kind: 'value',
          values: ['plugin'],
          placeholder: 'plugin',
          summary:
            'Render the host plugin a lowered workspace describes instead of the workspace projection; one plugin carries every host listed in product.hosts, and the host named must be claude or codex',
        }),
        option({
          name: 'out',
          kind: 'value',
          placeholder: '<directory>',
          summary: 'With --product plugin: the absent or empty directory to write',
          conflicts: ['check'],
        }),
        option({
          name: 'check',
          kind: 'boolean',
          summary: 'With --product plugin: render in memory, lower again and compare; writes nothing',
          conflicts: ['out', 'apply'],
        }),
        option({
          name: 'compare',
          kind: 'value',
          placeholder: '<plugin-directory>',
          summary: 'With --product plugin --check only: also compare against the original plugin directory',
        }),
      ],
      positionals('host', 1, 1),
    ),
  },
  {
    name: 'vocabulary',
    group: 'workspace',
    summary: 'Look up the public words, their schemas and fields',
    syntax: [
      'ia vocabulary [<word>] [--domain <owner>]... [--kind <kind>]... [--search <text>]',
      '              [--schema] [--example] [--json]',
    ],
    grammar: {
      options: [
        ...COMMON_OPTIONS.filter((entry) => entry.name !== 'root'),
        // §2.2's exception: this verb resolves no root at all, so accepting --root and discarding it would be a
        // flag that does nothing. It refuses with the reason instead.
        {
          ...ROOT,
          refuse: 'ia vocabulary reads the catalogue shipped with the package; --root is not accepted for this verb',
        },
        option({
          name: 'domain',
          kind: 'value',
          repeatable: true,
          placeholder: '<owner>',
          summary: 'Owning system; repeatable, union',
        }),
        option({
          name: 'kind',
          kind: 'value',
          repeatable: true,
          placeholder: '<kind>',
          summary: 'Record kind; repeatable, union',
        }),
        option({
          name: 'search',
          kind: 'value',
          placeholder: '<text>',
          summary: 'Case-insensitive substring of word or description',
        }),
        option({
          name: 'schema',
          kind: 'boolean',
          needsPositional: true,
          summary: 'Show sections, fields and edges for the word',
        }),
        option({
          name: 'example',
          kind: 'boolean',
          needsPositional: true,
          summary: 'Show a shipped worked example, when one exists',
        }),
      ],
      positionals: positionals('word', 0, 1),
    },
  },
  {
    name: 'pack',
    group: 'distribution',
    summary: 'Build a digest-named distribution archive',
    syntax: ['ia pack --descriptor <file> [--out <dir>] [--force] [--json]'],
    grammar: grammar([
      option({
        name: 'descriptor',
        kind: 'value',
        required: true,
        placeholder: '<file>',
        summary: 'Release descriptor, relative to --root',
      }),
      option({
        name: 'out',
        kind: 'value',
        placeholder: '<dir>',
        summary: 'Output directory (default <root>/.ia/work/dist)',
      }),
      option({ name: 'force', kind: 'boolean', summary: 'Overwrite an existing archive' }),
    ]),
  },
  {
    name: 'install',
    group: 'distribution',
    summary: 'Plan or apply an installation of distributions',
    syntax: [
      'ia install <id>[@<range>]... [--requests <file>] [--registry <url|dir>]',
      '           [--catalog <file>] [--offline] [--plan-out <file>]',
      '           [--apply] [--yes] [--json]',
    ],
    grammar: grammar(
      [
        option({
          name: 'requests',
          kind: 'value',
          excludesPositionals: true,
          placeholder: '<file>',
          summary: 'Request set file, relative to --root',
        }),
        REGISTRY,
        option({
          name: 'catalog',
          kind: 'value',
          placeholder: '<file>',
          summary: 'Release catalog file, relative to --root',
        }),
        option({ name: 'offline', kind: 'boolean', summary: 'Use only the local cache' }),
        option({
          name: 'plan-out',
          kind: 'value',
          placeholder: '<file>',
          summary: 'New plan file under <root>/.ia/work/',
        }),
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan rather than previewing it' }),
      ],
      positionals('id', 0, Number.POSITIVE_INFINITY),
    ),
  },
  {
    name: 'adopt',
    group: 'distribution',
    summary: 'Plan or apply a source-only workspace adoption',
    syntax: ['ia adopt <id>[@version] [--registry <url|dir>] [--apply] [--yes] [--json]'],
    grammar: grammar(
      [
        REGISTRY,
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the adoption and refresh packet projections' }),
      ],
      positionals('id', 1, 1),
    ),
  },
  {
    name: 'update',
    group: 'distribution',
    summary: 'Plan or apply a version change for one direct request',
    syntax: [
      'ia update <id> [--to <range>] [--registry <url|dir>] [--catalog <file>]',
      '          [--offline] [--plan-out <file>] [--apply] [--yes] [--json]',
    ],
    grammar: grammar(
      [
        // Registry spec §6 “Consumer operations”: without --to the request keeps its range and the newest release in it wins.
        option({
          name: 'to',
          kind: 'value',
          placeholder: '<range>',
          summary: 'Replacement version range (default: the existing range)',
        }),
        REGISTRY,
        option({
          name: 'catalog',
          kind: 'value',
          placeholder: '<file>',
          summary: 'Release catalog file, relative to --root',
        }),
        option({ name: 'offline', kind: 'boolean', summary: 'Use only the local cache' }),
        option({
          name: 'plan-out',
          kind: 'value',
          placeholder: '<file>',
          summary: 'New plan file under <root>/.ia/work/',
        }),
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan rather than previewing it' }),
      ],
      positionals('id', 1, 1),
    ),
  },
  {
    name: 'remove',
    group: 'distribution',
    summary: 'Plan or apply the removal of one direct request',
    syntax: ['ia remove <id> [--plan-out <file>] [--apply] [--yes] [--json]'],
    grammar: grammar(
      [
        option({
          name: 'plan-out',
          kind: 'value',
          placeholder: '<file>',
          summary: 'New plan file under <root>/.ia/work/',
        }),
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan rather than previewing it' }),
      ],
      positionals('id', 1, 1),
    ),
  },
  {
    name: 'restore',
    group: 'distribution',
    summary: 'Reinstall the locked generation from its pinned archives',
    syntax: [
      'ia restore [--registry <url|dir> | --offline | --catalog <file>]',
      '           [--allow-withdrawn] --apply [--yes] [--json]',
    ],
    grammar: grammar([
      REGISTRY,
      option({
        name: 'catalog',
        kind: 'value',
        conflicts: ['offline'],
        placeholder: '<file>',
        summary: 'Release catalog file, relative to --root',
      }),
      option({ name: 'offline', kind: 'boolean', summary: 'Use only the local cache' }),
      option({ name: 'allow-withdrawn', kind: 'boolean', summary: 'Accept a withdrawn release' }),
      option({ name: 'apply', kind: 'boolean', required: true, summary: 'Required; restore has no preview yet' }),
    ]),
  },
  {
    name: 'recover',
    group: 'distribution',
    summary: 'Recover an interrupted installation or host transaction',
    syntax: ['ia recover [installation|host|guard|lifecycle] --root <directory> [--json]'],
    grammar: {
      options: COMMON_OPTIONS.map((entry) =>
        entry.name === 'root'
          ? { ...entry, required: true, summary: 'Required existing directory whose transaction is to be recovered' }
          : entry,
      ),
      positionals: positionals('recovery', 0, 1),
    },
  },
  {
    name: 'doctor',
    group: 'distribution',
    summary: 'Report runtime, workspace and installation state',
    // Host plugin distribution spec §7.3: --host adds the §8.2 session briefing and next actions for that host.
    syntax: ['ia doctor [--host claude|codex|cursor] [--json]'],
    grammar: grammar([
      option({
        name: 'host',
        kind: 'value',
        values: ['claude', 'codex', 'cursor'],
        summary: 'Add the session briefing and next actions for this host',
      }),
    ]),
  },
  {
    // docs/specs/host-registration/README.md §4. The host is a positional the handler checks against the
    // host adapter table (apps/distribution/src/hosts.ts), because a positional has no closed value set here; a host
    // outside the table is still usage (exit 2). `--user` is the host plugin distribution contract’s §7.1 user-level entry point.
    name: 'host',
    group: 'distribution',
    summary: "Plan or apply this workspace's host registration",
    syntax: [
      'ia host <claude|codex|cursor> [--remove] [--context <identity>] [--apply] [--actor <agent>] [--json] [--yes]',
      'ia host claude --user [--local] [--remove] [--apply] [--json] [--yes]',
      'ia host <claude|codex|copilot> --commit [--kits-package-version <version>] [--remove] [--apply] [--actor <agent>] [--json] [--yes]',
    ],
    grammar: grammar(
      [
        option({
          name: 'user',
          kind: 'boolean',
          conflicts: ['context'],
          summary: 'Claude only: user-level plugin; needs no workspace',
        }),
        option({
          name: 'local',
          kind: 'boolean',
          conflicts: ['context', 'commit'],
          summary:
            'With --user: render the plugin into the IA home instead of installing it from inventarch/marketplace',
        }),
        option({
          name: 'commit',
          kind: 'boolean',
          conflicts: ['user', 'context'],
          summary:
            'Write the committable bootstrap: the IA instruction block, the published door entry with the default kits package, and its lock entry',
        }),
        option({
          name: 'kits-package-version',
          kind: 'value',
          placeholder: '<version>',
          conflicts: ['user', 'context', 'remove'],
          summary:
            'With --commit: the exact @inventarch/public-kits version to pin (default: the pinned one, else latest)',
        }),
        option({
          name: 'remove',
          kind: 'boolean',
          conflicts: ['context'],
          summary: 'Plan removal of the owned host set',
        }),
        option({
          name: 'context',
          kind: 'value',
          placeholder: '<identity>',
          summary: 'Claude only: select the lifecycle context element',
        }),
        option({ name: 'apply', kind: 'boolean', summary: 'Apply the plan rather than previewing it' }),
        // A workspace apply is gated as an effect; a removal and the user-level plugin are not.
        { ...ACTOR, conflicts: ['user', 'remove'] },
      ],
      positionals('host', 1, 1),
    ),
  },
  knowledgeCommand(COMMON_OPTIONS),
];

/**
 * “Dispatch and discovery”: legacy, consumer, reserved and entry tokens — every token an extension may never take. The core wins: `dispatch`
 * routes such a token to its core route even when an extension claims it.
 */
export const CORE_TOKENS: ReadonlySet<string> = new Set<string>([
  ...LEGACY_OPERATIONS,
  ...COMMANDS.map((command) => command.name),
  RESERVED_TOKEN,
  // Removed in 3.0; extensions must not revive this command.
  'compile',
  '--help',
  '-h',
  '--version',
]);
/** “Dispatch and discovery”: the shape of an extension token. */
export const EXTENSION_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

export const commandNames: readonly string[] = COMMANDS.map((command) => command.name);
/**
 * The position packet's command catalog, the rows tagged `catalog`, in table order, which the CLI passes to the
 * runtime's `renderPacket` as data, so the runtime imports nothing from this app.
 */
export const packetCatalog = (commands: readonly CommandSpec[] = COMMANDS): readonly PacketCatalogRow[] =>
  commands.flatMap((command) =>
    command.name === 'kb'
      ? knowledgeCatalog()
      : command.catalog === undefined
        ? []
        : [{ command: `ia ${command.name}`, ...command.catalog }],
  );
export const findCommand = (token: string): CommandSpec | undefined =>
  COMMANDS.find((command) => command.name === token);

/**
 * “Dispatch and discovery”: suggest a nearest match. Ordinary Levenshtein distance over the tokens the dispatcher admits, capped so a
 * wholly unrelated word gets no suggestion rather than a misleading one.
 */
export function nearestTokens(token: string, admitted: readonly string[], limit = 3): readonly string[] {
  const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1)
        current.push(
          Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)),
        );
      previous = current;
    }
    return previous[b.length]!;
  };
  const scored = admitted
    .map((candidate) => ({ candidate, score: distance(token.toLowerCase(), candidate) }))
    .filter((row) => row.score <= Math.max(2, Math.floor(row.candidate.length / 3)))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((row) => row.candidate);
}
