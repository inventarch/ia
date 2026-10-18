import type { Mode, PacketCatalogRow } from '@inventarch/runtime';
import { MODE_MOVES } from '@inventarch/runtime';
import type { Arguments, OptionSpec } from './args.js';
import { parseArguments, positionals, UsageError } from './args.js';
import type { CommandSpec } from './commands.js';
interface Row {
  name: string;
  mode: Mode;
  positional?: string;
  options?: readonly OptionSpec[];
  summary: string;
  syntax: string;
}
const value = (name: string, summary: string, required = false): OptionSpec => ({
  name,
  kind: 'value',
  summary,
  required,
});
const actor = value('actor', 'Acting authored participant; existing workspace defaults and mandates apply');
export const KB_COMMANDS: readonly Row[] = [
  {
    name: 'check',
    mode: 'validate',
    summary: 'Check local knowledge bindings and graph integrity',
    syntax: 'ia kb check [--actor <agent>] [--json]',
  },
  {
    name: 'search',
    mode: 'read',
    positional: 'query',
    summary: 'Search selected record and bound document text',
    syntax: 'ia kb search <query> [--limit <count>] [--actor <agent>] [--json]',
    options: [{ ...value('limit', 'Maximum results (1–100)'), integer: { min: 1, max: 100 } }],
  },
  {
    name: 'read',
    mode: 'read',
    positional: 'locator',
    summary: 'Read a selected native identity or fragment with a snapshot citation',
    syntax: 'ia kb read <identity> [--actor <agent>] [--json]',
  },
  {
    name: 'resolve',
    mode: 'read',
    summary: 'Resolve a pinned citation or refuse changed bytes',
    syntax: 'ia kb resolve --citation <json-file> [--actor <agent>] [--json]',
    options: [value('citation', 'Citation JSON path inside the workspace', true)],
  },
  {
    name: 'traverse',
    mode: 'read',
    positional: 'identity',
    summary: 'Follow resolved native edges inside selected knowledge',
    syntax: 'ia kb traverse <identity> [--steps <count>] [--actor <agent>] [--json]',
    options: [{ ...value('steps', 'Maximum edges (1–64)'), integer: { min: 1, max: 64 } }],
  },
  {
    name: 'pack',
    mode: 'validate',
    summary: 'Preview or write explicit knowledge from an exact commit; selection is read from that commit',
    syntax: 'ia kb pack --commit <full-sha> --selection <path> --out <path> [--apply --yes] [--actor <agent>] [--json]',
    options: [
      value('commit', 'Exact full commit hash', true),
      value('selection', 'Selection path read from the requested commit, not the working tree', true),
      value('out', 'New package output path; never overwritten', true),
      { name: 'apply', kind: 'boolean', summary: 'Write the package after validation; requires Execution' },
    ],
  },
];
export function knowledgeCommand(common: readonly OptionSpec[]): CommandSpec {
  return {
    name: 'kb',
    group: 'workspace',
    summary: 'Read and package knowledge from .ia records and bound documents',
    syntax: KB_COMMANDS.map((r) => r.syntax),
    grammar: { options: [...common, actor], positionals: positionals('subcommand', 1, 1) },
  };
}
export function selectKnowledgeCommand(base: CommandSpec, subcommand: string | undefined): CommandSpec | undefined {
  const row = KB_COMMANDS.find((r) => r.name === subcommand);
  if (!row) return undefined;
  return {
    ...base,
    summary: row.summary,
    syntax: [row.syntax],
    grammar: {
      options: [...base.grammar.options, ...(row.options ?? [])],
      positionals: positionals(
        'subcommand' + (row.positional ? ' and ' + row.positional : ''),
        row.positional ? 2 : 1,
        row.positional ? 2 : 1,
      ),
    },
  };
}
/** Used for both initial execution and parsed retry advice. */
export function knowledgeMode(args: Arguments): Mode {
  const row = KB_COMMANDS.find((r) => r.name === args.positionals[0]);
  if (!row) throw new UsageError('Unknown kb subcommand');
  return row.name === 'pack' && args.flag('apply') ? 'effect' : row.mode;
}
export function knowledgeAdviceMode(base: CommandSpec, argv: readonly string[]): Mode | undefined {
  const command = selectKnowledgeCommand(base, argv[0]);
  if (!command) return undefined;
  try {
    return knowledgeMode(parseArguments(argv, command.grammar));
  } catch {
    return undefined;
  }
}
export const knowledgeCatalog = (): readonly PacketCatalogRow[] => [
  ...KB_COMMANDS.map((row) => ({
    command: 'ia kb ' + row.name,
    mode: row.mode,
    move: MODE_MOVES[row.mode],
    refuses: 'unavailable selected knowledge or mandate restriction',
    next: 'ia position',
  })),
  {
    command: 'ia kb pack --apply',
    mode: 'effect',
    move: 'Execution',
    refuses: 'existing output or unavailable selected knowledge',
    next: 'ia position',
  },
];
