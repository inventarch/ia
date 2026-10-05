import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifestCache = new Map();
/** Parse the same bytes whose integrity was checked; never reopen a mutable archive between hash and manifest reads. */
export function packedManifest(path, qualifiedBytes = readFileSync(path)) {
  const key = createHash('sha256').update(qualifiedBytes).digest('hex');
  if (manifestCache.has(key)) return structuredClone(manifestCache.get(key));
  const run = (args) =>
    execFileSync('tar', args, {
      input: qualifiedBytes,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const names = run(['-tzf', '-']).trim().split(/\r?\n/);
  assert.equal(names.filter((name) => name === 'package/package.json').length, 1, 'Archive needs one package manifest');
  assert.ok(run(['-tvzf', '-', 'package/package.json']).startsWith('-'), 'Package manifest must be a regular file');
  const manifest = JSON.parse(run(['-xzOf', '-', 'package/package.json']));
  if (manifestCache.size >= 128) manifestCache.delete(manifestCache.keys().next().value);
  manifestCache.set(key, manifest);
  return structuredClone(manifest);
}
export function releaseGraph(manifests, version, allowedCycles) {
  const names = manifests.map((row) => row.name).sort();
  assert.equal(new Set(names).size, names.length, 'Duplicate packed package');
  const edges = new Map();
  for (const row of manifests) {
    assert.equal(row.version, version, `${row.name}: packed cohort version differs`);
    const dependencies = {};
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [name, range] of Object.entries(row[section] ?? {})) {
        assert.equal(typeof range, 'string');
        assert.ok(
          !/^(workspace:|catalog:|file:|link:|https?:|git[+:]|github:|gitlab:|bitbucket:)/.test(range),
          `${row.name}: unsupported packed dependency source`,
        );
        assert.ok(!name.startsWith('@ia/'), 'Private dependency in public archive');
        if (name.startsWith('@inventarch/')) {
          assert.ok(names.includes(name), `${row.name}: missing cohort dependency ${name}`);
          assert.equal(range, version, `${row.name}: dependency ${name} must use exact cohort version`);
          dependencies[name] = range;
        }
      }
    edges.set(row.name, Object.keys(dependencies).sort());
  }
  let next = 0;
  const indices = new Map(),
    low = new Map(),
    stack = [],
    onStack = new Set(),
    groups = [];
  function visit(name) {
    indices.set(name, next);
    low.set(name, next++);
    stack.push(name);
    onStack.add(name);
    for (const child of edges.get(name)) {
      if (!indices.has(child)) {
        visit(child);
        low.set(name, Math.min(low.get(name), low.get(child)));
      } else if (onStack.has(child)) low.set(name, Math.min(low.get(name), indices.get(child)));
    }
    if (low.get(name) === indices.get(name)) {
      const members = [];
      let child;
      do {
        child = stack.pop();
        onStack.delete(child);
        members.push(child);
      } while (child !== name);
      groups.push(members.sort());
    }
  }
  for (const name of names) if (!indices.has(name)) visit(name);
  const cycles = groups.filter((group) => group.length > 1 || edges.get(group[0]).includes(group[0]));
  const canonical = (groups) =>
    groups.map((group) => [...group].sort()).sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
  assert.deepEqual(
    canonical(cycles),
    canonical(allowedCycles),
    'Packed dependency cycle policy differs; review the complete cycle',
  );
  return {
    groups: groups.map((members) => ({ members, cyclic: cycles.includes(members) })),
    dependencies: Object.fromEntries(names.map((name) => [name, edges.get(name)])),
  };
}
