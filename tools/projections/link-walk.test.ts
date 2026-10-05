import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { withScope } from '../testing/resources.js';
import type { ResourceScope } from '../testing/resources.js';
import { classifyLink, fileLinks, linkCounts, linkProblems } from './fixtures/link-walk.mjs';
import type { LinkKind } from './fixtures/link-walk.mjs';

const fixtures = resolve(import.meta.dirname, 'fixtures');

/** A fresh directory in the system temporary root, released by the scope. */
function ownedRoot(scope: ResourceScope): string {
  return scope.own('link-walk root', mkdtempSync(join(tmpdir(), 'ia-link-walk-')), (path) => {
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('ia-link-walk-'))
      throw new Error('Unsafe link-walk cleanup');
    rmSync(path, { recursive: true, force: true });
  });
}

// One input list for every consumer of the rule: each row is a link as it appears in references/note.md.
// External schemes are exactly the ones the serializer passes through (projection-host.ts resourceMarkdown).
const ROWS: readonly { link: string; kind: LinkKind; target?: string }[] = [
  { link: '[a](examples/note.md)', kind: 'local', target: 'references/examples/note.md' },
  { link: '[a](<examples/a%20b.md>)', kind: 'local', target: 'references/examples/a b.md' },
  { link: '[a](examples/note.md#owner)', kind: 'local', target: 'references/examples/note.md' },
  { link: '[a](<../skills/x/SKILL.md> "Title")', kind: 'local', target: 'skills/x/SKILL.md' },
  { link: '[a]: examples/note.md', kind: 'local', target: 'references/examples/note.md' },
  { link: '[a](#owner)', kind: 'fragment' },
  { link: '[a](<#owner>)', kind: 'fragment' },
  { link: '[a](https://example.test/style)', kind: 'external' },
  { link: '[a](HTTP://example.test/style)', kind: 'external' },
  { link: '[a](mailto:editor@example.test)', kind: 'external' },
  { link: '[a](httpx://example.test/style)', kind: 'unsupported' },
  { link: '[a](ftp://example.test/style)', kind: 'unsupported' },
  { link: '[a](C:/notes/x.md)', kind: 'unsupported' },
  { link: '[a](/etc/hosts)', kind: 'unsupported' },
  { link: '[a](%E0%A4%A)', kind: 'unsupported' },
];

it.each(ROWS)('classifies $link as $kind', ({ link, kind, target }) => {
  const found = fileLinks({ path: 'references/note.md', content: `# Note\n\n${link}\n` });
  expect(found).toEqual([{ raw: expect.any(String), kind, ...(target === undefined ? {} : { target }) }]);
});

it('classifies a destination on the boundary of each external and fragment rule', () => {
  expect(classifyLink('https://example.test')).toEqual({ kind: 'external' });
  expect(classifyLink('https//example.test')).toEqual({ kind: 'local', path: 'https//example.test' });
  expect(classifyLink('mailto:editor@example.test')).toEqual({ kind: 'external' });
  expect(classifyLink('mailtox:editor@example.test')).toEqual({ kind: 'unsupported' });
  expect(classifyLink('#owner')).toEqual({ kind: 'fragment' });
  expect(classifyLink('a#owner')).toEqual({ kind: 'local', path: 'a' });
});

it('ignores links the serializer keeps literal inside code spans and fenced blocks', () => {
  const content =
    '# Literal\n\n`[a](missing.md)` and ``a ` [b](missing.md) ` code`` [c](x.md)\n\n````md\n```\n[d](missing.md)\n````\n\n[e](y.md)\n';
  expect(fileLinks({ path: 'note.md', content }).map((l) => l.raw)).toEqual(['x.md', 'y.md']);
});

it('walks decoded Codex agent instructions and config registrations, and no other non-Markdown file', () => {
  const instructions = JSON.stringify('See [g](../../references/g.md), [s](https://example.test) and [t](#top).');
  expect(
    fileLinks({ path: '.codex/agents/r.toml', content: `name = "r"\ndeveloper_instructions = ${instructions}\n` }),
  ).toEqual([
    { raw: '../../references/g.md', kind: 'local', target: 'references/g.md' },
    { raw: 'https://example.test', kind: 'external' },
    { raw: '#top', kind: 'fragment' },
  ]);
  expect(
    fileLinks({
      path: '.codex/config.toml',
      content: '[agents."r"]\ndescription = "R."\nconfig_file = "agents/r.toml"\n',
    }),
  ).toEqual([{ raw: 'agents/r.toml', kind: 'local', target: '.codex/agents/r.toml' }]);
  expect(fileLinks({ path: 'skills/x/agents/openai.yaml', content: 'short_description: "[a](missing.md)"\n' })).toEqual(
    [],
  );
});

it('reports unsupported, missing, escaping and non-file targets and nothing for a clean product', () =>
  withScope((scope) => {
    const outside = ownedRoot(scope),
      root = ownedRoot(scope),
      leaving = `../${basename(outside)}/source.md`;
    writeFileSync(join(outside, 'source.md'), '# Source\n');
    mkdirSync(join(root, 'folder'));
    mkdirSync(join(root, 'references'));
    writeFileSync(join(root, 'references/g.md'), '# Guide\n');
    const clean = {
      path: 'note.md',
      content:
        '[g](references/g.md#top), [site](<https://example.test/guide>), [mail](mailto:owner@example.test) and [top](<#top>)\n',
    };
    expect(linkProblems(root, [clean])).toEqual([]);
    const broken = {
      path: 'note.md',
      content: `[leaving](<${leaving}>), [missing](missing.md), [folder](<folder>), [ftp](ftp://example.test/x) and [g](references/g.md)\n`,
    };
    expect(linkProblems(root, [clean, broken])).toEqual([
      `note.md: escapes ${leaving}`,
      'note.md: missing missing.md',
      'note.md: not a regular file folder',
      'note.md: unsupported ftp://example.test/x',
    ]);
  }));

it('counts every link kind across a product', () => {
  const files = [
    {
      path: 'a.md',
      content: '[l](b.md) [h](https://example.test) [m](mailto:a@example.test) [f](#x) [u](ftp://example.test)\n',
    },
    { path: 'b.md', content: '[l](a.md#y)\n' },
  ];
  expect(linkCounts(files)).toEqual({ local: 2, external: 2, fragment: 1, unsupported: 1 });
});

it('keeps the shared fixture exercising external and fragment links', () => {
  const path = 'references/examples/note.md',
    links = fileLinks({ path, content: readFileSync(join(fixtures, 'synthetic-review', path), 'utf8') });
  expect(links.filter((l) => l.kind !== 'local').map(({ raw, kind }) => ({ raw, kind }))).toEqual([
    { raw: 'https://example.test/fictional-style', kind: 'external' },
    { raw: 'mailto:editor@example.test', kind: 'external' },
    { raw: '#example-note', kind: 'fragment' },
  ]);
});

it('imports only Node built-ins, so the isolated packed consumer can load the copied file', () => {
  const source = readFileSync(join(fixtures, 'link-walk.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/^import\s.*?\sfrom\s'([^']+)';$/gm)].map((m) => m[1]!);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
});
