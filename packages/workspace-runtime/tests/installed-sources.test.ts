import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalDistributionJson,
  decodeBundleManifest,
  decodeDistributionLock,
  deriveGenerationInputs,
  generationDigest,
  generationSources,
  installationWorkspace,
  sha256,
  type ExpandedBundle,
} from '@inventarch/db/distribution';
import { digest } from '@inventarch/session-system';
import {
  createInstalledSourcePolicy,
  createSourcePolicy,
  homeSourceCapture,
  mountSourceCapture,
  verifySourcePolicy,
} from '../src/sources.js';

const root = mkdtempSync(resolve(tmpdir(), 'ia-installed-source-policy-'));
afterAll(() => {
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe policy fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});
const base = () => createSourcePolicy(root, { validator: digest('validator') });

// Structural retained-byte fixture. Native admission and real packing are separate install-core gates.
function installed(version = '1.0.0') {
  const files = new Map<string, Buffer>([
    ['.ia/src/systems/sample/system.ia', Buffer.from('#! ia 1.0\n# Structural retained source fixture.\n')],
    ['.ia/src/systems/sample/record.ia', Buffer.from(`#! ia 1.0\n# release ${version}\n`)],
    ['LICENSE', Buffer.from('Fixture license text.\n')],
  ]);
  const manifest = decodeBundleManifest({
    formatVersion: 1,
    id: 'example/sample',
    version,
    distribution: 'sample/definition/distribution/sample',
    engine: '^0.1.0',
    language: ['1.0'],
    source: { repository: 'https://example.test/source', commit: digest(version), recipe: 'captured-source', epoch: 0 },
    license: 'MIT',
    description: 'Retained byte fixture',
    roots: ['sample/definition/distribution/sample'],
    systems: [{ name: 'sample', provider: 'example', version, path: '.ia/src/systems/sample' }],
    dependencies: [],
    files: [...files]
      .map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        role: path === 'LICENSE' ? 'license' : 'source',
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  // Native contracts use byte lexical order, not a locale collator.
  const bundle: ExpandedBundle = {
    manifest,
    files,
    archiveDigest: digest({ archive: version }),
    manifestDigest: sha256(canonicalDistributionJson(manifest)),
  };
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: [{ id: manifest.id, range: version }],
    packages: [
      {
        id: manifest.id,
        version,
        archive: bundle.archiveDigest,
        manifest: bundle.manifestDigest,
        location: `sha256:${bundle.archiveDigest}`,
        dependencies: [],
      },
    ],
  });
  const bundles = new Map([[manifest.id, bundle]]),
    inputs = deriveGenerationInputs(lock, bundles);
  const pointer = {
    formatVersion: 1 as const,
    generation: generationDigest(lock, inputs, installationWorkspace(lock, inputs, bundles)),
    previous: null,
    counter: 1,
  };
  return { pointer, lock, bundles, inputs };
}

describe('installed source policy', () => {
  it('preserves version-one bytes and replaces its dependency injection with the exact installed view', () => {
    const v1 = base(),
      before = JSON.stringify(v1),
      release = installed();
    const policy = createInstalledSourcePolicy(v1, release);
    expect(policy.version).toBe(2);
    expect(verifySourcePolicy(policy)).toEqual(policy);
    expect(JSON.stringify(v1)).toBe(before);
    expect(verifySourcePolicy(v1)).toEqual(v1);
    const capture = homeSourceCapture('owned', [{ path: '.ia/src/note.ia', text: '#! ia 1.0\n# Authored.\n' }], policy);
    expect(capture.activation).toEqual(release.pointer);
    const expected = generationSources(release.pointer, release.lock, release.inputs, release.bundles);
    for (const source of expected) expect(capture.sources.find((row) => row.path === source.path)).toEqual(source);
    expect(capture.sources.some((row) => row.path.startsWith('.ia/adopted/foundation/'))).toBe(false);
    expect(capture.sources.find((row) => row.path === '.ia/src/note.ia')?.location.placement.kind).toBe('authored');
  });

  it('detaches every mutable file byte, lock and pointer before retaining the policy', () => {
    const release = installed(),
      policy = createInstalledSourcePolicy(base(), release),
      before = JSON.stringify(policy);
    release.bundles.get('example/sample')!.files.get('LICENSE')!.fill(0);
    release.pointer.counter = 99;
    expect(JSON.stringify(policy)).toBe(before);
    expect(verifySourcePolicy(policy)).toEqual(policy);
  });

  it('refuses changed native payload, manifest, selected archive and generation', () => {
    expect(createInstalledSourcePolicy(base(), installed()).version).toBe(2);
    const altered = installed();
    altered.bundles.get('example/sample')!.files.get('LICENSE')!.fill(0);
    expect(() => createInstalledSourcePolicy(base(), altered)).toThrow();
    const pointer = installed();
    pointer.pointer.generation = digest('wrong');
    expect(() => createInstalledSourcePolicy(base(), pointer)).toThrow();
    const missing = installed();
    missing.bundles.clear();
    expect(() => createInstalledSourcePolicy(base(), missing)).toThrow();
    const wrong = installed();
    const original = wrong.bundles.get('example/sample')!;
    wrong.bundles.set('example/sample', { ...original, archiveDigest: digest('wrong-archive') });
    expect(() => createInstalledSourcePolicy(base(), wrong)).toThrow();
  });

  it('refuses retained extra fields and source substitution even when structurally valid', () => {
    const policy = createInstalledSourcePolicy(base(), installed());
    expect(() => verifySourcePolicy({ ...policy, unexpected: true })).toThrow();
    const serialized = JSON.stringify(policy).replace(
      Buffer.from('Fixture license text.\n').toString('base64'),
      Buffer.from('Changed license text.\n').toString('base64'),
    );
    expect(serialized).not.toBe(JSON.stringify(policy));
    expect(() => verifySourcePolicy(JSON.parse(serialized))).toThrow();
  });

  it('pins new versions to new policies while old source captures remain readable', () => {
    const first = createInstalledSourcePolicy(base(), installed()),
      second = createInstalledSourcePolicy(base(), installed('2.0.0'));
    const capture = homeSourceCapture('owned', [], first),
      saved = JSON.stringify(capture);
    expect(homeSourceCapture('owned', [], second).revision).not.toBe(capture.revision);
    expect(JSON.stringify(homeSourceCapture('owned', [], first))).toBe(saved);
    expect(() =>
      mountSourceCapture(capture, homeSourceCapture('home', [], second), digest('new-source'), second),
    ).toThrow();
  });
});
