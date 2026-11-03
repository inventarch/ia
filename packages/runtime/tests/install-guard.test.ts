import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MethodError, kitInstallMatches, kitInstallation, requireKitInstalled } from '../src/method/index.js';

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
