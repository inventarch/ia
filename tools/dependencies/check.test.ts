import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkDependencies, importedModules, moduleProblem } from './check.js';

it('inspects declarations, reexports, require, import-equals and dynamic loads', () => {
  expect(
    importedModules(
      'import x from "@inventarch/db"; export * from "@inventarch/runtime"; const y = require("@inventarch/graph"); const z = import("@inventarch/language"); import a = require("@inventarch/compliance"); import(name);',
      'x.ts',
    ),
  ).toEqual([
    '@inventarch/db',
    '@inventarch/runtime',
    '@inventarch/graph',
    '@inventarch/language',
    '@inventarch/compliance',
    null,
  ]);
});
it('checks inline import types that can enter emitted declaration files', () => {
  expect(
    importedModules(
      'type Hidden = import("@inventarch/runtime").Handle; type Value = typeof import("@inventarch/db");',
      'x.ts',
    ),
  ).toEqual(['@inventarch/runtime', '@inventarch/db']);
});
it('refuses allowed source dependencies absent from the installed manifest', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-dependencies-'));
  try {
    const component = resolve(root, 'packages/graph');
    mkdirSync(resolve(component, 'src'), { recursive: true });
    writeFileSync(
      resolve(component, 'package.json'),
      JSON.stringify({ name: '@inventarch/graph', devDependencies: { '@inventarch/language': '*' } }),
    );
    writeFileSync(
      resolve(component, 'src/index.ts'),
      'export type Record = import("@inventarch/language").CompiledRecord;',
    );
    expect(checkDependencies(root)).toHaveLength(1);
    expect(checkDependencies(root)[0]).toContain('@inventarch/language is allowed but not declared');
    writeFileSync(
      resolve(component, 'package.json'),
      JSON.stringify({ name: '@inventarch/graph', dependencies: { '@inventarch/language': '*' } }),
    );
    expect(checkDependencies(root)).toEqual([]);
    writeFileSync(resolve(component, 'src/index.ts'), 'export type Hidden = import("@inventarch/runtime").Handle;');
    expect(checkDependencies(root)[0]).toContain('@inventarch/graph may not depend on @inventarch/runtime');
  } finally {
    if (!root.startsWith(resolve(tmpdir(), 'ia-dependencies-'))) throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
it('enforces the package map and rejects cross-package relative paths', () => {
  const owner = { name: '@inventarch/graph', path: resolve('packages/graph'), app: false },
    file = resolve(owner.path, 'src/index.ts');
  expect(moduleProblem(owner, file, '@inventarch/language')).toBeUndefined();
  expect(moduleProblem(owner, file, './text.js')).toBeUndefined();
  for (const specifier of [
    '@inventarch/db',
    '@inventarch/runtime/private',
    '@inventarch/unknown',
    '../../language/src/index.ts',
    null,
  ])
    expect(moduleProblem(owner, file, specifier)).toBeDefined();
  expect(moduleProblem({ ...owner, name: '@inventarch/cli', app: true }, file, '@inventarch/graph')).toBeDefined();
  expect(moduleProblem({ ...owner, name: '@inventarch/cli', app: true }, file, '@inventarch/runtime')).toBeUndefined();
});
it('checks manifests and source while excluding composition-root tools and tests', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-dependencies-'));
  try {
    const component = resolve(root, 'packages/language');
    mkdirSync(resolve(component, 'src'), { recursive: true });
    mkdirSync(resolve(component, 'tests'));
    writeFileSync(
      resolve(component, 'package.json'),
      JSON.stringify({ name: '@inventarch/language', dependencies: { '@inventarch/db': '*' } }),
    );
    writeFileSync(resolve(component, 'src/index.ts'), 'export * from "@inventarch/graph";');
    writeFileSync(resolve(component, 'tests/x.ts'), 'import "@inventarch/runtime";');
    const findings = checkDependencies(root);
    expect(findings).toHaveLength(2);
    expect(findings.join('\n')).toContain('@inventarch/db');
    expect(findings.join('\n')).toContain('@inventarch/graph');
  } finally {
    if (!root.startsWith(resolve(tmpdir(), 'ia-dependencies-'))) throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
// Walks the whole installed package tree: 6.2 s on a Windows runner, past the unit profile's 5 s default.
it('verifies the actual runtime package tree', () => {
  expect(checkDependencies(resolve(import.meta.dirname, '../..'))).toEqual([]);
}, 20_000);

it('keeps client contracts browser-safe and foundation independent of service transports', () => {
  const owner = { name: '@inventarch/service-contracts', path: resolve('packages/service-contracts'), app: false },
    file = resolve(owner.path, 'src/index.ts');
  expect(moduleProblem(owner, file, 'zod')).toBeUndefined();
  for (const target of ['node:fs', 'fastify', '@inventarch/service-host', '@inventarch/runtime'])
    expect(moduleProblem(owner, file, target)).toBeDefined();
  for (const name of ['@inventarch/language', '@inventarch/runtime', '@inventarch/agent-system'])
    expect(moduleProblem({ ...owner, name }, file, '@inventarch/service-host')).toBeDefined();
});

it('keeps foundation independent from execution and admits only explicitly installed execution hosts', () => {
  const check = (name: string, app: boolean, target: string) =>
    moduleProblem({ name, app, path: resolve('fixture') }, resolve('fixture/src/index.ts'), target);
  expect(check('@inventarch/runtime', false, '@inventarch/agent-system')).toBeDefined();
  expect(check('@inventarch/session-system', false, '@inventarch/agent-system')).toBeDefined();
  expect(check('@inventarch/agent-system', false, '@inventarch/agent-composition-system')).toBeDefined();
  expect(check('@inventarch/agent-composition-system', false, '@inventarch/agent-system')).toBeUndefined();
  expect(check('@inventarch/agent-runner', true, '@inventarch/session-system/sqlite')).toBeUndefined();
  expect(check('@inventarch/cli', true, '@inventarch/session-system')).toBeDefined();
  expect(check('@inventarch/cli', true, '@inventarch/inventarch-system')).toBeUndefined();
  expect(check('@inventarch/folio', true, '@inventarch/language')).toBeUndefined();
  expect(check('@inventarch/folio', true, '@inventarch/runtime')).toBeDefined();
  expect(check('@inventarch/inventarch-system', false, '@inventarch/runtime')).toBeUndefined();
  expect(check('@inventarch/runtime', false, '@inventarch/inventarch-system')).toBeDefined();
});

it('refuses nonliteral producer loads even at the former exempt CLI path', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-dependencies-loader-'));
  try {
    const owner = resolve(root, 'apps/cli'),
      directory = resolve(owner, 'src/inventarch-development'),
      file = resolve(directory, 'producer-worker.mjs');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(owner, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', peerDependencies: { '@inventarch/monorepo-kit-host': '1.0.0' } }),
    );
    for (const source of [
      'const module = "@inventarch/monorepo-kit-host/development"; await import(module);',
      'import { pathToFileURL } from "node:url"; await import(pathToFileURL(entry).href);',
      'await import(request.module);',
      'require(request.module);',
    ]) {
      writeFileSync(file, source);
      const findings = checkDependencies(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('Nonliteral module load cannot establish dependency direction');
    }
  } finally {
    if (!root.startsWith(resolve(tmpdir(), 'ia-dependencies-loader-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires a literal development host capability in the installed CLI manifest', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-dependencies-loader-'));
  try {
    const owner = resolve(root, 'apps/cli'),
      file = resolve(owner, 'src/inventarch-development/producer-worker.mjs');
    mkdirSync(resolve(owner, 'src/inventarch-development'), { recursive: true });
    writeFileSync(file, 'export const producer = await import("@inventarch/monorepo-kit-host/development");');
    writeFileSync(resolve(owner, 'package.json'), JSON.stringify({ name: '@inventarch/cli' }));
    expect(checkDependencies(root).join('\n')).toContain('@inventarch/monorepo-kit-host is allowed but not declared');
    writeFileSync(
      resolve(owner, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', peerDependencies: { '@inventarch/monorepo-kit-host': '1.0.0' } }),
    );
    expect(checkDependencies(root)).toEqual([]);
    writeFileSync(
      resolve(owner, 'package.json'),
      JSON.stringify({ name: '@inventarch/mcp-door', peerDependencies: { '@inventarch/monorepo-kit-host': '1.0.0' } }),
    );
    expect(checkDependencies(root)).toHaveLength(2);
    expect(checkDependencies(root).every((finding) => finding.includes('Only the CLI may select'))).toBe(true);
    writeFileSync(
      resolve(owner, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', peerDependencies: { '@inventarch/monorepo-kit-host': '1.0.0' } }),
    );
    writeFileSync(file, 'await import("@inventarch/monorepo-kit-host/private");');
    expect(checkDependencies(root).join('\n')).toContain('Only the CLI may select');
  } finally {
    if (!root.startsWith(resolve(tmpdir(), 'ia-dependencies-loader-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
