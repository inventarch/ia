import { describe, expect, it } from 'vitest';
import { relativeTo } from '../src/canon/files.js';
import { localTarget } from '../src/canon/links.js';
import { scanMarkdown } from '../src/index.js';

/**
 * The canon reads Markdown and paths that third-party kits ship, so no crafted input may make it hang. Each input is a
 * pathological shape CodeQL reported (js/polynomial-redos), at a size the quadratic regexes took seconds on; the
 * linear scans take milliseconds.
 */
const BOUND_MS = 1000;
function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('the canon file rules run in linear time on crafted input', { timeout: 300_000 }, () => {
  it('relativeTo trims trailing slashes from a root of many slashes (files.ts relativeTo)', () => {
    expect(elapsed(() => relativeTo(`a${'/'.repeat(100_000)}b`, 'x'))).toBeLessThan(BOUND_MS);
    expect(relativeTo('/r///', '/r/a.md')).toBe('a.md');
    expect(relativeTo('/r///', '/r')).toBe('');
  });
  it('a line of many backticks (withoutCodeSpans)', () => {
    expect(elapsed(() => scanMarkdown(`x${'`'.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
  });
  it('a heading of many image openers (headingText images)', () => {
    expect(elapsed(() => scanMarkdown(`# ${'!['.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`# ${'![]('.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
  });
  it('a heading of many link and reference openers (headingText links)', () => {
    expect(elapsed(() => scanMarkdown(`# ${'[]('.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`# ${'[]['.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
  });
  it('a heading of many tag openers (headingText tags)', () => {
    expect(elapsed(() => scanMarkdown(`# ${'<'.repeat(100_000)}`))).toBeLessThan(BOUND_MS);
  });
  it('an ATX heading with a long run of tabs inside (ATX)', () => {
    expect(elapsed(() => scanMarkdown(`# a${'\t'.repeat(100_000)}b`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`# a${' \t'.repeat(50_000)}b\n===\n`))).toBeLessThan(BOUND_MS);
  });
  it('a line of many link openers, and a link with a long run of spaces (INLINE)', () => {
    expect(elapsed(() => scanMarkdown('['.repeat(100_000)))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`[a](${' '.repeat(50_000)}x`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`[a](x${' '.repeat(50_000)}"t"${' '.repeat(50_000)}y`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown('[a](<'.repeat(50_000)))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown('[a](b('.repeat(50_000)))).toBeLessThan(BOUND_MS);
  });
  /*
   * The inline scan builds its tables only from the first `[` to the last `)`, so a crafted line without a `)` never
   * reaches them. Each shape here ends in a `)` that no link uses, and the quadratic regex still took seconds on it.
   */
  it.each([
    ['a heading of image openers with paren titles', `# ${'![](x ('.repeat(50_000)})`],
    ['a heading of link openers with paren titles', `# ${'[](x ('.repeat(50_000)})`],
    ['many link openers', `${'['.repeat(100_000)}]()`],
    ['a link with a long run of spaces', `[a](${' '.repeat(50_000)}x y)`],
    ['a link with long runs of spaces around a title', `[a](${' '.repeat(50_000)}x "t"${' '.repeat(50_000)}y)`],
    ['many angle destinations', `${'[a](<'.repeat(50_000)})`],
    ['a bracketed destination after a long run of spaces', `[a](${' '.repeat(50_000)}b(c) y)`],
  ])('%s, closed by a `)` (INLINE tables)', (_name, input) => {
    expect(elapsed(() => scanMarkdown(input))).toBeLessThan(BOUND_MS);
  });
  it('the other line rules: definitions, attributes, setext, fences, escapes and targets', () => {
    expect(elapsed(() => scanMarkdown(`[${'a'.repeat(100_000)}]:${' \t'.repeat(50_000)}`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`<a href${' '.repeat(100_000)}`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`a\n${'='.repeat(50_000)}${'\t'.repeat(50_000)}x\n`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`\`\`\`\n\`\`\`${'\t'.repeat(100_000)}x\n`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => scanMarkdown(`[a](${'\\!'.repeat(50_000)})`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => localTarget(`${'a'.repeat(100_000)}/`))).toBeLessThan(BOUND_MS);
  });
});

describe('heading tag removal is complete (js/incomplete-multi-character-sanitization)', () => {
  it('removes every <...> span, including one a removal would reassemble', () => {
    expect([...scanMarkdown('# a<b>c<scr<script>ipt>d\n# x <y\n').ids]).toEqual(['aciptd', 'x-y']);
  });
});
