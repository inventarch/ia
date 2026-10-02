/** The entries of a USTAR, each header with its padded content, up to the end-of-archive blocks. The archive and host-tree tests share it. */
export const entries = (tar: Buffer): Buffer[] => {
  const out: Buffer[] = [];
  for (let at = 0; !tar.subarray(at, at + 512).every((byte) => byte === 0); ) {
    const next = at + 512 + Math.ceil(parseInt(tar.toString('ascii', at + 124, at + 135), 8) / 512) * 512;
    out.push(tar.subarray(at, next));
    at = next;
  }
  return out;
};
