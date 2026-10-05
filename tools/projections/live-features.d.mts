// Types for live-features.mjs, so tsconfig.tools.json can check its test.
export type FeatureStatus = 'unsupported' | 'generated' | 'process' | 'live-host';
export declare const STATUSES: readonly FeatureStatus[];
export declare const MATRIX_FORMAT: 'ia.host-feature-matrix.v1';
export interface FeatureEvidence {
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  installed: Record<string, unknown> | null;
  observation: string | null;
  [key: string]: unknown;
}
export interface FeatureRow {
  feature: string;
  host: string;
  hostVersion: string | null;
  profileDigest: string | null;
  os: string;
  runtime: string;
  status: string;
  evidence: FeatureEvidence;
}
export interface FeatureInventory {
  digest: string;
  features: readonly { id: string; requiredHosts: readonly string[] }[];
}
export interface HostFeatureMatrix {
  format: 'ia.host-feature-matrix.v1';
  inventoryDigest: string;
  rows: FeatureRow[];
  digest: string;
}
export interface CarryExpectation {
  text?: string;
  command?: string;
  argument?: string;
  prompt: string;
}
export interface ManifestKey {
  source: string;
  revision: string;
  path: string;
}
export interface ProductManifest {
  resourcesDigest: string;
  outputs: readonly { path: string; role: string; sha256: string; resources: readonly ManifestKey[] }[];
}
export interface ResolvedProduct {
  outputs: { path: string; sha256: string }[];
  references: { from: string; link: string; target: string }[];
}
export declare class LiveFeatureError extends Error {
  readonly code: string;
}
export declare function canonicalJson(value: unknown): string;
export declare function featureRows(
  inventory: FeatureInventory,
  observations: readonly FeatureRow[],
): HostFeatureMatrix;
export declare function commandBody(file: string): string;
export declare function requestCarries(
  request: unknown,
  expectation: CarryExpectation,
): { carried: boolean; occurrences: number };
export declare function resourcesResolve(productRoot: string, manifest: ProductManifest): ResolvedProduct;
export interface FeatureSelector {
  id: string;
  name?: string;
  resource?: string;
}
export declare function featureFiles(
  manifest: ProductManifest,
  feature: FeatureSelector,
): ProductManifest['outputs'][number][];
export declare function assignFeatures(
  host: string,
  manifest: ProductManifest,
  features: readonly FeatureSelector[],
): void;
