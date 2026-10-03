import { canonical, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import type { ModelAction, OutcomeKind } from './types.js';

export class EngineError extends SessionError {}
export function check(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new EngineError(code, message);
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32_768;
export const outcomes: OutcomeKind[] = [
  'answer',
  'deliverable',
  'clarification',
  'proposal',
  'follow-up',
  'handoff',
  'blocked',
  'refusal',
  'failure',
];
/** Closed action envelope. Descriptive model prose never supplies authority. */
export function parseAction(value: unknown): ModelAction {
  check(
    Buffer.byteLength(canonical(value)) <= 65_536 && object(value),
    'IA-ENGINE-ACTION-INVALID',
    'Action must be a bounded JSON object',
  );
  const fields: Record<string, string[]> = {
    continue: ['type', 'message'],
    invoke: ['type', 'operation', 'input', 'review'],
    delegate: ['type', 'profile', 'task'],
    outcome: [
      'type',
      'kind',
      'message',
      'continuation',
      'questions',
      'proposal',
      'artifacts',
      'evidence',
      'followUps',
      'review',
    ],
  };
  check(
    typeof value['type'] === 'string' && Object.hasOwn(fields, value['type']),
    'IA-ENGINE-ACTION-INVALID',
    'Unknown action type',
  );
  check(
    Object.keys(value).every((k) => fields[value['type'] as string]!.includes(k)),
    'IA-ENGINE-ACTION-INVALID',
    'Unknown action field',
  );
  const type = value['type'];
  if (type === 'continue') check(text(value['message']), 'IA-ENGINE-ACTION-INVALID', 'Missing continuation message');
  if (type === 'invoke')
    check(
      text(value['operation']) && Object.hasOwn(value, 'input'),
      'IA-ENGINE-ACTION-INVALID',
      'Missing operation/input',
    );
  if (type === 'delegate')
    check(text(value['profile']) && Object.hasOwn(value, 'task'), 'IA-ENGINE-ACTION-INVALID', 'Missing delegate/task');
  if (value['review'] !== undefined) {
    const review = value['review'];
    check(object(review), 'IA-ENGINE-ACTION-INVALID', 'Invalid review reference');
    if (type === 'invoke')
      check(
        Object.keys(review).every((k) => ['proposalId', 'revision', 'digest', 'decisionId'].includes(k)) &&
          text(review['proposalId']) &&
          Number.isSafeInteger(review['revision']) &&
          (review['revision'] as number) > 0 &&
          text(review['digest']) &&
          text(review['decisionId']),
        'IA-ENGINE-ACTION-INVALID',
        'Invalid exact review reference',
      );
    else
      check(
        type === 'outcome' &&
          Object.keys(review).every((k) => ['operation', 'input', 'validationReceipt'].includes(k)) &&
          text(review['operation']) &&
          Object.hasOwn(review, 'input') &&
          text(review['validationReceipt']),
        'IA-ENGINE-ACTION-INVALID',
        'Invalid effect review request',
      );
  }
  if (type === 'outcome') {
    check(
      outcomes.includes(value['kind'] as OutcomeKind) &&
        text(value['message']) &&
        ['finish', 'continue', 'await-input', 'await-review', 'await-dependency', 'fail'].includes(
          value['continuation'] as string,
        ),
      'IA-ENGINE-ACTION-INVALID',
      'Invalid outcome',
    );
    if (value['questions'] !== undefined)
      check(
        Array.isArray(value['questions']) &&
          value['questions'].length <= 8 &&
          value['questions'].every(
            (q: unknown) =>
              object(q) &&
              Object.keys(q).every((k) => ['prompt', 'required', 'choices'].includes(k)) &&
              text(q['prompt']) &&
              typeof q['required'] === 'boolean' &&
              Array.isArray(q['choices']) &&
              q['choices'].length <= 12 &&
              q['choices'].every(text),
          ),
        'IA-ENGINE-ACTION-INVALID',
        'Invalid questions',
      );
    for (const field of ['artifacts', 'evidence', 'followUps'])
      if (value[field] !== undefined)
        check(
          Array.isArray(value[field]) && value[field].length <= 32 && value[field].every(text),
          'IA-ENGINE-ACTION-INVALID',
          `Invalid ${field}`,
        );
    if (value['continuation'] === 'await-input')
      check(
        Array.isArray(value['questions']) && value['questions'].some((q: { required: boolean }) => q.required),
        'IA-ENGINE-ACTION-INVALID',
        'Input wait requires a required question',
      );
    if (value['continuation'] === 'await-review' || value['kind'] === 'proposal')
      check(Object.hasOwn(value, 'proposal'), 'IA-ENGINE-ACTION-INVALID', 'Review/proposal requires a candidate');
    if (value['kind'] === 'failure')
      check(value['continuation'] === 'fail', 'IA-ENGINE-ACTION-INVALID', 'Failure cannot complete successfully');
  }
  return JSON.parse(canonical(value)) as ModelAction;
}
/** Small, fail-closed installed schema vocabulary; unsupported JSON Schema is refused. */
export function validateShape(schema: Json, value: Json): boolean {
  if (
    !object(schema) ||
    Object.keys(schema).some(
      (k) =>
        ![
          'type',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'enum',
          'maxLength',
          'maxItems',
          'minimum',
          'maximum',
        ].includes(k),
    )
  )
    return false;
  if (
    schema['enum'] !== undefined &&
    (!Array.isArray(schema['enum']) || !schema['enum'].some((v) => canonical(v) === canonical(value)))
  )
    return false;
  switch (schema['type']) {
    case 'object': {
      if (
        !object(value) ||
        !object(schema['properties']) ||
        schema['additionalProperties'] !== false ||
        !Array.isArray(schema['required'])
      )
        return false;
      const properties = schema['properties'] as Record<string, Json>;
      return (
        schema['required'].every((key) => typeof key === 'string' && Object.hasOwn(value, key)) &&
        Object.keys(value).every(
          (key) => Object.hasOwn(properties, key) && validateShape(properties[key]!, value[key] as Json),
        )
      );
    }
    case 'string':
      return (
        typeof value === 'string' &&
        (schema['maxLength'] === undefined ||
          (typeof schema['maxLength'] === 'number' && value.length <= schema['maxLength']))
      );
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema['type'] !== 'integer' || Number.isSafeInteger(value)) &&
        (schema['minimum'] === undefined || (typeof schema['minimum'] === 'number' && value >= schema['minimum'])) &&
        (schema['maximum'] === undefined || (typeof schema['maximum'] === 'number' && value <= schema['maximum']))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return (
        Array.isArray(value) &&
        schema['items'] !== undefined &&
        (schema['maxItems'] === undefined ||
          (typeof schema['maxItems'] === 'number' && value.length <= schema['maxItems'])) &&
        value.every((v) => validateShape(schema['items'] as Json, v))
      );
    default:
      return false;
  }
}
