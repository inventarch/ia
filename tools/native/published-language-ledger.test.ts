import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseLedger } from './language-bases.js';
import { buildLanguageBase } from './language-base.js';
import { readPublicManifest } from './public-manifest.mjs';
import { publishedCli, retainPublishedBase } from './published-language-ledger.js';

const root = resolve(import.meta.dirname, '../..');
const sha = 'd'.repeat(40);
const version = '3.9.7';
const name = '@inventarch/cli';
const native = buildLanguageBase(root, { version: '3.9.7' });
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-tested-ledger-'));
  scratch.push(directory);
  const manifest = readPublicManifest(root);
  const paths = [
    ...manifest.floor,
    ...manifest.systems.flatMap(({ name, schemas }) => [`.ia/src/systems/${name}/system.ia`, ...schemas]),
    'examples/public-language',
    'releases/native',
    'LICENSE',
    'NOTICE',
  ];
  for (const path of paths) {
    const destination = resolve(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(root, path), destination, { recursive: true });
  }
  mkdirSync(resolve(directory, 'apps/cli/assets'), { recursive: true });
  return directory;
}
function tarball(base = native, includeArchive = true) {
  const files: Record<string, Buffer> = {
    'package/package.json': Buffer.from(JSON.stringify({ name, version })),
    'package/assets/base.json': Buffer.from(JSON.stringify(base.pin)),
  };
  if (includeArchive) files[`package/assets/base/${base.pin.archive}.ia.tgz`] = base.bytes;
  const blocks = Object.entries(files).flatMap(([path, body]) => {
    const header = Buffer.alloc(512);
    header.write(path);
    header.write(body.length.toString(8).padStart(11, '0'), 124, 'ascii');
    header.write('0', 156, 'ascii');
    return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const receipt = (bytes: Buffer) => ({
  format: 'ia.npm-release.v2',
  version,
  source: { repository: 'inventarch/ia', commit: sha, dirty: false },
  packages: [
    { name, version, bytes: bytes.length, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
  ],
});

describe('post-publication language-base recording', () => {
  it('requires a unique exact CLI row for the completed canonical commit', () => {
    const qualified = receipt(tarball());
    expect(publishedCli(qualified, version, sha)).toEqual(qualified.packages[0]);
    expect(() => publishedCli(qualified, version, 'a'.repeat(40))).toThrow(/completed publisher/);
    expect(() => publishedCli(qualified, 'latest', sha)).toThrow(/Exact published version/);
    expect(() =>
      publishedCli({ ...qualified, packages: [...qualified.packages, ...qualified.packages] }, version, sha),
    ).toThrow(/Exactly one/);
    expect(() => publishedCli({ ...qualified, source: { ...qualified.source, dirty: true } }, version, sha)).toThrow(
      /dirty publication/,
    );
  });

  it('verifies exact registry integrity and native membership before writing anything', () => {
    const directory = fixture();
    const bytes = tarball();
    const before = readBaseLedger(directory);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1]! ^= 1;
    expect(() => retainPublishedBase(directory, changed, receipt(bytes).packages[0]!)).toThrow(/integrity differs/);
    const missing = tarball(native, false);
    expect(() => retainPublishedBase(directory, missing, receipt(missing).packages[0]!)).toThrow(/tarball/i);
    expect(readBaseLedger(directory)).toEqual(before);
  });

  it('writes the four expected products and has no churn on identical replay', () => {
    const directory = fixture();
    const bytes = tarball();
    const entry = receipt(bytes).packages[0]!;
    const result = retainPublishedBase(directory, bytes, entry);
    expect(result.changed).toBe(true);
    expect(result.paths).toHaveLength(4);
    expect(readBaseLedger(directory).bases.at(-1)).toEqual(result.base);
    const expected = result.paths.map((path) => readFileSync(resolve(directory, path)));
    expect(retainPublishedBase(directory, bytes, entry)).toEqual({ changed: false, base: result.base, paths: [] });
    expect(result.paths.map((path) => readFileSync(resolve(directory, path)))).toEqual(expected);
    const republished = buildLanguageBase(root, { version, engine: '>=0.0.1' });
    const reissue = tarball(republished);
    expect(() => retainPublishedBase(directory, reissue, receipt(reissue).packages[0]!)).toThrow(
      /without a version change/,
    );
    expect(result.paths.map((path) => readFileSync(resolve(directory, path)))).toEqual(expected);
  }, 30_000);
});
