import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditRepository } from './audit.js';
import { checkLinks, gitFiles } from './check.js';
import { checkStructure, generateCatalog, checkDocumentationLinks, redirectText } from './catalog.mjs';

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-doc-audit-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir(), 'ia-doc-audit-')))
      throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it('executes the catalog CLI through a linked directory instead of silently skipping validation', () => {
  const root = fixture({
    'tools/docs/catalog.mjs': readFileSync(new URL('./catalog.mjs', import.meta.url), 'utf8'),
    'tools/docs/markdown.mjs': readFileSync(new URL('./markdown.mjs', import.meta.url), 'utf8'),
    'tools/entry/is-entry.mjs': readFileSync(new URL('../entry/is-entry.mjs', import.meta.url), 'utf8'),
    'docs/documentation.json': JSON.stringify({
      format: 'ia-documentation-policy/1',
      repository: 'fixture/repo',
      expected: [],
    }),
  });
  generateCatalog(root);
  const modules = resolve(root, 'node_modules'),
    alias = resolve(fixture({}), 'linked checkout');
  symlinkSync(resolve(import.meta.dirname, '../../node_modules'), modules, 'junction');
  try {
    symlinkSync(root, alias, 'junction');
    try {
      const invoke = () =>
        spawnSync(process.execPath, [resolve(alias, 'tools/docs/catalog.mjs')], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        });
      const valid = invoke();
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual({ documents: 0, findings: [] });
      writeFileSync(resolve(root, 'docs/catalog.json'), '{}\n');
      const stale = invoke();
      expect(stale.status).toBe(1);
      expect(JSON.parse(stale.stdout).findings).toContain('Documentation catalog stale; run pnpm docs:catalog');
    } finally {
      unlinkSync(alias);
    }
  } finally {
    unlinkSync(modules);
  }
});

it('adapts the nested roadmap config to the external loader without changing project or task identities', () => {
  const config = {
    repositoryRoot: '../..',
    manifestPath: 'docs/roadmap/github-manifest.json',
    project: { number: 9 },
    routing: { fallback: 'fixture/repo' },
  };
  const manifest = '{"tasks":[{"id":"DOC-01","repository":"fixture/repo"}]}\n';
  const root = fixture({
    'tools/docs/roadmap-sync-config.mjs': readFileSync(new URL('./roadmap-sync-config.mjs', import.meta.url), 'utf8'),
    'docs/roadmap/config.json': JSON.stringify(config),
    'docs/roadmap/github-manifest.json': manifest,
  });
  const invoke = () =>
    spawnSync(process.execPath, [resolve(root, 'tools/docs/roadmap-sync-config.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      windowsHide: true,
    });
  expect(invoke().status).toBe(0);
  const output = resolve(root, '.ia/work/roadmap-sync/config.json');
  const bytes = readFileSync(output, 'utf8');
  const prepared = JSON.parse(bytes);
  // Exact upstream loader semantics: path is relative to the provided config directory.
  expect(readFileSync(join(dirname(output), prepared.manifestPath), 'utf8')).toBe(manifest);
  expect(prepared.project).toEqual(config.project);
  expect(prepared.routing).toEqual(config.routing);
  expect(resolve(dirname(output), prepared.repositoryRoot)).toBe(root);
  expect(readFileSync(resolve(root, 'docs/roadmap/config.json'), 'utf8')).toBe(JSON.stringify(config));
  expect(invoke().status).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe(bytes);
  writeFileSync(output, '{"operatorOwned":true}\n');
  expect(invoke().stderr).toContain('unmanaged');
  expect(readFileSync(output, 'utf8')).toBe('{"operatorOwned":true}\n');
});

it('refuses a roadmap manifest escape before creating output', () => {
  const root = fixture({
    'tools/docs/roadmap-sync-config.mjs': readFileSync(new URL('./roadmap-sync-config.mjs', import.meta.url), 'utf8'),
    'docs/roadmap/config.json': JSON.stringify({ repositoryRoot: '../..', manifestPath: '../outside.json' }),
  });
  const result = spawnSync(process.execPath, [resolve(root, 'tools/docs/roadmap-sync-config.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Manifest must remain inside');
  expect(existsSync(resolve(root, '.ia/work/roadmap-sync/config.json'))).toBe(false);
});

it('refuses an aliased roadmap output directory without writing through it', () => {
  const root = fixture({
    'tools/docs/roadmap-sync-config.mjs': readFileSync(new URL('./roadmap-sync-config.mjs', import.meta.url), 'utf8'),
    'docs/roadmap/config.json': JSON.stringify({
      repositoryRoot: '../..',
      manifestPath: 'docs/roadmap/github-manifest.json',
    }),
    'docs/roadmap/github-manifest.json': '{"tasks":[]}',
  });
  const outside = fixture({ 'keep.txt': 'operator-owned' });
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(outside, resolve(root, '.ia/work/roadmap-sync'), 'junction');
  const result = spawnSync(process.execPath, [resolve(root, 'tools/docs/roadmap-sync-config.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Aliased output');
  expect(existsSync(resolve(outside, 'config.json'))).toBe(false);
  expect(readFileSync(resolve(outside, 'keep.txt'), 'utf8')).toBe('operator-owned');
});

it('preserves bundle coverage, refuses duplicate identities and cannot regenerate an omitted spec away', () => {
  const source =
    '---\nid: spec-one\ngenre: spec\ntitle: One\nstatus: draft\nowners: [maintainer]\ncreated: 2026-09-30\nlast-reviewed: 2026-09-30\n---\n# One\n';
  const root = fixture({
    'docs/specs/one/README.md': source,
    'docs/documentation.json': JSON.stringify({
      format: 'ia-documentation-policy/1',
      repository: 'fixture/repo',
      expected: [{ id: 'spec-one', path: 'docs/specs/one/README.md', profile: 'lifecycle' }],
    }),
  });
  generateCatalog(root);
  expect(checkStructure(root).findings).toEqual([]);
  mkdirSync(resolve(root, 'docs/specs/copy'));
  writeFileSync(resolve(root, 'docs/specs/copy/README.md'), source);
  expect(checkStructure(root).findings.join('\n')).toContain('duplicate local identity');
  rmSync(resolve(root, 'docs/specs/copy/README.md'));
  rmSync(resolve(root, 'docs/specs/one/README.md'));
  expect(() => generateCatalog(root)).toThrow('inventory changed');
});

it('refuses flat, dated and mixed-case lifecycle entries even when registered in policy', () => {
  const source =
    '---\nid: probe\ngenre: spec\ntitle: Probe\nstatus: draft\nowners: [maintainer]\ncreated: 2026-09-30\nlast-reviewed: 2026-09-30\n---\n# Probe\n';
  for (const path of [
    'docs/specs/flat.md',
    'docs/specs/2026-10-01-probe/README.md',
    'docs/specs/Bad_Topic/README.md',
  ]) {
    const root = fixture({
      [path]: source,
      'docs/documentation.json': JSON.stringify({
        format: 'ia-documentation-policy/1',
        repository: 'fixture/repo',
        expected: [{ id: 'probe', path, profile: 'lifecycle' }],
      }),
    });
    expect(() => generateCatalog(root)).toThrow('lowercase topic bundle');
  }
});

it('keeps identity-free pointers and snapshots out of current identities, and resolves only local IDs', () => {
  const source =
    '---\nid: spec-one\ngenre: spec\ntitle: One\nstatus: draft\nowners: [maintainer]\ncreated: 2026-09-30\nlast-reviewed: 2026-09-30\nrelated:\n  specs: [other/repo::spec-one]\n---\n# One\n';
  const root = fixture({
    'docs/specs/one/README.md': source,
    'docs/reports/snapshot/2026-09-30/README.md': source,
    'docs/old.md': '# Moved\n\n[Current](specs/one/README.md)\n',
    'docs/documentation.json': JSON.stringify({
      format: 'ia-documentation-policy/1',
      repository: 'fixture/repo',
      expected: [{ id: 'spec-one', path: 'docs/specs/one/README.md', profile: 'lifecycle' }],
    }),
  });
  const result = checkStructure(root, { generated: false });
  expect(result.documents).toBe(1);
  expect(result.findings).toEqual(['docs/specs/one/README.md: unresolved local document other/repo::spec-one']);
});

it('checks heading fragments and refuses a sibling file even when it exists', () => {
  const root = fixture({
    'docs/one.md': '# One\n\n[good](two.md#repeat-1) [bad](two.md#gone) [sibling](../../secret.md)\n',
    'docs/two.md': '# Repeat\n\n## Repeat\n',
  });
  expect(checkDocumentationLinks(root, ['docs/one.md']).findings).toEqual([
    'docs/one.md: missing fragment two.md#gone',
    'docs/one.md: sibling checkout link ../../secret.md',
  ]);
});

it('refuses a compatibility pointer that tries to create a second lifecycle identity', () => {
  const from = 'docs/specs/spec-0001-old.md',
    to = 'docs/specs/current/README.md';
  const source =
    '---\nid: spec-one\ngenre: spec\ntitle: One\nstatus: draft\nowners: [maintainer]\ncreated: 2026-09-30\nlast-reviewed: 2026-09-30\n---\n# One\n';
  const root = fixture({
    [from]: redirectText(from, to),
    [to]: source,
    'docs/documentation.json': JSON.stringify({
      format: 'ia-documentation-policy/1',
      repository: 'fixture/repo',
      expected: [{ id: 'spec-one', path: to, profile: 'lifecycle' }],
      redirects: [{ from, to }],
    }),
  });
  generateCatalog(root);
  expect(checkStructure(root).findings).toEqual([]);
  writeFileSync(resolve(root, from), source);
  expect(checkStructure(root).findings.join('\n')).toContain('identity-free pointer');
});

it('requires each owner contract even when a root contract exists', () => {
  const files = {
    'SPEC.md': '# Root',
    'packages/new/src/index.ts': 'export {};',
    'tools/new/run.ts': '',
    '.ia/src/systems/new/system.ia': '',
    'examples/new/sample.ia': '',
  };
  const result = auditRepository(fixture(files), Object.keys(files));
  expect(result.failures).toEqual([
    '.ia/src/systems/new: missing colocated SPEC.md',
    'examples/new: missing colocated SPEC.md',
    'packages/new: missing colocated SPEC.md',
    'tools/new: missing colocated SPEC.md',
  ]);
});
it('requires a separate distribution contract and inherits its nested native contracts', () => {
  const files = {
    'SPEC.md': '# Root',
    'distributions/example/SPEC.md': '# Distribution',
    'distributions/example/consumer.mjs': 'export {};',
    'distributions/example/.ia/src/systems/example/SPEC.md': '# Native owner',
    'distributions/example/.ia/src/systems/example/system.ia': '',
  };
  const result = auditRepository(fixture(files), Object.keys(files));
  expect(result.failures).toEqual([]);
  expect(result.owners.find((row) => row.owner === 'distributions/example')?.folders).toContainEqual({
    path: 'distributions/example/.ia/src/systems/example',
    spec: 'distributions/example/.ia/src/systems/example/SPEC.md',
  });
  const missing = { ...files };
  delete (missing as Record<string, string>)['distributions/example/SPEC.md'];
  expect(auditRepository(fixture(missing), Object.keys(missing)).failures).toContain(
    'distributions/example: missing colocated SPEC.md',
  );
});
it('keeps retained learning evidence under its own contract, distinct from native source and scratch state', () => {
  const files = {
    'SPEC.md': '# Root',
    '.ia/learning/SPEC.md': '# Retained evidence',
    '.ia/learning/observations/pinned.json': '{}',
    '.ia/src/systems/learning-system/SPEC.md': '# Native learning',
    '.ia/src/systems/learning-system/records/example.ia': '',
  };
  const result = auditRepository(fixture(files), Object.keys(files));
  expect(result.failures).toEqual([]);
  expect(result.owners.find((row) => row.owner === '.ia/learning')?.folders).toContainEqual({
    path: '.ia/learning/observations',
    spec: '.ia/learning/SPEC.md',
  });
  expect(result.owners.find((row) => row.owner === '.ia/src/systems/learning-system')?.files).toBe(2);
  const missing = { ...files };
  delete (missing as Record<string, string>)['.ia/learning/SPEC.md'];
  expect(auditRepository(fixture(missing), Object.keys(missing)).failures).toContain(
    '.ia/learning: missing colocated SPEC.md',
  );
});
it('maps internal folders to inherited and nested contracts and pins exact bytes', () => {
  const files = {
    'SPEC.md': '# Root',
    'packages/a/SPEC.md': '# A',
    'packages/a/package.json': JSON.stringify({
      name: '@ia/a',
      exports: { '.': './dist/index.js' },
      bin: { ia: './dist/cli.js' },
      dependencies: { '@ia/b': 'workspace:*' },
    }),
    'packages/a/src/index.ts': 'export {};',
    'packages/a/tests/main.test.ts': '',
    'packages/a/fixtures/loop/SPEC.md': '# Loop',
    'packages/a/fixtures/loop/data.txt': 'one',
  };
  const root = fixture(files),
    result = auditRepository(root, Object.keys(files)),
    owner = result.owners.find((row) => row.owner === 'packages/a')!;
  expect(result.failures).toEqual([]);
  expect(owner.surface).toMatchObject({
    name: '@ia/a',
    exports: ['.'],
    bins: { ia: './dist/cli.js' },
    dependencies: ['@ia/b'],
  });
  expect(owner.folders).toContainEqual({ path: 'packages/a/tests', spec: 'packages/a/SPEC.md' });
  expect(owner.folders).toContainEqual({ path: 'packages/a/fixtures', spec: 'packages/a/SPEC.md' });
  expect(owner.folders).toContainEqual({ path: 'packages/a/fixtures/loop', spec: 'packages/a/fixtures/loop/SPEC.md' });
  expect(auditRepository(root, Object.keys(files).reverse()).digest).toBe(result.digest);
  writeFileSync(resolve(root, 'packages/a/fixtures/loop/data.txt'), 'two');
  expect(auditRepository(root, Object.keys(files)).digest).not.toBe(result.digest);
  writeFileSync(resolve(root, 'packages/a/fixtures/loop/SPEC.md'), '');
  expect(auditRepository(root, Object.keys(files)).failures).toContain(
    'packages/a/fixtures/loop/SPEC.md: empty or untitled contract',
  );
});
it('reports unknown areas, deleted inventory files and untitled specs without losing other findings', () => {
  const files = { 'SPEC.md': '# Root', 'other/run.ts': '', 'apps/a/SPEC.md': '', 'docs/a.md': '[bad](missing.md)' };
  const result = auditRepository(fixture(files), [...Object.keys(files), 'apps/a/deleted.ts']);
  expect(result.failures).toContain('other/run.ts: no declared ownership area');
  expect(result.failures).toContain('apps/a/deleted.ts: missing, unreadable or aliased inventory file');
  expect(result.failures).toContain('apps/a/SPEC.md: empty or untitled contract');
  expect(result.failures).toContain('docs/a.md: missing missing.md');
});
it('refuses aliased ancestor directories before reading their content', () => {
  const root = fixture({
    'SPEC.md': '# Root',
    'docs/source/SPEC.md': '# Hidden',
    'docs/source/a.md': '[hidden](missing.md)',
  });
  mkdirSync(resolve(root, 'tools'));
  symlinkSync(resolve(root, 'docs/source'), resolve(root, 'tools/alias'), 'junction');
  const result = auditRepository(root, ['SPEC.md', 'tools/alias/SPEC.md', 'tools/alias/a.md']);
  expect(result.failures).toContain('tools/alias/SPEC.md: missing, unreadable or aliased inventory file');
  expect(result.failures).toContain('tools/alias: missing colocated SPEC.md');
  expect(result.markdown.files).toBe(1);
});
it('checks encoded inline and reference-definition targets but excludes fenced examples and URLs', () => {
  const files = {
    'docs/a.md':
      '[yes](<space%20name.md#heading>)\n[x][ref]\n\n[ref]: missing.md\n[bad](%zz)\n[web](https://example.com)\n```md\n[ignored](absent.md)\n```\n~~~~\n[ignored](absent2.md)\n```\n~~~~\n',
    'docs/space name.md': '# Target',
  };
  const result = checkLinks(fixture(files), ['docs/a.md']);
  expect(result.links).toBe(2);
  expect(result.failures).toEqual(['docs/a.md: invalid link encoding %zz', 'docs/a.md: missing missing.md']);
});
it('does not turn unavailable Git inventory into a successful empty audit', () => {
  expect(() => gitFiles(fixture({ 'SPEC.md': '# Root' }))).toThrow();
});
it('rejects relative links to sibling checkouts even when their files exist locally', () => {
  const container = fixture({
    'checkout/docs/a.md':
      '[local](local.md)\n[private](../../private/spec.md)\n[encoded][ref]\n\n[ref]: ..%2F..%2Fprivate%2Fspec.md\n[hosted](https://example.com/private/spec.md)\n',
    'checkout/docs/local.md': '# Local',
    'private/spec.md': '# Outside this checkout',
  });
  const result = checkLinks(resolve(container, 'checkout'), ['docs/a.md']);
  expect(result.links).toBe(3);
  expect(result.failures).toEqual([
    'docs/a.md: local target escapes repository ../../private/spec.md',
    'docs/a.md: local target escapes repository ../../private/spec.md',
  ]);
});
