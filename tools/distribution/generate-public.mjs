import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import { publicResources } from './resources.mjs';
import { authoringResources, AUTHORING_MANIFEST } from './authoring-resources.mjs';
import { checkWrite } from '../shared/check-write.mjs';
import { readPublicManifest } from '../native/public-manifest.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every public output this generator owns, in generation order, and those whose current text differs from it. `read`
 * returns a file's current text, or null when it is absent; a test passes its own to model a drifted file.
 */
export function publicOutputs(
  root = repository,
  read = (path) => (existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null),
) {
  const text = (path) => readFileSync(resolve(root, path), 'utf8');
  const manifest = readPublicManifest(root);
  const outputs = new Map();
  for (const base of ['.ia/src/floor', ...manifest.systems.map((system) => `.ia/src/systems/${system.name}`)]) {
    for (const name of [
      'README.md',
      'SPEC.md',
      ...(base.endsWith('/agent-composition-system')
        ? [
            'references/installed-read.md',
            'references/public-spec.md',
            'references/spec-read-boundary.md',
            'references/task-capture.md',
          ]
        : []),
    ]) {
      const path = `${base}/${name}`;
      if (existsSync(resolve(root, path))) outputs.set(path, { bytes: text(path) });
    }
  }
  const generated = new Map();
  const put = (path, bytes) => {
    outputs.set(path, { bytes });
    generated.set(path, bytes);
  };
  const json = (path, value) => put(path, JSON.stringify(value, null, 2) + '\n');
  publicResources({ outputs, text, put, json, manifest });
  put(AUTHORING_MANIFEST, authoringResources(root, generated).output);
  // Validate output aliases in check mode too; the caller-provided reader only models content drift.
  checkWrite(root, generated);
  return { generated, stale: [...generated].filter(([path, bytes]) => read(path) !== bytes) };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    console.error('Usage: generate-public.mjs --check|--write');
    process.exitCode = 2;
  } else
    try {
      const { generated, stale } = publicOutputs();
      if (args[0] === '--write') {
        checkWrite(repository, generated, { write: true });
      } else if (stale.length) {
        console.error('Stale public authoring resources:\n' + stale.map(([path]) => path).join('\n'));
        process.exitCode = 1;
      }
      console.log(
        `${args[0] === '--write' ? 'Generated' : 'Checked'} ${generated.size} public authoring outputs; ${stale.length} differences.`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
