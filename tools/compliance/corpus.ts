import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { NativeInput } from '../native/compile.js';
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function conformanceSources(root: string): { path: string; text: string }[] {
  const base = resolve(root, 'examples/conformance/native');
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(path, entry.name))
        : entry.name.endsWith('.ia')
          ? [resolve(path, entry.name)]
          : [],
    );
  return walk(base)
    .map((path) => ({
      path: '.ia/src/' + relative(base, path).replaceAll('\\', '/'),
      text: readFileSync(path, 'utf8'),
    }))
    .sort((a, b) => compare(a.path, b.path));
}

/** Repository conformance sources are explicit inputs; no package test module runs during qualification. */
export function conformanceInputs(root: string): NativeInput[] {
  return conformanceSources(root).map((source) => ({
    ...source,
    location: source.path.startsWith('.ia/src/floor/')
      ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
      : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  }));
}
