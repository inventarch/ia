import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_TOKENIZER } from '@inventarch/runtime';
import { metadataDigest } from '../src/resource-format.js';
import { lifecycleProfile } from '../src/lifecycle-profile.js';
import {
  fragmentLifecycleContext,
  assembleLifecycleContextSegments,
  LIFECYCLE_CONTEXT_SLOTS,
} from '../src/lifecycle-transport.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function packet(text = 'Required guide 🧭 with quotes " and newlines\n'.repeat(850)) {
  const pins = {
    binding: hash('binding'),
    source: hash('source'),
    view: hash('view'),
    resources: hash('resources'),
    installation: null,
    profile: lifecycleProfile('claude-code', '2.1.278').digest,
    policy: hash('policy'),
    implementation: hash('implementation'),
  };
  const body = {
    format: 'ia.lifecycle-context.v1',
    pins,
    event: { kind: 'prompt', source: null, key: null, inputDigest: hash('event') },
    required: { parts: [{ text }] },
    delivery: 'unconfirmed',
  };
  return JSON.stringify({ ...body, id: metadataDigest(body) });
}
it('fragments exact Unicode payload with twelve agreement markers and complete wrapper measurement', () => {
  const payload = packet(),
    result = fragmentLifecycleContext(payload);
  expect(result.outputs).toHaveLength(12);
  expect(LIFECYCLE_CONTEXT_SLOTS).toBe(12);
  expect(result.outputs.every((output) => output.hookSpecificOutput.additionalContext.length <= 10_000)).toBe(true);
  expect(
    result.outputs.every(
      (output) =>
        Buffer.from(output.hookSpecificOutput.additionalContext).toString('utf8') ===
        output.hookSpecificOutput.additionalContext,
    ),
  ).toBe(true);
  expect(result.serialized).toBe(result.outputs.map((output) => JSON.stringify(output)).join(''));
  expect(DEFAULT_TOKENIZER.count(result.serialized)).toBeGreaterThan(DEFAULT_TOKENIZER.count(payload));
  expect(
    assembleLifecycleContextSegments(
      [...result.outputs].reverse().map((output) => output.hookSpecificOutput.additionalContext),
    ),
  ).toEqual({ payload, id: JSON.parse(payload).id, delivery: 'unconfirmed' });
});
it('refuses missing, duplicate, conflicting, mixed-event and changed empty-slot frames', () => {
  const output = fragmentLifecycleContext(packet('small')).outputs.map(
    (item) => item.hookSpecificOutput.additionalContext,
  );
  expect(JSON.parse(output[11]!).chunk).toBe(null);
  for (const bad of [
    output.slice(0, 11),
    [...output.slice(0, 11), output[0]!],
    [
      ...output.slice(0, 11),
      fragmentLifecycleContext(packet('changed')).outputs[11]!.hookSpecificOutput.additionalContext,
    ],
  ])
    expect(() => assembleLifecycleContextSegments(bad)).toThrow();
  const changed = JSON.parse(output[0]!);
  changed.chunk += 'forged';
  changed.chunkDigest = hash(changed.chunk);
  expect(() => assembleLifecycleContextSegments([JSON.stringify(changed), ...output.slice(1)])).toThrow();
  const alias = output.map((text) => {
    const row = JSON.parse(text);
    row.event.inputDigest = hash('other event');
    return JSON.stringify(row);
  });
  expect(() => assembleLifecycleContextSegments(alias)).toThrow();
});
it('refuses a complete packet beyond the finite slot bound and oversized input collections', () => {
  expect(() => fragmentLifecycleContext(packet('x'.repeat(150_000)))).toThrow(/budget|bound/i);
  expect(() => assembleLifecycleContextSegments(Array(13).fill('{}'))).toThrow();
});

// HOST-03 (private source history) flipped this HOST-02 characterization: the transport fragments and assembles a packet pinned
// to an available Claude Code row (the H3-v1 selection 2.1.285 or the retained 2.1.278) and refuses every other pin, including
// an unavailable version's digest and the unsegmented native profile, with the generic IA-LIFECYCLE-BUDGET code.
it('fragments packets pinned to an available Claude Code row and refuses every other pin', () => {
  const { id: _id, ...body } = JSON.parse(packet('small')) as { id: string; pins: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const pinned = (profile: string): string => {
    const value = { ...body, pins: { ...body.pins, profile } };
    return JSON.stringify({ ...value, id: metadataDigest(value) });
  };
  for (const version of ['2.1.278', '2.1.285']) {
    const payload = pinned(lifecycleProfile('claude-code', version).digest),
      outputs = fragmentLifecycleContext(payload).outputs;
    expect(outputs).toHaveLength(LIFECYCLE_CONTEXT_SLOTS);
    expect(
      assembleLifecycleContextSegments(outputs.map((output) => output.hookSpecificOutput.additionalContext)).payload,
    ).toBe(payload);
  }
  for (const profile of [
    lifecycleProfile('ia-native', '1').digest,
    lifecycleProfile('claude-code', '2.1.286').digest,
    lifecycleProfile('claude-code', '2.1.277').digest,
    hash('no profile row'),
  ]) {
    expect(() => fragmentLifecycleContext(pinned(profile))).toThrow(
      expect.objectContaining({
        code: 'IA-LIFECYCLE-BUDGET',
        message: 'Lifecycle segment set exceeds its bound or has missing, mixed or invalid data',
      }),
    );
  }
});

// HOST-04 (private source history): the ia.lifecycle-context.v1 pins vector keeps exactly its eight keys, which every packet
// identity covers. The transport accepts them and refuses a packet whose pins drop, rename or add a key.
it('keeps the eight-key pins vector and refuses a dropped, renamed or added pin key (HOST-04)', () => {
  const keys = ['binding', 'implementation', 'installation', 'policy', 'profile', 'resources', 'source', 'view'];
  const { id: _id, ...body } = JSON.parse(packet('small')) as { id: string; pins: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const pins: Record<string, unknown> = { ...body.pins, profile: lifecycleProfile('claude-code', '2.1.285').digest };
  const signed = (value: Record<string, unknown>): string => {
    const next = { ...body, pins: value };
    return JSON.stringify({ ...next, id: metadataDigest(next) });
  };
  const refused = expect.objectContaining({
    code: 'IA-LIFECYCLE-BUDGET',
    message: 'Lifecycle segment set exceeds its bound or has missing, mixed or invalid data',
  });
  expect(body['format']).toBe('ia.lifecycle-context.v1');
  expect(Object.keys(pins).sort()).toEqual(keys);
  expect(fragmentLifecycleContext(signed(pins)).outputs).toHaveLength(LIFECYCLE_CONTEXT_SLOTS);
  for (const key of keys) {
    const { [key]: value, ...rest } = pins;
    for (const changed of [rest, { ...rest, [`${key}Pin`]: value }])
      expect(() => fragmentLifecycleContext(signed(changed))).toThrow(refused);
  }
  expect(() => fragmentLifecycleContext(signed({ ...pins, session: hash('session') }))).toThrow(refused);
});
