import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { LedgerBase } from './language-bases.js';
import {
  BASES_DIRECTORY,
  fetchBase,
  ledgerFindings,
  LEDGER_PATH,
  npmPack,
  readBaseLedger,
  tarMember,
} from './language-bases.js';
import { COMPAT_PATH, languageCompatOutputs, settleLanguageCompat, SHIPPED_COMPAT } from './language-compat.js';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { isEntry } from '../entry/is-entry.mjs';

const REPO = 'inventarch/ia';
const CLI = '@inventarch/cli';
const BASE = 'inventarch/language';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PIN = /^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const MAX_TARBALL = 64 * 1024 * 1024;

type Entry = { name: string; version: string; bytes: number; integrity: string };
type Receipt = {
  format: string;
  version: string;
  source: { repository: string; commit: string; dirty: boolean };
  packages: Entry[];
};

/** The workflow accepts only this canonical release receipt, tied to the completed publisher and immutable tag. */
export function publishedCli(receipt: Receipt, version: string, sha: string): Entry {
  assert.match(sha, /^[a-f0-9]{40}$/, 'Exact release commit required');
  assert.match(version, EXACT_VERSION, 'Exact published version required');
  assert.equal(receipt.format, 'ia.npm-release.v2');
  assert.equal(receipt.version, version, 'Wrong receipt version');
  assert.equal(receipt.source.repository, REPO, 'Wrong source repository');
  assert.equal(receipt.source.commit, sha, 'Receipt does not identify the completed publisher commit');
  assert.equal(receipt.source.dirty, false, 'A dirty publication receipt is not accepted');
  const cli = receipt.packages.filter((row) => row.name === CLI);
  assert.equal(cli.length, 1, 'Exactly one published CLI receipt row is required');
  const entry = cli[0]!;
  assert.equal(entry.version, version, 'Wrong CLI version in receipt');
  assert.match(entry.integrity, SRI, 'Invalid CLI archive integrity');
  assert.ok(
    Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_TARBALL,
    'Invalid CLI tarball size',
  );
  return entry;
}

/** Validation is also required for a no-op; a reused version with different bytes is never harmless. */
export function retainPublishedBase(
  root: string,
  bytes: Buffer,
  entry: Entry,
): {
  changed: boolean;
  base: LedgerBase;
  paths: readonly string[];
} {
  assert.equal(bytes.length, entry.bytes, 'CLI tarball size differs from the release receipt');
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    entry.integrity,
    'CLI tarball integrity differs from the provenance-verified release receipt',
  );
  const member = (path: string) => JSON.parse(tarMember(bytes, `package/${path}`).toString('utf8'));
  const manifest = member('package.json') as { name: string; version: string };
  assert.equal(manifest.name, CLI);
  assert.equal(manifest.version, entry.version);
  const pin = member('assets/base.json') as LedgerBase & { id: string };
  assert.equal(pin.id, BASE);
  assert.match(pin.version, PIN);
  assert.match(pin.archive, SHA256);
  assert.match(pin.manifest, SHA256);
  const archive = tarMember(bytes, `package/assets/base/${pin.archive}.ia.tgz`);
  const native = verifyArchive(archive, pin.archive);
  assert.equal(native.manifest.id, BASE);
  assert.equal(native.manifest.version, pin.version);
  assert.equal(native.manifestDigest, pin.manifest);
  assert.deepEqual(ledgerFindings(root), [], 'Existing ledger must independently validate');
  const prior = readBaseLedger(root).bases.find((row) => row.version === pin.version);
  if (prior) {
    assert.equal(prior.archive, pin.archive, 'Published base changed without a version change');
    assert.equal(prior.manifest, pin.manifest, 'Published base manifest changed without a version change');
    return { changed: false, base: prior, paths: [] };
  }
  const base = fetchBase(root, pin.version, `${CLI}@${entry.version}`, () => bytes);
  assert.deepEqual(ledgerFindings(root), [], 'Generated ledger must independently validate');
  const outputs = languageCompatOutputs(root);
  settleLanguageCompat(root, outputs, 'write');
  settleLanguageCompat(root, outputs, 'check');
  return {
    changed: true,
    base,
    paths: [LEDGER_PATH, `${BASES_DIRECTORY}/${base.archive}.ia.tgz`, COMPAT_PATH, SHIPPED_COMPAT],
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const [, , receiptPath, version, sha] = process.argv;
  assert.ok(receiptPath && version && sha, 'Usage: published-language-ledger.ts <receipt> <version> <sha>');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  const entry = publishedCli(receipt, version, sha);
  const scratch = mkdtempSync(resolve(tmpdir(), 'ia-published-cli-'));
  try {
    // The current workflow sets a clean npm home, pins the official registry and ignores lifecycle scripts.
    const bytes = npmPack(`${CLI}@${entry.version}`, scratch);
    console.log(JSON.stringify(retainPublishedBase(process.cwd(), bytes, entry)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
