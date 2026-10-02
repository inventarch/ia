import {
  buildRegistry,
  collisions,
  compile,
  parse,
  requirementCollisions,
  sortDiagnostics,
} from '../../packages/language/src/index.js';
import type { Diagnostic, Location } from '../../packages/language/src/index.js';

export interface NativeInput {
  readonly path: string;
  readonly text: string;
  readonly location: Location;
}
/** Build/test closure loader; db later owns location-specific admission and persistence. */
export function compileNative(inputs: readonly NativeInput[]) {
  const sources = [...inputs]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((i) => ({ ...parse(i.text, i.path), location: i.location }));
  const registered = buildRegistry(sources);
  const diagnostics: Diagnostic[] = [...registered.diagnostics];
  const errorPaths = new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.path));
  const first = sources.map((s) => compile(s.ast, registered.registry, s.location, []));
  first.forEach((r) => r.diagnostics.filter((d) => d.severity === 'error').forEach((d) => errorPaths.add(d.path)));
  let pool = first.flatMap((r) => r.records).filter((r) => !errorPaths.has(r.source.path));
  const identityFaults = collisions(
    pool.map((r) => ({ identity: r.identity, path: r.source.path, line: r.source.line, band: r.placement.band })),
  );
  diagnostics.push(...identityFaults.diagnostics);
  for (const d of identityFaults.diagnostics) errorPaths.add(d.path);
  pool = pool.filter((r) => !errorPaths.has(r.source.path));
  const results = sources.map((s) =>
    compile(
      s.ast,
      registered.registry,
      s.location,
      pool.filter((r) => r.source.path !== s.ast.path),
    ),
  );
  for (const result of results) diagnostics.push(...result.diagnostics);
  for (const d of diagnostics) if (d.severity === 'error') errorPaths.add(d.path);
  const preliminary = results.flatMap((r) => r.records).filter((r) => !errorPaths.has(r.source.path));
  const requirements = requirementCollisions(
    preliminary.flatMap((r) =>
      r.requirements.map((q) => ({ id: q.id, identity: r.identity, path: r.source.path, line: q.span.line })),
    ),
  );
  diagnostics.push(...requirements.diagnostics);
  for (const d of requirements.diagnostics) errorPaths.add(d.path);
  return {
    sources,
    registry: registered.registry,
    records: preliminary.filter((r) => !errorPaths.has(r.source.path)),
    diagnostics: sortDiagnostics(diagnostics),
  };
}
