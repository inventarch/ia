import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicResources } from './resources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--write'].includes(args[0])) throw new Error('Expected --check or --write');
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
const stale = [...generated].filter(([path, bytes]) => !existsSync(resolve(root, path)) || text(path) !== bytes);
if (args[0] === '--write') {
  for (const [path, bytes] of stale) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), bytes);
  }
} else if (stale.length) {
  console.error('Stale public authoring resources:\n' + stale.map(([path]) => path).join('\n'));
  process.exitCode = 1;
}
console.log(
  `${args[0] === '--write' ? 'Generated' : 'Checked'} ${generated.size} public authoring outputs; ${stale.length} differences.`,
);
