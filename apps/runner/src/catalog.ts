import { installed, installedReadAliases, installedReadCatalog } from '@inventarch/agent-composition-system';
import type { CatalogAliases, CompositionCatalog } from '@inventarch/agent-composition-system';
import { WRITE_PLAIN_NAMES } from './written-names.js';

/** Each name the runner contracts shipped under before names stopped carrying their version, with its plain name. */
const RENAMED = {
  hosts: { 'runner-local-v1': 'runner-local' },
  models: { 'runner-external-v1': 'runner-external' },
  validators: { 'runner-task-v1': 'runner-task' },
  outcomes: { 'runner-outcomes-v1': 'runner-outcomes' },
  mandates: { 'runner-read-v1': 'runner-read' },
  contexts: { 'runner-context-v1': 'runner-context' },
  entries: { 'runner-entry-v1': 'runner-entry' },
  mappings: { 'runner-identity-v1': 'runner-identity' },
} as const;

/**
 * Old runner and read names mapped to the plain names that replace them. The runner passes this to `compileHarness`, so
 * records that still name an old contract compile to the plain entry.
 */
export function runnerAliases(): CatalogAliases {
  // Until `WRITE_PLAIN_NAMES` is flipped a record that names an original contract compiles to the original entry.
  if (!WRITE_PLAIN_NAMES) return {};
  const read = installedReadAliases();
  return {
    ...RENAMED,
    operations: { ...read.operations },
    validators: { ...read.validators, ...RENAMED.validators },
  };
}

/**
 * Installed local host contracts. Source records may select these keys, never code or credentials. Each contract is
 * installed under its plain name and, unchanged, under the name it shipped with, so harnesses already pinned to the
 * original still pass `executionManifest`.
 */
export function runnerCatalog(): CompositionCatalog {
  const read = installedReadCatalog();
  const limits = {
    steps: 64,
    modelCalls: 16,
    operations: 16,
    tokens: 200000,
    children: 0,
    depth: 0,
    bytes: 8000000,
    durationMs: 3600000,
  };
  /** The runner contracts under one generation of names: the plain ones, or the originals. */
  const named = (n: {
    local: string;
    external: string;
    task: string;
    outcomes: string;
    read: string;
    context: string;
    entry: string;
    identity: string;
  }) => ({
    hosts: {
      [n.local]: installed({
        effects: ['read' as const],
        models: [n.external],
        limits,
        defaults: {
          model: n.external,
          input: n.task,
          outcomes: n.outcomes,
          context: n.context,
          mapping: n.identity,
        },
      }),
    },
    models: { [n.external]: installed({ model: 'runner/external' }) },
    validators: { [n.task]: installed({ schema: { type: 'string', maxLength: 8192 } }) },
    outcomes: {
      [n.outcomes]: installed({
        kinds: ['answer' as const, 'refusal' as const, 'failure' as const, 'blocked' as const],
        completion: 'response' as const,
      }),
    },
    mandates: {
      [n.read]: installed({
        input: n.task,
        outcomes: n.outcomes,
        effects: ['read' as const],
        context: n.context,
        limits: {},
        checks: [],
      }),
    },
    contexts: {
      [n.context]: installed({
        scope: 'captured-workspace' as const,
        coordinate: { phase: 'act' as const, primitive: 'Decision' as const, category: 'capability' as const },
        tokens: 4000,
        records: 12,
      }),
    },
    entries: { [n.entry]: installed({ target: 'agent-profile' as const, mapping: n.identity }) },
    mappings: { [n.identity]: installed({ kind: 'identity' as const }) },
  });
  const plain = named({
    local: 'runner-local',
    external: 'runner-external',
    task: 'runner-task',
    outcomes: 'runner-outcomes',
    read: 'runner-read',
    context: 'runner-context',
    entry: 'runner-entry',
    identity: 'runner-identity',
  });
  const original = named({
    local: 'runner-local-v1',
    external: 'runner-external-v1',
    task: 'runner-task-v1',
    outcomes: 'runner-outcomes-v1',
    read: 'runner-read-v1',
    context: 'runner-context-v1',
    entry: 'runner-entry-v1',
    identity: 'runner-identity-v1',
  });
  return {
    hosts: { ...plain.hosts, ...original.hosts },
    models: { ...plain.models, ...original.models },
    validators: { ...read.validators, ...plain.validators, ...original.validators },
    outcomes: { ...plain.outcomes, ...original.outcomes },
    mandates: { ...plain.mandates, ...original.mandates },
    contexts: { ...plain.contexts, ...original.contexts },
    operations: read.operations,
    evaluators: {},
    entries: { ...plain.entries, ...original.entries },
    mappings: { ...plain.mappings, ...original.mappings },
  };
}
