import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFormatPreservation, format, parse } from '../src/index.js';

describe('scanner-driven formatting', () => {
  it('normalizes ordinary token spacing, inline lists, CRLF and a missing terminal newline', () => {
    const source =
      '#! ia 1.0\r\n@agent   demo\r\n  meaning\r\n    says    "exact \\"raw\\""  # keep\r\n    list [ one ,two , @agent   other ]';
    const result = format(source, 'a.ia');
    expect(result.diagnostics).toEqual([]);
    expect(result.text).toBe(
      '#! ia 1.0\n@agent demo\n  meaning\n    says "exact \\"raw\\"" # keep\n    list [one, two, @agent other]\n',
    );
  });
  it('preserves multiline prose/list raw layout and every positioned comment and blank', () => {
    const source =
      '#! ia 1.0\n\n# before\n@agent demo # header\n  meaning\n    says """\n      Words # in prose\n\n      and   exact raw layout.\n    """ # close\n    values [ # open\n      "first", # middle\n\n    # inside\n      @agent other#act/Memory # fragment\n    ] # list close\n    # before nested\n    @agent child\n      meaning\n        says "child"\n# after\n\n';
    expect(format(source, 'a.ia')).toEqual({ text: source, diagnostics: [] });
  });
  it('preserves structural-looking words and literal comment markers in quoted values', () => {
    const source =
      '#! ia 1.0\n@agent demo\n  meaning\n    says "@system fake when phase is act # words"\n    other y# content\n';
    expect(format(source, 'a.ia').text).toBe(source);
  });
  it('refuses invalid input with the parser-owned errors and no writable text', () => {
    const source = '#! ia 1.0\n@agent demo\n   wrong indent # retained\n';
    expect(format(source, 'a.ia')).toEqual({ text: null, diagnostics: parse(source, 'a.ia').diagnostics });
  });
  it.each([
    ['# important\n', ''],
    ['# important', '# changed'],
    ['  meaning', '    meaning'],
    ['"words"', '"changed"'],
    ['\n\n', '\n'],
    ['# important', '# important\n# important'],
  ])('refuses a lossy candidate mutation %s', (before, after) => {
    const source = '#! ia 1.0\n\n# important\n@agent demo\n  meaning\n    says "words"\n';
    expect(checkFormatPreservation(source, source.replace(before!, after!), 'a.ia').map((d) => d.code)).toEqual([
      'IA-LANG-FORMAT-LOSSY',
    ]);
  });
});

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ia') ? [path] : [];
  });
}
describe('all conformance and native source formatting', () => {
  const roots = [
    resolve(import.meta.dirname, '../../compliance/fixtures/language'),
    resolve(import.meta.dirname, '../../../.ia/src'),
  ];
  for (const path of roots.flatMap(files))
    it(path.replaceAll('\\', '/').split('/').slice(-4).join('/'), () => {
      const source = readFileSync(path, 'utf8');
      const result = format(source, path);
      const parsed = parse(source, path);
      if (parsed.diagnostics.length > 0) {
        expect(result).toEqual({ text: null, diagnostics: parsed.diagnostics });
      } else {
        expect(result.diagnostics).toEqual([]);
        expect(result.text).not.toBeNull();
        expect(format(result.text!, path)).toEqual(result);
        expect(checkFormatPreservation(source, result.text!, path)).toEqual([]);
        expect(parse(result.text!, path).ast).toEqual(parsed.ast);
      }
    });
});
