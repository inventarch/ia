import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

/** Every subpath the package publishes: the root, `./tools` and the `./internal/*` subpath of each module it owns. */
const PUBLISHED = [
  '.',
  './tools',
  './internal/catalog',
  './internal/compile',
  './internal/compiled',
  './internal/execution',
  './internal/fields',
  './internal/index',
  './internal/inputs',
  './internal/installed-catalog',
  './internal/installed-read',
  './internal/task-capture',
  './internal/task-context-declaration',
  './internal/task-teaching-closure',
  './internal/tools',
];

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly publishConfig: { readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>> };
};

it('publishes exactly the owned subpaths in both export maps, each backed by an emitted module', () => {
  expect(Object.keys(manifest.exports)).toEqual(PUBLISHED);
  expect(Object.keys(manifest.publishConfig.exports)).toEqual(PUBLISHED);
  for (const key of PUBLISHED) {
    const name = key === '.' ? 'index' : (key.split('/').pop() as string),
      emitted = { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` };
    expect(manifest.publishConfig.exports[key], key).toEqual(emitted);
    expect(manifest.exports[key], key).toMatchObject(emitted);
    expect(existsSync(resolve(root, 'src', `${name}.ts`)), key).toBe(true);
  }
});

it('forwards no whole @inventarch/workspace-runtime module', () => {
  for (const key of PUBLISHED) {
    const name = key === '.' ? 'index' : (key.split('/').pop() as string);
    expect(readFileSync(resolve(root, 'src', `${name}.ts`), 'utf8'), key).not.toMatch(
      /^export \* from '@inventarch\/workspace-runtime/m,
    );
  }
});
