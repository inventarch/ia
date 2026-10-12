import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { contentFindings, scanContent, validateContentPolicy } from './public/content-scan.mjs';

it('keeps personal address and local-path refusals under public membership policy', () => {
  const root = resolve(import.meta.dirname, '../..');
  const policy = JSON.parse(readFileSync(resolve(root, 'tools/distribution/public-content-policy.json'), 'utf8'));
  expect(() => validateContentPolicy(policy)).not.toThrow();
  const outputs = new Map([
    [
      'packages/language/README.md',
      { bytes: Buffer.from(['person', 'unlisted.dev'].join('@') + ' and /' + 'home/person/private.txt') },
    ],
  ]);
  expect(
    contentFindings(outputs, policy)
      .map((row) => row.rule)
      .sort(),
  ).toEqual(['email', 'local-path']);
  expect(() => scanContent(outputs, policy)).toThrow(/private-content leak/);
  expect(() =>
    validateContentPolicy({ ...policy, packageNames: [{ root: 'apps/cli', name: '@inventarch/cli' }] }),
  ).toThrow(/invalid public package owner/);
});
