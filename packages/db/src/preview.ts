import { createHash } from 'node:crypto';
import { canonicalRoot, stableSerialize } from '@ia/graph';
import type { Node, RevisionSource } from '@ia/graph';
import type { Report } from '@ia/compliance';
import type { Location } from '@ia/language';
import { DbError } from './errors.js';
import { pathKey } from './inputs.js';
import type { InputSnapshot } from './inputs.js';
import { viewBuilder } from './view.js';
import type { RefusedRecord } from './view.js';

export interface DraftChange {
  readonly path: string;
  readonly text: string;
}
export interface DraftPreview {
  readonly baseRevision: string;
  readonly revision: string;
  readonly records: readonly Node[];
  readonly report: Report;
  readonly refused: readonly RefusedRecord[];
}
/** D12: reuse admission over an immutable in-memory source overlay. */
export function previewInputs(
  input: InputSnapshot,
  baseRevision: string,
  changes: readonly DraftChange[],
  locations: Readonly<Record<string, Location>> = {},
): DraftPreview {
  const invalid = (message: string): never => {
    throw new DbError('IA-DB-DRAFT-INVALID', message);
  };
  if (!Array.isArray(changes)) invalid('Draft changes must be an array');
  const sources = new Map(input.sources.map((s) => [pathKey(s.path), s])),
    seen = new Set<string>(),
    folders = new Set(input.folders);
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== 'object' ||
      typeof change.path !== 'string' ||
      typeof change.text !== 'string' ||
      Object.keys(change).some((k) => k !== 'path' && k !== 'text')
    )
      invalid('Each draft needs only path and text');
    let path = '';
    try {
      path = canonicalRoot(change.path);
    } catch {
      invalid('Draft path must be canonical and relative');
    }
    if (
      path !== change.path ||
      !path.startsWith('.ia/src/') ||
      !path.endsWith('.ia') ||
      pathKey(path).startsWith('.ia/src/floor/') ||
      /[\u0000-\u001f<>:"|?*]/.test(path) ||
      Buffer.from(change.text).toString('utf8') !== change.text
    )
      invalid('Draft requires a canonical non-floor IA path and valid Unicode text');
    const key = pathKey(path),
      previous = sources.get(key);
    if (seen.has(key) || (previous !== undefined && previous.path !== path))
      invalid(`Duplicate or aliased draft path: ${change.path}`);
    seen.add(key);
    const location: Location =
      previous?.location ??
      locations[key] ??
      Object.freeze({ placement: Object.freeze({ kind: 'authored', band: 100, reach: '' }), provenance: 'workspace' });
    sources.set(key, Object.freeze({ path: path, text: change.text, location }));
    const segments = path.split('/');
    if (segments[2] === 'systems' && segments.length >= 5) folders.add(segments[3]!);
  }
  const ordered: readonly RevisionSource[] = Object.freeze(
    [...sources.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  const snapshot = Object.freeze({
    ...input,
    sources: ordered,
    folders: Object.freeze([...folders].sort()),
    fingerprint: createHash('sha256')
      .update(
        stableSerialize({
          sources: ordered,
          folders: [...folders].sort(),
          floorOrigin: input.floorOrigin,
          ...(input.activation ? { activation: input.activation } : {}),
        }),
      )
      .digest('hex'),
  });
  const view = viewBuilder(snapshot)();
  return Object.freeze({
    baseRevision,
    revision: view.graph.revision,
    records: Object.freeze([...view.graph.nodes.values()]),
    report: view.report,
    refused: view.refused,
  });
}
