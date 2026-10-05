export interface PublicFilePin {
  path: string;
  sha256: string;
}
export interface PublicPackageInputs {
  format: 'ia.public-package-inputs.v1';
  sourceRevision: string;
  baselineOverlay: unknown;
  provenance: unknown;
  files: PublicFilePin[];
  packageIdentities?: Record<string, { name: string; private: boolean }>;
  publicRefresh?: {
    format: 'ia.public-input-refresh.v1';
    baseCommit: string;
    baseTree: string;
    dirty: boolean;
    inputDigest: string;
    npm: Record<string, string>;
  };
}
export declare const PUBLIC_INPUTS: string;
export declare const PUBLIC_SYSTEM_POLICY: string;
export declare const COMPATIBILITY: string;
export declare function publicPackageInputs(root: string): {
  receipt: PublicPackageInputs;
  sha256: string;
  bytes: Buffer;
};
export declare function packPublicPackages(
  root: string,
  target: string,
  pnpm?: string,
): {
  packed: { name: string; version: string; filename: string; owner: string; sha256: string }[];
  compatibility: unknown;
  compatibilitySha256: string;
};
export declare function verifyPublicCompatibility(
  root: string,
  directory: string,
  expectedSha256?: string,
): { compatibility: unknown; sha256: string };

export declare function refreshPublicPackageInputs(root: string): {
  receipt: PublicPackageInputs;
  sha256: string;
  bytes: Buffer;
};
