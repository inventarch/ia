import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import { createRequire } from 'node:module';
const common = {
  bundle: true,
  sourcemap: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  logLevel: 'warning',
};
const bundles = [];
bundles.push(
  await build({ ...common, metafile: true, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' }),
);
bundles.push(await build({ ...common, metafile: true, entryPoints: ['src/server.ts'], outfile: 'dist/server.cjs' }));
const packages = new Map();
for (const input of bundles.flatMap((b) => Object.keys(b.metafile.inputs))) {
  let directory = dirname(resolve(input));
  while (directory !== parse(directory).root) {
    const path = resolve(directory, 'package.json');
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.name && manifest.name !== 'inventarch-ia' && !packages.has(manifest.name)) {
        const notices = readdirSync(directory).filter((name) => /^(licen[cs]e|notice|copyright)(\.|$)/i.test(name));
        packages.set(manifest.name, {
          name: manifest.name,
          version: manifest.version,
          license: manifest.license ?? 'Not declared',
          notices: notices.map((name) => readFileSync(resolve(directory, name), 'utf8')).join('\n\n'),
        });
      }
      break;
    }
    directory = dirname(directory);
  }
}
writeFileSync(
  'THIRD_PARTY_NOTICES.txt',
  'Bundled dependency inventory. No license for InventArch source is granted by this inventory.\n\n' +
    [...packages.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `${p.name}@${p.version}\nDeclared license: ${p.license}\n${p.notices}`)
      .join('\n\n----------------------------------------\n\n'),
);
