import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { within } from '@ia/db';
import { DistributionError, fail, sha256 } from './files.js';
import { verifyHostCache } from './host.js';
import { ensureIaHome } from './ia-home.js';
import { HOST_TREE_LIMITS, unpackTree } from './ustar.js';

export interface HostPin {
  readonly release: string;
  readonly archive: string;
  readonly files: number;
  readonly bytes: number;
}
/** Spec §3.3 step 3: a failed verification of an existing payload must name the directory it refuses. */
function verifyNaming(target: string): ReturnType<typeof verifyHostCache> {
  try {
    return verifyHostCache(target);
  } catch (error) {
    if (error instanceof DistributionError)
      throw new DistributionError(error.code, `${error.message} at ${target}; delete that directory`);
    throw error;
  }
}
/** M5.3 §3.3's per-OS data directory, kept only so `doctor` can recognize registrations pinned there (host plugin distribution spec §3). */
export function legacyHostHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  home: string,
): string {
  if (platform === 'win32') return join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'ia');
  if (platform === 'darwin') return join(home, 'Library/Application Support', 'ia');
  return join(env['XDG_DATA_HOME'] || join(home, '.local/share'), 'ia');
}
export const hostPayloadPath = (home: string, release: string): string => join(home, 'hosts', release);
/** Spec §3.3 step 1: where a package carries its embedded payload, relative to its own root (tools/distribution/host-payload.mjs writes both). */
const HOST_PIN_PATH = 'assets/host.json';
const hostArchivePath = (archive: string): string => `assets/host/${archive}.tgz`;
/** Spec §3.3 step 1: read and shape-check the pin, and require the archive; its digest is checked by `materializeHostPayload`. A missing or malformed asset is ARTIFACT-UNAVAILABLE. */
export function readHostPin(packageRoot: string): {
  readonly pin: HostPin;
  readonly pinPath: string;
  readonly archivePath: string;
  readonly archive: () => Buffer;
} {
  const pinPath = resolve(packageRoot, HOST_PIN_PATH);
  let pin: HostPin;
  try {
    const value = JSON.parse(readFileSync(pinPath, 'utf8')) as Record<string, unknown>;
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'archive,bytes,files,release' ||
      !/^[a-f0-9]{64}$/.test(String(value['release'])) ||
      !/^[a-f0-9]{64}$/.test(String(value['archive'])) ||
      !Number.isSafeInteger(value['files']) ||
      !Number.isSafeInteger(value['bytes'])
    )
      throw new Error('unexpected fields');
    pin = value as unknown as HostPin;
  } catch (error) {
    return fail(
      'ARTIFACT-UNAVAILABLE',
      `The bundled host payload pin cannot be read (${error instanceof Error ? error.message : String(error)}): ${pinPath}`,
    );
  }
  const archivePath = resolve(packageRoot, hostArchivePath(pin.archive));
  if (!existsSync(archivePath))
    fail('ARTIFACT-UNAVAILABLE', `The bundled host payload archive is missing: ${archivePath}`);
  return { pin, pinPath, archivePath, archive: () => readFileSync(archivePath) };
}
/**
 * Spec §3.3: the consumer root MUST NOT be inside the host home, and a home inside the workspace would put per-user payload
 * bytes in it; both refuse. Nesting is judged on disk, so another spelling a case- or normalization-folding volume opens as
 * the same directory nests too (#315).
 */
export function assertHomeOutsideWorkspace(home: string, root: string): void {
  if (!isAbsolute(home) || !isAbsolute(root)) fail('INPUT-INVALID', 'Host home and workspace root must be absolute');
  if (within(home, root)) fail('PATH-UNSAFE', `Consumer workspace cannot be inside the host home ${home}`);
  if (within(root, home)) fail('PATH-UNSAFE', `Host home cannot be inside the consumer workspace: ${home}`);
}
/** Spec §3.3 steps 3-4: verify-or-reuse, never overwrite; stage beside the target and rename into place. */
export function materializeHostPayload(input: {
  readonly home: string;
  readonly archive: Buffer;
  readonly pin: HostPin;
}): { directory: string; release: string; reused: boolean } {
  const { home, archive, pin } = input;
  if (!/^[a-f0-9]{64}$/.test(pin.release) || !/^[a-f0-9]{64}$/.test(pin.archive))
    fail('INPUT-INVALID', 'Invalid host payload pin');
  const target = hostPayloadPath(home, pin.release);
  if (sha256(archive) !== pin.archive) fail('INTEGRITY-MISMATCH', 'Bundled host payload differs from its pin');
  if (existsSync(target)) {
    const found = verifyNaming(target);
    if (found.release !== pin.release)
      fail('INTEGRITY-MISMATCH', `Host payload at ${target} differs from its release; delete that directory`);
    return { directory: found.directory, release: found.release, reused: true };
  }
  const tree = unpackTree(archive, HOST_TREE_LIMITS),
    release = tree.get('release.json');
  if (!release || sha256(release) !== pin.release)
    fail('INTEGRITY-MISMATCH', 'Bundled host payload release differs from its pin');
  // Deferred past every integrity check: a bad bundled archive fails before the home is even created or marked.
  ensureIaHome(home);
  const stage = join(home, 'hosts', `.stage-${randomUUID()}`);
  mkdirSync(stage, { recursive: true });
  let won = true;
  try {
    for (const [path, bytes] of tree) {
      const file = join(stage, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: 'wx' });
    }
    verifyHostCache(stage);
    try {
      renameSync(stage, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
      won = false;
    } // another process won the race; verify its copy below
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
  const found = verifyNaming(target);
  if (found.release !== pin.release)
    fail('INTEGRITY-MISMATCH', `Host payload at ${target} differs from its release; delete that directory`);
  return { directory: found.directory, release: found.release, reused: !won };
}
