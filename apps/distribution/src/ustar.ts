import { crc32, gzipSync, inflateRawSync } from 'node:zlib';
import { fail, portable, utf8 } from './files.js';

const block = 512;
export interface TreeLimits {
  readonly files: number;
  readonly file: number;
  readonly expanded: number;
  readonly compressed: number;
}
/** The v2 host-cache bounds: 10,000 inventory files (host.ts:37) plus release.json, inventory.json and scripts/ia.mjs, 10,003 files total; 64 MiB per file; 256 MiB of file content, 10,003 x 1024 bytes of per-file tar framing, and 1024 bytes of end-of-archive padding. */
export const HOST_TREE_LIMITS: TreeLimits = Object.freeze({
  files: 10_003,
  file: 64 * 1024 * 1024,
  expanded: 256 * 1024 * 1024 + 10_003 * 1024 + 1024,
  compressed: 256 * 1024 * 1024,
});
function octal(value: number, width: number): string {
  const result = value.toString(8);
  if (result.length >= width) fail('ARCHIVE-INVALID', 'USTAR integer overflow');
  return result.padStart(width - 1, '0') + '\0';
}
/** The one header encoding of the ustar-v1 recipe; archive.ts and host payloads share it. */
export function ustarHeader(path: string, size: number, epoch: number): Buffer {
  portable(path);
  const result = Buffer.alloc(block);
  let name = path,
    prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const splits = [...path.matchAll(/\//g)].map((m) => m.index!);
    const split = splits.find(
      (at) => Buffer.byteLength(path.slice(0, at)) <= 155 && Buffer.byteLength(path.slice(at + 1)) <= 100,
    );
    if (split === undefined) fail('ARCHIVE-INVALID', 'Path exceeds portable USTAR fields');
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  result.write(name, 0, 100, 'utf8');
  result.write(octal(0o644, 8), 100, 8, 'ascii');
  result.write(octal(0, 8), 108, 8, 'ascii');
  result.write(octal(0, 8), 116, 8, 'ascii');
  result.write(octal(size, 12), 124, 12, 'ascii');
  result.write(octal(epoch, 12), 136, 12, 'ascii');
  result.fill(32, 148, 156);
  result.write('0', 156, 1);
  result.write('ustar\0', 257, 6);
  result.write('00', 263, 2);
  result.write(prefix, 345, 155, 'utf8');
  const sum = result.reduce((a, b) => a + b, 0);
  result.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return result;
}
/** The canonical USTAR bytes of a tree: sorted entries, fixed epoch, the one header encoding. */
function ustarTree(files: ReadonlyMap<string, Uint8Array>, limits: TreeLimits, epoch = 0): Buffer {
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail('ARCHIVE-INVALID', 'Invalid USTAR epoch');
  if (files.size > limits.files) fail('LIMIT-EXCEEDED', 'Tree exceeds its file count');
  const folded = new Set<string>(),
    chunks: Buffer[] = [];
  let expanded = 2 * block;
  for (const [path, input] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const content = Buffer.from(input);
    portable(path);
    if (folded.has(path.toLowerCase())) fail('PATH-UNSAFE', 'Tree paths collide');
    folded.add(path.toLowerCase());
    if (content.length > limits.file) fail('LIMIT-EXCEEDED', `File exceeds its bound: ${path}`);
    const padding = (block - (content.length % block)) % block;
    expanded += block + content.length + padding;
    if (expanded > limits.expanded) fail('LIMIT-EXCEEDED', 'Expanded tree exceeds its ceiling');
    chunks.push(ustarHeader(path, content.length, epoch), content, Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(2 * block));
  return Buffer.concat(chunks);
}
/** gzip level 9 with the OS byte set to 255. Identical trees give identical bytes on one zlib build; another build (Homebrew's Node links the system zlib) can encode the same tree differently, so verification never re-compresses. */
export function packTree(files: ReadonlyMap<string, Uint8Array>, limits: TreeLimits, epoch = 0): Buffer {
  const packed = gzipSync(ustarTree(files, limits, epoch), { level: 9 });
  packed[9] = 255;
  if (packed.length > limits.compressed) fail('LIMIT-EXCEEDED', 'Compressed tree exceeds its ceiling');
  return packed;
}
/** The two ways an envelope is refused: bytes that do not inflate within the bound or fail the trailer, and an envelope outside the recipe. */
export interface EnvelopeRefusals {
  readonly invalid: string;
  readonly outside: string;
}
/**
 * Inflates the recipe's gzip envelope once and returns the USTAR inside it. The header is checked before anything is inflated:
 * RFC 1952 magic and deflate, no flags, zero mtime, an XFL of 0, 2 or 4 (the only values zlib writes), and OS 255. The deflate
 * stream must then use every byte up to the 8-byte trailer, which leaves no room for a second member or a trailing byte, and
 * the trailer's CRC-32 and length must match what it inflated to. Inflating stops at `maxOutputLength`. The deflate bytes
 * themselves are not compared, so any zlib build's encoding passes (Homebrew's Node links the system zlib).
 */
export function inflateCanonical(input: Uint8Array, maxOutputLength: number, refusals: EnvelopeRefusals): Buffer {
  const gz = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (gz.length < 20 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8)
    return fail('ARCHIVE-INVALID', refusals.invalid);
  if (gz[3] !== 0 || gz.readUInt32LE(4) !== 0 || ![0, 2, 4].includes(gz[8]!) || gz[9] !== 255)
    return fail('ARCHIVE-INVALID', refusals.outside);
  let tar: Buffer, consumed: number;
  try {
    const inflated = inflateRawSync(gz.subarray(10, gz.length - 8), { maxOutputLength, info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    tar = inflated.buffer;
    consumed = inflated.engine.bytesWritten;
  } catch {
    return fail('ARCHIVE-INVALID', refusals.invalid);
  }
  // One member's deflate stream ends exactly at its trailer: a second member or a trailing byte leaves input unread.
  if (consumed !== gz.length - 18) return fail('ARCHIVE-INVALID', refusals.outside);
  if (crc32(tar) !== gz.readUInt32LE(gz.length - 8) || tar.length % 2 ** 32 !== gz.readUInt32LE(gz.length - 4))
    return fail('ARCHIVE-INVALID', refusals.invalid);
  return tar;
}
/** Reads only the canonical tree inside the recipe's envelope: the envelope is checked as it is inflated, the tree is rebuilt and compared byte for byte, and the deflate bytes are left to the zlib build that wrote them. */
export function unpackTree(input: Uint8Array, limits: TreeLimits): Map<string, Buffer> {
  if (input.length > limits.compressed) fail('LIMIT-EXCEEDED', 'Compressed tree exceeds its ceiling');
  const tar = inflateCanonical(input, limits.expanded, {
    invalid: 'Invalid or oversized compressed tree',
    outside: 'Tree is outside the canonical ustar-v1 recipe',
  });
  if (tar.length < 1024 || tar.length % block) fail('ARCHIVE-INVALID', 'Invalid USTAR length');
  const files = new Map<string, Buffer>();
  let at = 0,
    epoch = 0;
  while (at < tar.length - 1024) {
    const h = tar.subarray(at, at + block);
    if (h.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const bytes = h.subarray(start, start + length),
        zero = bytes.indexOf(0);
      return utf8(Buffer.from(zero < 0 ? bytes : bytes.subarray(0, zero)));
    };
    const prefix = field(345, 155),
      path = `${prefix ? prefix + '/' : ''}${field(0, 100)}`;
    const sizeField = field(124, 12),
      epochField = field(136, 12);
    if (!/^[0-7]{11}$/.test(sizeField) || !/^[0-7]{11}$/.test(epochField))
      fail('ARCHIVE-INVALID', 'Invalid USTAR integer');
    const size = parseInt(sizeField, 8);
    epoch = parseInt(epochField, 8);
    if (
      size > limits.file ||
      files.size >= limits.files ||
      at + block + size > tar.length - 1024 ||
      !h.equals(ustarHeader(path, size, epoch))
    )
      fail('ARCHIVE-INVALID', 'Invalid header, size, checksum or metadata');
    files.set(path, Buffer.from(tar.subarray(at + block, at + block + size)));
    at += block + Math.ceil(size / block) * block;
  }
  if (!ustarTree(files, limits, epoch).equals(tar))
    fail('ARCHIVE-INVALID', 'Tree is outside the canonical ustar-v1 recipe');
  return files;
}
