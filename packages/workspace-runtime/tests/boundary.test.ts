import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const source = resolve(import.meta.dirname, '../src');
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [resolve(directory, entry.name)]
        : [],
  );

it('never imports the composition compiler package', () => {
  const sources = files(source);
  expect(sources.length).toBeGreaterThan(0);
  const offending = sources.filter((file) =>
    readFileSync(file, 'utf8').includes('@inventarch/agent-composition-system'),
  );
  expect(offending).toEqual([]);
});
