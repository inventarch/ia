import { readFileSync } from 'node:fs';
import type { BasePin, Kit } from '@inventarch/runtime/method';
import { restoreKit } from '../src/method.js';

/**
 * The method fixture's ia-kb kit is the published 0.9.0 release with its published `.ia/distributions.lock.json`, which
 * pins the language base that release was packed on (3.2.0). The tests read it as shipped, never re-locked: this door
 * carries every published base (`assets/bases.json`, newest last), restores a kit on its locked archive when it carries
 * it, and otherwise on its newest base when the kit's range admits it (`selectKitBase`, kit runtime specification).
 */
export const KIT_LOCK = 'config/kits/ia-kb/.ia/distributions.lock.json';

/** The language bases this door carries, oldest first. */
export const CARRIED = JSON.parse(readFileSync(new URL('../assets/bases.json', import.meta.url), 'utf8')) as BasePin[];

/** Restores `dir` in place with the base the door chooses for `kit`, as a read root is restored, and says which. */
export function restoreInPlace(dir: string, kit: Kit): ReturnType<typeof restoreKit.select> {
  const chosen = restoreKit.select(kit);
  restoreKit.apply(dir, kit, chosen.base);
  return chosen;
}

/**
 * The fixture's files with the ia-kb kit locked on `base`; unchanged when the kit already locks it. Only the golden
 * comparison uses it: the goldens are resolved by the marketplace plugin's `resolve.mjs`, which restores a kit through
 * `ia restore` of the built CLI, and that restores offline only the CLI's newest base until it restores every carried
 * one. The lock is a kit file, so a packet's `implementation` and `retained` digests cover it, and
 * `fixtures/method/generate.mjs` has a twin `lockedOn` for the goldens: keep the two in step.
 */
export function lockedOn(files: Record<string, string>, base: BasePin): Record<string, string> {
  const lock = JSON.parse(files[KIT_LOCK]!) as { packages: Record<string, unknown>[] };
  const row = lock.packages.find((pkg) => pkg['id'] === base.id);
  if (row === undefined) throw new Error(`${KIT_LOCK} has no ${base.id} row to lock on the door's base`);
  if (row['archive'] === base.archive) return files;
  Object.assign(row, {
    archive: base.archive,
    location: `sha256:${base.archive}`,
    manifest: base.manifest,
    version: base.version,
  });
  return { ...files, [KIT_LOCK]: JSON.stringify(lock) + (files[KIT_LOCK]!.endsWith('\n') ? '\n' : '') };
}
