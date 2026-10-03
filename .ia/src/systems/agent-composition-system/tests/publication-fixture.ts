import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '@inventarch/runtime';
import { Engine, manifestDigest } from '@inventarch/agent-system';
import type { EngineHost, Grant, Manifest, ModelAction } from '@inventarch/agent-system';
import { digest } from '@inventarch/session-system';
import { sqliteStore } from '@inventarch/session-system/sqlite';
import type { Json } from '@inventarch/session-system';
import type { CandidateEnvelope, CandidateScope } from '@inventarch/runtime';
import { candidateValidation, managedPublication } from '../src/index.js';
import type { Capture } from '../src/index.js';

export const destination = '.ia/work/generated/reviewed-draft';
export interface Configuration {
  capture: Capture;
  candidate: CandidateEnvelope;
  scope: CandidateScope;
  grant: Grant;
  timeoutMs: number;
}
export type Boundary =
  | 'before-prepare'
  | 'prepared'
  | 'dispatched'
  | 'staged'
  | 'published'
  | 'observed'
  | 'reconciling';
export function fixture(root: string, config: Configuration, pause?: (boundary: Boundary) => Promise<void>) {
  const store = sqliteStore(resolve(root, 'sessions')),
    implementation = digest('p3-fixture-v1');
  const validation = candidateValidation(config.capture, config.scope, implementation),
    publication = managedPublication(root, destination, implementation);
  publication.definition.timeoutMs = config.timeoutMs;
  const body: Omit<Manifest, 'digest'> = {
    version: 1,
    id: 'publication-test',
    workspace: 'test',
    sourceDigest: config.capture.revision,
    reactions: [],
    provenance: {},
    operations: {
      [validation.definition.id]: validation.definition,
      [publication.definition.id]: publication.definition,
    },
    profiles: {
      author: {
        id: 'author',
        agent: 'author-agent',
        role: 'author',
        voice: '',
        instructions: [],
        operations: [validation.definition.id, publication.definition.id],
        capabilities: [],
        delegates: [],
        outcomes: ['proposal', 'deliverable'],
        completion: 'artifact',
        checks: [],
        model: 'test',
        contract: {
          id: 'test-v1',
          mandateContracts: ['test'],
          inputContracts: [{ id: 'text', schema: { type: 'string' } }],
          effects: ['read', 'local-write'],
          limits: {},
          delegation: [],
          checks: [],
          completionEvaluator: 'ia.completion.v1',
          repairAttempts: 1,
          maxAttempts: 2,
        },
      },
    },
  };
  const manifest = { ...body, digest: manifestDigest(body) };
  const command = store.command.bind(store);
  if (pause)
    store.command = async (request, owner) => {
      const m = request.mutation,
        preparation = m.type === 'attempt.prepare' && m.attempt.target === publication.definition.id;
      const effect =
        (m.type === 'attempt.observe' || m.type === 'attempt.dispatch' || m.type === 'attempt.reconcile.start') &&
        (await store.read('s')).attempts[m.attemptId]?.target === publication.definition.id;
      if (preparation) await pause('before-prepare');
      if (effect && m.type === 'attempt.observe') await pause('published');
      const result = await command(request, owner);
      if (preparation) await pause('prepared');
      if (effect && m.type === 'attempt.dispatch') await pause('dispatched');
      if (effect && m.type === 'attempt.observe') await pause('observed');
      if (effect && m.type === 'attempt.reconcile.start') await pause('reconciling');
      return result;
    };
  const input = { candidate: config.candidate as unknown as Json, destination };
  const host: EngineHost = {
    store,
    authorize: async () => config.grant,
    verifyManifest: async () => true,
    context: async () => null,
    evaluate: async () => ({ status: 'pass', evidence: [], message: 'pass' }),
    preflight: async () => {
      const parent = resolve(root, '.ia/work/generated');
      if (pause && existsSync(parent) && readdirSync(parent).some((name) => name.startsWith('.stage-')))
        await pause('staged');
      return true;
    },
    operations: { [validation.adapter.id]: validation.adapter, [publication.adapter.id]: publication.adapter },
    model: {
      id: 'scripted',
      generate: async () => {
        const state = await store.read('s'),
          verified = state.receipts.find((r) => r.target === validation.definition.id),
          proposal = Object.values(state.proposals)[0],
          receipt = [...state.receipts]
            .reverse()
            .find((r) => r.target === publication.definition.id && r.effect === 'applied' && r.error === null);
        let action: ModelAction;
        if (receipt)
          action = {
            type: 'outcome',
            kind: 'deliverable',
            message: 'Published exact draft',
            continuation: 'finish',
            artifacts: [receipt.id],
          };
        else if (proposal?.status === 'accepted')
          action = {
            type: 'invoke',
            operation: publication.definition.id,
            input,
            review: {
              proposalId: proposal.id,
              revision: proposal.revision,
              digest: proposal.digest,
              decisionId: proposal.decisionId!,
            },
          };
        else if (verified)
          action = {
            type: 'outcome',
            kind: 'proposal',
            message: 'Review draft',
            continuation: 'await-review',
            proposal: config.candidate as unknown as Json,
            review: { operation: publication.definition.id, input, validationReceipt: verified.id },
          };
        else
          action = { type: 'invoke', operation: validation.definition.id, input: config.candidate as unknown as Json };
        return { action, model: 'test', provider: 'test', usage: 10 };
      },
    },
  };
  return { store, manifest, host, publication, engine: () => new Engine(manifest, host) };
}
// The child pauses with a live session owner at an actual persisted/effect boundary.
if (isEntry(process.argv[1], import.meta.url)) {
  const root = process.argv[2]!,
    boundary = process.argv[3]!;
  const config = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8')) as Configuration;
  const f = fixture(root, config, async (at) => {
    if (at !== boundary) return;
    process.send?.(at);
    await new Promise<void>(() => {
      setInterval(() => {}, 1000);
    });
  });
  try {
    await f.engine().advance('s', 'alice');
    throw new Error('Did not reach crash boundary');
  } finally {
    await f.store.close();
  }
}
