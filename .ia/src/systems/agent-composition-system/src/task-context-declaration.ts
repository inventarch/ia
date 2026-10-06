import { validateCoordinate } from '@inventarch/graph';
import type { Coordinate } from '@inventarch/graph';
import { authoringRequest, unique } from '@inventarch/workspace-runtime/authoring-format';
import type { AuthoringTargetRequest } from '@inventarch/workspace-runtime/authoring-types';
import {
  frozen,
  list,
  object,
  occurrence,
  occurrenceOf,
  portablePath,
  resourceKey,
  keyOf,
  text,
} from '@inventarch/workspace-runtime/resource-format';
import type { ResourceKey, ResourceOccurrence } from '@inventarch/workspace-runtime/resource-format';

/** Supplied only by the trusted host's reviewed task resolver, never by a remote request. */
export interface TaskContextDeclaration {
  readonly format: 'ia.task-context-declaration.v1';
  readonly task: ResourceOccurrence;
  readonly basis: ResourceOccurrence;
  readonly coordinate: Coordinate;
  readonly affectedSources: readonly { readonly source: string; readonly path: string }[];
  readonly authoring: readonly AuthoringTargetRequest[];
  readonly requiredResources: readonly ResourceKey[];
}
/** Closed decoding is not an authority check. The owning host selects the current approved declaration. */
export function taskContextDeclaration(value: unknown): TaskContextDeclaration {
  const row = object(value, [
    'format',
    'task',
    'basis',
    'coordinate',
    'affectedSources',
    'authoring',
    'requiredResources',
  ]);
  if (row['format'] !== 'ia.task-context-declaration.v1') throw new Error('Unsupported task context declaration');
  const coordinateInput = row['coordinate'];
  if (!coordinateInput || typeof coordinateInput !== 'object' || Array.isArray(coordinateInput))
    throw new Error('Invalid task context coordinate');
  object(coordinateInput, Object.keys(coordinateInput));
  const coordinate = validateCoordinate(coordinateInput as Readonly<Record<string, unknown>>);
  const affectedSources = unique(
    list(row['affectedSources'], 5000).map((value) => {
      const item = object(value, ['source', 'path']),
        source = text(item['source'], 64);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(source)) throw new Error('Invalid affected source identity');
      return { source, path: portablePath(item['path']) };
    }),
    (v) => v.source + ':' + v.path,
  );
  const authoring = unique(list(row['authoring'], 2000).map(authoringRequest), (v) => JSON.stringify(v));
  if (!authoring.length) throw new Error('Explicit complete authoring coverage is required');
  const declaration: TaskContextDeclaration = {
    format: row['format'],
    task: occurrence(row['task']),
    basis: occurrence(row['basis']),
    coordinate,
    affectedSources,
    authoring,
    requiredResources: unique(list(row['requiredResources'], 2000).map(resourceKey), keyOf),
  };
  if (occurrenceOf(declaration.task) === occurrenceOf(declaration.basis))
    throw new Error('Task and made decision basis must be distinct occurrences');
  return frozen(declaration);
}
