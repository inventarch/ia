import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A native release row: the language base this door carries, as `assets/base.json` names it. */
export interface BaseRow {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}

/**
 * Re-locks a copied kit folder to the language base this door carries, as a kit re-cut would. The fixture kit's
 * `release.json` depends on a language range (`^3.2.0`) and its packed bytes do not include the lock, so the copy still
 * packs to the archive its `releases.json` names; only the exact base its lock pins moves with the door's language.
 */
export function relockLanguage(folder: string, base: BaseRow): void {
  const path = join(folder, '.ia', 'distributions.lock.json');
  const lock = JSON.parse(readFileSync(path, 'utf8')) as {
    packages: { id: string }[];
  };
  lock.packages = lock.packages.map((row) =>
    row.id === base.id
      ? {
          ...row,
          version: base.version,
          archive: base.archive,
          manifest: base.manifest,
          location: `sha256:${base.archive}`,
        }
      : row,
  );
  // The lock's own form, compact with a final newline, so a restored copy reads back byte for byte.
  writeFileSync(path, `${JSON.stringify(lock)}\n`);
}
