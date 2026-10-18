import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import { publicSystemNames } from '../native/public-systems.mjs';
import { LANG_CODES } from '../../packages/language/src/index.js';
import { GRAPH_CODES } from '../../packages/graph/src/index.js';
import { COMP_CODES, EVIDENCE_CODES } from '../../packages/compliance/src/index.js';
import { loadCorpus } from '../../packages/compliance/src/conformance/corpus.js';
import { companionSuffixes, fileDigest, inventoryDigest } from '../../packages/compliance/src/conformance/inventory.js';
import type { ConformanceInventory, InventoryFixture } from '../../packages/compliance/src/conformance/inventory.js';
import { runRefusalFixtures } from '../../packages/compliance/src/conformance/refusals.js';
import { HOOK_CODES, PUBLICATION_CODES, RUNTIME_CODES, RUNTIME_ESCALATIONS } from '../../packages/runtime/src/index.js';
import { EXEC_CODES } from '@inventarch/runtime/authoring-execution';
import { runEvidenceFixtures } from '../../packages/compliance/src/conformance/evidence-fixtures.js';

export const INVENTORY_PATH = 'packages/compliance/src/conformance/inventory.generated.ts';
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (codes: readonly string[]): string[] => [...new Set(codes)].sort(compare);

function fixtures(root: string): InventoryFixture[] {
  const base = resolve(root, 'packages/compliance/fixtures/language'),
    listed: InventoryFixture[] = [];
  for (const clause of readdirSync(base, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    if (!clause.isDirectory()) throw new Error(`Unexpected fixture entry ${clause.name}`);
    for (const mode of readdirSync(resolve(base, clause.name), { withFileTypes: true })) {
      if (!mode.isDirectory() || (mode.name !== 'pass' && mode.name !== 'fail'))
        throw new Error(`Unexpected fixture entry ${clause.name}/${mode.name}`);
      const folder = resolve(base, clause.name, mode.name),
        allowed = companionSuffixes(clause.name, mode.name);
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const suffix = entry.name.endsWith('.ia') ? '.ia' : allowed.find((s) => entry.name.endsWith(s));
        if (
          !entry.isFile() ||
          suffix === undefined ||
          !existsSync(resolve(folder, entry.name.slice(0, -suffix.length) + '.ia'))
        )
          throw new Error(`Unexpected fixture entry or orphan companion ${clause.name}/${mode.name}/${entry.name}`);
        if (suffix !== '.ia') continue;
        const stem = entry.name.slice(0, -3),
          files: Record<string, string> = {};
        for (const kind of ['.ia', ...allowed]) {
          const file = resolve(folder, stem + kind);
          if (existsSync(file)) files[kind] = fileDigest(readFileSync(file));
        }
        listed.push({ path: `${clause.name}/${mode.name}/${entry.name}`, clause: clause.name, mode: mode.name, files });
      }
    }
  }
  return listed.sort((a, b) => compare(a.path, b.path));
}
function corpus(root: string): { path: string; text: string }[] {
  const base = resolve(root, 'examples/conformance/native');
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(path, entry.name))
        : entry.name.endsWith('.ia')
          ? [resolve(path, entry.name)]
          : [],
    );
  return walk(base)
    .map((path) => ({
      path: '.ia/src/' + relative(base, path).replaceAll('\\', '/'),
      text: readFileSync(path, 'utf8'),
    }))
    .sort((a, b) => compare(a.path, b.path));
}

/** The package-v1 inventory of this tree: what verifyFixtures runs, and what it reports as out of profile. */
export function generateInventory(root: string): { text: string; digest: string; inventory: ConformanceInventory } {
  const sources = corpus(root),
    folders = publicSystemNames(root) as string[],
    loaded = loadCorpus(sources, folders);
  const boundaries = [
    ...runRefusalFixtures(loaded.graph, loaded.inputs, loaded.folders),
    ...runEvidenceFixtures(loaded.graph),
  ].map((result) => result.assessment.scope);
  if (new Set(boundaries).size !== boundaries.length) throw new Error('Duplicate boundary case scope');
  const inventory: ConformanceInventory = {
    profile: 'package-v1',
    fixtures: fixtures(root),
    corpus: sources,
    folders,
    boundaries: boundaries.sort(compare),
    requiredCodes: sorted([...LANG_CODES, ...GRAPH_CODES, ...COMP_CODES, ...EVIDENCE_CODES]),
    outOfProfile: [
      { suite: 'HOOK', reason: 'The hook fixtures start host hook processes.', codes: sorted(HOOK_CODES) },
      {
        suite: 'RUNTIME',
        reason:
          'The runtime, actor, read, next and mandate fixtures need a repository root, temporary directories or @inventarch/runtime.',
        codes: sorted(RUNTIME_CODES),
      },
      {
        suite: 'escalation',
        reason: 'Runtime escalations are observed only by the runtime fixtures.',
        codes: sorted(RUNTIME_ESCALATIONS),
      },
      {
        suite: 'EXEC',
        reason: 'The execution fixtures run system executions against a repository root.',
        codes: sorted(EXEC_CODES),
      },
      {
        suite: 'PUBLICATION',
        reason: 'The publication fixtures create and write a temporary directory.',
        codes: sorted(PUBLICATION_CODES),
      },
    ],
  };
  const digest = inventoryDigest(inventory);
  const text =
    '// Generated by tools/compliance/inventory.ts from the language fixtures and the conformance corpus; do not edit.\n' +
    "import type { ConformanceInventory } from './inventory.js';\n\n" +
    `export const INVENTORY: ConformanceInventory = ${JSON.stringify(inventory, null, 2)};\n\n` +
    `export const INVENTORY_DIGEST = ${JSON.stringify(digest)};\n`;
  return { text, digest, inventory };
}
/** The inventory gate: regenerate and compare with the checked-in module, or write it. */
export function checkInventory(root: string, write = false): { digest: string; fixtures: number } {
  const result = generateInventory(root),
    path = resolve(root, INVENTORY_PATH);
  if (write) writeFileSync(path, result.text);
  else if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== result.text)
    throw new Error(
      'Inventory drift: run node --conditions=development --import tsx tools/compliance/inventory.ts --write and review the result',
    );
  return { digest: result.digest, fixtures: result.inventory.fixtures.length };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const flag = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(flag)) throw new Error('Usage: inventory.ts [--check|--write]');
  const result = checkInventory(fileURLToPath(new URL('../../', import.meta.url)), flag === '--write');
  process.stdout.write(`Inventoried ${result.fixtures} language fixtures; digest ${result.digest}.\n`);
}
