import type { PackedContentArchive, PackedContentResult } from './packed-content.mjs';
export declare function scanPackedPublicContent(
  root: string,
  packed: readonly PackedContentArchive[],
): PackedContentResult;
