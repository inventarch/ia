import { EditorSnapshot } from '@inventarch/db/editor';
import {
  decodeActivationPointer,
  decodeDistributionLock,
  decodeGenerationInputs,
  deriveGenerationInputs,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  generationDigest,
  generationSources,
  installationWorkspace,
  metadataDigest,
  satisfies,
} from '@inventarch/db/distribution';
import type { ActivationPointer, DistributionLock, GenerationInputs } from '@inventarch/db/distribution';
import { verifySelectedArchiveClosure, type VerifiedArchive } from './archive.js';
import { fail } from './files.js';
import { distributionSnapshot, verifyDistributionSnapshot, type DistributionSnapshot } from './snapshot.js';

export type InstallOperation = 'install' | 'update' | 'remove' | 'restore' | 'rollback';
export interface CurrentInstallation {
  readonly pointer: ActivationPointer | null;
  readonly lock: DistributionLock | null;
}
export interface NativeInstallationInput {
  readonly base: DistributionSnapshot;
  /** Supplied by the adapter's verified current-state reader; partial state is restore-only. */
  readonly current: CurrentInstallation | null;
  readonly lock: unknown;
  readonly archives: ReadonlyMap<string, Uint8Array>;
  readonly operation: InstallOperation;
}
export interface NativeInstallationPlan {
  readonly formatVersion: 1;
  readonly operation: InstallOperation;
  readonly engine: string;
  readonly binding: {
    readonly source: string;
    readonly active: ActivationPointer | null;
    readonly lock: DistributionLock | null;
  };
  readonly lock: DistributionLock;
  readonly pointer: ActivationPointer;
  readonly inputs: GenerationInputs;
  readonly installedSources: DistributionSnapshot['sources'];
  readonly changes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly updated: readonly string[];
    readonly shadowed: readonly string[];
  };
  readonly digest: string;
}
const operations: readonly string[] = ['install', 'update', 'remove', 'restore', 'rollback'];
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('INPUT-INVALID', 'Expected installation data');
  const names = Reflect.ownKeys(value),
    fields = Object.getOwnPropertyDescriptors(value);
  if (
    names.length !== keys.length ||
    names.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !fields[key]?.enumerable ||
        !Object.hasOwn(fields[key]!, 'value'),
    )
  )
    fail('INPUT-INVALID', 'Unexpected installation fields');
  return value as Record<string, unknown>;
}
function frozen<T>(input: T): T {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(frozen);
    Object.freeze(input);
  }
  return input;
}
function operation(input: unknown): InstallOperation {
  if (typeof input !== 'string' || !operations.includes(input)) fail('INPUT-INVALID', 'Invalid installation operation');
  return input as InstallOperation;
}
function selectedArchives(input: unknown, lock: DistributionLock): ReadonlyMap<string, VerifiedArchive> {
  if (!(input instanceof Map) || input.size !== new Set(lock.packages.map((pkg) => pkg.archive)).size)
    fail('RESTORE-REQUIRED', 'Supply the exact selected archive inventory');
  return verifySelectedArchiveClosure(lock, input);
}

/** Native installation semantics only; no path selection, storage mutation or authority grant. */
export function planInstallationSnapshot(input: NativeInstallationInput): NativeInstallationPlan {
  const row = object(input, ['base', 'current', 'lock', 'archives', 'operation']),
    base = verifyDistributionSnapshot(row['base']),
    op = operation(row['operation']);
  if (base.activation || base.sources.some((source) => source.path.startsWith('.ia/distributions/')))
    fail('INPUT-INVALID', 'Installation base must exclude the prior installed generation');
  const current = row['current'] === null ? { pointer: null, lock: null } : object(row['current'], ['pointer', 'lock']);
  const previous = current['pointer'] === null ? null : decodeActivationPointer(current['pointer']),
    previousLock = current['lock'] === null ? null : decodeDistributionLock(current['lock']);
  if (op !== 'restore' && (previous === null) !== (previousLock === null))
    fail('RESTORE-REQUIRED', 'Current installation requires explicit recovery or restore');
  const lock = decodeDistributionLock(row['lock']);
  if (!satisfies(DISTRIBUTION_ENGINE_VERSION, lock.engine)) fail('CONFLICT', 'Lock engine compatibility differs');
  const releases = selectedArchives(row['archives'], lock),
    inputs = deriveGenerationInputs(lock, releases);
  const pointer = decodeActivationPointer({
    formatVersion: 1,
    generation: generationDigest(lock, inputs, installationWorkspace(lock, inputs, releases)),
    previous: previous?.generation ?? null,
    counter: (previous?.counter ?? 0) + 1,
  });
  const installedSources = [...generationSources(pointer, lock, inputs, releases)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const candidate = distributionSnapshot({
    sources: [...base.sources, ...installedSources],
    folders: [...new Set([...base.folders, ...inputs.systems.map((system) => system.name)])].sort(),
    floorOrigin: base.floorOrigin,
    activation: pointer,
  });
  const reader = new EditorSnapshot({ root: '', ...candidate });
  let shadowed: readonly string[];
  try {
    const view = reader.inspect(),
      errors = reader.report.findings.filter((finding) => finding.severity === 'error');
    if (errors.length || reader.refused.length || view.blockedSystems.length)
      fail(
        'ADMISSION-FAILED',
        errors.length ? JSON.stringify(errors) : 'Native candidate contains refused records or blocked systems',
      );
    shadowed = view.graph.shadows.map((shadow) => shadow.identity).sort();
  } finally {
    reader.close();
  }
  const old = previousLock?.packages ?? [],
    changes = {
      added: lock.packages.filter((pkg) => !old.some((prior) => prior.id === pkg.id)).map((pkg) => pkg.id),
      removed: old.filter((pkg) => !lock.packages.some((next) => next.id === pkg.id)).map((pkg) => pkg.id),
      updated: lock.packages
        .filter((pkg) => old.some((prior) => prior.id === pkg.id && prior.archive !== pkg.archive))
        .map((pkg) => pkg.id),
      shadowed,
    };
  const body = {
    formatVersion: 1 as const,
    operation: op,
    engine: DISTRIBUTION_ENGINE_VERSION,
    binding: { source: base.fingerprint, active: previous, lock: previousLock },
    lock,
    pointer,
    inputs,
    installedSources,
    changes,
  };
  return frozen({ ...body, digest: metadataDigest(body) });
}

function decodePlan(input: unknown): NativeInstallationPlan {
  const row = object(input, [
    'formatVersion',
    'operation',
    'engine',
    'binding',
    'lock',
    'pointer',
    'inputs',
    'installedSources',
    'changes',
    'digest',
  ]);
  if (row['formatVersion'] !== 1 || row['engine'] !== DISTRIBUTION_ENGINE_VERSION)
    fail('INPUT-INVALID', 'Invalid installation plan version/engine');
  const binding = object(row['binding'], ['source', 'active', 'lock']);
  if (typeof binding['source'] !== 'string' || !/^[a-f0-9]{64}$/.test(binding['source']))
    fail('INPUT-INVALID', 'Invalid source fingerprint');
  const pointer = decodeActivationPointer(row['pointer']),
    inputs = decodeGenerationInputs(row['inputs']);
  const installedSources = distributionSnapshot({
    sources: row['installedSources'],
    folders: inputs.systems.map((system) => system.name),
    floorOrigin: 'explicit',
    activation: pointer,
  }).sources;
  const changes = object(row['changes'], ['added', 'removed', 'updated', 'shadowed']);
  const entries = (value: unknown): readonly string[] => {
    if (
      !Array.isArray(value) ||
      value.length > DISTRIBUTION_LIMITS.files ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !Object.hasOwn(field, 'value')) ||
      value.some(
        (item) => typeof item !== 'string' || !item || Buffer.byteLength(item) > 1024 || /[\u0000-\u001f]/.test(item),
      )
    )
      fail('INPUT-INVALID', 'Invalid installation changes');
    return [...value] as string[];
  };
  const body = {
    formatVersion: 1 as const,
    operation: operation(row['operation']),
    engine: DISTRIBUTION_ENGINE_VERSION,
    binding: {
      source: binding['source'],
      active: binding['active'] === null ? null : decodeActivationPointer(binding['active']),
      lock: binding['lock'] === null ? null : decodeDistributionLock(binding['lock']),
    },
    lock: decodeDistributionLock(row['lock']),
    pointer,
    inputs,
    installedSources,
    changes: {
      added: entries(changes['added']),
      removed: entries(changes['removed']),
      updated: entries(changes['updated']),
      shadowed: entries(changes['shadowed']),
    },
  };
  if (row['digest'] !== metadataDigest(body)) fail('INPUT-INVALID', 'Installation plan digest differs');
  return frozen({ ...body, digest: row['digest'] as string });
}

/** Return freshly derived immutable evidence; the supplied plan never becomes execution authority. */
export function revalidateInstallationSnapshot(
  approved: unknown,
  input: NativeInstallationInput,
): NativeInstallationPlan {
  const plan = decodePlan(approved),
    current = planInstallationSnapshot(input);
  if (plan.digest !== current.digest) fail('STALE-PLAN', 'Installation bindings changed; create a fresh plan');
  return current;
}
