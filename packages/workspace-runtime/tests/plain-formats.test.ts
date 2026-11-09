import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureAuthoringManifestBytes } from '../src/authoring-manifest.js';
import { createAuthoringIndex, verifyAuthoringIndex } from '../src/authoring.js';
import { verifyResources } from '../src/resources.js';
import { verifyInstalledAdapter } from '../src/adapters.js';
import { verifyStoreBinding } from '../src/local-store.js';
import {
  SELECTED_CLAUDE_CODE_VERSION,
  decodeLifecycleEvent,
  lifecycleProfile,
  segmentedLifecycleRow,
  verifyLifecycleProfile,
} from '../src/lifecycle-profile.js';
import { claudeCodeRows, profileFromRows } from '../src/lifecycle-rows.js';
import { TASK_CAPTURE_POLICY, taskCaptureSelection } from '../src/task-capture-format.js';
import { verifyProjectionDescriptor } from '../src/projection-format.js';
import { claudeProseCatalog, codexProseCatalog, verifyCatalog } from '../src/projection-host.js';
import { metadataDigest } from '../src/resource-format.js';
import {
  CANDIDATE_VALIDATE_HANDLER,
  DRAFT_PUBLISH_HANDLER,
  LEGACY_CANDIDATE_VALIDATE_HANDLER,
  LEGACY_DRAFT_PUBLISH_HANDLER,
  candidateValidation,
  captureWorkspace,
  managedPublication,
} from '../src/index.js';
import { CORPUS_INSPECT_HANDLER, Corpus, LEGACY_CORPUS_INSPECT_HANDLER } from '../src/corpus.js';
import { currentStamp, peekStamp, stampKeys } from '../src/plain-format.js';
import { adapterFixture } from './adapter-fixture.js';
import { authoringFixture } from './authoring-fixture.js';

/** The document as it was written before formats stopped carrying their version: the legacy literal, no formatVersion. */
function legacy<T extends { format: string; digest: string }>(document: T, literal: string): Record<string, unknown> {
  const { digest: _digest, format: _format, formatVersion: _version, ...rest } = document as Record<string, unknown>;
  const body = { format: literal, ...rest };
  return { ...body, digest: metadataDigest(body) };
}
/** The same document with the plain stamp, digested again. */
function plain<T extends { format: string; digest: string }>(document: T, name: string): Record<string, unknown> {
  const { digest: _digest, format: _format, formatVersion: _version, ...rest } = document as Record<string, unknown>;
  const body = { ...currentStamp(name), ...rest };
  return { ...body, digest: metadataDigest(body) };
}

describe('the format stamp', () => {
  it('reads the plain name with formatVersion 1 or one listed legacy literal without it, and nothing else', () => {
    expect(peekStamp({ format: 'thing', formatVersion: 1 }, 'thing', ['ia.thing.v1'])).toEqual({
      format: 'thing',
      formatVersion: 1,
    });
    expect(peekStamp({ format: 'ia.thing.v1' }, 'thing', ['ia.thing.v1'])).toEqual({ format: 'ia.thing.v1' });
    for (const value of [
      { format: 'thing' },
      { format: 'thing', formatVersion: 2 },
      { format: 'thing', formatVersion: '1' },
      { format: 'ia.thing.v1', formatVersion: 1 },
      { format: 'ia.thing.v2' },
      { format: 'ia.thing.v1.1' },
      { format: 'other', formatVersion: 1 },
      null,
      [],
      'thing',
    ])
      expect(peekStamp(value, 'thing', ['ia.thing.v1'])).toBeUndefined();
    expect(stampKeys(currentStamp('thing'))).toEqual(['format', 'formatVersion']);
    expect(stampKeys({ format: 'ia.thing.v1' })).toEqual(['format']);
  });
});

describe('captured resources and the authoring index', () => {
  it('writes the plain names, and verifies a legacy envelope and index as written under their own digests', () => {
    const f = authoringFixture();
    try {
      expect(f.resources).toMatchObject({
        format: 'captured-resources',
        formatVersion: 1,
      });
      const oldResources = legacy(f.resources, 'ia.captured-resources.v1'),
        verified = verifyResources(oldResources, f.capture);
      expect(verified.format).toBe('ia.captured-resources.v1');
      expect(Object.hasOwn(verified, 'formatVersion')).toBe(false);
      expect(verified.digest).toBe(oldResources['digest']);
      expect(verified.digest).not.toBe(f.resources.digest);
      for (const bad of [
        { ...f.resources, formatVersion: 2 },
        {
          ...f.resources,
          format: 'captured-resources',
          formatVersion: undefined,
        },
        { ...f.resources, format: 'ia.captured-resources.v2' },
        { ...oldResources, formatVersion: 1 },
      ])
        expect(() => verifyResources(bad, f.capture)).toThrow();

      const index = createAuthoringIndex(f.capture, f.resources, f.input);
      expect(index).toMatchObject({
        format: 'authoring-index',
        formatVersion: 1,
      });
      expect(verifyAuthoringIndex(plain(index, 'authoring-index'), f.capture, f.resources)).toEqual(index);
      // A retained index written under the original literal re-derives under that literal, so its digest still holds.
      const oldIndex = legacy(createAuthoringIndex(f.capture, verified, f.input), 'ia.authoring-index.v1'),
        checked = verifyAuthoringIndex(oldIndex, f.capture, verified);
      expect(checked.format).toBe('ia.authoring-index.v1');
      expect(checked.digest).toBe(oldIndex['digest']);
      expect(checked.digest).not.toBe(index.digest);
      for (const bad of [
        plain({ ...index, format: 'authoring-index' }, 'authoring-index-two'),
        { ...index, formatVersion: 2 },
        { ...oldIndex, formatVersion: 1 },
      ])
        expect(() => verifyAuthoringIndex(bad, f.capture, verified)).toThrow();
    } finally {
      f.reader.close();
    }
  });

  it('reads an authoring manifest under either name and refuses another', () => {
    const f = authoringFixture();
    try {
      const select = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(select);
        if (!input || typeof input !== 'object') return input;
        const value = input as Record<string, unknown>;
        if (typeof value['source'] === 'string' && value['revision'] && value['path'])
          return {
            source: 'self',
            path: value['path'],
            ...(value['identity'] ? { identity: value['identity'] } : {}),
          };
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, select(v)]));
      };
      const body = {
        files: f.resources.files.map(({ key, content: _content, ...file }) => ({
          ...file,
          path: key.path,
        })),
        associations: select(f.resources.associations),
        index: select(f.input),
      };
      const source = (manifest: unknown) => ({
        source: f.capture.id,
        revision: f.capture.revision,
        imports: [],
        manifest,
        files: f.resources.files.map((file) => ({
          path: file.key.path,
          content: file.content,
        })),
      });
      const run = (manifest: unknown) =>
        captureAuthoringManifestBytes(f.capture, {
          sources: [source(manifest)],
        });
      const current = run({
          format: 'authoring-resources',
          formatVersion: 1,
          ...body,
        }),
        original = run({ format: 'ia.authoring-resources.v1', ...body });
      expect(current.resources).toMatchObject({
        format: 'captured-resources',
        formatVersion: 1,
      });
      expect(original).toEqual(current);
      for (const bad of [
        { format: 'authoring-resources', ...body },
        { format: 'authoring-resources', formatVersion: 2, ...body },
        { format: 'ia.authoring-resources.v1', formatVersion: 1, ...body },
        { format: 'ia.authoring-resources.v2', ...body },
      ])
        expect(() => run(bad)).toThrow();
    } finally {
      f.reader.close();
    }
  });
});

describe('installed adapters and retained stores', () => {
  it('verifies a descriptor and a binding under the plain stamp or the original literal, and refuses another', () => {
    const f = adapterFixture(),
      adapter = plain(f.adapter, 'installed-adapter'),
      bindingBody = {
        ...currentStamp('retained-store'),
        ...(({ format: _f, digest: _d, ...rest }) => rest)(f.binding),
        adapterDigest: adapter['digest'] as string,
      },
      binding = { ...bindingBody, digest: metadataDigest(bindingBody) };
    const catalog = { adapters: { retained: adapter }, containments: [] };
    expect(verifyInstalledAdapter(adapter, catalog)).toEqual(adapter);
    expect(verifyStoreBinding(binding, adapter)).toEqual(binding);
    // The fixture is the original form, which stays readable and keeps its pinned digests.
    expect(verifyInstalledAdapter(f.adapter, f.catalog)).toEqual(f.adapter);
    expect(verifyStoreBinding(f.binding, f.adapter)).toEqual(f.binding);
    expect(adapter['digest']).not.toBe(f.adapter.digest);
    for (const bad of [
      { ...adapter, formatVersion: 2 },
      { ...f.adapter, formatVersion: 1 },
      legacy(f.adapter, 'ia.installed-adapter.v2'),
      plain(f.adapter, 'installed-adapters'),
    ])
      expect(() =>
        verifyInstalledAdapter(bad, {
          adapters: { retained: bad },
          containments: [],
        }),
      ).toThrow();
    for (const bad of [
      { ...binding, formatVersion: 2 },
      { ...f.binding, formatVersion: 1 },
      legacy(binding as never, 'ia.retained-store.v2'),
    ])
      expect(() => verifyStoreBinding(bad, adapter)).toThrow();
  });
});

describe('lifecycle profiles and events', () => {
  const original = (version: string) =>
    profileFromRows(claudeCodeRows, 'claude-code', version, {
      format: 'ia.lifecycle-profile.v1',
    });
  it('writes the plain profile and still verifies, and names the row of, a profile under the original literal', () => {
    const current = lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION),
      old = original(SELECTED_CLAUDE_CODE_VERSION);
    expect(current).toMatchObject({
      format: 'lifecycle-profile',
      formatVersion: 1,
    });
    expect(Object.hasOwn(old, 'formatVersion')).toBe(false);
    expect(old.digest).toBe('b25a5786a27e21e6b81449739d114d66be7c77ac9339c058919402111c8525b2');
    expect(current.digest).not.toBe(old.digest);
    expect(verifyLifecycleProfile(current)).toEqual(current);
    expect(verifyLifecycleProfile(old)).toEqual(old);
    for (const digest of [current.digest, old.digest])
      expect(segmentedLifecycleRow(digest)).toEqual({
        host: 'claude-code',
        version: SELECTED_CLAUDE_CODE_VERSION,
      });
    for (const bad of [
      { ...current, formatVersion: 2 },
      { ...old, formatVersion: 1 },
      { ...current, format: 'ia.lifecycle-profile.v1' },
      { ...old, format: 'ia.lifecycle-profile.v2' },
      { ...old, version: '2.1.278' },
    ])
      expect(() => verifyLifecycleProfile(bad as never)).toThrow();
  });
  it('decodes an event under a legacy profile, stamping it plain and keeping the profile digest', () => {
    const old = original('2.1.278'),
      event = decodeLifecycleEvent(
        verifyLifecycleProfile(old),
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'host-session',
          cwd: '/fixed/project',
          prompt: 'Implement the change',
          prompt_id: 'prompt-1',
        }),
      );
    expect(event).toMatchObject({
      format: 'lifecycle-event',
      formatVersion: 1,
      profile: old.digest,
    });
  });
});

describe('task capture selections', () => {
  const hex = (letter: string) => letter.repeat(64);
  const body = {
    request: {
      target: 'work-system/definition/task/example',
      phase: 'act',
      primitive: 'Decision',
    },
    policy: TASK_CAPTURE_POLICY,
    implementation: hex('a'),
    fullRevision: hex('b'),
    resources: hex('c'),
    index: hex('d'),
    declaration: hex('e'),
    teaching: hex('f'),
    proof: hex('1'),
  };
  it('reads the plain stamp and the original literal as written, and refuses another', () => {
    const current = {
        format: 'task-capture-selection',
        formatVersion: 1,
        ...body,
      },
      old = { format: 'ia.task-capture-selection.v1', ...body };
    expect(taskCaptureSelection(current)).toEqual(current);
    expect(taskCaptureSelection(old)).toEqual(old);
    for (const bad of [
      { ...current, formatVersion: 2 },
      { ...current, formatVersion: undefined },
      { ...old, formatVersion: 1 },
      { ...old, format: 'ia.task-capture-selection.v2' },
    ])
      expect(() => taskCaptureSelection(bad)).toThrow();
  });
});

describe('projection descriptors and catalogs', () => {
  it('rebuilds a catalog and a descriptor under the literal each carries, and refuses another', () => {
    const impl = 'a'.repeat(64);
    for (const [make, name] of [
      [claudeProseCatalog, 'host.claude-prose'],
      [codexProseCatalog, 'host.codex-prose'],
    ] as const) {
      const catalog = make(impl);
      expect(catalog).toMatchObject({
        format: 'projection-catalog',
        formatVersion: 1,
        profile: { id: name },
      });
      expect(verifyCatalog(catalog)).toEqual(catalog);
      const { formatVersion: _version, ...rest } = catalog,
        old = {
          ...rest,
          format: 'ia.projection-catalog.v1' as const,
          profile: { ...catalog.profile, id: `ia.${name}.v1` },
        };
      expect(verifyCatalog(old)).toEqual(old);
      for (const bad of [
        { ...catalog, formatVersion: 2 },
        { ...old, formatVersion: 1 },
        { ...old, format: 'ia.projection-catalog.v2' },
        { ...catalog, profile: { ...catalog.profile, id: `ia.${name}.v2` } },
      ])
        expect(() => verifyCatalog(bad as never)).toThrow();
    }
  });
  it('refuses a descriptor that is neither the plain stamp nor the original literal', () => {
    const body = {
      sourceRevisions: [],
      product: 'plugin',
      profiles: [],
      exports: [],
      resourcesDigest: 'a'.repeat(64),
      inventoryDigest: 'b'.repeat(64),
    };
    for (const format of [
      { format: 'projection-descriptor' },
      { format: 'projection-descriptor', formatVersion: 2 },
      { format: 'ia.projection-descriptor.v2' },
      { format: 'ia.projection-descriptor.v1', formatVersion: 1 },
    ])
      expect(() =>
        verifyProjectionDescriptor({
          ...format,
          ...body,
          digest: metadataDigest({ ...format, ...body }),
        }),
      ).toThrow(/Unsupported projection descriptor format/);
  });
});

describe('handler ids', () => {
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  it('answers both the plain and the original handler for the corpus inspection, validation and publication', () => {
    const capture = captureWorkspace(repository),
      corpus = new Corpus(capture);
    try {
      expect(corpus.adapter.id).toBe(CORPUS_INSPECT_HANDLER);
      expect(Object.keys(corpus.adapters).sort()).toEqual(
        [CORPUS_INSPECT_HANDLER, LEGACY_CORPUS_INSPECT_HANDLER].sort(),
      );
      for (const [handler, adapter] of Object.entries(corpus.adapters)) expect(adapter.id).toBe(handler);
    } finally {
      corpus.close();
    }
    const code = 'a'.repeat(64),
      validation = candidateValidation(
        capture,
        {
          sourceSet: capture.id,
          revision: capture.revision,
          composition: [],
          systems: [],
          paths: [],
        },
        code,
      );
    expect(validation.definition.handler).toBe(CANDIDATE_VALIDATE_HANDLER);
    expect(Object.keys(validation.adapters).sort()).toEqual(
      [CANDIDATE_VALIDATE_HANDLER, LEGACY_CANDIDATE_VALIDATE_HANDLER].sort(),
    );
    for (const [handler, adapter] of Object.entries(validation.adapters)) expect(adapter.id).toBe(handler);
    const publication = managedPublication(repository, '.ia/work/generated/reviewed-draft', code);
    expect(publication.definition.handler).toBe(DRAFT_PUBLISH_HANDLER);
    expect(Object.keys(publication.adapters).sort()).toEqual(
      [DRAFT_PUBLISH_HANDLER, LEGACY_DRAFT_PUBLISH_HANDLER].sort(),
    );
    for (const [handler, adapter] of Object.entries(publication.adapters)) expect(adapter.id).toBe(handler);
  });
  it('binds a publication compiled under the original handler to that handler and its own digest', () => {
    const code = 'a'.repeat(64),
      destination = '.ia/work/generated/reviewed-draft',
      plainBinding = managedPublication(repository, destination, code).definition,
      binding = {
        ...plainBinding,
        handler: LEGACY_DRAFT_PUBLISH_HANDLER,
        id: 'authoring-system/binding/operation/publish-draft',
        digest: 'b'.repeat(64),
      },
      bound = managedPublication(repository, destination, code, binding);
    expect(bound.definition).toMatchObject({
      handler: LEGACY_DRAFT_PUBLISH_HANDLER,
      digest: binding.digest,
    });
    expect(bound.adapter.id).toBe(LEGACY_DRAFT_PUBLISH_HANDLER);
    expect(() =>
      managedPublication(repository, destination, code, {
        ...binding,
        handler: 'ia.draft.publish.v2',
      }),
    ).toThrow('incompatible');
  });
});
