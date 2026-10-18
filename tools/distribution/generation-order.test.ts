import '../temp/physical-temp.mjs';
import { cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { publicOutputs } from './generate-public.mjs';
import { authoringResources } from './generate-authoring.js';
import { materializeSource } from '../testing/fixtures/source.js';
import { checkWrite } from '../shared/check-write.mjs';
import { vocabularyOutputs, SHIPPED_CATALOGUE, DOOR_CATALOGUE } from '../native/public-vocabulary.js';
import { nativeBaseline, nativeRelease, NATIVE_CURRENT } from '../release/native-version.js';
import { prepareNativeSelection } from '../release/native-selectors.mjs';
import { generateProjections } from '../projections/generate.js';

const source = resolve(import.meta.dirname, '../..'),
  roots: string[] = [];
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'ia-generation-')),
    root = join(parent, 'repository');
  roots.push(parent);
  mkdirSync(root);
  cpSync(join(source, '.ia/src'), join(root, '.ia/src'), {
    recursive: true,
    filter: (path) =>
      !['node_modules', 'dist'].includes(basename(path)) &&
      (lstatSync(path).isDirectory() || /\.(?:ia|md|json)$/.test(path)),
  });
  for (const path of ['docs/reference/language/vocabulary.json', 'examples/public-language/manifest.json']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path));
  }
  return { root, parent };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('ia-generation-'))
      throw Error('Unsafe generation fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it('computes byte-identical authoring manifests through both generator paths', () => {
  const { root } = fixture();
  expect(publicOutputs(root).generated.get('.ia/authoring.resources.json')).toBe(authoringResources(root).output);
});

it.each(['hardlink', 'oversize', 'utf8', 'teaching-link'])(
  'applies identical authoring input refusals through public generation: %s',
  (kind) => {
    const { root, parent } = fixture(),
      path = join(root, '.ia/src/floor/README.md');
    if (kind === 'hardlink') linkSync(path, join(parent, 'foreign.md'));
    else if (kind === 'oversize') writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    else if (kind === 'utf8') writeFileSync(path, Buffer.from([0xff, 0xfe]));
    else writeFileSync(path, readFileSync(path, 'utf8') + '\n[Missing](missing-selected-guide.md)\n');
    const before = readFileSync(path);
    expect(() => authoringResources(root)).toThrow();
    expect(() => publicOutputs(root)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  },
);

it('stabilizes source-mutated vocabulary, authoring, selectors and archives within three passes, then projections', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ia-generation-')),
    root = join(parent, 'repository');
  roots.push(parent);
  materializeSource(source, root);
  const baseline = nativeBaseline(root),
    target = baseline.source.tag.slice(1).split('.').map(Number);
  target[2] = target[2]! + 1;
  const version = target.join('.');
  const json = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  json('releases/current.json', {
    format: 'ia.npm-cohort.v1',
    version,
    tag: 'latest',
    baseline: { version: baseline.source.tag.slice(1), commit: baseline.source.commit },
    cycles: [],
  });
  json('releases/native/notes.json', {
    format: 'ia.native-release-notes.v1',
    baseline: baseline.source,
    changes: baseline.archives.map((row) => ({
      id: row.id,
      bump: 'patch',
      summary: 'Scratch-only convergence fixture.',
    })),
  });
  const schema = '.ia/src/systems/work-system/schemas/task.schema.ia';
  const old = readFileSync(join(root, schema), 'utf8');
  const phrase = "What the task's owner does to complete it.";
  expect(old).toContain(phrase);
  writeFileSync(join(root, schema), old.replace(phrase, 'Scratch convergence: the action that completes this task.'));
  const guide = '.ia/src/systems/authoring-system/reference/task.md',
    beforeGuide = readFileSync(join(root, guide), 'utf8');
  const selector = '.ia/src/systems/work-system/system.ia',
    beforeSelector = readFileSync(join(root, selector), 'utf8');
  const generated = new Set<string>();
  const snapshot = () => new Map([...generated].sort().map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const write = (outputs: ReadonlyMap<string, string>) => {
    for (const path of outputs.keys()) generated.add(path);
    return checkWrite(root, outputs, { write: true }).changed;
  };
  const pass = () => {
    const changed: string[] = [],
      vocabulary = vocabularyOutputs(root);
    changed.push(
      ...write(
        new Map([
          ...Object.entries(vocabulary).map(([name, text]) => ['docs/reference/language/' + name, text] as const),
          [SHIPPED_CATALOGUE, vocabulary['vocabulary.json']],
          [DOOR_CATALOGUE, vocabulary['vocabulary.json']],
        ]),
      ),
    );
    changed.push(...write(publicOutputs(root).generated));
    changed.push(...write(new Map([['.ia/authoring.resources.json', authoringResources(root).output]])));
    const nativePaths = [NATIVE_CURRENT, ...prepareNativeSelection(root, version).keys()];
    for (const path of nativePaths) generated.add(path);
    const prior = new Map(nativePaths.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
    nativeRelease(root, 'write');
    for (const [path, text] of prior) if (text !== readFileSync(join(root, path), 'utf8')) changed.push(path);
    return changed;
  };
  const changes: string[][] = [];
  for (let i = 0; i < 3; i++) {
    changes.push(pass());
    if (changes.at(-1)!.length === 0) break;
  }
  expect(changes[0]!.length).toBeGreaterThan(0);
  expect(changes.at(-1), JSON.stringify(changes)).toEqual([]);
  expect(readFileSync(join(root, guide), 'utf8')).not.toBe(beforeGuide);
  expect(readFileSync(join(root, guide), 'utf8')).toContain('Scratch convergence');
  expect(readFileSync(join(root, selector), 'utf8')).not.toBe(beforeSelector);
  expect(nativeRelease(root, 'check').target).toBe(version);
  generateProjections(root, true);
  const stable = snapshot();
  expect(pass()).toEqual([]);
  expect(snapshot()).toEqual(stable);
  expect(generateProjections(root, false)).toEqual([]);
  expect(publicOutputs(root).stale).toEqual([]);
}, 180_000);
