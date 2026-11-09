import { expect, it, vi } from 'vitest';

const criteria = vi.hoisted(() => new Set<string>());
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

it('names the primary-guide and minting-readiness proof criteria without a version', () => {
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
  expect([...criteria].sort()).toEqual(['minting-readiness', 'primary-guide']);
});
