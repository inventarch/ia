import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('binds compiled system bytes, native archive, npm identity and entrypoints to an external manifest pin', async () => {
  const { verifySystemPackage, SYSTEM_PACKAGE_FORMAT, SYSTEM_NATIVE_PATH, SYSTEM_BINDING_PATH } = await import(
    '../src/system-package.js'
  );
  const { buildArchive, verifyArchive } = await import('../src/archive.js');
  const scratch = mkdtempSync(resolve(tmpdir(), 'ia-system-package-binding-'));
  if (dirname(scratch) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const put = (path: string, bytes: string | Uint8Array) => {
    mkdirSync(dirname(resolve(scratch, path)), { recursive: true });
    writeFileSync(resolve(scratch, path), bytes);
  };
  try {
    const code = 'throw new Error("verification must never execute package code");\n',
      path = '.ia/src/systems/fixture-system/system.ia',
      source = '#! ia 1.0\n@system fixture-system\n  provider "fixture.test"\n  version "3.2.1"\n';
    const native = buildArchive(
      {
        formatVersion: 1,
        id: 'fixture/system',
        version: '2.1.0',
        distribution: 'workspace-system/definition/distribution/fixture',
        roots: ['workspace-system/definition/workspace/fixture'],
        engine: '^0.1.0',
        language: ['1.0'],
        source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
        license: 'UNLICENSED',
        description: 'Original independent version fixture',
        systems: [
          {
            name: 'fixture-system',
            provider: 'fixture.test',
            version: '3.2.1',
            path: '.ia/src/systems/fixture-system',
          },
        ],
        dependencies: [],
        files: [{ path, role: 'source', bytes: Buffer.byteLength(source), sha256: sha(source) }],
      },
      new Map([[path, Buffer.from(source)]]),
    );
    const verified = verifyArchive(native),
      manifest = {
        name: '@inventarch/fixture-system',
        version: '1.4.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { '@inventarch/language': '1.0.0' },
      };
    const files = [{ path: 'dist/index.js', sha256: sha(code) }];
    const binding = {
      format: SYSTEM_PACKAGE_FORMAT,
      package: { name: manifest.name, version: manifest.version },
      system: verified.manifest.systems[0],
      native: {
        path: SYSTEM_NATIVE_PATH,
        archiveSha256: verified.archiveDigest,
        manifestSha256: verified.manifestDigest,
        id: verified.manifest.id,
        version: verified.manifest.version,
      },
      code: { digest: sha(json(files)), files },
      entrypoints: manifest.exports,
      dependencies: manifest.dependencies,
      protocols: { distribution: 1, language: ['1.0'], binding: 1 },
    };
    put('package.json', json(manifest));
    put('dist/index.js', code);
    put(SYSTEM_NATIVE_PATH, native);
    put(SYSTEM_BINDING_PATH, json(binding));
    const pin = sha(json(binding));
    expect(verifySystemPackage(scratch, pin)).toEqual(binding);
    // pnpm's installed store hard links preserve exact read-only digest verification.
    linkSync(resolve(scratch, 'dist/index.js'), resolve(scratch, 'store-member.js'));
    expect(verifySystemPackage(scratch, pin)).toEqual(binding);
    put('store-member.js', code + '// changed store bytes\n');
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
    put('store-member.js', code);
    expect(() => verifySystemPackage(scratch, '0'.repeat(64))).toThrow(/binding digest/);
    put('dist/index.js', code + '// changed\n');
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
    put('dist/index.js', code);
    const corrupt = Buffer.from(native);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    put(SYSTEM_NATIVE_PATH, corrupt);
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/digest/);
    put(SYSTEM_NATIVE_PATH, native);
    put('package.json', json({ ...manifest, version: '1.4.1' }));
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/npm identity/);
    put('package.json', json({ ...manifest, exports: { '.': { default: './dist/other.js' } } }));
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/entrypoints/);
    put('package.json', json(manifest));
    const wrongNative = { ...binding, system: { ...binding.system, version: '4.0.0' } };
    put(SYSTEM_BINDING_PATH, json(wrongNative));
    expect(() => verifySystemPackage(scratch, sha(json(wrongNative)))).toThrow(/native identity/);
    put(SYSTEM_BINDING_PATH, json(binding));
    put('dist/unlisted.js', 'export const unreviewed = true;\n');
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
