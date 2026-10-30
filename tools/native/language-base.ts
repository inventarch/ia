import { parseOptions } from '../shared/args.mjs';
/**
 * The bundled `inventarch/language` base package: docs/specs/workspace-initialization-apply/README.md
 * §2, producing what docs/specs/workspace-initialization/README.md §3 ships.
 *
 * Packs the language-only source set `languagePackageInputs` returns — floor, the manifest-selected contracts and schemas, and
 * `records/language.ia`, never the public examples (workspace initialization §3 “Bundled language”) — with the same `distributionSnapshot` and
 * `packSnapshot` calls `public-language.test.ts` exercises. `--write` emits the archive bytes at
 * `<package>/assets/base/<archive digest>.ia.tgz` and the pin `{ id, version, archive, manifest }` at
 * `<package>/assets/base.json` for `apps/cli` and `apps/mcp-door`, before retiring obsolete verified archives under
 * `assets/base/`; foreign entries refuse before writing.
 * Both are gitignored build output: the root `build` runs this before `pnpm -r build`. Public release
 * preparation regenerates the archive from public sources (apply contract §2 “Base artifact”).
 *
 * Packing is deterministic for fixed inputs (`ustar-v1`, epoch 0), so two builds of one revision on one zlib build
 * produce the same bytes and the same pin. The “Base artifact” build-time checks are `languageBaseFindings`; the generator refuses to write while
 * any of them fails, so a CLI whose engine the bundled range rejects never ships.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { distributionSnapshot, packSnapshot } from '../../apps/distribution/src/snapshot.js';
import { DISTRIBUTION_ENGINE_VERSION, satisfies } from '../../packages/db/src/distribution/index.js';
import { languagePackageInputs } from './public-language.js';
import { isEntry } from '../entry/is-entry.mjs';
import { containedFile, readRegular } from '../shared/paths.mjs';

export const BASE_ID = 'inventarch/language';
/** The pin and the one archive it names, relative to the `@inventarch/cli` package root (workspace initialization §3 “Bundled language”). */
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

/** The base artifact descriptor. `version` and `engine` are parameters so compatibility refusals can be exercised. */
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
    // Local archive builds retain neutral provenance; the release receipt binds the reviewed public source.
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    // The public package license; publication approval remains a separate release boundary.
    license: 'Apache-2.0',
    description: 'Public IA language vocabulary',
  };
}

/** Derived native artifact selector; `pnpm native:version` selects it by content, never changing syntax or protocol. */
export function languageVersion(root: string): string {
  const policy = JSON.parse(readFileSync(resolve(root, 'examples/public-language/versions.json'), 'utf8')) as {
    format: string;
    language: string;
  };
  if (
    policy.format !== 'ia.public-native-versions.v1' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(policy.language)
  )
    throw new Error('Invalid native language version policy');
  return policy.language;
}

export function buildLanguageBase(
  root: string,
  options: { readonly version?: string; readonly engine?: string } = {},
): LanguageBase {
  const { inputs, folders } = languagePackageInputs(root);
  const packed = packSnapshot(
    distributionSnapshot({ sources: inputs, folders, floorOrigin: 'local' }),
    languageBaseDescriptor(options.version ?? languageVersion(root), options.engine),
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
 * Base artifact compatibility checks, as findings rather than a throw so each disagreement is named on its own. The archive is
 * re-verified from its bytes, so the pin is compared with what the archive actually is, not with what the packer
 * said it produced.
 */
export function languageBaseFindings(input: {
  readonly pin: BasePin;
  readonly bytes: Uint8Array;
  readonly languageVersion: string;
  readonly engineVersion: string;
}): readonly string[] {
  const { pin, bytes } = input,
    findings: string[] = [];
  if (pin.id !== BASE_ID) findings.push(`Pinned id ${pin.id} is not ${BASE_ID}`);
  if (pin.version !== input.languageVersion)
    findings.push(`Pinned version ${pin.version} differs from native language policy ${input.languageVersion}`);
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

/** The packages that carry the base: the CLI, and the MCP door, which restores a method kit's read root in process. */
export const BASE_PACKAGES = ['apps/cli', 'apps/mcp-door'] as const;

/** Writes the base into each package that carries it (`BASE_PACKAGES`), in order. */
export function writeLanguageBase(root: string, base: LanguageBase): void {
  for (const directory of BASE_PACKAGES) writePackageBase(root, base, directory);
}

/** Preflight the complete output set; publish the archive before its pin, then retire only owned archives. */
function writePackageBase(root: string, base: LanguageBase, directory: string): void {
  if (
    !/^[a-f0-9]{64}$/.test(base.pin.archive) ||
    createHash('sha256').update(base.bytes).digest('hex') !== base.pin.archive
  )
    throw new Error('Language base bytes do not match their archive pin');
  const archive = `${directory}/${archivePath(base.pin.archive)}`,
    pin = `${directory}/${PIN_PATH}`;
  const outputs = new Map([
    [archive, base.bytes],
    [pin, Buffer.from(JSON.stringify(base.pin, null, 2) + '\n')],
  ]);
  for (const path of outputs.keys()) containedFile(root, path, { allowMissing: true });
  const archives = resolve(root, directory, ARCHIVE_DIRECTORY),
    obsolete: string[] = [];
  if (existsSync(archives))
    for (const name of readdirSync(archives)) {
      if (!/^[a-f0-9]{64}\.ia\.tgz$/.test(name)) throw new Error('Unowned language base output: ' + name);
      const path = `${directory}/${ARCHIVE_DIRECTORY}/${name}`;
      const bytes = readRegular(root, path, 64 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== name.slice(0, 64))
        throw new Error('Changed language base archive: ' + name);
      if (path !== archive) obsolete.push(path);
    }
  const changed = [...outputs].filter(
    ([path, bytes]) => !existsSync(resolve(root, path)) || !readRegular(root, path, 64 * 1024 * 1024).equals(bytes),
  );
  for (const [path, bytes] of changed) {
    const target = containedFile(root, path, { allowMissing: true });
    mkdirSync(resolve(target, '..'), { recursive: true });
    const temporary = path + '.' + randomUUID() + '.tmp',
      temp = containedFile(root, temporary, { allowMissing: true });
    let created = false;
    try {
      writeFileSync(temp, bytes, { flag: 'wx' });
      created = true;
      for (const output of outputs.keys()) containedFile(root, output, { allowMissing: true });
      renameSync(temp, containedFile(root, path, { allowMissing: true }));
    } finally {
      if (created) rmSync(temp, { force: true });
    }
  }
  // If pin publication fails, all earlier archives remain; no retained pin can name a removed archive.
  for (const path of obsolete) rmSync(containedFile(root, path));
}

if (isEntry(process.argv[1], import.meta.url)) {
  let options: ReturnType<typeof parseOptions> | undefined;
  try {
    options = parseOptions(process.argv.slice(2), { booleans: ['write'], required: ['write'] });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
  if (options)
    try {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const base = buildLanguageBase(root);
      const findings = languageBaseFindings({
        ...base,
        languageVersion: languageVersion(root),
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
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
