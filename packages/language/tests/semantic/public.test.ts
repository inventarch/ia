import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  buildRegistry,
  compile,
  parse,
  resolveTarget,
  requirementCollisions,
  isRequirementId,
  canonicalValue,
  verbOf,
  VERB_PHRASES,
  REQUIREMENT_KINDS,
} from '../../src/index.js';
import type { CompiledRecord, Location, RequirementOccurrence, Resolution } from '../../src/index.js';

describe('semantic public API', () => {
  it('exposes resolver and tree validation without private carrier readers', () => {
    const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    const parsed = parse('#! ia 1.0\n@system example\n  provider "test"\n  version "1.0.0"\n', 'a.ia');
    const built = buildRegistry([{ ...parsed, location }]);
    const compiled = compile(parsed.ast, built.registry, location, []);
    const resolution = resolveTarget(
      { kind: 'ref', discriminator: 'system', name: 'Example' },
      built.registry,
      compiled.records,
    );
    expectTypeOf(resolution).toEqualTypeOf<Resolution<CompiledRecord>>();
    expect(resolution.kind).toBe('resolved');
    const occurrences: RequirementOccurrence[] = [
      { id: 'REQ-A', identity: 'x', path: 'x.ia', line: 1 },
      { id: 'REQ-A', identity: 'y', path: 'y.ia', line: 2 },
    ];
    expect(requirementCollisions(occurrences).refused.size).toBe(2);
    expect(isRequirementId('REQ-A')).toBe(true);
    expect(REQUIREMENT_KINDS).toHaveLength(8);
  });
  it('shares the exact closed vocabulary with downstream consumers', () => {
    expect(canonicalValue('primitive', 'memory')).toBe('Memory');
    expect(verbOf('used-by')).toEqual({ predicate: 'use', direction: 'in' });
    expect(VERB_PHRASES).toHaveLength(54);
    expect(new Set(VERB_PHRASES).size).toBe(54);
  });
});
