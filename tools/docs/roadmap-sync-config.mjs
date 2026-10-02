#!/usr/bin/env node
// Prepare the external roadmap sync tool's config-directory-relative manifest path.
// This adapter reads/writes local files only; it never invokes the sync tool.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length !== 0) throw new Error('Usage: node tools/docs/roadmap-sync-config.mjs (local preparation only)');
const source = resolve(root, 'docs/roadmap/config.json');
const output = resolve(root, '.ia/work/roadmap-sync/config.json');
const inside = (base, target) => {
  const path = relative(base, target);
  return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path);
};
// Refuse aliases in the output ancestry before creating or replacing managed output.
for (let cursor = output; cursor !== root; cursor = dirname(cursor)) {
  if (!inside(root, cursor)) throw new Error('Output must remain inside the repository');
  let stat;
  try {
    stat = lstatSync(cursor);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) throw new Error(`Aliased output: ${cursor}`);
}
const sourceBytes = readFileSync(source);
const config = JSON.parse(sourceBytes);
if (resolve(dirname(source), config.repositoryRoot) !== root) throw new Error('Unexpected roadmap repositoryRoot');
const manifest = resolve(root, config.manifestPath);
if (!inside(root, manifest)) throw new Error('Manifest must remain inside the repository');
const manifestBytes = readFileSync(manifest);
JSON.parse(manifestBytes); // Refuse invalid input before touching output.
const format = 'ia-roadmap-sync-config/1';
if (existsSync(output) && JSON.parse(readFileSync(output, 'utf8')).syncAdapter?.format !== format) {
  throw new Error('Refusing to overwrite an unmanaged sync configuration');
}
const localPath = (base, target) => relative(base, target).replaceAll('\\', '/');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const prepared = {
  ...config,
  repositoryRoot: localPath(dirname(output), root),
  manifestPath: localPath(dirname(output), manifest),
  syncAdapter: {
    format,
    source: localPath(root, source),
    sourceSha256: sha(sourceBytes),
    manifestSha256: sha(manifestBytes),
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(prepared, null, 2) + '\n');
console.log(JSON.stringify({ output: localPath(root, output), manifestSha256: sha(manifestBytes), remoteActions: 0 }));
