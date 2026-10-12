/** Reproduce the native bytes selected by the public packers, without writing a package or loading handlers. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readInputs } from '@inventarch/db';
import { distributionSnapshot, packSnapshot, packSnapshotSet } from '../../apps/distribution/src/snapshot.js';
import { languageBaseDescriptor, languageVersion } from '../native/language-base.js';
import { languagePackageInputs } from '../native/public-language.js';
import { systemArchivePartitions, type NativeSystemOwner } from './system-partitions.js';

export interface NativeArchive {
  id: string;
  version: string;
  archive: string;
  manifest: string;
  dependencies: string[];
}
export const NATIVE_SYSTEM_POLICY = 'tools/distribution/system-package-policy.json';
export const NATIVE_LANGUAGE_POLICY = 'examples/public-language/versions.json';
export const readJson = (root: string, path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export function nativeOwners(root: string): NativeSystemOwner[] {
  const policy = readJson(root, NATIVE_SYSTEM_POLICY);
  assert.equal(policy.format, 'ia.system-package-policy.v2');
  return policy.owners.map((row: { native: NativeSystemOwner }) => row.native);
}
export function nativeVersions(root: string): Record<string, string> {
  return Object.fromEntries([
    ['inventarch/language', languageVersion(root)],
    ...nativeOwners(root).map((row) => [row.id, row.version]),
  ]);
}
/** Only the selected declaration's version field may change; headers and other versions are untouched. */
export function declarationVersion(text: string, from: string, to: string): string {
  const matches = [...text.matchAll(/^  version "([^"\r\n]+)"\r?$/gm)];
  assert.equal(matches.length, 1, 'Native declaration must have exactly one version');
  assert.equal(matches[0]![1], from, 'Native declaration differs from selected policy');
  return text.replace(/^(  version ")[^"\r\n]+("\r?)$/m, `$1${to}$2`);
}
/** Version overrides normalize identity metadata only, so a version-only edit cannot manufacture a content bump. */
export function nativeArchives(root: string, overrides?: Readonly<Record<string, string>>): NativeArchive[] {
  const owners = nativeOwners(root),
    selected = nativeVersions(root);
  const versions = overrides ?? selected;
  assert.deepEqual(Object.keys(versions).sort(), Object.keys(selected).sort(), 'Native identity inventory changed');
  const transform = <T extends { path: string; text: string }>(source: T): T => {
    const owner = owners.find((row) => source.path === `.ia/src/systems/${row.system}/system.ia`);
    return owner ? { ...source, text: declarationVersion(source.text, owner.version, versions[owner.id]!) } : source;
  };
  const before = readInputs(root),
    resources = readJson(root, '.ia/authoring.resources.json');
  const snapshot = distributionSnapshot({
    sources: before.sources.map(transform),
    folders: before.folders,
    floorOrigin: before.floorOrigin,
  });
  const assets = new Map<string, Buffer>(
    ['LICENSE', 'NOTICE', ...resources.files.map((row: { path: string }) => row.path)].map((path) => [
      path,
      readFileSync(resolve(root, path)),
    ]),
  );
  const partitions = systemArchivePartitions(
    snapshot,
    resources,
    assets,
    owners.map((row) => ({ ...row, version: versions[row.id]! })),
  );
  const systems = packSnapshotSet(snapshot, partitions);
  const languageInputs = languagePackageInputs(root);
  const language = packSnapshot(
    distributionSnapshot({
      sources: languageInputs.inputs.map(transform),
      folders: languageInputs.folders,
      floorOrigin: 'local',
    }),
    languageBaseDescriptor(versions['inventarch/language']!),
    new Map(['LICENSE', 'NOTICE'].map((path) => [path, assets.get(path)!])),
  );
  assert.equal(readInputs(root).fingerprint, before.fingerprint, 'Native inputs changed during packing');
  return [...systems, language]
    .map((row) => ({
      id: row.manifest.id,
      version: row.manifest.version,
      archive: row.archiveDigest,
      manifest: row.manifestDigest,
      // The language embeds every public system declaration, despite having no install-time dependency.
      dependencies:
        row.manifest.id === 'inventarch/language'
          ? owners.map((owner) => owner.id).sort()
          : row.manifest.dependencies.map((dependency) => dependency.id).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
