import type { OperationContext } from '@inventarch/agent-system';
import { metadataDigest } from '../src/resource-format.js';

export function adapterFixture() {
  const body = {
    format: 'ia.installed-adapter.v1',
    id: 'retained',
    version: '1.0.0',
    implementation: {
      kind: 'local',
      inventoryDigest: metadataDigest('installed-code'),
      entrypoint: 'retained-store',
      transport: 'process',
      runtime: 'node-24',
      platforms: ['linux', 'win32'],
      abi: 'ia.operation.v1',
    },
    operations: [
      {
        id: 'retained-ingest',
        handler: 'retained-ingest-v1',
        digest: metadataDigest('native-operation'),
        effects: ['local-write'],
        recovery: 'idempotent',
        timeoutMs: 50,
        input: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { receipt: { type: 'string' } },
          required: ['receipt'],
          additionalProperties: false,
        },
        maxOutputBytes: 2048,
      },
    ],
    effects: [
      {
        id: 'store-write',
        kind: 'retained-store',
        targetPolicy: 'owned-store',
        enforcement: 'adapter',
        credentials: [],
        telemetry: 'store-metrics',
      },
    ],
    limits: { durationMs: 100, inputBytes: 2048, outputBytes: 2048, concurrency: 1 },
    recovery: { id: 'retained-receipt-v1', contractDigest: metadataDigest('receipt-contract') },
  };
  const adapter = { ...body, digest: metadataDigest(body) };
  const bindingBody = {
    format: 'ia.retained-store.v1',
    owner: 'owner-a',
    storeId: 'notes',
    rootBinding: 'configured-store-root',
    schemaVersion: 1,
    accessPolicy: 'owner-members',
    retention: { days: 30, deletion: 'explicit' },
    quotas: { entries: 1000, entryBytes: 1024, totalBytes: 1024 * 1024, indexBatch: 100 },
    adapterDigest: adapter.digest,
  };
  const binding = { ...bindingBody, digest: metadataDigest(bindingBody) };
  const context: OperationContext = {
    sessionId: 'session',
    runId: 'run',
    invocationId: 'invocation',
    attemptId: 'attempt',
    principal: 'alice',
    manifest: {
      version: 1,
      id: 'manifest',
      digest: metadataDigest('manifest'),
      workspace: 'workspace',
      sourceDigest: metadataDigest('source'),
      profiles: {},
      operations: {},
      reactions: [],
      provenance: {},
    },
    grant: {
      id: 'grant',
      principal: 'alice',
      workspace: 'workspace',
      expiresAt: Date.now() + 60_000,
      profiles: [],
      operations: ['retained-ingest'],
      effects: ['local-write'],
      sources: [],
      models: [],
      limits: {
        steps: 1,
        modelCalls: 0,
        operations: 1,
        tokens: 0,
        children: 0,
        depth: 0,
        bytes: 2048,
        deadline: Date.now() + 60_000,
      },
    },
    signal: new AbortController().signal,
  };
  return { adapter, binding, context, catalog: { adapters: { retained: adapter }, containments: [] } };
}
