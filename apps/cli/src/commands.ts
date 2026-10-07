/**
 * The consumer command table: docs/specs/consumer-cli-contract/README.md §1.2 step 5 and §2.
 *
 * One row per verb, carrying its help text and its whole argument grammar. §1.2's order is a property of this
 * table and of the dispatcher that reads it; nothing else in the binary enumerates a verb or a flag name.
 */
import type { Grammar, OptionSpec, PositionalSpec } from './args.js';
import { none, positionals } from './args.js';

/** §1.2 step 4. The frozen machine routes, in the order `packages/runtime/src/door.ts:103` admits them. */
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
/**
 * The operations machine protocol version 2 adds after the frozen nine, in protocol-table order. Each shares its
 * name with a consumer command, so it takes the machine route only by `isMachineInvocation` (consumer.ts); the
 * frozen nine never need that test.
 */
export const SINCE_2_OPERATIONS: readonly string[] = ['position', 'read'];
/** The whole machine routing table: the frozen nine, then the version-2 operations. It equals the protocol table. */
export const MACHINE_OPERATIONS: readonly string[] = [...LEGACY_OPERATIONS, ...SINCE_2_OPERATIONS];

/** §1.2 step 6. Reserved so a later milestone can take the name without a rename; see §1.5. */
export const RESERVED_TOKEN = 'agent';

export type Group = 'workspace' | 'distribution';
export interface CommandSpec {
  readonly name: string;
  readonly group: Group;
  readonly summary: string;
  /** The syntax lines `ia <command> --help` prints, verbatim from §2. */
  readonly syntax: readonly string[];
  readonly grammar: Grammar;
}

const option = (spec: OptionSpec): OptionSpec => spec;
export const ROOT: OptionSpec = option({
  name: 'root',
  kind: 'value',
  placeholder: '<path>',
  summary: 'Workspace root (default: nearest ancestor with .ia/src)',
});
/** §2.0. Applies to all fifteen verbs; §2.1 refuses `--root` for `init` alone, with its own reason. */
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
 * Registry spec §4 level 1: one registry for every id in the command, whatever its provider. It replaces discovery's
 * per-provider choice, so it cannot stand beside the two sources that replace discovery outright.
 */
const REGISTRY: OptionSpec = option({
  name: 'registry',
  kind: 'value',
  conflicts: ['catalog', 'offline'],
  placeholder: '<url|dir>',
  summary: 'Registry for every id in this command (default: per-provider configuration)',
});

const grammar = (options: readonly OptionSpec[], rest: PositionalSpec = none): Grammar => ({
  options: [...COMMON_OPTIONS, ...options],
  positionals: rest,
});

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    group: 'workspace',
    summary: 'Plan or create a new workspace',
    syntax: [
      'ia init [<directory>] [--id <provider/name>] [--host claude|codex|none] [--apply] [--json] [--yes]',
      'ia init [<directory>] --decline today|forever | --forget-decline [--host claude|codex|none] [--json]',
    ],
    grammar: {
      options: [
        ...COMMON_OPTIONS.filter((entry) => entry.name !== 'root'),
        { ...ROOT, refuse: 'ia init takes its target as <directory>; --root is not accepted for this verb' },
        // M5.1 §2.3: the package id, when the directory name does not normalize to the one wanted.
        option({
          name: 'id',
          kind: 'value',
          placeholder: '<provider/name>',
          summary: 'Package id (default: local/<directory name>)',
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
          conflicts: ['apply', 'id', 'forget-decline'],
          summary: 'Record that this repository should not be initialized',
        }),
        option({
          name: 'forget-decline',
          kind: 'boolean',
          conflicts: ['apply', 'id', 'decline', 'host'],
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
    syntax: ['ia validate [<path>...] [--severity error|warning] [--max-findings <n>] [--json]'],
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
      ],
      positionals('path', 0, Number.POSITIVE_INFINITY),
    ),
  },
  {
    name: 'capture',
    group: 'workspace',
    summary: 'Admit the workspace and keep its current and previous snapshots',
    syntax: ['ia capture [--preview] [--json]'],
    grammar: grammar([
      option({ name: 'preview', kind: 'boolean', summary: 'Report what capture would keep and write nothing' }),
    ]),
  },
  {
    name: 'compile',
    group: 'workspace',
    summary: 'Deprecated alias of capture, removed in 3.0',
    syntax: ['ia compile [--force] [--json]'],
    grammar: grammar([
      option({
        name: 'out',
        kind: 'value',
        placeholder: '<file>',
        summary: 'Refused: capture keeps one store under .ia/work/snapshot/',
      }),
      option({ name: 'stdout', kind: 'boolean', summary: 'Refused: run "ia capture --preview --json" instead' }),
      option({ name: 'force', kind: 'boolean', summary: 'Accepted: capture always replaces its stored snapshot' }),
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
          summary: 'Edge direction (default out); in and both also list typed field references',
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
    name: 'read',
    group: 'workspace',
    summary: 'Print the body behind a locator: a record, a cell, a requirement or a source line',
    syntax: ['ia read <identity>[#<phase>/<Primitive>|#<REQ-ID>] [--json]', 'ia read <path>:<line> [--json]'],
    grammar: grammar([], positionals('locator', 1, 1)),
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
        // §2.0's exception: this verb resolves no root at all, so accepting --root and discarding it would be a
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
    name: 'update',
    group: 'distribution',
    summary: 'Plan or apply a version change for one direct request',
    syntax: [
      'ia update <id> [--to <range>] [--registry <url|dir>] [--catalog <file>]',
      '          [--offline] [--plan-out <file>] [--apply] [--yes] [--json]',
    ],
    grammar: grammar(
      [
        // Registry spec §6.2: without --to the request keeps its range and the newest release in it wins.
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
    // host adapter table (host plugin distribution spec §4), because a positional has no closed value set here; a host
    // outside the table is still usage (exit 2). `--user` is that spec's §7.1 user-level entry point.
    name: 'host',
    group: 'distribution',
    summary: "Plan or apply this workspace's host registration",
    syntax: [
      'ia host <claude|codex|cursor> [--remove] [--context <identity>] [--apply] [--json] [--yes]',
      'ia host claude --user [--remove] [--apply] [--json] [--yes]',
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
      ],
      positionals('host', 1, 1),
    ),
  },
];

/**
 * §1.6: L ∪ C ∪ R and the step 1–2 tokens — every token an extension may never take. The core wins: `dispatch`
 * routes such a token to its core route even when an extension claims it.
 */
export const CORE_TOKENS: ReadonlySet<string> = new Set<string>([
  ...MACHINE_OPERATIONS,
  ...COMMANDS.map((command) => command.name),
  RESERVED_TOKEN,
  '--help',
  '-h',
  '--version',
]);
/** §1.6: the shape of an extension token. */
export const EXTENSION_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

export const commandNames: readonly string[] = COMMANDS.map((command) => command.name);
export const findCommand = (token: string): CommandSpec | undefined =>
  COMMANDS.find((command) => command.name === token);

/**
 * §1.2 step 7's nearest match. Ordinary Levenshtein distance over the tokens the dispatcher admits, capped so a
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
