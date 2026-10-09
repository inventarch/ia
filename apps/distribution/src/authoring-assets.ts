import { KERNEL_SOURCES, parse } from '@inventarch/language';
import { EditorSnapshot } from '@inventarch/db/editor';
import {
  decodeDistributionJson,
  deriveGenerationInputs,
  generationDigest,
  generationSources,
  installationWorkspace,
  type BundleManifest,
  type DistributionLock,
} from '@inventarch/db/distribution';
import { verifyCapture, type Capture } from '@inventarch/workspace-runtime';
import {
  AUTHORING_MANIFEST_PATH,
  captureAuthoringManifestBytes,
  type AuthoringManifestByteSource,
} from '@inventarch/workspace-runtime/authoring-manifest';
import { resolveAuthoring } from '@inventarch/workspace-runtime/authoring';
import { RESOURCE_LIMITS, resourceOccurrences, nativeResourcePath } from '@inventarch/workspace-runtime/resources';
import { digest } from '@inventarch/graph';
import { fail, utf8 } from './files.js';

/** Archive evidence is entirely input bytes plus the installed language's explicit immutable floor. */
export function verifyAuthoringAssetClosure(manifest: BundleManifest, files: ReadonlyMap<string, Uint8Array>): void {
  const sources = manifest.files
    .filter((file) => file.role === 'source')
    .map((file) => ({ path: file.path, text: utf8(Buffer.from(files.get(file.path)!)) }));
  const declaresGuide = sources.some((source) =>
    parse(source.text, source.path).ast.records.some((record) => record.discriminator === 'authoring-guide'),
  );
  const protectedAssets = manifest.files.filter((file) => file.role !== 'source' && file.path.startsWith('.ia/'));
  const raw = files.get(AUTHORING_MANIFEST_PATH);
  if (!declaresGuide && !protectedAssets.length && !raw) return;
  const refuse = (): never =>
    fail('CLOSURE-INVALID', 'Authoring asset closure is missing, partial, external or inconsistent');
  if (!raw || raw.length > RESOURCE_LIMITS.metadataBytes || manifest.dependencies.length) return refuse();
  let reader: EditorSnapshot | undefined;
  try {
    const selection = decodeDistributionJson(utf8(Buffer.from(raw))) as Record<string, unknown>;
    if (!selection || typeof selection !== 'object') return refuse();
    const selectedRows = selection['files'];
    if (!Array.isArray(selectedRows) || selectedRows.length > RESOURCE_LIMITS.files) return refuse();
    const selectedFiles: { path: string; content: string }[] = selectedRows.map((file: unknown) => {
      if (!file || typeof file !== 'object' || typeof (file as Record<string, unknown>)['path'] !== 'string') refuse();
      const path = (file as { path: string }).path,
        bytes = files.get(path);
      if (!bytes) return refuse();
      return { path, content: utf8(Buffer.from(bytes)) };
    });
    const protectedSelection = selectedFiles
      .filter((file) => file.path.startsWith('.ia/'))
      .map((file) => file.path)
      .sort();
    const protectedPayload = protectedAssets
      .filter((file) => file.path !== AUTHORING_MANIFEST_PATH)
      .map((file) => file.path)
      .sort();
    if (JSON.stringify(protectedSelection) !== JSON.stringify(protectedPayload)) refuse();
    const body = {
      version: 1 as const,
      id: 'archive',
      floorOrigin: 'embedded' as const,
      folders: manifest.systems.map((system) => system.name),
      sources: [
        ...KERNEL_SOURCES.map((source) => ({
          ...source,
          location: {
            placement: { kind: 'floor' as const, band: 10 as const, reach: '' },
            provenance: 'bootstrap' as const,
          },
        })),
        ...sources.map((source) => ({
          ...source,
          location: {
            placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
            provenance: 'workspace' as const,
          },
        })),
      ],
    };
    const capture: Capture = verifyCapture({ ...body, revision: digest(body) });
    reader = new EditorSnapshot({
      root: '.',
      sources: capture.sources,
      folders: capture.folders,
      floorOrigin: capture.floorOrigin,
      fingerprint: capture.revision,
    });
    if (
      reader.refused.length ||
      reader.inspect().blockedSystems.length ||
      reader.report.findings.some((finding) => finding.severity === 'error')
    )
      refuse();
    const captured = captureAuthoringManifestBytes(capture, {
      sources: [
        {
          source: capture.id,
          revision: capture.revision,
          imports: [{ alias: 'floor', source: capture.id, revision: capture.revision }],
          manifest: selection,
          files: selectedFiles,
        },
      ],
    });
    const registry = reader.inspect().graph.registry;
    const view = resolveAuthoring(capture, captured.resources, captured.index, {
      reader,
      within: reader.resolveScope().token,
      allowedResources: captured.resources.files.map((file) => file.key),
      allowedSystems: [...registry.systems.keys(), 'floor'],
      allowedRegistrations: [...registry.registrations.keys()],
      allowedArtifacts: captured.index.artifacts.map((artifact) => artifact.id),
      allowedDocuments: captured.index.documents.map((document) => document.id),
    });
    const guides = reader.records().filter((record) => record.discriminator === 'authoring-guide');
    if (
      (declaresGuide && !guides.length) ||
      guides.some(
        (record) =>
          !view.guides.some(
            (guide) =>
              guide.status === 'resolved' &&
              guide.descriptor?.identity === record.identity &&
              guide.descriptor.path === record.source.path &&
              guide.descriptor.line === record.source.line,
          ),
      )
    )
      refuse();
  } catch {
    refuse();
  } finally {
    reader?.close();
  }
}

/** Bound to the exact selected archive generation, never a standalone readiness claim. */
export function verifySelectedAuthoringAssetClosure(
  lock: DistributionLock,
  releases: ReadonlyMap<
    string,
    {
      readonly manifest: BundleManifest;
      readonly files: ReadonlyMap<string, Buffer>;
      readonly archiveDigest: string;
      readonly manifestDigest: string;
    }
  >,
): void {
  for (const pkg of lock.packages) {
    const needed = new Set<string>();
    const visit = (id: string): void => {
      if (needed.has(id)) return;
      needed.add(id);
      const selected = lock.packages.find((row) => row.id === id);
      if (!selected) fail('CLOSURE-INVALID', 'Missing selected dependency');
      selected.dependencies.forEach(visit);
    };
    visit(pkg.id);
    // An unrelated requested package must not satisfy an undeclared guide/schema dependency.
    verifyAuthoringSelection(
      {
        ...lock,
        requests: [{ id: pkg.id, range: pkg.version }],
        packages: lock.packages.filter((row) => needed.has(row.id)),
      },
      new Map([...releases].filter(([id]) => needed.has(id))),
    );
  }
}

function verifyAuthoringSelection(
  lock: DistributionLock,
  releases: ReadonlyMap<
    string,
    {
      readonly manifest: BundleManifest;
      readonly files: ReadonlyMap<string, Buffer>;
      readonly archiveDigest: string;
      readonly manifestDigest: string;
    }
  >,
): void {
  const inputs = deriveGenerationInputs(lock, releases);
  const pointer = {
    formatVersion: 1 as const,
    generation: generationDigest(lock, inputs, installationWorkspace(lock, inputs, releases)),
    previous: null,
    counter: 1,
  };
  const body = {
    version: 1 as const,
    id: 'selected-archives',
    floorOrigin: 'embedded' as const,
    folders: inputs.systems.map((system) => system.name),
    activation: pointer,
    sources: [
      ...KERNEL_SOURCES.map((source) => ({
        ...source,
        location: {
          placement: { kind: 'floor' as const, band: 10 as const, reach: '' },
          provenance: 'bootstrap' as const,
        },
      })),
      ...generationSources(pointer, lock, inputs, releases),
    ],
  };
  const capture = verifyCapture({ ...body, revision: digest(body) });
  const reader = new EditorSnapshot({ root: '', ...capture, fingerprint: capture.revision });
  const refuse = (): never =>
    fail('CLOSURE-INVALID', 'Selected authoring asset closure is missing, partial, external or inconsistent');
  try {
    if (
      reader.refused.length ||
      reader.inspect().blockedSystems.length ||
      reader.report.findings.some((finding) => finding.severity === 'error')
    )
      refuse();
    const native = resourceOccurrences(capture),
      sources: AuthoringManifestByteSource[] = [];
    for (const release of releases.values()) {
      const { manifest, files } = release;
      const guides = manifest.files
        .filter((file) => file.role === 'source')
        .some((file) =>
          parse(utf8(Buffer.from(files.get(file.path)!)), file.path).ast.records.some(
            (record) => record.discriminator === 'authoring-guide',
          ),
        );
      const protectedAssets = manifest.files.filter((file) => file.role !== 'source' && file.path.startsWith('.ia/'));
      const raw = files.get(AUTHORING_MANIFEST_PATH);
      if (!guides && !protectedAssets.length && !raw) continue;
      if (!raw || raw.length > RESOURCE_LIMITS.metadataBytes) return refuse();
      const selection = decodeDistributionJson(utf8(Buffer.from(raw))) as Record<string, unknown>;
      const rows = selection['files'];
      if (!Array.isArray(rows) || rows.length > RESOURCE_LIMITS.files) return refuse();
      const selected = rows.map((row: unknown) => {
        if (!row || typeof row !== 'object' || typeof (row as Record<string, unknown>)['path'] !== 'string') refuse();
        const path = (row as { path: string }).path,
          bytes = files.get(path);
        if (!bytes) return refuse();
        return { path, content: utf8(Buffer.from(bytes)) };
      });
      if (
        JSON.stringify(
          selected
            .filter((file) => file.path.startsWith('.ia/'))
            .map((file) => file.path)
            .sort(),
        ) !==
        JSON.stringify(
          protectedAssets
            .filter((file) => file.path !== AUTHORING_MANIFEST_PATH)
            .map((file) => file.path)
            .sort(),
        )
      )
        refuse();
      const first = manifest.files.find((file) => file.role === 'source');
      if (!first) return refuse();
      const binding = native.sourceRevisions.find(
        (source) =>
          nativeResourcePath(capture, { ...source, path: first.path }) ===
          `.ia/distributions/store/${release.archiveDigest}/${first.path}`,
      );
      if (!binding) return refuse();
      // No dependency asset imports: every protected guide/resource must be owned
      // and pinned by its own archive. Only immutable floor identity is shared.
      sources.push({
        ...binding,
        imports: [{ alias: 'floor', source: capture.id, revision: capture.revision }],
        manifest: selection,
        files: selected,
      });
    }
    if (!sources.length) return;
    const captured = captureAuthoringManifestBytes(capture, { sources });
    const registry = reader.inspect().graph.registry;
    const view = resolveAuthoring(capture, captured.resources, captured.index, {
      reader,
      within: reader.resolveScope().token,
      allowedResources: captured.resources.files.map((file) => file.key),
      allowedSystems: [...registry.systems.keys(), 'floor'],
      allowedRegistrations: [...registry.registrations.keys()],
      allowedArtifacts: captured.index.artifacts.map((artifact) => artifact.id),
      allowedDocuments: captured.index.documents.map((document) => document.id),
    });
    for (const guide of reader.records().filter((record) => record.discriminator === 'authoring-guide')) {
      if (
        !view.guides.some(
          (item) =>
            item.status === 'resolved' &&
            item.descriptor?.identity === guide.identity &&
            nativeResourcePath(capture, item.descriptor) === guide.source.path &&
            item.descriptor.line === guide.source.line,
        )
      )
        refuse();
    }
  } catch {
    refuse();
  } finally {
    reader.close();
  }
}
