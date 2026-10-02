import { digest } from '@ia/session-system';
import { captureWorkspace, installed } from '../src/index.js';
import { exampleCatalog } from '../../../../../tools/native/public-language.js';

export function executionCatalog(model: string, implementationDigest: string) {
  const catalog = exampleCatalog();
  const host = catalog.hosts['example-host']!.value;
  catalog.hosts['example-host'] = installed({ ...host, limits: { ...host.limits, tokens: 400000 } });
  catalog.models['example-model'] = installed({ model });
  catalog.validators['example-read-input'] = installed({
    schema: {
      type: 'object',
      properties: { operation: { type: 'string' } },
      required: ['operation'],
      additionalProperties: false,
    },
  });
  catalog.validators['example-read-output'] = installed({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        revision: { type: 'string' },
        citations: { type: 'array', items: { type: 'string' } },
      },
      required: ['text', 'revision', 'citations'],
      additionalProperties: false,
    },
  });
  catalog.operations['corpus-inspect-v1'] = installed({
    identity: 'authoring-system/binding/operation/example-read',
    owner: 'agent-composition-system',
    handler: 'ia.corpus.inspect.v1',
    implementationDigest,
    input: 'example-read-input',
    output: 'example-read-output',
    effects: ['read'],
    recovery: 'repeatable',
    timeoutMs: 10000,
    maxOutputBytes: 65536,
    preflight: 'captured-workspace',
  });
  return catalog;
}

export function executionFixture(root: string) {
  const { revision: _revision, ...body } = captureWorkspace(root);
  const sources = body.sources.map((source) =>
    source.path.endsWith('/records/composition.ia')
      ? {
          ...source,
          text: source.text
            .replace('operations []', 'operations [@operation example-read]')
            .replace(
              'bindings [@execution-binding example-entry]',
              'bindings [@execution-binding example-entry, @execution-binding example-read-binding]',
            ),
        }
      : source,
  );
  const owner = sources.find((source) => source.path === '.ia/src/systems/agent-composition-system/system.ia')!;
  sources.push({
    ...owner,
    path: '.ia/src/systems/agent-composition-system/records/example-read.ia',
    text: '#! ia 1.0\n\n@operation example-read\n  meaning\n    says "Read the selected fixture source."\n    answers "Which fixture operation is selected?"\n  execution\n    handler corpus-inspect-v1\n    effects read-only\n    input example-read-input\n    output example-read-output\n    profile governed-v1\n    recovery repeatable\n\n@execution-binding example-read-binding\n  meaning\n    says "Bind the fixture read adapter."\n    answers "Which adapter receives the fixture request?"\n  binding\n    kind operation\n    target @operation example-read\n    implementation corpus-inspect-v1\n',
  });
  const next = { ...body, sources };
  return { ...next, revision: digest(next) };
}
