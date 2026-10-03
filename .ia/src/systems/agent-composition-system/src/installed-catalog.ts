import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { platformDebris } from '@inventarch/db/distribution';
import { digest } from '@inventarch/session-system';

/** Node host helper over fixed installed package entrypoints, never record- or model-supplied paths.
 * Bundled hosts supply their verified release artifact digest to inspectionCatalog instead. */
export function installedImplementationDigest(): string {
  const database = import.meta.resolve('@inventarch/db');
  const entries: [string, string][] = [
    ['agent-composition-system', fileURLToPath(import.meta.url)],
    ['agent-system', fileURLToPath(import.meta.resolve('@inventarch/agent-system'))],
    ['session-system', fileURLToPath(import.meta.resolve('@inventarch/session-system'))],
    ['template-system', fileURLToPath(import.meta.resolve('@inventarch/template-system'))],
    ['authoring-system', fileURLToPath(import.meta.resolve('@inventarch/authoring-system'))],
    ['runtime', fileURLToPath(import.meta.resolve('@inventarch/runtime'))],
    ['db', fileURLToPath(database)],
    ['graph', fileURLToPath(import.meta.resolve('@inventarch/graph'))],
    ['language', fileURLToPath(import.meta.resolve('@inventarch/language'))],
    ['compliance', createRequire(database).resolve('@inventarch/compliance')],
  ];
  const files: { package: string; path: string; digest: string }[] = [];
  for (const [name, entry] of entries) {
    const root = dirname(entry);
    const visit = (directory: string): void => {
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (child.isSymbolicLink()) throw new Error('Installed code aliases are unsupported');
        const path = resolve(directory, child.name);
        if (child.isDirectory()) visit(path);
        else if (
          /\.(?:[cm]?js|ts)$/.test(child.name) &&
          !child.name.endsWith('.d.ts') &&
          !(child.isFile() && platformDebris(child.name))
        )
          files.push({
            package: name,
            path: relative(root, path).replaceAll('\\', '/'),
            digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
          });
      }
    };
    visit(root);
  }
  files.sort((a, b) => (`${a.package}/${a.path}` < `${b.package}/${b.path}` ? -1 : 1));
  return digest(files);
}
