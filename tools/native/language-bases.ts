/**
 * The ledger of published `inventarch/language` bases: every base a CLI of this major has shipped, with its verified
 * archive kept under `releases/native/bases/<archive digest>.ia.tgz`, so a workspace pinned to an earlier base can be
 * read and upgraded from its exact bytes. The current build is `language-base.ts`; this file records what was released.
 *
 * `--fetch <version> --from <npm-spec>` runs `npm pack <spec>` in a temporary directory, takes
 * `package/assets/base/<digest>.ia.tgz` and `package/assets/base.json` from the tarball, and trusts the bytes only when
 * the digest matches the seed table (or, for a version not yet in it, the pin the tarball itself carries and the manifest
 * the archive verifies to). Nothing is written before that.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { isEntry } from '../entry/is-entry.mjs';
import { parseOptions } from '../shared/args.mjs';
import { containedFile, readRegular } from '../shared/paths.mjs';
import { BASE_ID } from './language-base.js';

export interface LedgerBase {
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly source: string;
}
export interface BaseLedger {
  readonly format: 'ia.language-bases.v1';
  readonly id: 'inventarch/language';
  readonly major: 3;
  readonly bases: LedgerBase[];
}

export const LEDGER_PATH = 'releases/native/language-bases.json';
export const BASES_DIRECTORY = 'releases/native/bases';
const LIMIT = 64 * 1024 * 1024;
const VERSION = /^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NPM_SPEC = /^@inventarch\/cli@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Archive digests of the bases published before this ledger, by version, with the npm release that carries each. */
export const SEED: Readonly<Record<string, { readonly archive: string; readonly source: string }>> = {
  '3.0.0': {
    archive: '08eaab3e1a6215d78283b82a94a0228367ac7bd78d0a746c56db79c8d7546c3a',
    source: '@inventarch/cli@3.0.0',
  },
  '3.1.0': {
    archive: '7db20e0dbbc2b88701ea24991886b4a8e08d419dda469cce5caff66911f81e4c',
    source: '@inventarch/cli@3.1.0',
  },
  '3.1.1': {
    archive: 'df626d1dc4949649ba7203842b29b4f064e0552e8db8c2c41ff74b6462b81b75',
    source: '@inventarch/cli@3.1.1',
  },
  '3.1.2': {
    archive: '62ecd5092f364b40e335e9e509ef512ac8030eb5689e72a5d0ff1e073cb13cfb',
    source: '@inventarch/cli@3.2.0',
  },
  '3.2.0': {
    archive: '7b36e4b4959a7bead1c57906cd346b419f32570dac0ac764af805ad20cd63b16',
    source: '@inventarch/cli@3.3.0',
  },
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const parts = (version: string): number[] => version.split('.').map(Number);
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

const archiveFile = (digest: string): string => `${BASES_DIRECTORY}/${digest}.ia.tgz`;

export function readBaseLedger(root: string): BaseLedger {
  const ledger = JSON.parse(readRegular(root, LEDGER_PATH, LIMIT).toString('utf8')) as BaseLedger;
  if (
    ledger.format !== 'ia.language-bases.v1' ||
    ledger.id !== BASE_ID ||
    ledger.major !== 3 ||
    !Array.isArray(ledger.bases)
  )
    throw new Error(`Invalid language base ledger ${LEDGER_PATH}`);
  return ledger;
}

/** The ledger archive's bytes, refused unless they hash to the ledger's digest. */
export function ledgerArchive(root: string, base: LedgerBase): Buffer {
  if (!DIGEST.test(base.archive)) throw new Error(`Invalid archive digest ${base.archive}`);
  const bytes = readRegular(root, archiveFile(base.archive), LIMIT);
  const digest = sha256(bytes);
  if (digest !== base.archive) throw new Error(`Ledger archive ${base.archive} hashes to ${digest}`);
  return bytes;
}

/** Every disagreement between the ledger, its archives and the directory that holds them, each named on its own. */
export function ledgerFindings(root: string): string[] {
  const findings: string[] = [];
  let ledger: BaseLedger;
  try {
    ledger = readBaseLedger(root);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  let previous: string | undefined;
  for (const base of ledger.bases) {
    if (!VERSION.test(base.version)) findings.push(`Ledger version ${base.version} is not a 3.x.y version`);
    else if (previous !== undefined && compareVersions(previous, base.version) >= 0)
      findings.push(`Ledger version ${base.version} does not ascend after ${previous}`);
    previous = base.version;
    try {
      const verified = verifyArchive(ledgerArchive(root, base), base.archive);
      if (verified.manifest.id !== BASE_ID || verified.manifest.version !== base.version)
        findings.push(
          `Archive ${base.archive} carries ${verified.manifest.id}@${verified.manifest.version}, not ${BASE_ID}@${base.version}`,
        );
      if (verified.manifestDigest !== base.manifest)
        findings.push(
          `Archive ${base.archive} manifest ${verified.manifestDigest} differs from the ledger's ${base.manifest}`,
        );
    } catch (error) {
      findings.push(
        `Archive ${base.archive} does not verify: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const directory = resolve(root, BASES_DIRECTORY);
  const named = new Set(ledger.bases.map((base) => `${base.archive}.ia.tgz`));
  if (existsSync(directory))
    for (const name of readdirSync(directory)) if (!named.has(name)) findings.push(`Unlisted archive ${name}`);
  return findings;
}

/** The named regular file of an npm tarball (gzip of ustar), by exact path. */
export function tarMember(tarball: Uint8Array, path: string): Buffer {
  const tar = gunzipSync(tarball, { maxOutputLength: 2 * LIMIT });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const type = field(156, 1);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar header');
    const body = offset + 512;
    if (name === path && (type === '0' || type === '')) {
      if (body + size > tar.length) throw new Error('Truncated tar member ' + path);
      return Buffer.from(tar.subarray(body, body + size));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Tarball has no ${path}`);
}

/** Fetches one published base from npm, verifies it, and records it; returns the ledger entry. */
export function fetchBase(root: string, version: string, spec: string): LedgerBase {
  if (!VERSION.test(version)) throw new Error(`Not a 3.x.y version: ${version}`);
  if (!NPM_SPEC.test(spec)) throw new Error(`Not an @inventarch/cli@x.y.z spec: ${spec}`);
  const ledger = readBaseLedger(root);
  if (ledger.bases.some((base) => base.version === version)) throw new Error(`Ledger already holds ${version}`);
  const last = ledger.bases[ledger.bases.length - 1];
  if (last && compareVersions(last.version, version) >= 0)
    throw new Error(`Version ${version} does not follow ${last.version}`);
  const scratch = mkdtempSync(resolve(tmpdir(), 'ia-base-fetch-'));
  try {
    // The spec is validated above, so the Windows npm shim (a .cmd file, which needs a shell) receives only safe text.
    const out = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', spec, '--silent', '--pack-destination', scratch],
      { cwd: scratch, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    const name = out.trim().split(/\r?\n/).pop() ?? '';
    if (!/^[\w.@-]+\.tgz$/.test(name)) throw new Error(`Unexpected npm pack output: ${name}`);
    const tarball = readFileSync(resolve(scratch, name));
    const pin = JSON.parse(tarMember(tarball, 'package/assets/base.json').toString('utf8')) as {
      id: string;
      version: string;
      archive: string;
      manifest: string;
    };
    const seed = SEED[version];
    const expected = seed?.archive ?? pin.archive;
    if (!DIGEST.test(expected)) throw new Error('Invalid pinned archive digest');
    if (pin.id !== BASE_ID || pin.version !== version || pin.archive !== expected)
      throw new Error(`${spec} pins ${pin.id}@${pin.version} ${pin.archive}, not ${BASE_ID}@${version} ${expected}`);
    const bytes = tarMember(tarball, `package/assets/base/${pin.archive}.ia.tgz`);
    if (sha256(bytes) !== expected) throw new Error(`Archive from ${spec} does not hash to ${expected}`);
    const verified = verifyArchive(bytes, expected);
    if (
      verified.manifest.id !== BASE_ID ||
      verified.manifest.version !== version ||
      verified.manifestDigest !== pin.manifest
    )
      throw new Error(`Archive from ${spec} disagrees with its pin`);
    const entry: LedgerBase = {
      version,
      archive: expected,
      manifest: verified.manifestDigest,
      source: seed?.source ?? spec,
    };
    const target = containedFile(root, archiveFile(expected), { allowMissing: true });
    mkdirSync(resolve(target, '..'), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, target);
    const next: BaseLedger = { ...ledger, bases: [...ledger.bases, entry] };
    const ledgerTarget = containedFile(root, LEDGER_PATH, { allowMissing: true });
    const ledgerTemporary = `${ledgerTarget}.${randomUUID()}.tmp`;
    writeFileSync(ledgerTemporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    renameSync(ledgerTemporary, ledgerTarget);
    return entry;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), {
      values: ['fetch', 'from'],
      booleans: ['check'],
      exclusive: [['fetch', 'check']],
    });
    const root = fileURLToPath(new URL('../../', import.meta.url));
    if (options.has('fetch')) {
      const spec = options.value('from');
      if (!spec) throw new Error('Required option: --from');
      const entry = fetchBase(root, options.value('fetch')!, spec);
      process.stdout.write(`Recorded ${BASE_ID}@${entry.version}: sha256 ${entry.archive}.\n`);
    } else {
      const findings = ledgerFindings(root);
      if (findings.length > 0) {
        process.stderr.write(findings.map((finding) => `${finding}\n`).join(''));
        process.exitCode = 1;
      } else process.stdout.write('Language base ledger verifies.\n');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
