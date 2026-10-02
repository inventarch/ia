import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digest } from '@ia/session-system';
import { captureWorkspace, installed } from '../src/index.js';
import type { Capture, CompositionCatalog } from '../src/index.js';
import type { OperationContract } from '../src/catalog.js';
import { draftToolCatalog } from '../src/tools.js';
import type { TemplateToolSelection } from '../src/tools.js';

export function compilerCapture(root: string): Capture {
  const { revision: _revision, ...body } = captureWorkspace(root);
  const origin = body.sources.find((source) => source.path === '.ia/src/systems/agent-composition-system/system.ia')!;
  const paths = [
    '.ia/src/systems/agent-composition-system/records/native-sample.ia',
    '.ia/src/systems/agent-composition-system/records/sample-author-profile.ia',
    '.ia/src/systems/agent-composition-system/records/sample-architect-profile.ia',
    '.ia/src/systems/agent-composition-system/records/sample-author.ia',
    '.ia/src/systems/agent-composition-system/records/sample-architect.ia',
    '.ia/src/systems/agent-composition-system/records/sample-voice.ia',
    '.ia/src/systems/agent-composition-system/records/fixture-readion.ia',
    '.ia/src/systems/agent-composition-system/records/secondary-read.ia',
    '.ia/src/systems/agent-composition-system/records/sample-cells.ia',
    '.ia/src/systems/agent-composition-system/records/sample-task.ia',
    '.ia/src/systems/agent-composition-system/records/sample-workspace.ia',
    '.ia/src/systems/agent-composition-system/records/sample-entry.ia',
    '.ia/src/systems/agent-composition-system/records/architect-entry.ia',
    '.ia/src/systems/agent-composition-system/records/sample-read-binding.ia',
    '.ia/src/systems/agent-composition-system/records/fixture-secondary-read-binding.ia',
    '.ia/src/systems/agent-composition-system/records/native-draft-tools.ia',
    '.ia/src/systems/agent-composition-system/records/native-template-tools.ia',
    '.ia/src/systems/agent-composition-system/records/draft-tools-profile.ia',
    '.ia/src/systems/agent-composition-system/records/template-tools-profile.ia',
    '.ia/src/systems/agent-composition-system/records/draft-tools-capability.ia',
    '.ia/src/systems/agent-composition-system/records/template-tools-capability.ia',
    '.ia/src/systems/agent-composition-system/records/validate-draft-binding.ia',
    '.ia/src/systems/agent-composition-system/records/format-draft-binding.ia',
    '.ia/src/systems/agent-composition-system/records/render-captured-template-binding.ia',
    '.ia/src/systems/agent-composition-system/records/draft-tools-entry.ia',
    '.ia/src/systems/agent-composition-system/records/template-tools-entry.ia',
    '.ia/src/systems/agent-composition-system/records/prepare-native-drafts.ia',
    '.ia/src/systems/agent-composition-system/operations/sample-read.ia',
    '.ia/src/systems/agent-composition-system/operations/fixture-secondary-read.ia',
    '.ia/src/systems/compliance-system/checks/instance-schema-check.ia',
    '.ia/src/systems/authoring-system/operations/validate-draft.ia',
    '.ia/src/systems/authoring-system/operations/format-draft.ia',
    '.ia/src/systems/template-system/operations/render-captured-template.ia',
  ];
  const next = {
    ...body,
    sources: [
      ...body.sources,
      ...paths.map((path) => ({
        ...origin,
        path,
        text: readFileSync(resolve(root, 'examples/conformance/composition', path), 'utf8'),
      })),
    ],
  };
  return { ...next, revision: digest(next) };
}
export function compilerCatalog(model: string, implementationDigest: string): CompositionCatalog {
  const readOperation = (identity: string, owner: string, handler: string, input: string, output: string) =>
    installed<OperationContract>({
      identity,
      owner,
      handler,
      implementationDigest,
      input,
      output,
      effects: ['read'],
      recovery: 'repeatable',
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      preflight: 'captured-workspace',
    });
  return {
    hosts: {
      'captured-sample-v1': installed({
        effects: ['read'],
        models: ['host-model'],
        limits: {
          steps: 32,
          modelCalls: 16,
          operations: 16,
          tokens: 500000,
          children: 4,
          depth: 2,
          bytes: 33554432,
          durationMs: 3600000,
        },
        defaults: {
          model: 'host-model',
          input: 'task-text-v1',
          outcomes: 'sample-outcomes-v1',
          context: 'captured-context-v1',
          mapping: 'identity-v1',
        },
      }),
    },
    models: { 'host-model': installed({ model }) },
    validators: Object.fromEntries(
      [
        'task-text-v1',
        'corpus-input-v1',
        'corpus-output-v1',
        'fixture-secondary-input-v1',
        'fixture-secondary-output-v1',
      ].map((key) => [key, installed({ schema: { type: 'string', maxLength: 16384 } })]),
    ),
    outcomes: {
      'sample-outcomes-v1': installed({ kinds: ['answer', 'proposal'], completion: 'response' }),
      'secondary-read-outcomes-v1': installed({ kinds: ['answer', 'proposal'], completion: 'response' }),
    },
    mandates: {
      'sample-task-v1': installed({
        input: 'task-text-v1',
        outcomes: 'sample-outcomes-v1',
        effects: ['read'],
        context: 'captured-context-v1',
        limits: {},
        checks: [],
      }),
    },
    contexts: {
      'captured-context-v1': installed({
        scope: 'captured-workspace',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'capability' },
        tokens: 32768,
        records: 100,
      }),
    },
    operations: {
      'fixture-read-v1': readOperation(
        'authoring-system/binding/operation/sample-read',
        'agent-composition-system',
        'ia.corpus.inspect.v1',
        'corpus-input-v1',
        'corpus-output-v1',
      ),
      'fixture-secondary-v1': readOperation(
        'authoring-system/binding/operation/fixture-secondary-read',
        'agent-composition-system',
        'fixture.secondary.v1',
        'fixture-secondary-input-v1',
        'fixture-secondary-output-v1',
      ),
    },
    evaluators: {},
    entries: { 'harness-entry-v1': installed({ target: 'agent-profile', mapping: 'identity-v1' }) },
    mappings: { 'identity-v1': installed({ kind: 'identity' }) },
  };
}
export function compilerToolCatalog(
  model: string,
  implementationDigest: string,
  resources?: TemplateToolSelection,
): CompositionCatalog {
  const base = compilerCatalog(model, implementationDigest),
    tools = draftToolCatalog(model, implementationDigest, resources);
  return {
    ...base,
    validators: { ...base.validators, ...tools.validators },
    operations: { ...base.operations, ...tools.operations },
  };
}
