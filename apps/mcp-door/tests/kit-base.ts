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
