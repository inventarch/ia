import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import {
  checkout,
  inQualifiedCohort,
  evidence,
  receipts,
  archivesFixture,
  compatibilityFixture,
} from './release-fixtures.js';
import { writeReleaseManifest } from './npm-release.mjs';
import { releaseArtifacts, qualificationManifest } from './consumer.mjs';

it('removes only SDK-owned output after a verified cohort reaches installation failure', async () => {
  const fixture = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-sdk-cleanup-test-'));
  const directory = resolve(fixture, 'archives'),
    output = resolve(fixture, 'output'),
    store = resolve(fixture, 'store');
  mkdirSync(directory);
  mkdirSync(store);
  const archives = archivesFixture(directory);
  compatibilityFixture(directory);
  writeReleaseManifest(checkout, directory, receipts(archives), evidence());
  const originalReceipt = readFileSync(resolve(directory, 'npm-release.json'));
  const sourceMarker = readFileSync(resolve(checkout, 'package.json'));
  writeFileSync(resolve(store, 'keep'), 'unrelated store evidence');
  const argv = process.argv;
  const install = vi.fn(() => {
    expect(existsSync(resolve(output, 'sdk-runtime/recipe.mjs'))).toBe(true);
    throw new Error('intentional-sdk-installation-failure');
  });
  vi.doMock('../release/public-pack.mjs', async (original) => ({
    ...(await original<typeof import('../release/public-pack.mjs')>()),
    publicPackageInputs: () => evidence().inputs,
  }));
  vi.doMock('./consumer.mjs', async (original) => ({
    ...(await original<typeof import('./consumer.mjs')>()),
    releaseArtifacts: (candidate: string, path: string) => releaseArtifacts(candidate, path, evidence()),
    installConsumer: install,
  }));
  process.argv = [
    process.execPath,
    resolve(checkout, 'tools/distribution/qualify-sdk.mjs'),
    checkout,
    directory,
    output,
    process.execPath,
    store,
  ];
  try {
    await expect(import('./qualify-sdk.mjs')).rejects.toThrow('intentional-sdk-installation-failure');
    expect(install).toHaveBeenCalledOnce();
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(resolve(directory, 'npm-release.json'))).toEqual(originalReceipt);
    expect(readFileSync(resolve(checkout, 'package.json'))).toEqual(sourceMarker);
    expect(readFileSync(resolve(store, 'keep'), 'utf8')).toBe('unrelated store evidence');
  } finally {
    process.argv = argv;
    vi.doUnmock('../release/public-pack.mjs');
    vi.doUnmock('./consumer.mjs');
    vi.resetModules();
    rmSync(fixture, { recursive: true, force: true });
  }
});

it('consumes controlled sealed release receipts through the separate release verifier', () => {
  inQualifiedCohort((directory, archives) => {
    writeReleaseManifest(checkout, directory, receipts(archives), evidence());
    const selected = releaseArtifacts(checkout, directory, evidence());
    expect(selected.packed.map((row) => row.sha256).sort()).toEqual(archives.map((row) => row.sha256).sort());
    writeFileSync(resolve(directory, archives[0]!.filename), 'changed');
    expect(() => releaseArtifacts(checkout, directory, evidence())).toThrow();
  });
});

it('refuses ordinary qualification and missing or stale release evidence before SDK output', () => {
  inQualifiedCohort((directory, archives) => {
    expect(() => releaseArtifacts(checkout, directory)).toThrow();
    writeFileSync(
      resolve(directory, 'qualification.json'),
      JSON.stringify(qualificationManifest(checkout, directory, archives)),
    );
    expect(() => releaseArtifacts(checkout, directory, evidence())).toThrow(/release receipt/i);
    const output = resolve(directory, 'sdk-output');
    const result = spawnSync(
      process.execPath,
      ['tools/distribution/qualify-sdk.mjs', checkout, directory, output, 'not-a-launcher', 'not-a-store'],
      { cwd: checkout, encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
    writeReleaseManifest(checkout, directory, receipts(archives), evidence());
    expect(() => releaseArtifacts(checkout, directory)).toThrow(/Changed/);
  });
});
