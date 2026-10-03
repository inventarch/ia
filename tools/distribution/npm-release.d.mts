export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access: string; registry: string };
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
  source: { repository: string; commit: string; dirty: boolean };
  packages: ReleaseArchive[];
}
export declare const REGISTRY: string;
export declare const REPOSITORY: string;
export declare const REPOSITORY_URL: string;
export declare const WORKFLOW: string;
export declare const ENVIRONMENT: string;
export declare function publicPackages(root: string): PublicPackage[];
export declare function dependencyOrder<
  T extends { manifest: { name: string; dependencies?: Record<string, string> } },
>(projects: readonly T[]): T[];
export declare function validatePackages(projects: readonly PublicPackage[], version: string): void;
export declare function writeReleaseManifest(
  root: string,
  directory: string,
  packed: readonly { name: string; filename: string }[],
): NpmRelease;
export declare function verifyRelease(root: string, directory: string, version: string): NpmRelease;
export declare function publicationPlan(
  release: Pick<NpmRelease, 'packages'>,
  registryPackages: Record<string, { versions?: Record<string, { dist?: { integrity?: string } }> } | null>,
): (ReleaseArchive & { action: 'publish' | 'skip-identical' })[];
export declare function assertPublisherEnvironment(
  release: { source: { commit: string; dirty: boolean } },
  env: Record<string, string | undefined>,
): void;
