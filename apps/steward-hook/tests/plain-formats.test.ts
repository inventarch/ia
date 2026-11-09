import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleProfile } from '@inventarch/workspace-runtime/lifecycle-profile';

/** The package's one switch, flipped here to prove the plain names come back exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import { contextHookImplementationDigest, runContextHook } from '../src/context.js';

afterEach(() => {
  flip.plain = false;
});

// Older, separately released programs probe this hook's identity and compare what it reports, so by default it answers
// with the released literal and no formatVersion; the plain answer is what the follow-up release writes (dec-008, A15).
it('answers the identity handshake with the released literal, and with the plain name once the switch flips', async () => {
  const shared = {
    implementation: expect.stringMatching(/^[a-f0-9]{64}$/),
    profile: lifecycleProfile('claude-code', '2.1.285').digest,
    slots: 12,
    characters: 10_000,
  };
  const released = await runContextHook(['identity'], '');
  expect(released).toEqual({ format: 'ia.context-hook-identity.v2', ...shared });
  expect(released).not.toHaveProperty('formatVersion');
  flip.plain = true;
  expect(await runContextHook(['identity'], '')).toEqual({
    format: 'context-hook-identity',
    formatVersion: 2,
    ...shared,
  });
});

it('digests the implementation under the released literal by default, and differently under the plain stamp', () => {
  const released = contextHookImplementationDigest();
  expect(released).toMatch(/^[a-f0-9]{64}$/);
  flip.plain = true;
  expect(contextHookImplementationDigest()).not.toBe(released);
  flip.plain = false;
  expect(contextHookImplementationDigest()).toBe(released);
});
