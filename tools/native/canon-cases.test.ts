import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readNative } from './check.js';
import { compileNative } from './compile.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CANON = /^\.ia\/src\/systems\/[^/]+\/records\/canon\//;
const TITLE = /\b(?:it|test)(?:\.(?:only|concurrent|sequential))*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** The titles of every `it(...)` and `test(...)` call that runs (not `.skip`, `.todo` or `.fails`) and whose title is a string literal. */
function testTitles(text: string): Set<string> {
  return new Set([...text.matchAll(TITLE)].map((m) => m[2]!.replace(/\\(.)/g, '$1')));
}

describe('canon case evidence', () => {
  it('every canon case evaluator names an existing file and a test in it with exactly that title', () => {
    const { inputs } = readNative(root);
    const { records } = compileNative(inputs);
    const cases = records.filter((r) => r.discriminator === 'case' && CANON.test(r.source.path));
    const cited = cases.flatMap((r) => {
      const field = r.sections
        .filter((s) => s.name === 'scenario')
        .flatMap((s) => s.fields)
        .find((f) => 'key' in f && f.key === 'evaluator');
      const text = field && 'value' in field && 'text' in field.value ? field.value.text : undefined;
      const split = text?.split(' | ');
      return [
        split?.length === 2
          ? { identity: r.identity, file: split[0]!, title: split[1]! }
          : { identity: r.identity, malformed: text ?? '(no evaluator)' },
      ];
    });
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cited.flatMap((c) => ('malformed' in c ? [`${c.identity}: ${c.malformed}`] : []))).toEqual([]);
    const wellFormed = cited.flatMap((c) => ('malformed' in c ? [] : [c]));
    const titles = new Map<string, Set<string> | undefined>();
    const stale = wellFormed.filter(({ file, title }) => {
      if (!titles.has(file))
        titles.set(
          file,
          existsSync(resolve(root, file)) ? testTitles(readFileSync(resolve(root, file), 'utf8')) : undefined,
        );
      return !titles.get(file)?.has(title);
    });
    expect(stale.map(({ identity, file, title }) => `${identity}: ${file} | ${title}`)).toEqual([]);
  });
});
