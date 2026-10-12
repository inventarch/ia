import { installed, installedReadCatalog } from '@inventarch/agent-composition-system';
import type { CompositionCatalog } from '@inventarch/agent-composition-system';

/** Installed local host contracts. Source records may select these keys, never code or credentials. */
export function runnerCatalog(): CompositionCatalog {
  const read = installedReadCatalog();
  return {
    ...read,
    validators: { ...read.validators, 'runner-task-v1': installed({ schema: { type: 'string', maxLength: 8192 } }) },
    hosts: {
      'runner-local-v1': installed({
        effects: ['read'],
        models: ['runner-external-v1'],
        limits: {
          steps: 64,
          modelCalls: 16,
          operations: 16,
          tokens: 200000,
          children: 0,
          depth: 0,
          bytes: 8000000,
          durationMs: 3600000,
        },
        defaults: {
          model: 'runner-external-v1',
          input: 'runner-task-v1',
          outcomes: 'runner-outcomes-v1',
          context: 'runner-context-v1',
          mapping: 'runner-identity-v1',
        },
      }),
    },
    models: { 'runner-external-v1': installed({ model: 'runner/external' }) },
    outcomes: {
      'runner-outcomes-v1': installed({ kinds: ['answer', 'refusal', 'failure', 'blocked'], completion: 'response' }),
    },
    mandates: {
      'runner-read-v1': installed({
        input: 'runner-task-v1',
        outcomes: 'runner-outcomes-v1',
        effects: ['read'],
        context: 'runner-context-v1',
        limits: {},
        checks: [],
      }),
    },
    contexts: {
      'runner-context-v1': installed({
        scope: 'captured-workspace',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'capability' },
        tokens: 4000,
        records: 12,
      }),
    },
    operations: read.operations,
    evaluators: {},
    entries: { 'runner-entry-v1': installed({ target: 'agent-profile', mapping: 'runner-identity-v1' }) },
    mappings: { 'runner-identity-v1': installed({ kind: 'identity' }) },
  };
}
