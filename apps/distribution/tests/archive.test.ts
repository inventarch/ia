import { afterAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { constants, gzipSync, gunzipSync } from 'node:zlib';
import type { ZlibOptions } from 'node:zlib';
import { decodeBundleManifest, sha256 } from '@ia/db/distribution';
import { buildArchive, verifyArchive } from '../src/archive.js';
import { entries } from './tar-entries.js';
import { packDistribution } from '../src/pack.js';
import { resolveReleases } from '../src/resolve.js';
import type { ReleaseCandidate } from '../src/resolve.js';

const repository = resolve(import.meta.dirname, '../../..'),
  temporary = mkdtempSync(join(tmpdir(), 'ia-native-pack-'));
afterAll(() => {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-native-pack-')) throw Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});
const source = {
  repository: 'https://example.com/fixture',
  commit: 'a'.repeat(40),
  recipe: 'ustar-v1',
  epoch: 1_700_000_000,
};
function release(
  id: string,
  version = '1.0.0',
  dependencies: { id: string; range: string }[] = [],
  systemName = id.split('/')[1]!,
  content = 'original',
): ReleaseCandidate {
  const path = `.ia/src/systems/${systemName}/system.ia`,
    files = new Map([[path, Buffer.from(content)]]);
  const manifest = decodeBundleManifest({
    formatVersion: 1,
    id,
    version,
    distribution: 'workspace-system/definition/distribution/fixture-release',
    roots: ['workspace-system/definition/workspace/fixture-workspace'],
    engine: '^0.1.0',
    language: ['1.0'],
    source,
    license: 'UNLICENSED',
    description: 'Original fixture',
    systems: [{ name: systemName, provider: 'example.test', version: '1.0.0', path: `.ia/src/systems/${systemName}` }],
    dependencies,
    files: [{ path, role: 'source', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
  });
  const archive = verifyArchive(buildArchive(manifest, files));
  return { release: archive, location: `sha256:${archive.archiveDigest}`, withdrawn: false };
}
it('reproducibly packs exact original bytes and refuses tampering, links and extra entries', () => {
  const candidate = release('test/a', '1.0.0', [], 'a', '\ufeff#! ia 1.0\r\n# exact\r\n'),
    archive = buildArchive(candidate.release.manifest, candidate.release.files);
  expect(buildArchive(candidate.release.manifest, candidate.release.files)).toEqual(archive);
  expect(archive[9]).toBe(255);
  expect(verifyArchive(archive).files.get('.ia/src/systems/a/system.ia')?.toString()).toBe(
    '\ufeff#! ia 1.0\r\n# exact\r\n',
  );
  expect(() => verifyArchive(archive, 'f'.repeat(64))).toThrow('digest');
  const tar = gunzipSync(archive);
  // Each changed tar goes back inside the recipe's envelope, so its refusal comes from the content check it names.
  const envelope = (bytes: Buffer): Buffer => {
    const out = gzipSync(bytes, { level: 9 });
    out[9] = 255;
    return out;
  };
  const reasons: [number, RegExp][] = [
    [0, /Unsafe portable path/],
    [124, /size, checksum/],
    [148, /size, checksum/],
    [156, /Nonregular/],
    [512, /Payload pin mismatch/],
  ];
  for (const [offset, reason] of reasons) {
    const changed = Buffer.from(tar);
    changed[offset] = changed[offset]! ^ 1;
    expect(() => verifyArchive(envelope(changed))).toThrow(reason);
  }
  expect(() => verifyArchive(envelope(Buffer.concat([tar, Buffer.alloc(512)])))).toThrow(/trailing archive data/);
  const files = new Map(candidate.release.files);
  files.set('extra', Buffer.from('extra'));
  expect(() => buildArchive(candidate.release.manifest, files)).toThrow();
});
it('verifies the canonical content whichever zlib compressed it, and refuses any other envelope', () => {
  const candidate = release('test/a', '1.0.0', [], 'a'),
    archive = buildArchive(candidate.release.manifest, candidate.release.files),
    tar = gunzipSync(archive);
  const wrap = (bytes: Buffer, options: ZlibOptions): Buffer => {
    const out = gzipSync(bytes, options);
    out[9] = 255;
    return out;
  };
  // Another zlib build (Homebrew's Node links the system zlib) encodes the same tar differently; its archive has its own digest.
  for (const options of [{ level: 6 }, { level: 9, strategy: constants.Z_FILTERED }, { level: 1, memLevel: 1 }]) {
    const other = wrap(tar, options),
      verified = verifyArchive(other);
    expect(other.equals(archive)).toBe(false);
    expect(verified.archiveDigest).toBe(sha256(other));
    expect(verified.manifestDigest).toBe(candidate.release.manifestDigest);
    expect(() => verifyArchive(other, candidate.release.archiveDigest)).toThrow('digest');
  }
  const refused = (bytes: Buffer): void => {
    expect(() => verifyArchive(bytes)).toThrow(/canonical format-1 recipe/);
  };
  refused(gzipSync(tar, { level: 9 })); // the OS byte is not 255
  const text = Buffer.from(archive);
  text[3] = 1;
  refused(text); // FTEXT set
  const stamped = Buffer.from(archive);
  stamped[4] = 1;
  refused(stamped); // nonzero mtime
  for (const xfl of [1, 3, 0x42]) {
    const extra = Buffer.from(archive);
    extra[8] = xfl;
    refused(extra);
  } // XFL values zlib never writes
  for (const xfl of [0, 2, 4]) {
    const written = Buffer.from(archive);
    written[8] = xfl;
    expect(verifyArchive(written).manifestDigest).toBe(candidate.release.manifestDigest);
  } // the three it does
  refused(Buffer.concat([wrap(Buffer.alloc(0), { level: 9 }), archive])); // an empty member before the tree
  refused(Buffer.concat([archive, wrap(Buffer.alloc(0), { level: 9 })])); // an empty member after it
  refused(Buffer.concat([archive, Buffer.from([0])])); // a trailing byte
  // A trailer that disagrees with what the stream inflates to is corrupt rather than another encoding.
  for (const at of [8, 4]) {
    const trailer = Buffer.from(archive);
    trailer[trailer.length - at] = trailer[trailer.length - at]! ^ 1;
    expect(() => verifyArchive(trailer)).toThrow(/Invalid or oversized compressed archive/);
  }
  // Inside the recipe's envelope the payload pins pass, but the entries must still form the one canonical USTAR.
  refused(wrap(Buffer.concat([...entries(tar).reverse(), Buffer.alloc(1024)]), { level: 9 })); // the entries in the other order
});
// Real output of another zlib build, not a simulation: Homebrew's Node 25.9.0 links the system zlib 1.2.12. It packed the
// release() shape of test/a with 'original fixture content\n' forty times as its one system file.
const ZLIB_1_2_12_ARCHIVE =
  'H4sIAAAAAAAC/+1WTY/TMBTMeX/Fyuc2sdN8tL3CHpDQckBwWbGS47y0hsSObLdsVe1/571sW62KCgjBHiBzSfTmZTwefyixlol3KvE7H6DziTy8xVpGfwocUWTZ8EScP0WZ80hkeZqVJc+oLmZ8VkTXPHoBbHyQDq1E/yes0yttZHvd6IewcXCtrAlgwtVIjMRI/DPEpfNfax+crjZBWxN/9tb8hTvmZ/d/WmZn97/I0ny8/18Ce1ZDD6YGozR4trz7NMGKV073tCXYkr0721IMG55tGuz4at0X30sF06d/h6SGRhtNbPK8NTkoTB20ID0pgUFtQI17HouYY6XR7eBjz6pdoDeBW2TCehnW2BZf/l3Bb51tScvbjVOk7tcyzQuszMpywYVKc8UbwVU9L5uCQz7nci4lLPJZNavKTPCsyKtsoTgsiroqoWnyIgXBC/aIsTTWdTJ8BOeHaYsJ0zVqo8mQ0OitNKuNXKGDO0ZzwU9arcB48vTh9u2bVze3729eDz5toDn+MLkTd4rtVCHpwySXe6Zs1+mAY8hfBOXeW4V5ivJwBjFhB0r3ZHU4EdOtIKPY53Wwbof1dQi9XyYJPMiubyHGcY/W2CMaelqSYemM7EiJRrq0cEQ5u9U1OKSPmhQmMttjyBQkRknxf1e7ikaMGDFixG/jG3w1zYkAEAAA';
it('verifies an archive that zlib 1.2.12 compressed', () => {
  const bytes = Buffer.from(ZLIB_1_2_12_ARCHIVE, 'base64');
  expect(sha256(bytes)).toBe('956d7ea5397dce7fc94011633f4b79105c57a977e5b93a1edf45a4ec40bcb83f');
  const verified = verifyArchive(bytes);
  expect(verified.files.get('.ia/src/systems/a/system.ia')?.toString()).toBe('original fixture content\n'.repeat(40));
  // The same content compressed by this process's zlib keeps its manifest digest.
  expect(verifyArchive(buildArchive(verified.manifest, verified.files)).manifestDigest).toBe(verified.manifestDigest);
});
it('backtracks across dependency constraints, preserves compatible locks and excludes prereleases/withdrawals', () => {
  const a1 = release('test/a', '1.0.0', [{ id: 'test/b', range: '^1.0.0' }]),
    a2 = release('test/a', '2.0.0', [{ id: 'test/b', range: '^2.0.0' }]);
  const b1 = release('test/b'),
    request = [{ id: 'test/a', range: '*' }];
  const resolved = resolveReleases(request, [a1, a2, b1], '0.1.0');
  expect(resolved.lock.packages.map((p) => p.version)).toEqual(['1.0.0', '1.0.0']);
  expect(resolved.assignments).toBe(3);
  const b2 = release('test/b', '2.0.0');
  expect(resolveReleases(request, [a1, a2, b1, b2], '0.1.0', resolved.lock).lock).toEqual(resolved.lock);
  expect(resolveReleases(request, [a1, a2, b1, b2], '0.1.0').lock.packages.map((p) => p.version)).toEqual([
    '2.0.0',
    '2.0.0',
  ]);
  expect(() => resolveReleases(request, [{ ...a1, withdrawn: true }, b1], '0.1.0')).toThrow('No compatible');
  expect(() => resolveReleases(request, [release('test/a', '3.0.0-rc.1')], '0.1.0')).toThrow();
});
it('deduplicates byte-identical systems with provenance and refuses provider/source conflicts', () => {
  const a = release('test/a', '1.0.0', [], 'shared'),
    b = release('test/b', '1.0.0', [], 'shared'),
    requests = [
      { id: 'test/a', range: '*' },
      { id: 'test/b', range: '*' },
    ];
  expect(resolveReleases(requests, [a, b], '0.1.0').inputs.systems).toMatchObject([
    { bundles: ['test/a', 'test/b'], selected: 'test/a' },
  ]);
  expect(() => resolveReleases(requests, [a, release('test/b', '1.0.0', [], 'shared', 'different')], '0.1.0')).toThrow(
    'Different provider/version/source',
  );
  expect(() =>
    resolveReleases([{ id: 'test/a', range: '*' }], [a, release('test/a', '1.0.0', [], 'shared', 'mutated')], '0.1.0'),
  ).toThrow('Immutable');
});
it('refuses unsatisfiable searches at the finite candidate assignment ceiling', () => {
  const catalog = Array.from({ length: 10 }, (_, n) =>
    ['1.0.0', '2.0.0'].map((v) =>
      release(`test/s${n}`, v, [{ id: n === 9 ? 'test/missing' : `test/s${n + 1}`, range: '*' }]),
    ),
  ).flat();
  expect(() => resolveReleases([{ id: 'test/s0', range: '*' }], catalog, '0.1.0')).toThrow(
    '1000 candidate assignments',
  );
});
it('packs an admitted whole-system closure from native roots without selecting unrelated systems', () => {
  const root = join(temporary, 'source with spaces');
  mkdirSync(root);
  const sources = [
    '.ia/src/floor/artifact-set.ia',
    '.ia/src/floor/axis.ia',
    '.ia/src/floor/cardinality.ia',
    '.ia/src/floor/category.ia',
    '.ia/src/floor/dimension.ia',
    '.ia/src/floor/floor.schema.ia',
    '.ia/src/floor/intent-shape.ia',
    '.ia/src/floor/kernel.schema.ia',
    '.ia/src/floor/kind.ia',
    '.ia/src/floor/lane.ia',
    '.ia/src/floor/move.ia',
    '.ia/src/floor/phase.ia',
    '.ia/src/floor/placement.ia',
    '.ia/src/floor/predicate.ia',
    '.ia/src/floor/primitive.ia',
    '.ia/src/floor/taxonomy.system.ia',
    '.ia/src/floor/value-type.ia',
    '.ia/src/systems/agent-system/system.ia',
    '.ia/src/systems/agent-system/schemas/agent.schema.ia',
    '.ia/src/systems/agent-system/schemas/mandate.schema.ia',
    '.ia/src/systems/compliance-system/system.ia',
    '.ia/src/systems/compliance-system/schemas/case.schema.ia',
    '.ia/src/systems/compliance-system/schemas/check.schema.ia',
    '.ia/src/systems/compliance-system/schemas/contract.schema.ia',
    '.ia/src/systems/workspace-system/system.ia',
    '.ia/src/systems/workspace-system/schemas/distribution.schema.ia',
    '.ia/src/systems/workspace-system/schemas/workspace.schema.ia',
    '.ia/src/systems/governance-system/system.ia',
    '.ia/src/systems/governance-system/schemas/convention.schema.ia',
    '.ia/src/systems/governance-system/schemas/law.schema.ia',
    '.ia/src/systems/governance-system/schemas/playbook.schema.ia',
    '.ia/src/systems/governance-system/schemas/principle.schema.ia',
    '.ia/src/systems/session-system/system.ia',
    '.ia/src/systems/session-system/schemas/run.schema.ia',
    '.ia/src/systems/authoring-system/system.ia',
    '.ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia',
    '.ia/src/systems/authoring-system/schemas/operation.schema.ia',
    '.ia/src/systems/agent-composition-system/system.ia',
    '.ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/capability.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/harness.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/voice.schema.ia',
    '.ia/src/systems/template-system/system.ia',
    '.ia/src/systems/template-system/schemas/template.schema.ia',
    '.ia/src/systems/hook-authoring-system/system.ia',
    '.ia/src/systems/hook-authoring-system/schemas/hook.schema.ia',
    '.ia/src/systems/learning-system/system.ia',
    '.ia/src/systems/learning-system/schemas/improvement.schema.ia',
    '.ia/src/systems/learning-system/schemas/observation.schema.ia',
    '.ia/src/systems/work-system/system.ia',
    '.ia/src/systems/work-system/schemas/decision.schema.ia',
    '.ia/src/systems/work-system/schemas/milestone.schema.ia',
    '.ia/src/systems/work-system/schemas/plan.schema.ia',
    '.ia/src/systems/work-system/schemas/task.schema.ia',
    '.ia/src/systems/agent-composition-system/records/composition.ia',
    '.ia/src/systems/workspace-system/records/quality.ia',
    '.ia/src/systems/workspace-system/records/architecture.ia',
    '.ia/src/systems/learning-system/records/evidence.ia',
    '.ia/src/systems/workspace-system/records/language.ia',
    '.ia/src/systems/work-system/records/work.ia',
    '.ia/src/systems/authoring-system/operations/validate-ia.ia',
    '.ia/src/systems/authoring-system/operations/format-ia.ia',
    '.ia/src/systems/template-system/operations/render-template.ia',
    '.ia/src/systems/workspace-system/records/repository-distribution.ia',
  ];
  for (const source of sources) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), readFileSync(join(repository, source)));
  }
  writeFileSync(join(root, 'LICENSE'), 'Original test fixture; no external publication.\n');
  const descriptor = {
    formatVersion: 1,
    id: 'test/foundation',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/public-language',
    engine: '^0.1.0',
    language: ['1.0'],
    dependencies: [],
    assets: [{ path: 'LICENSE', role: 'license' }],
    source,
    license: 'UNLICENSED',
    description: 'Original isolated native fixture',
  };
  const packed = packDistribution(root, descriptor);
  expect(packDistribution(root, descriptor).bytes).toEqual(packed.bytes);
  expect(packed.manifest.systems.map((s) => s.name)).toContain('workspace-system');
  expect(packed.manifest.files.every((f) => !f.path.includes('node_modules') && !f.path.includes('/floor/'))).toBe(
    true,
  );
  expect(packed.manifest.files.some((f) => f.path.endsWith('repository-distribution.ia'))).toBe(true);
  expect(packed.files.get('.ia/src/systems/workspace-system/system.ia')).toEqual(
    readFileSync(join(root, '.ia/src/systems/workspace-system/system.ia')),
  );
  expect(() =>
    packDistribution(root, { ...descriptor, dependencies: [{ id: 'test/unused', range: '*', systems: ['unused'] }] }),
  ).toThrow('Unused');
  // An unpublished local pack: no provenance, same recipe/epoch, same payload bytes.
  const local = packDistribution(root, { ...descriptor, source: { ...source, repository: null, commit: null } });
  expect(local.manifest.source).toEqual({ ...source, repository: null, commit: null });
  expect(verifyArchive(local.bytes, local.archiveDigest).manifest.source.repository).toBeNull();
  expect(local.manifest.files).toEqual(packed.manifest.files);
  expect(local.archiveDigest).not.toBe(packed.archiveDigest);
}, 30000);
