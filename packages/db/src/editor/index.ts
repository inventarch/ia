import { createHash } from 'node:crypto';
import { canonicalRoot, stableSerialize } from '@ia/graph';
import type { RevisionSource } from '@ia/graph';
import type { Location } from '@ia/language';
import { DbError } from '../errors.js';
import { Reader } from '../handle.js';
import type { ReadOptions } from '../handle.js';
import { inputOptions, pathKey, readInputs, safePath } from '../inputs.js';
import type { InputOptions, InputSnapshot } from '../inputs.js';
import { viewBuilder } from '../view.js';
import type { View } from '../view.js';
import type { LockedPackage } from '../distribution/contracts.js';
export type { ReadOptions, ReadHandle } from '../handle.js';
export type { InputOptions } from '../inputs.js';

export interface Overlay {
  readonly path: string;
  readonly text: string | null;
  readonly version: number;
}
export interface EditorSource extends RevisionSource {
  readonly origin: 'local' | 'embedded' | 'explicit' | 'adopted' | 'installed';
  readonly writable: boolean;
  readonly dirty: boolean;
  readonly version?: number;
  readonly hash: string;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function overlayInputs(
  input: InputSnapshot,
  changes: readonly Overlay[],
  locations: Readonly<Record<string, Location>> = {},
): InputSnapshot {
  const sources = new Map(input.sources.map((s) => [pathKey(s.path), s])),
    seen = new Set<string>();
  for (const change of changes) {
    const path = canonicalRoot(change.path),
      key = pathKey(path),
      previous = sources.get(key);
    if (
      path !== change.path ||
      !path.startsWith('.ia/src/') ||
      !path.endsWith('.ia') ||
      /[\u0000-\u001f<>:"|?*]/.test(path) ||
      !Number.isSafeInteger(change.version) ||
      change.version < 0 ||
      seen.has(key) ||
      (previous !== undefined && previous.path !== path) ||
      (change.text !== null &&
        (typeof change.text !== 'string' || Buffer.from(change.text).toString('utf8') !== change.text))
    )
      throw new DbError('IA-DB-DRAFT-INVALID', 'Invalid, duplicate or aliased editor overlay');
    safePath(input.root, path);
    seen.add(key);
    if (pathKey(path).startsWith('.ia/src/floor/') && input.floorOrigin !== 'local')
      throw new DbError('IA-DB-DRAFT-INVALID', 'Virtual floor sources are read-only');
    if (previous !== undefined && previous.location.provenance !== 'workspace' && !key.startsWith('.ia/src/floor/'))
      throw new DbError('IA-DB-DRAFT-INVALID', 'Non-workspace sources are read-only');
    if (change.text === null) {
      sources.delete(key);
      continue;
    }
    const location: Location =
      previous?.location ??
      locations[key] ??
      (key.startsWith('.ia/src/floor/')
        ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
        : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' });
    sources.set(key, Object.freeze({ path, text: change.text, location }));
  }
  const ordered = Object.freeze([...sources.values()].sort((a, b) => a.path.localeCompare(b.path)));
  // A buffer may add a file to an existing or new system folder; disk refresh owns removal of empty directories.
  const folders = Object.freeze(
    [
      ...new Set([
        ...input.folders,
        ...ordered.flatMap((s) => (s.path.startsWith('.ia/src/systems/') ? [s.path.split('/')[3]!] : [])),
      ]),
    ].sort(),
  );
  return Object.freeze({
    ...input,
    sources: ordered,
    folders,
    fingerprint: digest(
      stableSerialize({
        sources: ordered,
        folders,
        floorOrigin: input.floorOrigin,
        ...(input.activation ? { activation: input.activation } : {}),
      }),
    ),
  });
}

/** Privileged local inspection. This type is not exported by the remote Door. */
export class EditorSnapshot extends Reader {
  readonly sources: readonly EditorSource[];
  readonly installed: readonly LockedPackage[];
  constructor(input: InputSnapshot, changes: readonly Overlay[] = [], options: InputOptions = {}) {
    const captured = overlayInputs(input, changes, options.locations),
      build = viewBuilder(captured),
      rootView = build();
    super(
      {
        inputs: captured,
        build,
        rootView,
        cache: { state: 'disabled', observations: [] },
        views: new Map([['["",null]', rootView]]),
      },
      options.locations,
    );
    const overlays = new Map(changes.map((c) => [pathKey(c.path), c])),
      savedSources = new Map(input.sources.map((s) => [s.path, s.text]));
    this.sources = Object.freeze(
      captured.sources.map((source) => {
        const virtual = source.path.startsWith('.ia/src/floor/') && input.floorOrigin !== 'local';
        const overlay = overlays.get(pathKey(source.path));
        const installed = source.path.startsWith('.ia/distributions/');
        return Object.freeze({
          ...source,
          origin: installed
            ? ('installed' as const)
            : source.path.startsWith('.ia/adopted/')
              ? ('adopted' as const)
              : virtual
                ? (input.floorOrigin as 'embedded' | 'explicit')
                : ('local' as const),
          writable:
            !virtual &&
            !installed &&
            (source.location.provenance === 'workspace' || source.location.placement.kind === 'floor'),
          dirty: overlay !== undefined && savedSources.get(source.path) !== source.text,
          ...(overlay === undefined ? {} : { version: overlay.version }),
          hash: digest(source.text),
        });
      }),
    );
    this.installed = captured.installed ?? [];
    Object.freeze(this);
  }
  inspect(options: Omit<ReadOptions, 'within'> = {}): View {
    return this.view(options);
  }
  candidate(changes: readonly Overlay[]): EditorSnapshot {
    return new EditorSnapshot(this.capturedInputs, changes);
  }
}

function capture(
  root: string,
  options: InputOptions,
  changes: readonly Overlay[] = [],
): { saved: InputSnapshot; current: EditorSnapshot } {
  for (let attempt = 0; attempt < 3; attempt++) {
    let current: EditorSnapshot | undefined;
    try {
      const saved = readInputs(root, options);
      current = new EditorSnapshot(saved, changes, options);
      if (readInputs(root, options).fingerprint === saved.fingerprint) return { saved, current };
    } catch (error) {
      current?.close();
      if (!(error instanceof DbError) || error.code !== 'IA-DB-SOURCE-CHANGED') throw error;
    }
    current?.close();
  }
  throw new DbError('IA-DB-SOURCE-CHANGED', 'Source inputs changed during three consecutive editor snapshot attempts');
}

/** Atomic rebuild: a failed capture never replaces a usable view. No cache is published. */
export class EditorDatabase {
  readonly root: string;
  #options: InputOptions;
  #saved: InputSnapshot;
  #current: EditorSnapshot;
  #versions = new Map<string, { version: number; text: string | null }>();
  #generation = 0;
  #closed = false;
  constructor(root: string, options: InputOptions = {}) {
    this.#options = inputOptions(options);
    const captured = capture(root, this.#options);
    this.#saved = captured.saved;
    this.root = this.#saved.root;
    this.#current = captured.current;
  }
  get generation(): number {
    return this.#generation;
  }
  get savedRevision(): string {
    return this.#saved.fingerprint;
  }
  get current(): EditorSnapshot {
    return this.#current;
  }
  update(changes: readonly Overlay[], refresh = false): EditorSnapshot {
    if (this.#closed) throw new DbError('IA-DB-CLOSED', 'Editor database is closed');
    for (const change of changes) {
      const previous = this.#versions.get(pathKey(change.path));
      if (
        previous &&
        (change.version < previous.version || (change.version === previous.version && change.text !== previous.text))
      )
        throw new DbError('IA-DB-STALE', 'Overlay version moved backwards or changed bytes without a new version');
    }
    const captured = refresh
      ? capture(this.root, this.#options, changes)
      : { saved: this.#saved, current: new EditorSnapshot(this.#saved, changes, this.#options) };
    const saved = captured.saved,
      next = captured.current;
    this.#current.close();
    this.#current = next;
    this.#saved = saved;
    this.#versions = new Map(changes.map((c) => [pathKey(c.path), { version: c.version, text: c.text }]));
    this.#generation++;
    return next;
  }
  close(): void {
    this.#closed = true;
    this.#current.close();
  }
}
