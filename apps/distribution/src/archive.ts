import { gzipSync } from 'node:zlib';
import {
  canonicalDistributionJson,
  decodeBundleManifest,
  decodeDistributionLock,
  deriveGenerationInputs,
  DISTRIBUTION_LIMITS,
  portablePath,
  sha256,
} from '@ia/db/distribution';
import type { BundleManifest, BundleMetadata } from '@ia/db/distribution';
import { fail, utf8 } from './files.js';
import { verifyAuthoringAssetClosure, verifySelectedAuthoringAssetClosure } from './authoring-assets.js';
import { KERNEL_SOURCES } from '@ia/language';
import { inflateCanonical, ustarHeader } from './ustar.js';

interface ArchiveContent {
  readonly manifest: BundleManifest;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly archiveDigest: string;
  readonly manifestDigest: string;
}
export interface VerifiedArchive extends ArchiveContent {}
const block = 512;
// Successful immutable structural joins only. Every call still checks complete
// canonical archive content, gzip envelope and payload pins before consulting this bounded cache.
const authoringClosures = new Map<string, true>();
const header = (path: string, size: number, epoch: number): Buffer => {
  portablePath(path);
  return ustarHeader(path, size, epoch);
};
function archiveTar(input: BundleManifest, inputFiles: ReadonlyMap<string, Uint8Array>): Buffer {
  const manifest = decodeBundleManifest(input),
    files = new Map([...inputFiles].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  if (manifest.source.recipe !== 'ustar-v1') fail('ARCHIVE-INVALID', 'Unsupported archive recipe');
  if (files.size !== manifest.files.length || manifest.files.some((p) => !files.has(p.path)))
    fail('ARCHIVE-INVALID', 'Payload differs from exact manifest inventory');
  for (const pin of manifest.files) {
    const content = files.get(pin.path)!;
    if (content.length !== pin.bytes || sha256(content) !== pin.sha256)
      fail('ARCHIVE-INVALID', `Payload pin mismatch: ${pin.path}`);
    if (pin.role === 'source') utf8(content);
  }
  files.set('distribution.json', Buffer.from(canonicalDistributionJson(manifest)));
  const chunks: Buffer[] = [];
  let expanded = 2 * block;
  for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const padding = (block - (content.length % block)) % block;
    expanded += block + content.length + padding;
    if (expanded > DISTRIBUTION_LIMITS.expanded) fail('LIMIT-EXCEEDED', 'Expanded archive exceeds its ceiling');
    chunks.push(header(path, content.length, manifest.source.epoch), content, Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(2 * block));
  return Buffer.concat(chunks);
}
export function buildArchive(input: BundleManifest, inputFiles: ReadonlyMap<string, Uint8Array>): Buffer {
  const packed = gzipSync(archiveTar(input, inputFiles), { level: 9 });
  // RFC 1952's informational OS byte must not make identical releases differ
  // between Windows and Unix. 255 means unspecified; payload/CRC stay unchanged.
  packed[9] = 255;
  if (packed.length > DISTRIBUTION_LIMITS.compressed) fail('LIMIT-EXCEEDED', 'Compressed archive exceeds its ceiling');
  return packed;
}
// Deliberately wrapped: pending bytes cannot be returned as a VerifiedArchive.
function verifyArchiveBytes(input: Uint8Array, expectedDigest?: string): { pending: ArchiveContent } {
  if (input.length > DISTRIBUTION_LIMITS.compressed) fail('LIMIT-EXCEEDED', 'Compressed archive exceeds its ceiling');
  const archive = Buffer.from(input),
    archiveDigest = sha256(archive);
  if (expectedDigest !== undefined && archiveDigest !== expectedDigest)
    fail('ARCHIVE-INVALID', 'Archive digest mismatch');
  const tar = inflateCanonical(archive, DISTRIBUTION_LIMITS.expanded, {
    invalid: 'Invalid or oversized compressed archive',
    outside: 'Archive is outside the canonical format-1 recipe',
  });
  if (tar.length < 1024 || tar.length % block) fail('ARCHIVE-INVALID', 'Invalid USTAR length');
  const files = new Map<string, Buffer>(),
    aliases = new Set<string>();
  let at = 0;
  while (at < tar.length - 1024) {
    const h = tar.subarray(at, at + block);
    if (h.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const bytes = h.subarray(start, start + length),
        zero = bytes.indexOf(0);
      return utf8(zero < 0 ? bytes : bytes.subarray(0, zero));
    };
    const prefix = field(345, 155),
      path = portablePath(`${prefix ? prefix + '/' : ''}${field(0, 100)}`);
    if (h[156] !== 48 || field(257, 6) !== 'ustar' || field(263, 2) !== '00' || aliases.has(path.toLowerCase()))
      fail('ARCHIVE-INVALID', 'Nonregular, duplicate or unsupported archive entry');
    const sizeField = field(124, 12),
      epochField = field(136, 12);
    if (!/^[0-7]{11}$/.test(sizeField) || !/^[0-7]{11}$/.test(epochField))
      fail('ARCHIVE-INVALID', 'Invalid USTAR integer');
    const size = parseInt(sizeField, 8),
      epoch = parseInt(epochField, 8);
    if (
      size > DISTRIBUTION_LIMITS.file ||
      files.size >= DISTRIBUTION_LIMITS.files ||
      at + block + size > tar.length - 1024 ||
      !h.equals(header(path, size, epoch))
    )
      fail('ARCHIVE-INVALID', 'Invalid header, size, checksum or metadata');
    const next = at + block + Math.ceil(size / block) * block;
    if (tar.subarray(at + block + size, next).some((byte) => byte !== 0))
      fail('ARCHIVE-INVALID', 'Nonzero file padding');
    files.set(path, Buffer.from(tar.subarray(at + block, at + block + size)));
    aliases.add(path.toLowerCase());
    at = next;
  }
  if (at !== tar.length - 1024 || tar.subarray(at).some((byte) => byte !== 0))
    fail('ARCHIVE-INVALID', 'Unexpected trailing archive data');
  const content = files.get('distribution.json');
  if (!content) fail('ARCHIVE-INVALID', 'Missing manifest');
  const manifest = decodeBundleManifest(utf8(content));
  if (canonicalDistributionJson(manifest) !== utf8(content)) fail('ARCHIVE-INVALID', 'Noncanonical manifest');
  files.delete('distribution.json');
  // One canonical USTAR per manifest and payload; inflateCanonical already held it to the recipe's gzip envelope. The deflate bytes
  // are not compared: zlib builds encode the same tar differently (Homebrew's Node links the system zlib). A pinned digest still binds exact bytes.
  if (!archiveTar(manifest, files).equals(tar))
    fail('ARCHIVE-INVALID', 'Archive is outside the canonical format-1 recipe');
  return { pending: Object.freeze({ manifest, files, archiveDigest, manifestDigest: sha256(content) }) };
}

/** Integrity-only metadata for selection. This wrapper makes no authoring/readiness claim and omits payload files. */
export function inspectArchiveMetadata(
  input: Uint8Array,
  expectedDigest?: string,
): { readonly pending: BundleMetadata } {
  const { pending } = verifyArchiveBytes(input, expectedDigest);
  return Object.freeze({
    pending: Object.freeze({
      manifest: pending.manifest,
      archiveDigest: pending.archiveDigest,
      manifestDigest: pending.manifestDigest,
    }),
  });
}

/** Standalone guarantee is unchanged: unresolved dependent authoring assets refuse. */
export function verifyArchive(input: Uint8Array, expectedDigest?: string): VerifiedArchive {
  const { pending } = verifyArchiveBytes(input, expectedDigest);
  const { manifest, files, archiveDigest } = pending;
  const authoringKey = sha256(`${archiveDigest}:${sha256(JSON.stringify(KERNEL_SOURCES))}`);
  if (!authoringClosures.has(authoringKey)) {
    verifyAuthoringAssetClosure(manifest, files);
    authoringClosures.set(authoringKey, true);
    if (authoringClosures.size > 32) authoringClosures.delete(authoringClosures.keys().next().value!);
  } else {
    authoringClosures.delete(authoringKey);
    authoringClosures.set(authoringKey, true);
  }
  return pending;
}

/** Exact selected closure only; no deferred archive escapes as verified/ready. */
export function verifySelectedArchiveClosure(
  lockInput: unknown,
  input: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, VerifiedArchive> {
  const lock = decodeDistributionLock(lockInput);
  if (!(input instanceof Map) || input.size !== new Set(lock.packages.map((pkg) => pkg.archive)).size)
    fail('RESTORE-REQUIRED', 'Supply the exact selected archive inventory');
  const pending = new Map<string, ArchiveContent>();
  let total = 0;
  for (const pkg of lock.packages) {
    const content: unknown = input.get(pkg.archive);
    if (!(content instanceof Uint8Array)) fail('RESTORE-REQUIRED', `Missing exact archive ${pkg.archive}`);
    total += content.length;
    if (total > DISTRIBUTION_LIMITS.expanded) fail('LIMIT-EXCEEDED', 'Combined archive selection exceeds its ceiling');
    const decoded = verifyArchiveBytes(content, pkg.archive);
    if (decoded.pending.manifestDigest !== pkg.manifest) fail('ARCHIVE-INVALID', 'Selected manifest differs from lock');
    pending.set(pkg.id, decoded.pending);
  }
  deriveGenerationInputs(lock, pending);
  verifySelectedAuthoringAssetClosure(lock, pending);
  return pending;
}
