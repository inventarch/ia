/**
 * A doctor check's structured fix: docs/specs/consumer-cli-contract/README.md §2.12 and host-plugin-distribution §7.3.
 *
 * A fix is the runnable form of a check's `remedy`: `{program, argv, flow, writesTo}`, or `null` when the remedy is
 * advice. The flow is derived from the parsed form under the grammar of the action it names, never from a hand table,
 * so a later command or check id needs no change here. The display text is always derived from `argv` (`displayFix`),
 * never stored, and it equals the remedy wherever the remedy is a single runnable command.
 */
import type { Arguments, Grammar } from './args.js';
import { parseArguments } from './args.js';
import type { CommandSpec } from './commands.js';
import { COMMANDS, ownedOptions } from './commands.js';
import { quote } from './render.js';

export type Flow = 'preview-apply' | 'preview-flag' | 'confirm' | 'immediate';
export type WritesTo = 'none' | 'repo' | 'user' | 'machine';
/** A remedy as doctor prints it, with its runnable form; `fix` is null when no flow derives for it. */
export interface Remedy {
  readonly remedy: string;
  readonly fix: Fix | null;
}
export interface Fix {
  readonly program: 'ia' | 'external';
  /** For `ia`, the arguments after `ia`; for `external`, `argv[0]` is the executable (`npm`, `pnpm`, `yarn`, `bun`, `git`). */
  readonly argv: readonly string[];
  readonly flow: Flow;
  readonly writesTo: WritesTo;
}

/**
 * The grammar of one action of `spec`: the command's options minus every option another action owns. A command with
 * no actions has one grammar, whatever its positionals; an action the command does not declare has none (`null`).
 */
export function actionGrammar(spec: CommandSpec, action: string | undefined): Grammar | null {
  if (spec.actions === undefined) return spec.grammar;
  if (action === undefined || !Object.hasOwn(spec.actions, action)) return null;
  const owned = ownedOptions(spec);
  return {
    ...spec.grammar,
    options: spec.grammar.options.filter((option) => (owned[option.name] ?? action) === action),
  };
}

interface Parsed {
  readonly spec: CommandSpec;
  readonly grammar: Grammar;
  readonly action: string | undefined;
  readonly args: Arguments;
}
/** The form parsed under its action's grammar; `null` for an unknown command, an unknown action or a usage error. */
function parse(argv: readonly string[], commands: readonly CommandSpec[]): Parsed | null {
  const [name, ...rest] = argv;
  const spec = commands.find((command) => command.name === name);
  if (spec === undefined) return null;
  try {
    // The action is the first positional, read under the command's whole grammar; the form is then parsed again
    // under that action's own, so an option another action owns refuses here as it does at run time.
    const action = spec.actions === undefined ? undefined : parseArguments(rest, spec.grammar).positionals[0];
    const grammar = actionGrammar(spec, action);
    if (grammar === null) return null;
    return { spec, grammar, action, args: parseArguments(rest, grammar) };
  } catch {
    return null;
  }
}
const present = (args: Arguments, name: string): boolean => args.flag(name) || args.value(name) !== undefined;

/**
 * dec-005's rules over the parsed form; the first that holds decides:
 * 1. an option given in the form conflicts with `apply` → confirm;
 * 2. the grammar requires `apply` → confirm;
 * 3. the grammar offers an optional `apply` → preview-apply;
 * 4. the grammar offers `preview` → preview-flag;
 * 5. the action's, then the command's, declared flow;
 * 6. a catalog mode of read or validate → immediate;
 * 7. otherwise none.
 */
export function deriveFlow(argv: readonly string[], commands: readonly CommandSpec[] = COMMANDS): Flow | null {
  const parsed = parse(argv, commands);
  if (parsed === null) return null;
  const { spec, grammar, action, args } = parsed;
  const apply = grammar.options.find((option) => option.name === 'apply');
  const conflictsWithApply = grammar.options.some(
    (option) =>
      option.name !== 'apply' &&
      present(args, option.name) &&
      ((option.conflicts ?? []).includes('apply') || (apply?.conflicts ?? []).includes(option.name)),
  );
  if (conflictsWithApply) return 'confirm';
  if (apply?.required === true) return 'confirm';
  if (apply !== undefined) return 'preview-apply';
  if (grammar.options.some((option) => option.name === 'preview')) return 'preview-flag';
  const declared = (action === undefined ? undefined : spec.actions?.[action]?.flow) ?? spec.flow;
  if (declared !== undefined) return declared;
  if (spec.catalog?.mode === 'read' || spec.catalog?.mode === 'validate') return 'immediate';
  return null;
}

const join = (argv: readonly string[]): string => argv.map(quote).join(' ');
/** The text a fix shows: `ia` and its quoted argv, or the quoted external argv. */
export const displayFix = (fix: Fix): string => (fix.program === 'ia' ? `ia ${join(fix.argv)}` : join(fix.argv));

/**
 * The remedy and fix of one `ia` command. `--root <root>` is appended only when the command requires a root and the
 * form lacks one; the remedy is then that same argv displayed, so the two never differ. A form no flow derives for
 * keeps its remedy and has no fix.
 */
export function iaFix(argv: readonly string[], writesTo: WritesTo, root?: string): Remedy {
  const spec = COMMANDS.find((command) => command.name === argv[0]);
  const needsRoot =
    root !== undefined &&
    spec?.grammar.options.some((option) => option.name === 'root' && option.required === true) === true &&
    !argv.slice(1).some((token) => token === '--root' || token.startsWith('--root='));
  const full = needsRoot ? [...argv, '--root', root] : [...argv];
  const flow = deriveFlow(full);
  const remedy = `ia ${join(full)}`;
  return { remedy, fix: flow === null ? null : { program: 'ia', argv: full, flow, writesTo } };
}

/** An external program's remedy and fix: always confirmed, since the console cannot preview another program. */
export function externalFix(
  argv: readonly string[],
  writesTo: WritesTo,
): { readonly remedy: string; readonly fix: Fix } {
  const fix: Fix = { program: 'external', argv: [...argv], flow: 'confirm', writesTo };
  return { remedy: displayFix(fix), fix };
}

const APPLY = '--apply',
  YES = ['--yes', '-y'];
/**
 * The form the console runs before its confirmation: a preview-apply form without `--apply` and `--yes`, a
 * preview-flag form with `--preview`; `null` for a flow that has no preview.
 */
export function previewArgv(fix: Fix): readonly string[] | null {
  if (fix.program !== 'ia') return null;
  if (fix.flow === 'preview-apply') return fix.argv.filter((token) => token !== APPLY && !YES.includes(token));
  if (fix.flow === 'preview-flag') return fix.argv.includes('--preview') ? [...fix.argv] : [...fix.argv, '--preview'];
  return null;
}

/**
 * The form the console runs after its own confirmation. A form that applies (a preview-apply one, or one that holds
 * `--apply`, as a required apply does) gains `--apply` when it is preview-apply and lacks it, and `--yes` when the
 * grammar has one and the form lacks it: with piped stdio the child refuses `--apply` without `--yes`, and with
 * inherited stdio it would ask a second time. Every other form, and every external one, is returned unchanged.
 */
export function confirmedArgv(fix: Fix): readonly string[] {
  if (fix.program !== 'ia') return fix.argv;
  const parsed = parse(fix.argv, COMMANDS);
  if (parsed === null) return fix.argv;
  const applies = fix.flow === 'preview-apply' || parsed.args.flag('apply');
  if (!applies) return fix.argv;
  const out = [...fix.argv];
  if (fix.flow === 'preview-apply' && !parsed.args.flag('apply')) out.push(APPLY);
  if (parsed.grammar.options.some((option) => option.name === 'yes') && !parsed.args.flag('yes')) out.push('--yes');
  return out;
}
