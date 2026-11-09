/**
 * The method fixture's ia-kb kit is the published 0.9.0 release, and its `.ia/distributions.lock.json` pins the
 * language base that release was packed on. A door restores a kit only on the base it carries (kit runtime
 * specification: a kit locked on another base refuses `IA-CORE-CLI-UNSUPPORTED`), and the kit's archive does not hold
 * that lock: the same 0.9.0 archive restores on any base its `^` range admits. So a language base release moves the
 * lock and not the kit. Each test re-locks its copy of the fixture kit on the base this door carries, as the
 * marketplace re-records its kits for a door release, and still checks the packed kit against the published archive.
 * The lock is a kit file, so a packet's `implementation` and `retained` digests cover it: `fixtures/method/generate.mjs`
 * applies this same rule to the plugin it resolves the goldens with.
 */
export interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}
export const KIT_LOCK = 'config/kits/ia-kb/.ia/distributions.lock.json';

/**
 * The fixture's files with the ia-kb kit locked on `base`; unchanged when the kit already locks it.
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
