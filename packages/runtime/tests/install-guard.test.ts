import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MethodError,
  kitInstallMatches,
  kitInstallation,
  methodRefusal,
  requireKitInstalled,
  resolveMethod,
} from '../src/method/index.js';

/** Which kits a repository's own lock installs: presence is one question, identity another. */
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-install-guard-')));
  mkdirSync(join(dir, '.ia', 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KIT = 'inventarch/ia-kb-kit';
const ARCHIVE = 'd'.repeat(64);
const OTHER = 'e'.repeat(64);
const lockPath = (): string => join(dir, '.ia', 'distributions.lock.json');
const writeLock = (value: unknown): void =>
  writeFileSync(lockPath(), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const lockWith = (extra: { packages?: unknown[]; entries?: unknown[] }): unknown => ({
  formatVersion: 1,
  engine: '^0.1.2',
  requests: [],
  packages: [],
  ...extra,
});
const carrier = (kits: unknown[]): unknown => ({
  kind: 'package',
  name: '@inventarch/public-kits',
  version: '1.0.0',
  integrity: `sha512-${'E'.repeat(86)}==`,
  kits,
});
const codeOf = (action: () => void): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof MethodError ? error.code : `other:${String(error)}`;
  }
  return undefined;
};

describe('requireKitInstalled', () => {
  it('a packages row installs', () => {
    writeLock(lockWith({ packages: [{ id: KIT, version: '0.9.0', archive: ARCHIVE }] }));
    expect(() => requireKitInstalled(dir, { id: KIT })).not.toThrow();
    expect(kitInstallation(dir, KIT)).toEqual({ via: 'package', version: '0.9.0', archive: ARCHIVE });
  });
  it('an entries package carrier row naming the kit installs', () => {
    writeLock(lockWith({ entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] }));
    expect(() => requireKitInstalled(dir, { id: KIT })).not.toThrow();
    expect(kitInstallation(dir, KIT)).toEqual({ via: 'entry', version: '0.9.0', archive: ARCHIVE });
  });
  it('presence ignores the archive: an entries row with another archive for the id still counts as installed', () => {
    writeLock(lockWith({ entries: [carrier([{ id: KIT, version: '0.9.0', archive: OTHER }])] }));
    expect(() => requireKitInstalled(dir, { id: KIT })).not.toThrow();
  });
  it('installed at another version than the one resolved is still installed (the retained pin keeps running)', () => {
    writeLock(lockWith({ packages: [{ id: KIT, version: '1.2.0', archive: ARCHIVE }] }));
    expect(() => requireKitInstalled(dir, { id: KIT })).not.toThrow();
  });
  it('a row for another kit does not install this one', () => {
    writeLock(lockWith({ packages: [{ id: 'inventarch/other-kit', version: '0.9.0', archive: ARCHIVE }] }));
    expect(codeOf(() => requireKitInstalled(dir, { id: KIT }))).toBe('IA-CORE-KIT-NOT-INSTALLED');
    expect(kitInstallation(dir, KIT)).toBeNull();
  });
  it('a carrier row that is not a package carrier installs nothing', () => {
    writeLock(
      lockWith({
        entries: [{ ...(carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }]) as object), kind: 'file' }],
      }),
    );
    expect(codeOf(() => requireKitInstalled(dir, { id: KIT }))).toBe('IA-CORE-KIT-NOT-INSTALLED');
  });
  it('no lock at all is not installed', () => {
    expect(codeOf(() => requireKitInstalled(dir, { id: KIT }))).toBe('IA-CORE-KIT-NOT-INSTALLED');
    expect(kitInstallation(dir, KIT)).toBeNull();
  });
  it('an unreadable lock refuses as corrupt, not as not-installed', () => {
    writeLock('{ not json');
    expect(() => requireKitInstalled(dir, { id: KIT })).toThrow(SyntaxError);
  });
  it('the error code is IA-CORE-KIT-NOT-INSTALLED, not IA-CORE-PIN-UNAVAILABLE, and names the kit and the remedy', () => {
    writeLock(lockWith({}));
    let thrown: unknown;
    try {
      requireKitInstalled(dir, { id: KIT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MethodError);
    const error = thrown as MethodError;
    expect(error.code).toBe('IA-CORE-KIT-NOT-INSTALLED');
    expect(error.code).not.toBe('IA-CORE-PIN-UNAVAILABLE');
    expect(error.message).toBe(
      `kit ${KIT} is bound by this repository but its lock does not install it; run ia install ${KIT} (or kit.mjs add ${KIT}), then resolve again`,
    );
  });
});

describe('kitInstallMatches', () => {
  it('is false for another archive or version and true for the row’s own, and never throws', () => {
    writeLock(lockWith({ packages: [{ id: KIT, version: '0.9.0', archive: ARCHIVE }] }));
    expect(kitInstallMatches(dir, { id: KIT, version: '0.9.0', archive: ARCHIVE })).toBe(true);
    expect(kitInstallMatches(dir, { id: KIT, version: '0.9.0', archive: OTHER })).toBe(false);
    expect(kitInstallMatches(dir, { id: KIT, version: '0.8.0', archive: ARCHIVE })).toBe(false);
    expect(kitInstallMatches(dir, { id: 'inventarch/none', version: '0.9.0', archive: ARCHIVE })).toBe(false);
  });
  it('compares an entries row the same way', () => {
    writeLock(lockWith({ entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] }));
    expect(kitInstallMatches(dir, { id: KIT, version: '0.9.0', archive: ARCHIVE })).toBe(true);
    expect(kitInstallMatches(dir, { id: KIT, version: '0.9.0', archive: OTHER })).toBe(false);
  });
});

/** Bound execution: the door's resolve refuses a bound kit the lock does not install, before anything is retained. */
describe('resolveMethod with a bound kit', () => {
  const NOT_INSTALLED = 'IA-CORE-KIT-NOT-INSTALLED';
  const REACHED = 'the restore was reached';
  let bundled: string, home: string, store: string, cache: string, runRoot: string;
  const write = (path: string, value: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const kitFolder = (at: string): void => {
    write(join(at, '.ia', 'release.json'), { id: KIT, version: '0.9.0' });
    write(join(at, 'releases.json'), { kit: KIT, releases: [{ version: '0.9.0', archive: ARCHIVE, records: [] }] });
  };
  beforeEach(() => {
    bundled = join(dir, 'bundled');
    home = join(dir, 'home');
    store = join(dir, 'closures');
    cache = join(dir, 'cache');
    runRoot = join(dir, 'run');
    kitFolder(join(bundled, 'ia-kb'));
    write(join(dir, '.ia', 'bindings.json'), {
      format: 1,
      bindings: { 'knowledge.find': { kit: KIT, capability: 'kb-retrieve' } },
    });
  });
  /** Every file under the paths, by content hash: the same before and after a refusal that wrote nothing. */
  const snapshot = (): Record<string, string> => {
    const seen: Record<string, string> = {};
    const walk = (path: string): void => {
      if (!existsSync(path)) {
        seen[path] = 'absent';
        return;
      }
      if (statSync(path).isDirectory()) {
        seen[path] = 'dir';
        for (const name of readdirSync(path)) walk(join(path, name));
        return;
      }
      seen[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
    };
    for (const path of [dir, store, cache, home, runRoot]) walk(path);
    return seen;
  };
  let restored = 0;
  const resolve = (extra: { rebind?: boolean } = {}): { code: string; message: string } | 'resolved' => {
    restored = 0;
    try {
      resolveMethod(
        { entry: 'knowledge', activity: 'find', root: dir, pin: true, ...extra },
        {
          kits: { bundled, home: null },
          restore: () => {
            restored++;
            throw new Error(REACHED);
          },
          env: { IA_HOME: home, IA_CORE_RUN_ROOT: runRoot },
          store,
          cache,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === REACHED) return { code: REACHED, message: REACHED };
      return methodRefusal(error).error;
    }
    return 'resolved';
  };
  const unrelated = { packages: [{ id: 'inventarch/other-kit', version: '1.0.0', archive: OTHER }] };

  it('refuses a bound kit with no lock row before retaining it, restoring it or writing a pin', () => {
    writeLock(lockWith(unrelated));
    mkdirSync(store);
    const before = snapshot();
    expect(resolve()).toMatchObject({ code: NOT_INSTALLED, message: expect.stringContaining(KIT) });
    expect(restored).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(store)).toEqual([]);
    expect(existsSync(join(runRoot, 'binding.json'))).toBe(false);
    expect(resolve({ rebind: true })).toMatchObject({ code: NOT_INSTALLED });
    expect(snapshot()).toEqual(before);
  });
  it('refuses when the repository has no lock at all', () => {
    const before = snapshot();
    expect(resolve()).toMatchObject({ code: NOT_INSTALLED });
    expect(snapshot()).toEqual(before);
  });
  it('a kit that exists only as an IA-home copy refuses, with no fallback to it', () => {
    rmSync(join(bundled, 'ia-kb'), { recursive: true });
    kitFolder(join(home, 'kits', 'ia-kb', '0.9.0'));
    writeLock(lockWith(unrelated));
    const before = snapshot();
    expect(resolve()).toMatchObject({ code: NOT_INSTALLED });
    expect(restored).toBe(0);
    expect(snapshot()).toEqual(before);
  });
  it('a packages row or a carrier entries row installs: the guard lets the kit through to its own steps', () => {
    writeLock(lockWith({ packages: [{ id: KIT, version: '0.9.0', archive: ARCHIVE }] }));
    expect(resolve()).toMatchObject({ code: REACHED });
    expect(restored).toBe(1);
    rmSync(store, { recursive: true, force: true });
    writeLock(lockWith({ entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] }));
    expect(resolve()).not.toMatchObject({ code: NOT_INSTALLED });
  });
  describe('a task that already pins the kit', () => {
    const pin = (version: string, extra: Record<string, unknown> = {}): void =>
      write(join(runRoot, 'binding.json'), {
        format: 3,
        revision: 1,
        workspace: { root: dir, revision: 'r' },
        task: null,
        kits: {
          [KIT]: {
            version,
            archive: ARCHIVE,
            sources: 's'.repeat(64),
            implementation: 'i'.repeat(64),
            retained: 'f'.repeat(64),
            ...extra,
          },
        },
        keys: { 'knowledge.find': { kit: KIT, capability: 'kb-retrieve', profile: null } },
        supersedes: null,
      });
    it('refuses when the lock no longer installs its kit, and the pin is left as it was', () => {
      pin('0.9.0');
      writeLock(lockWith(unrelated));
      const before = snapshot();
      expect(resolve()).toMatchObject({ code: NOT_INSTALLED });
      expect(resolve({ rebind: true })).toMatchObject({ code: NOT_INSTALLED });
      expect(snapshot()).toEqual(before);
    });
    it('an unrelated field change does not turn the refusal into a pass', () => {
      pin('0.9.0', { implementation: '0'.repeat(64) });
      writeLock(lockWith(unrelated));
      expect(resolve()).toMatchObject({ code: NOT_INSTALLED });
    });
    it('a pin older than the installed version is not refused by the guard: it goes on to its retained bytes', () => {
      pin('0.1.0');
      writeLock(lockWith({ packages: [{ id: KIT, version: '9.9.9', archive: ARCHIVE }] }));
      expect(resolve()).toMatchObject({ code: 'IA-CORE-CLOSURE-MISSING' });
    });
  });
  it('the unbound route needs no lock row', () => {
    let code: string | null = null;
    try {
      resolveMethod(
        { entry: 'knowledge', activity: 'find', root: join(dir, '..'), kit: KIT, capability: 'kb-retrieve' },
        {
          kits: { bundled, home: null },
          restore: () => {
            throw new Error(REACHED);
          },
          env: { IA_HOME: home },
          store,
          cache,
        },
      );
    } catch (error) {
      code = methodRefusal(error).error.code;
    }
    expect(code).not.toBe(NOT_INSTALLED);
  });
});
