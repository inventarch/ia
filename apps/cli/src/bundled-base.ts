/** Exact packaged base acquisition shared by init, migration and restore. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyArchive } from '@inventarch/distribution/archive';
import { Refusal } from './consumer.js';
import { codeOf } from './session.js';
export const PIN_PATH = 'assets/base.json';
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
}
export function readBase(packageRoot: string): Base {
  const pinPath = resolve(packageRoot, PIN_PATH);
  let pin: BasePin;
  try {
    const value = JSON.parse(readFileSync(pinPath, 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (
      keys !== 'archive,id,manifest,version' ||
      !Object.values(value).every((item) => typeof item === 'string') ||
      !PACKAGE_ID.test(String(value['id']))
    )
      throw new Error('unexpected fields');
    if (!/^[a-f0-9]{64}$/.test(String(value['archive'])) || !/^[a-f0-9]{64}$/.test(String(value['manifest'])))
      throw new Error('malformed digest');
    pin = value as unknown as BasePin;
  } catch (error) {
    throw new Refusal(
      'IA-CLI-FAILED',
      `The bundled base package pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { path: pinPath },
      DAMAGED,
    );
  }
  const archivePath = resolve(packageRoot, baseArchivePath(pin.archive));
  const bytes = existsSync(archivePath) ? readFileSync(archivePath) : Buffer.alloc(0);
  try {
    const verified = verifyArchive(bytes, pin.archive);
    if (
      verified.manifestDigest !== pin.manifest ||
      verified.manifest.id !== pin.id ||
      verified.manifest.version !== pin.version
    )
      throw new Refusal(
        'IA-CLI-FAILED',
        'The bundled base archive does not carry the pinned manifest',
        3,
        { path: archivePath },
        DAMAGED,
      );
    return { pin, bytes, systems: verified.manifest.systems.map((system) => system.name) };
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
