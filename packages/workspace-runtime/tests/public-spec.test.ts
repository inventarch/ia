import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { qualifyPublicSpec } from './public-spec-fixture.mjs';

it('qualifies public spec shapes and explicit document bodies with stale, digest and disclosure refusals', () => {
  const result = qualifyPublicSpec(
    resolve(import.meta.dirname, '../../..'),
    mkdtempSync(join(tmpdir(), 'ia-public-spec-')),
  );
  expect(result.passed).toBe(true);
  expect(result.positiveStatuses).toBe(4);
  expect(result.refused.length).toBeGreaterThanOrEqual(14);
  expect(result.implicitBodyLoader).toBe(false);
}, 120000);
