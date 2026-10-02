import { expect, it } from 'vitest';
import { PUBLICATION_CODES } from '../../packages/runtime/src/index.js';
import { publicationFixtureCodes, runPublicationFixtures } from './publication-fixtures.js';

for (const platform of ['linux', 'darwin'] as const)
  it(`observes unsupported local publication without claiming Windows effects on ${platform}`, () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      const results = runPublicationFixtures();
      expect(results.flatMap((result) => result.assessment.findings)).toEqual([]);
      expect(results.every((result) => result.assessment.outcome === 'pass')).toBe(true);
      expect(results.map((result) => result.assessment.scope)).toContain('publication/local-unavailable');
      expect(results.map((result) => result.assessment.scope)).toContain('publication/existing-unavailable');
      expect([...new Set(results.flatMap((result) => result.observedCodes))].sort()).toEqual([
        'IA-PUBLICATION-INVALID',
        'IA-PUBLICATION-PATH-UNSAFE',
        'IA-PUBLICATION-UNAVAILABLE',
      ]);
      expect(publicationFixtureCodes()).toEqual([
        'IA-PUBLICATION-INVALID',
        'IA-PUBLICATION-PATH-UNSAFE',
        'IA-PUBLICATION-UNAVAILABLE',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

it.skipIf(process.platform !== 'win32')(
  'observes every publication refusal through the actual qualified Windows primitive',
  () => {
    const results = runPublicationFixtures();
    expect(results.flatMap((result) => result.assessment.findings)).toEqual([]);
    expect(results.every((result) => result.assessment.outcome === 'pass')).toBe(true);
    expect(results.flatMap((result) => result.observedCodes).sort()).toEqual([...PUBLICATION_CODES].sort());
    expect(publicationFixtureCodes()).toEqual(PUBLICATION_CODES);
  },
);
