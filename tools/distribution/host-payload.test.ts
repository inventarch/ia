// Host registration spec §3.2 (amended): the payload @inventarch/cli embeds is generated from the workspace's built packages.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { unpackTree, HOST_TREE_LIMITS } from '../../apps/distribution/src/ustar.js';
import { verifyHostCache } from '../../apps/distribution/src/host.js';
import { assertStaticPayloadCode, staticCliManifest, collectPayload, generateHostPayload } from './host-payload.mjs';

const repository = resolve(import.meta.dirname, '../..'),
  made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});
function extract(archive: Buffer): string {
  const tree = unpackTree(archive, HOST_TREE_LIMITS),
    out = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-')));
  made.push(out);
  for (const [path, bytes] of tree) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), bytes);
  }
  return out;
}
/** The public CLI has no private entry. Its refusal tests use an inert reviewed-capability manifest;
 * the private producer still tests its actual manifest unchanged, including any boundary drift. */
function developmentManifest() {
  const original = JSON.parse(readFileSync(join(repository, 'apps/cli/package.json'), 'utf8'));
  if (original.exports['./development'] !== undefined) return original;
  return {
    ...original,
    exports: {
      ...original.exports,
      './development': {
        types: './dist/inventarch-development/index.d.ts',
        default: './dist/inventarch-development/index.js',
      },
    },
    peerDependencies: { '@inventarch/monorepo-kit-host': '0.1.0' },
    peerDependenciesMeta: { '@inventarch/monorepo-kit-host': { optional: true } },
    dependencies: {
      ...original.dependencies,
      '@inventarch/architecture-system': 'workspace:*',
      '@inventarch/code-quality-system': 'workspace:*',
    },
  };
}
it('produces a deterministic v2 payload that verifies after extraction', async () => {
  const first = await generateHostPayload({ repository, write: false }),
    second = await generateHostPayload({ repository, write: false });
  expect(first.pin).toEqual(second.pin);
  expect(first.archive.equals(second.archive)).toBe(true);
  const verified = verifyHostCache(extract(first.archive));
  expect(verified).toMatchObject({ format: 2, host: null, release: first.pin.release });
});
it('excludes the private service dependencies and the payload itself', async () => {
  const { files, packages } = await collectPayload(repository);
  expect(packages.map((p: { name: string }) => p.name)).toEqual(
    expect.arrayContaining([
      '@inventarch/cli',
      '@inventarch/distribution',
      '@inventarch/mcp-door',
      '@inventarch/steward-hook',
    ]),
  );
  expect(
    packages.some(
      (p: { name: string }) => p.name === '@modelcontextprotocol/client' || p.name === '@inventarch/service-contracts',
    ),
  ).toBe(false);
  expect([...files.keys()].some((path) => /@ia\/cli\/assets\/host(\/|\.json$)/.test(path))).toBe(false);
  expect(
    packages.some((p) =>
      ['@inventarch/architecture-system', '@inventarch/code-quality-system', '@inventarch/monorepo-kit-host'].includes(
        p.name,
      ),
    ),
  ).toBe(false);
  expect([...files.keys()].some((path) => /inventarch-development|development-native/.test(path))).toBe(false);
  expect(packages.length).toBeLessThanOrEqual(64);
});
it('bundles @ia manifests without the development condition, pinned by the bundled bytes', async () => {
  const { files, packages } = await collectPayload(repository);
  for (const pkg of packages.filter((p) => p.name.startsWith('@inventarch/'))) {
    const bytes = files.get(`runtime/node_modules/${pkg.name}/package.json`) as Buffer;
    expect(bytes.toString('utf8')).not.toContain('"development"');
    expect(pkg.manifestDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});
it('retains the exact shipped guide and reference documentation in the offline payload', async () => {
  const { files, packages } = await collectPayload(repository);
  let checked = 0;
  for (const pkg of packages.filter((p) => p.name.startsWith('@inventarch/'))) {
    const prefix = `runtime/node_modules/${pkg.name}/`,
      manifest = JSON.parse(files.get(prefix + 'package.json')!.toString('utf8'));
    for (const path of manifest.files ?? [])
      if (/^(?:README\.md|SPEC\.md|LANGUAGE\.md|references\/[A-Za-z0-9_.-]+\.md)$/.test(path)) {
        expect(files.has(prefix + path), prefix + path).toBe(true);
        checked++;
      }
    for (const path of files.keys())
      if (path.startsWith(prefix + 'references/')) expect(manifest.files).toContain(path.slice(prefix.length));
  }
  expect(checked).toBeGreaterThan(0);
});
it("runs the real launcher from the extracted payload regardless of the caller's Node conditions", async () => {
  const { archive } = await generateHostPayload({ repository, write: false }),
    dir = extract(archive),
    launcher = join(dir, 'scripts/ia.mjs');
  const verify = spawnSync(process.execPath, [launcher, 'verify'], { encoding: 'utf8', timeout: 10_000 });
  expect(verify.status, verify.stderr).toBe(0);
  expect(JSON.parse(verify.stdout)).toMatchObject({ status: 'verified', host: null });
  const env = { ...process.env, NODE_OPTIONS: '--conditions=development' };
  const door = spawnSync(
    process.execPath,
    [launcher, 'door', 'records', '--root', join(repository, 'packages/compliance/fixtures/loop')],
    { encoding: 'utf8', timeout: 10_000, env },
  );
  expect(door.status, door.stderr).toBe(0);
  expect(JSON.parse(door.stdout)).toMatchObject({ ok: true });
});

it('projects only the reviewed private development capability without mutating its source manifest', () => {
  const original = developmentManifest();
  const before = JSON.stringify(original),
    projected = staticCliManifest(original);
  expect(JSON.stringify(original)).toBe(before);
  expect(projected['exports']).not.toHaveProperty('./development');
  expect(projected).not.toHaveProperty('peerDependencies');
  expect(projected['bin']).toEqual(original.bin);
  expect(projected['dependencies']).not.toHaveProperty('@inventarch/architecture-system');
  expect(projected['dependencies']).not.toHaveProperty('@inventarch/code-quality-system');
});
it('projects the private CLI name (tools/release/private.mjs renames apps/cli) the same way', () => {
  const original = { ...developmentManifest(), name: '@inventarch/inventarch-cli' };
  const projected = staticCliManifest(original);
  expect(projected['exports']).not.toHaveProperty('./development');
  expect(projected).not.toHaveProperty('peerDependencies');
  expect(projected).not.toHaveProperty('peerDependenciesMeta');
  expect(projected['dependencies']).not.toHaveProperty('@inventarch/architecture-system');
  expect(projected['dependencies']).not.toHaveProperty('@inventarch/code-quality-system');
  const unreviewed = structuredClone(original);
  unreviewed.peerDependencies.other = '1';
  expect(() => staticCliManifest(unreviewed)).toThrow(/Unreviewed/);
});
it("excludes the private CLI's own embedded payload, so a repeat write does not grow it", async () => {
  // A private candidate as tools/release/private.mjs stages it: apps/cli renamed, its built files and embedded payload copied.
  const candidate = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-private-'))),
    cli = join(candidate, 'apps/cli');
  made.push(candidate);
  mkdirSync(cli, { recursive: true });
  for (const entry of ['dist', 'assets', 'LICENSE', 'README.md', 'SPEC.md'])
    cpSync(join(repository, 'apps/cli', entry), join(cli, entry), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, 'apps/cli/package.json'), 'utf8'));
  writeFileSync(
    join(cli, 'package.json'),
    JSON.stringify({ ...manifest, name: '@inventarch/inventarch-cli' }, null, 2) + '\n',
  );
  // Directory junctions need no privilege on Windows; the payload walk resolves installed packages through them.
  symlinkSync(join(repository, 'apps/cli/node_modules'), join(cli, 'node_modules'), 'junction');
  for (const app of ['distribution', 'mcp-door', 'steward-hook'])
    symlinkSync(join(repository, 'apps', app), join(candidate, 'apps', app), 'junction');
  const first = await generateHostPayload({ repository: candidate, write: true }),
    second = await generateHostPayload({ repository: candidate, write: true });
  expect(second.pin).toEqual(first.pin);
  const { files } = await collectPayload(candidate);
  expect([...files.keys()].some((path) => /@ia\/inventarch-cli\/assets\/host(\/|\.json$)/.test(path))).toBe(false);
});
it('refuses unreviewed manifest peers, entries, dependency coupling and retained aliases', () => {
  const original = developmentManifest();
  const mutations = [
    (m: typeof original) => {
      m.peerDependencies.other = '1';
    },
    (m: typeof original) => {
      m.exports['./development'].default = './dist/other.js';
    },
    (m: typeof original) => {
      m.exports['./development'].extra = './dist/other.js';
    },
    (m: typeof original) => {
      m.dependencies['@inventarch/architecture-system'] = '1.0.0';
    },
    (m: typeof original) => {
      m.optionalDependencies = { other: '1' };
    },
    (m: typeof original) => {
      m.exports['./review'] = './dist/inventarch-development/index.js';
    },
    (m: typeof original) => {
      m.bin.review = './dist/inventarch-development/index.js';
    },
    (m: typeof original) => {
      m.main = './assets/development-native.json';
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    expect(() => staticCliManifest(candidate)).toThrow();
  }
  const generic = { name: 'other', peerDependencies: { other: '1' } };
  expect(staticCliManifest(generic)).toEqual(generic);
});
it('refuses retained executable coupling to omitted owners', () => {
  for (const code of [
    "import '@inventarch/architecture-system'",
    "require('@inventarch/code-quality-system')",
    "import('./inventarch-development/index.js')",
    "import '@inventarch/monorepo-kit-host'",
  ])
    expect(() => assertStaticPayloadCode('dist/retained.js', Buffer.from(code))).toThrow(/omitted/);
  expect(() => assertStaticPayloadCode('dist/retained.js', Buffer.from("import '@inventarch/runtime'"))).not.toThrow();
});
