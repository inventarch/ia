import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { installedDistributionDigest } from '../src/inventory.js';

it('pins every installed distribution runtime module and refuses a partial or mixed installation', () => {
  expect(installedDistributionDigest()).toMatch(/^[a-f0-9]{64}$/);
  const root = mkdtempSync(join(tmpdir(), 'ia-distribution-code-'));
  try {
    for (const name of [
      'archive',
      'pack',
      'resolve',
      'snapshot',
      'install',
      'installation-core',
      'inventory',
      'transfer',
    ])
      writeFileSync(join(root, `${name}.js`), '// Executable fixture.\n');
    const before = installedDistributionDigest(root);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'helper.js'), '// Altered implementation.\n');
    expect(installedDistributionDigest(root)).not.toBe(before);
    const changed = installedDistributionDigest(root);
    writeFileSync(join(root, 'archive.d.ts'), '// Declaration only.\n');
    expect(installedDistributionDigest(root)).toBe(changed);
    expect(() => installedDistributionDigest(`${root}/nested/..`)).toThrow();
    writeFileSync(join(root, 'archive.ts'), '// Mixed loaded modes.\n');
    expect(() => installedDistributionDigest(root)).toThrow();
  } finally {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe inventory cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
