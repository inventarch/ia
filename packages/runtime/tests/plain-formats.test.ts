import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names come back exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import { canonical } from '../src/method/packet.js';
import { folderKits, retainKit, retainedKit } from '../src/method/index.js';
import { currentStamp, peekStamp } from '../src/plain-format.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-plain-formats-')));
});
afterEach(() => {
  flip.plain = false;
  rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const put = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
};
function retained() {
  const store = join(dir, 'store'),
    kit = join(dir, 'kits', 'ia-kb');
  put(join(kit, '.ia', 'release.json'), { id: 'inventarch/ia-kb-kit', version: '0.1.0' });
  put(join(kit, 'releases.json'), {
    kit: 'inventarch/ia-kb-kit',
    releases: [{ version: '0.1.0', archive: 'e'.repeat(64), records: [] }],
  });
  const kept = retainKit(folderKits(join(dir, 'kits'), 'bundled')[0]!, store);
  return { store, kept };
}
const manifestOf = (store: string, digest: string) =>
  JSON.parse(readFileSync(join(store, digest, 'manifest.json'), 'utf8')) as Record<string, unknown>;

// Forward compatibility (dec-008, A15): an older program reads a retained manifest only under the literal it was released
// with, so by default the manifest is retained under it; flipped, under the plain stamp. Both are read either way.
it('retains method bytes under the released literal, and under the plain stamp once the switch flips', () => {
  const { store, kept } = retained();
  const manifest = manifestOf(store, kept.retained!);
  expect(manifest['format']).toBe('inventarch.method-bytes/1');
  expect(Object.hasOwn(manifest, 'formatVersion')).toBe(false);
  expect(sha(canonical(manifest))).toBe(kept.retained);
  const { format: _format, formatVersion: _version, ...rest } = manifest,
    plain = { format: 'method-bytes', formatVersion: 1, ...rest },
    digest = sha(canonical(plain));
  expect(digest).not.toBe(kept.retained);
  // The plain copy a later release retains verifies under its own digest, and the released one keeps reading.
  cpSync(join(store, kept.retained!), join(store, digest), { recursive: true });
  writeFileSync(
    join(store, digest, 'manifest.json'),
    `${canonical(plain)}
`,
  );
  expect(retainedKit(digest, store)).toMatchObject({ id: 'inventarch/ia-kb-kit', retained: digest });
  expect(retainedKit(kept.retained!, store)).toMatchObject({ retained: kept.retained });
  flip.plain = true;
  rmSync(store, { recursive: true, force: true });
  const flipped = retained();
  expect(manifestOf(flipped.store, flipped.kept.retained!)).toMatchObject({ format: 'method-bytes', formatVersion: 1 });
  expect(flipped.kept.retained).toBe(digest);
});

it('refuses a retained manifest that is neither the plain stamp nor the original literal', () => {
  const { store, kept } = retained();
  const { format: _format, formatVersion: _version, ...rest } = manifestOf(store, kept.retained!);
  for (const stamp of [
    { format: 'method-bytes' },
    { format: 'method-bytes', formatVersion: 2 },
    { format: 'inventarch.method-bytes/2' },
    { format: 'inventarch.method-bytes/1', formatVersion: 1 },
  ]) {
    const manifest = { ...stamp, ...rest },
      digest = sha(canonical(manifest));
    cpSync(join(store, kept.retained!), join(store, digest), { recursive: true });
    writeFileSync(join(store, digest, 'manifest.json'), `${canonical(manifest)}\n`);
    expect(() => retainedKit(digest, store)).toThrow(/manifest digest mismatch/);
  }
});

it('spells the stamp the writers use', () => {
  expect(currentStamp('position-body')).toEqual({ format: 'position-body', formatVersion: 1 });
  expect(peekStamp({ format: 'ia.position-packet.v1' }, 'position-packet', ['ia.position-packet.v1'])).toEqual({
    format: 'ia.position-packet.v1',
  });
});
