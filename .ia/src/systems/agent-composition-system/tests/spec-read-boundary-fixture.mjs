import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as installedSDK from '@inventarch/agent-composition-system';
import { Engine } from '@inventarch/agent-system';
import { open } from '@inventarch/db';
import { copy, digest, memoryStore } from '@inventarch/session-system';
import { isEntry } from '@inventarch/runtime/entry';
import {
  captureResources,
  resourceOccurrences,
  resolveResources,
} from '@inventarch/agent-composition-system/resources';
import { readFixture } from './installed-read-fixture.mjs';

const anchorPath = '.ia/src/systems/work-system/records/joined-spec-fixture.ia';
const bodyPath = 'documents/specification.md';
const bodyMarker = 'JOINED-SPEC-BODY-ONLY';
const anchor = `#! ia 1.0
@spec joined-spec-fixture
  meaning
    says "A consumer selects this neutral specification body."
    answers "Which explicit body belongs to this specification?"
  work
    title "Joined read fixture specification"
    status draft
    source "${bodyPath}"
`;
const bodyText = `# Neutral specification\n\n${bodyMarker}\n\nThe consumer chooses contents and document membership.\n`;

/** Qualification-only host: existing APIs, deterministic model, no application grants. */
export async function qualifySpecReadBoundary(SDK, nativeRoot, output) {
  // Create-only output protects an existing consumer workspace before any file write.
  const out = resolve(output);
  mkdirSync(out);
  const put = (path, text) => {
    const target = resolve(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const seed = readFixture(SDK, resolve(nativeRoot));
  // Materialize this existing fixture's capture so the resource source check sees
  // the same physical native bytes as compilation and the installed read.
  for (const source of seed.capture.sources) if (source.path.startsWith('.ia/src/')) put(source.path, source.text);
  put(anchorPath, anchor);
  put(bodyPath, bodyText);
  const capture = SDK.captureWorkspace(out);
  assert(!capture.sources.some((source) => source.path === bodyPath));
  const compilation = SDK.compileHarness(capture, {
    harness: 'installed-read-example-harness',
    entry: 'installed-read-example-entry',
    catalog: seed.catalog,
  });
  assert(compilation.ok, JSON.stringify(compilation));
  const compiled = compilation.manifest,
    manifest = SDK.executionManifest(compiled, seed.catalog);
  const grant = {
    ...seed.grant,
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    sources: [capture.revision],
  };
  const principal = seed.principal;
  const installedRead = SDK.installedReadAdapters(capture, {
    compiled,
    manifest,
    catalog: seed.catalog,
    principal,
    currentCapture: () => SDK.captureWorkspace(out),
  });
  const reader = open(out, { cache: false }),
    store = memoryStore();
  let modelCalls = 0,
    dispatches = 0,
    modelSawBodyProse = false,
    selectedPath = anchorPath,
    nativeBodyFailure = null;
  const nativeAdapter = installedRead.operations[SDK.INSTALLED_READ.handler];
  const host = {
    store,
    operations: {
      [nativeAdapter.id]: {
        id: nativeAdapter.id,
        execute: async (input, context) => {
          dispatches++;
          try {
            return await nativeAdapter.execute(input, context);
          } catch (error) {
            nativeBodyFailure = { code: error.code, message: error.message };
            throw error;
          }
        },
      },
    },
    model: {
      id: 'joined-spec-scripted-model',
      generate: async (request) => {
        modelCalls++;
        modelSawBodyProse ||= JSON.stringify(request).includes(bodyMarker);
        return {
          provider: 'deterministic-fake',
          model: 'example/scripted-read',
          usage: 1,
          action: request.history.some((row) => row?.kind === 'action')
            ? {
                type: 'outcome',
                kind: 'answer',
                message: 'The native specification anchor was read.',
                continuation: 'finish',
              }
            : { type: 'invoke', operation: SDK.INSTALLED_READ.operation, input: { path: selectedPath } },
        };
      },
    },
    authorize: async (actor) => {
      assert.equal(actor, principal);
      return copy(grant);
    },
    verifyManifest: async (value) =>
      digest(value) === digest(manifest) &&
      SDK.captureWorkspace(out).revision === capture.revision &&
      SDK.installedImplementationDigest() ===
        seed.catalog.operations[SDK.INSTALLED_READ.implementation].value.implementationDigest,
    context: async () => ({ capture: capture.revision }),
    evaluate: async () => ({
      status: 'pass',
      evidence: [],
      message: 'The fixture selects only the existing captured read.',
    }),
    preflight: async (definition) => definition.id === SDK.INSTALLED_READ.operation,
  };
  try {
    const engine = new Engine(manifest, host);
    await engine.start({
      sessionId: 'joined-anchor',
      commandId: 'start-anchor',
      principal,
      profile: compiled.entry.profile,
      task: 'Read the native spec anchor.',
    });
    const anchorState = await engine.advance('joined-anchor', principal);
    assert.equal(anchorState.runs.root.status, 'completed');
    const receipt = anchorState.receipts.find(
      (row) => row.target === SDK.INSTALLED_READ.operation && row.error === null,
    );
    assert(receipt);
    assert.equal(receipt.effect, 'none');
    assert.equal(receipt.output.revision, capture.revision);
    assert.equal(JSON.parse(receipt.output.text).lines.join('\n'), anchor);
    assert(!receipt.output.text.includes(bodyMarker));
    assert.equal(anchorState.budget.operations, 1);

    selectedPath = bodyPath;
    await engine.start({
      sessionId: 'joined-body-path',
      commandId: 'start-body',
      principal,
      profile: compiled.entry.profile,
      task: 'Attempt the locator as a native path.',
    });
    const refusedState = await engine.advance('joined-body-path', principal);
    assert.equal(refusedState.runs.root.wait.reason, 'operation-error');
    const refusedReceipt = refusedState.receipts.find(
      (row) => row.target === SDK.INSTALLED_READ.operation && row.error !== null,
    );
    assert(refusedReceipt);
    assert.equal(refusedReceipt.error, 'operation-attempt-failed');
    assert.deepEqual(nativeBodyFailure, {
      code: 'IA-CORPUS-INVALID',
      message: 'Requested file is outside the captured source set',
    });
    assert.equal(refusedReceipt.output, null);
    assert.equal(refusedState.budget.operations, 1);
    assert(!JSON.stringify(refusedState).includes(bodyMarker));
    assert.equal(modelSawBodyProse, false);

    const owner = resourceOccurrences(capture).occurrences.find(
      (row) => row.identity === 'work-system/contract/spec/joined-spec-fixture',
    );
    assert(owner, 'The spec body needs an admitted native owner.');
    const key = { source: owner.source, revision: owner.revision, path: bodyPath };
    const bytes = readFileSync(resolve(out, bodyPath));
    const pin = {
      key,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    };
    const resources = captureResources(capture, {
      roots: [{ source: owner.source, revision: owner.revision, root: out }],
      files: [pin],
      associations: [{ owner, resources: [{ key, role: 'body', order: 0, required: true, delivery: 'inline' }] }],
    });
    const options = {
      reader,
      within: reader.resolveScope().token,
      owners: [owner],
      expectedDigest: resources.digest,
      maxBytes: 65536,
    };
    // A successful native read/grant cannot replace this independent disclosure input.
    assert.throws(() => resolveResources(resources, capture, { ...options, allowedResources: [] }), {
      code: 'IA-RESOURCE-INVALID',
      message: 'Required resource is missing or outside the current resource permission',
    });
    const disclosed = resolveResources(resources, capture, { ...options, allowedResources: [key] });
    assert.equal(disclosed.items.length, 1);
    assert.equal(disclosed.items[0].file.content, bodyText);
    assert.equal(disclosed.items[0].file.sha256, pin.sha256);
    assert(disclosed.items[0].citation.includes(bodyPath));
    return {
      passed: true,
      capture: capture.revision,
      compiled: compiled.digest,
      installedCode: seed.catalog.operations[SDK.INSTALLED_READ.implementation].value.implementationDigest,
      resources: resources.digest,
      body: pin,
      modelCalls,
      dispatches,
      paidProviderCalls: 0,
      nativeAnchorRead: true,
      nativeBodyPathRefused: true,
      undisclosedRequiredBodyRefused: true,
      nativeBodyPathError: refusedReceipt.error,
      nativeBodyPathAdapterError: nativeBodyFailure,
      disclosedBodyExact: true,
      modelSawBodyProse,
      semanticCoherence: 'not-evaluated',
    };
  } finally {
    installedRead.close();
    reader.close();
    await store.close();
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  assert.equal(
    process.argv.length,
    4,
    'Usage: node spec-read-boundary-fixture.mjs <public-native-root> <new-empty-output>',
  );
  console.log(JSON.stringify(await qualifySpecReadBoundary(installedSDK, process.argv[2], process.argv[3]), null, 2));
}
