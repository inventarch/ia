/**
 * Doctor reports over fixed inputs for the structured-fix tests: one runtime, one npm channel, one clock, and a scratch
 * IA home, so every row but the paths and digests is the same on every run. `normalized` replaces those with
 * placeholders, so a report can be compared by value with one captured earlier.
 */
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import type { Channel } from '../src/channel.js';
import type { DoctorView } from '../src/doctor.js';
import { collectDoctor, doctorEnvelope } from '../src/doctor.js';
import { cli, commandRoot, FIXTURE, FOREIGN, run, scratch } from './workspace-fixture.js';

export const VERSION = '3.5.1';
const RUNTIME = { version: 'v22.22.0', platform: 'linux', arch: 'x64' } as const;
const CHANNEL: Channel = { kind: 'npm', name: '@inventarch/cli', version: VERSION };
const NOW = new Date('2026-11-03T12:00:00Z');
const RECEIPT = '.ia/distributions/hosts/claude-receipt.json';

export interface Fixture {
  /** The directory doctor was asked about, as given. */
  readonly root: string;
  /** A second directory a row may name: the ancestor that holds the manifest. */
  readonly repo?: string;
  readonly cwd: string;
  readonly home: string;
  readonly user: string;
  readonly env: Readonly<Record<string, string>>;
  /** Whether `--root` is supplied; a discovered root is not. */
  readonly supplied: boolean;
}
const homes = (prefix: string) => {
  const home = resolve(scratch(`${prefix}-home`), '.ia'),
    config = scratch(`${prefix}-config`);
  return { home, user: scratch(`${prefix}-user`), env: { IA_HOME: home, IA_HOST_HOME: home, IA_CONFIG_HOME: config } };
};
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
/** A copy of the loop fixture at `root`, admitted unless `foreign`. */
function loop(root: string, foreign = false): string {
  cpSync(FIXTURE, root, { recursive: true });
  if (!foreign) rmSync(resolve(root, FOREIGN));
  return root;
}
const NPM = JSON.stringify({ packageManager: 'npm@10.0.0' });
async function initialized(root: string, env: Readonly<Record<string, string>>): Promise<string> {
  const result = await run(['init', root, '--apply', '--yes', '--json'], { env });
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}

export type FixtureName =
  | 'none'
  | 'declined'
  | 'clean'
  | 'foreign'
  | 'pending'
  | 'generation'
  | 'ancestor'
  | 'shell-root'
  | 'projected'
  | 'registered';
export async function fixture(name: FixtureName): Promise<Fixture> {
  const { home, user, env } = homes(`df-${name}`);
  if (name === 'none' || name === 'declined') {
    const cwd = scratch(`df-${name}-cwd`);
    if (name === 'declined') {
      const declined = await run(['init', cwd, '--decline', 'forever', '--json'], { env });
      expect(declined.exitCode, declined.stdout).toBe(0);
    }
    return { root: cwd, cwd, home, user, env, supplied: false };
  }
  if (name === 'ancestor') {
    // The workspace at repo/kb; the CLI dependency is listed, not installed, in repo/package.json.
    const repo = scratch('df-ancestor'),
      root = loop(resolve(repo, 'kb'));
    put(
      resolve(repo, 'package.json'),
      JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' }, packageManager: 'npm@10.0.0' }),
    );
    return { root, repo, cwd: root, home, user, env, supplied: true };
  }
  // A path that holds shell syntax is never printed in a command; the remedy runs from the workspace root instead.
  const at = resolve(scratch(`df-${name}`), name === 'shell-root' ? 'a$(b)' : 'workspace');
  // A host projects only an initialized workspace, which `ia init --apply` leaves; the loop fixture is not one.
  const root =
    name === 'projected' || name === 'registered' ? await initialized(at, env) : loop(at, name === 'foreign');
  put(resolve(root, 'package.json'), NPM);
  if (name === 'pending' || name === 'shell-root') {
    put(resolve(root, '.ia/distributions/pending.json'), '{}');
    put(resolve(root, '.ia/distributions/install-lock.json'), '{}');
  }
  if (name === 'generation') put(resolve(root, '.ia/distributions/active.json'), 'not json');
  if (name === 'projected' || name === 'registered') {
    const verb = name === 'projected' ? 'project' : 'host';
    const projected = await run([verb, 'claude', '--root', root, '--apply', '--yes', '--json'], { env });
    expect(projected.exitCode, projected.stdout).toBe(0);
    // The first file the receipt lists, deleted: the next apply writes it again.
    const receipt = JSON.parse(readFileSync(resolve(root, RECEIPT), 'utf8')) as { files: { path: string }[] };
    rmSync(resolve(root, receipt.files[0]!.path));
  }
  return { root, cwd: root, home, user, env, supplied: true };
}

export function report(at: Fixture): DoctorView {
  return collectDoctor({
    cwd: at.cwd,
    root: at.supplied ? at.root : undefined,
    packageRoot: cli,
    runtime: RUNTIME,
    env: at.env,
    home: at.user,
    version: VERSION,
    now: NOW,
    channel: CHANNEL,
  });
}

/** Every spelling of the fixture's directories and every digest replaced by a placeholder, the longest first. */
export function normalized(value: unknown, at: Fixture): unknown {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const named: (readonly [string, string])[] = [];
  for (const [path, label] of [
    [at.root, '<root>'],
    [at.repo, '<repo>'],
    [at.home, '<home>'],
    [at.user, '<user>'],
    [at.env['IA_CONFIG_HOME'], '<config>'],
    [cli, '<cli>'],
  ] as const)
    if (path !== undefined)
      for (const spelling of new Set([path, real(path), commandRoot(path), commandRoot(real(path))]))
        named.push([spelling, label]);
  named.sort((a, b) => b[0].length - a[0].length);
  const text = (input: string): string => {
    let out = input;
    for (const [spelling, label] of named) out = out.split(spelling).join(label);
    return out.replace(/\b[0-9a-f]{12,64}\b/g, '<hex>').replaceAll('\\', '/');
  };
  // A detail also counts the corpus and names the language and package versions, which change with the repository
  // rather than with doctor; a remedy keeps every version it names.
  const detail = (input: string): string =>
    text(input)
      .replace(/\b\d+ (records|words|errors|warnings)\b/g, '<n> $1')
      .replace(/\b\d+(?:\.\d+)+\b/g, '<version>');
  const walk = (node: unknown, key = ''): unknown =>
    typeof node === 'string'
      ? key === 'detail'
        ? detail(node)
        : text(node)
      : Array.isArray(node)
        ? node.map((child) => walk(child))
        : node !== null && typeof node === 'object'
          ? Object.fromEntries(Object.entries(node).map(([name, child]) => [name, walk(child, name)]))
          : node;
  return walk(value);
}
/** The `--json` envelope with every check's `fix` removed: what the envelope was before `fix` existed. */
export function withoutFix(view: DoctorView): unknown {
  const envelope = doctorEnvelope(view) as { checks: Record<string, unknown>[] };
  return {
    ...envelope,
    checks: envelope.checks.map(({ fix: _fix, ...rest }) => rest),
  };
}
