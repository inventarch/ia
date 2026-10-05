import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function publicPackages(root) {
  const projects = [];
  for (const parent of ['packages', 'apps', '.ia/src/systems']) {
    for (const child of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${child.name}`;
      const path = resolve(root, directory, 'package.json');
      if (child.isDirectory() && existsSync(path)) {
        const manifest = json(path);
        if (!manifest.private) projects.push({ directory, manifest });
      }
    }
  }
  assert.ok(projects.length, 'No public packages found');
  return dependencyOrder(projects);
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
