import { expect, it } from 'vitest';
import { evaluateSteward } from '../src/index.js';
import { database, workspace } from './workspace.js';

it('resolves the admitted owner and permits only its identity or a trusted operator', () => {
  const records = database(workspace()).records();
  const missing = evaluateSteward(records, 'governance-system');
  expect(missing).toMatchObject({
    allowed: false,
    code: 'IA-HOOK-IDENTITY-UNAVAILABLE',
    steward: { name: 'governance-steward' },
  });
  expect(
    evaluateSteward(records, 'governance-system', { kind: 'agent', identity: missing.steward!.identity }).allowed,
  ).toBe(true);
  expect(evaluateSteward(records, 'governance-system', { kind: 'operator' }).allowed).toBe(true);
  expect(evaluateSteward(records, 'governance-system', { kind: 'agent', identity: 'governance-steward' }).code).toBe(
    'IA-HOOK-NOT-STEWARD',
  );
  expect(Object.isFrozen(missing.steward)).toBe(true);
});
it('refuses missing, nonlocal, fragment and ambiguous steward records even for an operator', () => {
  const records = database(workspace()).records(),
    owner = records.find((r) => r.name === 'governance-steward')!;
  for (const pool of [
    records.filter((r) => r !== owner),
    [...records, owner],
    records.map((r) =>
      r !== owner ? r : { ...r, source: { ...r.source, path: '.ia/src/systems/agent-system/stolen.ia' } },
    ),
    records.map((r) =>
      r.discriminator !== 'system' || r.name !== 'governance-system'
        ? r
        : {
            ...r,
            head: r.head.map((f) =>
              f.key !== 'steward' || f.value.kind !== 'ref'
                ? f
                : { ...f, value: { ...f.value, fragment: 'orient/Memory' } },
            ),
          },
    ),
  ]) {
    expect(evaluateSteward(pool, 'governance-system', { kind: 'operator' }).code).toBe('IA-HOOK-STEWARD-UNAVAILABLE');
  }
});
