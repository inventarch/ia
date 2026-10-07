import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dispatch } from '../src/consumer.js';
import type { Extension, Host, Result } from '../src/consumer.js';
import { scratch } from './scratch-fixture.js';
export { cleanup, scratch } from './scratch-fixture.js';

export const repository = resolve(import.meta.dirname, '../../..');
export const cli = resolve(repository, 'apps/cli');
export const FIXTURE = resolve(repository, 'packages/compliance/fixtures/loop');
/** The fixture's one deliberately foreign record; removing it leaves a workspace that admits. */
export const FOREIGN = '.ia/src/systems/agent-system/records/foreign.ia';
/** A record the formatter accepts: an authored instance of an admitted system, not a declaration or a schema. */
export const FORMATTABLE = '.ia/src/systems/governance-system/records/sample-procedure.ia';

/** The descriptor `ia pack` is given in these tests; `fixture/foundation` is packed from the loop fixture itself. */
export const DESCRIPTOR = {
  formatVersion: 1,
  id: 'fixture/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/definition/distribution/foundation-distribution',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  assets: [{ path: 'LICENSE', role: 'license' }],
  source: {
    repository: 'https://fixture.example/source-workspaces/foundation',
    commit: 'a'.repeat(64),
    recipe: 'ustar-v1',
    epoch: 1_700_000_000,
  },
  license: 'UNLICENSED',
  description: 'Consumer CLI example fixture',
};

/** A copy of the committed loop fixture, admitted unless `foreign` keeps its deliberate defect. */
export function workspace(options: { readonly foreign?: boolean } = {}): string {
  const root = resolve(scratch('workspace'), 'workspace');
  cpSync(FIXTURE, root, { recursive: true });
  if (options.foreign !== true) rmSync(resolve(root, FOREIGN));
  return root;
}
/** A workspace plus the LICENSE and descriptor `ia pack` needs to build `fixture/foundation`. */
export function packable(): string {
  const root = workspace();
  writeFileSync(resolve(root, 'LICENSE'), 'Fixture only; no external publication.\n');
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  writeFileSync(resolve(root, '.ia/work/descriptor.json'), JSON.stringify(DESCRIPTOR) + '\n');
  return root;
}
export interface HostOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly interactive?: boolean;
  /** §2.8 rule 3: the lines stdin would hand back, in order. An exhausted script is EOF, which declines. */
  readonly answers?: readonly string[];
  /** Everything the interaction wrote — the change summary, then the question — in the order it was written. */
  readonly prompts?: string[];
}
/**
 * Every host carries an IA_HOST_HOME (the alias for IA_HOME): the caller's, or a fresh scratch directory. `ia host`
 * and `ia init --host` materialize the payload under it, so without one an in-process test would write the real IA
 * home (host plugin distribution spec §3). No test needs the variable absent; one that did would have to opt out here.
 * IA_CONFIG_HOME is supplied the same way, so registry routing (registry spec §4 level 4) reads an empty scratch
 * directory and never the real per-user `registries.json`.
 */
export function makeHost(options: HostOptions = {}): Host {
  const given = options.env ?? {};
  const env = {
    ...given,
    ...(given['IA_HOST_HOME'] === undefined ? { IA_HOST_HOME: scratch('host-home') } : {}),
    ...(given['IA_CONFIG_HOME'] === undefined ? { IA_CONFIG_HOME: scratch('config-home') } : {}),
  };
  const terminal = { env, isTTY: options.isTTY ?? false, columns: options.columns };
  const answers = [...(options.answers ?? [])];
  return {
    cwd: options.cwd ?? repository,
    env,
    stdout: terminal,
    stderr: terminal,
    // The real entry point points `write` at stderr and `read` at one line of stdin; here both are captured, so a
    // test observes the exact bytes the question put on the wire without owning a terminal.
    interaction: {
      interactive: options.interactive ?? false,
      write: (text: string) => {
        options.prompts?.push(text);
      },
      read: () => Promise.resolve(answers.length === 0 ? null : answers.shift()!),
    },
    version: '9.9.9',
    packageRoot: cli,
  };
}
/**
 * Design row 27's programs a next action may name: this binary, the distribution binary it ships with, and repository
 * tooling. An argument with a space is JSON-quoted inside the command (`quote` in render.ts), so it is one argument here
 * too.
 */
const ARGUMENT = String.raw`(?:"(?:[^"\\]|\\.)*"|[^\s"]+)`;
export const COMMAND = new RegExp(String.raw`"((?:ia|ia-distribution|pnpm)(?: ${ARGUMENT})*)"`, 'g');
export const commandsIn = (next: string): readonly string[] => [...next.matchAll(COMMAND)].map((match) => match[1]!);
/** The argv of the first command a next action names, each argument unquoted as a shell hands it over, the program dropped. */
export const nextArgv = (next: string): string[] =>
  [...(commandsIn(next)[0] ?? '').matchAll(new RegExp(ARGUMENT, 'g'))]
    .map((match) => (match[0].startsWith('"') ? (JSON.parse(match[0]) as string) : match[0]))
    .slice(1);
/**
 * Why a next action breaks design row 27, or null when it keeps it: exactly one quoted command, and no option spelled
 * outside it, because an option in prose (`or pass --registry <url|dir>`) offers a second invocation.
 */
export function nextDefect(next: string): string | null {
  const commands = commandsIn(next);
  if (commands.length !== 1) return `names ${commands.length} commands`;
  const prose = next.replace(COMMAND, '').match(/(?<![\w-])--[a-z][\w-]*/g);
  return prose === null ? null : `spells ${prose.join(', ')} outside its command`;
}
/** A refusal's next action, from its `--json` object or its human `→` line, or null for any other result. */
function refusalNext(result: Result): string | null {
  if (result.exitCode === 0) return null;
  const line = result.stdout.trim();
  if (line.startsWith('{') && !line.includes('\n')) {
    let body: { readonly ok?: unknown; readonly next?: unknown };
    try {
      body = JSON.parse(line) as typeof body;
    } catch {
      return null;
    }
    return body.ok === false && typeof body.next === 'string' ? body.next : null;
  }
  return result.stderr.replace(/\s+/g, ' ').split('→ ')[1]?.trim() ?? null;
}

const legacy = () => ({ exitCode: 2, stdout: '' });
const extensions: readonly Extension[] = [];
/**
 * One in-process invocation. Every refusal any suite provokes is held to design row 27 here, so a next action a verb
 * computes at run time is checked wherever a test reaches it, not only where a test asserts its text.
 */
export async function run(argv: readonly string[], options: HostOptions = {}): Promise<Result> {
  const result = await dispatch(argv, makeHost(options), legacy, extensions);
  const next = refusalNext(result),
    defect = next === null ? null : nextDefect(next);
  if (defect !== null)
    throw new Error(`Design row 27: ia ${argv.join(' ')} refused, and its next action ${defect}: ${next}`);
  return result;
}
