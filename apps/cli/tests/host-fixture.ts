/** Shared host fixtures. Each isolated test file owns its temporary roots and cleanup. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect } from 'vitest';
import { quote } from '../src/render.js';
import { run, scratch } from './workspace-fixture.js';

export const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
export const read = (root: string, path: string): string => readFileSync(resolve(root, path), 'utf8');
export async function initialized(): Promise<{ root: string; env: { IA_HOST_HOME: string } }> {
  const root = resolve(scratch('host'), 'demo'),
    env = { IA_HOST_HOME: scratch('host-home') };
  const result = await run(['init', root, '--apply', '--yes', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return { root, env };
}
export const host = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['host', ...extra, '--root', root, '--json'], { env });
export const human = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['host', ...extra, '--root', root], { env });
export const element = (envelope: any, id: string): any =>
  envelope.plan.elements.find((row: { id: string }) => row.id === id);

/** A pid no process holds: a child that has already exited. The lock a killed run leaves names one like it. */
export const deadPid = (): number =>
  spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '' } }).pid!;
export const HOST_LOCK = '.ia/distributions/hosts/lock.json';
export const lockNext = (root: string): string =>
  `Another ia host run holds the host lock, or a killed run left it: run "ia-distribution recover-host --root ${quote(root)}" (it clears a dead holder's lock and refuses a live one), then rerun.`;

export type Row = { id: string; status: string; detail: string; remedy: string | null };
export const doctor = async (root: string, env: Record<string, string>) => {
  const result = await run(['doctor', '--root', root, '--json'], { env });
  return { exitCode: result.exitCode, checks: JSON.parse(result.stdout).checks as Row[] };
};
export const row = (checks: readonly Row[], id: string): Row | undefined => checks.find((check) => check.id === id);
/** Doctor was given --root, so each command it prints carries it, in the form `ia init --host` uses (rootedNext). */
export const rootedApply = (root: string, name = 'claude'): string => `ia host ${name} --root ${quote(root)} --apply`;
