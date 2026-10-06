import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, load } from '../../packages/graph/src/index.js';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '../../packages/language/src/index.js';
import { compileHarness } from '../../.ia/src/systems/agent-composition-system/src/compile.js';
import { installed } from '../../.ia/src/systems/agent-composition-system/src/catalog.js';
import type { CompositionCatalog } from '../../.ia/src/systems/agent-composition-system/src/catalog.js';
import type { Capture } from '../../.ia/src/systems/agent-composition-system/src/corpus.js';
import { checkNative } from './check.js';
import type { NativeInput } from './compile.js';
import { isEntry } from '../entry/is-entry.mjs';

interface Manifest {
  version: 1;
  floor: string[];
  systems: { name: string; declaration: string; schemas: string[] }[];
  examples: { file: string; system: string }[];
}
/** The file whose `@distribution language-distribution` roots the bundled `inventarch/language` package. */
export const LANGUAGE_ROOT = 'records/language.ia';
/** Floor, contracts, schemas and the language root only: packing whole system folders must not ship the examples. */
export function languagePackageInputs(root: string): { inputs: NativeInput[]; folders: string[] } {
  return publicLanguageInputs(root, [LANGUAGE_ROOT]);
}
export function publicLanguageInputs(
  root: string,
  examples?: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): { inputs: NativeInput[]; folders: string[] } {
  const base = resolve(root, 'examples/public-language');
  const manifest = JSON.parse(read(resolve(base, 'manifest.json'))) as Manifest;
  if (manifest.version !== 1) throw new Error('Unsupported public language manifest');
  const inputs: NativeInput[] = [],
    paths = new Set<string>();
  const add = (path: string, file: string, floor = false): void => {
    if (paths.has(path)) throw new Error(`Duplicate public input ${path}`);
    paths.add(path);
    inputs.push({
      path,
      text: read(file).replace(/\r\n/g, '\n'),
      location: floor
        ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
        : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    });
  };
  for (const path of manifest.floor) add(path, resolve(root, path), true);
  for (const system of manifest.systems) {
    add(`.ia/src/systems/${system.name}/system.ia`, resolve(base, system.declaration));
    for (const path of system.schemas) add(path, resolve(root, path));
  }
  if (examples?.some((file) => !manifest.examples.some((example) => example.file === file)))
    throw new Error('Selected public example is not in the manifest');
  for (const example of manifest.examples)
    if (!examples || examples.includes(example.file))
      add(`.ia/src/systems/${example.system}/${example.file}`, resolve(base, example.file));
  return { inputs, folders: manifest.systems.map((s) => s.name) };
}
export function exampleCatalog(): CompositionCatalog {
  return {
    hosts: {
      'example-host': installed({
        effects: ['read'],
        models: ['example-model'],
        limits: { modelCalls: 1, steps: 2, tokens: 4096 },
        defaults: {
          model: 'example-model',
          input: 'example-text',
          outcomes: 'example-outcomes',
          context: 'example-context',
          mapping: 'example-identity',
        },
      }),
    },
    models: { 'example-model': installed({ model: 'uninvoked-example-model' }) },
    validators: { 'example-text': installed({ schema: { type: 'string', maxLength: 1024 } }) },
    outcomes: { 'example-outcomes': installed({ kinds: ['answer'], completion: 'response' }) },
    mandates: {
      'example-mandate': installed({
        input: 'example-text',
        outcomes: 'example-outcomes',
        effects: ['read'],
        context: 'example-context',
        limits: {},
        checks: [],
      }),
    },
    contexts: {
      'example-context': installed({
        scope: 'captured-workspace',
        coordinate: { phase: 'act', primitive: 'Attention', category: 'capability' },
        tokens: 4096,
        records: 100,
      }),
    },
    operations: {},
    evaluators: {},
    entries: { 'example-entry-v1': installed({ target: 'agent-profile', mapping: 'example-identity' }) },
    mappings: { 'example-identity': installed({ kind: 'identity' }) },
  };
}
export function publicCapture(inputs: readonly NativeInput[], folders: readonly string[]): Capture {
  const body = {
    version: 1 as const,
    id: 'public-example',
    sources: inputs,
    folders,
    floorOrigin: 'explicit' as const,
  };
  return { ...body, revision: digest(body) };
}
export function checkPublicLanguage(root: string) {
  const { inputs, folders } = publicLanguageInputs(root);
  return compilePublicLanguage(inputs, folders);
}
export function compilePublicLanguage(inputs: readonly NativeInput[], folders: readonly string[]) {
  const native = checkNative(inputs, folders);
  const graph = load(native.records, native.registry, {
    sources: inputs,
    kernelDigest: KERNEL_DIGEST,
    languageVersion: LANGUAGE_VERSION,
    location: '',
  });
  const harness = compileHarness(publicCapture(inputs, folders), {
    harness: 'example-harness',
    entry: 'example-entry',
    catalog: exampleCatalog(),
  });
  return {
    inputs,
    folders,
    native,
    graph,
    harness,
    ok:
      native.ok && graph.dangling.length === 0 && !graph.diagnostics.some((d) => d.severity === 'error') && harness.ok,
  };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const result = checkPublicLanguage(fileURLToPath(new URL('../../', import.meta.url)));
  if (!result.ok)
    console.log(
      JSON.stringify(
        {
          diagnostics: result.native.diagnostics,
          findings: result.native.assessments.flatMap((a) => a.findings),
          graph: result.graph.diagnostics,
          harness: result.harness,
        },
        null,
        2,
      ),
    );
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}: ${result.native.records.length} public-example records; ${result.native.registry.registrations.size} words; harness ${result.harness.ok ? 'compiled' : 'refused'}`,
  );
  process.exitCode = result.ok ? 0 : 1;
}
