/**
 * The compatibility index of `inventarch/language`: one schema catalogue per base of the major, read from each base's
 * verified archive bytes, so a minimum base can be computed (`languageFloor` in `@inventarch/db/distribution`) without
 * the archives at hand. It covers every base in the ledger (`language-bases.ts`) and the base this tree builds
 * (`language-base.ts`) when that one is newer and so not yet released.
 *
 * A base archive carries its systems, schemas and `records/language.ia` but no floor: a reader supplies the floor from
 * its kernel (`KERNEL_SOURCES`, as `packages/db/src/inputs.ts` does for an installed base). The catalogue therefore
 * reads each archive with this tree's kernel floor, which is what a current carrier reads it with; the floor words
 * (`schema`, `system`) and the taxonomy words come out the same for every base, and every other word is the archive's.
 *
 * `--write` writes the index to `releases/native/language-compat.json` and, for the CLI that ships it,
 * `apps/cli/assets/language-compat.json`; `--check` fails when either differs.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { KERNEL_SOURCES } from '../../packages/language/src/index.js';
import type { BaseCatalogue, CatalogueWord, CompatIndex } from '../../packages/db/src/distribution/index.js';
import { isEntry } from '../entry/is-entry.mjs';
import { checkWrite } from '../shared/check-write.mjs';
import { generationMode } from '../shared/args.mjs';
import { compileNative } from './compile.js';
import type { NativeInput } from './compile.js';
import { BASE_ID, buildLanguageBase } from './language-base.js';
import { compareVersions, ledgerArchive, readBaseLedger } from './language-bases.js';

export const COMPAT_PATH = 'releases/native/language-compat.json';
/** `ia floor`, `ia pack` and `ia update` read the index shipped inside the installed @inventarch/cli package. */
export const SHIPPED_COMPAT = 'apps/cli/assets/language-compat.json';
/** The language record's path inside a base archive. */
const LANGUAGE_RECORD = /(^|\/)records\/language\.ia$/;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One base's catalogue from its archive bytes, refused unless they verify against `digest` and compile cleanly. */
export function baseCatalogue(bytes: Buffer, digest: string): BaseCatalogue {
  const { manifest, files, archiveDigest } = verifyArchive(bytes, digest);
  const floor: NativeInput[] = KERNEL_SOURCES.map(({ path, text }) => ({
    path,
    text,
    location: { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' },
  }));
  const sources: NativeInput[] = manifest.files
    .filter((file) => file.role === 'source' && file.path.endsWith('.ia'))
    .map((file) => ({
      path: file.path,
      text: files.get(file.path)!.toString('utf8').replace(/\r\n/g, '\n'),
      location: file.path.startsWith('.ia/src/floor/')
        ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
        : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    }));
  const compiled = compileNative([...floor, ...sources]);
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0)
    throw new Error(
      `${manifest.id}@${manifest.version} does not compile: ${errors.map((error) => error.message).join('; ')}`,
    );
  const records = manifest.files.filter((file) => LANGUAGE_RECORD.test(file.path));
  if (records.length !== 1) throw new Error(`${manifest.id}@${manifest.version} carries no single records/language.ia`);
  const words: Record<string, CatalogueWord> = {};
  for (const registration of [...compiled.registry.registrations.values()].sort((a, b) =>
    byCodeUnit(a.keyword, b.keyword),
  )) {
    const schema = compiled.registry.schemas.get(registration.schema);
    if (!schema) throw new Error(`${manifest.id}@${manifest.version} has no schema for ${registration.keyword}`);
    words[registration.keyword] = {
      closed: schema.closed,
      sections: schema.sections.map(({ name, must }) => ({ name, required: must })),
      fields: schema.fields.map(({ section, key, type, must, values, target }) => ({
        path: `${section}.${key}`,
        type,
        required: must,
        ...(values ? { values: [...values] } : {}),
        ...(target ? { target } : {}),
      })),
      edges: schema.edges.map(({ predicate, direction, must }) => ({ predicate, direction, required: must })),
    };
  }
  return {
    version: manifest.version,
    archive: archiveDigest,
    engine: manifest.engine,
    language: [...manifest.language],
    languageRecord: sha256(files.get(records[0]!.path)!),
    words,
  };
}

/** Every ledger base in ascending order, then the built base when it is newer than all of them. */
export function compatIndex(root: string): CompatIndex {
  const ledger = readBaseLedger(root);
  const bases = ledger.bases.map((base) => baseCatalogue(ledgerArchive(root, base), base.archive));
  const built = buildLanguageBase(root);
  const newest = ledger.bases[ledger.bases.length - 1];
  if (newest === undefined || compareVersions(built.pin.version, newest.version) > 0)
    bases.push(baseCatalogue(built.bytes, built.pin.archive));
  return { format: 'ia.language-compat.v1', id: BASE_ID, major: ledger.major, bases };
}

/** The index text at each path it is written to, in write order. */
export function languageCompatOutputs(root: string): Map<string, string> {
  const text = JSON.stringify(compatIndex(root), null, 2) + '\n';
  return new Map([
    [COMPAT_PATH, text],
    [SHIPPED_COMPAT, text],
  ]);
}

/** Compares (`check`) or writes (`write`) the outputs under `root`; returns the changed paths, and refuses drift in check. */
export function settleLanguageCompat(
  root: string,
  outputs: ReadonlyMap<string, string>,
  mode: 'check' | 'write',
): string[] {
  const { changed } = checkWrite(root, outputs, { write: mode === 'write', normalizeNewlines: true });
  if (mode === 'check' && changed.length > 0)
    throw new Error('Language compatibility index drift: ' + changed.join(', '));
  return changed;
}

if (isEntry(process.argv[1], import.meta.url)) {
  let mode: 'check' | 'write' | undefined;
  try {
    mode = generationMode(process.argv.slice(2), { defaultCheck: false });
  } catch (error) {
    console.error('Usage: language-compat.ts --check|--write');
    console.error(String(error));
    process.exitCode = 2;
  }
  if (mode)
    try {
      const root = fileURLToPath(new URL('../../', import.meta.url)),
        outputs = languageCompatOutputs(root);
      settleLanguageCompat(root, outputs, mode);
      const index = JSON.parse(outputs.get(COMPAT_PATH)!) as CompatIndex;
      console.log(
        `Language compatibility index: ${index.bases.map((base) => base.version).join(', ')}; committed and shipped copies ${mode === 'write' ? 'written' : 'verified'}.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
