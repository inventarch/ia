import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';

describe('fragment segments', () => {
  it.each([
    '    cites @playbook p#act/Decision',
    '    refs [@playbook p#act/Decision, @contract c#REQ-X-1]',
    '    - @playbook p#act/Decision',
  ])('accepts slash fragments in a reference position: %s', (line) => {
    const result = parse(`#! ia 1.0\n@schema x\n  notes\n${line}\n`, 'a.ia');
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result.ast)).toContain('"fragment":"act/Decision"');
  });

  it.each(['#', '#/Decision', '#act/', '#act//Decision', '#act/Decision#x'])(
    'refuses malformed fragment %s once',
    (fragment) => {
      const result = parse(`#! ia 1.0\n@schema x\n  notes\n    cites @playbook p${fragment}\n`, 'a.ia');
      expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-REF-MALFORMED']);
    },
  );

  it('does not validate fragment existence or allow fragments on headers', () => {
    expect(parse('#! ia 1.0\n@schema x\n  notes\n    cites @playbook p#future/Other\n', 'a.ia').diagnostics).toEqual(
      [],
    );
    expect(parse('#! ia 1.0\n@schema x#act/Decision\n', 'a.ia').diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-HEADER-MALFORMED',
    ]);
  });
});
