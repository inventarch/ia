/** Exact packaged base acquisition shared by init, migration and restore. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyArchive } from '@inventarch/distribution/archive';
import type { BundleManifest } from '@inventarch/db/distribution';
import { Refusal } from './consumer.js';
import { codeOf } from './session.js';
export const PIN_PATH = 'assets/base.json';
export const BASES_PATH = 'assets/bases.json';
export const baseArchivePath = (digest: string): string => `assets/base/${digest}.ia.tgz`;
export const PACKAGE_ID = /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*$/;
export const DAMAGED =
  'The ia installation is damaged; run "ia doctor" for its install channel and reinstall @inventarch/cli through it.';
export interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}
export interface Base {
  readonly pin: BasePin;
  readonly bytes: Buffer;
  /** The systems the bundled manifest carries, sorted, which the starter composes and the descriptor externalizes. */
  readonly systems: readonly string[];
  /** The verified manifest the archive carries. */
  readonly manifest: BundleManifest;
}
const damaged = (message: string, path: string): Refusal => new Refusal('IA-CLI-FAILED', message, 3, { path }, DAMAGED);

function parsePin(value: unknown): BasePin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('unexpected fields');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (
    keys !== 'archive,id,manifest,version' ||
    !Object.values(record).every((item) => typeof item === 'string') ||
    !PACKAGE_ID.test(String(record['id']))
  )
    throw new Error('unexpected fields');
  if (!/^[a-f0-9]{64}$/.test(String(record['archive'])) || !/^[a-f0-9]{64}$/.test(String(record['manifest'])))
    throw new Error('malformed digest');
  return record as unknown as BasePin;
}

/** The pin's archive, read from the package and verified against the pin: digest, manifest digest, id and version. */
function verifiedBase(packageRoot: string, pin: BasePin): Base {
  const archivePath = resolve(packageRoot, baseArchivePath(pin.archive));
  const bytes = existsSync(archivePath) ? readFileSync(archivePath) : Buffer.alloc(0);
  try {
    const verified = verifyArchive(bytes, pin.archive);
    if (
      verified.manifestDigest !== pin.manifest ||
      verified.manifest.id !== pin.id ||
      verified.manifest.version !== pin.version
    )
      throw damaged('The bundled base archive does not carry the pinned manifest', archivePath);
    return { pin, bytes, systems: verified.manifest.systems.map((system) => system.name), manifest: verified.manifest };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(
      codeOf(error, 'IA-CLI-FAILED'),
      error instanceof Error ? error.message : String(error),
      3,
      { path: archivePath },
      DAMAGED,
    );
  }
}

export function readBase(packageRoot: string): Base {
  const pinPath = resolve(packageRoot, PIN_PATH);
  let pin: BasePin;
  try {
    pin = parsePin(JSON.parse(readFileSync(pinPath, 'utf8')));
  } catch (error) {
    throw damaged(
      `The bundled base package pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      pinPath,
    );
  }
  return verifiedBase(packageRoot, pin);
}

/** Every base the package carries, ascending, the last being the newest (the one `readBase` returns); each is verified. */
export function readBases(packageRoot: string): Base[] {
  const listPath = resolve(packageRoot, BASES_PATH);
  let pins: BasePin[];
  try {
    const value = JSON.parse(readFileSync(listPath, 'utf8')) as unknown;
    if (!Array.isArray(value) || value.length === 0) throw new Error('expected a non-empty list');
    pins = value.map(parsePin);
  } catch (error) {
    throw damaged(
      `The bundled base list cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      listPath,
    );
  }
  return pins.map((pin) => verifiedBase(packageRoot, pin));
}
