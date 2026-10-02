import type { RecordNode } from './ast.js';
import { diag } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { fieldOf } from './registry/fields.js';
import type { Registration } from './registry/types.js';
import type { Band, Kind } from './taxonomy.js';

/** The four slots of spec 3.1 and their rendering. */
export interface Identity {
  readonly identity: string;
  readonly system: string;
  readonly kind: Kind;
  readonly facet: string;
  readonly name: string;
  readonly displayName: string;
}

export function renderIdentity(system: string, kind: string, facet: string, name: string): string {
  return `${system}/${kind}/${facet}/${name}`;
}

/** Spec 3.1: the facet is the `facet` head field or the registration's first facet; the name is lowercased; the authored spelling is kept. */
export function identityOf(
  record: RecordNode,
  registration: Registration,
  path: string,
): { readonly identity: Identity | undefined; readonly diagnostics: readonly Diagnostic[] } {
  let facet = registration.facets[0]!; // A joined registration declares at least one facet (4.2).
  const facetField = fieldOf(record.head, ['facet']);
  if (facetField !== undefined) {
    const value = facetField.value;
    const named = value.kind === 'scalar' || value.kind === 'string' ? value.text : '';
    if (!registration.facets.includes(named)) {
      const line = facetField.span.line;
      return {
        identity: undefined,
        diagnostics: [
          diag(
            'IA-LANG-FACET-UNDECLARED',
            path,
            line,
            `${path}:${line}: facet '${named}' is not declared for '${registration.keyword}'; declared: ${registration.facets.join(', ')}`,
          ),
        ],
      };
    }
    facet = named;
  }
  const name = record.name.toLowerCase();
  return {
    identity: {
      identity: renderIdentity(registration.system, registration.kind, facet, name),
      system: registration.system,
      kind: registration.kind,
      facet,
      name,
      displayName: record.name,
    },
    diagnostics: [],
  };
}

export interface IdentityOccurrence {
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly band: Band;
}

/** Spec 3.2 and 3.3: one identity twice at one band is a collision on both; across bands the graph's authority rule decides. */
export function collisions(occurrences: readonly IdentityOccurrence[]): {
  readonly refused: ReadonlySet<IdentityOccurrence>;
  readonly diagnostics: readonly Diagnostic[];
} {
  const groups = new Map<string, IdentityOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.identity}@${occurrence.band}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [occurrence]);
    else group.push(occurrence);
  }
  const refused = new Set<IdentityOccurrence>();
  const diagnostics: Diagnostic[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const occurrence of group) {
      refused.add(occurrence);
      const others = group
        .filter((other) => other !== occurrence)
        .map((other) => `${other.path}:${other.line}`)
        .join(', ');
      diagnostics.push(
        diag(
          'IA-LANG-IDENTITY-COLLISION',
          occurrence.path,
          occurrence.line,
          `${occurrence.path}:${occurrence.line}: identity ${occurrence.identity} is also declared at ${others} (band ${occurrence.band})`,
          { identity: occurrence.identity },
        ),
      );
    }
  }
  return { refused, diagnostics };
}
