import type { PublicPackage } from './npm-release.mjs';
export interface ReleasePolicy {
  format: string;
  version: string;
  tag: string;
  baseline: { commit: string; version: string };
  cycles: string[][];
}
export interface ChangeEntry {
  id: string;
  title: string;
  summary: string;
  packages: string[];
  paths: string[];
}
export interface Changeset {
  format: string;
  version: string;
  state: string;
  baseline: ReleasePolicy['baseline'];
  summary: string;
  packages: Record<string, { previous: string | null; kind: string; summary: string }>;
  changes: ChangeEntry[];
  coverage: { path: string; sha256: string | null; cohortOnly?: boolean; change: string }[];
}
export interface ReleaseChanges {
  policy: ReleasePolicy;
  entry: Changeset;
  path: string;
  sha256: string;
  coverageSha256: string;
  commits: string[];
}
export declare const RELEASE_POLICY: string;
export declare function sha256(bytes: string | Buffer): string;
export declare function stableVersion(version: unknown): version is string;
export declare function compareVersions(left: string, right: string): number;
export declare function releasePolicy(root: string): ReleasePolicy;
export declare function renderChangelog(entries: Changeset[]): string;
export declare function validateChangeset(
  entry: Changeset,
  policy: ReleasePolicy,
  projects: PublicPackage[],
  actualCoverage: { path: string; sha256: string | null; cohortOnly?: boolean }[],
): void;
export declare function releaseChanges(root: string, projects: PublicPackage[]): ReleaseChanges;
export declare function collectChanges(root: string, projects: PublicPackage[]): ReleaseChanges;
