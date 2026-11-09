import { PHASES, PRIMITIVES } from '@inventarch/language';
import type { Phase, Primitive } from '@inventarch/language';
import { digest } from '@inventarch/session-system';
import { hash, object, text } from './resource-format.js';
import { peekStamp, stampKeys } from './plain-format.js';

export const TASK_CAPTURE_BYTES = 700 * 1024;
/** This policy selects by declared native relations, never by an inferred prose similarity. */
export const TASK_CAPTURE_POLICY = digest({
  version: 2,
  declaration: 'trusted-reviewed-task',
  closure: 'declared-subjects-applicable-governance-directed-dependencies',
  files: 'whole-with-resolution',
  teaching: 'required-authoring-closure',
  incomplete: 'refuse',
});
const LEGACY_TASK_CAPTURE_POLICY = digest({
  version: 1,
  closure: 'all-policy-and-connected-work',
  files: 'whole',
  teaching: 'all-explicit-resources',
  incomplete: 'refuse',
});
export interface TaskCaptureRequest {
  readonly target: string;
  readonly phase: Phase;
  readonly primitive: Primitive;
}
export interface TaskCaptureSelection {
  readonly format: 'task-capture-selection' | 'ia.task-capture-selection.v1';
  readonly formatVersion?: 1;
  readonly request: TaskCaptureRequest;
  readonly policy: string;
  readonly implementation: string;
  readonly fullRevision: string;
  readonly resources: string;
  readonly index: string;
  readonly declaration?: string;
  readonly teaching: string;
  readonly proof: string;
}
export function taskCaptureRequest(value: unknown): TaskCaptureRequest {
  const row = object(value, ['target', 'phase', 'primitive']);
  const target = text(row['target']),
    phase = text(row['phase']),
    primitive = text(row['primitive']);
  if (
    !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(target) ||
    !PHASES.includes(phase as Phase) ||
    !PRIMITIVES.includes(primitive as Primitive)
  )
    throw new Error('Invalid task capture target or coordinate');
  return { target, phase: phase as Phase, primitive: primitive as Primitive };
}
/** Shape and pin validation only. Completeness requires recomputation against a trusted full view. */
export function taskCaptureSelection(value: unknown): TaskCaptureSelection {
  const legacy =
    value !== null &&
    typeof value === 'object' &&
    Object.getOwnPropertyDescriptor(value, 'policy')?.value === LEGACY_TASK_CAPTURE_POLICY;
  const stamp = peekStamp(value, 'task-capture-selection', ['ia.task-capture-selection.v1']);
  const row = object(value, [
    ...stampKeys(stamp),
    'request',
    'policy',
    'implementation',
    'fullRevision',
    'resources',
    'index',
    ...(!legacy ? ['declaration'] : []),
    'teaching',
    'proof',
  ]);
  if (stamp === undefined || (row['policy'] !== TASK_CAPTURE_POLICY && !legacy))
    throw new Error('Unsupported task capture policy');
  return {
    ...stamp,
    request: taskCaptureRequest(row['request']),
    policy: hash(row['policy']),
    implementation: hash(row['implementation']),
    fullRevision: hash(row['fullRevision']),
    resources: hash(row['resources']),
    index: hash(row['index']),
    ...(!legacy ? { declaration: hash(row['declaration']) } : {}),
    teaching: hash(row['teaching']),
    proof: hash(row['proof']),
  };
}
