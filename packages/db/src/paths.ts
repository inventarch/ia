import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * Path identity on volumes that fold case or Unicode normalization, as APFS and NTFS do by default: two spellings of one
 * entry are one path, and only a link or junction makes a path an alias. Strings are compared only where nothing exists yet
 * to compare (`pathKey`). Issue #315.
 */

/** Some existing component of `path` is a symbolic link or junction. A component that does not exist yet is not one. */
export function linked(path: string): boolean {
  const absolute = resolve(path),
    volume = parse(absolute).root;
  let current = volume;
  for (const part of absolute.slice(volume.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    let link: boolean;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    if (link) return true;
  }
  return false;
}

/**
 * `path` reaches `real`, its `realpathSync.native`, without passing a link or junction. They are equal; or, on win32, equal
 * ignoring case once `path` is normalized, as Windows removes `..` and redundant separators before the volume sees a path, so
 * a subst drive or an 8.3 name still counts as an alias there, and no component of the normalized path is a link, since
 * `toLowerCase` folds pairs NTFS keeps apart (a junction named Kelvin `K` to its sibling `k`); or, elsewhere, `path` is
 * absolute and normalized (a `link/..` pair is not collapsed by the kernel) and no component of it is a link, so they differ
 * only where the volume folds the case or the Unicode normalization of existing names.
 */
export function unaliased(path: string, real: string): boolean {
  if (path === real) return true;
  if (process.platform === 'win32') return resolve(path).toLowerCase() === real.toLowerCase() && !linked(resolve(path));
  return path === resolve(path) && !linked(path);
}

/**
 * Both exist and are the same file or directory: the same device and inode. A path that cannot be examined (a link loop, a
 * directory without search permission) is the same only as another spelling of itself, compared by `pathKey`.
 */
export function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a, { bigint: true, throwIfNoEntry: false }),
      right = statSync(b, { bigint: true, throwIfNoEntry: false });
    return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
  } catch {
    return pathKey(resolve(a)) === pathKey(resolve(b));
  }
}

/**
 * `child` is `parent`, or lies under it on disk. Where `parent` exists, the child's deepest existing ancestor is resolved and its
 * real ancestors are compared with `parent` by device and inode, so another spelling of the same directory, or a path through a
 * link, is judged by where it really is. Where `parent` does not exist yet, the two settled paths are compared as strings,
 * folded as the volume folds names.
 */
export function within(parent: string, child: string): boolean {
  const target = statSync(parent, { bigint: true, throwIfNoEntry: false });
  if (!target) {
    const path = relative(pathKey(settled(parent)), pathKey(settled(child)));
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
  }
  let existing = resolve(child);
  while (!statSync(existing, { throwIfNoEntry: false })) {
    const up = dirname(existing);
    if (up === existing) return false;
    existing = up;
  }
  for (let entry = realpathSync.native(existing); ; entry = dirname(entry)) {
    const stat = statSync(entry, { bigint: true });
    if (stat.dev === target.dev && stat.ino === target.ino) return true;
    if (dirname(entry) === entry) return false;
  }
}

/** The real path of the deepest existing ancestor with the rest appended, so an absent path compares like a present one. */
function settled(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!statSync(head, { throwIfNoEntry: false })) {
    const up = dirname(head);
    if (up === head) return resolve(path);
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync.native(head), ...tail);
}

/**
 * The comparison key of a relative path that may not exist yet. It folds where volumes fold by default: case on win32, and
 * `caseFold` on darwin (APFS's default personality; a case-sensitive APFS volume then refuses two names that differ only in
 * case, which no archive could carry anyway).
 */
export function pathKey(path: string): string {
  if (process.platform === 'win32') return path.toLowerCase();
  return process.platform === 'darwin' ? caseFold(path) : path;
}

/**
 * A name as APFS compares names: canonical normalization and full Unicode case folding, so `ß` and `ss`, `ſ` and `s`, and `ﬁ`
 * and `fi` are one name as well as `A` and `a` (#323). The dotless `ı` stays out of the round trip, since upper-casing it gives
 * `I` and APFS keeps it apart from `i`. Checked against APFS on macOS 26: for every code point up to U+1FFFF with a case or
 * normalization mapping, two spellings get the same key exactly when APFS opens them as the same name.
 */
export function caseFold(name: string): string {
  return name
    .normalize('NFC')
    .split('\u0131')
    .map((part) => part.toLowerCase().toUpperCase().toLowerCase().normalize('NFC'))
    .join('\u0131');
}
