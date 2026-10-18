import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { compiledSystemFolders, publicSystemNames } from './public-systems.mjs';

it('derives the selected systems and compiled subset, refusing duplicate and unsafe names', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-public-systems-'));
  try {
    const put = (path: string, value: unknown) => {
      mkdirSync(resolve(root, path, '..'), { recursive: true });
      writeFileSync(resolve(root, path), JSON.stringify(value));
    };
    const manifest = (names: string[]) => ({
      version: 1,
      floor: ['.ia/src/floor/kernel.schema.ia'],
      examples: [],
      systems: names.map((name) => ({
        name,
        declaration: 'contracts/' + name + '.ia',
        schemas: ['.ia/src/systems/' + name + '/schemas/item.schema.ia'],
      })),
    });
    put('examples/public-language/manifest.json', manifest(['one-system', 'two-system']));
    put('.ia/src/systems/one-system/package.json', { scripts: { build: 'tsc' } });
    put('.ia/src/systems/two-system/package.json', {});
    expect(publicSystemNames(root)).toEqual(['one-system', 'two-system']);
    expect(compiledSystemFolders(root)).toEqual(['.ia/src/systems/one-system']);
    for (const names of [['one-system', 'one-system'], ['../one-system'], []]) {
      put('examples/public-language/manifest.json', manifest(names));
      expect(() => publicSystemNames(root)).toThrow(/membership/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
