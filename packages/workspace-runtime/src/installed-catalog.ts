import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { platformDebris } from '@inventarch/db/distribution';
import { SessionError, digest } from '@inventarch/session-system';

/** One installed package to pin: its name and the file path of its installed entrypoint. */
export type InstalledImplementationEntry = readonly [name: string, entry: string];
/** Each pinned package directory is walked within the bounds of the steward hook implementation inventory. */
const INVENTORY_DEPTH = 16,
  INVENTORY_ENTRIES = 2000,
  FILE_BYTES = 8 * 1024 * 1024,
  PACKAGE_BYTES = 32 * 1024 * 1024;
function refuse(message: string): never {
  throw new SessionError('IA-CORPUS-DENIED', message);
}
/** Node host helper over fixed installed package entrypoints, never record- or model-supplied paths.
 * An upper package pins its own installed entrypoint through `additional`, taken from its own module URL.
 * Every pinned directory walk is bounded in depth, entries and bytes; a larger tree is refused, never truncated.
 * Bundled hosts supply their verified release artifact digest to inspectionCatalog instead. */
export function installedImplementationDigest(additional: readonly InstalledImplementationEntry[] = []): string {
  const database = import.meta.resolve('@inventarch/db');
  const entries: InstalledImplementationEntry[] = [
    ['workspace-runtime', fileURLToPath(import.meta.url)],
    ['agent-system', fileURLToPath(import.meta.resolve('@inventarch/agent-system'))],
    ['session-system', fileURLToPath(import.meta.resolve('@inventarch/session-system'))],
    ['template-system', fileURLToPath(import.meta.resolve('@inventarch/template-system'))],
    ['authoring-system', fileURLToPath(import.meta.resolve('@inventarch/authoring-system'))],
    ['runtime', fileURLToPath(import.meta.resolve('@inventarch/runtime'))],
    ['db', fileURLToPath(database)],
    ['graph', fileURLToPath(import.meta.resolve('@inventarch/graph'))],
    ['language', fileURLToPath(import.meta.resolve('@inventarch/language'))],
    ['compliance', createRequire(database).resolve('@inventarch/compliance')],
    ...additional,
  ];
  const files: { package: string; path: string; digest: string }[] = [];
  for (const [name, entry] of entries) {
    const root = dirname(entry);
    let count = 0,
      total = 0;
    const visit = (directory: string, depth: number): void => {
      if (depth > INVENTORY_DEPTH) refuse('Installed implementation inventory exceeds its bound');
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (++count > INVENTORY_ENTRIES) refuse('Installed implementation inventory exceeds its bound');
        if (child.isSymbolicLink()) throw new Error('Installed code aliases are unsupported');
        const path = resolve(directory, child.name);
        if (child.isDirectory()) visit(path, depth + 1);
        else if (
          /\.(?:[cm]?js|ts)$/.test(child.name) &&
          !child.name.endsWith('.d.ts') &&
          !(child.isFile() && platformDebris(child.name))
        ) {
          const stat = lstatSync(path);
          if (!stat.isFile()) refuse('Installed implementation has a nonregular file');
          if (stat.size > FILE_BYTES || (total += stat.size) > PACKAGE_BYTES)
            refuse('Installed implementation bytes exceed their bound');
          files.push({
            package: name,
            path: relative(root, path).replaceAll('\\', '/'),
            digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
          });
        }
      }
    };
    visit(root, 0);
  }
  files.sort((a, b) => (`${a.package}/${a.path}` < `${b.package}/${b.path}` ? -1 : 1));
  return digest(files);
}
