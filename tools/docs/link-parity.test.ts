import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLinks } from './check.js';
import { checkDocumentationLinks } from './catalog.mjs';
import { localTarget, parseMarkdown } from './markdown.mjs';
import { teachingLinkFindings } from '../systems/teaching-links.js';

interface ParityCase {
  name: string;
  surfaces: string[];
  files: Record<string, string>;
  broken: string[];
}
const { cases } = JSON.parse(readFileSync(new URL('./fixtures/link-parity.json', import.meta.url), 'utf8')) as {
  cases: ParityCase[];
};
const prefix = resolve(tmpdir(), 'ia-link-parity-'),
  roots: string[] = [];
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(prefix);
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(prefix)) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

const targets = (findings: string[]): string[] =>
  findings.map((finding) => /: missing (?:fragment )?(.+)$/.exec(finding)?.[1] ?? finding);
const readers: Record<string, (root: string) => string[]> = {
  catalog: (root) => checkDocumentationLinks(root, ['docs/a.md']).findings,
  check: (root) => checkLinks(root, ['docs/a.md']).failures,
};
for (const [surface, read] of Object.entries(readers)) {
  describe(`link parity: ${surface}`, () => {
    for (const parity of cases.filter((c) => c.surfaces.includes(surface))) {
      it(parity.name, () => {
        expect(targets(read(checkout(parity.files)))).toEqual(parity.broken);
      });
    }
  });
}

interface ConformanceCase {
  name: string;
  markdown: string;
  check: boolean;
  catalog: boolean;
}
const corpus = JSON.parse(readFileSync(new URL('./fixtures/link-conformance.json', import.meta.url), 'utf8')) as {
  target: string;
  cases: ConformanceCase[];
};
for (const [surface, read] of Object.entries(readers)) {
  describe(`${surface} frozen syntax/container conformance`, () => {
    for (const example of corpus.cases) {
      it(example.name, () => {
        const root = checkout({ 'docs/a.md': example.markdown });
        expect(targets(read(root)).includes(corpus.target), example.name).toBe(example[surface as 'check' | 'catalog']);
      });
    }
  });
}

it('the teaching reader applies the same Markdown syntax and retains its installed-closure policy', () => {
  const root = checkout({});
  for (const example of corpus.cases) {
    const findings = teachingLinkFindings(root, [{ path: '.ia/src/guide.md', text: example.markdown }], new Set());
    expect(
      findings.some((finding) => finding.endsWith(`: ${corpus.target}`)),
      example.name,
    ).toBe(example.check);
  }
});

it('returns semantic targets and source positions without matching text inside code or HTML comments', () => {
  const text =
    'Example `[skip](fake.md)`\n\n[`label`](has&amp;name.md)\n\n<a HREF = "html.md">x</a><!-- href="fake.md" -->';
  const links = parseMarkdown(text).links;
  expect(links.map(({ kind, href }) => ({ kind, href }))).toEqual([
    { kind: 'link', href: 'has&name.md' },
    { kind: 'html', href: 'html.md' },
  ]);
  expect(links[0]!.position).toMatchObject({ line: 3, column: 1, offset: text.indexOf('[`label`]') });
  expect(links[1]!.offset).toBe(text.indexOf('HREF'));
});

it('separates URI components before decoding while retaining explicit nonlocal and invalid-escape outcomes', () => {
  expect(localTarget('has%23name.md?view=1#heading%20name')).toEqual({
    pathname: 'has#name.md',
    fragment: 'heading name',
  });
  expect(localTarget('/site-root.md')).toBeNull();
  expect(localTarget('https://example.com/x')).toBeNull();
  expect(localTarget('../outside.md')).toEqual({ pathname: '../outside.md', fragment: '' });
  expect(() => localTarget('bad%zz.md')).toThrow(URIError);
});
