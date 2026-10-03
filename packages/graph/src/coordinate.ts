import { ARTIFACT_SETS, CONDITION_AXES, SEVERITIES, canonicalValue, valuesFor } from '@inventarch/language';
import type {
  ArtifactSet,
  CompiledField,
  CompiledRecord,
  ConditionAxis,
  KernelSeverity,
  Provenance,
} from '@inventarch/language';
import { GraphUsageError, graphDiagnostic } from './diagnostics.js';
import type { GraphDiagnostic } from './diagnostics.js';
export type Coordinate = Readonly<Partial<Record<ConditionAxis, string>>>;
export interface Dimensions {
  readonly provenance: Provenance;
  readonly severity?: KernelSeverity;
  readonly artifactSet?: ArtifactSet;
}

export function validateCoordinate(input: Readonly<Record<string, unknown>>): Coordinate {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new GraphUsageError('IA-GRAPH-COORDINATE-VALUE-UNKNOWN', 'Coordinate must be an axis/value object');
  const output: Partial<Record<ConditionAxis, string>> = {};
  for (const [name, value] of Object.entries(input)) {
    if (valuesFor(name) === undefined)
      throw new GraphUsageError(
        'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
        `Unknown coordinate axis '${name}'; admitted: ${CONDITION_AXES.join(', ')}`,
      );
    if (value === undefined) continue;
    const canonical = typeof value === 'string' ? canonicalValue(name, value) : undefined;
    if (canonical === undefined)
      throw new GraphUsageError(
        'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
        `Unknown ${name} value '${String(value)}'; admitted: ${valuesFor(name)!.join(', ')}`,
      );
    output[name as ConditionAxis] = canonical;
  }
  return Object.freeze(output);
}
export function dimensionsOf(record: CompiledRecord): {
  dimensions: Dimensions;
  diagnostics: readonly GraphDiagnostic[];
} {
  const diagnostics: GraphDiagnostic[] = [];
  const read = (fields: readonly CompiledField[], key: string, domain: readonly string[]): string | undefined => {
    const matched = fields.filter((f) => f.key === key);
    if (matched.length === 0) return undefined;
    const value = matched[0]!.value;
    const canonical =
      matched.length === 1 && (value.kind === 'scalar' || value.kind === 'string')
        ? domain.find((v) => v.toLowerCase() === value.text.toLowerCase())
        : undefined;
    if (canonical === undefined)
      diagnostics.push(
        graphDiagnostic(
          'IA-GRAPH-DIMENSION-UNKNOWN',
          record.source.path,
          matched[0]!.span.line,
          `${record.identity}: ${key} must occur once as one of ${domain.join(', ')}`,
        ),
      );
    return canonical;
  };
  const governance = record.sections
    .filter((s) => s.name === 'governance')
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f);
  const severity = read(governance, 'severity', SEVERITIES) as KernelSeverity | undefined;
  const artifactSet = read(record.head, 'artifact-set', ARTIFACT_SETS) as ArtifactSet | undefined;
  return {
    dimensions: Object.freeze({
      provenance: record.provenance,
      ...(severity === undefined ? {} : { severity }),
      ...(artifactSet === undefined ? {} : { artifactSet }),
    }),
    diagnostics,
  };
}
