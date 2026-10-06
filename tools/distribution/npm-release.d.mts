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
