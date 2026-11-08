import { expect, it } from 'vitest';
import { dependencyChanges, describeDependencyChanges } from './dependency-note.mjs';
import { NOTE_FORMAT, validateNote } from './release-notes.mjs';

const db = {
  before: { dependencies: { semver: '7.8.5' }, devDependencies: { '@types/semver': '7.7.1', vitest: 'catalog:' } },
  after: { dependencies: { semver: '7.8.6' }, devDependencies: { '@types/semver': '7.8.0', vitest: 'catalog:' } },
};

it('lists each moved dependency by section, and nothing that kept its range', () => {
  expect(dependencyChanges(db.before, db.after)).toEqual([
    { section: 'dependencies', name: 'semver', from: '7.8.5', to: '7.8.6' },
    { section: 'devDependencies', name: '@types/semver', from: '7.7.1', to: '7.8.0' },
  ]);
  expect(dependencyChanges(null, { dependencies: { zod: '4.6.7' } })).toEqual([
    { section: 'dependencies', name: 'zod', from: null, to: '4.6.7' },
  ]);
  expect(dependencyChanges({ peerDependencies: { zod: '4' } }, {})).toEqual([
    { section: 'peerDependencies', name: 'zod', from: '4', to: null },
  ]);
});

it('makes a runtime move a patch and names every move, with packages in code spans', () => {
  const described = describeDependencyChanges([
    { name: '@inventarch/db', rows: dependencyChanges(db.before, db.after) },
    { name: '@inventarch/graph', rows: [] },
    {
      name: '@inventarch/service-contracts',
      rows: dependencyChanges({ dependencies: { zod: '4.6.6' } }, { dependencies: { zod: '4.6.7' } }),
    },
  ]);
  expect(described).toEqual({
    bump: 'patch',
    title: 'Move dependencies to newer releases',
    summary:
      'Dependencies move to newer releases. `@inventarch/db`: `semver` 7.8.5 to 7.8.6, `@types/semver` 7.7.1 to 7.8.0 ' +
      '(development); `@inventarch/service-contracts`: `zod` 4.6.6 to 4.6.7.',
  });
  // The summary is publishable: the note validator refuses bare account mentions.
  const names = ['@inventarch/db', '@inventarch/service-contracts'];
  expect(() =>
    validateNote(
      'dependabot-x',
      { format: NOTE_FORMAT, ...described, packages: names, paths: ['packages/db/'] },
      names,
    ),
  ).not.toThrow();
});

it('records a development-only move as none, and refuses a branch that moves nothing', () => {
  const rows = dependencyChanges({ devDependencies: { vitest: '4.1.11' } }, { devDependencies: { vitest: '4.1.12' } });
  expect(describeDependencyChanges([{ name: '@inventarch/db', rows }])).toMatchObject({
    bump: 'none',
    title: 'Move development dependencies to newer releases',
  });
  expect(() => describeDependencyChanges([{ name: '@inventarch/db', rows: [] }])).toThrow(/hand-written note/);
});
