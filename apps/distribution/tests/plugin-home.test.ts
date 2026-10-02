import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// Every busy/failure test overrides renameSync and/or rmSync; put both back to a plain passthrough so later tests see the real filesystem.
afterEach(() => {
  vi.mocked(renameSync).mockImplementation((from, to) => real.renameSync(from as never, to as never));
  vi.mocked(rmSync).mockImplementation((path, options) => real.rmSync(path as never, options as never));
});
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
// everywhere (#315): on macOS the second write used to collide with a raw EEXIST after the first had been written.
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
  // APFS also folds full Unicode case, so these are one path on a Mac too (#323).
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
  let caught: unknown;
  try {
    materializeMarketplace(home, files('0.1.0+aaa'));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-INSTALL-BUSY');
  expect((caught as Error).message).toMatch(/Another ia host --user run holds/);
}, 5000);
