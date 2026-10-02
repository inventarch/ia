import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkCompliance, readFixtures } from './check.js';

const root = resolve(import.meta.dirname, '../..');
it('discovers the actual conformance tree without stray entries', () => {
  const listing = readFixtures(root);
  expect(listing.strays).toEqual([]);
  expect(listing.fixtures).toHaveLength(179);
});
it('executes native graph, all language fixtures, all refusal-code boundaries and kernel generation', () => {
  const { report, fixtures, boundaries, qualification } = checkCompliance(root);
  expect(fixtures).toBe(179);
  expect(boundaries).toBe(66);
  expect(qualification).toEqual({
    platform: process.platform,
    deferredPlatformCodes:
      process.platform === 'win32' ? [] : ['IA-EXEC-OUTPUT-EXISTS', 'IA-PUBLICATION-BUSY', 'IA-PUBLICATION-CONFLICT'],
    reason:
      process.platform === 'win32'
        ? null
        : 'Managed draft publication is qualified only on local Windows NTFS; unsupported hosts verify refusal without effects.',
  });
  expect(report.verdicts.filter((v) => v.outcome === 'fail')).toEqual([]);
  expect(report.outcome).toBe('pass');
  expect(report.verdicts.filter((v) => v.outcome === 'not-evaluated')).toEqual([]);
  expect(report.verdicts.find((v) => v.check === 'COMP-ADOPTION')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-FIXTURES')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-KERNEL')!.outcome).toBe('pass');
});
