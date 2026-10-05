// Neutral qualification recipe over installed public exports. No producer source imports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureWorkspace,
  compileHarness,
  executionManifest,
  installed,
  installedImplementationDigest,
} from '@inventarch/agent-composition-system';
import { Engine, manifestDigest } from '@inventarch/agent-system';
import { canonical, copy, digest, memoryStore } from '@inventarch/session-system';
import { sqliteStore } from '@inventarch/session-system/sqlite';
import { isEntry } from '@inventarch/runtime/entry';

const recipeRoot = fileURLToPath(new URL('.', import.meta.url));
const operationId = 'authoring-system/binding/operation/sdk-example-read';
const handlerId = 'sdk.example.read.v1';
const modelId = 'example/scripted';
const principal = 'example-operator';
const policyId = 'sdk-example-read-guard-v1';
const fixtureFiles = ['system.ia.fixture', 'records.ia.fixture', 'read.ia.fixture'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function recipeIdentity() {
  return digest(
    ['recipe.mjs', ...fixtureFiles.map((name) => `native/${name}`)].map((path) => ({
      path,
      sha256: sha(readFileSync(resolve(recipeRoot, path))),
    })),
  );
}
export function captureExample(root) {
  const base = captureWorkspace(root);
  assert(!base.folders.includes('sdk-example-system'), 'The fixture must not shadow an existing system');
  const sources = fixtureFiles.map((name) => ({
    path: `.ia/src/systems/sdk-example-system/${name === 'read.ia.fixture' ? 'operations/sdk-example-read.ia' : name.replace('.fixture', '')}`,
    text: readFileSync(resolve(recipeRoot, 'native', name), 'utf8'),
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  }));
  const { revision: _revision, ...body } = base;
  const next = {
    ...body,
    folders: [...body.folders, 'sdk-example-system'].sort(),
    sources: [...body.sources, ...sources].sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };
  return { ...next, revision: digest(next) };
}
function catalogFor(implementationDigest) {
  const limits = {
    steps: 40,
    modelCalls: 12,
    operations: 6,
    tokens: 800000,
    children: 2,
    depth: 1,
    bytes: 16000000,
    durationMs: 600000,
  };
  return {
    hosts: {
      'sdk-example-host-v1': installed({
        effects: ['read'],
        models: ['sdk-example-model-v1'],
        limits,
        defaults: {
          model: 'sdk-example-model-v1',
          input: 'sdk-example-task-v1',
          outcomes: 'sdk-example-outcomes-v1',
          context: 'sdk-example-context-v1',
          mapping: 'sdk-example-identity-v1',
        },
      }),
    },
    models: { 'sdk-example-model-v1': installed({ model: modelId }) },
    validators: { 'sdk-example-task-v1': installed({ schema: { type: 'string', maxLength: 1024 } }) },
    outcomes: {
      'sdk-example-outcomes-v1': installed({ kinds: ['answer', 'clarification', 'failure'], completion: 'response' }),
    },
    mandates: {
      'sdk-example-mandate-v1': installed({
        input: 'sdk-example-task-v1',
        outcomes: 'sdk-example-outcomes-v1',
        effects: ['read'],
        context: 'sdk-example-context-v1',
        limits: {},
        checks: [policyId],
      }),
    },
    contexts: {
      'sdk-example-context-v1': installed({
        scope: 'captured-workspace',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'capability' },
        tokens: 32768,
        records: 100,
      }),
    },
    operations: {
      'sdk-example-read-v1': installed({
        identity: operationId,
        owner: 'sdk-example-system',
        handler: handlerId,
        implementationDigest,
        input: 'sdk-example-task-v1',
        output: 'sdk-example-task-v1',
        effects: ['read'],
        recovery: 'repeatable',
        timeoutMs: 5000,
        maxOutputBytes: 4096,
        preflight: 'captured-workspace',
      }),
    },
    evaluators: { [policyId]: installed({ phases: ['before-effect'] }) },
    entries: { 'sdk-example-entry-v1': installed({ target: 'agent-profile', mapping: 'sdk-example-identity-v1' }) },
    mappings: { 'sdk-example-identity-v1': installed({ kind: 'identity' }) },
  };
}

// This is an explicitly approved first-party fake host, not a module loader or a grant issuer for an application.
function exampleHost(root, capture, manifest, store, pins, scenario) {
  let revoked = false,
    stale = false,
    deniedCheck = false,
    failedRead = false;
  const counters = { model: 0, reads: 0, evaluators: 0 };
  const grant = {
    id: `example-${scenario}`,
    principal,
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    operations: [operationId],
    effects: ['read'],
    sources: [capture.revision],
    models: [modelId],
    expiresAt: Date.now() + 600000,
    limits: {
      steps: 40,
      modelCalls: 12,
      operations: 6,
      tokens: 800000,
      children: 2,
      depth: 1,
      bytes: 16000000,
      deadline: Date.now() + 600000,
    },
  };
  const answer = { type: 'outcome', kind: 'answer', message: 'The bounded example finished.', continuation: 'finish' };
  const host = {
    store,
    model: {
      id: 'example-scripted-single-attempt-v1',
      generate: async (request, signal) => {
        signal.throwIfAborted();
        counters.model++;
        const previous = request.history.filter((row) => row?.kind === 'action').length;
        const action =
          request.profile.role === 'child'
            ? answer
            : previous === 0
              ? { type: 'invoke', operation: operationId, input: 'public-label' }
              : scenario !== 'orchestration'
                ? answer
                : previous === 1
                  ? { type: 'delegate', profile: request.profile.delegates[0], task: 'Inspect the same bounded label' }
                  : previous === 2
                    ? {
                        type: 'outcome',
                        kind: 'clarification',
                        message: 'One operator input is needed.',
                        continuation: 'await-input',
                        questions: [{ prompt: 'Continue this read-only example?', choices: ['yes'], required: true }],
                      }
                    : answer;
        return { action, usage: 1, provider: 'deterministic-fake', model: modelId };
      },
    },
    operations: {
      [handlerId]: {
        id: handlerId,
        execute: async (input, context) => {
          await context.assertCurrent();
          context.signal.throwIfAborted();
          assert.equal(input, 'public-label');
          assert.equal(context.principal, principal);
          assert(context.grant.sources.includes(capture.revision));
          counters.reads++;
          if (scenario === 'recovery' && !failedRead) {
            failedRead = true;
            throw new Error('A deterministic fake read failure');
          }
          return { output: 'public-label', effect: 'none' };
        },
      },
    },
    authorize: async (actor, requested) => {
      if (actor !== principal || requested.digest !== manifest.digest)
        throw new Error('The example principal or manifest is unavailable');
      return copy({ ...grant, operations: revoked ? [] : grant.operations });
    },
    verifyManifest: async (requested) =>
      !stale &&
      manifestDigest(requested) === requested.digest &&
      digest(requested) === digest(manifest) &&
      captureExample(root).revision === capture.revision &&
      installedImplementationDigest() === pins.code &&
      recipeIdentity() === pins.recipe,
    context: async (_profile, _task, current, budget) => {
      assert(current.sources.includes(capture.revision));
      const result = {
        sourceRevision: capture.revision,
        label: 'public-label',
        authority: 'Host grants are checked separately from this data.',
      };
      assert(Buffer.byteLength(canonical(result)) <= budget.bytes);
      return result;
    },
    evaluate: async (id, input, current) => {
      assert.equal(id, policyId);
      assert.equal(input.phase, 'before-effect');
      counters.evaluators++;
      const allowed =
        !deniedCheck &&
        input.action.operation === operationId &&
        current.operations.includes(operationId) &&
        current.effects.includes('read');
      return {
        status: allowed ? 'pass' : 'fail',
        evidence: [],
        message: 'Only the host-approved example read is allowed.',
      };
    },
    preflight: async (operation, _input, context) =>
      operation.id === operationId &&
      context.principal === principal &&
      context.grant.sources.includes(capture.revision),
  };
  return {
    host,
    counters,
    revoke() {
      revoked = true;
    },
    stale() {
      stale = true;
    },
    denyCheck() {
      deniedCheck = true;
    },
  };
}

export async function qualifySdk({ root, directory, storeProfile }) {
  assert(['memory', 'sqlite'].includes(storeProfile));
  const pins = { code: installedImplementationDigest(), recipe: recipeIdentity() };
  const capture = captureExample(root),
    catalog = catalogFor(digest(pins));
  const result = compileHarness(capture, { harness: 'sdk-example-harness', entry: 'sdk-example-entry', catalog });
  assert.equal(result.ok, true, JSON.stringify(result));
  const compiled = result.manifest,
    manifest = executionManifest(compiled, catalog),
    profile = compiled.entry.profile;
  const changed = copy(catalog);
  changed.operations['sdk-example-read-v1'] = installed({
    ...changed.operations['sdk-example-read-v1'].value,
    timeoutMs: 4999,
  });
  assert.throws(
    () => executionManifest(compiled, changed),
    (error) => error.diagnostic?.code === 'IA-COMPOSITION-UNAVAILABLE',
  );
  const missing = copy(catalog);
  delete missing.evaluators[policyId];
  assert.equal(
    compileHarness(capture, { harness: 'sdk-example-harness', entry: 'sdk-example-entry', catalog: missing }).ok,
    false,
  );
  const store = storeProfile === 'memory' ? memoryStore() : sqliteStore(directory);
  const summaries = [];
  try {
    for (const scenario of ['orchestration', 'recovery', 'revoked-operation', 'stale-manifest', 'denied-evaluator']) {
      const f = exampleHost(root, capture, manifest, store, pins, scenario),
        engine = new Engine(manifest, f.host),
        sessionId = `${storeProfile}-${scenario}`;
      const start = {
        sessionId,
        commandId: `start-${scenario}`,
        principal,
        profile,
        task: 'Run a bounded neutral SDK example',
      };
      await assert.rejects(engine.start({ ...start, sessionId: `invalid-${scenario}`, task: 42 }), {
        code: 'IA-ENGINE-TASK-INVALID',
      });
      await engine.start(start);
      await assert.rejects(engine.advance(sessionId, 'another-principal'), { code: 'IA-ENGINE-AUTHORITY-DENIED' });
      let state;
      if (scenario === 'revoked-operation' || scenario === 'stale-manifest') {
        await engine.advance(sessionId, principal, { maxActions: 3 });
        if (scenario === 'revoked-operation') f.revoke();
        else f.stale();
        await assert.rejects(engine.advance(sessionId, principal), {
          code: scenario === 'revoked-operation' ? 'IA-ENGINE-OPERATION-DENIED' : 'IA-ENGINE-SOURCE-CHANGED',
        });
        state = await store.read(sessionId);
        assert.equal(f.counters.reads, 0);
        assert.equal(state.budget.operations, 0);
      } else if (scenario === 'denied-evaluator') {
        f.denyCheck();
        await assert.rejects(engine.advance(sessionId, principal), { code: 'IA-ENGINE-GOVERNANCE-DENIED' });
        state = await store.read(sessionId);
        assert.equal(f.counters.reads, 0);
      } else {
        state = await engine.advance(sessionId, principal);
        if (scenario === 'orchestration') {
          assert.equal(state.runs.root.wait.reason, 'input');
          const question = Object.values(state.questions).find((row) => row.status === 'open');
          assert(question);
          await assert.rejects(
            engine.reply(sessionId, principal, question.id, question.revision, '0'.repeat(64), 'yes', 'stale-reply'),
            { code: 'IA-SESSION-TRANSITION-INVALID' },
          );
          await engine.reply(
            sessionId,
            principal,
            question.id,
            question.revision,
            question.digest,
            'yes',
            'exact-reply',
          );
          state = await engine.advance(sessionId, principal);
          assert.equal(Object.keys(state.runs).length, 2);
          assert.equal(f.counters.reads, 1);
          assert.equal(f.counters.model, 5);
        } else {
          assert.equal(state.runs.root.wait.reason, 'operation-error');
          const first = Object.values(state.attempts).find((row) => row.kind === 'operation');
          assert(first);
          await engine.retry(sessionId, principal, first.id, 'bounded-read-retry');
          state = await engine.advance(sessionId, principal);
          const attempts = Object.values(state.attempts).filter((row) => row.kind === 'operation');
          assert.equal(attempts.length, 2);
          assert.equal(new Set(attempts.map((row) => row.invocationId)).size, 1);
          assert.equal(f.counters.reads, 2);
          assert.equal(state.budget.operations, 2);
        }
        assert.equal(state.runs.root.status, 'completed');
        const priorCalls = copy(f.counters);
        await engine.advance(sessionId, principal);
        assert.deepEqual(f.counters, priorCalls);
      }
      summaries.push({
        scenario,
        status: state.runs.root.status,
        sequence: state.sequence,
        counters: copy(f.counters),
        receipts: state.receipts.length,
        usedTokens: state.budget.usedTokens,
        operationAttempts: state.budget.operations,
      });
    }
    // Restart a scheduler over the same store; it must not replay completed effects.
    const restarted = exampleHost(root, capture, manifest, store, pins, 'orchestration');
    const reopened = await new Engine(manifest, restarted.host).advance(`${storeProfile}-orchestration`, principal);
    assert.equal(reopened.runs.root.status, 'completed');
    assert.equal(restarted.counters.reads, 0);
    assert.equal(restarted.counters.model, 0);
  } finally {
    await store.close();
  }
  if (storeProfile === 'sqlite') {
    const reopened = sqliteStore(directory);
    try {
      assert.equal((await reopened.read('sqlite-orchestration')).runs.root.status, 'completed');
    } finally {
      await reopened.close();
    }
  }
  return {
    storeProfile,
    compiledDigest: compiled.digest,
    sourceRevision: capture.revision,
    installedCodeDigest: pins.code,
    recipeDigest: pins.recipe,
    negatives: [
      'task-type',
      'principal',
      'changed-catalog',
      'missing-evaluator',
      'stale-question',
      'revoked-operation',
      'stale-manifest',
      'failed-evaluator',
    ],
    recovery: 'One repeatable read retry retains invocation identity and prior accounting.',
    restart: true,
    paidProviderCalls: 0,
    observations: summaries,
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = resolve(process.argv[2] ?? ''),
    directory = resolve(process.argv[3] ?? '');
  assert(process.argv.length === 4, 'Usage: node recipe.mjs <native-root> <new-session-directory>');
  mkdirSync(directory, { recursive: false });
  console.log(
    JSON.stringify(
      {
        version: 1,
        profile: 'deterministic-fake-sdk-qualification',
        memory: await qualifySdk({ root, directory, storeProfile: 'memory' }),
        sqlite: await qualifySdk({ root, directory, storeProfile: 'sqlite' }),
      },
      null,
      2,
    ),
  );
}
