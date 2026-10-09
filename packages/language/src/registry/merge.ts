import type { Span } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import type { Band } from '../taxonomy.js';
import type { Entry, Registration, SystemDeclaration } from './types.js';

interface Named {
  readonly name: string;
  readonly displayName: string;
  readonly band: Band;
  readonly path: string;
  readonly span: Span;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Band merge of declarations sharing a name: the highest band wins and lower bands are shadowed
 * silently; two at the winning band collide and neither is in force (spec 3.2, 4.2).
 */
export function mergeByName<T extends Named>(
  items: readonly T[],
  label: string,
): { winners: Map<string, T>; diagnostics: Diagnostic[] } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.name);
    if (group === undefined) groups.set(item.name, [item]);
    else group.push(item);
  }
  const winners = new Map<string, T>();
  const diagnostics: Diagnostic[] = [];
  for (const [name, group] of [...groups.entries()].sort(([a], [b]) => byName(a, b))) {
    const top = Math.max(...group.map((item) => item.band));
    const atTop = group.filter((item) => item.band === top);
    const winner = atTop[0];
    if (atTop.length === 1 && winner !== undefined) {
      winners.set(name, winner);
      continue;
    }
    for (const item of atTop) {
      const others = atTop
        .filter((o) => o !== item)
        .map((o) => `${o.path}:${o.span.line}`)
        .join(', ');
      diagnostics.push(
        diag(
          'IA-LANG-IDENTITY-COLLISION',
          item.path,
          item.span.line,
          `${item.path}:${item.span.line}: ${label} ${item.displayName} collides with ${others} at band ${top}`,
        ),
      );
    }
  }
  return { winners, diagnostics };
}

interface Candidate {
  readonly registration: Registration;
  readonly entry: Entry;
  readonly system: SystemDeclaration;
}

/**
 * One registration per keyword. The floor's words come first and cannot be overridden (extraction
 * refuses them). For a minted keyword the winning band is the highest any system registers it at;
 * two systems there is a conflict on each, and the keyword is blocked at that band rather than
 * falling through to a lower provider.
 */
export function mergeRegistrations(
  systems: readonly SystemDeclaration[],
  floor: readonly Registration[],
): { registrations: Map<string, Registration>; blocked: Set<string>; diagnostics: Diagnostic[] } {
  const candidates = new Map<string, Candidate[]>();
  for (const system of systems) {
    for (const entry of system.entries) {
      const registration: Registration = {
        keyword: entry.keyword,
        system: system.name,
        kind: entry.kind,
        category: entry.category,
        facets: entry.facets,
        schema: entry.schema,
        ...(entry.artifactSet === undefined ? {} : { artifactSet: entry.artifactSet }),
        ...(entry.primitive === undefined ? {} : { primitive: entry.primitive }),
        ...(entry.move === undefined ? {} : { move: entry.move }),
        band: system.band,
      };
      const list = candidates.get(entry.keyword);
      if (list === undefined) candidates.set(entry.keyword, [{ registration, entry, system }]);
      else list.push({ registration, entry, system });
    }
  }
  const registrations = new Map<string, Registration>(floor.map((r) => [r.keyword, r] as const));
  const blocked = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const [keyword, list] of [...candidates.entries()].sort(([a], [b]) => byName(a, b))) {
    // Extraction owns the reserved-keyword diagnostic; preserve the supplied floor here.
    if (registrations.has(keyword)) continue;
    const top = Math.max(...list.map((c) => c.registration.band));
    const atTop = list.filter((c) => c.registration.band === top);
    const winner = atTop[0];
    if (atTop.length === 1 && winner !== undefined) {
      registrations.set(keyword, winner.registration);
      continue;
    }
    blocked.add(keyword);
    const names = atTop.map((c) => c.system.displayName).join(', ');
    for (const c of atTop) {
      diagnostics.push(
        diag(
          'IA-LANG-DISCRIMINATOR-CONFLICT',
          c.system.path,
          c.entry.span.line,
          `${c.system.path}:${c.entry.span.line}: '${keyword}' is registered by ${names} at band ${top}; the keyword is blocked at that band`,
        ),
      );
    }
  }
  return { registrations, blocked, diagnostics };
}
