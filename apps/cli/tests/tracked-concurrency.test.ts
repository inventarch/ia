/**
 * The tracked list's store lock (consumer CLI contract §2.16): concurrent `ia` processes never lose a row, and a lock
 * another owner holds is never removed by `ia`, whether that owner is running or not: the call waits, then refuses
 * naming the lock and its owner. The multi-process case runs the built `dist/tracked.js` in real `node` children, so it
 * belongs to the installed profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Refusal } from '../src/consumer.js';
import { readTracked, TRACKED_FILE, trackWorkspace } from '../src/tracked.js';
import { TRACKED_LOCK_FILE, withTrackedLock } from '../src/tracked-lock.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
afterEach(() => void vi.restoreAllMocks());

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
const refusalOf = (action: () => unknown): Refusal => {
  try {
    action();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('Expected a refusal');
};
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
/** What the lock left in the home besides the lock itself: a staging or set-aside file would show here. */
const leftovers = (at: string): readonly string[] =>
  readdirSync(at).filter((name) => name.startsWith(TRACKED_LOCK_FILE) && name !== TRACKED_LOCK_FILE);

const dist = (file: string): string => pathToFileURL(resolve(import.meta.dirname, '../dist', file)).href;
/** Generous on purpose: on a loaded machine a child can take many seconds just to import the built CLI. */
const SIGNAL_WAIT_MS = 90_000;
/**
 * The child-side half of the file signals: `until(name)` blocks until `<gate>/<name>` exists and throws once
 * SIGNAL_WAIT_MS has passed, so a child never outlives a test that gave up on it.
 */
const SIGNALS = `
  const { existsSync, writeFileSync } = await import('node:fs');
  const signal = (gate, name, text = '') => writeFileSync(gate + '/' + name, text);
  const until = (gate, name) => {
    const end = Date.now() + ${SIGNAL_WAIT_MS};
    while (!existsSync(gate + '/' + name)) {
      if (Date.now() > end) throw new Error('timed out waiting for ' + name);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  };
`;
type Exit = { readonly code: number | null; readonly stderr: string };
/** One `node` child per argument list, running `script`; `kill` ends any still running. */
function children(script: string, argvs: readonly (readonly string[])[]) {
  const spawned = argvs.map((argv) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...argv], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    return { child, exit: new Promise<Exit>((done) => child.on('close', (code) => done({ code, stderr }))) };
  });
  return {
    exits: Promise.all(spawned.map((entry) => entry.exit)),
    kill: () => spawned.forEach((entry) => entry.child.kill()),
  };
}
/** Polls until `ready` holds, or SIGNAL_WAIT_MS passes; the result says which. */
async function settle(ready: () => boolean): Promise<boolean> {
  const end = Date.now() + SIGNAL_WAIT_MS;
  while (!ready()) {
    if (Date.now() > end) return false;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  return true;
}

it('real processes adding at once lose no row', async () => {
  const at = home(),
    gate = scratch('tracked-gate'),
    count = 6,
    each = 4;
  // Every child imports, says it is ready, and waits for one "go", so the adds start together instead of in turn.
  const script = `
    ${SIGNALS}
    const { trackWorkspace } = await import(${JSON.stringify(dist('tracked.js'))});
    const [home, base, child, each, gate] = process.argv.slice(1);
    signal(gate, 'ready-' + child);
    until(gate, 'go');
    for (let n = 0; n < Number(each); n += 1) trackWorkspace(home, { root: base + '/c' + child + 'w' + n, id: 'c' + child + 'w' + n });
  `;
  const base = scratch('tracked-roots');
  for (let c = 0; c < count; c += 1)
    for (let n = 0; n < each; n += 1) workspaceAt(resolve(base, `c${c}w${n}`), `c${c}w${n}`);
  const run = children(
    script,
    Array.from({ length: count }, (_, c) => [at, base, String(c), String(each), gate]),
  );
  const ready = (): number => readdirSync(gate).filter((name) => name.startsWith('ready-')).length;
  if (!(await settle(() => ready() === count))) run.kill();
  expect(ready(), 'every child is ready before go').toBe(count);
  writeFileSync(resolve(gate, 'go'), '');
  for (const exit of await run.exits) expect(exit, exit.stderr).toMatchObject({ code: 0 });
  const ids = readTracked(at).map((row) => row.id);
  expect(ids).toHaveLength(count * each);
  expect(new Set(ids).size).toBe(count * each);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
}, 240_000);

it('a process that finds the lock held waits until its holder releases it', async () => {
  const at = home(),
    gate = scratch('tracked-gate');
  // The holder keeps the lock until the waiter reports a failed attempt, then releases it; the waiter then records
  // whether the holder had finished before its own turn began.
  const script = `
    ${SIGNALS}
    const { withTrackedLock } = await import(${JSON.stringify(dist('tracked-lock.js'))});
    const [role, home, gate] = process.argv.slice(1);
    if (role === 'holder')
      withTrackedLock(home, () => {
        signal(gate, 'held');
        until(gate, 'blocked');
        signal(gate, 'released');
      });
    else {
      until(gate, 'held');
      let blocked = 0;
      withTrackedLock(
        home,
        () => signal(gate, 'waited', JSON.stringify({ blocked, holderDone: existsSync(gate + '/released') })),
        { waitMs: ${SIGNAL_WAIT_MS}, onBlocked: () => { if (blocked++ === 0) signal(gate, 'blocked'); } },
      );
    }
  `;
  const run = children(script, [
    ['holder', at, gate],
    ['waiter', at, gate],
  ]);
  const exits = await run.exits;
  for (const exit of exits) expect(exit, exit.stderr).toMatchObject({ code: 0 });
  const waited = JSON.parse(readFileSync(resolve(gate, 'waited'), 'utf8')) as { blocked: number; holderDone: boolean };
  expect(waited.blocked).toBeGreaterThan(0);
  expect(waited.holderDone).toBe(true);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
}, 240_000);

it('never removes the lock of an owner on this host whose process is gone: it refuses and says so', () => {
  const at = home(),
    pid = deadPid(),
    lock = plantLock(at, { pid }),
    before = readFileSync(lock);
  let ran = false;
  const started = performance.now();
  const refusal = refusalOf(() =>
    withTrackedLock(
      at,
      () => {
        ran = true;
      },
      { waitMs: 150 },
    ),
  );
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(ran).toBe(false);
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain(lock);
  expect(refusal.message).toContain(`pid ${pid} on ${hostname()}`);
  expect(refusal.message).toContain(`pid ${pid} is not running on this host`);
  expect(refusal.next).toContain(`delete ${lock}`);
  // A live holder removes its own lock on release; what ia never does is remove another owner's.
  expect(refusal.next).toContain("ia never removes another owner's lock automatically");
  expect(readFileSync(lock).equals(before)).toBe(true);
  expect(leftovers(at)).toEqual([]);
  expect(existsSync(resolve(at, TRACKED_FILE))).toBe(false);
});

it('never removes a lock whose owner is running, however old it is', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' }),
    before = readFileSync(lock);
  const refusal = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 150 }));
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain(lock);
  expect(refusal.message).not.toContain('is not running');
  expect(readFileSync(lock).equals(before)).toBe(true);
});

it('never removes a lock another host owns, nor one it cannot parse', () => {
  const at = home(),
    lock = plantLock(at, { pid: deadPid(), host: `${hostname()}-elsewhere` });
  const elsewhere = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 }));
  expect(elsewhere.message).toContain(`on ${hostname()}-elsewhere`);
  expect(elsewhere.message).not.toContain('is not running');
  writeFileSync(lock, 'not json');
  expect(refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 })).message).toMatch(/could not be read/);
  expect(readFileSync(lock, 'utf8')).toBe('not json');
  expect(existsSync(resolve(at, TRACKED_FILE))).toBe(false);
});

it('a lock it cannot read still reaches the refusal within the wait', () => {
  const at = home(),
    lock = plantLock(at, { pid: process.pid });
  const read = (path: string): string => {
    if (path === lock) throw errno('EACCES');
    return readFileSync(path, 'utf8');
  };
  const started = performance.now();
  const refusal = refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100, read }));
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(refusal.code).toBe('IA-CLI-TRACKED-LOCKED');
  expect(refusal.message).toContain('its owner could not be read (EACCES)');
  expect(refusal.message).toContain(lock);
  expect(existsSync(lock)).toBe(true);
}, 10_000);

it('measures the wait on a monotonic clock, so a wall clock that stands still cannot extend it', () => {
  const at = home();
  plantLock(at, { pid: process.pid });
  vi.spyOn(Date, 'now').mockReturnValue(0);
  expect(refusalOf(() => withTrackedLock(at, () => 'ran', { waitMs: 100 })).code).toBe('IA-CLI-TRACKED-LOCKED');
}, 10_000);

it('releases the lock when the action throws', () => {
  const at = home();
  expect(() =>
    withTrackedLock(at, () => {
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
});

it('releases the lock when removing its staging file fails after the lock is published', () => {
  const at = home();
  let ran = false;
  const removeStage = (): void => {
    throw errno('EPERM');
  };
  expect(() =>
    withTrackedLock(
      at,
      () => {
        ran = true;
      },
      { removeStage },
    ),
  ).toThrow(/EPERM/);
  expect(ran).toBe(false);
  expect(existsSync(resolve(at, TRACKED_LOCK_FILE))).toBe(false);
  // The next call in the same process takes the lock at once.
  expect(withTrackedLock(at, () => 'ran', { waitMs: 100 })).toBe('ran');
});

it('a lock it cannot remove after the list was written refuses saying the change was made, naming the lock', () => {
  const at = home(),
    root = resolve(scratch('tracked-lock-left'), 'demo');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  const removeLock = (): void => {
    throw errno('EBUSY');
  };
  const refusal = refusalOf(() => trackWorkspace(at, { root, id: 'demo' }, new Date(), { removeLock }));
  const lock = resolve(at, TRACKED_LOCK_FILE);
  expect(refusal).toMatchObject({ code: 'IA-CLI-TRACKED-LOCK-LEFT', exit: 3, where: { path: lock } });
  expect(refusal.message).toContain('The change was made');
  expect(refusal.message).toContain(lock);
  expect(refusal.next).toContain(`delete ${lock}`);
  expect(readTracked(at).map((row) => row.id)).toEqual(['demo']);
  expect(existsSync(lock)).toBe(true);
});
