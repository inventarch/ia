import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { buildRegistry, compile, parse } from '@ia/language';
import type { Location } from '@ia/language';

const root = resolve(import.meta.dirname, '../../..');
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(path, entry.name))
      : entry.name.endsWith('.ia')
        ? [resolve(path, entry.name)]
        : [],
  );
}
export const inputs = files(resolve(root, 'examples/conformance/native'))
  .sort()
  .map((path) => {
    const name = '.ia/src/' + relative(resolve(root, 'examples/conformance/native'), path).replaceAll('\\', '/');
    const location: Location = name.startsWith('.ia/src/floor/')
      ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
      : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    return { path: name, text: readFileSync(path, 'utf8'), location };
  });
export const sources = inputs.map((input) => ({ ...parse(input.text, input.path), location: input.location }));
const registered = buildRegistry(sources);
if (registered.diagnostics.length > 0) throw new Error(JSON.stringify(registered.diagnostics));
export const registry = registered.registry;
const first = sources.flatMap((s) => compile(s.ast, registry, s.location, []).records);
export const records = sources.flatMap((s) => {
  const result = compile(
    s.ast,
    registry,
    s.location,
    first.filter((r) => r.source.path !== s.ast.path),
  );
  if (result.diagnostics.length > 0) throw new Error(JSON.stringify(result.diagnostics));
  return result.records;
});
export function instance(source: string) {
  const parsed = parse(`#! ia 1.0\n${source}\n`, 'probe.ia');
  if (parsed.diagnostics.length > 0) throw new Error(JSON.stringify(parsed.diagnostics));
  return compile(
    parsed.ast,
    registry,
    { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    records,
  ).records[0]!;
}
