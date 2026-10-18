import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { DISTRIBUTION_ENGINE_VERSION } from '../../packages/db/src/distribution/index.js';
import {
  BASE_ID,
  buildLanguageBase,
  languageVersion,
  languageBaseFindings,
  writeLanguageBase,
  archivePath,
} from './language-base.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = languageVersion(root);
const base = buildLanguageBase(root);
const checked = (overrides: Partial<Parameters<typeof languageBaseFindings>[0]> = {}) =>
  languageBaseFindings({ ...base, languageVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION, ...overrides });

it.each(['unchanged', 'foreign-file', 'aliased-pin'])(
  'publishes language base idempotently with owned outputs: %s',
  (kind) => {
    const scratch = mkdtempSync(resolve(tmpdir(), 'ia-base-write-'));
    try {
      writeLanguageBase(scratch, base);
      const archive = resolve(scratch, 'apps/cli', archivePath(base.pin.archive));
      const pin = resolve(scratch, 'apps/cli/assets/base.json'),
        before = readFileSync(pin);
      if (kind === 'unchanged') {
        const date = new Date('2000-01-01T00:00:00Z');
        utimesSync(archive, date, date);
        utimesSync(pin, date, date);
        writeLanguageBase(scratch, base);
        expect(statSync(archive).mtimeMs).toBe(date.getTime());
        expect(statSync(pin).mtimeMs).toBe(date.getTime());
      } else {
        if (kind === 'foreign-file') writeFileSync(resolve(scratch, 'apps/cli/assets/base/retain.txt'), 'foreign');
        else linkSync(pin, resolve(scratch, 'foreign-pin.json'));
        expect(() => writeLanguageBase(scratch, base)).toThrow();
        expect(readFileSync(pin)).toEqual(before);
        expect(
          readFileSync(
            kind === 'foreign-file'
              ? resolve(scratch, 'apps/cli/assets/base/retain.txt')
              : resolve(scratch, 'foreign-pin.json'),
          ),
        ).toEqual(kind === 'foreign-file' ? Buffer.from('foreign') : before);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

// docs/specs/workspace-initialization-apply/README.md §2 “Base artifact” and §8 “Acceptance evidence”.
describe('bundled language base', () => {
  it('packs artifact3 without changing syntax1, the archive format or the released engine contract', () => {
    const aligned = buildLanguageBase(root, { version: '3.0.0' });
    const verified = verifyArchive(aligned.bytes, aligned.pin.archive);
    expect(aligned.pin.version).toBe('3.0.0');
    expect(verified.manifest.version).toBe('3.0.0');
    expect(verified.manifest.formatVersion).toBe(1);
    expect(verified.manifest.language).toEqual(['1.0']);
    expect(verified.manifest.engine).toBe('^0.1.1');
    const sources = [...verified.files].filter(([path]) => path.endsWith('.ia'));
    expect(sources.length).toBeGreaterThan(0);
    for (const [, bytes] of sources) expect(Buffer.from(bytes).toString('utf8')).toMatch(/^#! ia 1\.0(?:\r?\n|$)/);
  });
  it('reads the derived native language selector and refuses an absent or malformed version policy', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'ia-language-version-'));
    try {
      mkdirSync(resolve(temporary, 'examples/public-language'), { recursive: true });
      mkdirSync(resolve(temporary, 'apps/cli'), { recursive: true });
      writeFileSync(resolve(temporary, 'apps/cli/package.json'), JSON.stringify({ version: '9.0.0' }));
      expect(() => languageVersion(temporary)).toThrow();
      const policy = resolve(temporary, 'examples/public-language/versions.json');
      writeFileSync(policy, JSON.stringify({ format: 'ia.public-native-versions.v1', language: '2.3.4' }));
      expect(languageVersion(temporary)).toBe('2.3.4');
      for (const invalid of ['01.0.0', '1.0', null]) {
        writeFileSync(policy, JSON.stringify({ format: 'ia.public-native-versions.v1', language: invalid }));
        expect(() => languageVersion(temporary)).toThrow('Invalid native language version policy');
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('packs inventarch/language at its derived artifact version from the language-only set, deterministically', () => {
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
    // On one zlib build, two builds of one revision are the same bytes and the same pin (the “Base artifact” contract).
    const again = buildLanguageBase(root);
    expect(again.pin).toEqual(base.pin);
    expect(again.bytes.equals(base.bytes)).toBe(true);
    expect(checked()).toEqual([]);
  });
  it("ships none of this repository's own participant pair, which stays in the unpacked .ia/src/participant.ia", () => {
    const verified = verifyArchive(base.bytes, base.pin.archive);
    expect(verified.manifest.files.map((f) => f.path)).not.toContain('.ia/src/participant.ia');
    expect(
      [...verified.files.values()].filter((bytes) =>
        /language-(?:participant|mandate)/.test(Buffer.from(bytes).toString('utf8')),
      ),
    ).toEqual([]);
  });
  it('fails when the bundled engine range rejects the CLI engine', () => {
    const foreign = buildLanguageBase(root, { engine: '^99.0.0' });
    expect(
      languageBaseFindings({ ...foreign, languageVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION }),
    ).toEqual([`Bundled engine range ^99.0.0 rejects the CLI engine ${DISTRIBUTION_ENGINE_VERSION}`]);
    expect(checked({ engineVersion: '99.0.0' })).toEqual([
      `Bundled engine range ^${DISTRIBUTION_ENGINE_VERSION} rejects the CLI engine 99.0.0`,
    ]);
  });
  it('fails when the pinned version differs from native policy', () => {
    expect(checked({ languageVersion: '9.9.9' })).toEqual([
      `Pinned version ${version} differs from native language policy 9.9.9`,
    ]);
    const other = buildLanguageBase(root, { version: '9.9.9' });
    expect(
      languageBaseFindings({ ...other, languageVersion: version, engineVersion: DISTRIBUTION_ENGINE_VERSION }),
    ).toEqual([`Pinned version 9.9.9 differs from native language policy ${version}`]);
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
