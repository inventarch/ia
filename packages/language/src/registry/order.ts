import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { BUILTIN_SYSTEMS } from './floor.js';
import type { SystemDeclaration } from './types.js';

export interface OrderedSystems {
  /** Bootstrap order over the systems in force: every system after all it requires, ties by name. */
  readonly order: readonly string[];
  /** Systems refused for missing requirements, cycle membership, or dependence on a refused system. */
  readonly dropped: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolve `requires` against the final systems in force, then order survivors (spec 4.2). */
export function orderSystems(winners: ReadonlyMap<string, SystemDeclaration>): OrderedSystems {
  const diagnostics: Diagnostic[] = [];
  const dropped = new Set<string>();
  const names = [...winners.keys()].sort();
  const dependencies = new Map<string, string[]>();
  const dependents = new Map(names.map((name) => [name, [] as string[]]));
  for (const name of names) {
    const system = winners.get(name)!;
    const declared = new Set<string>();
    for (const required of system.requires) {
      if (BUILTIN_SYSTEMS.includes(required.name)) continue;
      if (winners.has(required.name)) declared.add(required.name);
      else dropped.add(name);
    }
    dependencies.set(name, [...declared].sort());
    for (const required of declared) dependents.get(required)!.push(name);
  }

  // Tarjan's strongly connected components include every member of overlapping cycles.
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycleOf = new Map<string, ReadonlySet<string>>();
  const visit = (name: string): void => {
    const index = indices.size;
    indices.set(name, index);
    low.set(name, index);
    stack.push(name);
    active.add(name);
    for (const required of dependencies.get(name)!) {
      if (!indices.has(required)) {
        visit(required);
        low.set(name, Math.min(low.get(name)!, low.get(required)!));
      } else if (active.has(required)) {
        low.set(name, Math.min(low.get(name)!, indices.get(required)!));
      }
    }
    if (low.get(name) !== index) return;
    const members = new Set<string>();
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      members.add(member);
    } while (member !== name);
    if (members.size > 1 || dependencies.get(name)!.includes(name)) {
      for (const member of members) {
        cycleOf.set(member, members);
        dropped.add(member);
      }
    }
  };
  for (const name of names) if (!indices.has(name)) visit(name);

  // Refusal propagates to every dependent before resolving any requirement as satisfied.
  const refused = [...dropped];
  for (const name of refused) {
    for (const dependent of dependents.get(name)!) {
      if (dropped.has(dependent)) continue;
      dropped.add(dependent);
      refused.push(dependent);
    }
  }

  const cycleThrough = (start: string, members: ReadonlySet<string>): string[] => {
    const seen = new Set<string>();
    const path: string[] = [];
    const walk = (name: string): string[] | undefined => {
      seen.add(name);
      path.push(name);
      for (const required of dependencies.get(name)!) {
        if (!members.has(required)) continue;
        if (required === start) return [...path, start];
        if (seen.has(required)) continue;
        const cycle = walk(required);
        if (cycle !== undefined) return cycle;
      }
      path.pop();
      return undefined;
    };
    return walk(start)!; // Every member of a cyclic component lies on a cycle.
  };

  const visible = [...new Set([...BUILTIN_SYSTEMS, ...names.filter((name) => !dropped.has(name))])].join(', ');
  for (const name of names) {
    const system = winners.get(name)!;
    const cycle = cycleOf.get(name);
    if (cycle !== undefined) {
      diagnostics.push(
        diag(
          'IA-LANG-SYSTEM-CYCLE',
          system.path,
          system.span.line,
          `${system.path}:${system.span.line}: requires cycle ${cycleThrough(name, cycle).join(' -> ')}`,
        ),
      );
    }
    for (const required of system.requires) {
      if (BUILTIN_SYSTEMS.includes(required.name)) continue;
      if (winners.has(required.name) && !dropped.has(required.name)) continue;
      if (cycle !== undefined && cycle === cycleOf.get(required.name)) continue;
      diagnostics.push(
        diag(
          'IA-LANG-SYSTEM-MISSING',
          system.path,
          required.span.line,
          `${system.path}:${required.span.line}: @system ${system.displayName} requires '${required.name}', which has no @system in force; visible: ${visible}`,
        ),
      );
    }
  }
  diagnostics.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  // Kahn's algorithm with a sorted ready queue gives the first available name at each step.
  const remaining = new Map(
    names.filter((name) => !dropped.has(name)).map((name) => [name, dependencies.get(name)!.length]),
  );
  const ready = names.filter((name) => remaining.get(name) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    order.push(name);
    for (const dependent of dependents.get(name)!) {
      const count = remaining.get(dependent);
      if (count === undefined) continue;
      remaining.set(dependent, count - 1);
      if (count === 1) ready.push(dependent);
    }
    ready.sort();
  }
  return { order, dropped, diagnostics };
}
