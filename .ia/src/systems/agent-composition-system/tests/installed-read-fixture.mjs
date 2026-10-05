import assert from 'node:assert/strict';
import * as installedSDK from '@inventarch/agent-composition-system';
import { Engine } from '@inventarch/agent-system';
import { copy, digest, memoryStore } from '@inventarch/session-system';
import { sqliteStore } from '@inventarch/session-system/sqlite';
import { isEntry } from '@inventarch/runtime/entry';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const readPath = '.ia/src/systems/agent-system/records/installed-read-label.ia';
export const evaluator = 'installed-read-example-policy-v1';
export function readFixture(SDK, root) {
  const baseline = SDK.captureWorkspace(root),
    { revision: _revision, ...body } = baseline;
  const placement = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  const sources = [
    {
      path: readPath,
      text: '#! ia 1.0\n@agent installed-read-label\n  meaning\n    says "A supplied public read label."\n    answers "What bounded public label is read?"\n  governance\n    applies []\n',
      location: placement,
    },
    {
      path: '.ia/src/systems/agent-composition-system/operations/read-captured-source.ia',
      text: '#! ia 1.0\n@operation read-captured-source\n  meaning\n    says "Read one exact captured native source through the first-party adapter."\n    answers "Which captured bytes are selected?"\n  execution\n    handler captured-source-read-v1\n    effects read-only\n    input captured-source-read-input-v1\n    output captured-source-read-output-v1\n    profile governed-v1\n    recovery repeatable\n  relationships\n    implements @contract agent-composition-runtime-contract#REQ-RT-CAPTURED-INPUT\n    implements @contract agent-composition-runtime-contract#REQ-RT-CAPTURED-READ\n    implements @contract agent-composition-runtime-contract#REQ-RT-CAPTURED-REFUSE\n',
      location: placement,
    },
    {
      path: '.ia/src/systems/agent-composition-system/records/read-captured-source-binding.ia',
      text: '#! ia 1.0\n\n@execution-binding read-captured-source-binding\n  meaning\n    says "Select the fixed installed first-party captured-source read adapter."\n    answers "Which declared implementation can an explicitly selected harness bind for captured reads?"\n  binding\n    kind operation\n    target @operation read-captured-source\n    implementation captured-source-read-v1\n',
      location: placement,
    },
    {
      path: '.ia/src/systems/agent-composition-system/records/installed-read-example.ia',
      text: `#! ia 1.0
@agent installed-read-example-agent
  meaning
    says "Perform the supplied bounded captured read."
    answers "Which participant retains the read task?"
  governance
    applies []
@playbook installed-read-example-method
  meaning
    says "Read the exact supplied capture path and return its evidence."
    answers "What procedure does the example follow?"
  cognition
    act
      primary Decision
      Decision means "Select only the installed captured read operation. A method grants no authority."
@mandate installed-read-example-mandate
  meaning
    says "Retain read-only effects and current host checks."
    answers "What restrictions govern this task?"
  governance
    requires "Do not write, load modules or widen capture scope."
  execution
    contract installed-read-example-mandate-v1
    limit-model-calls 4
    limit-operations 3
@capability installed-read-example-capability
  meaning
    says "Compose the fixed read and neutral method."
    answers "Which operation is available?"
  composition
    operations [@operation read-captured-source]
    playbooks [@playbook installed-read-example-method]
  execution
    input installed-read-example-task-v1
    outcomes installed-read-example-outcomes-v1
    context-profile installed-read-example-context-v1
    mapping-profile installed-read-example-identity-v1
    effects [read]
@agent-profile installed-read-example-profile
  meaning
    says "Bind the example to its restricted read capability."
    answers "Which profile enters the task?"
  composition
    agent @agent installed-read-example-agent
    mandate @mandate installed-read-example-mandate
    capabilities [@capability installed-read-example-capability]
  execution
    role reader
    outcomes installed-read-example-outcomes-v1
    mandate-contract installed-read-example-mandate-v1
@workspace installed-read-example-workspace
  meaning
    says "Select the public read and existing composition dependencies."
    answers "Which systems compose this example?"
  composition
    systems [@system agent-composition-system, @system agent-system, @system workspace-system, @system governance-system, @system compliance-system, @system authoring-system]
@execution-binding installed-read-example-entry
  meaning
    says "Enter the bounded reader profile."
    answers "Where does the authorized task enter?"
  binding
    kind entry
    target @agent-profile installed-read-example-profile
    implementation installed-read-example-entry-v1
    mapping installed-read-example-identity-v1
@harness installed-read-example-harness
  meaning
    says "Compile the fixed installed read without executing it."
    answers "Which example harness is compiled?"
  composition
    workspace @workspace installed-read-example-workspace
    profiles [@agent-profile installed-read-example-profile]
    bindings [@execution-binding read-captured-source-binding, @execution-binding installed-read-example-entry]
  execution
    host-profile installed-read-example-host-v1
`,
      location: placement,
    },
  ];
  // Reuse the explicitly selected canonical operation; never duplicate or silently replace its bytes.
  const added = sources.filter((source) => {
    const existing = body.sources.find((row) => row.path === source.path);
    if (!existing) return true;
    assert.ok(
      [
        '.ia/src/systems/agent-composition-system/operations/read-captured-source.ia',
        '.ia/src/systems/agent-composition-system/records/read-captured-source-binding.ia',
      ].includes(source.path),
      'Unexpected fixture/native path collision',
    );
    assert.equal(existing.text.trim(), source.text.trim(), 'Canonical installed read declaration differs');
    return false;
  });
  const next = { ...body, sources: [...body.sources, ...added].sort((a, b) => a.path.localeCompare(b.path, 'en')) },
    capture = { ...next, revision: digest(next) };
  const installedRead = SDK.installedReadCatalog(),
    limits = {
      steps: 24,
      modelCalls: 6,
      operations: 4,
      tokens: 100000,
      children: 0,
      depth: 0,
      bytes: 4000000,
      durationMs: 600000,
    };
  const catalog = {
    ...installedRead,
    validators: {
      ...installedRead.validators,
      'installed-read-example-task-v1': SDK.installed({ schema: { type: 'string', maxLength: 1024 } }),
    },
    hosts: {
      'installed-read-example-host-v1': SDK.installed({
        effects: ['read'],
        models: ['installed-read-example-model-v1'],
        limits,
        defaults: {
          model: 'installed-read-example-model-v1',
          input: 'installed-read-example-task-v1',
          outcomes: 'installed-read-example-outcomes-v1',
          context: 'installed-read-example-context-v1',
          mapping: 'installed-read-example-identity-v1',
        },
      }),
    },
    models: { 'installed-read-example-model-v1': SDK.installed({ model: 'example/scripted-read' }) },
    outcomes: {
      'installed-read-example-outcomes-v1': SDK.installed({ kinds: ['answer', 'failure'], completion: 'response' }),
    },
    mandates: {
      'installed-read-example-mandate-v1': SDK.installed({
        input: 'installed-read-example-task-v1',
        outcomes: 'installed-read-example-outcomes-v1',
        effects: ['read'],
        context: 'installed-read-example-context-v1',
        checks: [evaluator],
        limits: {},
      }),
    },
    contexts: {
      'installed-read-example-context-v1': SDK.installed({
        scope: 'captured-workspace',
        coordinate: { phase: 'act', primitive: 'Decision', category: 'capability' },
        tokens: 8192,
        records: 20,
      }),
    },
    evaluators: { [evaluator]: SDK.installed({ phases: ['before-effect'] }) },
    entries: {
      'installed-read-example-entry-v1': SDK.installed({
        target: 'agent-profile',
        mapping: 'installed-read-example-identity-v1',
      }),
    },
    mappings: { 'installed-read-example-identity-v1': SDK.installed({ kind: 'identity' }) },
  };
  const compilation = SDK.compileHarness(capture, {
    harness: 'installed-read-example-harness',
    entry: 'installed-read-example-entry',
    catalog,
  });
  assert(compilation.ok, JSON.stringify(compilation));
  const compiled = compilation.manifest,
    manifest = SDK.executionManifest(compiled, catalog),
    principal = 'read-operator';
  const grant = {
    id: 'read-example',
    principal,
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    operations: [SDK.INSTALLED_READ.operation],
    effects: ['read'],
    sources: [capture.revision],
    models: ['example/scripted-read'],
    expiresAt: Date.now() + 600000,
    limits: {
      steps: 24,
      modelCalls: 6,
      operations: 4,
      tokens: 100000,
      children: 0,
      depth: 0,
      bytes: 4000000,
      deadline: Date.now() + 600000,
    },
  };
  return {
    capture,
    compiled,
    catalog,
    manifest,
    principal,
    grant,
    profile: compiled.entry.profile,
    options: { manifest, compiled, catalog, principal, currentCapture: () => copy(capture) },
  };
}

/** Qualification-only host. It never issues an application grant or calls a live provider. */
export async function qualifyInstalledRead(SDK, root, store, retryFault) {
  const f = readFixture(SDK, root);
  let current = f.capture;
  const read = SDK.installedReadAdapters(f.capture, { ...f.options, currentCapture: () => current }),
    adapter = read.operations[SDK.INSTALLED_READ.handler];
  let calls = 0,
    reads = 0,
    failOnce = true,
    revoked = false,
    checks = 0;
  const host = {
    store,
    operations: {
      [adapter.id]: {
        id: adapter.id,
        execute: async (input, context) => {
          reads++;
          if (failOnce) {
            failOnce = false;
            throw new Error('One deterministic pre-read failure');
          }
          return adapter.execute(input, context);
        },
      },
    },
    model: {
      id: 'example-scripted-read',
      generate: async (request) => {
        calls++;
        return {
          provider: 'deterministic-fake',
          model: 'example/scripted-read',
          usage: 1,
          action: request.history.some((row) => row?.kind === 'action')
            ? { type: 'outcome', kind: 'answer', message: 'The captured read completed.', continuation: 'finish' }
            : { type: 'invoke', operation: SDK.INSTALLED_READ.operation, input: { path: readPath, limit: 2 } },
        };
      },
    },
    authorize: async (actor) => {
      assert.equal(actor, f.principal);
      return copy({ ...f.grant, operations: revoked ? [] : f.grant.operations });
    },
    verifyManifest: async (manifest) =>
      digest(manifest) === digest(f.manifest) &&
      current.revision === f.capture.revision &&
      SDK.installedImplementationDigest() ===
        f.catalog.operations[SDK.INSTALLED_READ.implementation].value.implementationDigest,
    context: async () => ({ capture: f.capture.revision }),
    evaluate: async () => {
      checks++;
      return { status: 'pass', evidence: [], message: 'Only the fixed captured read is authorized.' };
    },
    preflight: async (definition) => definition.id === SDK.INSTALLED_READ.operation,
  };
  try {
    const engine = new Engine(f.manifest, host);
    await engine.start({
      sessionId: 'installed-read',
      commandId: 'start',
      principal: f.principal,
      profile: f.profile,
      task: 'Read the supplied public capture label.',
    });
    let state = await engine.advance('installed-read', f.principal);
    assert.equal(state.runs.root.wait.reason, 'operation-error');
    const first = Object.values(state.attempts).find((row) => row.kind === 'operation');
    assert(first);
    const { revision: _revision, ...body } = f.capture;
    const next = {
      ...body,
      sources: body.sources.map((row) =>
        row.path === readPath ? { ...row, text: row.text + '# changed captured bytes\n' } : row,
      ),
    };
    current = { ...next, revision: digest(next) };
    await assert.rejects(engine.retry('installed-read', f.principal, first.id, 'stale-source-retry'), {
      code: 'IA-ENGINE-SOURCE-CHANGED',
    });
    assert.equal(reads, 1);
    current = f.capture;
    if (retryFault) {
      const restore = retryFault();
      try {
        await assert.rejects(engine.retry('installed-read', f.principal, first.id, 'changed-code-retry'), {
          code: 'IA-ENGINE-SOURCE-CHANGED',
        });
        assert.equal(reads, 1);
      } finally {
        restore();
      }
    }
    revoked = true;
    await assert.rejects(engine.retry('installed-read', f.principal, first.id, 'revoked-retry'), {
      code: 'IA-ENGINE-OPERATION-DENIED',
    });
    assert.equal(reads, 1);
    revoked = false;
    await engine.retry('installed-read', f.principal, first.id, 'authorized-retry');
    state = await engine.advance('installed-read', f.principal);
    assert.equal(state.runs.root.status, 'completed');
    assert.equal(state.budget.operations, 2);
    const attempts = Object.values(state.attempts).filter((row) => row.kind === 'operation');
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((row) => row.invocationId)).size, 1);
    const receipt = state.receipts.find((row) => row.target === SDK.INSTALLED_READ.operation && row.error === null);
    assert(receipt);
    assert.equal(receipt.output.revision, f.capture.revision);
    assert(receipt.output.text.includes('installed-read-label'));
    assert.equal(receipt.effect, 'none');
    const before = { calls, reads };
    await new Engine(f.manifest, host).advance('installed-read', f.principal);
    assert.deepEqual({ calls, reads }, before);
    const context = {
      sessionId: 'direct',
      runId: 'root',
      attemptId: 'direct',
      invocationId: 'direct',
      principal: f.principal,
      grant: f.grant,
      manifest: f.manifest,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    };
    await assert.rejects(adapter.execute({ path: '.ia/src/outside.ia' }, context));
    await assert.rejects(adapter.execute({ path: readPath, module: 'private-handler' }, context));
    await assert.rejects(adapter.execute({ path: readPath }, { ...context, grant: { ...f.grant, effects: [] } }));
    return {
      capture: f.capture.revision,
      compiled: f.compiled.digest,
      installedCode: f.catalog.operations[SDK.INSTALLED_READ.implementation].value.implementationDigest,
      calls,
      reads,
      checks,
      attempts: attempts.length,
      operationBudget: state.budget.operations,
      receipts: state.receipts.length,
      paidProviderCalls: 0,
      revokedRetryRefused: true,
      staleSourceRetryRefused: true,
      changedCodeRetryRefused: Boolean(retryFault),
      restart: true,
      result: receipt.output,
    };
  } finally {
    read.close();
  }
}

function mutateDisposableInstalledCode(root) {
  const code = resolve(
    dirname(fileURLToPath(import.meta.resolve('@inventarch/agent-composition-system'))),
    'installed-read.js',
  );
  assert(code.startsWith(resolve(root, 'node_modules') + sep), 'Mutate only this disposable consumer installed module');
  const original = readFileSync(code),
    temporary = code + '.mutation-tmp';
  // Replace the directory entry; never write into pnpm's possibly hard-linked store inode.
  writeFileSync(temporary, Buffer.concat([original, Buffer.from('\n// disposable code pin mutation\n')]));
  renameSync(temporary, code);
  return () => {
    writeFileSync(temporary, original);
    renameSync(temporary, code);
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  assert(
    [4, 5].includes(process.argv.length),
    'Usage: node installed-read-fixture.mjs <native-root> <sqlite-directory> [--mutate-installed-code]',
  );
  assert(process.argv.length === 4 || process.argv[4] === '--mutate-installed-code');
  const root = resolve(process.argv[2]),
    memory = memoryStore(),
    sqlite = sqliteStore(resolve(process.argv[3]));
  try {
    const retryFault =
      process.argv[4] === '--mutate-installed-code' ? () => mutateDisposableInstalledCode(root) : undefined;
    const result = {
      node: process.version,
      memory: await qualifyInstalledRead(installedSDK, root, memory, retryFault),
      sqlite: await qualifyInstalledRead(installedSDK, root, sqlite, retryFault),
    };
    await sqlite.close();
    const reopened = sqliteStore(resolve(process.argv[3]));
    try {
      assert.equal((await reopened.read('installed-read')).runs.root.status, 'completed');
    } finally {
      await reopened.close();
    }
    let byteMutationRefused = null;
    if (process.argv[4] === '--mutate-installed-code') {
      const f = readFixture(installedSDK, root),
        bound = installedSDK.installedReadAdapters(f.capture, f.options),
        restore = mutateDisposableInstalledCode(root);
      const context = {
        sessionId: 'bytes',
        runId: 'root',
        attemptId: 'a',
        invocationId: 'i',
        principal: f.principal,
        grant: f.grant,
        manifest: f.manifest,
        signal: new AbortController().signal,
        assertCurrent: async () => {},
      };
      try {
        await assert.rejects(
          bound.operations[installedSDK.INSTALLED_READ.handler].execute({ path: readPath }, context),
          /implementation bytes changed/,
        );
        byteMutationRefused = true;
      } finally {
        restore();
        bound.close();
      }
    }
    console.log(JSON.stringify({ ...result, sqliteReopened: true, byteMutationRefused }, null, 2));
  } finally {
    await memory.close();
    await sqlite.close();
  }
}
