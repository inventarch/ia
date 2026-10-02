/**
 * The bundled `inventarch/language` base package: docs/specs/workspace-initialization-apply/README.md
 * §2, producing what docs/specs/workspace-initialization/README.md §3 ships.
 *
 * Packs the language-only source set `languagePackageInputs` returns — floor, the ten contracts and schemas, and
 * `records/language.ia`, never the public examples (M5.1 §3.1) — with the same `distributionSnapshot` and
 * `packSnapshot` calls `public-language.test.ts` exercises. `--write` emits the archive bytes at
 * `apps/cli/assets/base/<archive digest>.ia.tgz` and the pin `{ id, version, archive, manifest }` at
 * `apps/cli/assets/base.json`, after removing every other file under `assets/base/` so exactly one archive ships.
 * Both are gitignored build output: the root `build` runs this before `pnpm -r build`, and the public export
 * carries this file so `release:pack-public` regenerates the archive from public sources (§2.2).
 *
 * Packing is deterministic for fixed inputs (`ustar-v1`, epoch 0), so two builds of one revision on one zlib build
 * produce the same bytes and the same pin. §2.3's build-time checks are `languageBaseFindings`; the generator refuses to write while
 * any of them fails, so a CLI whose engine the bundled range rejects never ships.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { distributionSnapshot, packSnapshot } from '../../apps/distribution/src/snapshot.js';
import { DISTRIBUTION_ENGINE_VERSION, satisfies } from '../../packages/db/src/distribution/index.js';
import { languagePackageInputs } from './public-language.js';
import { isEntry } from '../entry/is-entry.mjs';

export const BASE_ID = 'inventarch/language';
/** The pin and the one archive it names, relative to the `@ia/cli` package root (M5.1 §3.2). */
export const PIN_PATH = 'assets/base.json';
export const ARCHIVE_DIRECTORY = 'assets/base';
export const archivePath = (digest: string): string => `${ARCHIVE_DIRECTORY}/${digest}.ia.tgz`;

export interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}
export interface LanguageBase {
  readonly pin: BasePin;
  readonly bytes: Buffer;
}

/** §2.1's descriptor. `version` and `engine` are parameters only so §2.3's refusals can be exercised. */
export function languageBaseDescriptor(version: string, engine = `^${DISTRIBUTION_ENGINE_VERSION}`) {
  return {
    formatVersion: 1,
    id: BASE_ID,
    version,
    distribution: 'workspace-system/definition/distribution/language-distribution',
    engine,
    language: ['1.0'],
    dependencies: [],
    assets: [
      { path: 'LICENSE', role: 'license' },
      { path: 'NOTICE', role: 'license' },
    ],
    // M5.1 §3.3 and §6.1: unpublished local provenance until the public repository exists.
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    // Operator decision #162, 2026-10-01; final release review remains M7.3.
    license: 'Apache-2.0',
    description: 'Public IA language vocabulary',
  };
}

/** The `@ia/cli` version is the base version: M5.1 §3.3's lockstep rule. */
export const cliVersion = (root: string): string =>
  (JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')) as { version: string }).version;

export function buildLanguageBase(
  root: string,
  options: { readonly version?: string; readonly engine?: string } = {},
): LanguageBase {
  const { inputs, folders } = languagePackageInputs(root);
  const packed = packSnapshot(
    distributionSnapshot({ sources: inputs, folders, floorOrigin: 'local' }),
    languageBaseDescriptor(options.version ?? cliVersion(root), options.engine),
    new Map(['LICENSE', 'NOTICE'].map((path) => [path, readFileSync(resolve(root, path))])),
  );
  return {
    pin: {
      id: packed.manifest.id,
      version: packed.manifest.version,
      archive: packed.archiveDigest,
      manifest: packed.manifestDigest,
    },
    bytes: packed.bytes,
  };
}

/**
 * §2.3 and M5.1 §3.3, as findings rather than a throw so each disagreement is named on its own. The archive is
 * re-verified from its bytes, so the pin is compared with what the archive actually is, not with what the packer
 * said it produced.
 */
export function languageBaseFindings(input: {
  readonly pin: BasePin;
  readonly bytes: Uint8Array;
  readonly cliVersion: string;
  readonly engineVersion: string;
}): readonly string[] {
  const { pin, bytes } = input,
    findings: string[] = [];
  if (pin.id !== BASE_ID) findings.push(`Pinned id ${pin.id} is not ${BASE_ID}`);
  if (pin.version !== input.cliVersion)
    findings.push(`Pinned version ${pin.version} differs from @ia/cli ${input.cliVersion}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.archive) findings.push(`Archive digest ${digest} differs from the pinned ${pin.archive}`);
  try {
    const verified = verifyArchive(bytes);
    if (verified.manifestDigest !== pin.manifest)
      findings.push(`Manifest digest ${verified.manifestDigest} differs from the pinned ${pin.manifest}`);
    if (verified.manifest.id !== pin.id || verified.manifest.version !== pin.version)
      findings.push(
        `Archive carries ${verified.manifest.id}@${verified.manifest.version}, not the pinned ${pin.id}@${pin.version}`,
      );
    if (!satisfies(input.engineVersion, verified.manifest.engine))
      findings.push(`Bundled engine range ${verified.manifest.engine} rejects the CLI engine ${input.engineVersion}`);
  } catch (error) {
    findings.push(`Archive does not verify: ${error instanceof Error ? error.message : String(error)}`);
  }
  return findings;
}

/** Writes the archive before the pin, so an interrupted write never leaves a pin naming an absent archive. */
export function writeLanguageBase(root: string, base: LanguageBase): void {
  const cli = resolve(root, 'apps/cli'),
    directory = resolve(cli, ARCHIVE_DIRECTORY),
    name = `${base.pin.archive}.ia.tgz`;
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory))
    if (entry !== name) rmSync(resolve(directory, entry), { recursive: true, force: true });
  writeFileSync(resolve(cli, archivePath(base.pin.archive)), base.bytes);
  writeFileSync(resolve(cli, PIN_PATH), JSON.stringify(base.pin, null, 2) + '\n');
}

if (isEntry(process.argv[1], import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write') throw new Error('Usage: language-base.ts --write');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const base = buildLanguageBase(root);
  const findings = languageBaseFindings({
    ...base,
    cliVersion: cliVersion(root),
    engineVersion: DISTRIBUTION_ENGINE_VERSION,
  });
  if (findings.length > 0) {
    process.stderr.write(
      `Refusing to write the bundled base package:\n${findings.map((finding) => `  ${finding}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    writeLanguageBase(root, base);
    process.stdout.write(
      `Bundled ${base.pin.id}@${base.pin.version}: ${base.bytes.length} bytes, sha256 ${base.pin.archive}.\n`,
    );
  }
}
