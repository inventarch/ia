import type { ReleaseGraph } from './release-graph.mjs';
import type { ReleaseChanges } from './release-changes.mjs';
import type { publicPackageInputs } from '../release/public-pack.mjs';
/** Injected release evidence; omitted fields use the strict changeset check and the sealed descriptor. */
export interface ReleaseEvidence {
  changes?: ReleaseChanges;
  inputs?: ReturnType<typeof publicPackageInputs>;
}
export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access: string; registry: string; tag?: string };
}
export interface PublicPackage {
  directory: string;
  manifest: PackageManifest;
}
export interface ReleaseArchive {
  name: string;
  version: string;
  filename: string;
  bytes: number;
  integrity: string;
}
export interface NpmRelease {
  format: string;
  version: string;
  tag: string;
  graph: ReleaseGraph;
  baselineVersions: Record<string, string | null>;
  changeset: { path: string; sha256: string; coverageSha256: string; commits: string[] };
  source: { repository: string; commit: string; dirty: boolean };
  packages: ReleaseArchive[];
  systemCompatibility: { path: string; sha256: string };
}
export declare const REGISTRY: string;
export declare const REPOSITORY: string;
export declare const REPOSITORY_URL: string;
export declare const WORKFLOW: string;
export declare const ENVIRONMENT: string;
export declare const NPM_VERSION: string;
export declare function publicPackages(root: string): PublicPackage[];
export declare function dependencyOrder<
  T extends { manifest: { name: string; dependencies?: Record<string, string> } },
>(projects: readonly T[]): T[];
export declare function releaseVersions(
  root: string,
  inputs?: ReturnType<typeof publicPackageInputs>,
): Record<string, string>;
export declare function validatePackages(
  projects: readonly PublicPackage[],
  version: string,
  versions?: Readonly<Record<string, string>>,
): void;
export declare function publicationOrder(
  groups: ReleaseGraph['groups'],
  baselines: Readonly<Record<string, string | null>>,
): string[];
export declare function writeReleaseManifest(
  root: string,
  directory: string,
  packed: readonly { name: string; filename: string; sha256: string }[],
  evidence?: ReleaseEvidence,
): NpmRelease;
export declare function verifyRelease(
  root: string,
  directory: string,
  version: string,
  evidence?: ReleaseEvidence,
): NpmRelease;
export declare function publicationPlan(
  release: Pick<NpmRelease, 'packages' | 'version' | 'tag'> & Partial<Pick<NpmRelease, 'baselineVersions'>>,
  registryPackages: Record<string, RegistryPackage | null>,
): (ReleaseArchive & { action: 'publish' | 'skip-identical' })[];
export declare function assertPublisherEnvironment(
  release: { source: { commit: string; dirty: boolean } },
  env: Record<string, string | undefined>,
): void;

export interface RegistryPackage {
  versions?: Record<
    string,
    { dist?: { integrity?: string; tarball?: string; attestations?: { url: string; provenance: unknown } } }
  >;
  'dist-tags'?: Record<string, string>;
}
export declare function verifyRegistryCohort(
  release: Pick<NpmRelease, 'packages' | 'version' | 'tag'>,
  registryPackages: Record<string, RegistryPackage | null>,
): (ReleaseArchive & { action: 'publish' | 'skip-identical' })[];
/** How long final verification waits for npm to show every published version, and how often it looks. */
export interface RegistryVisibility {
  timeoutMs: number;
  intervalMs: number;
}
/** The bound with the delay, clock and progress log the wait uses. */
export interface RegistryWait extends RegistryVisibility {
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  log: (line: string) => void;
}
export declare const REGISTRY_VISIBILITY: Readonly<RegistryVisibility>;
/** What `verify-registry` waits with: the bound, a real delay, the monotonic `performance.now()` clock and stderr. */
export declare const REGISTRY_WAIT: Readonly<RegistryWait>;
/** The request `registryPackage` makes; `fetch` by default. */
export type RegistryRequest = (url: string, init: { signal: AbortSignal }) => Promise<Response>;
/** One packument from the npm registry, or null for a 404; any other unsuccessful status throws with its `status`. */
export declare function registryPackage(name: string, request?: RegistryRequest): Promise<RegistryPackage | null>;
/**
 * `lookup` returns null only for a 404. A timeout or abort, a network failure, or an error whose `status` is 429 or a
 * 5xx is read again within the bound; any other error refuses at once.
 */
export declare function waitForRegistryCohort(
  release: Pick<NpmRelease, 'packages' | 'version' | 'tag'>,
  lookup: (name: string) => Promise<RegistryPackage | null>,
  wait: RegistryWait,
): Promise<{
  plan: (ReleaseArchive & { action: 'publish' | 'skip-identical' })[];
  registryPackages: Record<string, RegistryPackage>;
}>;
/** Downloads each verified archive and checks its size and integrity against the release receipt. */
export declare function verifyRegistryArchives(
  plan: readonly ReleaseArchive[],
  registryPackages: Record<string, RegistryPackage>,
  request?: RegistryRequest,
): Promise<void>;
