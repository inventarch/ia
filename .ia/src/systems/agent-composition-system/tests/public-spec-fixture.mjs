import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import { captureWorkspace } from '@inventarch/agent-composition-system';
import {
  captureResources,
  resourceOccurrences,
  resolveResources,
  verifyResources,
} from '@inventarch/agent-composition-system/resources';
import {
  createAuthoringIndex,
  resolveAuthoring,
  prepareAuthoringTarget,
  closeAuthoringView,
  verifyAuthoringIndex,
} from '@inventarch/agent-composition-system/authoring';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const sign = (v) => {
  const { digest: _, ...body } = v;
  return { ...body, digest: sha(stableSerialize(body)) };
};
const anchorPath = '.ia/src/systems/work-system/records/public-spec-body-fixture.ia';
const anchor = (status) =>
  `#! ia 1.0\n@spec fixture-spec\n  meaning\n    says "A neutral maintained specification anchor."\n  work\n    title "Neutral consumer specification"\n    status ${status}\n    source "documents/specification.md"\n`;
const body =
  '# Neutral specification\n\nA consumer owns contents and decomposition.\n<script>literal inert fixture data</script>\n';
export function qualifyPublicSpec(nativeRoot, output) {
  const put = (path, text) => {
    const file = resolve(output, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  // Copy captured native bytes only into this independent consumer workspace.
  for (const source of captureWorkspace(nativeRoot).sources)
    if (source.path.startsWith('.ia/src/')) put(source.path, source.text);
  put(anchorPath, anchor('draft'));
  put('documents/specification.md', body);
  put('documents/excluded.md', 'Unselected neighboring body fixture.');
  const capture = captureWorkspace(output, 'project'),
    reader = open(output, { cache: false });
  const refused = [];
  const refuses = (name, action) => {
    assert.throws(action, name);
    refused.push(name);
  };
  try {
    const inventory = resourceOccurrences(capture),
      owner = inventory.occurrences.find((row) => row.identity === 'work-system/contract/spec/fixture-spec');
    assert(owner, 'Public spec occurrence must be admitted');
    const errors = reader.report.findings.filter((f) => f.severity === 'error');
    assert.deepEqual(errors, []);
    const supporting = `\n@spec first\n  meaning\n    says "First neutral prior spec."\n  work\n    title "First spec"\n    status draft\n@spec second\n  meaning\n    says "Second neutral prior spec."\n  work\n    title "Second spec"\n    status draft\n@plan fixture-plan\n  meaning\n    says "Neutral fixture arrangement."\n  work\n    title "Fixture plan"\n    status open\n@milestone fixture-milestone\n  meaning\n    says "Neutral fixture outcome."\n  work\n    title "Fixture milestone"\n    status open\n    plan @plan fixture-plan\n    exit "Fixture evidence retained."\n@task wrong\n  meaning\n    says "Neutral fixture action."\n  work\n    title "Fixture task"\n    status open\n    milestone @milestone fixture-milestone\n`;
    const preview = (text) => reader.preview([{ path: anchorPath, text: text + supporting }]);
    for (const status of ['draft', 'accepted', 'superseded', 'withdrawn'])
      assert.equal(preview(anchor(status)).report.findings.filter((f) => f.severity === 'error').length, 0, status);
    assert(preview(anchor('completed')).report.findings.some((f) => f.severity === 'error'));
    refused.push('unknown-status');
    const relation = (text) => anchor('superseded') + `  relationships\n    supersedes ${text}\n`;
    assert(preview(relation('@task wrong')).report.findings.some((f) => f.severity === 'error'));
    refused.push('wrong-word-supersession');
    assert(
      preview(relation('@spec first\n    supersedes @spec second')).report.findings.some((f) => f.severity === 'error'),
    );
    refused.push('multiple-supersession');
    const unresolved = preview(relation('@spec absent'));
    assert(
      unresolved.report.findings.length > 0 || unresolved.report.verdicts.some((v) => v.outcome === 'not-evaluated'),
      'Unresolved supersession cannot become silently proven',
    );
    const key = { source: owner.source, revision: owner.revision, path: 'documents/specification.md' };
    const pin = {
      key,
      bytes: Buffer.byteLength(body),
      sha256: sha(body),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    };
    const association = { owner, resources: [{ key, role: 'body', order: 0, required: true, delivery: 'inline' }] };
    const request = {
      roots: [{ source: key.source, revision: key.revision, root: output }],
      files: [pin],
      associations: [association],
    };
    const resources = captureResources(capture, request);
    assert(!JSON.stringify(resources).includes('Unselected neighboring'));
    const options = {
      reader,
      within: reader.resolveScope().token,
      owners: [owner],
      allowedResources: [key],
      expectedDigest: resources.digest,
      maxBytes: 65536,
    };
    const result = resolveResources(resources, capture, options);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].file.content, body);
    refuses('missing-required-body', () => captureResources(capture, { ...request, files: [], roots: [] }));
    refuses('missing-association', () => captureResources(capture, { ...request, associations: [] }));
    refuses('body-not-disclosed', () => resolveResources(resources, capture, { ...options, allowedResources: [] }));
    refuses('resource-envelope-digest', () => verifyResources({ ...resources, digest: '0'.repeat(64) }, capture));
    refuses('expected-envelope-digest', () =>
      resolveResources(resources, capture, { ...options, expectedDigest: '0'.repeat(64) }),
    );
    refuses('body-sha256', () =>
      captureResources(capture, { ...request, files: [{ ...pin, sha256: '0'.repeat(64) }] }),
    );
    refuses('body-size', () => captureResources(capture, { ...request, files: [{ ...pin, bytes: pin.bytes + 1 }] }));
    refuses('unsafe-body-path', () =>
      captureResources(capture, { ...request, files: [{ ...pin, key: { ...key, path: '../specification.md' } }] }),
    );
    refuses('aliased-body-path', () =>
      captureResources(capture, {
        ...request,
        files: [{ ...pin, key: { ...key, path: 'documents/./specification.md' } }],
      }),
    );
    refuses('stale-body-source', () =>
      captureResources(capture, { ...request, roots: [{ ...request.roots[0], revision: '0'.repeat(64) }] }),
    );
    const input = {
      systems: [],
      artifacts: [
        {
          id: 'spec-body',
          source: { kind: 'resource', key, range: null },
          purpose: 'Neutral explicit maintained specification body',
          contract: null,
          dependencies: [],
          lifecycle: [],
        },
      ],
      profiles: [
        {
          id: 'spec-body-fixture',
          version: '1',
          roles: [
            { id: 'spec', min: 1, max: 1, context: 'required-input', contract: null },
            { id: 'evidence', min: 1, max: 1, context: 'expected-output', contract: null },
          ],
          criteria: [
            { id: 'coherence', version: '1', basis: 'semantic', text: 'Consumer specification and evidence agree.' },
          ],
        },
      ],
      documents: [
        {
          id: 'fixture-spec-document',
          version: '1',
          profile: { id: 'spec-body-fixture', version: '1' },
          members: [{ artifact: 'spec-body', role: 'spec', order: 0 }],
          gaps: [{ role: 'evidence', reason: 'Consumer evidence has not been supplied.' }],
        },
      ],
      lifecycles: [],
    };
    const index = createAuthoringIndex(capture, resources, input);
    const scope = {
      reader,
      within: options.within,
      allowedResources: [key],
      allowedSystems: [],
      allowedRegistrations: [],
      allowedArtifacts: ['spec-body'],
      allowedDocuments: ['fixture-spec-document'],
    };
    const view = resolveAuthoring(capture, resources, index, scope);
    try {
      const packet = prepareAuthoringTarget(view, {
        target: { kind: 'document', id: 'fixture-spec-document' },
        document: null,
        lifecycle: null,
      });
      assert(packet.parts.some((part) => part.text === body));
      assert.deepEqual(packet.expectedOutputs, [
        { role: 'evidence', reason: 'Consumer evidence has not been supplied.' },
      ]);
      assert(packet.criteria.some((c) => c.status === 'not-evaluated'));
    } finally {
      closeAuthoringView(view);
    }
    const hidden = resolveAuthoring(capture, resources, index, { ...scope, allowedResources: [] });
    try {
      assert(!JSON.stringify(hidden).includes('A consumer owns contents and decomposition.'));
      assert(
        prepareAuthoringTarget(hidden, {
          target: { kind: 'document', id: 'fixture-spec-document' },
          document: null,
          lifecycle: null,
        }).missing.length > 0,
      );
    } finally {
      closeAuthoringView(hidden);
    }
    put('documents/specification.md', body + '\nChanged body without native edit.\n');
    assert.equal(
      captureWorkspace(output, 'project').revision,
      capture.revision,
      'Body edit does not change native capture',
    );
    refuses('changed-disk-body-old-pin', () => captureResources(capture, request));
    const changed = readFileSync(resolve(output, key.path), 'utf8'),
      fresh = captureResources(capture, {
        ...request,
        files: [{ ...pin, bytes: Buffer.byteLength(changed), sha256: sha(changed) }],
      });
    assert.notEqual(fresh.digest, resources.digest);
    refuses('old-document-index-new-body', () => verifyAuthoringIndex(index, capture, fresh));
    // Retained snapshots remain immutable; freshness of the disk body requires recapture.
    assert.equal(resolveResources(resources, capture, options).items[0].file.content, body);
    return {
      passed: true,
      node: process.version,
      capture: capture.revision,
      resources: resources.digest,
      authoring: index.digest,
      bodySha256: pin.sha256,
      positiveStatuses: 4,
      refused,
      semantic: 'not-evaluated',
      expectedEvidenceGap: true,
      bodyEditLeavesNativeRevision: true,
      retainedSnapshotIsHistorical: true,
      implicitBodyLoader: false,
      paidProviderCalls: 0,
    };
  } finally {
    reader.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(qualifyPublicSpec(resolve(process.argv[2]), resolve(process.argv[3]))));
