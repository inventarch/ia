/**
 * The tracked list's store lock (consumer CLI contract §2.16): concurrent `ia` processes never lose a row, and a lock
 * left by a killed holder is taken over only when its owner is provably gone. The multi-process case runs the built
 * `dist/tracked.js` in real `node` children, so it belongs to the installed profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { Refusal } from '../src/consumer.js';
import { readTracked, TRACKED_FILE, trackWorkspace } from '../src/tracked.js';
import { TRACKED_LOCK_FILE, withTrackedLock } from '../src/tracked-lock.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const home = (): string => resolve(scratch('tracked-lock-home'), '.ia');
function workspaceAt(root: string, name: string): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/workspace.ia'), `@workspace ${name}\n`);
  return root;
}
/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}
const plantLock = (at: string, owner: Record<string, unknown>): string => {
  mkdirSync(at, { recursive: true });
  const lock = resolve(at, TRACKED_LOCK_FILE);
  writeFileSync(
    lock,
    JSON.stringify({
      token: 'planted',
      start: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      host: hostname(),
      ...owner,
    }),
  );
  return lock;
};

it('real processes adding at once lose no row', async () => {
  const at = home(),
    dist = pathToFileURL(resolve(import.meta.dirname, '../dist/tracked.js')).href,
    children = 6,
    each = 4;
  const script = `
    const { trackWorkspace } = await import(${JSON.stringify(dist)});
    const [home, base, child, each] = process.argv.slice(1);
    for (let n = 0; n < Number(each); n += 1) trackWorkspace(home, { root: base + '/c' + child + 'w' + n, id: 'c' + child + 'w' + n });
  `;
  const base = scratch('tracked-roots');
  for (let c = 0; c < children; c += 1)
    for (let n = 0; n < each; n += 1) workspaceAt(resolve(base, `c${c}w${n}`), `c${c}w${n}`);
  const exits = await Promise.all(
    Array.from(
      { length: children },
      (_, c) =>
        new Promise<{ code: number | null; stderr: string }>((done) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', script, at, base, String(c), String(each)],
            {
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.on('close', (code) => done({ code, stderr }));
        }),
    ),
  );
  for (const exit of exits) expect(exit, exit.stderr).toMatchObject({ code: 0 });
  const ids = readTracked(at).map((row) => row.id);
  expect(ids).toHaveLength(children * each);
  expect(new Set(ids).size).toBe(children * each);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
}, 120_000);

it('takes over the lock of an owner on this host whose process is gone', () => {
  const at = home(),
    lock = plantLock(at, { pid: deadPid() }),
    root = workspaceAt(resolve(scratch('tracked-roots'), 'repo'), 'repo');
  expect(trackWorkspace(at, { root }).status).toBe('added');
  expect(existsSync(lock)).toBe(false);
  expect(readTracked(at).map((row) => row.id)).toEqual(['repo']);
});

it('never takes over a lock whose owner is running, however old it is', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' });
  let refusal: unknown;
  try {
    withTrackedLock(at, () => 'ran', 150);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Refusal);
  expect((refusal as Refusal).code).toBe('IA-CLI-TRACKED-LOCKED');
  expect((refusal as Refusal).message).toContain(lock);
  expect(existsSync(lock)).toBe(true);
});

it('never takes over a lock another host owns, nor one it cannot read', () => {
  const at = home(),
    lock = plantLock(at, { pid: deadPid(), host: `${hostname()}-elsewhere` });
  expect(() => withTrackedLock(at, () => 'ran', 100)).toThrow(/locked/);
  writeFileSync(lock, 'not json');
  expect(() => withTrackedLock(at, () => 'ran', 100)).toThrow(/locked/);
  expect(readFileSync(lock, 'utf8')).toBe('not json');
  expect(existsSync(resolve(at, TRACKED_FILE))).toBe(false);
});

it('releases the lock when the action throws', () => {
  const at = home();
  expect(() =>
    withTrackedLock(at, () => {
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
});
