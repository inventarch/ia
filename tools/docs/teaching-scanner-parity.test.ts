import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanMarkdown, teachingLinkFindings as dbFindings } from '@inventarch/db';
import { parseMarkdown } from './markdown.mjs';
import { teachingLinkFindings } from './teaching-links.mjs';

const root = resolve(import.meta.dirname, '../..');
function markdown(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
    return entry.isDirectory() ? markdown(path) : path.endsWith('.md') ? [path] : [];
  });
}
const files = markdown('.ia/src').map((path) => ({ path, text: readFileSync(resolve(root, path), 'utf8') }));
const nativePaths = new Set(
  (function walk(directory: string): string[] {
    return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
      return entry.isDirectory() ? walk(path) : [path];
    });
  })('.ia/src'),
);
const exists = (path: string) => existsSync(resolve(root, path));

describe('the db teaching-link scanner and the tools parser agree on the shipped .ia/src corpus', () => {
  it('reads a corpus of Markdown files', () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it('finds the same links in every file', () => {
    for (const file of files) {
      const expected = parseMarkdown(file.text)
        .links.filter((link: { kind: string }) => link.kind !== 'html')
        .map((link: { href: string }) => link.href)
        .sort();
      const actual = scanMarkdown(file.text)
        .links.filter((link) => link.kind !== 'html')
        .map((link) => link.href)
        .sort();
      expect(actual, file.path).toEqual(expected);
    }
  });
  it('finds the same section ids in every file', () => {
    for (const file of files)
      expect([...scanMarkdown(file.text).ids].sort(), file.path).toEqual([...parseMarkdown(file.text).ids].sort());
  });
  it('gives the same verdicts over the whole corpus', () => {
    const tool = teachingLinkFindings(root, files, nativePaths, exists);
    expect(
      dbFindings(files, nativePaths, exists)
        .map((finding) => finding.message)
        .sort(),
    ).toEqual(tool);
  });
});
