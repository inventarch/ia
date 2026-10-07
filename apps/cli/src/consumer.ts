/**
 * The consumer shell: docs/specs/consumer-cli-contract/README.md §§1.2, 3, 4, 5 and 6.
 *
 * Everything here is pure with respect to the process. The host — argv, environment, cwd, both stream
 * descriptions and the package version — arrives as a parameter and the result is returned as text, so a test
 * observes exactly the bytes the entry point writes and §5's `--json` invariant is checkable without a
 * subprocess. Progress is not produced by any verb in this release; §6.6 permits its absence and requires the
 * terminal state line, which every verb prints as text.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { sameFile } from '@inventarch/db';
import { resolveIaHome } from '@inventarch/distribution/ia-home';
import type { ProtocolOperation } from '@inventarch/runtime';
import type { Arguments, Grammar } from './args.js';
import { parseArguments, UsageError } from './args.js';
import type { CommandSpec, Group } from './commands.js';
import {
  COMMANDS,
  COMMON_OPTIONS,
  CORE_TOKENS,
  findCommand,
  LEGACY_OPERATIONS,
  nearestTokens,
  RESERVED_TOKEN,
  SINCE_2_OPERATIONS,
} from './commands.js';
import { runCapture } from './capture.js';
import { runCompile } from './compile.js';
import { runDistribute } from './distribute.js';
import { runDoctor } from './doctor.js';
import { runFormat } from './format.js';
import { runHost } from './host.js';
import { runInit } from './init.js';
import { runInspect } from './inspect.js';
import { describeOperation, renderOperationHelp, SCHEMA_TOKEN } from './operation-help.js';
import { runPack } from './pack.js';
import { runPosition } from './position.js';
import { runRead } from './read.js';
import { runValidate } from './validate.js';
import { runVocabulary } from './vocabulary.js';
import type { Capabilities, Terminal, Token } from './render.js';
import { atom, document, entry, errorBlock, fieldRows, resolveCapabilities, sectionLabel, words } from './render.js';

/**
 * §2.8 rule 3's one question, described rather than performed — the same move `render.ts` makes for the terminal.
 * The reader and the writer arrive from the entry point, so the decision is a pure function of a string and a test
 * observes the exact bytes the question put on the wire. Unlike a rendered result this cannot be returned as text:
 * the prompt has to be written before the answer can be read.
 */
export interface Interaction {
  /** §2.8 rule 3: both stdin and stdout are terminals. A question that cannot be answered is never asked. */
  readonly interactive: boolean;
  /** §5 keeps every prompt off stdout, so the entry point points this at stderr. */
  readonly write: (text: string) => void;
  /** One line of input, or null at EOF, on a closed stdin, or where stdin cannot be read at all. */
  readonly read: () => Promise<string | null>;
}
/** §2.8 rule 3: `y` or `yes`, in any case and ignoring surrounding space. Everything else, EOF included, declines. */
export const consents = (answer: string | null): boolean =>
  answer !== null && ['y', 'yes'].includes(answer.trim().toLowerCase());
/**
 * Shows the change summary, asks once, and reports the answer. What a declined answer means belongs to the caller:
 * §2.8 rule 3 makes declining an answer to the question, not a failure of the command.
 */
export async function confirm(interaction: Interaction, summary: string, question: string): Promise<boolean> {
  interaction.write(summary);
  interaction.write(question);
  return consents(await interaction.read());
}

export interface Host {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: Terminal;
  readonly stderr: Terminal;
  /** §2.8 rule 3: `--apply` may prompt only when a question can actually be asked and answered. */
  readonly interaction: Interaction;
  readonly version: string;
  /** The directory holding `assets/`, so §2.2's catalogue travels with the package rather than the workspace. */
  readonly packageRoot: string;
  readonly signal?: AbortSignal;
  /**
   * Called once, only when §1.2 step 5 has selected a consumer verb. §3 forbids a SIGINT handler on the legacy
   * route's path, so the entry point installs its cleanup here rather than at startup.
   */
  readonly onConsumerRoute?: () => void | (() => void);
}
export interface Result {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface Context {
  readonly host: Host;
  readonly command: CommandSpec;
  readonly args: Arguments;
  readonly caps: Capabilities;
  readonly json: boolean;
}

/**
 * §4: a refusal carries the service's own code unchanged, its exit class, where it happened, and the one next command
 * that moves the user on. `next` is required: a site that has no remedy of its own passes `fallbackNext`.
 */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number,
    readonly where: { readonly path?: string; readonly line?: number; readonly identity?: string } | null,
    readonly next: string,
    /** §6.5 element 1 when there is no `where`: the invocation that was refused, rendered but never serialized. */
    readonly at: string | null = null,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

/**
 * §5's first signal, raised by a verb that had already written when it observed the signal. The JSON result is §5's
 * object with this rerun as its `next`, and the one stderr line gains the same rerun that finishes the work, which
 * M5.2 §5 requires `ia init` to name once it has written anything.
 */
export class Interrupted extends Error {
  constructor(readonly next: string) {
    super('Interrupted.');
    this.name = 'Interrupted';
  }
}

const IA_CODE = /^IA-[A-Z]+-[A-Z-]+$/;
const codeOf = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && IA_CODE.test(code) ? code : undefined;
};
/**
 * The next command for a refusal whose raiser named none: the refused command's own help for a usage error, and
 * otherwise `ia doctor`, which observes the runtime, workspace and installation without changing them. Every
 * fallback wording lives here, so a rule for how next commands are phrased changes in one place.
 */
export const fallbackNext = (code: string, command?: string): string =>
  code === 'IA-CLI-USAGE'
    ? `Run "ia ${command === undefined ? '' : `${command} `}--help" for the arguments it accepts.`
    : 'Run "ia doctor" to check the runtime, workspace and installation.';
/**
 * §4.1: the consumer never rewrites a service's code. Class 4 is unreachable from the three verbs this release
 * implements, because none of them acquires anything over a network, so every unmapped failure is class 3.
 * Whatever was thrown, the refusal returned names a non-empty next command; `command` is the refused verb. A refusal
 * an inner site converted without the verb carries the verbless fallback, which is re-derived here with the verb.
 */
export function refusalOf(error: unknown, command?: string): Refusal {
  if (error instanceof Refusal)
    return typeof error.next === 'string' && error.next.trim() !== '' && error.next !== fallbackNext(error.code)
      ? error
      : new Refusal(error.code, error.message, error.exit, error.where, fallbackNext(error.code, command), error.at);
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError)
    return new Refusal('IA-CLI-USAGE', message, 2, null, fallbackNext('IA-CLI-USAGE', command));
  const code = codeOf(error) ?? 'IA-CLI-FAILED';
  return new Refusal(code, message, 3, null, fallbackNext(code, command));
}

/** §4.3 and §6.5. Human mode renders the block on stderr; `--json` emits the one object on stdout. */
export function renderRefusal(refusal: Refusal, caps: Capabilities, json: boolean): Result {
  const located =
    refusal.where?.path === undefined || refusal.where.path === ''
      ? null
      : refusal.where.line === undefined
        ? refusal.where.path
        : `${refusal.where.path}:${refusal.where.line}`;
  const location = located ?? refusal.at;
  if (json) {
    const body = {
      version: 1,
      ok: false,
      code: refusal.code,
      message: stripFor(refusal.message, refusal.code, located, refusal.where?.identity ?? null),
      exit: refusal.exit,
      where:
        refusal.where === null
          ? null
          : {
              path: refusal.where.path ?? null,
              line: refusal.where.line ?? null,
              identity: refusal.where.identity ?? null,
            },
      next: refusal.next,
    };
    return { exitCode: refusal.exit, stdout: JSON.stringify(body) + '\n', stderr: '' };
  }
  const block = errorBlock(
    {
      location,
      ...(refusal.where?.identity === undefined ? {} : { identity: refusal.where.identity }),
      code: refusal.code,
      message: refusal.message,
      next: words(refusal.next),
    },
    { depth: 0 },
    caps,
  );
  return { exitCode: refusal.exit, stdout: '', stderr: document([block]) };
}
/** §6.5's strip rule applied to the serializer as well as the renderer, so both carry the same message. */
export const stripFor = (message: string, code: string, location: string | null, identity: string | null): string => {
  let text = message;
  for (const prefix of [location, identity, code])
    if (prefix && text.startsWith(prefix + ': ')) text = text.slice(prefix.length + 2);
  return text;
};

const OPTION_ORDER = ['root', 'json', 'no-color', 'ascii', 'yes', 'quiet', 'help'] as const;
export const optionLabel = (name: string, short: string | undefined, placeholder: string | undefined): string =>
  `${short === undefined ? '' : `-${short}, `}--${name}${placeholder === undefined ? '' : ` ${placeholder}`}`;
const optionRows = (grammar: Grammar): readonly { readonly label: string; readonly value: readonly Token[] }[] =>
  grammar.options
    .filter((row) => row.refuse === undefined)
    .map((row) => ({
      label: optionLabel(
        row.name,
        row.short,
        row.kind === 'value'
          ? (row.placeholder ?? (row.values === undefined ? '<value>' : `<${row.values.join('|')}>`))
          : undefined,
      ),
      value: words(row.summary),
    }));

export interface Namespace {
  readonly token: string;
  readonly summary: string;
}
const groupBlock = (group: Group, label: string, caps: Capabilities): readonly string[] => [
  sectionLabel(label, caps),
  ...fieldRows(
    COMMANDS.filter((command) => command.group === group).map((command) => ({
      label: command.name,
      value: words(command.summary),
    })),
    { depth: 1 },
    caps,
  ),
];

/**
 * §1.2 step 1 and §7.1. The nine legacy operations are listed verbatim under their own heading, together with
 * their own usage line, because the consumer help is the only place a reader learns that the machine protocol
 * exists and is unchanged. One row points at each operation's own help (spec-0012 CLI-04). Private namespaces are
 * supplied by the caller so that a tree without them prints a help text that does not mention them.
 */
export function renderHelp(host: Host, caps: Capabilities, namespaces: readonly Namespace[]): string {
  const common = OPTION_ORDER.map((name) => COMMON_OPTIONS.find((row) => row.name === name)!);
  return document([
    entry(
      [[atom('ia', 'bold', 0), atom(`${host.version} — author, capture and distribute .ia records`)]],
      { depth: 0 },
      caps,
    ),
    [sectionLabel('Usage', caps), ...entry([words('ia <command> [options]')], { depth: 1 }, caps)],
    groupBlock('workspace', 'Workspace', caps),
    groupBlock('distribution', 'Distribution', caps),
    [
      sectionLabel('Machine protocol — frozen, JSON in, one JSON line out, no color', caps),
      ...entry([[atom(LEGACY_OPERATIONS.join('  '))]], { depth: 1 }, caps),
      ...entry(
        [[atom('Usage: ia', null, 0), ...words('<operation> [--root <workspace>] [--params <JSON|->]')]],
        { depth: 1 },
        caps,
      ),
      // The operations a later protocol version added, on their own line so the frozen line above stays as it was.
      ...(SINCE_2_OPERATIONS.length === 0
        ? []
        : entry(
            [
              [
                atom('Since v2:', null, 0),
                atom(SINCE_2_OPERATIONS.join('  ')),
                ...words('— the machine route only with --params or --schema'),
              ],
            ],
            { depth: 1 },
            caps,
          )),
      ...fieldRows(
        [
          { label: 'ia <operation> --help', value: words('Parameters, refusals and an example for one operation') },
          ...namespaces.map((namespace) => ({
            label: `ia ${namespace.token} --help`,
            value: words(namespace.summary),
          })),
        ],
        { depth: 1 },
        caps,
      ),
    ],
    [
      sectionLabel('Common options', caps),
      ...fieldRows(
        [
          ...common.map((row) => ({
            label: optionLabel(row.name, row.short, row.kind === 'value' ? row.placeholder : undefined),
            value: words(row.summary),
          })),
          { label: '--version', value: words('Print the version') },
        ],
        { depth: 1 },
        caps,
      ),
    ],
    entry([words('Run "ia <command> --help" for one command\'s full syntax.')], { depth: 0 }, caps),
  ]);
}

/**
 * A command that shares its name with an operation a later protocol version added also names that machine form,
 * which `--params` or `--schema` selects, and where its own help is; the operation's row is the source.
 */
const machineForm = (command: CommandSpec, caps: Capabilities): readonly string[] => {
  const operation = SINCE_2_OPERATIONS.includes(command.name) ? describeOperation(command.name) : undefined;
  if (operation?.since === undefined) return [];
  return [
    sectionLabel(`Machine operation (protocol v${operation.since})`, caps),
    ...entry([[atom(`ia ${command.name} --params <JSON|-> [--root <workspace>]`, null, 0)]], { depth: 1 }, caps),
    ...fieldRows(
      [
        { label: `ia ${command.name} --schema`, value: words('Its parameters as one JSON line') },
        {
          label: `ia ${command.name} --params '{}' --help`,
          value: words('Its parameters, refusals and an example'),
        },
      ],
      { depth: 1 },
      caps,
    ),
  ];
};
export function renderCommandHelp(command: CommandSpec, caps: Capabilities): string {
  return document([
    entry([[atom(`ia ${command.name}`, 'bold', 0), ...words(command.summary, null, 2)]], { depth: 0 }, caps),
    [
      sectionLabel('Usage', caps),
      ...command.syntax.flatMap((line) => entry([[atom(line, null, 0)]], { depth: 1 }, caps)),
    ],
    [sectionLabel('Options', caps), ...fieldRows(optionRows(command.grammar), { depth: 1 }, caps)],
    machineForm(command, caps),
  ]);
}

/**
 * §2.0: walk from cwd toward the filesystem root and take the first directory containing `.ia/src`. Host plugin
 * distribution spec §3: a directory whose `.ia` is the IA home is never a workspace, even if src/ appeared there.
 */
export function discoverRoot(start: string, iaHome?: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    // The IA home by device and inode, so a home spelled in another case or normalization is still recognized (#315).
    if (existsSync(resolve(current, '.ia/src')) && (iaHome === undefined || !sameFile(resolve(current, '.ia'), iaHome)))
      return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
/** The IA home for discovery, or undefined when its variable is malformed; the verb that needs the home refuses then. */
export function iaHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string | undefined {
  try {
    return resolveIaHome(env, home).home;
  } catch {
    return undefined;
  }
}
/**
 * §2.0: the real path of the resolved absolute root, because `workspace()` refuses a relative root and any link on the
 * way to one (`apps/distribution/src/files.ts:51`). A failed discovery is exit 3 with IA-DB-ROOT-INVALID.
 */
export function requireRoot(context: Context): string {
  const supplied = context.args.value('root');
  if (supplied !== undefined) {
    const path = isAbsolute(supplied) ? resolve(supplied) : resolve(context.host.cwd, supplied);
    // §2.5 names IA-DB-ROOT-INVALID for an unavailable root. The distribution `workspace()` guard would refuse a
    // missing directory as IA-DIST-INPUT-INVALID first, and §4.1 forbids rewriting a service's code, so the CLI
    // makes the check itself and the service is never reached with a root it would name differently.
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory())
      throw new Refusal(
        'IA-DB-ROOT-INVALID',
        `Cannot open workspace ${path}: no such directory`,
        3,
        { path },
        'Pass --root <path> with an existing directory.',
      );
    // The root the user chose opens at its real path, as `ia host` resolves it, so a root reached through links (macOS
    // /tmp, a linked checkout) works; every path below it is still checked link by link. The JS `realpathSync`, not
    // `.native`: it keeps each name's case as typed, which the steward guard now folds (`unaliased`, #315). An 8.3
    // short name or a subst drive that the JS form keeps is still an alias to the guard.
    return realpathSync(path);
  }
  const found = discoverRoot(context.host.cwd, iaHomeOf(context.host.env));
  if (found === undefined)
    throw new Refusal(
      'IA-DB-ROOT-INVALID',
      `No .ia/src directory at ${context.host.cwd} or in any parent`,
      3,
      { path: context.host.cwd },
      'Run "ia init" to see what a new workspace would contain, or pass --root <path>.',
    );
  // A discovered root opens at its real path too: Windows keeps a junction's spelling in the cwd, where POSIX getcwd resolves it.
  return realpathSync(found);
}

export const HELP_TOKENS: ReadonlySet<string> = new Set(['--help', '-h']);
/** §2.0: `-h` short-circuits before the rest of the grammar, so a command's own help is never gated on it. */
const wantsHelp = (argv: readonly string[]): boolean => {
  const end = argv.indexOf('--');
  return argv.slice(0, end === -1 ? argv.length : end).some((token) => HELP_TOKENS.has(token));
};

type Handler = (context: Context) => Result | Promise<Result>;
/** The sixteen verbs of §1.2 step 5. A verb with no row here is a defect in this table, not a missing feature. */
const HANDLERS: Readonly<Record<string, Handler>> = {
  init: runInit,
  vocabulary: runVocabulary,
  format: runFormat,
  capture: runCapture,
  compile: runCompile,
  validate: runValidate,
  inspect: runInspect,
  read: runRead,
  position: runPosition,
  pack: runPack,
  install: runDistribute('install'),
  update: runDistribute('update'),
  remove: runDistribute('remove'),
  restore: runDistribute('restore'),
  doctor: runDoctor,
  host: runHost,
};

/** §1.2 step 5. Parse, then run; every class-2 check has already happened when a handler is entered. */
export async function runCommand(command: CommandSpec, argv: readonly string[], host: Host): Promise<Result> {
  const preliminary = resolveCapabilities(host.stdout, {});
  if (wantsHelp(argv)) return { exitCode: 0, stdout: renderCommandHelp(command, preliminary), stderr: '' };
  let caps = preliminary;
  try {
    const args = parseArguments(argv, command.grammar);
    const json = args.flag('json');
    caps = resolveCapabilities(host.stdout, {
      ...(args.flag('color') ? { color: true } : args.flag('no-color') ? { color: false } : {}),
      ...(args.flag('ascii') ? { ascii: true } : {}),
      json,
    });
    // §2.8 rule 3 and §2.1: the confirmation check is part of parsing, so it precedes every class-3 refusal and
    // keeps §3's promise that an exit 2 read nothing and wrote nothing. Both branches refuse the same invocation
    // for the same reason — the question rule 3 specifies cannot be put where the answer could come from.
    if (args.flag('apply') && !args.flag('yes')) {
      if (!host.interaction.interactive) throw new UsageError('--apply without a terminal requires --yes');
      // §5: `--json` stdout is one parseable value with no prompt in it, so a terminal does not make it askable.
      if (json) throw new UsageError('--apply --json requires --yes; a --json run is never asked to confirm');
    }
    const context: Context = { host, command, args, caps, json };
    const handler = HANDLERS[command.name];
    if (handler === undefined)
      throw new Refusal(
        'IA-CLI-FAILED',
        `No handler is installed for ia ${command.name}`,
        3,
        null,
        fallbackNext('IA-CLI-FAILED'),
      );
    host.signal?.throwIfAborted();
    const result = await handler(context);
    host.signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (host.signal?.aborted) {
      // Like every refusal, the one object names the next command: the rerun a verb that had written supplies, or
      // otherwise the interrupted command itself.
      const next =
        error instanceof Interrupted ? error.next : `Run the interrupted "ia ${command.name}" command again.`;
      return {
        exitCode: 130,
        stdout: wantsJson(argv)
          ? JSON.stringify({
              version: 1,
              ok: false,
              code: 'IA-CLI-INTERRUPTED',
              message: 'Interrupted.',
              exit: 130,
              next,
            }) + '\n'
          : '',
        stderr: error instanceof Interrupted ? `Interrupted. ${error.next}\n` : 'Interrupted.\n',
      };
    }
    const raw = refusalOf(error, command.name);
    const refusal =
      raw.where === null && raw.at === null
        ? new Refusal(raw.code, raw.message, raw.exit, null, raw.next, `ia ${command.name}`)
        : raw;
    return renderRefusal(refusal, refusal.exit === 2 ? preliminary : caps, wantsJson(argv));
  }
}
/** A refusal raised before or during parsing still has to honor §5, so `--json` is read from argv directly. */
const wantsJson = (argv: readonly string[]): boolean => {
  const end = argv.indexOf('--');
  return argv.slice(0, end === -1 ? argv.length : end).includes('--json');
};

export interface Extension extends Namespace {
  readonly run: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}
export interface Legacy {
  (args: readonly string[]): { readonly exitCode: number; readonly stdout: string };
}

/**
 * A version-2 operation whose consumer command has not shipped (every shipped one has its command): its help is the
 * operation's own, and any other call is refused with the machine form it has, never "unknown" and never a
 * suggestion of itself.
 */
export function answerMachineOnly(operation: ProtocolOperation, argv: readonly string[], caps: Capabilities): Result {
  const token = operation.name;
  if (argv.slice(1).some((arg) => HELP_TOKENS.has(arg)))
    return { exitCode: 0, stdout: renderOperationHelp(operation), stderr: '' };
  return renderRefusal(
    new Refusal(
      'IA-CLI-USAGE',
      `ia ${token} needs --params or --schema: it has no consumer command yet, only the machine operation`,
      2,
      null,
      `Run "ia ${token} --params '{}'", or "ia ${token} --help" for its parameters.`,
      `ia ${token}`,
    ),
    caps,
    wantsJson(argv),
  );
}

/** The two options that make an invocation of a version-2 operation a machine call. */
const MACHINE_OPTIONS: ReadonlySet<string> = new Set(['--params', SCHEMA_TOKEN]);
/**
 * Whether `argv` asks for the machine route of a version-2 operation: `--params` or `--schema` stands in an option
 * position, the odd positions the machine parser (main.ts) reads options from. Anything else is a consumer call.
 */
export const isMachineInvocation = (argv: readonly string[]): boolean =>
  argv.some((token, index) => index % 2 === 1 && MACHINE_OPTIONS.has(token));

/**
 * §1.2's ordered table. The first match wins and the order is normative: step 4 precedes step 5 unconditionally,
 * so a legacy operation can never be shadowed by a consumer verb. A version-2 operation shares its name with a
 * consumer command and takes the machine route only for a machine invocation, between those two steps. `since2`
 * is that operation list (`SINCE_2_OPERATIONS` unless a test passes another).
 */
export async function dispatch(
  argv: readonly string[],
  host: Host,
  legacy: Legacy,
  extensions: readonly Extension[],
  since2: readonly string[] = SINCE_2_OPERATIONS,
): Promise<Result> {
  const plain = (result: { readonly exitCode: number; readonly stdout: string }): Result => ({ ...result, stderr: '' });
  const token = argv[0];
  const caps = resolveCapabilities(host.stdout, {});
  // §1.2 step 1, which supersedes main.ts:11's usage-exit: no arguments is a request for help, not a syntax
  // error. decisions.md:60 freezes the nine named routes, and a bare invocation is not one of them.
  if (token === undefined || (argv.length === 1 && HELP_TOKENS.has(token)))
    return { exitCode: 0, stdout: renderHelp(host, caps, extensions), stderr: '' };
  if (argv.length === 1 && token === '--version') return { exitCode: 0, stdout: host.version + '\n', stderr: '' };
  // §1.6: an extension never takes a core, legacy or reserved token; such a token falls through to its core route.
  const core = CORE_TOKENS.has(token) || since2.includes(token);
  const extension = core ? undefined : extensions.find((candidate) => candidate.token === token);
  if (extension !== undefined) return plain(await extension.run(argv.slice(1)));
  if ((LEGACY_OPERATIONS as readonly string[]).includes(token)) return plain(legacy(argv));
  if (since2.includes(token) && isMachineInvocation(argv)) return plain(legacy(argv));
  const command = findCommand(token);
  if (command !== undefined) {
    const dispose = host.onConsumerRoute?.();
    try {
      return await runCommand(command, argv.slice(1), host);
    } finally {
      dispose?.();
    }
  }
  const served = since2.includes(token) ? describeOperation(token) : undefined;
  if (served !== undefined) return answerMachineOnly(served, argv, caps);
  if (token === RESERVED_TOKEN)
    return renderRefusal(
      new Refusal(
        'IA-CLI-USAGE',
        `"${RESERVED_TOKEN}" is reserved. Machine operations are invoked directly: ia scope, ia context, ia get.`,
        2,
        null,
        'Run "ia --help" for the machine protocol and the consumer commands.',
        `ia ${RESERVED_TOKEN}`,
      ),
      caps,
      wantsJson(argv),
    );
  const admitted = [
    ...new Set([
      ...COMMANDS.map((entry) => entry.name),
      ...LEGACY_OPERATIONS,
      ...since2,
      ...extensions.map((entry) => entry.token).filter((candidate) => !CORE_TOKENS.has(candidate)),
    ]),
  ];
  const near = nearestTokens(
    token,
    admitted.filter((candidate) => candidate !== token),
  );
  return renderRefusal(
    new Refusal(
      'IA-CLI-USAGE',
      `Unknown command ${token}`,
      2,
      null,
      near.length === 0 ? 'Run "ia --help" for the commands this binary admits.' : `Did you mean ${near.join(', ')}?`,
      `ia ${token}`,
    ),
    caps,
    wantsJson(argv),
  );
}
