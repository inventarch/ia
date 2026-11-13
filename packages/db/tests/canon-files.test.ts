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
  scanMarkdown,
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
      '.ia/src/doc.md': '[a](https://example.com/x) [b](#top) [c](//example.com/x) [d](mailto:a@b.c)\n\n# Top\n',
    });
    expect(canonTeachingLinks(root, ['.ia/src/doc.md'], new Set())).toEqual([]);
  });
  it('C12 reports a root-relative link, which leaves .ia/src (H8)', () => {
    const root = tree({ '.ia/src/doc.md': '[c](/abs)\n\n[d]: /.ia/src/doc.md\n', abs: '' });
    const found = canonTeachingLinks(root, ['.ia/src/doc.md'], new Set());
    const rows = found.map((f) => [f.code, f.line, f.message] as const);
    expect([...rows].sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0))).toEqual([
      [CODE_LINKS, 3, '.ia/src/doc.md: target outside installed teaching closure: /.ia/src/doc.md'],
      [CODE_LINKS, 1, '.ia/src/doc.md: target outside installed teaching closure: /abs'],
    ]);
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

describe('the dependency-free link scanner', () => {
  const hrefs = (text: string) => scanMarkdown(text).links.map((link) => `${link.kind}:${link.href}`);
  it('reads inline links and images with a title, and reference definitions', () => {
    expect(hrefs('[a](./a.md "t") ![i](<./i one.png>) [r][x]\n\n[x]: ./x.md\n')).toEqual([
      'link:./a.md',
      'image:./i one.png',
      'definition:./x.md',
    ]);
  });
  it('skips fenced code blocks and inline code spans', () => {
    const text = '```\n[a](./a.md)\n```\n~~~\n[b](./b.md)\n~~~\n`[c](./c.md)` [d](./d.md)\n';
    expect(hrefs(text)).toEqual(['link:./d.md']);
  });
  it('reads HTML href and src attributes and ids', () => {
    const scanned = scanMarkdown('<a href="./a.md" id="top">x</a> <img src=./i.png name=pic>\n');
    expect(scanned.links.map((link) => link.href)).toEqual(['./a.md', './i.png']);
    expect([...scanned.ids]).toEqual(['top', 'pic']);
  });
  it('ends a link destination before its title at exactly the code units /\\s/ matches', () => {
    // Each line is `[a](x<unit>"t")`. A space ends the destination; any other code unit joins it. `(`, `)` and `\`
    // change the destination's syntax, and \n and \r end the line, so those five are left out.
    const units: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const unit = String.fromCharCode(code);
      if (!'()\\\n\r'.includes(unit)) units.push(unit);
    }
    const { links } = scanMarkdown(units.map((unit) => `[a](x${unit}"t")`).join('\n'));
    const wrong = units.filter((unit, index) => links[index]?.href !== (/\s/.test(unit) ? 'x' : `x${unit}"t"`));
    expect(wrong.map((unit) => `U+${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)).toEqual([]);
    expect(links).toHaveLength(units.length);
  });
  it('dedupes a repeat whose numbered slug already exists without looping', { timeout: 2000 }, () => {
    expect([...scanMarkdown('# A\n# A-1\n# A\n').ids]).toEqual(['a', 'a-1', 'a-2']);
  });
  it('slugs headings GitHub-style and dedupes repeats', () => {
    const scanned = scanMarkdown('# Hello, World!\n## Hello, World!\n## Hello, World!\n### a_b `c` - d\n');
    expect([...scanned.ids]).toEqual(['hello-world', 'hello-world-1', 'hello-world-2', 'a_b-c---d']);
  });
});

/** A release descriptor and a one-package lock that db's decoders accept. */
const descriptor = {
  formatVersion: 1,
  id: 'test/nested',
  version: '0.1.0',
  engine: '^0.1.0',
  language: ['1.0'],
  source: { repository: 'https://example.com/nested', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 0 },
  license: 'UNLICENSED',
  description: 'Nested release fixture',
  dependencies: [],
  assets: [],
};
const lock = {
  formatVersion: 1,
  engine: '^0.1.0',
  requests: [{ id: descriptor.id, range: '^0.1.0' }],
  packages: [
    {
      id: descriptor.id,
      version: descriptor.version,
      archive: 'a'.repeat(64),
      manifest: 'b'.repeat(64),
      location: `sha256:${'a'.repeat(64)}`,
      dependencies: [],
    },
  ],
};

describe('A6 source roots', () => {
  const nested = { '.ia/src/a.ia': '', 'sub/.ia/src/b.ia': '' };
  it('A6 reports a nested .ia/src in a kit', () => {
    const found = canonSourceRoots(tree(nested), 'kit');
    expect(found).toMatchObject([{ code: CODE_ROOTS, path: 'sub/.ia/src' }]);
  });
  it('A6 accepts a nested root with release.json', () => {
    const root = tree({ ...nested, 'sub/.ia/release.json': JSON.stringify(descriptor) });
    expect(canonSourceRoots(root, 'kit')).toEqual([]);
    const adopted = tree({ ...nested, 'sub/.ia/distributions.lock.json': JSON.stringify(lock) });
    expect(canonSourceRoots(adopted, 'knowledge')).toEqual([]);
  });
  it('A6 reports a nested root whose release.json or lock does not decode (H9)', () => {
    const reported = (files: Record<string, string>) => canonSourceRoots(tree({ ...nested, ...files }), 'kit');
    for (const text of ['{}', 'not json', JSON.stringify({ ...descriptor, version: 'v1' })])
      expect(reported({ 'sub/.ia/release.json': text }), text).toMatchObject([
        { code: CODE_ROOTS, path: 'sub/.ia/src' },
      ]);
    for (const text of [
      '{}',
      JSON.stringify({ ...lock, requests: [], packages: [] }),
      JSON.stringify({ ...lock, packages: [] }),
    ])
      expect(reported({ 'sub/.ia/distributions.lock.json': text }), text).toMatchObject([{ path: 'sub/.ia/src' }]);
  });
  it('A6 ignores node_modules, dist and .git', () => {
    const root = tree({ 'node_modules/p/.ia/src/x.ia': '', 'dist/.ia/src/x.ia': '', '.git/.ia/src/x.ia': '' });
    expect(canonSourceRoots(root, 'knowledge')).toEqual([]);
  });
  it('A6 is inactive outside kits and knowledge repositories', () => {
    expect(canonSourceRoots(tree(nested), null)).toEqual([]);
  });
});

describe('runtime state at any depth (H4)', () => {
  const store = `sub/.ia/distributions/store/${'a'.repeat(64)}`;
  const files = {
    '.ia/src/a.ia': '',
    [`${store}/.ia/src/b.ia`]: '',
    [`${store}/.ia/src/systems/s/run.mjs`]: '',
    [`${store}/scripts/x.mjs`]: '',
    'sub/.ia/work/w/.ia/src/c.ia': '',
    'sub/.ia/work/w/run.py': '',
  };
  it('A6 does not report a nested workspace store or work root', () => {
    expect(canonSourceRoots(tree(files), 'kit')).toEqual([]);
  });
  it('C6 does not report scripts under a nested workspace store or work folder', () => {
    expect(canonKitScripts(tree(files), true)).toEqual([]);
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

describe('canon file rules reach the report at every severity (H1)', () => {
  const RULES = [
    ['links', 'CANON-TEACHING-LINKS'],
    ['roots', 'CANON-SOURCE-ROOTS'],
    ['scripts', 'CANON-KIT-SCRIPTS'],
  ] as const;
  const law = (name: string, severity: string) =>
    `#! ia 1.0\n@law ${name}-law\n  meaning\n    says "The ${name} canon rule holds."\n    answers "Does the ${name} canon rule hold?"\n  governance\n    severity ${severity}\n  relationships\n    enforced-by @check ${name}-check\n`;
  const check = (name: string, runs: string) =>
    `#! ia 1.0\n@check ${name}-check\n  meaning\n    says "Evaluates the ${name} canon rule."\n    answers "What does the ${name} check evaluate?"\n  check\n    runs ${runs}\n    scope "fixture"\n`;
  // A @distribution under a system folder listing a @system makes the workspace a kit (C6, A6 scope 'kit').
  const kit = `#! ia 1.0\n@distribution canon-kit-distribution\n  meaning\n    says "The kit this fixture ships."\n    answers "What does this kit ship?"\n  distribution\n    records [@system workspace-system]\n`;
  function violating(severity: string): string {
    const root = workspace();
    put(root, '.ia/src/systems/workspace-system/records/canon-kit-distribution.ia', kit);
    put(root, '.ia/src/docs/guide.md', '[out](../../../README.md)\n');
    put(root, '.ia/src/docs/run.mjs', '');
    put(root, 'sub/.ia/src/b.ia', '');
    for (const [name, runs] of RULES) {
      put(root, `.ia/src/systems/governance-system/records/${name}-law.ia`, law(name, severity));
      put(root, `.ia/src/systems/compliance-system/checks/${name}-check.ia`, check(name, runs));
    }
    return root;
  }
  const read = (root: string) => {
    const db = open(root, { cache: false });
    try {
      const { findings, verdicts } = db.report;
      return {
        findings: findings.filter((f) => f.code.startsWith('IA-COMP-CANON-')),
        verdicts: verdicts.filter((v) => v.check.startsWith('CANON-') && RULES.some(([, id]) => id === v.check)),
        laws: db.laws().filter((l) => RULES.some(([name]) => l.identity.endsWith(`/${name}-law`))),
      };
    } finally {
      db.close();
    }
  };
  it('an advisory law reports C12, A6 and C6 as warnings and each check has a passing verdict', () => {
    const { findings, verdicts, laws } = read(violating('advisory'));
    expect(findings.map((f) => [f.code, f.severity, f.path]).sort()).toEqual([
      [CODE_SCRIPTS, 'warning', '.ia/src/docs/run.mjs'],
      [CODE_ROOTS, 'warning', 'sub/.ia/src'],
      [CODE_LINKS, 'warning', '.ia/src/docs/guide.md'],
    ]);
    expect(verdicts.map((v) => [v.check, v.outcome]).sort()).toEqual([
      ['CANON-KIT-SCRIPTS', 'pass'],
      ['CANON-SOURCE-ROOTS', 'pass'],
      ['CANON-TEACHING-LINKS', 'pass'],
    ]);
    expect(laws.map((l) => l.state)).toEqual(['enforced', 'enforced', 'enforced']);
  });
  it('a blocking law reports C12, A6 and C6 as errors and each check fails', () => {
    const { findings, verdicts } = read(violating('blocking'));
    expect(findings.map((f) => [f.code, f.severity]).sort()).toEqual([
      [CODE_SCRIPTS, 'error'],
      [CODE_ROOTS, 'error'],
      [CODE_LINKS, 'error'],
    ]);
    expect(verdicts.map((v) => v.outcome)).toEqual(['fail', 'fail', 'fail']);
  });
});

const assets = (...paths: string[]) => JSON.stringify({ assets: paths.map((path) => ({ path, role: 'asset' })) });

describe('C6 kit scripts', () => {
  it('C6 reports a script the kit ships', () => {
    const root = tree({
      '.ia/src/tools/run.mjs': '',
      '.ia/src/a/b.ps1': '',
      '.ia/src/a/c.sh': '',
      '.ia/src/readme.md': '',
      '.ia/src/x.json': '',
    });
    expect(canonKitScripts(root, true).map((f) => f.path)).toEqual([
      '.ia/src/a/b.ps1',
      '.ia/src/a/c.sh',
      '.ia/src/tools/run.mjs',
    ]);
    expect(canonKitScripts(root, true)[0]).toMatchObject({ code: CODE_SCRIPTS, severity: 'error', line: 1 });
  });
  it('C6 is inactive outside a kit', () => {
    expect(canonKitScripts(tree({ '.ia/src/run.mjs': '' }), false)).toEqual([]);
  });
  it('C6 ignores node_modules, dist and .git', () => {
    const root = tree({
      '.ia/src/node_modules/p/i.js': '',
      '.ia/src/dist/i.js': '',
      '.ia/src/.git/hooks/h.sh': '',
      '.ia/src/sub/node_modules/i.js': '',
    });
    expect(canonKitScripts(root, true)).toEqual([]);
  });
  it('C6 ignores runtime state and separate checkouts', () => {
    // The kit ships all of .ia/, so the root's .ia/distributions and .ia/work are inside the walk and must be skipped.
    const root = tree({
      '.ia/distributions/x/i.js': '',
      '.ia/work/w.py': '',
      '.ia/src/wt/.git': 'gitdir: x',
      '.ia/src/wt/i.js': '',
      '.ia/src/clone/.git/HEAD': '',
      '.ia/src/clone/i.js': '',
      '.ia/src/plain/i.js': '',
    });
    expect(canonKitScripts(root, true).map((f) => f.path)).toEqual(['.ia/src/plain/i.js']);
  });
  it('C6 ignores an executing-system folder', () => {
    const root = tree({
      '.ia/src/systems/ia-1-run/lib/x.mjs': '',
      '.ia/src/systems/other/y.mjs': '',
      '.ia/src/z.mjs': '',
    });
    expect(canonKitScripts(root, true, ['ia-1-run']).map((f) => f.path)).toEqual([
      '.ia/src/systems/other/y.mjs',
      '.ia/src/z.mjs',
    ]);
  });
});

describe('C6 checks only shipped files (H6)', () => {
  it('C6 reports a script anywhere under .ia/, which the kit ships, not only under .ia/src', () => {
    const root = tree({ '.ia/tools/x.mjs': '', '.ia/release.json': '{}', '.ia/distributions.lock.json': '{}' });
    expect(canonKitScripts(root, true)).toMatchObject([{ code: CODE_SCRIPTS, path: '.ia/tools/x.mjs' }]);
  });
  it('C6 does not report tests, fixtures or scripts the kit does not declare as assets', () => {
    const root = tree({
      'tests/x.mjs': '',
      'tests/fixtures/f.js': '',
      'fixtures/g.py': '',
      'scripts/undeclared.mjs': '',
      'tools/run.sh': '',
    });
    expect(canonKitScripts(root, true)).toEqual([]);
  });
  it('C6 reports a script the kit declares as an asset in .ia/release.json', () => {
    const root = tree({
      '.ia/release.json': assets('scripts/x.mjs', 'README.md'),
      'scripts/x.mjs': '',
      'scripts/y.mjs': '',
      'README.md': '',
    });
    expect(canonKitScripts(root, true)).toMatchObject([{ code: CODE_SCRIPTS, path: 'scripts/x.mjs' }]);
  });
  it('C6 ignores a declared asset that is missing, a folder or outside the kit', () => {
    const root = tree({ '.ia/release.json': assets('scripts/gone.mjs', 'scripts', '../out.mjs'), 'scripts/a.txt': '' });
    expect(canonKitScripts(root, true)).toEqual([]);
  });
  it('C6 matches script extensions case-insensitively, including the added ones', () => {
    expect(canonKitScripts(tree({ '.ia/src/X.JS': '' }), true).map((f) => f.path)).toEqual(['.ia/src/X.JS']);
    for (const ext of [
      'mjs',
      'cjs',
      'js',
      'ts',
      'mts',
      'cts',
      'tsx',
      'jsx',
      'py',
      'rb',
      'sh',
      'bash',
      'zsh',
      'ps1',
      'psm1',
      'cmd',
      'bat',
    ])
      for (const spelled of [ext, ext.toUpperCase()])
        expect(canonKitScripts(tree({ [`.ia/src/s.${spelled}`]: '' }), true), spelled).toHaveLength(1);
    expect(canonKitScripts(tree({ '.ia/src/s.json': '', '.ia/src/s.md': '', '.ia/src/s.ia': '' }), true)).toEqual([]);
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
  const files = {
    '.ia/src/systems/ia-1-run/lib/x.mjs': '',
    '.ia/release.json': assets('tools/y.mjs'),
    'tools/y.mjs': '',
    'tests/z.mjs': '',
  };
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
