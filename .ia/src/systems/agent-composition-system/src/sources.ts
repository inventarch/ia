import { createHash } from 'node:crypto';
import { stableSerialize } from '@ia/graph';
import { PROVENANCES } from '@ia/language';
import { EditorSnapshot } from '@ia/db/editor';
import type { ActivationPointer } from '@ia/db/distribution';
import { copy, digest } from '@ia/session-system';
import { adoptWorkspace, captureWorkspace, verifyCapture } from './corpus.js';
import type { Capture } from './corpus.js';
import { installedImplementationDigest } from './installed-catalog.js';
import {
  readSourceInstallation,
  retainSourceInstallation,
  type RetainedSourceInstallation,
  type SourceInstallation,
} from './installed-source-policy.js';
export { readSourceInstallation, SOURCE_INSTALLATION_BYTES } from './installed-source-policy.js';
export type { RetainedSourceInstallation, SourceInstallation } from './installed-source-policy.js';

export interface SourcePolicyV1 {
  version: 1;
  validator: string;
  foundation: ReturnType<typeof adoptWorkspace>;
  floor: Capture['sources'];
}
export interface SourcePolicyV2 extends Omit<SourcePolicyV1, 'version'> {
  version: 2;
  installation: RetainedSourceInstallation;
}
export type SourcePolicy = SourcePolicyV1 | SourcePolicyV2;
export interface SourceAdmission {
  ok: boolean;
  revision: string;
  refused: number;
  diagnostics: { code: string; path: string; line: number }[];
  unavailableChecks: string[];
}
export class SourceCompositionError extends Error {
  readonly code = 'composition-conflict';
  constructor(message: string) {
    super(message);
    this.name = 'SourceCompositionError';
  }
}
const invalid = (message: string): never => {
  throw new SourceCompositionError(message);
};
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    invalid('Invalid retained source policy');
  const names = Reflect.ownKeys(value as object),
    descriptors = Object.getOwnPropertyDescriptors(value as object);
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
    invalid('Invalid retained source policy');
  return value as Record<string, unknown>;
}
function sourceShape(value: unknown): asserts value is Capture['sources'][number] {
  const record = (value: unknown): Record<string, unknown> => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      invalid('Invalid retained floor source shape');
    return value as Record<string, unknown>;
  };
  const source = record(value),
    location = record(source['location']),
    placement = record(location['placement']);
  if (
    typeof source['path'] !== 'string' ||
    typeof source['text'] !== 'string' ||
    !PROVENANCES.some((provenance) => provenance === location['provenance']) ||
    placement['kind'] !== 'floor' ||
    placement['band'] !== 10 ||
    placement['reach'] !== ''
  )
    invalid('Invalid retained floor source shape');
}
/** The shared capture owner validates native source paths, placement, bounds and exact UTF-8. */
export function verifySourcePolicy(input: unknown): SourcePolicy {
  const version =
    input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'version')?.value : undefined;
  const policy = closed(input, [
    'version',
    'validator',
    'foundation',
    'floor',
    ...(version === 2 ? ['installation'] : []),
  ]);
  const foundation = closed(policy['foundation'], ['id', 'revision', 'sources']);
  if (
    (version !== 1 && version !== 2) ||
    typeof policy['validator'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(policy['validator']) ||
    typeof foundation['id'] !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(foundation['id']) ||
    !Array.isArray(foundation['sources']) ||
    !Array.isArray(policy['floor'])
  )
    invalid('Invalid retained source policy');
  const sources = (foundation['sources'] as unknown[]).map((entry: unknown) => {
    const row = closed(entry, ['path', 'text']);
    if (typeof row['path'] !== 'string' || typeof row['text'] !== 'string')
      invalid('Invalid retained foundation source');
    return { path: row['path'] as string, text: row['text'] as string };
  });
  if (createHash('sha256').update(stableSerialize(sources)).digest('hex') !== foundation['revision'])
    invalid('Foundation bytes differ from their pinned revision');
  const floor = (policy['floor'] as unknown[]).map((value) => {
    sourceShape(value);
    return value;
  });
  const body = {
    version: 1 as const,
    id: 'retained-policy',
    folders: [],
    floorOrigin: 'explicit' as const,
    sources: [
      ...floor,
      ...sources.map((source) => ({
        ...source,
        location: {
          placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
          provenance: 'workspace' as const,
        },
      })),
    ],
  };
  verifyCapture({ ...body, revision: digest(body) });
  const base = copy({
    version: 1,
    validator: policy['validator'],
    foundation: { id: foundation['id'], revision: foundation['revision'], sources },
    floor,
  }) as SourcePolicyV1;
  if (version === 1) return base;
  try {
    const installed = readSourceInstallation(policy['installation']);
    captured('retained-installation', [...floor, ...installed.sources], installed.pointer);
    return { ...base, version: 2, installation: retainSourceInstallation(installed) };
  } catch {
    return invalid('Invalid installed source policy');
  }
}
export function createSourcePolicy(
  foundation: string,
  options: { id?: string; validator?: string } = {},
): SourcePolicyV1 {
  return verifySourcePolicy({
    version: 1,
    validator: options.validator ?? installedImplementationDigest(),
    foundation: adoptWorkspace(foundation, options.id ?? 'foundation'),
    floor: captureWorkspace(foundation).sources.filter((source) => source.location.placement.kind === 'floor'),
  }) as SourcePolicyV1;
}
export function createInstalledSourcePolicy(base: SourcePolicy, installation: SourceInstallation): SourcePolicyV2 {
  const { validator, foundation, floor } = verifySourcePolicy(base);
  return verifySourcePolicy({
    version: 2,
    validator,
    foundation,
    floor,
    installation: retainSourceInstallation(installation),
  }) as SourcePolicyV2;
}
function captured(id: string, sources: Capture['sources'], activation?: ActivationPointer): Capture {
  const folders = [
    ...new Set(
      sources.flatMap((source) => {
        const match = /\/src\/systems\/([^/]+)\//.exec(source.path);
        return match?.[1] ? [match[1]] : [];
      }),
    ),
  ].sort();
  const body = {
    version: 1 as const,
    id,
    sources: [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    folders,
    floorOrigin: 'explicit' as const,
    ...(activation ? { activation } : {}),
  };
  return verifyCapture({ ...body, revision: digest(body) });
}
const adopted = {
  placement: { kind: 'adopted' as const, band: 90 as const, reach: '' },
  provenance: 'methodology' as const,
};
function dependencies(policy: SourcePolicy): Capture['sources'] {
  if (policy.version === 2) return readSourceInstallation(policy.installation).sources;
  return policy.foundation.sources.map((source) => ({
    ...source,
    path: `.ia/adopted/${policy.foundation.id}/${policy.foundation.revision}/${source.path}`,
    location: adopted,
  }));
}
export function homeSourceCapture(
  workspace: string,
  sources: { path: string; text: string }[],
  input: SourcePolicy,
): Capture {
  const policy = verifySourcePolicy(input);
  return captured(
    workspace,
    [
      ...policy.floor,
      ...dependencies(policy),
      ...sources.map((source) => ({
        ...source,
        location: {
          placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
          provenance: 'workspace' as const,
        },
      })),
    ],
    policy.version === 2 ? policy.installation.pointer : undefined,
  );
}
export function admitSourceCapture(capture: Capture): SourceAdmission {
  verifyCapture(capture);
  const reader = new EditorSnapshot({
    root: process.cwd(),
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  try {
    const view = reader.inspect(),
      errors = reader.report.findings.filter((finding) => finding.severity === 'error');
    return {
      ok: errors.length === 0 && reader.refused.length === 0 && view.blockedSystems.length === 0,
      revision: reader.revision,
      refused: reader.refused.length,
      diagnostics: errors.slice(0, 100).map(({ code, path, line }) => ({ code, path, line })),
      unavailableChecks: [
        ...new Set(
          reader.report.verdicts
            .filter((verdict) => verdict.outcome === 'not-evaluated')
            .map((verdict) => verdict.check),
        ),
      ].sort(),
    };
  } finally {
    reader.close();
  }
}
function nativeMount(sources: Capture['sources'], mountId: string): Capture['sources'] {
  const files = sources
    .map(({ path, text }) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Resource identity follows adoptWorkspace: the ledger's request/policy/actor commitment stays in the separate source pin.
  const revision = createHash('sha256').update(stableSerialize(files)).digest('hex');
  return files.map((source) => ({
    ...source,
    path: `.ia/adopted/${mountId}/${revision}/${source.path}`,
    location: adopted,
  }));
}
export function mountSourceCapture(
  project: Capture,
  home: Capture,
  revision: string,
  input: SourcePolicy,
  mountId = 'workspace',
): Capture {
  const policy = verifySourcePolicy(input);
  verifyCapture(project);
  verifyCapture(home);
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(mountId) ||
    !/^[a-f0-9]{64}$/.test(revision) ||
    mountId === policy.foundation.id ||
    mountId === project.id
  )
    invalid('Invalid source mount identity');
  const floors = project.sources.filter((source) => source.location.placement.kind === 'floor');
  if (
    digest(floors) !== digest(policy.floor) ||
    digest(home.sources.filter((source) => source.location.placement.kind === 'floor')) !== digest(policy.floor)
  )
    invalid('Project and source floor policies differ');
  if (policy.version === 2) return mountInstalled(project, home, policy, mountId);
  if (project.activation || home.activation) invalid('Installed capture requires an installed source policy');
  const sources = [...project.sources],
    prefix = `.ia/adopted/${policy.foundation.id}/${policy.foundation.revision}/`;
  const direct = policy.foundation.sources.every((source) =>
    sources.some(
      (existing) =>
        existing.path === source.path &&
        existing.text === source.text &&
        existing.location.placement.kind === 'authored',
    ),
  );
  const mounted = policy.foundation.sources.every((source) =>
    sources.some(
      (existing) =>
        existing.path === prefix + source.path &&
        existing.text === source.text &&
        existing.location.placement.kind === 'adopted',
    ),
  );
  if (!direct && !mounted) sources.push(...dependencies(policy));
  if (sources.some((source) => source.path.startsWith(`.ia/adopted/${mountId}/`)))
    invalid('A source mount with this identity is already present');
  sources.push(
    ...nativeMount(
      home.sources.filter((source) => source.location.placement.kind === 'authored'),
      mountId,
    ),
  );
  const result = captured(project.id, sources);
  if (!admitSourceCapture(result).ok) invalid('The source revision is not admitted in this project closure');
  return result;
}

function mountInstalled(project: Capture, home: Capture, policy: SourcePolicyV2, mountId: string): Capture {
  const installed = readSourceInstallation(policy.installation),
    pointer = installed.pointer;
  if (
    digest(home.activation ?? null) !== digest(pointer) ||
    (project.activation && digest(project.activation) !== digest(pointer))
  )
    invalid('Project and source installation policies differ');
  const expected = new Map(installed.sources.map((source) => [source.path, source]));
  for (const capture of [project, home])
    for (const source of capture.sources)
      if (source.path.startsWith('.ia/distributions/')) {
        if (!capture.activation || digest(expected.get(source.path) ?? null) !== digest(source))
          invalid('Unproven installed source bytes');
      }
  for (const source of installed.sources)
    if (!home.sources.some((row) => row.path === source.path && digest(row) === digest(source)))
      invalid('Home capture has an incomplete installed view');
  const prefix = `.ia/adopted/${policy.foundation.id}/${policy.foundation.revision}/`;
  const baseline = new Map(policy.foundation.sources.map((source) => [source.path, source.text]));
  const sources = project.sources.filter((source) => {
    if (source.path.startsWith('.ia/distributions/')) return false;
    // Only exact unchanged baseline copies are replaced. Authored changes remain authored overrides.
    if (source.location.placement.kind === 'authored' && baseline.get(source.path) === source.text) return false;
    if (
      source.location.placement.kind === 'adopted' &&
      source.path.startsWith(prefix) &&
      baseline.get(source.path.slice(prefix.length)) === source.text
    )
      return false;
    return true;
  });
  if (sources.some((source) => source.path.startsWith(`.ia/adopted/${mountId}/`)))
    invalid('A source mount with this identity is already present');
  sources.push(
    ...installed.sources,
    ...nativeMount(
      home.sources.filter(
        (source) => source.location.placement.kind === 'authored' && source.path.startsWith('.ia/src/'),
      ),
      mountId,
    ),
  );
  const result = captured(project.id, sources, pointer);
  if (!admitSourceCapture(result).ok) invalid('The installed source revision is not admitted in this project closure');
  return result;
}
