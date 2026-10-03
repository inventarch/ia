import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { DISTRIBUTION_ENGINE_VERSION } from '../../packages/db/src/distribution/index.js';
import { BASE_ID, buildLanguageBase, cliVersion, languageBaseFindings } from './language-base.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = cliVersion(root);
const base = buildLanguageBase(root);
const checked = (overrides: Partial<Parameters<typeof languageBaseFindings>[0]> = {}) =>
  languageBaseFindings({ ...base, cliVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION, ...overrides });

// docs/specs/workspace-initialization-apply/README.md §2 and §8 item 8.
describe('bundled language base', () => {
  it('packs inventarch/language at the CLI version from the language-only set, deterministically', () => {
    expect(base.pin).toMatchObject({ id: BASE_ID, version });
    const verified = verifyArchive(base.bytes, base.pin.archive);
    expect(verified.manifestDigest).toBe(base.pin.manifest);
    expect(verified.manifest.license).toBe('Apache-2.0');
    for (const path of ['LICENSE', 'NOTICE']) {
      expect(verified.files.get(path)).toEqual(readFileSync(resolve(root, path)));
    }
    expect(verified.manifest.engine).toBe(`^${DISTRIBUTION_ENGINE_VERSION}`);
    expect(verified.manifest.source).toEqual({ repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 });
    expect(verified.manifest.roots).toEqual(['workspace-system/definition/workspace/language-workspace']);
    expect(verified.manifest.systems).toHaveLength(11);
    // On one zlib build, two builds of one revision are the same bytes and the same pin (§2.2).
    const again = buildLanguageBase(root);
    expect(again.pin).toEqual(base.pin);
    expect(again.bytes.equals(base.bytes)).toBe(true);
    expect(checked()).toEqual([]);
  });
  it('fails when the bundled engine range rejects the CLI engine', () => {
    const foreign = buildLanguageBase(root, { engine: '^99.0.0' });
    expect(
      languageBaseFindings({ ...foreign, cliVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION }),
    ).toEqual([`Bundled engine range ^99.0.0 rejects the CLI engine ${DISTRIBUTION_ENGINE_VERSION}`]);
    expect(checked({ engineVersion: '99.0.0' })).toEqual([
      `Bundled engine range ^${DISTRIBUTION_ENGINE_VERSION} rejects the CLI engine 99.0.0`,
    ]);
  });
  it('fails when the pinned version is not the CLI version', () => {
    expect(checked({ cliVersion: '9.9.9' })).toEqual([`Pinned version ${version} differs from @inventarch/cli 9.9.9`]);
    const other = buildLanguageBase(root, { version: '9.9.9' });
    expect(languageBaseFindings({ ...other, cliVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION })).toEqual(
      [`Pinned version 9.9.9 differs from @inventarch/cli ${version}`],
    );
  });
  it('fails when the archive bytes or the manifest disagree with the pin', () => {
    const bytes = Buffer.from(base.bytes);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    const tampered = checked({ bytes });
    expect(tampered[0]).toMatch(/^Archive digest [a-f0-9]{64} differs from the pinned /);
    expect(tampered[1]).toMatch(/^Archive does not verify: /);
    expect(checked({ pin: { ...base.pin, manifest: '0'.repeat(64) } })).toEqual([
      `Manifest digest ${base.pin.manifest} differs from the pinned ${'0'.repeat(64)}`,
    ]);
  });
});
