import { fileURLToPath } from 'node:url';
import { Corpus } from '@inventarch/workspace-runtime';
import { expect, it } from 'vitest';
import { publicFixtureCapture } from './public-fixture.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));

it('returns a whole-corpus capture usable by the M6 reader without repository release work', () => {
  const capture = publicFixtureCapture(repository);
  expect(capture.version).toBe(1);
  expect(capture.selection).toBeUndefined();
  const records = new Corpus(capture).records();
  expect(records.some((record) => record.discriminator === 'task' && record.name === 'example-task')).toBe(true);
  expect(records.some((record) => record.name === 'npm-release-policy' || record.name === 'npm-release-hygiene')).toBe(
    false,
  );
});

it('refuses an unsafe capture identity before a fixture can reach a consumer', () => {
  expect(() => publicFixtureCapture(repository, '../outside')).toThrow(
    'Invalid capture version, identity, revision or size',
  );
});
