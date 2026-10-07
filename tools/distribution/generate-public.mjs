import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import { publicResources } from './resources.mjs';

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
  const manifest = JSON.parse(text('examples/public-language/manifest.json'));
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
  return { generated, stale: [...generated].filter(([path, bytes]) => read(path) !== bytes) };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) throw new Error('Expected --check or --write');
  const { generated, stale } = publicOutputs();
  if (args[0] === '--write') {
    for (const [path, bytes] of stale) {
      mkdirSync(dirname(resolve(repository, path)), { recursive: true });
      writeFileSync(resolve(repository, path), bytes);
    }
  } else if (stale.length) {
    console.error('Stale public authoring resources:\n' + stale.map(([path]) => path).join('\n'));
    process.exitCode = 1;
  }
  console.log(
    `${args[0] === '--write' ? 'Generated' : 'Checked'} ${generated.size} public authoring outputs; ${stale.length} differences.`,
  );
}
