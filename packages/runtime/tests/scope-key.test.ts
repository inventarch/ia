import { PRIMITIVE_ANCHORS, SHAPE_ROWS } from '@inventarch/language';
import { expect, it } from 'vitest';
import {
  K0,
  SCOPE_BODY_LIMITS,
  SCOPE_KEY_CAPS,
  SCOPE_KEY_DEFAULTS,
  SCOPE_KEY_PARTS,
  context,
  normalizeScopeKey,
  prepareCoordinate,
} from '../src/index.js';
import type { NormalizedScopeKey } from '../src/index.js';
import { database, workspace } from './workspace.js';

const k0: NormalizedScopeKey = {
  seat: null,
  shape: 'context',
  phase: 'orient',
  primitive: 'Attention',
  depth: 0,
  budget: 0,
  word: null,
  k0: true,
  sources: {
    seat: 'default',
    shape: 'default',
    phase: 'derived',
    primitive: 'derived',
    depth: 'default',
    budget: 'default',
    word: 'default',
  },
  coordinate: { shape: 'context', phase: 'orient', primitive: 'Attention' },
};
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

it('names the scope key parts, caps, non-empty defaults and body limits as frozen constants', () => {
  expect(SCOPE_KEY_PARTS).toEqual(['seat', 'shape', 'phase', 'depth', 'budget', 'word']);
  expect(SCOPE_KEY_CAPS).toEqual({ depth: 2, budget: 64 });
  expect(SCOPE_KEY_DEFAULTS).toEqual({ depth: 1, budget: 16 });
  expect(SCOPE_BODY_LIMITS).toEqual({ pointers: 48, cells: 4 });
  for (const constant of [SCOPE_KEY_PARTS, SCOPE_KEY_CAPS, SCOPE_KEY_DEFAULTS, SCOPE_BODY_LIMITS, K0])
    expect(deeplyFrozen(constant)).toBe(true);
});
it('serves an empty key as K0: the workspace seat, context, orient, depth 0, budget 0, no word', () => {
  expect(K0).toEqual(k0);
  expect(normalizeScopeKey({})).toEqual(k0);
  expect(normalizeScopeKey()).toEqual(k0);
  expect(normalizeScopeKey({ shape: undefined, word: undefined })).toEqual(k0);
});
it('reads K0 as a value, so a key that spells it out is K0 and any other value is not', () => {
  const spelled = normalizeScopeKey({ shape: 'context', phase: 'orient', depth: 0, budget: 0 });
  expect(spelled.k0).toBe(true);
  expect({ ...spelled, sources: k0.sources }).toEqual(k0);
  expect(spelled.sources).toMatchObject({
    shape: 'declared',
    phase: 'declared',
    depth: 'declared',
    budget: 'declared',
  });
  for (const key of [
    { depth: 0 },
    { budget: 0 },
    { depth: 0, budget: 0, phase: 'plan' },
    { depth: 0, budget: 0, shape: 'governance' },
    { depth: 0, budget: 0, word: 'law' },
    { depth: 0, budget: 0, seat: 'docs/guide.md' },
  ])
    expect(normalizeScopeKey(key).k0).toBe(false);
});
it.each([
  ['context', 'Attention', 'orient'],
  ['governance', 'Inference', 'plan'],
  ['execution', 'Decision', 'act'],
  ['sequence', 'Inference', 'plan'],
  ['learning', 'Learning', 'learn'],
] as const)('derives the %s primitive from its shape row and the phase from its anchor', (shape, primitive, phase) => {
  const got = normalizeScopeKey({ shape });
  expect(got.primitive).toBe(SHAPE_ROWS[shape].primitive);
  expect(got.phase).toBe(PRIMITIVE_ANCHORS[got.primitive]);
  expect(got).toMatchObject({ shape, primitive, phase, depth: 1, budget: 16, k0: false });
  expect(got.sources).toEqual({
    seat: 'default',
    shape: 'declared',
    phase: 'derived',
    primitive: 'derived',
    depth: 'default',
    budget: 'default',
    word: 'default',
  });
  expect(got.coordinate).toEqual({ shape, phase, primitive });
});
it('fills only the omitted depth or budget of a non-empty key', () => {
  expect(normalizeScopeKey({ depth: 2 })).toMatchObject({ depth: 2, budget: 16, shape: 'context', phase: 'orient' });
  expect(normalizeScopeKey({ budget: 64 })).toMatchObject({ depth: 1, budget: 64 });
  expect(normalizeScopeKey({ word: 'law' })).toMatchObject({ depth: 1, budget: 16, word: 'law' });
  expect(normalizeScopeKey({ depth: 0, budget: 0, shape: 'execution' })).toMatchObject({ depth: 0, budget: 0 });
});
it('keeps a declared phase, canonicalized, and still derives the primitive from the shape', () => {
  const got = normalizeScopeKey({ shape: 'Governance', phase: 'ACT' });
  expect(got).toMatchObject({ shape: 'governance', phase: 'act', primitive: 'Inference' });
  expect(got.sources).toMatchObject({ shape: 'declared', phase: 'declared', primitive: 'derived' });
  expect(got.coordinate).toEqual({ shape: 'governance', phase: 'act', primitive: 'Inference' });
});
it('carries a seat and a word verbatim for seeding to resolve', () => {
  const got = normalizeScopeKey({ seat: '.ia/src/systems/work-system/records/work.ia', word: 'law' });
  expect(got).toMatchObject({ seat: '.ia/src/systems/work-system/records/work.ia', word: 'law' });
  expect(got.sources).toMatchObject({ seat: 'declared', word: 'declared' });
  expect(normalizeScopeKey({ seat: 'work-system/definition/system/work-system' }).seat).toBe(
    'work-system/definition/system/work-system',
  );
});
it('answers a shape and phase alone without coordinate-incomplete, while the frozen context route still refuses them', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    budget = { tokens: 100000, records: 1000 };
  expect(context(db, { within, text: '', coordinate: { shape: 'governance', phase: 'plan' } }, budget)).toMatchObject({
    ok: false,
    escalation: 'coordinate-incomplete',
    missing: ['primitive'],
  });
  expect(prepareCoordinate('', { shape: 'governance', phase: 'plan' }).sources.primitive).toBe('absent');
  const key = normalizeScopeKey({ shape: 'governance', phase: 'plan' });
  expect(key.coordinate).toEqual({ shape: 'governance', phase: 'plan', primitive: 'Inference' });
  expect(context(db, { within, text: '', coordinate: key.coordinate }, budget)).toMatchObject({ ok: true });
});
it('accepts the caps and refuses depth 3, budget 65 and every non-integer or negative value', () => {
  expect(normalizeScopeKey({ depth: 2, budget: 64 })).toMatchObject({ depth: 2, budget: 64 });
  for (const key of [
    { depth: 3 },
    { budget: 65 },
    { depth: -1 },
    { budget: -1 },
    { depth: 1.5 },
    { budget: 0.5 },
    { depth: '1' },
    { budget: Number.NaN },
    { budget: Number.POSITIVE_INFINITY },
    { depth: null },
  ])
    expect(() => normalizeScopeKey(key), JSON.stringify(key)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  expect(() => normalizeScopeKey({ depth: 3 })).toThrow('depth must be an integer from 0 to 2');
  expect(() => normalizeScopeKey({ budget: 65 })).toThrow('budget must be an integer from 0 to 64');
});
it('refuses unknown parts, unknown shapes and phases, and malformed seats and words', () => {
  expect(() => normalizeScopeKey({ primitive: 'Memory' })).toThrow(
    "IA-RUNTIME-REQUEST-INVALID: Unknown scope key part 'primitive'; admitted: seat, shape, phase, depth, budget, word",
  );
  expect(() => normalizeScopeKey({ pointers: 48 })).toThrow("Unknown scope key part 'pointers'");
  expect(() => normalizeScopeKey({ shape: 'thinking' })).toThrow('IA-GRAPH-COORDINATE-VALUE-UNKNOWN');
  expect(() => normalizeScopeKey({ phase: 'dream' })).toThrow('IA-GRAPH-COORDINATE-VALUE-UNKNOWN');
  expect(() => normalizeScopeKey({ shape: 7 })).toThrow('IA-GRAPH-COORDINATE-VALUE-UNKNOWN');
  for (const key of [{ seat: '' }, { seat: 1 }, { seat: null }, { word: '' }, { word: ['law'] }, { word: null }])
    expect(() => normalizeScopeKey(key), JSON.stringify(key)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  for (const input of [null, [], 'context', 0])
    expect(() => normalizeScopeKey(input), JSON.stringify(input)).toThrow(
      'IA-RUNTIME-REQUEST-INVALID: Scope key must be an object',
    );
});
it('is pure: equal keys normalize to equal frozen values and the input is never changed', () => {
  const input = { shape: 'sequence', budget: 8 },
    copy = structuredClone(input);
  const first = normalizeScopeKey(input),
    second = normalizeScopeKey({ ...input });
  expect(first).toEqual(second);
  expect(deeplyFrozen(first)).toBe(true);
  expect(input).toEqual(copy);
  expect(Object.isFrozen(input)).toBe(false);
});
