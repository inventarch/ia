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
  profileRefusal,
} from '../src/index.js';
import type { CompiledRecord } from '@inventarch/language';
import type { MandateAuthority, Mode, ProfileMandate } from '../src/index.js';
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
  expect(MANDATE_CODES).toEqual(['IA-RUNTIME-MANDATE-MOVE', 'IA-RUNTIME-MANDATE-WORD', 'IA-RUNTIME-MANDATE-ACTOR']);
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
  // Admission refuses an authored `moves []` (compliance C05); the reader still refuses one it is handed, as
  // defence in depth, locating it as data.
  const emptied = JSON.parse(JSON.stringify(mandate)) as CompiledRecord;
  const movesField = emptied.sections
    .find((section) => section.name === 'authority')!
    .fields.find((field) => 'key' in field && field.key === 'moves')!;
  (movesField as unknown as { value: { items: unknown[] } }).value.items = [];
  expect(() => mandateAuthorityOf(emptied)).toThrow(
    expect.objectContaining({
      message: `IA-RUNTIME-REQUEST-INVALID: ${mandate.identity}: authority.moves must name at least one kernel move`,
      where: { path: mandate.source.path, line: mandate.source.line, identity: mandate.identity },
    }),
  );
});

it('enforces authority.words allow-lists, combined excluded-words, multi-mandate grants and participant-less ceilings (#286)', () => {
  const allowList: MandateAuthority = { identity, moves: ['Synthesis'], words: ['decision', 'task'] };
  expect(mandateRefusal(allowList, 'author', ['decision', 'task'])).toBeUndefined();
  expect(mandateRefusal(allowList, 'author', ['decision', 'milestone'])).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: `${identity} allows words decision, task; disallowed: milestone`,
    next,
  });
  expect(mandateRefusal({ identity, moves: ['Synthesis'], words: [] }, 'author', ['task'])).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: `${identity} allows no words; disallowed: task`,
    next,
  });
  // When both `words` and `excluded-words` are stated, a word must be in `words` AND not in `excluded-words`.
  const both: MandateAuthority = {
    identity,
    moves: ['Synthesis'],
    words: ['decision', 'task'],
    excludedWords: ['decision'],
  };
  expect(mandateRefusal(both, 'author', ['task'])).toBeUndefined();
  expect(mandateRefusal(both, 'author', ['decision'])).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: `${identity} excludes decision`,
    next,
  });
  expect(mandateRefusal(both, 'author', ['spec'])).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: `${identity} allows words decision, task; disallowed: spec`,
    next,
  });

  // In profileRefusal, multiple granting mandates for the same bound actor pool their allowed words unless excluded or capped.
  const first: ProfileMandate = {
    identity: 'agent-system/policy/mandate/m-tasks',
    participant: 'agent-system/binding/agent/author',
    binds: true,
    moves: ['Synthesis'],
    words: ['task'],
  };
  const second: ProfileMandate = {
    identity: 'agent-system/policy/mandate/m-decisions',
    participant: 'agent-system/binding/agent/author',
    binds: true,
    moves: ['Synthesis'],
    words: ['decision'],
  };
  expect(profileRefusal([first, second], 'author', ['task', 'decision'])).toEqual({});
  expect(profileRefusal([first, second], 'author', ['milestone']).refusal).toEqual({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message:
      'agent-system/policy/mandate/m-tasks allows words task; agent-system/policy/mandate/m-decisions allows words decision; disallowed: milestone',
    next: 'ia position --seat agent-system/policy/mandate/m-tasks --shape governance',
  });
  // A participant-less mandate stating `words` acts as a ceiling even when the actor's mandate is unrestricted.
  const ceiling: ProfileMandate = {
    identity: 'agent-system/policy/mandate/ceiling',
    moves: ['Synthesis'],
    words: ['decision'],
  };
  const unrestricted: ProfileMandate = {
    identity: 'agent-system/policy/mandate/unrestricted',
    participant: 'agent-system/binding/agent/author',
    binds: true,
    moves: ['Synthesis'],
  };
  expect(profileRefusal([ceiling, unrestricted], 'author', ['decision'])).toEqual({});
  expect(profileRefusal([ceiling, unrestricted], 'author', ['task']).refusal).toMatchObject({
    code: 'IA-RUNTIME-MANDATE-WORD',
    message: 'agent-system/policy/mandate/ceiling allows words decision; disallowed: task',
  });
});
