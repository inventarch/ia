import { validateShape } from '@inventarch/agent-system';
import type { Json } from '@inventarch/session-system';

/** Decidable conjunction for the installed closed schema vocabulary (after schema validation).
 * Optional properties may be omitted; arrays always admit the empty array unless an enum forbids it. */
export function compatibleInputs(schemas: Json[]): boolean {
  const objects = schemas as Record<string, Json>[];
  const enumeration = objects.find((s) => Array.isArray(s['enum']))?.['enum'];
  if (Array.isArray(enumeration))
    return enumeration.some((candidate) => schemas.every((s) => validateShape(s, candidate)));
  const types = new Set(objects.map((s) => s['type']));
  if (types.size > 1 && ![...types].every((t) => t === 'number' || t === 'integer')) return false;
  if (types.has('number') || types.has('integer')) {
    let min = Math.max(
      -Number.MAX_VALUE,
      ...objects.map((s) => (typeof s['minimum'] === 'number' ? s['minimum'] : -Number.MAX_VALUE)),
    );
    let max = Math.min(
      Number.MAX_VALUE,
      ...objects.map((s) => (typeof s['maximum'] === 'number' ? s['maximum'] : Number.MAX_VALUE)),
    );
    if (types.has('integer')) {
      min = Math.max(-Number.MAX_SAFE_INTEGER, Math.ceil(min));
      max = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(max));
    }
    return min <= max;
  }
  if (types.has('object')) {
    const required = new Set(objects.flatMap((s) => s['required'] as string[]));
    return [...required].every(
      (key) =>
        objects.every((s) => Object.hasOwn(s['properties'] as object, key)) &&
        compatibleInputs(objects.map((s) => (s['properties'] as Record<string, Json>)[key]!)),
    );
  }
  return true;
}
