// The public-language guide ships as LANGUAGE.md in every system folder and in each package resources.mjs lists in
// LANGUAGE_GUIDE_COPIES; `pnpm public:generate` writes every copy and `generate-public.mjs --check` reports one that drifts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { publicOutputs } from './generate-public.mjs';

const root = resolve(import.meta.dirname, '../..');
const GUIDE = 'LANGUAGE.md',
  SYSTEMS = '.ia/src/systems/';
const disk = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** Every package outside the system folders that ships the guide: its manifest lists LANGUAGE.md or the file is there. */
function shippedCopies(): string[] {
  const copies: string[] = [];
  for (const parent of ['apps', 'packages'])
    for (const entry of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${entry.name}`,
        manifest = resolve(root, directory, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const files = (JSON.parse(readFileSync(manifest, 'utf8')) as { files?: unknown }).files;
      if ((Array.isArray(files) && files.includes(GUIDE)) || existsSync(resolve(root, directory, GUIDE)))
        copies.push(`${directory}/${GUIDE}`);
    }
  return copies.sort();
}

it('generates every shipped LANGUAGE.md as the one public-language guide and finds each copy current', () => {
  const { generated, stale } = publicOutputs(root);
  const guides = [...generated].filter(([path]) => path.endsWith('/' + GUIDE)),
    systems = guides.filter(([path]) => path.startsWith(SYSTEMS)),
    copies = guides.filter(([path]) => !path.startsWith(SYSTEMS)).map(([path]) => path);
  expect(systems).toHaveLength(11);
  // A package that starts shipping the guide joins LANGUAGE_GUIDE_COPIES, so no copy is kept by hand.
  expect(copies.sort()).toEqual(shippedCopies());
  expect(copies).toHaveLength(12);
  const guide = systems[0]![1];
  expect(guide).toMatch(/^# Public IA language\n/);
  for (const [path, bytes] of guides) {
    expect(bytes, path).toBe(guide);
    expect(disk(path), path).toBe(guide);
  }
  expect(stale.map(([path]) => path).filter((path) => path.endsWith('/' + GUIDE))).toEqual([]);
});

it('reports a drifted package copy as a difference', () => {
  const drifted = 'packages/db/LANGUAGE.md',
    read = (path: string) => (path === drifted ? disk(path) + 'A hand edit.\n' : disk(path));
  expect(publicOutputs(root, read).stale.map(([path]) => path)).toContain(drifted);
  expect(publicOutputs(root).stale.map(([path]) => path)).not.toContain(drifted);
});
