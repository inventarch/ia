import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { RECIPE_VERSION, RECIPE_FILES, RECIPE_TOOL_MODULES, recipeFiles } from './recipe.mjs';
import { compatibilityFixture, inQualifiedCohort, checkout, evidence } from '../distribution/release-fixtures.js';
import { verifyPublicCompatibility } from './public-pack.mjs';

const root = resolve(import.meta.dirname, '../..');
const frozen = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/recipe-v2.json'), 'utf8')) as {
  digest: string;
  files: { path: string; sha256: string }[];
};

it('preserves the frozen v2 recipe rows and digest without inferring membership from a directory', () => {
  const old = frozen.files.filter(
    (row) => row.path.startsWith('tools/release/') || row.path === 'tools/distribution/system-package-policy.json',
  );
  expect(RECIPE_VERSION).toBe('ia.packing-recipe.v1');
  expect(old).toHaveLength(26);
  expect(recipeFiles(frozen.files)).toEqual(old);
  expect(
    createHash('sha256')
      .update(JSON.stringify(recipeFiles(frozen.files)))
      .digest('hex'),
  ).toBe(frozen.digest);
  const extra = { path: 'tools/release/unreviewed.mjs', sha256: 'f'.repeat(64) };
  expect(recipeFiles([...frozen.files, extra])).toEqual(old);
  expect(() => recipeFiles(frozen.files.slice(1))).toThrow(/missing recipe input/i);
  expect(() => recipeFiles([...frozen.files, frozen.files[0]!])).toThrow(/duplicate/i);
});

/** Follow syntax, including side effects, re-exports and literal dynamic imports; never infer edges from a regex. */
function toolingClosure(overrides = new Map<string, string>()) {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    expect(RECIPE_TOOL_MODULES, `Unlisted packing implementation: ${path}`).toContain(path);
    const source = ts.createSourceFile(
      path,
      overrides.get(path) ?? readFileSync(resolve(root, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const dependency = (specifier: string) => {
      if (!specifier.startsWith('.') && !specifier.startsWith('@tools/')) return;
      let target = specifier.startsWith('@tools/')
        ? 'tools/' + specifier.slice('@tools/'.length)
        : posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!target.startsWith('tools/')) return;
      if (!existsSync(resolve(root, target)) && target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
      visit(target);
    };
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        dependency(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteralLike(argument))
          throw Error('Packing implementation has an unreviewable dynamic import: ' + path);
        dependency(argument.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const path of RECIPE_FILES)
    if (/\.(?:mjs|ts)$/.test(path) && !/(?:\.d\.mts|\.test\.ts)$/.test(path)) visit(path);
  return [...seen].sort();
}

it('explicitly accounts for the transitive tooling implementation and catches new import edges', () => {
  expect(toolingClosure()).toEqual([...RECIPE_TOOL_MODULES].sort());
  const path = 'tools/release/pack-manifest.mjs';
  for (const statement of [
    "import '../shared/unlisted.mjs';",
    "export * from '../shared/unlisted.mjs';",
    "import('../shared/unlisted.mjs');",
    "require('../shared/unlisted.mjs');",
    "import '@tools/shared/unlisted.mjs';",
  ]) {
    expect(() => toolingClosure(new Map([[path, statement]]))).toThrow(/Unlisted packing implementation/);
  }
  expect(() => toolingClosure(new Map([[path, 'import(process.env.PACK_HELPER);']]))).toThrow(
    /unreviewable dynamic import/,
  );
});

it('uses the same selection in compatibility fixtures and refuses an altered recipe', () => {
  inQualifiedCohort((directory) => {
    const companion = compatibilityFixture(directory);
    expect(companion.recipe.files).toEqual(recipeFiles(evidence().inputs.receipt.files));
    expect(() =>
      verifyPublicCompatibility(checkout, directory, undefined, { inputs: evidence().inputs }),
    ).not.toThrow();
    companion.recipe.files[0]!.sha256 = 'f'.repeat(64);
    // Rewriting the companion also invalidates the outer digest when supplied; omit it to exercise the recipe comparison itself.
    writeFileSync(resolve(directory, 'system-compatibility.json'), JSON.stringify(companion));
    expect(() => verifyPublicCompatibility(checkout, directory, undefined, { inputs: evidence().inputs })).toThrow(
      /source or recipe differs/,
    );
  });
});
