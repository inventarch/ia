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
/** A first-party installed operation implementation whose handler bytes the payload ships. */
export interface PayloadImplementation {
  id: string;
  package: string;
  module: string;
  declaration: string;
}
/** An implementation as `collectPayload` located it: its package directory, and why it is not shipped, or null. */
export interface LocatedImplementation extends PayloadImplementation {
  dir: string | null;
  reason: string | null;
}
export interface PayloadCatalog {
  format: 'ia.installed-implementations';
  formatVersion: 1;
  evaluators: { format: string; entries: unknown[] };
  operations: ({ id: string; status: 'available' | 'unavailable'; reason?: string } & Record<string, unknown>)[];
}
export declare const EXCLUDED: ReadonlySet<string>;
export declare const IMPLEMENTATIONS: readonly PayloadImplementation[];
export declare const PAYLOAD_BYTES: number;
export declare function collectPayload(
  repository: string,
  implementations?: readonly PayloadImplementation[],
): Promise<{ files: Map<string, Buffer>; packages: HostPayloadPackage[]; implementations: LocatedImplementation[] }>;
export declare function packageClosure(files: ReadonlyMap<string, Buffer>, name: string): string[] | string;
export declare function moduleClosure(
  files: ReadonlyMap<string, Buffer>,
  start: string,
): { reached: string[]; packages: string[]; missing: string[] };
/** One catalog row for a located implementation; it imports the declaration module when the handler ships. */
export declare function operationRow(
  implementation: LocatedImplementation,
  files: ReadonlyMap<string, Buffer>,
): Promise<{ id: string; status: 'available' | 'unavailable'; reason?: string } & Record<string, unknown>>;
export declare function generateHostPayload(options: {
  repository: string;
  write: boolean;
  implementations?: readonly PayloadImplementation[];
}): Promise<{ pin: HostPayloadPin; archive: Buffer; catalog: PayloadCatalog }>;

export declare function staticCliManifest(input: Record<string, unknown>): Record<string, unknown>;
export declare function assertStaticPayloadCode(path: string, bytes: Buffer): void;
