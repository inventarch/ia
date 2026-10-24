import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBounded } from '@tools/testing/subprocess.js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MARKETPLACE_DIR,
  inspectMaterializedPlugin,
  materializeMarketplace,
  readMaterializedPlugin,
  removeMarketplace,
} from '../src/plugin-home.js';

// spy: true keeps every unmocked call on the real filesystem; only the calls a test overrides are diverted.
vi.mock('node:fs', { spy: true });
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-plugin-home-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of the temp dir itself */
    }
  }
});
// Every busy/failure test overrides renameSync and/or rmSync, and the lock tests openSync, readFileSync, statSync, lstatSync or mkdirSync; put each back to a plain passthrough so later tests see the real filesystem.
afterEach(() => {
  vi.mocked(renameSync).mockImplementation((from, to) => real.renameSync(from as never, to as never));
  vi.mocked(rmSync).mockImplementation((path, options) => real.rmSync(path as never, options as never));
  vi.mocked(mkdirSync).mockImplementation(((path: never, options: never) => real.mkdirSync(path, options)) as never);
  vi.mocked(openSync).mockImplementation((path, flags, mode) => real.openSync(path, flags, mode));
  vi.mocked(readFileSync).mockImplementation(((path: never, options: never) =>
    real.readFileSync(path, options)) as never);
  vi.mocked(statSync).mockImplementation(((path: never, options: never) => real.statSync(path, options)) as never);
  vi.mocked(lstatSync).mockImplementation(((path: never, options: never) => real.lstatSync(path, options)) as never);
});
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
/** Never a live pid here: Linux pids stay below 4194304, the largest pid_max, and macOS pids below 100000. */
const DEAD_PID = '4194305';
/** No run's token: what another run's lock, in the format this CLI writes, holds after its pid. */
const OTHER_TOKEN = '00000000-0000-4000-8000-000000000000';
/** Past this many opens of the lock path a takeover is looping: it opens it at most twice per attempt. */
const OPEN_LIMIT = 20;
/**
 * Stubs openSync and readFileSync for the lock path. Past OPEN_LIMIT opens of it the stub throws an error that the
 * exclusive open passes on, so a regression in the attempt bound fails instead of spinning. With `fifo`, any open or
 * read of it that could block is refused and recorded in `blocked`: an openSync without O_NONBLOCK, except the
 * exclusive create (which fails at once), and any readFileSync, since one given an encoding opens in Node's C++ fast
 * path and reaches no openSync stub. Vitest cannot time out a blocked synchronous call. `before` runs ahead of each
 * open of the lock path, `after` once one succeeds, and `opened` counts the opens that succeed.
 */
function watchOpens(
  lockPath: string,
  hooks: { readonly fifo?: boolean; readonly before?: (exclusive: boolean) => void; readonly after?: () => void } = {},
): { readonly opened: () => number; readonly blocked: readonly string[] } {
  let opens = 0,
    opened = 0;
  const blocked: string[] = [];
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) !== lockPath) return real.openSync(path, flags, mode);
    if (++opens > OPEN_LIMIT)
      throw new Error(`Opened ${lockPath} more than ${OPEN_LIMIT} times: takeover is unbounded`);
    const exclusive = typeof flags === 'string' ? flags.includes('x') : (Number(flags) & real.constants.O_EXCL) !== 0,
      nonblocking = typeof flags === 'number' && (flags & real.constants.O_NONBLOCK) !== 0;
    if (hooks.fifo && !exclusive && !nonblocking) {
      blocked.push(`openSync(${String(flags)})`);
      throw new Error(`Refused an open of the FIFO at ${lockPath} that could block`);
    }
    hooks.before?.(exclusive);
    const fd = real.openSync(path, flags, mode);
    opened++;
    hooks.after?.();
    return fd;
  });
  vi.mocked(readFileSync).mockImplementation(((path: never, options: never) => {
    if (!hooks.fifo || String(path) !== lockPath) return real.readFileSync(path, options);
    blocked.push('readFileSync');
    throw new Error(`Refused a read of the FIFO at ${lockPath}, which could block`);
  }) as never);
  return { opened: () => opened, blocked };
}
/** Creates a file symbolic link, or returns false where Windows denies the privilege (EPERM); any other failure throws. */
function fileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}
const files = (version: string) => [
  { path: 'plugins/ia/.claude-plugin/plugin.json', text: JSON.stringify({ name: 'ia', version }) },
  {
    path: 'plugins/ia/ia-plugin.json',
    text: JSON.stringify({ format: 'ia.claude-plugin.v1', cli: '0.1.0', channel: 'npm', entry: '/x', install: 'y' }),
  },
];
const ok = { version: '0.1.0+aaa', cli: '0.1.0', channel: 'npm', entry: '/x' };
// EPERM is only "busy" on win32; elsewhere it is a permission error, so the busy-retry tests inject whichever code this platform actually retries.
const busyCode = process.platform === 'win32' ? 'EPERM' : 'EBUSY';
/** Diverts only renames matching `from`'s prefix and `to === target`; everything else, including the demote and (unless matched) the restore, hits the real filesystem. */
function interceptRename(target: string, fromPrefix: string, throwing: () => never): void {
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === target && String(from).startsWith(fromPrefix)) throwing();
    return real.renameSync(from as never, to as never);
  });
}

it('materializes, replaces whole and reads back what it wrote', () => {
  const home = join(temp(), '.ia');
  expect(readMaterializedPlugin(home)).toBeNull();
  materializeMarketplace(home, files('0.1.0+aaa'));
  expect(readMaterializedPlugin(home)).toEqual(ok);
  materializeMarketplace(home, files('0.1.0+bbb'));
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+bbb');
  expect(readdirSync(join(home, 'claude'))).toEqual(['marketplace']);
  expect(removeMarketplace(home)).toBe(true);
  expect(existsSync(join(home, MARKETPLACE_DIR))).toBe(false);
  expect(removeMarketplace(home)).toBe(false);
});
it('refuses a path that escapes the marketplace directory, before writing anything', () => {
  const home = join(temp(), '.ia');
  expect(() => materializeMarketplace(home, [{ path: '../evil', text: '' }])).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(existsSync(home)).toBe(false);
});
it('refuses an empty path, before writing anything', () => {
  const home = join(temp(), '.ia');
  expect(() => materializeMarketplace(home, [{ path: '', text: '' }])).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(existsSync(home)).toBe(false);
});
it('refuses an absolute path, posix- or windows-shaped, before writing anything', () => {
  const home = join(temp(), '.ia');
  expect(() => materializeMarketplace(home, [{ path: '/etc/passwd', text: '' }])).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(() => materializeMarketplace(home, [{ path: 'C:/evil.txt', text: '' }])).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(existsSync(home)).toBe(false);
});
// The set must install on every platform, and macOS and Windows volumes fold case, so case-distinct paths are one path
// everywhere (crowncodes/ia#315): on macOS the second write used to collide with a raw EEXIST after the first had been written.
it('refuses duplicate paths, case-insensitively on every platform, before writing anything', () => {
  const home = join(temp(), '.ia');
  const dupes = [
    { path: 'plugins/ia/a.txt', text: 'x' },
    { path: 'plugins/IA/A.txt', text: 'y' },
  ];
  expect(() => materializeMarketplace(home, dupes)).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(() =>
    materializeMarketplace(home, [
      { path: 'same.txt', text: 'x' },
      { path: 'same.txt', text: 'y' },
    ]),
  ).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  // APFS also folds full Unicode case, so these are one path on a Mac too (crowncodes/ia#323).
  for (const other of ['plugins/ia/cla\u00df.txt', 'plugins/ia/\ufb01le.txt', 'plugins/ia/\u017f.txt']) {
    const first = other.replace('cla\u00df', 'class').replace('\ufb01le', 'file').replace('\u017f', 's');
    expect(() =>
      materializeMarketplace(home, [
        { path: first, text: 'x' },
        { path: other, text: 'y' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  }
  expect(existsSync(home)).toBe(false);
});
it('refuses a path that is a strict prefix-directory of another, before writing anything', () => {
  const home = join(temp(), '.ia');
  expect(() =>
    materializeMarketplace(home, [
      { path: 'a', text: 'x' },
      { path: 'a/b', text: 'y' },
    ]),
  ).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(existsSync(home)).toBe(false);
});
it('refuses a home that contains src/ before writing anything', () => {
  const home = join(temp(), '.ia');
  mkdirSync(join(home, 'src'), { recursive: true });
  expect(() => materializeMarketplace(home, files('0.1.0+aaa'))).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(existsSync(join(home, 'claude'))).toBe(false);
});
it('inspectMaterializedPlugin reports absent, invalid and ok', () => {
  const home = join(temp(), '.ia');
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
  materializeMarketplace(home, files('0.1.0+aaa'));
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'ok', ...ok });
  writeFileSync(join(home, MARKETPLACE_DIR, 'plugins/ia/.claude-plugin/plugin.json'), 'not json');
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'invalid', reason: 'parse' });
  expect(readMaterializedPlugin(home)).toBeNull();
});
it('restores the previous copy when the swap fails for a non-busy reason: previous intact, no leftovers, original error thrown', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  interceptRename(target, join(parent, '.stage-'), () => {
    throw Object.assign(new Error('disk fell over'), { code: 'EIO' });
  });
  expect(() => materializeMarketplace(home, files('0.1.0+bbb'))).toThrow(/disk fell over/);
  expect(readMaterializedPlugin(home)).toEqual(ok);
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
it('keeps the previous copy and refuses RECOVERY-REQUIRED when the swap and the restore both fail, then a clean call recovers it', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  vi.mocked(renameSync).mockImplementation((from, to) => {
    const f = String(from);
    if (String(to) === target && (f.startsWith(join(parent, '.stage-')) || f.startsWith(join(parent, '.previous-'))))
      throw Object.assign(new Error('disk fell over'), { code: 'EIO' });
    return real.renameSync(from as never, to as never);
  });
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+bbb'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-RECOVERY-REQUIRED');
  expect((caught as Error).message).toMatch(/rerun ia host claude --user --apply/);
  const remaining = readdirSync(parent);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.startsWith('.previous-')).toBe(true);
  expect(readMaterializedPlugin(home)).toBeNull();
  vi.mocked(renameSync).mockImplementation((from, to) => real.renameSync(from as never, to as never)); // a subsequent, unmocked attempt
  materializeMarketplace(home, files('0.1.0+ccc'));
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+ccc');
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
it('retries a persistently busy swap, then refuses INSTALL-BUSY and restores the previous copy', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  interceptRename(target, join(parent, '.stage-'), () => {
    throw Object.assign(new Error('locked'), { code: busyCode });
  });
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+bbb'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  expect((caught as Error).message).toMatch(/close Claude Code sessions/);
  expect(readMaterializedPlugin(home)).toEqual(ok);
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
it('recovers a transient busy rename on retry and succeeds', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  let thrown = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (!thrown && String(to) === target && String(from).startsWith(join(parent, '.stage-'))) {
      thrown = true;
      throw Object.assign(new Error('locked once'), { code: busyCode });
    }
    return real.renameSync(from as never, to as never);
  });
  materializeMarketplace(home, files('0.1.0+bbb'));
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+bbb');
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
it('classifies a non-busy permission error per platform: INSTALL-BUSY on win32, INPUT-INVALID elsewhere', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  interceptRename(target, join(parent, '.stage-'), () => {
    throw Object.assign(new Error('perm'), { code: 'EACCES' });
  });
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+bbb'));
  } catch (error) {
    caught = error;
  }
  if (process.platform === 'win32') {
    expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  } else {
    expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INPUT-INVALID');
    expect((caught as Error).message).toMatch(/cannot be renamed \(EACCES\); check its permissions/);
  }
  expect(readMaterializedPlugin(home)).toEqual(ok);
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
it.skipIf(process.platform !== 'win32')(
  'a genuinely open file refuses materialize as INSTALL-BUSY, and removeMarketplace never leaves the tree partial',
  () => {
    const home = join(temp(), '.ia');
    materializeMarketplace(home, files('0.1.0+aaa'));
    const target = join(home, MARKETPLACE_DIR),
      heldPath = join(target, 'plugins/ia/ia-plugin.json');
    const fd = openSync(heldPath, 'r+');
    try {
      let caught: unknown;
      try {
        materializeMarketplace(home, files('0.1.0+bbb'));
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
      expect(readMaterializedPlugin(home)).toEqual(ok);
      expect(readdirSync(join(home, 'claude'))).toEqual(['marketplace']);
      let removeCaught: unknown,
        removed = false;
      try {
        removed = removeMarketplace(home);
      } catch (error) {
        removeCaught = error;
      }
      if (removeCaught !== undefined) {
        expect((removeCaught as { code?: string }).code).toBe('IA-DIST-INSTALL-BUSY');
        expect(readMaterializedPlugin(home)).toEqual(ok);
      } else {
        expect(removed).toBe(true);
        expect(existsSync(target)).toBe(false);
      }
    } finally {
      closeSync(fd);
    }
  },
);
it('removeMarketplace sweeps stale leftovers too, and invalid input afterward does not resurrect anything', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude');
  materializeMarketplace(home, files('0.1.0+aaa'));
  mkdirSync(join(parent, '.previous-stale'), { recursive: true }); // a stray leftover from some earlier interrupted run
  expect(removeMarketplace(home)).toBe(true);
  expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
  expect(() =>
    materializeMarketplace(home, [
      { path: 'a', text: 'x' },
      { path: 'a/b', text: 'y' },
    ]),
  ).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
it('removeMarketplace clears a RECOVERY-REQUIRED leftover: true, nothing left', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    target = join(home, MARKETPLACE_DIR);
  materializeMarketplace(home, files('0.1.0+aaa'));
  vi.mocked(renameSync).mockImplementation((from, to) => {
    const f = String(from);
    if (String(to) === target && (f.startsWith(join(parent, '.stage-')) || f.startsWith(join(parent, '.previous-'))))
      throw Object.assign(new Error('disk fell over'), { code: 'EIO' });
    return real.renameSync(from as never, to as never);
  });
  expect(() => materializeMarketplace(home, files('0.1.0+bbb'))).toThrow(
    expect.objectContaining({ code: 'IA-DIST-RECOVERY-REQUIRED' }),
  );
  vi.mocked(renameSync).mockImplementation((from, to) => real.renameSync(from as never, to as never));
  expect(readdirSync(parent).some((name) => name.startsWith('.previous-'))).toBe(true);
  expect(removeMarketplace(home)).toBe(true);
  expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
});
it('refuses INSTALL-BUSY when a live-pid lock is already held', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, '.lock'), String(process.pid));
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+aaa'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  expect((caught as Error).message).toMatch(/Another ia host --user run holds/);
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
it('takes over a dead-pid lock and succeeds', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, '.lock'), '999999'); // not a live pid in this test run
  materializeMarketplace(home, files('0.1.0+aaa'));
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+aaa');
  expect(existsSync(join(parent, '.lock'))).toBe(false); // released after the successful materialize
});
it('refuses INSTALL-BUSY for a freshly created, still-empty lock rather than stealing it', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, '.lock'), ''); // another run's openSync landed, its pid write has not happened yet
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+aaa'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
it('takes over an empty lock once it is old enough, even though its pid never parsed', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock');
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, '');
  const past = new Date(Date.now() - 20_000); // well past the 10s empty-lock grace period
  utimesSync(lockPath, past, past);
  materializeMarketplace(home, files('0.1.0+aaa'));
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+aaa');
  expect(existsSync(lockPath)).toBe(false);
});
it('refuses INSTALL-BUSY after bounded takeover attempts, without hanging, when lock removal keeps failing', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock');
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, '999999'); // dead pid: every attempt judges the lock stale, so it always reaches rmSync
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (String(path) === lockPath) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return real.rmSync(path as never, options as never);
  });
  watchOpens(lockPath); // so a takeover that stops bounding its attempts fails here instead of spinning
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+aaa'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  expect((caught as Error).message).toMatch(/Another ia host --user run holds/);
}, 5000);
// Each verdict at every age that matters: a dead pid is taken over at any age, a live pid only past a day (a younger
// age does not show that its owner stopped), and an empty or unparseable pid after 10 seconds' grace. So is a pid
// outside 1 to 2147483647, which names no single owner: on POSIX process.kill takes 0 or a negative pid for a process
// group or for every process, on Windows 0 is the caller itself, and Node refuses a larger one. 2147483647, the largest
// pid that names one, is judged by whether it runs, and as no process has it, it is taken over at 5 seconds, when
// 2147483648 is not. A lock an older CLI wrote holds its pid alone; one this CLI writes holds its pid, a space and a
// token. A live pid is this process's own and also another process's, this process's parent (Vitest's main process), so
// a check that judges only this process alive fails. Ages are set with utimesSync, never waited out.
it('takes over a lock whose pid died or that holds no pid from 1 to 2147483647 past 10 seconds, in either format, a live one past a day, and refuses INSTALL-BUSY untouched for any other', () => {
  const minutes = 60_000,
    live = String(process.pid),
    otherLive = String(process.ppid),
    dead = DEAD_PID,
    token = ` ${OTHER_TOKEN}`;
  const cases: Record<string, readonly [text: string, ageMs: number, takenOver: boolean]> = {
    'dead pid, just written': [dead, 0, true],
    'dead pid, 20 minutes old': [dead, 20 * minutes, true],
    'dead pid and token, just written': [dead + token, 0, true],
    'live pid, just written': [live, 0, false],
    'live pid, 9 minutes old': [live, 9 * minutes, false],
    'live pid, 11 minutes old': [live, 11 * minutes, false],
    'live pid and token, 11 minutes old': [live + token, 11 * minutes, false],
    'live pid and token, 23 hours old': [live + token, 23 * 60 * minutes, false],
    'live pid and token, 25 hours old': [live + token, 25 * 60 * minutes, true],
    "another live process's pid and token, 23 hours old": [otherLive + token, 23 * 60 * minutes, false],
    "another live process's pid and token, 25 hours old": [otherLive + token, 25 * 60 * minutes, true],
    'empty, 5 seconds old': ['', 5_000, false],
    'empty, 20 seconds old': ['', 20_000, true],
    'unparseable, 5 seconds old': ['not a pid', 5_000, false],
    'unparseable, 20 seconds old': ['not a pid', 20_000, true],
    'pid 0, 5 seconds old': ['0', 5_000, false],
    'pid 0, 20 seconds old': ['0', 20_000, true],
    'pid -1, 5 seconds old': ['-1', 5_000, false],
    'pid -1, 20 seconds old': ['-1', 20_000, true],
    'pid 2147483647, 5 seconds old': ['2147483647', 5_000, true],
    'pid 2147483648, 5 seconds old': ['2147483648', 5_000, false],
    'pid 2147483648, 20 seconds old': ['2147483648', 20_000, true],
    'pid 99999999999, 5 seconds old': ['99999999999', 5_000, false],
    'pid 99999999999, 20 seconds old': ['99999999999', 20_000, true],
  };
  const seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  for (const [name, [text, ageMs, takenOver]] of Object.entries(cases)) {
    const home = join(temp(), '.ia'),
      lockPath = join(home, 'claude', '.lock');
    mkdirSync(join(home, 'claude'), { recursive: true });
    writeFileSync(lockPath, text);
    const when = new Date(Date.now() - ageMs);
    utimesSync(lockPath, when, when);
    seen[name] = {
      outcome: materialized(home),
      lock: existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
      version: readMaterializedPlugin(home)?.version ?? null,
    };
    expected[name] = takenOver
      ? { outcome: 'materialized', lock: null, version: '0.1.0+aaa' }
      : { outcome: heldBy(lockPath), lock: text, version: null };
  }
  // One comparison, so a changed verdict shows every case it moves, not only the first.
  expect(seen).toEqual(expected);
});
// Both ends of the owner range name one owner, so a lock holding either is judged by whether that pid runs (here it does,
// as process.kill answers), not taken over at 20 seconds by its age alone, as a lock past 10 seconds whose pid is outside
// the range is.
it.each([1, 2147483647])(
  'checks liveness at pid %i, an inclusive end of the owner range, before taking over a young lock',
  (pid) => {
    const home = join(temp(), '.ia'),
      lockPath = join(home, 'claude', '.lock');
    mkdirSync(join(home, 'claude'), { recursive: true });
    writeFileSync(lockPath, `${pid} ${OTHER_TOKEN}`);
    const when = new Date(Date.now() - 20_000);
    utimesSync(lockPath, when, when);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(materialized(home)).toEqual(heldBy(lockPath));
      expect(kill).toHaveBeenCalledWith(pid, 0);
    } finally {
      kill.mockRestore();
    }
  },
);
// The day backstop at both ends of the owner range: a lock naming pid 1 or 2147483647 whose pid runs (here it does, as
// process.kill answers when asked about that pid) is still busy 23 hours old and taken over 25 hours old, as the live
// pids' locks in the table above are. Past a day the backstop decides before process.kill would be asked, so whether
// it was is pinned only under a day. Ages are set with utimesSync, never waited out.
it('takes over a lock naming pid 1 or 2147483647, which process.kill answers is running, past a day, and refuses INSTALL-BUSY untouched under one', () => {
  const minutes = 60_000,
    token = ` ${OTHER_TOKEN}`;
  const cases: Record<string, readonly [pid: number, ageMs: number, takenOver: boolean]> = {
    'pid 1 and token, 23 hours old': [1, 23 * 60 * minutes, false],
    'pid 1 and token, 25 hours old': [1, 25 * 60 * minutes, true],
    'pid 2147483647 and token, 23 hours old': [2147483647, 23 * 60 * minutes, false],
    'pid 2147483647 and token, 25 hours old': [2147483647, 25 * 60 * minutes, true],
  };
  const seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    for (const [name, [pid, ageMs, takenOver]] of Object.entries(cases)) {
      const home = join(temp(), '.ia'),
        lockPath = join(home, 'claude', '.lock'),
        text = `${pid}${token}`;
      mkdirSync(join(home, 'claude'), { recursive: true });
      writeFileSync(lockPath, text);
      const when = new Date(Date.now() - ageMs);
      utimesSync(lockPath, when, when);
      kill.mockClear();
      seen[name] = {
        outcome: materialized(home),
        lock: existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
        version: readMaterializedPlugin(home)?.version ?? null,
        askedKill: kill.mock.calls.some(([target, signal]) => target === pid && signal === 0),
      };
      expected[name] = takenOver
        ? { outcome: 'materialized', lock: null, version: '0.1.0+aaa', askedKill: expect.any(Boolean) }
        : { outcome: heldBy(lockPath), lock: text, version: null, askedKill: true };
    }
  } finally {
    kill.mockRestore();
  }
  // One comparison, so a changed verdict shows every case it moves, not only the first.
  expect(seen).toEqual(expected);
});
// Only ESRCH from process.kill means the pid is not running: any other error, such as the EPERM another user's or a
// protected process answers, leaves the lock busy until it is a day old, so a live run is not taken over.
it('refuses INSTALL-BUSY untouched for a lock under a day old whose pid process.kill answers with EPERM', () => {
  const home = join(temp(), '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    text = `${DEAD_PID} ${OTHER_TOKEN}`;
  mkdirSync(join(home, 'claude'), { recursive: true });
  writeFileSync(lockPath, text);
  const when = new Date(Date.now() - 23 * 60 * 60_000);
  utimesSync(lockPath, when, when);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  try {
    expect(materialized(home)).toEqual(heldBy(lockPath));
    expect(kill).toHaveBeenCalledWith(Number(DEAD_PID), 0);
  } finally {
    kill.mockRestore();
  }
  expect(readFileSync(lockPath, 'utf8')).toBe(text);
});
// A takeover removes a stale lock only under its claim, made while the judging descriptor still holds the judged file
// open (so its inode cannot be reused), after finding again that the lock path still names that file: a lock another
// run created after this run's judgment, here just before the claim, is left in place.
it('leaves in place a lock another run created after this run judged the stale one, and refuses INSTALL-BUSY', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock'),
    other = `${process.ppid} ${OTHER_TOKEN}`;
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, `${DEAD_PID} ${OTHER_TOKEN}`);
  const staleIno = real.lstatSync(lockPath, { bigint: true }).ino;
  let judgedFd: number | undefined;
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const fd = real.openSync(path, flags, mode);
    if (String(path) === lockPath && flags !== 'wx') judgedFd = fd;
    return fd;
  });
  let replaced = false,
    judgedOpenAtClaim = false;
  vi.mocked(mkdirSync).mockImplementation(((path: never, options: never) => {
    if (!replaced && String(path).endsWith('.claim')) {
      try {
        judgedOpenAtClaim = real.fstatSync(judgedFd as number, { bigint: true }).ino === staleIno;
      } catch {
        /* closed already: judgedOpenAtClaim stays false */
      }
      replaced = true;
      real.rmSync(lockPath);
      real.writeFileSync(lockPath, other);
    }
    return real.mkdirSync(path, options);
  }) as never);
  expect(materialized(home)).toEqual(heldBy(lockPath));
  expect(replaced).toBe(true);
  expect(judgedOpenAtClaim).toBe(true);
  expect(readFileSync(lockPath, 'utf8')).toBe(other);
  expect(readdirSync(parent).filter((name) => name.endsWith('.claim'))).toEqual([]);
});
// Two runs that judged the same stale lock never both remove it: the claim is exclusive, so a run that finds it held
// refuses INSTALL-BUSY and leaves the lock, until the claim is older than the 10 seconds' grace and so abandoned.
it('refuses INSTALL-BUSY for a stale lock another run is claiming, and takes it over once that claim is abandoned', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock'),
    text = `${DEAD_PID} ${OTHER_TOKEN}`;
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, text);
  const judged = real.lstatSync(lockPath, { bigint: true }),
    claim = `${lockPath}.${judged.ino}.claim`;
  real.mkdirSync(claim);
  expect(materialized(home)).toEqual(heldBy(lockPath));
  expect(readFileSync(lockPath, 'utf8')).toBe(text);
  expect(existsSync(claim)).toBe(true);
  const abandoned = new Date(Date.now() - 20_000);
  utimesSync(claim, abandoned, abandoned);
  expect(materialized(home)).toBe('materialized');
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
// A run that died after its takeover's removal leaves its claim behind. The next run to acquire the lock removes it
// once it is older than the grace, and leaves a younger one, which may still be another run's.
it('sweeps abandoned claims beside the lock once it acquires it, and leaves a young one', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    old = join(parent, '.lock.1-2.claim'),
    young = join(parent, '.lock.3-4.claim');
  mkdirSync(old, { recursive: true });
  mkdirSync(young);
  const abandoned = new Date(Date.now() - 20_000);
  utimesSync(old, abandoned, abandoned);
  expect(materialized(home)).toBe('materialized');
  expect(readdirSync(parent).sort()).toEqual(['.lock.3-4.claim', 'marketplace']);
});
// The claim lasts until the stale lock is gone. Released before the removal, it would let a second run that judged the
// same lock claim it, find the lock's name still on the judged file, and remove the lock this run creates next.
it('removes a stale lock while it still holds its claim, and has released the claim by the time it releases its own lock', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock'),
    text = `${DEAD_PID} ${OTHER_TOKEN}`;
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, text);
  const claim = `${lockPath}.${real.lstatSync(lockPath, { bigint: true }).ino}.claim`,
    removals: unknown[] = [];
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (String(path) === lockPath) removals.push({ removing: standing(lockPath), claimed: real.existsSync(claim) });
    return real.rmSync(path as never, options as never);
  });
  expect(materialized(home)).toBe('materialized');
  expect(removals).toEqual([
    { removing: `file holding ${text}`, claimed: true }, // the takeover
    { removing: expect.stringMatching(new RegExp(`^file holding ${process.pid} `)), claimed: false }, // the release
  ]);
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
// The lock's name is compared with the judged file before the claim and again under it, and the judging descriptor holds
// that file open at both, so its inode cannot pass to a lock another run creates in between and pass the comparison.
it('compares the lock name with the judged file before and again under its claim, holding the judged file open at each', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock');
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, `${DEAD_PID} ${OTHER_TOKEN}`);
  const judged = real.lstatSync(lockPath, { bigint: true }).ino,
    claim = `${lockPath}.${judged}.claim`,
    comparisons: unknown[] = [];
  let judging: number | undefined,
    removed = false;
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const fd = real.openSync(path, flags, mode);
    if (judging === undefined && String(path) === lockPath && flags !== 'wx') judging = fd;
    return fd;
  });
  vi.mocked(lstatSync).mockImplementation(((path: never, options: never) => {
    if (judging !== undefined && !removed && String(path) === lockPath) {
      let open = false;
      try {
        open = real.fstatSync(judging, { bigint: true }).ino === judged;
      } catch {
        /* closed: open stays false */
      }
      comparisons.push({ open, claimed: real.existsSync(claim) });
    }
    return real.lstatSync(path, options);
  }) as never);
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (String(path) === lockPath) removed = true;
    return real.rmSync(path as never, options as never);
  });
  expect(materialized(home)).toBe('materialized');
  expect(removed).toBe(true);
  expect(comparisons).toEqual([
    { open: true, claimed: false },
    { open: true, claimed: true },
  ]);
});
// A claim is abandoned once it is older than 10 seconds, on either side of which these claims lie. The clock stands still
// while each materialize runs, so their ages are exact.
it('removes a claim 11 seconds old as abandoned and takes the stale lock over, and leaves one 9 seconds old with the lock, refusing INSTALL-BUSY', () => {
  const rows: Record<string, readonly [ageMs: number, abandoned: boolean]> = {
    '9 seconds old': [9_000, false],
    '11 seconds old': [11_000, true],
  };
  const text = `${DEAD_PID} ${OTHER_TOKEN}`,
    now = Date.now(),
    seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    for (const [name, [ageMs, abandoned]] of Object.entries(rows)) {
      const home = join(temp(), '.ia'),
        parent = join(home, 'claude'),
        lockPath = join(parent, '.lock');
      mkdirSync(parent, { recursive: true });
      writeFileSync(lockPath, text);
      const claim = `.lock.${real.lstatSync(lockPath, { bigint: true }).ino}.claim`,
        claimedAt = new Date(now - ageMs);
      real.mkdirSync(join(parent, claim));
      utimesSync(join(parent, claim), claimedAt, claimedAt);
      seen[name] = { outcome: materialized(home), left: readdirSync(parent).sort(), lock: standing(lockPath) };
      expected[name] = abandoned
        ? { outcome: 'materialized', left: ['marketplace'], lock: null }
        : { outcome: heldBy(lockPath), left: ['.lock', claim], lock: `file holding ${text}` };
    }
  } finally {
    clock.mockRestore();
  }
  expect(seen).toEqual(expected);
});
// On Windows a lock name another run is removing stays delete-pending briefly, and the exclusive create refuses it
// with a busy code; EBUSY is one on every platform, so this pins the wait everywhere.
it('waits out a lock name the exclusive create finds busy, and then acquires the lock', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock');
  let refused = 0;
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) === lockPath && flags === 'wx' && refused < 2) {
      refused++;
      throw Object.assign(new Error('pending'), { code: 'EBUSY' });
    }
    return real.openSync(path, flags, mode);
  });
  expect(materialized(home)).toBe('materialized');
  expect(refused).toBe(2);
  expect(readdirSync(parent)).toEqual(['marketplace']);
});
// A busy code that outlasts the wait while a file still holds the lock's name is judged like any held lock: here a live
// run's, so the run refuses INSTALL-BUSY rather than INPUT-INVALID.
it('judges the lock at its name like any held lock when the exclusive create stays busy, and refuses INSTALL-BUSY', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock'),
    other = `${process.ppid} ${OTHER_TOKEN}`;
  mkdirSync(parent, { recursive: true });
  writeFileSync(lockPath, other);
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) === lockPath && flags === 'wx') throw Object.assign(new Error('pending'), { code: 'EBUSY' });
    return real.openSync(path, flags, mode);
  });
  expect(materialized(home)).toEqual(heldBy(lockPath));
  expect(readFileSync(lockPath, 'utf8')).toBe(other);
});
// EACCES is a permission code off Windows and a busy one on it, so on every platform a create it keeps refusing, with
// nothing at the lock's name, ends in INPUT-INVALID naming the directory rather than a raw error or INSTALL-BUSY.
it('refuses INPUT-INVALID, naming the directory, when the lock cannot be created and nothing holds its name', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock');
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) === lockPath && flags === 'wx') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return real.openSync(path, flags, mode);
  });
  expect(materialized(home)).toEqual({
    code: 'IA-DIST-INPUT-INVALID',
    message: `${parent} cannot hold the install lock (EACCES); check its permissions`,
  });
  expect(existsSync(lockPath)).toBe(false);
});
// The wait for a busy name, on a clock that moves only while the create waits, and only for a wait that blocks: as the
// real Atomics.wait, the fake returns at once when the value it watches no longer matches. The create backs off from
// 1 ms, doubling to at most 50 ms, while less than 250 ms have passed, so its last wait ends at 263 ms; it then finds
// nothing at the name, creates once more, and refuses INPUT-INVALID with the code the create kept answering.
// watchOpens bounds the creates, so a wait that never ends, or never blocks, fails instead of spinning.
it('backs off a create that stays busy from 1 to 50 ms until 250 ms have passed, creates twice more, and refuses INPUT-INVALID naming the directory', () => {
  const home = join(temp(), '.ia'),
    parent = join(home, 'claude'),
    lockPath = join(parent, '.lock'),
    start = Date.now(),
    waits: { readonly ms: number; readonly blocks: boolean }[] = [],
    creates: number[] = [];
  let clock = start;
  watchOpens(lockPath, {
    before: (exclusive) => {
      if (!exclusive) return;
      creates.push(clock - start);
      throw Object.assign(new Error('pending'), { code: 'EBUSY' });
    },
  });
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock),
    wait = vi.spyOn(Atomics, 'wait').mockImplementation(((
      array: Int32Array,
      index: number,
      value: number,
      ms?: number,
    ) => {
      const blocks = Atomics.load(array, index) === value,
        timeout = ms ?? Number.POSITIVE_INFINITY;
      waits.push({ ms: timeout, blocks });
      if (!blocks) return 'not-equal';
      clock += timeout;
      return 'timed-out';
    }) as never);
  let outcome: unknown;
  try {
    outcome = materialized(home);
  } finally {
    now.mockRestore();
    wait.mockRestore();
  }
  expect({ outcome, waits, creates, left: readdirSync(parent) }).toEqual({
    outcome: {
      code: 'IA-DIST-INPUT-INVALID',
      message: `${parent} cannot hold the install lock (EBUSY); check its permissions`,
    },
    waits: [1, 2, 4, 8, 16, 32, 50, 50, 50, 50].map((ms) => ({ ms, blocks: true })),
    creates: [0, 1, 3, 7, 15, 31, 63, 113, 163, 213, 263, 263],
    left: [],
  });
});
/** plugin-home loaded afresh as it loads on `platform`, where it settles which codes it waits out as busy. */
async function loadedOn(platform: NodeJS.Platform): Promise<typeof import('../src/plugin-home.js')> {
  const actual = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  vi.resetModules();
  Object.defineProperty(process, 'platform', { ...actual, value: platform });
  try {
    return await import('../src/plugin-home.js');
  } finally {
    Object.defineProperty(process, 'platform', actual);
  }
}
// EPERM and EACCES are codes with which Windows refuses an exclusive create at a name another run is still removing, and
// permission problems elsewhere. The module settles which codes are which as it loads, so it is loaded as it loads on each
// platform, wherever this runs: as on Windows, two refusals with either code are waited out and the lock is acquired; as
// on Linux, the first refuses INPUT-INVALID at once.
it('waits out EPERM and EACCES from the exclusive create as on Windows, and refuses each INPUT-INVALID at once as on Linux, wherever it runs', async () => {
  const rows: Record<string, readonly [platform: NodeJS.Platform, code: string, waitedOut: boolean]> = {
    'EPERM, loaded as on Windows': ['win32', 'EPERM', true],
    'EACCES, loaded as on Windows': ['win32', 'EACCES', true],
    'EPERM, loaded as on Linux': ['linux', 'EPERM', false],
    'EACCES, loaded as on Linux': ['linux', 'EACCES', false],
  };
  const seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  for (const [name, [platform, code, waitedOut]] of Object.entries(rows)) {
    const { materializeMarketplace: materialize } = await loadedOn(platform),
      home = join(temp(), '.ia'),
      parent = join(home, 'claude'),
      lockPath = join(parent, '.lock');
    let refused = 0;
    watchOpens(lockPath, {
      before: (exclusive) => {
        if (!exclusive || refused >= 2) return;
        refused++;
        throw Object.assign(new Error('pending'), { code });
      },
    });
    seen[name] = { outcome: materialized(home, materialize), refused, left: readdirSync(parent) };
    expected[name] = waitedOut
      ? { outcome: 'materialized', refused: 2, left: ['marketplace'] }
      : {
          outcome: {
            code: 'IA-DIST-INPUT-INVALID',
            message: `${parent} cannot hold the install lock (${code}); check its permissions`,
          },
          refused: 1,
          left: [],
        };
  }
  expect(seen).toEqual(expected);
});
/** What a materialize (by default this file's import of it) did: the refusal it raised, as its code and message, or `materialized`. */
function materialized(home: string, materialize = materializeMarketplace): unknown {
  try {
    materialize(home, files('0.1.0+aaa'));
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  return 'materialized';
}
const heldBy = (lockPath: string) => ({
  code: 'IA-DIST-INSTALL-BUSY',
  message: `Another ia host --user run holds ${lockPath}; wait for it or delete the file if no run is active`,
});
/** What stands at `path`, read without following a symbolic link or opening a FIFO, or null when nothing does. */
function standing(path: string): string | null {
  const stats = real.lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return null;
  if (stats.isSymbolicLink()) return `symbolic link to ${real.readlinkSync(path)}`;
  if (stats.isFIFO()) return 'FIFO';
  return `file holding ${real.readFileSync(path, 'utf8')}`;
}
// The sequence the live-owner rule closes, with both runs in this process, so both pids are alive. Run A holds the lock
// and has held it for eleven minutes. Run B used to take it over by age; A's release then removed B's lock by name, and
// a run C acquired it while B was still active. B now refuses INSTALL-BUSY, A's lock stays as A wrote it, and A goes on
// to finish and release it, so a run after A acquires it.
it('refuses INSTALL-BUSY for the lock of a live run held past the old 10 minutes, and leaves that run to release it', () => {
  const home = join(temp(), '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    stage = join(home, 'claude', '.stage-'),
    elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
  let b: unknown, held: string | undefined, kept: string | null | undefined;
  // A makes its stage once it holds the lock; B runs just before, so nothing of A's stage exists for B to touch.
  vi.mocked(mkdirSync).mockImplementation(((path: never, options: never) => {
    if (b === undefined && String(path).startsWith(stage)) {
      b = 'running'; // so B's own stage, should B get that far, is not intercepted
      held = real.readFileSync(lockPath, 'utf8');
      real.utimesSync(lockPath, elevenMinutesAgo, elevenMinutesAgo);
      b = materialized(home);
      kept = real.existsSync(lockPath) ? real.readFileSync(lockPath, 'utf8') : null;
    }
    return real.mkdirSync(path, options);
  }) as never);
  const a = materialized(home);
  expect({ a, b, kept }).toEqual({ a: 'materialized', b: heldBy(lockPath), kept: held });
  expect(existsSync(lockPath)).toBe(false); // A released its own lock
  expect(materialized(home)).toBe('materialized'); // and a run after A acquires it
});
/**
 * Runs A, a materialize whose own lock is moved aside to `aside` once A holds it, after which `replace` puts something
 * at the lock path; then runs C. Returns what A did, what A left at the lock path, what C did and any open of a FIFO
 * there that could block (watchOpens refuses and records one), with what each should be: A goes ahead and leaves the
 * replacement in place, and C waits for it, or goes ahead when nothing was put there.
 */
function releaseAfterReplacement(
  replace: (lockPath: string, aside: string) => void,
  fifo = false,
): { readonly seen: unknown; readonly expected: unknown } {
  const root = temp(),
    home = join(root, '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    aside = join(root, 'a.lock');
  let placed: string | null | undefined;
  vi.mocked(mkdirSync).mockImplementation(((path: never, options: never) => {
    if (placed === undefined && String(path).startsWith(join(home, 'claude', '.stage-'))) {
      real.renameSync(lockPath, aside); // moved aside rather than removed, as a run taking it over might leave it
      replace(lockPath, aside);
      placed = standing(lockPath);
    }
    return real.mkdirSync(path, options);
  }) as never);
  const { blocked } = watchOpens(lockPath, { fifo });
  const a = materialized(home);
  return {
    seen: { a, left: standing(lockPath), c: materialized(home), blocked },
    expected: { a: 'materialized', left: placed, c: placed === null ? 'materialized' : heldBy(lockPath), blocked: [] },
  };
}
// Whatever replaced run A's lock while A ran is still at the lock path when A ends: A's release removes only the lock A
// wrote, judged through one descriptor as a held lock is. Before, A's release removed whatever held the name, so a run C
// after A acquired a lock whose holder was still active. A pid alone is what an older CLI writes.
it('releases only the lock it wrote, leaving whatever replaced it for the next run to find', () => {
  const live = String(process.pid);
  const replacements: Record<string, (lockPath: string, aside: string) => void> = {
    'the lock of another run: this pid with another token': (lockPath) =>
      real.writeFileSync(lockPath, `${live} ${OTHER_TOKEN}`, { flag: 'wx' }),
    'the lock of an older CLI: this pid alone': (lockPath) => real.writeFileSync(lockPath, live, { flag: 'wx' }),
    'the bytes of A followed by a newline': (lockPath, aside) =>
      real.writeFileSync(lockPath, `${real.readFileSync(aside, 'utf8')}\n`, { flag: 'wx' }),
    'nothing: removed by hand': () => {},
  };
  const seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  for (const [name, replace] of Object.entries(replacements)) {
    const result = releaseAfterReplacement(replace);
    seen[name] = result.seen;
    expected[name] = result.expected;
  }
  expect(seen).toEqual(expected);
});
// The release never waits on a FIFO that replaced the lock. Skipped on Windows, where no FIFO can be created in a
// directory (a skip tools/testing/tasks.json declares).
it.skipIf(process.platform === 'win32')(
  'releases only the lock it wrote, leaving a FIFO that replaced it in place without waiting on it',
  async () => {
    const fifo = join(temp(), 'fifo');
    expect((await runBounded('mkfifo', [fifo], { timeoutMs: SUBPROCESS })).status).toBe(0);
    const { seen, expected } = releaseAfterReplacement((lockPath) => real.renameSync(fifo, lockPath), true);
    expect(seen).toEqual(expected);
  },
);
// The release never follows a symbolic link to this run's own lock: off Windows O_NOFOLLOW refuses it, and on Windows
// the identity check does. Skipped only where Windows denies file symbolic link creation (EPERM), a skip
// tools/testing/tasks.json declares.
it('releases only the lock it wrote, leaving a symbolic link to it that replaced it in place', (context) => {
  const probe = temp();
  if (!fileSymlink(join(probe, 'probe'), join(probe, 'probe-link')))
    return context.skip('Windows denied file symlink creation (EPERM)');
  const { seen, expected } = releaseAfterReplacement((lockPath, aside) => real.symlinkSync(aside, lockPath, 'file'));
  expect(seen).toEqual(expected);
});
// The release's identity check. Right after the release opens this run's lock, the lock is moved aside and a copy of it,
// holding this run's exact bytes, takes its name. The opened file passes every other check, so only comparing the name
// with the opened descriptor (dev and ino) keeps the release from removing the copy. Off Windows a symbolic link never
// reaches that comparison, as O_NOFOLLOW refuses it first, so this case is what holds it there.
it('leaves in place a file holding its own bytes that takes the lock path while its release judges the lock', () => {
  const root = temp(),
    home = join(root, '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    copy = join(root, 'copy.lock');
  let swapped = false,
    copied: bigint | undefined,
    own = '';
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const fd = real.openSync(path, flags, mode);
    // Only the release opens the free lock path with numeric flags: the acquire's exclusive open passes 'wx'.
    if (!swapped && String(path) === lockPath && typeof flags === 'number') {
      swapped = true; // set first: given options with no encoding, the real writeFileSync below opens through this stub
      own = real.readFileSync(lockPath, 'utf8');
      real.writeFileSync(copy, own, { flag: 'wx' });
      // Moved aside rather than removed, so its name is free on every platform while the release still holds it open.
      real.renameSync(lockPath, join(root, 'released.lock'));
      real.renameSync(copy, lockPath);
      copied = real.statSync(lockPath, { bigint: true }).ino;
    }
    return fd;
  });
  const a = materialized(home);
  expect(swapped).toBe(true);
  expect({
    a,
    named: real.statSync(lockPath, { bigint: true, throwIfNoEntry: false })?.ino === copied,
    left: standing(lockPath),
  }).toEqual({ a: 'materialized', named: true, left: `file holding ${own}` });
  expect(materialized(home)).toEqual(heldBy(lockPath)); // the copy names a live pid, so the next run waits for it
});
// A run writes its pid, a space and a token of its own. The pid comes first, so a reader that parses only a leading pid,
// as an older CLI and the takeover's bounded read do, still finds it; the token tells this run's lock from that of any
// other run, even one in the same process. Its own release removes it, after a materialize and after a removal alike.
it('writes its pid and a token of its own to the lock, and its own release removes it', () => {
  const home = join(temp(), '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    during: string[] = [],
    after: boolean[] = [];
  // Only the marketplace's own renames, made beside the lock while it is held; the IA home is written before that.
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (dirname(String(to)) === dirname(lockPath)) during.push(real.readFileSync(lockPath, 'utf8'));
    return real.renameSync(from as never, to as never);
  });
  expect(materialized(home)).toBe('materialized'); // one rename: the stage swapped in
  after.push(existsSync(lockPath));
  expect(materialized(home)).toBe('materialized'); // two: the previous copy demoted, then the swap
  after.push(existsSync(lockPath));
  expect(removeMarketplace(home)).toBe(true); // one: the marketplace renamed away
  after.push(existsSync(lockPath));
  const own = new RegExp(`^${process.pid} [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
  expect(during).toHaveLength(4);
  for (const text of during) expect(text).toMatch(own);
  expect(during[1]).toBe(during[2]); // one run, one token
  expect(new Set([during[0], during[1], during[3]]).size).toBe(3); // each run its own
  expect(after).toEqual([false, false, false]);
});
// The race CodeQL js/file-system-race flags: another run takes the stale lock over just after this run first looks at
// it, and writes its own. This run must judge only the file it looked at, and its identity check must then keep it from
// removing the lock that took the name. (A replacement after that check, just before the removal, is the window that
// remains: Node has no unlink-if-same.)
it('keeps a fresh lock that replaced the stale one while it was judged, and refuses INSTALL-BUSY', () => {
  const root = temp(),
    home = join(root, '.ia'),
    lockPath = join(home, 'claude', '.lock');
  mkdirSync(join(home, 'claude'), { recursive: true });
  writeFileSync(lockPath, DEAD_PID);
  const past = new Date(Date.now() - 20 * 60_000);
  utimesSync(lockPath, past, past);
  let replaced = false,
    fresh: bigint | undefined;
  const replace = (path: unknown): void => {
    if (replaced || String(path) !== lockPath) return;
    // Set first: given options with no encoding, the real writeFileSync below opens through the openSync stub.
    replaced = true;
    // Moved aside rather than removed, so its name is free on every platform while this run still holds it open.
    real.renameSync(lockPath, join(root, 'judged.lock'));
    real.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    fresh = real.statSync(lockPath, { bigint: true }).ino;
  };
  // Whichever call makes this run's first look at the held lock, the other run replaces it right after.
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const fd = real.openSync(path, flags, mode);
    replace(path);
    return fd;
  });
  vi.mocked(statSync).mockImplementation(((path: never, options: never) => {
    const stats = real.statSync(path, options);
    replace(path);
    return stats;
  }) as never);
  const outcome = materialized(home);
  expect(fresh).toBeDefined(); // the other run did replace the lock
  expect(outcome).toEqual(heldBy(lockPath));
  expect(real.statSync(lockPath, { bigint: true }).ino).toBe(fresh);
  expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
// The other half of judging one file: the pid and the age are the opened lock's. In each row, right after this run opens
// the held lock, a stale-looking lock takes its name. In the first, the opened lock is live and young and the
// swapped-in one holds a dead pid, 20 minutes old, so a pid read by name would make the opened lock look stale. In the
// second, neither holds a pid, so only their ages tell them apart: the opened lock is 5 seconds old, inside the grace,
// and the swapped-in one 20 seconds old, past it, so an age read by name would make the opened lock look stale. Either
// way the identity check would then refuse to remove it, and the retry would take the swapped-in lock over and go ahead.
it('judges the pid and age of the lock it opened, not of a stale-looking lock swapped in at its name, and refuses INSTALL-BUSY at once', () => {
  const rows: Record<
    string,
    readonly [opened: string, openedAgeMs: number, swappedIn: string, swappedInAgeMs: number]
  > = {
    'a live pid just written, then a dead pid 20 minutes old': [String(process.pid), 0, DEAD_PID, 20 * 60_000],
    'no pid, 5 seconds old, then no pid, 20 seconds old': ['', 5_000, '', 20_000],
  };
  const seen: Record<string, unknown> = {},
    expected: Record<string, unknown> = {};
  for (const [name, [openedText, openedAgeMs, swappedText, swappedAgeMs]] of Object.entries(rows)) {
    const root = temp(),
      home = join(root, '.ia'),
      lockPath = join(home, 'claude', '.lock');
    mkdirSync(join(home, 'claude'), { recursive: true });
    writeFileSync(lockPath, openedText);
    const openedAt = new Date(Date.now() - openedAgeMs);
    utimesSync(lockPath, openedAt, openedAt);
    let swapping = false,
      swapped: bigint | undefined,
      opened = 0;
    const swap = (path: unknown): void => {
      if (swapping || swapped !== undefined || String(path) !== lockPath) return;
      swapping = true; // given options with no encoding, the real writeFileSync below opens through the openSync stub
      try {
        // Moved aside rather than removed, so its name is free on every platform while this run still holds it open.
        real.renameSync(lockPath, join(root, 'opened.lock'));
        real.writeFileSync(lockPath, swappedText, { flag: 'wx' });
        const past = new Date(Date.now() - swappedAgeMs);
        real.utimesSync(lockPath, past, past);
        swapped = real.statSync(lockPath, { bigint: true }).ino;
      } finally {
        swapping = false;
      }
    };
    // Whichever call makes this run's first look at the held lock, the swap comes right after it.
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = real.openSync(path, flags, mode);
      if (!swapping && String(path) === lockPath) opened++;
      swap(path);
      return fd;
    });
    vi.mocked(statSync).mockImplementation(((path: never, options: never) => {
      const stats = real.statSync(path, options);
      swap(path);
      return stats;
    }) as never);
    const outcome = materialized(home);
    seen[name] = {
      outcome,
      opened, // judged once: busy on its first look, never retried
      named: swapped !== undefined && real.statSync(lockPath, { bigint: true, throwIfNoEntry: false })?.ino === swapped,
      left: standing(lockPath),
      plugin: inspectMaterializedPlugin(home),
    };
    expected[name] = {
      outcome: heldBy(lockPath),
      opened: 1,
      named: true,
      left: `file holding ${swappedText}`,
      plugin: { state: 'absent' },
    };
  }
  expect(seen).toEqual(expected);
});
// The lock is only ever created as a regular file, so a symbolic link at its path was put there. Followed, this one would
// read as a long-dead lock (a dead pid, 20 minutes old) and be removed. Off Windows it is never even opened through
// (O_NOFOLLOW); on Windows the open follows it, and the identity check, which compares the link itself, refuses it.
// Skipped only where Windows denies file symbolic link creation (EPERM), a skip tools/testing/tasks.json declares.
it('refuses INSTALL-BUSY for a symbolic link at the lock path, changing neither the link nor its target', (context) => {
  const root = temp(),
    home = join(root, '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    target = join(root, 'elsewhere.lock');
  mkdirSync(join(home, 'claude'), { recursive: true });
  writeFileSync(target, DEAD_PID);
  const past = new Date(Date.now() - 20 * 60_000);
  utimesSync(target, past, past);
  if (!fileSymlink(target, lockPath)) return context.skip('Windows denied file symlink creation (EPERM)');
  const before = real.statSync(target, { bigint: true });
  const opens = watchOpens(lockPath);
  expect(materialized(home)).toEqual(heldBy(lockPath));
  if (process.platform !== 'win32') expect(opens.opened(), 'opens through the link').toBe(0);
  expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  expect(real.statSync(lockPath, { bigint: true }).ino).toBe(before.ino); // the link still names its target
  const after = real.statSync(target, { bigint: true });
  expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
  expect(readFileSync(target, 'utf8')).toBe(DEAD_PID);
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
// The identity check compares the lock path itself, never what a symbolic link there names. Here, right after this run
// opens a stale lock, the lock is moved aside and a symbolic link to it takes its name: a check that followed the link
// would find the very file it judged and remove the link in its place. Skipped only where Windows denies file symbolic
// link creation (EPERM), a skip tools/testing/tasks.json declares.
it('refuses INSTALL-BUSY when a symbolic link to the judged lock replaces it while it is judged, keeping the link', (context) => {
  const root = temp(),
    home = join(root, '.ia'),
    lockPath = join(home, 'claude', '.lock'),
    aside = join(root, 'judged.lock');
  mkdirSync(join(home, 'claude'), { recursive: true });
  if (!fileSymlink(join(root, 'probe'), join(root, 'probe-link')))
    return context.skip('Windows denied file symlink creation (EPERM)');
  writeFileSync(lockPath, DEAD_PID);
  const past = new Date(Date.now() - 20 * 60_000);
  utimesSync(lockPath, past, past);
  let swapped = false;
  watchOpens(lockPath, {
    after: () => {
      if (swapped) return;
      swapped = true;
      // Moved aside rather than removed, so its name is free on every platform while this run still holds it open.
      real.renameSync(lockPath, aside);
      real.symlinkSync(aside, lockPath, 'file');
    },
  });
  expect(materialized(home)).toEqual(heldBy(lockPath));
  expect(swapped).toBe(true);
  expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  expect(real.statSync(lockPath, { bigint: true }).ino).toBe(real.statSync(aside, { bigint: true }).ino);
  expect(readFileSync(aside, 'utf8')).toBe(DEAD_PID);
  expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
});
// A FIFO at the lock path hung the takeover's read until a writer came. It is judged by its type alone: never read,
// never removed, though it is old enough that a regular file there would be taken over. watchOpens refuses and records
// any open or read of it that could block, so a regression fails at once rather than hanging the worker, even a full
// revert to the readFileSync of the old takeover. Skipped on Windows, where no FIFO can be created in a directory
// (a skip tools/testing/tasks.json declares).
it.skipIf(process.platform === 'win32')(
  'refuses INSTALL-BUSY for a FIFO at the lock path without hanging, and leaves it in place',
  async () => {
    const home = join(temp(), '.ia'),
      lockPath = join(home, 'claude', '.lock');
    mkdirSync(join(home, 'claude'), { recursive: true });
    expect((await runBounded('mkfifo', [lockPath], { timeoutMs: SUBPROCESS })).status).toBe(0);
    const past = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, past, past);
    const { blocked } = watchOpens(lockPath, { fifo: true });
    const outcome = materialized(home);
    expect(blocked, 'opens or reads of the FIFO that could block').toEqual([]);
    expect(outcome).toEqual(heldBy(lockPath));
    expect(lstatSync(lockPath).isFIFO()).toBe(true);
    expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
  },
);
// Run A releases its lock just as this run's exclusive open meets it, so the lock is gone by the takeover's open. That
// is a reason to retry the exclusive open, which now succeeds, and never to refuse INSTALL-BUSY.
it('retries and goes ahead when the held lock is released just before the takeover opens it', () => {
  const home = join(temp(), '.ia'),
    lockPath = join(home, 'claude', '.lock');
  mkdirSync(join(home, 'claude'), { recursive: true });
  writeFileSync(lockPath, String(process.pid)); // live and just written: judged, it would be busy
  let released = false;
  watchOpens(lockPath, {
    before: (exclusive) => {
      if (exclusive || released) return;
      released = true;
      real.rmSync(lockPath);
    },
  });
  expect(materialized(home)).toBe('materialized');
  expect(released).toBe(true);
  expect(readMaterializedPlugin(home)?.version).toBe('0.1.0+aaa');
  expect(existsSync(lockPath)).toBe(false); // this run's own lock, released after its materialize
});
// Every verdict closes the descriptor it judged: whatever stands at the lock path, a materialize ends holding the
// descriptors it began with. /dev/fd lists this process's descriptors on Linux and macOS; Windows has none to count, so
// the case is skipped there (a skip tools/testing/tasks.json declares).
it.skipIf(process.platform === 'win32')(
  'closes the descriptor it judged, whether the lock is a FIFO, stale, live or a symbolic link',
  async () => {
    const past = new Date(Date.now() - 20 * 60_000),
      count = () => real.readdirSync('/dev/fd').length;
    const arrange: Record<string, (lockPath: string, root: string) => Promise<unknown> | void> = {
      FIFO: async (lockPath) => {
        expect((await runBounded('mkfifo', [lockPath], { timeoutMs: SUBPROCESS })).status).toBe(0);
      },
      stale: (lockPath) => {
        writeFileSync(lockPath, DEAD_PID);
        utimesSync(lockPath, past, past);
      },
      live: (lockPath) => writeFileSync(lockPath, String(process.pid)),
      'symbolic link': (lockPath, root) => {
        writeFileSync(join(root, 'elsewhere.lock'), DEAD_PID);
        symlinkSync(join(root, 'elsewhere.lock'), lockPath);
      },
    };
    materialized(join(temp(), '.ia')); // a first materialize, so nothing set up once per process is counted below
    const seen: Record<string, unknown> = {},
      expected: Record<string, unknown> = {};
    for (const [name, setUp] of Object.entries(arrange)) {
      const root = temp(),
        home = join(root, '.ia'),
        lockPath = join(home, 'claude', '.lock');
      mkdirSync(join(home, 'claude'), { recursive: true });
      await setUp(lockPath, root);
      const { blocked } = watchOpens(lockPath, { fifo: name === 'FIFO' });
      const before = count();
      materialized(home);
      seen[name] = { leaked: count() - before, blocked };
      expected[name] = { leaked: 0, blocked: [] };
    }
    expect(seen).toEqual(expected);
  },
);
// A lock this run cannot open is never judged, so never taken over however old it is: it ends INSTALL-BUSY, untouched.
// Skipped on Windows, where a file mode only sets the read-only attribute, which does not stop its owner opening it to
// read (a skip tools/testing/tasks.json declares).
it.skipIf(process.platform === 'win32')(
  'refuses INSTALL-BUSY for an old lock it cannot open, leaving it untouched',
  () => {
    if (process.getuid?.() === 0) return; // no mode denies root, and the skip gate has no condition for it
    const home = join(temp(), '.ia'),
      lockPath = join(home, 'claude', '.lock');
    mkdirSync(join(home, 'claude'), { recursive: true });
    writeFileSync(lockPath, DEAD_PID);
    const past = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, past, past);
    real.chmodSync(lockPath, 0o000);
    try {
      const before = real.statSync(lockPath, { bigint: true });
      watchOpens(lockPath);
      expect(materialized(home)).toEqual(heldBy(lockPath));
      const after = real.statSync(lockPath, { bigint: true });
      expect([after.ino, after.size, after.mtimeNs, after.mode]).toEqual([
        before.ino,
        before.size,
        before.mtimeNs,
        before.mode,
      ]);
    } finally {
      real.chmodSync(lockPath, 0o600);
    }
    expect(readFileSync(lockPath, 'utf8')).toBe(DEAD_PID);
    expect(inspectMaterializedPlugin(home)).toEqual({ state: 'absent' });
  },
);
