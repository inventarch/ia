export interface PackedManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
export interface ReleaseGraph {
  groups: { members: string[]; cyclic: boolean }[];
  dependencies: Record<string, string[]>;
}
export declare function packedManifest(path: string, qualifiedBytes?: Buffer): PackedManifest;
export declare function releaseGraph(
  manifests: PackedManifest[],
  version: string,
  allowedCycles: string[][],
): ReleaseGraph;
