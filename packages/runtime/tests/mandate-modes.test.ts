import { expect, it } from 'vitest';
import { MOVES as KERNEL_MOVES } from '@inventarch/language';
import {
  MANDATE_CODES,
  MODES,
  MODE_MOVES,
  MOVES,
  RUNTIME_CODES,
  isMode,
  mandateAuthorityOf,
  mandateRefusal,
} from '../src/index.js';
import type { CompiledRecord } from '@inventarch/language';
import type { MandateAuthority, Mode } from '../src/index.js';
import { database, workspace } from './workspace.js';

const identity = 'agent-system/policy/mandate/sample-mandate';
const next = `ia inspect ${identity} --edges both`;

it('publishes the five kernel moves in kernel order and one move per mode', () => {
  expect(MOVES).toEqual(['Observation', 'Execution', 'Delegation', 'Synthesis', 'Verification']);
  expect(MOVES).toEqual(KERNEL_MOVES);
  expect(MODE_MOVES).toEqual({
    read: 'Observation',
    validate: 'Verification',
    author: 'Synthesis',
    effect: 'Execution',
    're-seat': 'Delegation',
  });
  expect(Object.isFrozen(MODE_MOVES)).toBe(true);
  expect(MODES).toEqual(['read', 'validate', 'author', 'effect', 're-seat']);
  expect(MODES.every(isMode)).toBe(true);
  expect(isMode('invented')).toBe(false);
  expect(MANDATE_CODES).toEqual(['IA-RUNTIME-MANDATE-MOVE', 'IA-RUNTIME-MANDATE-WORD']);
  for (const code of MANDATE_CODES) expect(RUNTIME_CODES).toContain(code);
});

it.each(MODES)('permits %s for a mandate without moves, whatever the words', (mode) => {
  expect(mandateRefusal({ identity }, mode, ['hook', 'law'])).toBeUndefined();
});

it.each(MODES)('judges %s by its move once moves are declared', (mode) => {
  const move = MODE_MOVES[mode];
  expect(mandateRefusal({ identity, moves: [move] }, mode)).toBeUndefined();
  expect(mandateRefusal({ identity, moves: MOVES }, mode)).toBeUndefined();
  const refusal = mandateRefusal({ identity, moves: MOVES.filter((candidate) => candidate !== move) }, mode);
  expect(refusal).toMatchObject({ code: 'IA-RUNTIME-MANDATE-MOVE', next });
  expect(refusal!.message).toContain(`${mode} needs ${move}`);
  expect(Object.isFrozen(refusal)).toBe(true);
  // A declared list names one or more moves; an empty one is a malformed authority, not a lockout of every mode.
  expect(() => mandateRefusal({ identity, moves: [] }, mode)).toThrow('IA-RUNTIME-REQUEST-INVALID');
});

it('refuses an excluded word, naming every excluded word, after the move has been judged', () => {
  const authority: MandateAuthority = { identity, moves: ['Observation'], excludedWords: ['hook', 'law'] };
  expect(mandateRefusal(authority, 'read')).toBeUndefined();
  expect(mandateRefusal(authority, 'read', ['agent'])).toBeUndefined();
  expect(mandateRefusal(authority, 'read', ['agent', 'hook', 'law'])).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: `${identity} excludes hook, law`,
    next,
  });
  expect(mandateRefusal(authority, 'author', ['hook'])!.code).toBe('IA-RUNTIME-MANDATE-MOVE');
  expect(mandateRefusal({ identity, excludedWords: ['hook'] }, 'effect', ['hook'])!.code).toBe(
    'IA-RUNTIME-MANDATE-WORD',
  );
});

it('refuses an unknown mode before reading anything', () => {
  expect(() => mandateRefusal({ identity }, 'invented' as Mode)).toThrow('IA-RUNTIME-REQUEST-INVALID');
});

it('reads the authority section of the compiled conformance mandate and refuses a non-mandate', () => {
  const records = database(workspace()).records();
  const mandate = records.find((r) => r.discriminator === 'mandate' && r.name === 'sample-mandate')!;
  expect(mandate.identity).toBe(identity);
  const authority = mandateAuthorityOf(mandate);
  expect(authority).toEqual({
    identity,
    participant: 'agent-steward',
    moves: ['Observation', 'Verification'],
    excludedWords: ['hook'],
    covers: ['docs/**'],
  });
  expect(Object.isFrozen(authority)).toBe(true);
  expect(Object.isFrozen(authority.moves)).toBe(true);
  const stewardship = records.find((r) => r.discriminator === 'mandate' && r.name === 'agent-system-stewardship')!;
  expect(mandateAuthorityOf(stewardship)).toEqual({ identity: stewardship.identity });
  expect(mandateRefusal(mandate, 'read')).toBeUndefined();
  expect(mandateRefusal(mandate, 'validate', ['agent'])).toBeUndefined();
  expect(mandateRefusal(mandate, 'author')).toMatchObject({ code: 'IA-RUNTIME-MANDATE-MOVE', next });
  expect(mandateRefusal(mandate, 'read', ['hook'])).toMatchObject({ code: 'IA-RUNTIME-MANDATE-WORD', next });
  expect(mandateRefusal(stewardship, 're-seat', ['hook'])).toBeUndefined();
  const agent = records.find((r) => r.discriminator === 'agent' && r.name === 'agent-steward')!;
  expect(() => mandateAuthorityOf(agent)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  // An authored `moves []` admits structurally (the schema narrows items, not their count); the reader refuses it.
  const emptied = JSON.parse(JSON.stringify(mandate)) as CompiledRecord;
  const movesField = emptied.sections
    .find((section) => section.name === 'authority')!
    .fields.find((field) => 'key' in field && field.key === 'moves')!;
  (movesField as unknown as { value: { items: unknown[] } }).value.items = [];
  expect(() => mandateAuthorityOf(emptied)).toThrow('authority.moves must name at least one kernel move');
});
