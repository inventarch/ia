import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { hasWorkspaceSource, shipsPackage } from '../src/workspace-state.js';
import { cleanup, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const withSource = (name: string): string => {
  const root = scratch(name);
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  return root;
};

it('hasWorkspaceSource is true for a folder with .ia/src and false otherwise', () => {
  expect(hasWorkspaceSource(withSource('state-source'))).toBe(true);
  expect(hasWorkspaceSource(scratch('state-bare'))).toBe(false);
});

it('shipsPackage is true only when .ia/release.json exists', () => {
  const root = withSource('state-ships');
  expect(shipsPackage(root)).toBe(false);
  writeFileSync(resolve(root, '.ia/release.json'), '{}');
  expect(shipsPackage(root)).toBe(true);
  expect(shipsPackage(scratch('state-none'))).toBe(false);
});

it('the two are independent: source without a descriptor is a workspace that ships nothing', () => {
  const root = withSource('state-independent');
  expect([hasWorkspaceSource(root), shipsPackage(root)]).toEqual([true, false]);
});
