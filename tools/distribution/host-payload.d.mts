// Types for host-payload.mjs, so tsconfig.tools.json can check its test.
export interface HostPayloadPackage {
  name: string;
  version: string;
  manifestDigest: string;
  license: string;
  notices: string[];
}
export interface HostPayloadPin {
  release: string;
  archive: string;
  files: number;
  bytes: number;
}
export declare const EXCLUDED: ReadonlySet<string>;
export declare const PAYLOAD_BYTES: number;
export declare function collectPayload(
  repository: string,
): Promise<{ files: Map<string, Buffer>; packages: HostPayloadPackage[] }>;
export declare function generateHostPayload(options: {
  repository: string;
  write: boolean;
}): Promise<{ pin: HostPayloadPin; archive: Buffer }>;

export declare function staticCliManifest(input: Record<string, unknown>): Record<string, unknown>;
export declare function assertStaticPayloadCode(path: string, bytes: Buffer): void;
