import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryKey } from '@inventarch/distribution/decisions';
import { afterAll, expect, it, vi } from 'vitest';
import { quote } from '../src/render.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

const repositories = (home: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(home, 'state/decisions.json'), 'utf8')).repositories;

it('records a decline in the IA home and never writes the repository', async () => {
  const repo = scratch('decline-repo'),
    home = resolve(scratch('decline-home'), '.ia'),
    env = { IA_HOME: home };
  const forever = await run(['init', repo, '--decline', 'forever', '--host', 'claude', '--json'], { env });
  expect(forever.exitCode, forever.stdout).toBe(0);
  const path = repositoryKey(repo).path;
  expect(JSON.parse(forever.stdout)).toMatchObject({
    version: 1,
    command: 'init',
    path,
    decision: { decision: 'declined-forever', host: 'claude' },
    forgotten: false,
  });
  expect(existsSync(resolve(repo, '.ia'))).toBe(false);
  expect(Object.keys(repositories(home))).toHaveLength(1);
  const forgot = await run(['init', repo, '--forget-decline', '--json'], { env });
  expect(forgot.exitCode, forgot.stdout).toBe(0);
  expect(JSON.parse(forgot.stdout)).toMatchObject({ decision: null, forgotten: true, path });
});
it('refuses --decline with --apply as usage', async () => {
  const result = await run(['init', scratch('decline-usage'), '--decline', 'today', '--apply', '--yes']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(2);
});
it('refuses --decline with --id as usage', async () => {
  const result = await run(['init', scratch('decline-id'), '--decline', 'today', '--id', 'a/b']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(2);
});
it('refuses --forget-decline with --host as usage', async () => {
  const result = await run(['init', scratch('forget-host'), '--forget-decline', '--host', 'claude']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(2);
});
it('--forget-decline with nothing recorded reports it and exits 0', async () => {
  const result = await run(['init', scratch('forget-nothing'), '--forget-decline']);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toContain('No decline was recorded');
});
it('clears a decline when initialization is applied', async () => {
  // The directory exists before the decline, so the decline and the init compute the same real-path key.
  const repo = resolve(scratch('decline-apply'), 'demo'),
    home = resolve(scratch('decline-home2'), '.ia'),
    env = { IA_HOME: home };
  mkdirSync(repo);
  const declined = await run(['init', repo, '--decline', 'today', '--json'], { env });
  expect(declined.exitCode, declined.stdout).toBe(0);
  expect(Object.keys(repositories(home))).toHaveLength(1);
  const applied = await run(['init', repo, '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(repositories(home)).toEqual({});
});
it('clears a decline recorded before the target directory existed once init --apply creates it', async () => {
  const repo = resolve(scratch('decline-notyet'), 'demo'),
    home = resolve(scratch('decline-home3'), '.ia'),
    env = { IA_HOME: home };
  expect(existsSync(repo)).toBe(false);
  const declined = await run(['init', repo, '--decline', 'today', '--json'], { env });
  expect(declined.exitCode, declined.stdout).toBe(0);
  expect(Object.keys(repositories(home))).toHaveLength(1);
  const applied = await run(['init', repo, '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(repositories(home)).toEqual({});
});
it('a relative IA_HOME refuses at exit 3, naming the decline to run again once it is absolute', async () => {
  const repo = scratch('decline-relhome');
  const result = await run(['init', repo, '--decline', 'today', '--json'], {
    env: { IA_HOME: '.ia' },
  });
  expect(result.exitCode, result.stdout).toBe(3);
  expect(JSON.parse(result.stdout).next).toBe(
    `Set IA_HOME to an absolute directory, or unset it to use ~/.ia; then run "ia init ${quote(repo)} --decline today".`,
  );
});
it('an invalid decisions file is refused with its own path', async () => {
  const home = resolve(scratch('decline-invalid'), '.ia'),
    env = { IA_HOME: home };
  mkdirSync(resolve(home, 'state'), { recursive: true });
  writeFileSync(resolve(home, 'state/decisions.json'), '{not json', 'utf8');
  const repo = scratch('decline-invalid-target');
  const result = await run(['init', repo, '--forget-decline', '--json'], { env });
  expect(result.exitCode, result.stdout).toBe(3);
  const body = JSON.parse(result.stdout) as { where: { path: string }; next: string };
  expect(body.where.path.endsWith('decisions.json')).toBe(true);
  expect(body.next).toBe(
    `Fix or delete ${resolve(home, 'state/decisions.json')}, then run "ia init ${quote(repo)} --forget-decline".`,
  );
});
