import {
  decodeActivationPointer,
  decodeBundleManifest,
  decodeDistributionLock,
  decodeGenerationInputs,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  generationSources,
  satisfies,
} from '@ia/db/distribution';
import { copy } from '@ia/session-system';
import type {
  ActivationPointer,
  BundleManifest,
  DistributionLock,
  ExpandedBundle,
  GenerationInputs,
} from '@ia/db/distribution';
import type { Capture } from './corpus.js';

export interface SourceInstallation {
  readonly pointer: ActivationPointer;
  readonly lock: DistributionLock;
  readonly inputs: GenerationInputs;
  readonly bundles: ReadonlyMap<string, ExpandedBundle>;
}
export interface RetainedSourceInstallation {
  readonly pointer: ActivationPointer;
  readonly lock: DistributionLock;
  readonly inputs: GenerationInputs;
  readonly bundles: readonly {
    readonly id: string;
    readonly manifest: BundleManifest;
    readonly archiveDigest: string;
    readonly manifestDigest: string;
    readonly files: readonly { readonly path: string; readonly base64: string }[];
  }[];
}
// This hosted retained-policy profile is narrower than the native 256 MiB expanded archive limit.
export const SOURCE_INSTALLATION_BYTES = 32 * 1024 * 1024;
function fail(): never {
  throw new Error('Invalid retained source installation');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const names = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    names.length !== keys.length ||
    names.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail();
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((row) => !Object.hasOwn(row, 'value'))
  )
    fail();
  return value;
}
const hash = (value: unknown): string => (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail());

/** Decode retained data, then delegate all native membership and payload verification to the native owner. */
export function readSourceInstallation(value: unknown): SourceInstallation & { readonly sources: Capture['sources'] } {
  const row = object(value, ['pointer', 'lock', 'inputs', 'bundles']);
  const pointer = decodeActivationPointer(row['pointer']),
    lock = decodeDistributionLock(row['lock']),
    inputs = decodeGenerationInputs(row['inputs']);
  if (!satisfies(DISTRIBUTION_ENGINE_VERSION, lock.engine)) fail();
  const bundles = new Map<string, ExpandedBundle>();
  let total = 0,
    count = 0,
    previous = '';
  for (const entry of array(row['bundles'], DISTRIBUTION_LIMITS.bundles)) {
    const bundle = object(entry, ['id', 'manifest', 'archiveDigest', 'manifestDigest', 'files']);
    const manifest = decodeBundleManifest(bundle['manifest']),
      id = bundle['id'];
    if (id !== manifest.id || id <= previous) fail();
    previous = id;
    const files = new Map<string, Buffer>();
    let pathBefore = '';
    for (const item of array(bundle['files'], DISTRIBUTION_LIMITS.files)) {
      const file = object(item, ['path', 'base64']),
        path = file['path'],
        base64 = file['base64'];
      if (
        ++count > DISTRIBUTION_LIMITS.files ||
        typeof path !== 'string' ||
        path <= pathBefore ||
        typeof base64 !== 'string' ||
        base64.length > Math.ceil(DISTRIBUTION_LIMITS.file / 3) * 4
      )
        fail();
      const pin = manifest.files.find((pin) => pin.path === path);
      if (!pin || (total += pin.bytes) > SOURCE_INSTALLATION_BYTES || base64.length !== Math.ceil(pin.bytes / 3) * 4)
        fail();
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64 || bytes.length !== pin.bytes) fail();
      files.set(path, bytes);
      pathBefore = path;
    }
    bundles.set(id, {
      manifest,
      archiveDigest: hash(bundle['archiveDigest']),
      manifestDigest: hash(bundle['manifestDigest']),
      files,
    });
  }
  if (bundles.size !== lock.packages.length || lock.packages.some((pkg) => !bundles.has(pkg.id))) fail();
  return { pointer, lock, inputs, bundles, sources: generationSources(pointer, lock, inputs, bundles) };
}

/** Synchronous copy occurs before callers can mutate file buffers, maps, metadata or activation. */
export function retainSourceInstallation(value: SourceInstallation): RetainedSourceInstallation {
  const data: RetainedSourceInstallation = {
    pointer: value.pointer,
    lock: value.lock,
    inputs: value.inputs,
    bundles: [...value.bundles]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, bundle]) => ({
        id,
        manifest: bundle.manifest,
        archiveDigest: bundle.archiveDigest,
        manifestDigest: bundle.manifestDigest,
        files: [...bundle.files]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })),
      })),
  };
  readSourceInstallation(data);
  // Native metadata decoders return closed detached values; JSON detaches the complete retained envelope.
  return copy(data);
}
