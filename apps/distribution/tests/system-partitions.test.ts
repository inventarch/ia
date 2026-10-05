import { beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error The reviewed public fixture generator is JavaScript.
import { publicResources } from '../../../tools/distribution/resources.mjs';
import { publicLanguageInputs } from '../../../tools/native/public-language.js';
import { systemArchivePartitions } from '../../../tools/release/system-partitions.js';
import { decodeDistributionLock, deriveGenerationInputs } from '@inventarch/db/distribution';
import { distributionSnapshot, packSnapshot, packSnapshotSet } from '../src/snapshot.js';
import { verifyArchive, verifySelectedArchiveClosure } from '../src/archive.js';
import {
  verifySystemPackage,
  OWNED_SYSTEM_PACKAGE_FORMAT,
  SYSTEM_BINDING_PATH,
  SYSTEM_NATIVE_PATH,
  SYSTEM_SELECTION_PATH,
} from '../src/system-package.js';
import type { OwnedSystemPackageBinding } from '../src/system-package.js';

const root = resolve(import.meta.dirname, '../../..'),
  sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const own = '.ia/src/systems/authoring-system',
  guidePath = own + '/records/public-guides.ia',
  document = own + '/reference/agent.md';
function fixture() {
  const native = publicLanguageInputs(root);
  const outputs = new Map<string, { bytes: string | Buffer }>();
  const put = (path: string, bytes: string | Buffer) => outputs.set(path, { bytes });
  for (const row of native.inputs) put(row.path, row.text);
  for (const path of [
    '.ia/src/floor/README.md',
    '.ia/src/floor/SPEC.md',
    '.ia/src/systems/agent-composition-system/references/installed-read.md',
    '.ia/src/systems/agent-composition-system/references/public-spec.md',
    '.ia/src/systems/agent-composition-system/references/spec-read-boundary.md',
    '.ia/src/systems/agent-composition-system/references/task-capture.md',
  ])
    put(path, '# Original partition fixture teaching\n');
  publicResources({
    outputs,
    put,
    text: (path: string) => readFileSync(resolve(root, path), 'utf8'),
    json: (path: string, value: unknown) => put(path, json(value)),
    manifest: JSON.parse(readFileSync(resolve(root, 'examples/public-language/manifest.json'), 'utf8')),
  });
  const declarationPath = '.ia/src/systems/workspace-system/records/system-packages.ia';
  const declaration = {
    path: declarationPath,
    text: readFileSync(resolve(root, declarationPath), 'utf8'),
    location: {
      placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
      provenance: 'workspace' as const,
    },
  };
  const guide = { ...declaration, path: guidePath, text: String(outputs.get(guidePath)!.bytes) };
  const snapshot = distributionSnapshot({
    sources: [...native.inputs, declaration, guide],
    folders: native.folders,
    floorOrigin: 'local',
  });
  const owners = [...native.folders].sort().map((system) => ({
    system,
    id: 'fixture/' + system,
    version: system === 'work-system' ? '2.0.0' : '1.0.0',
    distribution: 'workspace-system/definition/distribution/package-' + system,
  }));
  const resources = JSON.parse(String(outputs.get('.ia/authoring.resources.json')!.bytes));
  const assets = new Map<string, Buffer>([
    ['LICENSE', Buffer.from('fixture license')],
    ['NOTICE', Buffer.from('fixture notice')],
    ...resources.files.map((row: { path: string }) => [row.path, Buffer.from(outputs.get(row.path)!.bytes)]),
  ]);
  return { snapshot, owners, assets, resources };
}
let input: ReturnType<typeof fixture>,
  partitions: ReturnType<typeof systemArchivePartitions>,
  packed: ReturnType<typeof packSnapshotSet>;
beforeAll(() => {
  input = fixture();
  partitions = systemArchivePartitions(input.snapshot, input.resources, input.assets, input.owners);
  packed = packSnapshotSet(input.snapshot, partitions);
});
function selection() {
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: packed.map((row) => ({ id: row.manifest.id, range: row.manifest.version })),
    packages: packed.map((row) => ({
      id: row.manifest.id,
      version: row.manifest.version,
      archive: row.archiveDigest,
      manifest: row.manifestDigest,
      location: 'sha256:' + row.archiveDigest,
      dependencies: row.manifest.dependencies.map((row) => row.id),
    })),
  });
  return { lock, archives: new Map(packed.map((row) => [row.archiveDigest, row.bytes])) };
}
it('atomically admits eleven separate native owners with one shared floor and one teaching owner', () => {
  const selected = selection(),
    verified = verifySelectedArchiveClosure(selected.lock, selected.archives);
  const generation = deriveGenerationInputs(selected.lock, verified);
  expect(packed).toHaveLength(11);
  expect(generation.systems).toHaveLength(11);
  expect(generation.systems.every((row) => row.bundles.length === 1)).toBe(true);
  expect(packed.every((row) => row.manifest.systems.length === 1)).toBe(true);
  expect(
    packed.flatMap((row) =>
      row.manifest.files.filter((file) => file.role === 'source' && file.path.includes('/floor/')),
    ),
  ).toEqual([]);
  expect(packed.filter((row) => row.files.has(document)).map((row) => row.manifest.id)).toEqual([
    'fixture/authoring-system',
  ]);
  expect(packed.filter((row) => row.files.has('.ia/src/floor/README.md')).map((row) => row.manifest.id)).toEqual([
    'fixture/authoring-system',
  ]);
  expect(packed.find((row) => row.manifest.id === 'fixture/work-system')!.manifest.version).toBe('2.0.0');
});
it('retains standalone refusal for an externalized declaration and dependent authoring assets', () => {
  const row = partitions.find((row) => row.owner.system === 'agent-system')!;
  expect(() => packSnapshot(input.snapshot, row.descriptor, row.assets)).toThrow(/own authored distribution/);
  expect(() => verifyArchive(packed[0]!.bytes)).toThrow(/authoring/i);
});
it('refuses absent declarations and declarations selecting the wrong native owner', () => {
  const sources = input.snapshot.sources.filter((row) => !row.path.endsWith('/system-packages.ia'));
  const missing = distributionSnapshot({
    sources,
    folders: input.snapshot.folders,
    floorOrigin: input.snapshot.floorOrigin,
  });
  expect(() => systemArchivePartitions(missing, input.resources, input.assets, input.owners)).toThrow(
    /distribution declaration/,
  );
  const changedSources = input.snapshot.sources.map((row) =>
    !row.path.endsWith('/system-packages.ia')
      ? row
      : {
          ...row,
          text: row.text.replace('records [@system agent-composition-system]', 'records [@system work-system]'),
        },
  );
  const changed = distributionSnapshot({
    sources: changedSources,
    folders: input.snapshot.folders,
    floorOrigin: input.snapshot.floorOrigin,
  });
  expect(() => packSnapshotSet(changed, partitions)).toThrow();
  const bad = partitions.map((row, index) =>
    index
      ? row
      : {
          ...row,
          descriptor: {
            ...row.descriptor,
            distribution: 'workspace-system/definition/distribution/package-work-system',
          },
        },
  );
  expect(() => packSnapshotSet(input.snapshot, bad)).toThrow();
});
it('refuses missing owners, duplicate packages and skewed exact dependency versions', () => {
  expect(() => packSnapshotSet(input.snapshot, partitions.slice(1))).toThrow();
  expect(() => packSnapshotSet(input.snapshot, [...partitions, partitions[0]!])).toThrow();
  const skew = partitions.map((row, index) =>
    index
      ? row
      : {
          ...row,
          descriptor: {
            ...row.descriptor,
            dependencies: row.descriptor.dependencies.map((dependency, dep) =>
              dep ? dependency : { ...dependency, range: '99.0.0' },
            ),
          },
        },
  );
  expect(() => packSnapshotSet(input.snapshot, skew)).toThrow();
  expect(() => systemArchivePartitions(input.snapshot, input.resources, input.assets, input.owners.slice(1))).toThrow(
    /owners differ/,
  );
});
it('refuses changed or cross-owned required teaching without silently dropping it', () => {
  const changed = partitions.map((row) =>
    row.owner.system !== 'authoring-system'
      ? row
      : {
          ...row,
          assets: new Map(
            [...row.assets].map(([path, bytes]) => [path, path === document ? Buffer.from('changed') : bytes]),
          ),
        },
  );
  expect(() => packSnapshotSet(input.snapshot, changed)).toThrow(/authoring/i);
  const cross = structuredClone(input.resources);
  cross.associations[0]!.resources[0]!.key.path = '.ia/src/systems/agent-system/unowned.md';
  expect(() => systemArchivePartitions(input.snapshot, cross, input.assets, input.owners)).toThrow(/Cross-owner/);
});
it('verifies installed native-only bindings against the exact closure and rejects code, pin and owner substitutions', () => {
  const selected = selection(),
    native = packed.find((row) => row.manifest.id === 'fixture/work-system')!;
  const scratch = mkdtempSync(resolve(tmpdir(), 'ia-native-only-binding-'));
  const put = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(resolve(scratch, path)), { recursive: true });
    writeFileSync(resolve(scratch, path), content);
  };
  const manifest = {
    name: '@inventarch/work-system',
    version: '1.0.0',
    type: 'module',
    exports: { './native.ia.tgz': './' + SYSTEM_NATIVE_PATH, './system-package.json': './' + SYSTEM_BINDING_PATH },
    dependencies: {},
  };
  const lockBytes = json(selected.lock);
  const binding: OwnedSystemPackageBinding = {
    format: OWNED_SYSTEM_PACKAGE_FORMAT,
    kind: 'native-only',
    package: { name: manifest.name, version: manifest.version, manifestSha256: sha(json(manifest)) },
    payload: { digest: sha(json([])), files: [] },
    system: native.manifest.systems[0]!,
    native: {
      path: SYSTEM_NATIVE_PATH,
      archiveSha256: native.archiveDigest,
      manifestSha256: native.manifestDigest,
      id: native.manifest.id,
      version: native.manifest.version,
      selection: { path: SYSTEM_SELECTION_PATH, sha256: sha(lockBytes) },
    },
    code: { digest: sha(json([])), files: [] },
    entrypoints: manifest.exports,
    dependencies: {},
    protocols: { distribution: 1, language: ['1.0'], binding: 2 },
  };
  try {
    put('package.json', json(manifest));
    put(SYSTEM_NATIVE_PATH, native.bytes);
    put(SYSTEM_SELECTION_PATH, lockBytes);
    put(SYSTEM_BINDING_PATH, json(binding));
    const pin = sha(json(binding));
    expect(verifySystemPackage(scratch, pin, selected)).toEqual(binding);
    expect(() => verifySystemPackage(scratch, pin)).toThrow(/exact selected/);
    const incomplete = new Map(selected.archives);
    incomplete.delete(packed[0]!.archiveDigest);
    expect(() => verifySystemPackage(scratch, pin, { archives: incomplete })).toThrow();
    const changed = new Map(selected.archives);
    changed.set(packed[0]!.archiveDigest, Buffer.from('changed'));
    expect(() => verifySystemPackage(scratch, pin, { archives: changed })).toThrow();
    put(SYSTEM_SELECTION_PATH, lockBytes + ' ');
    expect(() => verifySystemPackage(scratch, pin, selected)).toThrow(/closure digest/);
    put(SYSTEM_SELECTION_PATH, lockBytes);
    const other = packed.find((row) => row.manifest.id !== native.manifest.id)!;
    const mixed = { ...binding, native: { ...binding.native, archiveSha256: other.archiveDigest } };
    put(SYSTEM_NATIVE_PATH, other.bytes);
    put(SYSTEM_BINDING_PATH, json(mixed));
    expect(() => verifySystemPackage(scratch, sha(json(mixed)), selected)).toThrow(/native identity/);
    put(SYSTEM_NATIVE_PATH, native.bytes);
    put(SYSTEM_BINDING_PATH, json(binding));
    const wrongOwner = { ...binding, system: { ...binding.system, version: '99.0.0' } };
    put(SYSTEM_BINDING_PATH, json(wrongOwner));
    expect(() => verifySystemPackage(scratch, sha(json(wrongOwner)), selected)).toThrow(/native identity/);
    put(SYSTEM_BINDING_PATH, json(binding));
    put('dist/index.js', 'throw new Error("must never execute");\n');
    expect(() => verifySystemPackage(scratch, pin, selected)).toThrow(/compiled bytes/);
  } finally {
    expect(dirname(scratch)).toBe(resolve(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});

function ownedFixture(kind: 'compiled' | 'native-only' = 'native-only') {
  const selected = selection(),
    native = packed.find((row) => row.manifest.id === 'fixture/work-system')!;
  const scratch = mkdtempSync(resolve(tmpdir(), 'ia-owned-payload-'));
  const put = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(resolve(scratch, path)), { recursive: true });
    writeFileSync(resolve(scratch, path), content);
  };
  const manifest: { name: string; version: string; exports: Record<string, string>; [key: string]: unknown } = {
    name: '@inventarch/work-system',
    version: '1.0.0',
    type: 'module',
    exports:
      kind === 'native-only'
        ? { './native.ia.tgz': './' + SYSTEM_NATIVE_PATH, './system-package.json': './' + SYSTEM_BINDING_PATH }
        : { '.': './dist/index.js' },
    dependencies: {},
  };
  const lockBytes = json(selected.lock),
    code = 'throw new Error("verification must never execute package code");\n';
  const codeFiles = kind === 'compiled' ? [{ path: 'dist/index.js', sha256: sha(code) }] : [];
  const payload = [...codeFiles, { path: 'LICENSE', sha256: sha('fixture license\n') }].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  const binding = {
    format: OWNED_SYSTEM_PACKAGE_FORMAT,
    kind,
    package: { name: manifest.name, version: manifest.version, manifestSha256: sha(json(manifest)) },
    system: native.manifest.systems[0]!,
    native: {
      path: SYSTEM_NATIVE_PATH,
      archiveSha256: native.archiveDigest,
      manifestSha256: native.manifestDigest,
      id: native.manifest.id,
      version: native.manifest.version,
      selection: { path: SYSTEM_SELECTION_PATH, sha256: sha(lockBytes) },
    },
    code: { digest: sha(json(codeFiles)), files: codeFiles },
    payload: { digest: sha(json(payload)), files: payload },
    entrypoints: manifest.exports,
    dependencies: {},
    protocols: { distribution: 1, language: ['1.0'], binding: 2 },
  };
  put('package.json', json(manifest));
  put('LICENSE', 'fixture license\n');
  put(SYSTEM_NATIVE_PATH, native.bytes);
  put(SYSTEM_SELECTION_PATH, lockBytes);
  if (kind === 'compiled') put('dist/index.js', code);
  const rebind = () => {
    put(SYSTEM_BINDING_PATH, json(binding));
    return sha(json(binding));
  };
  const pin = rebind();
  const cleanup = () => {
    expect(dirname(scratch)).toBe(resolve(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  };
  return { scratch, put, manifest, binding, pin, rebind, cleanup, selected };
}

it.each([
  ['bin', { x: './x.js' }],
  ['scripts', { install: 'node x.js' }],
  ['peerDependencies', { unreviewed: '1.0.0' }],
  ['optionalDependencies', { unreviewed: '1.0.0' }],
  ['imports', { '#x': './x.js' }],
  ['type', 'commonjs'],
])('refuses changed native-only package metadata %s under the original binding', (key, value) => {
  const f = ownedFixture();
  try {
    expect(verifySystemPackage(f.scratch, f.pin, f.selected)).toEqual(f.binding);
    f.put('package.json', json({ ...f.manifest, [key]: value }));
    expect(() => verifySystemPackage(f.scratch, f.pin, f.selected)).toThrow(/package manifest/);
  } finally {
    f.cleanup();
  }
});

it.each(['native-only', 'compiled'] as const)(
  'refuses unlisted root and nested payload files for %s packages',
  (kind) => {
    const f = ownedFixture(kind);
    try {
      expect(verifySystemPackage(f.scratch, f.pin, f.selected)).toEqual(f.binding);
      for (const path of ['x.js', 'assets/x.js', 'node_modules/x/index.js']) {
        f.put(path, 'throw new Error("unreviewed code must never execute");\n');
        expect(() => verifySystemPackage(f.scratch, f.pin, f.selected)).toThrow(/payload/);
        rmSync(resolve(f.scratch, path));
      }
    } finally {
      f.cleanup();
    }
  },
);

it('refuses changed or missing pinned root documents without confusing them with native store files', () => {
  const f = ownedFixture();
  try {
    f.put('LICENSE', 'changed\n');
    expect(() => verifySystemPackage(f.scratch, f.pin, f.selected)).toThrow(/payload/);
    rmSync(resolve(f.scratch, 'LICENSE'));
    expect(() => verifySystemPackage(f.scratch, f.pin, f.selected)).toThrow(/payload/);
  } finally {
    f.cleanup();
  }
});

it.each([
  ['bin', { x: './x.js' }],
  ['scripts', { install: 'node x.js' }],
  ['main', './x.js'],
  ['module', './x.js'],
  ['browser', './x.js'],
  ['imports', { '#x': './x.js' }],
  ['peerDependencies', { unreviewed: '1.0.0' }],
  ['optionalDependencies', { unreviewed: '1.0.0' }],
])('refuses executable native-only metadata %s even with newly selected complete pins', (key, value) => {
  const f = ownedFixture();
  try {
    f.manifest[key as string] = value;
    f.put('package.json', json(f.manifest));
    f.binding.package.manifestSha256 = sha(json(f.manifest));
    expect(() => verifySystemPackage(f.scratch, f.rebind(), f.selected)).toThrow(/Native-only/);
  } finally {
    f.cleanup();
  }
});

it('refuses a fully pinned root executable in a native-only payload', () => {
  const f = ownedFixture();
  try {
    const code = 'throw new Error("must never execute");\n';
    f.put('x.js', code);
    f.binding.payload.files.push({ path: 'x.js', sha256: sha(code) });
    f.binding.payload.digest = sha(json(f.binding.payload.files));
    expect(() => verifySystemPackage(f.scratch, f.rebind(), f.selected)).toThrow(/Native-only/);
  } finally {
    f.cleanup();
  }
});

it('refuses incomplete historical v2 bindings rather than assigning them complete payload integrity', () => {
  const f = ownedFixture();
  try {
    const incomplete = {
      ...f.binding,
      package: { name: f.binding.package.name, version: f.binding.package.version },
      payload: undefined,
    };
    f.put(SYSTEM_BINDING_PATH, json(incomplete));
    expect(() => verifySystemPackage(f.scratch, sha(json(incomplete)), f.selected)).toThrow(/complete.*integrity/);
  } finally {
    f.cleanup();
  }
});

it('preserves installed-store hardlinks while refusing changed linked package bytes', () => {
  const f = ownedFixture('compiled'),
    storeMember = f.scratch + '-store.js';
  try {
    linkSync(resolve(f.scratch, 'dist/index.js'), storeMember);
    expect(verifySystemPackage(f.scratch, f.pin, f.selected)).toEqual(f.binding);
    writeFileSync(storeMember, 'throw new Error("changed store bytes");\n');
    expect(() => verifySystemPackage(f.scratch, f.pin, f.selected)).toThrow(/compiled bytes/);
  } finally {
    rmSync(storeMember, { force: true });
    f.cleanup();
  }
});
