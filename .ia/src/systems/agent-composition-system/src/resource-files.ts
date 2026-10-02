import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { readInputs, unaliased } from '@ia/db';
import type { Capture } from './corpus.js';
import { resourcePrefix } from './resource-sources.js';
import { invalid, metadataDigest, portablePath, RESOURCE_LIMITS, sha256 } from './resource-format.js';
import type { ResourceFilePin, SourceRevision } from './resource-format.js';

export interface ResourceRoot extends SourceRevision {
  readonly root: string;
}
export function canonicalPackageRoot(root: string): string {
  if (!isAbsolute(root)) invalid('Resource roots must be explicit absolute package directories');
  const path = resolve(root);
  let current = parse(path).root;
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) invalid('Aliased resource package root');
  }
  // Another case or normalization of the same names is not an alias (#315); the loop above has refused every link.
  if (!lstatSync(path).isDirectory() || !unaliased(path, realpathSync.native(path)))
    invalid('Aliased or unavailable resource package root');
  return path;
}
function contained(root: string, path: string): string {
  canonicalPackageRoot(root);
  portablePath(path);
  let current = root;
  for (const segment of path.split('/')) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) invalid('Resource path crosses a symbolic link or junction');
  }
  if (!unaliased(current, realpathSync.native(current))) invalid('Aliased resource file');
  return current;
}
export function readPinnedResource(root: string, pin: ResourceFilePin): Buffer {
  const path = contained(root, pin.key.path),
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > RESOURCE_LIMITS.fileBytes)
      invalid('Resource must be one bounded regular file without hard-link aliases');
    const buffer = Buffer.alloc(RESOURCE_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd),
      current = lstatSync(contained(root, pin.key.path));
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1 ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs
    )
      invalid('Resource changed while capturing');
    const bytes = buffer.subarray(0, length);
    if (length !== pin.bytes || sha256(bytes) !== pin.sha256) invalid('Resource differs from its pinned size/hash');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Compare selected physical native inputs, excluding virtual floors and other mounts. */
export function verifyPackageSource(root: ResourceRoot, capture: Capture): void {
  canonicalPackageRoot(root.root);
  const actual = readInputs(root.root, { adopted: [] });
  const prefix = resourcePrefix(capture, root);
  const expected = capture.sources
    .filter((s) => (prefix ? s.path.startsWith(prefix) : s.path.startsWith('.ia/src/')))
    .map((s) => ({ path: s.path.slice(prefix.length), text: s.text }));
  const useFloor = !prefix && capture.floorOrigin === 'local';
  const selected = (rows: readonly { path: string; text: string }[]) =>
    rows
      .filter((s) => useFloor || !s.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const installed = prefix.startsWith('.ia/distributions/store/'),
    expectedPaths = new Set(expected.map((s) => s.path));
  const physical = actual.sources.filter(
    (s) => s.path.startsWith('.ia/src/') && (!installed || expectedPaths.has(s.path)),
  );
  if (
    metadataDigest(selected(physical)) !== metadataDigest(selected(expected)) ||
    (!prefix && capture.floorOrigin !== 'explicit' && actual.floorOrigin !== capture.floorOrigin) ||
    (!prefix && metadataDigest(actual.activation ?? null) !== metadataDigest(capture.activation ?? null))
  )
    invalid('Physical native source differs from its captured revision');
}
