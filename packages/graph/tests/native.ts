import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { buildRegistry, compile, parse } from '@ia/language';
import type { Location } from '@ia/language';

const root = resolve(import.meta.dirname, '../../..');
const tree = (base: string) =>
  base === root ? resolve(root, 'examples/conformance/native') : resolve(base, '.ia/src');
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(path, entry.name))
      : entry.name.endsWith('.ia')
        ? [resolve(path, entry.name)]
        : [],
  );
}
/**
 * Compile every `.ia` file under `<base>/.ia/src` in two passes, placing `floor/` at band 10 and the rest at band 100.
 * `edit` may rewrite a file's text (keyed by its workspace-relative path) before parsing.
 */
export function corpus(base: string, edit: (path: string, text: string) => string = (_path, text) => text) {
  const inputs = files(tree(base))
    .sort()
    .map((path) => {
      const name = '.ia/src/' + relative(tree(base), path).replaceAll('\\', '/');
      const location: Location = name.startsWith('.ia/src/floor/')
        ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
        : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
      return { path: name, text: edit(name, readFileSync(path, 'utf8')), location };
    });
  const sources = inputs.map((input) => ({ ...parse(input.text, input.path), location: input.location }));
  const registered = buildRegistry(sources);
  if (registered.diagnostics.length > 0) throw new Error(JSON.stringify(registered.diagnostics));
  const registry = registered.registry;
  const first = sources.flatMap((s) => compile(s.ast, registry, s.location, []).records);
  const records = sources.flatMap((s) => {
    const result = compile(
      s.ast,
      registry,
      s.location,
      first.filter((r) => r.source.path !== s.ast.path),
    );
    if (result.diagnostics.length > 0) throw new Error(JSON.stringify(result.diagnostics));
    return result.records;
  });
  return { inputs, sources, registry, records };
}
export const { inputs, sources, registry, records } = corpus(root);
/** The self-contained compliance loop fixture; its advisory law keeps a conditioned inverse `enforced-by` edge. */
export const loopRoot = resolve(root, 'packages/compliance/fixtures/loop');
export const loop = corpus(loopRoot);
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
