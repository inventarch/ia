import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_TOKENIZER } from '@ia/runtime';
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
