import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonSourceRoots, canonTeachingLinks, open } from '../src/index.js';
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
