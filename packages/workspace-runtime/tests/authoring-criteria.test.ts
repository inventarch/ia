import { expect, it, vi } from 'vitest';

const criteria = vi.hoisted(() => new Set<string>());
/** The package's one switch, flipped here to prove the plain names come back exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
vi.mock('../src/resource-format.js', async (original) => {
  const actual = await original<typeof import('../src/resource-format.js')>();
  return {
    ...actual,
    metadataDigest: (value: unknown) => {
      const criterion = (value as { criterion?: unknown } | null)?.criterion;
      if (typeof criterion === 'string') criteria.add(criterion);
      return actual.metadataDigest(value);
    },
  };
});

const { assessAuthoringMinting, createAuthoringIndex, resolveAuthoring } = await import('../src/authoring.js');
const { authoringFixture } = await import('./authoring-fixture.js');

const proved = (): string[] => {
  criteria.clear();
  const f = authoringFixture();
  try {
    const view = resolveAuthoring(
      f.capture,
      f.resources,
      createAuthoringIndex(f.capture, f.resources, f.input),
      f.scope,
    );
    assessAuthoringMinting(view, view);
  } finally {
    f.reader.close();
  }
  return [...criteria].sort();
};

// Forward compatibility (dec-008, A15): the criterion ids are digested into shared proofs that older programs compare
// against their own, so the released ids are written until the switch flips.
it('names the proof criteria with their released ids by default and without a version once the switch flips', () => {
  expect(proved()).toEqual(['minting-readiness-v1', 'primary-guide-v1']);
  flip.plain = true;
  try {
    expect(proved()).toEqual(['minting-readiness', 'primary-guide']);
  } finally {
    flip.plain = false;
  }
});
