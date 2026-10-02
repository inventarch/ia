import { expect, it } from 'vitest';
import { createAuthoringIndex, prepareAuthoringTarget, resolveAuthoring } from '../src/authoring.js';
import type { AuthoringIndexInput, AuthoringLifecycleSelection } from '../src/authoring.js';
import { authoringFixture } from './authoring-fixture.js';

const selection: AuthoringLifecycleSelection = {
  model: 'delivery',
  version: '1',
  workflow: 'product',
  iteration: 2,
  stage: 'draft',
  phase: null,
  primitive: null,
};
function lifecycleInput(f: ReturnType<typeof authoringFixture>): AuthoringIndexInput {
  return {
    ...f.input,
    artifacts: f.input.artifacts.map((a) => ({
      ...a,
      lifecycle: [{ ...selection, role: 'consumed', maturity: 'draft' }],
    })),
    lifecycles: [
      {
        id: 'delivery',
        version: '1',
        stages: ['draft', 'review'],
        transitions: [
          {
            id: 'review',
            from: 'draft',
            to: 'review',
            inputs: ['requirement'],
            outputs: ['acceptance'],
            feedback: false,
            criteria: [{ id: 'ready', version: '1', basis: 'semantic', text: 'Review the explicit evidence.' }],
          },
        ],
      },
    ],
  };
}
it('assembles exact artifact contracts and profile-role lifecycle obligations without claiming semantic assessment', () => {
  const f = authoringFixture();
  try {
    const input = lifecycleInput(f),
      index = createAuthoringIndex(f.capture, f.resources, input),
      view = resolveAuthoring(f.capture, f.resources, index, f.scope);
    const result = prepareAuthoringTarget(view, {
      target: { kind: 'document', id: 'brief' },
      document: null,
      lifecycle: selection,
    });
    expect(result.parts.some((p) => p.text.includes('# Note'))).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.expectedOutputs).toEqual([
      { role: 'acceptance', reason: 'Expected after requirements are authored.' },
    ]);
    expect(result.criteria.find((c) => c.id === 'ready')?.status).toBe('not-evaluated');
    expect(
      prepareAuthoringTarget(view, {
        target: { kind: 'document', id: 'brief' },
        document: null,
        lifecycle: { ...selection, iteration: 3 },
      }).missing,
    ).toContainEqual({ id: 'lifecycle', reason: 'Lifecycle selection unavailable' });
  } finally {
    f.reader.close();
  }
});
it('refuses unbound lifecycle selection and missing transition inputs, while preserving independent phase coordinates', () => {
  const f = authoringFixture();
  try {
    const input = lifecycleInput(f),
      absent = {
        ...input,
        profiles: input.profiles.map((p) => ({
          ...p,
          roles: [...p.roles, { id: 'evidence', min: 0, max: 1, context: 'optional' as const, contract: null }],
        })),
        lifecycles: input.lifecycles.map((m) => ({
          ...m,
          transitions: m.transitions.map((t) => ({ ...t, inputs: ['evidence'] })),
        })),
      };
    const index = createAuthoringIndex(f.capture, f.resources, absent),
      view = resolveAuthoring(f.capture, f.resources, index, f.scope);
    expect(
      prepareAuthoringTarget(view, { target: f.target, document: null, lifecycle: selection }).missing,
    ).toContainEqual({ id: 'lifecycle', reason: 'Lifecycle selection unavailable' });
    const result = prepareAuthoringTarget(view, {
      target: { kind: 'document', id: 'brief' },
      document: null,
      lifecycle: selection,
    });
    expect(result.missing.some((m) => m.id === 'lifecycle-input-evidence')).toBe(true);
  } finally {
    f.reader.close();
  }
});
it('decodes the target request as closed data without invoking accessors', () => {
  const f = authoringFixture();
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input),
      view = resolveAuthoring(f.capture, f.resources, index, f.scope);
    expect(() =>
      prepareAuthoringTarget(view, {
        target: { kind: 'document', id: 'brief', secret: true },
        document: null,
        lifecycle: null,
      } as never),
    ).toThrow();
    let reads = 0;
    const target = {
      get kind() {
        reads++;
        return 'document';
      },
      id: 'brief',
    };
    expect(() => prepareAuthoringTarget(view, { target, document: null, lifecycle: null } as never)).toThrow();
    expect(reads).toBe(0);
  } finally {
    f.reader.close();
  }
});
