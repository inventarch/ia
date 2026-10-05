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
const legacy = () => ({ exitCode: 2, stdout: '' });
const extensions: readonly Extension[] = [];
export const run = (argv: readonly string[], options: HostOptions = {}): Promise<Result> =>
  dispatch(argv, makeHost(options), legacy, extensions);
