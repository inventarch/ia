import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function noAliases(path) {
  for (let current = resolve(path); ; ) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw new Error(`Aliased extraction path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export function within(parent, path) {
  const local = relative(resolve(parent), resolve(path));
  return (
    local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\'))
  );
}
export function separate(target, ...sources) {
  noAliases(target);
  for (const source of sources) {
    noAliases(source);
    if (within(source, target) || within(target, source)) throw new Error('Choose a separate candidate directory');
  }
}
export function child(root, path) {
  const target = resolve(root, path);
  if (!path || isAbsolute(path) || !within(root, target) || target === resolve(root))
    throw new Error('Unsafe extraction path');
  noAliases(target);
  return target;
}
