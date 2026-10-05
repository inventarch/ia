import type { PublicContentPolicy } from './public/content-scan.mjs';
export interface PackedContentArchive {
  name: string;
  filename: string;
  sha256: string;
  owner?: string;
}
export interface PackedContentDecoder {
  unpackTree: (input: Uint8Array, limits: PackedContentDecoder['limits']) => ReadonlyMap<string, Uint8Array>;
  limits: { compressed: number; expanded: number; file: number; files: number };
}
export interface PackedContentResult {
  archives: number;
  files: number;
  observations: { name: string; sha256: string; files: number }[];
}
export declare function readPackedContent(
  archive: string,
  owner: string,
  decoder: PackedContentDecoder,
): Map<string, { bytes: Buffer }>;
export declare function scanPackedArchives(
  packed: readonly PackedContentArchive[],
  policy: PublicContentPolicy,
  decoder: PackedContentDecoder,
): PackedContentResult;
