import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

/** Every subpath @inventarch/agent-composition-system 1.1.0 published, in both export maps. */
const PUBLISHED_1_1_0 = [
  '.',
  './resources',
  './projections',
  './templates',
  './tools',
  './sources',
  './authoring',
  './authoring-manifest',
  './lifecycle',
  './lifecycle-profile',
  './adapters',
  './local-store',
  './internal/adapters',
  './internal/authoring-format',
  './internal/authoring-index',
  './internal/authoring-manifest',
  './internal/authoring-types',
  './internal/authoring',
  './internal/candidate',
  './internal/catalog',
  './internal/compile',
  './internal/compiled',
  './internal/corpus',
  './internal/execution',
  './internal/fields',
  './internal/index',
  './internal/inputs',
  './internal/installed-catalog',
  './internal/installed-read',
  './internal/installed-source-policy',
  './internal/lifecycle-profile',
  './internal/lifecycle-rows',
  './internal/lifecycle-transport',
  './internal/lifecycle',
  './internal/local-store',
  './internal/projection-codex',
  './internal/projection-format',
  './internal/projection-host',
  './internal/projection-routine',
  './internal/projections',
  './internal/publication',
  './internal/resource-context',
  './internal/resource-files',
  './internal/resource-format',
  './internal/resource-sources',
  './internal/resources',
  './internal/sources',
  './internal/task-capture-format',
  './internal/task-capture',
  './internal/task-context-declaration',
  './internal/task-teaching-closure',
  './internal/templates',
  './internal/tools',
];
/** The deprecated subpath aliases and the @inventarch/workspace-runtime module each one forwards to. */
const ALIASES: readonly (readonly [alias: string, target: string])[] = [
  ...[
    'resources',
    'projections',
    'templates',
    'sources',
    'authoring',
    'authoring-manifest',
    'lifecycle',
    'lifecycle-profile',
    'adapters',
    'local-store',
  ].map((name) => [name, `@inventarch/workspace-runtime/${name}`] as const),
  ...[
    'authoring-format',
    'authoring-index',
    'authoring-types',
    'candidate',
    'corpus',
    'installed-source-policy',
    'lifecycle-rows',
    'lifecycle-transport',
    'projection-codex',
    'projection-format',
    'projection-host',
    'projection-routine',
    'publication',
    'resource-context',
    'resource-files',
    'resource-format',
    'resource-sources',
    'task-capture-format',
  ].map((name) => [name, `@inventarch/workspace-runtime/internal/${name}`] as const),
];

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly publishConfig: { readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>> };
};

it('keeps every 1.1.0 subpath in both export maps, each backed by an emitted module', () => {
  for (const key of PUBLISHED_1_1_0) {
    const name = key === '.' ? 'index' : (key.split('/').pop() as string),
      emitted = { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` };
    expect(manifest.publishConfig.exports[key], key).toEqual(emitted);
    expect(manifest.exports[key], key).toMatchObject(emitted);
    expect(existsSync(resolve(root, 'src', `${name}.ts`)), key).toBe(true);
  }
});

it('forwards each deprecated alias to exactly the bindings of its workspace-runtime module', async () => {
  for (const [alias, target] of ALIASES) {
    // A plain variable keeps the bundler from rewriting the import into a fixed glob of emitted files.
    const source = `../src/${alias}.js`,
      shim = (await import(source)) as Record<string, unknown>,
      moved = (await import(target)) as Record<string, unknown>;
    expect(Object.keys(shim), alias).toEqual(Object.keys(moved));
    for (const name of Object.keys(moved)) expect(shim[name], `${alias}: ${name}`).toBe(moved[name]);
  }
}, 60_000);
