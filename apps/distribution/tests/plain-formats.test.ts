import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyHost, planHost, verifyHostCache } from '../src/host.js';
import { json, sha256, versionedDocument, versionedObject } from '../src/files.js';

const roots: string[] = [];
const temp = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-plain-formats-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
const code = (value: string) => expect.objectContaining({ code: value });

/** A v2 payload whose release and inventory declare themselves with the given format fields. */
function payload(release: Record<string, unknown>, cache: Record<string, unknown>): string {
  const root = temp(),
    content = '// inert payload\n',
    launcher = '// launcher fixture\n';
  const inventory = json({
    ...cache,
    version: '0.1.0',
    packages: [],
    files: [{ path: 'payload.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
  });
  put(root, 'payload.txt', content);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(root, 'release.json', json({ ...release, inventory: sha256(inventory), launcher: sha256(launcher) }));
  return root;
}

it('reads the plain host release and cache with their formatVersion and the exact legacy literals of version 2', () => {
  const plain = payload({ format: 'ia.host-release', formatVersion: 2 }, { format: 'ia.host-cache', formatVersion: 2 });
  expect(verifyHostCache(plain)).toMatchObject({ format: 2, version: '0.1.0' });
  const legacy = payload({ format: 'ia.host-release.v2' }, { format: 'ia.host-cache.v2' });
  expect(verifyHostCache(legacy)).toMatchObject({ format: 2 });
  // A release and inventory may each be in either form while they agree on the version.
  const mixed = payload({ format: 'ia.host-release', formatVersion: 2 }, { format: 'ia.host-cache.v2' });
  expect(verifyHostCache(mixed)).toMatchObject({ format: 2 });
});

it('refuses unknown host release and cache formats, versions and mixed versions', () => {
  const refusals: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ format: 'ia.host-release' }, { format: 'ia.host-cache', formatVersion: 2 }],
    [
      { format: 'ia.host-release', formatVersion: 3 },
      { format: 'ia.host-cache', formatVersion: 3 },
    ],
    [{ format: 'ia.host-release.v2', formatVersion: 2 }, { format: 'ia.host-cache.v2' }],
    [{ format: 'ia.host-release.v3' }, { format: 'ia.host-cache.v2' }],
    [
      { format: 'ia.host-release', formatVersion: 2 },
      { format: 'ia.host-cache', formatVersion: 1 },
    ],
    [{ format: 'ia.host-release', formatVersion: 2 }, { format: 'ia.host-cache.v1' }],
  ];
  for (const [release, cache] of refusals)
    expect(() => verifyHostCache(payload(release, cache))).toThrow(code('IA-DIST-INPUT-INVALID'));
});

it('writes host ownership state and the plan in the plain shape, reads the legacy state, and asks an older plan to be made again', () => {
  const root = temp(),
    cache = payload({ format: 'ia.host-release', formatVersion: 2 }, { format: 'ia.host-cache', formatVersion: 2 });
  const plan = planHost(root, 'claude', cache);
  expect(plan).toMatchObject({ format: 'ia.host-plan', formatVersion: 1 });
  expect(applyHost(plan).status).toBe('host-active');
  const state = resolve(root, '.ia/distributions/hosts/claude-workspace.json');
  const written = JSON.parse(readFileSync(state, 'utf8'));
  expect(written).toMatchObject({ format: 'ia.host-state', formatVersion: 1 });
  // The same state under the legacy literal is still owned: removing the registration plans and applies cleanly.
  const { formatVersion: _formatVersion, ...rest } = written;
  writeFileSync(state, json({ ...rest, format: 'ia.host-state.v1' }));
  const removal = planHost(root, 'claude', null, written.id);
  expect(applyHost(removal).status).toBe('host-removed');
  // A saved plan made before formatVersion digests its old body and is refused as stale, never misread.
  const old = { ...plan, format: 'ia.host-plan.v1' } as Record<string, unknown>;
  delete old['formatVersion'];
  expect(() => applyHost(old)).toThrow(code('IA-DIST-PLAN-STALE'));
  for (const bad of [
    { ...plan, formatVersion: 2 },
    { ...plan, format: 'ia.host-plan.v2' },
  ])
    expect(() => applyHost(bad)).toThrow(code('IA-DIST-INPUT-INVALID'));
});

it('versionedDocument maps each exact legacy literal to its version and refuses anything outside the allow-list', () => {
  const spec = { format: 'ia.example', versions: [1, 2], legacy: { 'ia.example.v1': 1, 'ia.example.v2': 2 } };
  expect(versionedDocument({ format: 'ia.example', formatVersion: 2, a: 1 }, spec, ['a'])).toMatchObject({
    version: 2,
    legacy: null,
  });
  expect(versionedDocument({ format: 'ia.example.v1', a: 1 }, spec, ['a'])).toMatchObject({
    version: 1,
    legacy: 'ia.example.v1',
  });
  for (const bad of [
    { format: 'ia.example.v3', a: 1 },
    { format: 'ia.example', formatVersion: 3, a: 1 },
    { format: 'ia.example', a: 1 },
    { format: 'ia.example.v1', formatVersion: 1, a: 1 },
    { format: 'ia.example.v1', a: 1, extra: true },
    null,
    [],
  ])
    expect(() => versionedDocument(bad, spec, ['a'])).toThrow(code('IA-DIST-INPUT-INVALID'));
  expect(
    versionedObject({ format: 'ia.example', formatVersion: 1 }, { format: 'ia.example', version: 1, legacy: [] }, []),
  ).toMatchObject({ legacy: null });
});
