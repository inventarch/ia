import assert from 'node:assert/strict';
/** Data-only exports are qualified through their complete native/binding closure, never imported as JS. */
export function executableExports(manifest) {
  const code = [];
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === './native.ia.tgz' || key === './system-package.json') {
      assert.equal(
        target,
        key === './native.ia.tgz' ? './dist/native.ia.tgz' : './dist/system-package.json',
        'Unreviewed data export target',
      );
      continue;
    }
    const runtime = typeof target === 'string' ? target : target?.default;
    assert.ok(
      typeof runtime === 'string' && runtime.startsWith('./dist/') && /\.(?:mjs|cjs|js)$/.test(runtime),
      'Unknown executable export: ' + key,
    );
    code.push(manifest.name + (key === '.' ? '' : key.slice(1)));
  }
  return code;
}
export const systemVerificationProgram = [
  "import { verifySystemPackage } from '@inventarch/distribution/system-package';",
  "import { verifySelectedArchiveClosure } from '@inventarch/distribution/archive';",
  "import { deriveGenerationInputs } from '@inventarch/db/distribution';",
  "import assert from 'node:assert/strict'; import { readFileSync, realpathSync } from 'node:fs'; import { resolve } from 'node:path';",
  "const compatibility = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
  "const roots = new Map(compatibility.packages.map(row => [row.package.name, realpathSync(resolve(process.argv[3], 'node_modules', row.package.name))]));",
  'const archives = new Map(compatibility.packages.map(row => [row.native.archiveSha256, readFileSync(resolve(roots.get(row.package.name), row.native.path))]));',
  'for (const row of compatibility.packages) { verifySystemPackage(roots.get(row.package.name), row.bindingSha256, { archives }); assert.throws(() => verifySystemPackage(roots.get(row.package.name), row.bindingSha256)); const incomplete = new Map(archives); incomplete.delete(row.native.archiveSha256); assert.throws(() => verifySystemPackage(roots.get(row.package.name), row.bindingSha256, { archives: incomplete })); }',
  "const lock = JSON.parse(readFileSync(resolve(roots.values().next().value, 'dist/native-selection.json'), 'utf8')); const verified = verifySelectedArchiveClosure(lock, archives); const generation = deriveGenerationInputs(lock, verified);",
  'assert.equal(verified.size, compatibility.packages.length); assert.equal(generation.systems.length, compatibility.packages.length); assert.ok(generation.systems.every(row => row.bundles.length === 1));',
  "console.log(JSON.stringify({ systems: compatibility.packages.length, uniqueOwners: generation.systems.length, missingClosureRefusals: compatibility.packages.length * 2, outcome: 'pass' }));",
].join('\n');
