import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { unaliased } from '@inventarch/db';
import { metadataDigest } from '@inventarch/db/distribution';

const required = ['archive', 'pack', 'resolve', 'snapshot', 'install', 'installation-core', 'inventory', 'transfer'];
const runtime = /\.(?:[cm]?[jt]sx?|json|node|wasm)$/;
const declaration = /\.d\.[cm]?ts$/;
function refuse(): never {
  throw new Error('Installed distribution runtime is missing, mixed or aliased');
}

/** Explicit installed byte inventory. A root override is trusted qualification configuration only. */
export function installedDistributionDigest(root = import.meta.dirname): string {
  if (!isAbsolute(root) || root.split(/[\\/]/).some((part) => part === '.' || part === '..')) return refuse();
  root = resolve(root);
  const volume = parse(root).root;
  let current = volume;
  for (const part of relative(volume, root).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    // Another case or normalization of an existing name is the same directory (#315); a link is refused on its own.
    if (lstatSync(current).isSymbolicLink() || !unaliased(current, realpathSync.native(current))) return refuse();
  }
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return refuse();
  const files: { path: string; sha256: string }[] = [],
    names = new Set<string>();
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name),
        path = relative(root, absolute).replaceAll('\\', '/'),
        key = path.toLowerCase(),
        stat = lstatSync(absolute);
      if (names.has(key) || stat.isSymbolicLink() || path.normalize('NFC') !== path) return refuse();
      names.add(key);
      if (stat.isDirectory()) visit(absolute);
      else if (!stat.isFile()) refuse();
      else if (runtime.test(entry.name) && !declaration.test(entry.name))
        files.push({ path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') });
    }
  }
  visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const source = files.some((file) => /\.[cm]?tsx?$/.test(file.path)),
    emitted = files.some((file) => /\.[cm]?jsx?$/.test(file.path));
  if (source === emitted || !required.every((name) => names.has(`${name}.${source ? 'ts' : 'js'}`))) return refuse();
  return metadataDigest({ version: 'ia-distribution-runtime-v1', kind: source ? 'source' : 'emitted', files });
}
