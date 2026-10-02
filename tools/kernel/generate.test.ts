import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKernel, generateKernel, readKernel } from './generate.js';
import type { KernelSource } from './generate.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = readKernel(root);
function change(file: string, before: string, after: string): readonly KernelSource[] {
  let changed = false;
  const result = sources.map((s) => {
    if (!s.path.endsWith(`/${file}`)) return s;
    expect(s.text).toContain(before);
    changed = true;
    return { ...s, text: s.text.replace(before, after) };
  });
  expect(changed).toBe(true);
  return result;
}
describe('native kernel generation', () => {
  it('validates every native record and exactly reproduces the checked embed', () => {
    const result = generateKernel(sources);
    expect(result.records).toBe(118);
    expect(result.text).toBe(
      readFileSync(resolve(root, 'packages/language/src/kernel.generated.ts'), 'utf8').replaceAll('\r\n', '\n'),
    );
    expect(checkKernel(root).digest).toBe(result.digest);
  });
  it('is stable under input permutation and CRLF checkout normalization', () => {
    expect(
      generateKernel([...sources].reverse().map((s) => ({ ...s, text: s.text.replaceAll('\n', '\r\n') }))),
    ).toEqual(generateKernel(sources));
  });
  it('binds the digest to prose and comments, not only vocabulary memberships', () => {
    expect(generateKernel(change('kind.ia', '#! ia 1.0', '#! ia 1.0\n# revision change')).digest).not.toBe(
      generateKernel(sources).digest,
    );
  });
  it.each([
    ['kind.ia', '    lane authority', '    lane [authority]', 'IA-COMP-FIELD-TYPE'],
    ['kind.ia', '    lane authority', '    lane unknown', 'kind lane'],
    ['kind.ia', '    order 0', '    order 1', 'kind order'],
    ['kind.ia', '    order 0', '    order 0\n    order 0', 'IA-COMP-FIELD-DUPLICATE'],
    ['kind.ia', '    order 0', '    order 0\n    ready true', 'IA-COMP-FIELD-UNKNOWN'],
    ['kind.ia', '@kind governance', '@kind extra', 'KINDS'],
    ['kind.ia', '  meaning', '  unexpected', 'IA-COMP-SECTION'],
    ['intent-shape.ia', '    category relation', '    category unknown', 'shape category'],
    ['intent-shape.ia', '    tie-precedence 4', '    tie-precedence 0', 'shape tie precedence'],
    [
      'axis.ia',
      '    values [context, governance, execution, sequence, learning]',
      '    values [context]',
      'shape values',
    ],
    ['dimension.ia', '"governance.severity"', '"meaning.category"', 'dimension paths'],
    ['predicate.ia', '    inverse governed-by', '    inverse invented-by', 'PREDICATE_PAIRS'],
    ['predicate.ia', '    phrase "governs"', '    phrase "governz"', 'PRESENT_PHRASES'],
    ['placement.ia', '    band 100', '    band 99', 'BANDS'],
    [
      'floor.schema.ia',
      '    must have head.provider as text',
      '    must have head.provider as number',
      'IA-COMP-FIELD-TYPE',
    ],
    [
      'kernel.schema.ia',
      '    must have data.order as number',
      '    must have data.order as bogus',
      'IA-LANG-SCHEMA-MALFORMED',
    ],
  ])('refuses %s mutation of %s before output', (file, before, after, error) => {
    expect(() => generateKernel(change(file!, before!, after!))).toThrow(error);
  });
  it('refuses extra unenrolled schemas and cross-file identity duplicates', () => {
    expect(() =>
      generateKernel([
        ...sources,
        {
          path: '.ia/src/floor/extra.ia',
          text: '#! ia 1.0\n@schema unused\n  lowers to definition\n  sections\n    open\n',
        },
      ]),
    ).toThrow('enrollment');
    const first = sources.find((s) => s.path.endsWith('/kind.ia'))!;
    expect(() => generateKernel([...sources, { ...first, path: '.ia/src/floor/duplicate.ia' }])).toThrow(
      'Duplicate kernel identity',
    );
  });
  it('refuses duplicate paths and missing members', () => {
    expect(() => generateKernel([...sources, sources[0]!])).toThrow('Duplicate kernel source path');
    expect(() => generateKernel(sources.filter((s) => !s.path.endsWith('/move.ia')))).toThrow('MOVES');
  });
  it('does not overwrite an existing output after failed validation, and detects output drift', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ia-kernel-'));
    try {
      mkdirSync(join(temp, '.ia/src/floor'), { recursive: true });
      mkdirSync(join(temp, 'packages/language/src'), { recursive: true });
      const output = join(temp, 'packages/language/src/kernel.generated.ts');
      writeFileSync(output, 'retained output');
      for (const source of sources) writeFileSync(join(temp, source.path), source.text);
      expect(() => checkKernel(temp)).toThrow('drift');
      const malformed = change('kind.ia', '    lane authority', '    lane [authority]').find((s) =>
        s.path.endsWith('/kind.ia'),
      )!;
      writeFileSync(join(temp, malformed.path), malformed.text);
      expect(() => checkKernel(temp, true)).toThrow('IA-COMP-FIELD-TYPE');
      expect(readFileSync(output, 'utf8')).toBe('retained output');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
