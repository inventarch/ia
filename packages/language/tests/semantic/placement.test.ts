import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { misplacedConditions, misplacedIn } from '../../src/semantic/placement.js';

function record(body: string, discriminator = 'playbook') {
  const parsed = parse(`#! ia 1.0\n@${discriminator} demo\n${body}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return parsed.ast.records[0]!;
}
describe('condition placement ownership', () => {
  it.each([
    '  label "text" when phase is act',
    '  label "text"\n    when phase is act',
    '  meaning\n    category context when phase is act',
    '  notes\n    field "text" when phase is act',
    '  notes\n    block\n      field "text"\n        when phase is act',
    '  when\n    phase is act',
  ])('rejects forbidden ordinary placement once: %s', (body) => {
    expect(misplacedConditions(record(body), 'a.ia').map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('consumes an invalid carrier but reports independent siblings', () => {
    const body =
      '  notes\n    field "text" when phase is act\n      when phase is plan\n    other "text" when phase is learn';
    expect(misplacedConditions(record(body), 'a.ia').map((d) => d.line)).toEqual([4, 6]);
  });
  it('leaves semantic-section errors with their readers', () => {
    const body =
      '  cognition\n    act\n      primary Decision when phase is act\n  activation\n    activate when phase is act\n  relationships\n    cites @playbook other when phase is act\n  governance\n    severity blocking when phase is act';
    expect(misplacedConditions(record(body), 'a.ia')).toEqual([]);
    const phase = record(body).sections[0]!.children[0]!;
    expect(phase.kind).toBe('field');
    if (phase.kind === 'field') expect(misplacedIn(phase.children, 'a.ia')).toHaveLength(1);
  });
  it.each(['schema', 'system'])('preserves %s registry ownership', (word) => {
    const body =
      word === 'system'
        ? '  provider "x" when phase is act\n  discriminators\n    playbook definition when phase is act\n  requires\n    when phase is act\n  edges\n    cite * using * when phase is act'
        : '  kind contract when phase is act\n  fields\n    message string when phase is act';
    expect(misplacedConditions(record(body, word), 'a.ia')).toEqual([]);
  });
  it('preserves requirement-reader ownership only for contracts', () => {
    const body = '  inputs\n    REQ-A-1 "text" when phase is act';
    expect(misplacedConditions(record(body, 'contract'), 'a.ia')).toEqual([]);
    expect(misplacedConditions(record(body), 'a.ia')).toHaveLength(1);
  });
  it('does not scan nested records as the parent', () => {
    const node = record('  children\n    @playbook child\n      label "text" when phase is act');
    expect(misplacedConditions(node, 'a.ia')).toEqual([]);
    expect(misplacedConditions(node.nested[0]!, 'a.ia')).toHaveLength(1);
  });
  it('does not interpret quoted text', () => {
    expect(misplacedConditions(record('  describes "when phase is act"'), 'a.ia')).toEqual([]);
  });
  it('leaves contract and case dialect refusals with their readers', () => {
    expect(
      misplacedConditions(
        record('  binds "old" when phase is act\n  schema\n    field "old" when phase is act', 'contract'),
        'a.ia',
      ),
    ).toEqual([]);
    expect(
      misplacedConditions(
        record('  verdict "pass" when phase is act\n  scenario\n    given "x" when phase is act', 'case'),
        'a.ia',
      ),
    ).toEqual([]);
  });
});
