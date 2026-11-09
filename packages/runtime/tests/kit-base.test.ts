import { describe, expect, it } from 'vitest';
import { selectKitBase } from '../src/method/kit-base.js';
import type { BasePin } from '../src/method/kit-base.js';

/**
 * The one rule a reader uses to choose the language base it restores a kit's read root with: the locked archive when it
 * carries it, else its newest base when that is the same major, not older than the lock, and admitted by the kit's range.
 */
const ID = 'inventarch/language';
const pin = (version: string, letter: string): BasePin => ({
  id: ID,
  version,
  archive: letter.repeat(64),
  manifest: letter.toUpperCase().repeat(64),
});
const B300 = pin('3.0.0', 'a');
const B320 = pin('3.2.0', 'b');
const B321 = pin('3.2.1', 'c');
const UNCARRIED = 'd'.repeat(64);
const locked = (version: string, archive: string, requests?: { id: string; range: string }[]) => ({
  packages: [
    { id: 'inventarch/other-kit', version: '1.0.0', archive: 'e'.repeat(64) },
    { id: ID, version, archive },
  ],
  ...(requests === undefined ? {} : { requests }),
});
const refusal = (run: () => unknown): { code: string; message: string } => {
  try {
    run();
  } catch (error) {
    return { code: (error as { code: string }).code, message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('selectKitBase', () => {
  it('exact when the locked archive is carried', () => {
    expect(selectKitBase(locked('3.2.0', B320.archive), '^3.2.0', [B300, B320, B321])).toEqual({
      base: B320,
      use: {
        locked: { version: '3.2.0', archive: B320.archive },
        effective: { version: '3.2.0', archive: B320.archive },
        mode: 'exact',
      },
    });
    // An older carried base is still used exactly: the newest is used only when the lock's archive is not carried.
    expect(selectKitBase(locked('3.0.0', B300.archive), undefined, [B300, B320, B321]).base).toBe(B300);
  });

  it('exact by digest even when the label disagrees', () => {
    // Identity is the archive digest: a stale or hand-edited label never sends the kit to another base or refuses it.
    const chosen = selectKitBase(locked('9.0.0', B300.archive), '^9.0.0', [B300, B320, B321]);
    expect(chosen.base).toBe(B300);
    expect(chosen.use).toEqual({
      locked: { version: '9.0.0', archive: B300.archive },
      effective: { version: '3.0.0', archive: B300.archive },
      mode: 'exact',
    });
  });

  it('compatible: locked 3.2.0 under an uncarried archive, carried newest 3.2.1', () => {
    expect(selectKitBase(locked('3.2.0', UNCARRIED, [{ id: ID, range: '^3.2.0' }]), '^3.2.0', [B300, B321])).toEqual({
      base: B321,
      use: {
        locked: { version: '3.2.0', archive: UNCARRIED },
        effective: { version: '3.2.1', archive: B321.archive },
        mode: 'compatible',
      },
    });
  });

  it('refuses a newer locked base and names the upgrade', () => {
    const refused = refusal(() =>
      selectKitBase(locked('3.3.0', UNCARRIED), '^3.3.0', [B300, B320, B321], 'inventarch/x-kit 1.0.0'),
    );
    expect(refused).toEqual({
      code: 'IA-CORE-CLI-UNSUPPORTED',
      message:
        'kit inventarch/x-kit 1.0.0 locks inventarch/language 3.3.0; this door carries up to 3.2.1: upgrade @inventarch/mcp-door',
    });
  });

  it('refuses another major', () => {
    for (const version of ['4.0.0', '2.5.0']) {
      const refused = refusal(() =>
        selectKitBase(locked(version, UNCARRIED), `^${version}`, [B300, B320, B321], 'inventarch/x-kit 1.0.0'),
      );
      expect(refused.code).toBe('IA-CORE-CLI-UNSUPPORTED');
      expect(refused.message).toContain(`kit inventarch/x-kit 1.0.0 locks inventarch/language ${version}`);
      expect(refused.message).not.toMatch(/downgrade|release that ships it/);
    }
    expect(refusal(() => selectKitBase(locked('4.0.0', UNCARRIED), undefined, [B321])).message).toContain(
      'upgrade @inventarch/mcp-door',
    );
    expect(refusal(() => selectKitBase(locked('2.5.0', UNCARRIED), undefined, [B321])).message).toContain(
      'migrated to inventarch/language 3.x',
    );
  });

  it('refuses when the declared range excludes the carried newest', () => {
    const carried = [B300, B320, B321];
    const refused = refusal(() =>
      selectKitBase(locked('3.1.5', UNCARRIED), '~3.1.0', carried, 'inventarch/x-kit 1.0.0'),
    );
    expect(refused.code).toBe('IA-CORE-CLI-UNSUPPORTED');
    expect(refused.message).toContain('kit inventarch/x-kit 1.0.0 requires inventarch/language ~3.1.0');
    expect(refused.message).toContain('3.2.1');
    expect(refused.message).not.toMatch(/downgrade/);
    // Without a declared range the lock's request is the range; a declared range comes first.
    expect(
      refusal(() => selectKitBase(locked('3.1.5', UNCARRIED, [{ id: ID, range: '~3.1.0' }]), undefined, carried)).code,
    ).toBe('IA-CORE-CLI-UNSUPPORTED');
    expect(selectKitBase(locked('3.1.5', UNCARRIED, [{ id: ID, range: '~3.1.0' }]), '^3.1.0', carried).use.mode).toBe(
      'compatible',
    );
    // A range whose floor is above every carried base names the upgrade.
    expect(refusal(() => selectKitBase(locked('3.1.5', UNCARRIED), '^3.4.0', carried)).message).toContain(
      'upgrade @inventarch/mcp-door',
    );
  });

  it('no requests and no declared range means ^locked', () => {
    // Another package's request is not the language's range.
    const lock = locked('3.1.5', UNCARRIED, [{ id: 'inventarch/other-kit', range: '*' }]);
    expect(selectKitBase(lock, undefined, [B300, B321])).toMatchObject({
      base: B321,
      use: { locked: { version: '3.1.5' }, effective: { version: '3.2.1' }, mode: 'compatible' },
    });
    // ^locked, never "anything": a prerelease newest base is not admitted.
    const preview = pin('3.3.0-rc.1', 'f');
    expect(refusal(() => selectKitBase(locked('3.2.0', UNCARRIED), undefined, [B300, preview])).message).toContain(
      'requires inventarch/language ^3.2.0',
    );
  });

  it('refuses a lock with no language row, and a reader that carries no base', () => {
    expect(refusal(() => selectKitBase({ packages: [] }, '^3.2.0', [B321])).code).toBe('IA-CORE-CLI-UNSUPPORTED');
    expect(refusal(() => selectKitBase(locked('3.2.0', B320.archive), '^3.2.0', [])).code).toBe('IA-CORE-CLI-MISSING');
  });
});
