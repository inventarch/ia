export interface PublicFilePin {
  path: string;
  sha256: string;
}
export interface PublicPackageInputs {
  format: 'ia.public-package-inputs.v2';
  source: { repository: 'https://github.com/inventarch/ia'; commit: string; tree: string; dirty: boolean };
  membership: { path: string; sha256: string };
  inputDigest: string;
  npm: Record<string, string>;
  files: PublicFilePin[];
}
export declare const PUBLIC_INPUTS: string;
export declare const PUBLIC_MEMBERSHIP: string;
export declare const PUBLIC_SYSTEM_POLICY: string;
export declare const COMPATIBILITY: string;
export declare function publicPackageInputs(
  root: string,
  options?: { sealed?: boolean },
): {
  receipt: PublicPackageInputs;
  sha256: string;
  bytes: Buffer;
};
export declare function packPublicPackages(
  root: string,
  target: string,
  pnpm?: string,
  options?: { sealed?: boolean },
): {
  packed: { name: string; version: string; filename: string; owner: string; sha256: string }[];
  compatibility: unknown;
  compatibilitySha256: string;
};
export declare function verifyPublicCompatibility(
  root: string,
  directory: string,
  expectedSha256?: string,
  options?: { inputs?: { receipt: PublicPackageInputs; sha256: string; bytes: Buffer } },
): { compatibility: unknown; sha256: string };

export declare function refreshPublicPackageInputs(root: string): {
  receipt: PublicPackageInputs;
  sha256: string;
  bytes: Buffer;
};
