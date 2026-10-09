import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
/** Every package manifest under the package roots, private ones included, with its exact text. */
function manifests(root) {
  const rows = [];
  for (const parent of ['packages', 'apps', '.ia/src/systems']) {
    for (const child of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${child.name}`;
      const path = resolve(root, directory, 'package.json');
      if (child.isDirectory() && existsSync(path)) {
        const text = readFileSync(path, 'utf8');
        rows.push({ directory, text, manifest: JSON.parse(text) });
      }
    }
  }
  return rows;
}
export function publicPackages(root) {
  const projects = manifests(root)
    .filter(({ manifest }) => !manifest.private)
    .map(({ directory, manifest }) => ({ directory, manifest }));
  assert.ok(projects.length, 'No public packages found');
  return dependencyOrder(projects);
}

/** A string exports value is shorthand for the root subpath. */
const subpaths = (exports) => (typeof exports === 'string' ? { '.': exports } : (exports ?? {}));
/** The entry a package publishes for one it develops against: the same conditions, in order, less `development`. */
const published = (entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).filter(([condition]) => condition !== 'development'))
    : entry;
/**
 * Manifest problems `pnpm release:check` refuses, sorted. Every manifest under the package roots keeps the bytes of
 * `JSON.stringify(manifest, null, 2)` and one final newline, the form the version rewrite matches line by line. A
 * public package publishes exactly the entrypoints it develops against: packing replaces `exports` with
 * `publishConfig.exports`, so both declare the same subpaths, and each published entry is its `exports` entry without
 * the `development` condition, which points at sources the package does not ship.
 */
export function manifestProblems(root) {
  const problems = [];
  for (const { directory, text, manifest } of manifests(root)) {
    const path = `${directory}/package.json`;
    if (text !== JSON.stringify(manifest, null, 2) + '\n')
      problems.push(`${path}: not written as JSON.stringify(manifest, null, 2) and one final newline`);
    if (manifest.private) continue;
    const developed = subpaths(manifest.exports),
      packed = subpaths(manifest.publishConfig?.exports);
    for (const subpath of Object.keys(developed))
      if (!Object.hasOwn(packed, subpath)) problems.push(`${path}: publishConfig.exports omits ${subpath}`);
      else if (JSON.stringify(packed[subpath]) !== JSON.stringify(published(developed[subpath])))
        problems.push(`${path}: publishConfig.exports ${subpath} differs from exports ${subpath} without development`);
    for (const subpath of Object.keys(packed))
      if (!Object.hasOwn(developed, subpath)) problems.push(`${path}: exports omits ${subpath}`);
  }
  return problems.sort();
}

export function dependencyOrder(projects) {
  const byName = new Map(projects.map((project) => [project.manifest.name, project]));
  assert.equal(byName.size, projects.length, 'Duplicate public package name');
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(name) {
    assert.ok(!visiting.has(name), `Package dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const project = byName.get(name);
    for (const dependency of Object.keys(project.manifest.dependencies ?? {}).sort()) {
      if (byName.has(dependency)) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(project);
  }
  for (const name of [...byName.keys()].sort()) visit(name);
  return ordered;
}
