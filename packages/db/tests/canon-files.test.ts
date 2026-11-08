import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Node } from '@inventarch/graph';
import {
  canonFileAssessments,
  canonKitScripts,
  canonSourceRoots,
  canonTeachingLinks,
  open,
  sourceRootScope,
} from '../src/index.js';
import { put, workspace } from './workspace.js';

const temporary: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-db-canon-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(resolve(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(path) || !path.startsWith('ia-db-canon-') || path.includes('..')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
const CODE_LINKS = 'IA-COMP-CANON-TEACHING-LINKS';
const CODE_ROOTS = 'IA-COMP-CANON-SOURCE-ROOTS';
const CODE_SCRIPTS = 'IA-COMP-CANON-KIT-SCRIPTS';

describe('C12 teaching links', () => {
  it('C12 reports a relative link leaving .ia/src', () => {
    const root = tree({ '.ia/src/doc.md': '[out](../../README.md)\n', 'README.md': '# x\n' });
    const found = canonTeachingLinks(root, ['.ia/src/doc.md'], new Set());
    expect(found).toMatchObject([{ code: CODE_LINKS, path: '.ia/src/doc.md', line: 1 }]);
    expect(found[0]!.message).toContain('../../README.md');
  });
  it('C12 accepts absolute URLs and anchors', () => {
    const root = tree({
      '.ia/src/doc.md': '[a](https://example.com/x) [b](#top) [c](/abs) [d](mailto:a@b.c)\n\n# Top\n',
    });
    expect(canonTeachingLinks(root, ['.ia/src/doc.md'], new Set())).toEqual([]);
  });
  it('C12 accepts a link that stays under .ia/src, exists and is in the closure', () => {
    const root = tree({
      '.ia/src/a/doc.md': '[b](../b.md#there) <a href="../b.md">x</a>\n',
      '.ia/src/b.md': '# There\n',
    });
    expect(canonTeachingLinks(root, ['.ia/src/a/doc.md', '.ia/src/b.md'], new Set())).toEqual([]);
  });
  it('C12 reports a missing file and a missing section', () => {
    const root = tree({ '.ia/src/doc.md': '[m](./missing.md) [s](./b.md#nope)\n', '.ia/src/b.md': '# Here\n' });
    const found = canonTeachingLinks(root, ['.ia/src/doc.md', '.ia/src/b.md'], new Set());
    expect(found.map((f) => f.message).sort()).toEqual([
      expect.stringContaining('section missing from its installed teaching target: ./b.md#nope'),
      expect.stringContaining('target outside installed teaching closure: ./missing.md'),
    ]);
  });
  it('paths with backslashes and drive letters are normalised', () => {
    const root = tree({ '.ia/src/a/doc.md': '[b](../b.md) [out](../../../x.md)\n', '.ia/src/b.md': '# B\n' });
    const found = canonTeachingLinks(root, ['.ia\\src\\a\\doc.md', '.ia\\src\\b.md'], new Set(['.ia\\src\\n.md']));
    expect(found).toMatchObject([{ code: CODE_LINKS, path: '.ia/src/a/doc.md' }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('../../../x.md');
    // A backslash-spelled target is a path separator, and an absolute path under the root loses its drive and root.
    const spelled = tree({ '.ia/src/a/doc.md': '[b](..\\b.md)\n', '.ia/src/b.md': '# B\n' });
    expect(canonTeachingLinks(spelled, [resolve(spelled, '.ia/src/a/doc.md'), '.ia/src/b.md'], new Set())).toEqual([]);
  });
});

describe('A6 source roots', () => {
  const nested = { '.ia/src/a.ia': '', 'sub/.ia/src/b.ia': '' };
  it('A6 reports a nested .ia/src in a kit', () => {
    const found = canonSourceRoots(tree(nested), 'kit');
    expect(found).toMatchObject([{ code: CODE_ROOTS, path: 'sub/.ia/src' }]);
  });
  it('A6 accepts a nested root with release.json', () => {
    const root = tree({ ...nested, 'sub/.ia/release.json': '{}' });
    expect(canonSourceRoots(root, 'kit')).toEqual([]);
    expect(canonSourceRoots(tree({ ...nested, 'sub/.ia/distributions.lock.json': '{}' }), 'knowledge')).toEqual([]);
  });
  it('A6 ignores node_modules, dist and .git', () => {
    const root = tree({ 'node_modules/p/.ia/src/x.ia': '', 'dist/.ia/src/x.ia': '', '.git/.ia/src/x.ia': '' });
    expect(canonSourceRoots(root, 'knowledge')).toEqual([]);
  });
  it('A6 is inactive outside kits and knowledge repositories', () => {
    expect(canonSourceRoots(tree(nested), null)).toEqual([]);
  });
});

describe('A6 separate checkouts', () => {
  it('A6 does not enter a nested directory holding a .git file or directory', () => {
    const root = tree({
      '.ia/src/a.ia': '',
      'wt/.git': 'gitdir: ../.git/worktrees/wt',
      'wt/.ia/src/b.ia': '',
      'clone/.git/HEAD': '',
      'clone/.ia/src/b.ia': '',
      'plain/.ia/src/b.ia': '',
    });
    expect(canonSourceRoots(root, 'kit')).toMatchObject([{ path: 'plain/.ia/src' }]);
  });
});

describe('A6 scope through canonFileAssessments', () => {
  const field = (key: string, text: string) => ({
    key,
    value: { kind: 'scalar', text },
    span: { line: 1, endLine: 1 },
  });
  const node = (discriminator: string, identity: string, extra: object): Node =>
    ({
      discriminator,
      identity,
      name: identity,
      edges: [],
      sections: [],
      source: { path: 'x.ia', line: 1 },
      ...extra,
    }) as unknown as Node;
  const enforcing = [
    node('law', 'law/a', {
      edges: [{ predicate: 'enforce', direction: 'in', target: 'check/a' }],
      sections: [{ name: 'governance', span: { line: 1, endLine: 1 }, fields: [field('severity', 'blocking')] }],
    }),
    node('check', 'check/a', {
      sections: [{ name: 'check', span: { line: 1, endLine: 1 }, fields: [field('runs', 'CANON-SOURCE-ROOTS')] }],
    }),
  ];
  const kit = node('distribution', 'distribution/kit', {
    source: { path: '.ia/src/systems/kit-a/records/plugin.ia', line: 1 },
    sections: [{ name: 'product', span: { line: 1, endLine: 1 }, fields: [] }],
  });
  const nested = { '.ia/src/a.ia': '', 'sub/.ia/src/b.ia': '' };
  it('a kit is scope kit and the nested root is reported', () => {
    const found = canonFileAssessments(tree(nested), [...enforcing, kit]);
    expect(found.flatMap((a) => a.findings)).toMatchObject([
      { code: CODE_ROOTS, severity: 'error', path: 'sub/.ia/src' },
    ]);
    expect(found.flatMap((a) => a.findings)[0]!.message).toContain('A kit');
  });
  it('a lock installing inventarch/ia-kb-kit is scope knowledge and the nested root is reported', () => {
    const found = canonFileAssessments(tree(nested), enforcing, { installed: [{ id: 'inventarch/ia-kb-kit' }] });
    expect(found.flatMap((a) => a.findings)).toMatchObject([{ code: CODE_ROOTS, path: 'sub/.ia/src' }]);
    expect(found.flatMap((a) => a.findings)[0]!.message).toContain('knowledge repository');
  });
  it('neither a kit nor the knowledge kit leaves A6 inactive', () => {
    expect(canonFileAssessments(tree(nested), enforcing, { installed: [{ id: 'inventarch/other' }] })).toMatchObject([
      { check: 'CANON-SOURCE-ROOTS', findings: [] },
    ]);
    expect(sourceRootScope(enforcing, [])).toBeNull();
  });
});

describe('canon file rules through the view', () => {
  const law = `#! ia 1.0\n@law teaching-links-law\n  meaning\n    says "Teaching links stay inside the installed closure."\n    answers "Where may teaching links point?"\n  governance\n    severity blocking\n  relationships\n    enforced-by @check teaching-links-check\n`;
  const check = `#! ia 1.0\n@check teaching-links-check\n  meaning\n    says "Evaluates teaching links."\n    answers "What does the teaching links check evaluate?"\n  check\n    runs CANON-TEACHING-LINKS\n    scope "fixture"\n`;
  const canon = (root: string) => {
    const db = open(root, { cache: false });
    try {
      return db.report.findings.filter((f) => f.code.startsWith('IA-COMP-CANON-'));
    } finally {
      db.close();
    }
  };
  it('reports C12 as error only when a blocking law enforces a check running it', () => {
    const root = workspace();
    put(root, '.ia/src/docs/guide.md', '[out](../../../README.md)\n');
    expect(canon(root)).toEqual([]);
    put(root, '.ia/src/systems/governance-system/records/teaching-links-law.ia', law);
    put(root, '.ia/src/systems/compliance-system/checks/teaching-links-check.ia', check);
    expect(canon(root)).toMatchObject([{ code: CODE_LINKS, severity: 'error', path: '.ia/src/docs/guide.md' }]);
  });
});

describe('C6 kit scripts', () => {
  it('C6 reports a script in a kit', () => {
    const root = tree({ 'tools/run.mjs': '', 'a/b.ps1': '', 'a/c.sh': '', 'readme.md': '', 'x.json': '' });
    expect(canonKitScripts(root, true).map((f) => f.path)).toEqual(['a/b.ps1', 'a/c.sh', 'tools/run.mjs']);
    expect(canonKitScripts(root, true)[0]).toMatchObject({ code: CODE_SCRIPTS, severity: 'error', line: 1 });
    for (const ext of ['mjs', 'cjs', 'js', 'ts', 'py', 'sh', 'ps1'])
      expect(canonKitScripts(tree({ [`s.${ext}`]: '' }), true)).toHaveLength(1);
  });
  it('C6 is inactive outside a kit', () => {
    expect(canonKitScripts(tree({ 'run.mjs': '' }), false)).toEqual([]);
  });
  it('C6 ignores node_modules, dist and .git', () => {
    const root = tree({
      'node_modules/p/i.js': '',
      'dist/i.js': '',
      '.git/hooks/h.sh': '',
      'sub/node_modules/i.js': '',
    });
    expect(canonKitScripts(root, true)).toEqual([]);
  });
  it('C6 ignores runtime state and separate checkouts', () => {
    const root = tree({
      '.ia/distributions/x/i.js': '',
      '.ia/work/w.py': '',
      'wt/.git': 'gitdir: x',
      'wt/i.js': '',
      'clone/.git/HEAD': '',
      'clone/i.js': '',
      'plain/i.js': '',
    });
    expect(canonKitScripts(root, true).map((f) => f.path)).toEqual(['plain/i.js']);
  });
  it('C6 ignores an executing-system folder', () => {
    const root = tree({ '.ia/src/systems/ia-1-run/lib/x.mjs': '', '.ia/src/systems/other/y.mjs': '', 'z.mjs': '' });
    expect(canonKitScripts(root, true, ['ia-1-run']).map((f) => f.path)).toEqual([
      '.ia/src/systems/other/y.mjs',
      'z.mjs',
    ]);
  });
});

describe('C6 through canonFileAssessments', () => {
  const field = (key: string, text: string) => ({
    key,
    value: { kind: 'scalar', text },
    span: { line: 1, endLine: 1 },
  });
  const node = (discriminator: string, identity: string, extra: object): Node =>
    ({
      discriminator,
      identity,
      name: identity,
      edges: [],
      sections: [],
      source: { path: 'x.ia', line: 1 },
      ...extra,
    }) as unknown as Node;
  const enforcing = [
    node('law', 'law/a', {
      edges: [{ predicate: 'enforce', direction: 'in', target: 'check/a' }],
      sections: [{ name: 'governance', span: { line: 1, endLine: 1 }, fields: [field('severity', 'blocking')] }],
    }),
    node('check', 'check/a', {
      sections: [{ name: 'check', span: { line: 1, endLine: 1 }, fields: [field('runs', 'CANON-KIT-SCRIPTS')] }],
    }),
  ];
  const kit = node('distribution', 'distribution/kit', {
    source: { path: '.ia/src/systems/ia-1-run/records/plugin.ia', line: 1 },
    sections: [{ name: 'product', span: { line: 1, endLine: 1 }, fields: [] }],
  });
  const binding = node('execution-binding', 'execution-binding/b', {
    source: { path: '.ia/src/systems/ia-1-run/records/b.ia', line: 1 },
  });
  const files = { '.ia/src/systems/ia-1-run/lib/x.mjs': '', 'tools/y.mjs': '' };
  it('an executing kit system allows its folder; others are reported', () => {
    const found = canonFileAssessments(tree(files), [...enforcing, kit, binding]).flatMap((a) => a.findings);
    expect(found).toMatchObject([{ code: CODE_SCRIPTS, path: 'tools/y.mjs' }]);
  });
  it('a kit system without an execution-binding is not allowed', () => {
    const found = canonFileAssessments(tree(files), [...enforcing, kit]).flatMap((a) => a.findings);
    expect(found.map((f) => f.path)).toEqual(['.ia/src/systems/ia-1-run/lib/x.mjs', 'tools/y.mjs']);
  });
  it('a workspace that is not a kit reports nothing', () => {
    expect(canonFileAssessments(tree(files), enforcing).flatMap((a) => a.findings)).toEqual([]);
  });
});
