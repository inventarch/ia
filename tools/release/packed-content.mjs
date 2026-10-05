import { readFileSync, lstatSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanContent, validateContentPolicy } from './public/content-scan.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error('Public safety: ' + message);
};
/** Read regular npm members and bounded canonical nested assets without filesystem extraction. */
export function readPackedContent(archive, owner, { unpackTree, limits }) {
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.compressed)
    fail('invalid or oversized packed archive');
  const cwd = dirname(archive),
    filename = basename(archive);
  const run = (args) => execFileSync('tar', args, { cwd, windowsHide: true, maxBuffer: limits.file, timeout: 30000 });
  const names = run(['-tzf', filename]).toString('utf8').replaceAll('\r\n', '\n').trim().split('\n');
  const listing = run(['-tvzf', filename]).toString('utf8').replaceAll('\r\n', '\n').trim().split('\n');
  if (names.length !== listing.length || names.length > limits.files) fail('invalid packed inventory');
  const files = new Map(),
    aliases = new Set();
  let expanded = 0,
    members = 0;
  const add = (path, bytes, depth = 0) => {
    expanded += bytes.length;
    if (++members > limits.files || bytes.length > limits.file || expanded > limits.expanded)
      fail('packed expansion limit');
    if (/\.t(?:ar\.)?gz$/.test(path)) {
      if (
        depth === 0 &&
        path.startsWith('apps/cli/assets/host/') &&
        path.endsWith('.tgz') &&
        basename(path) !== sha(bytes) + '.tgz'
      )
        fail('changed host carrier digest');
      if (depth >= 3) fail('nested archive limit');
      for (const [member, value] of unpackTree(bytes, limits)) add(path + '!/' + member, value, depth + 1);
    } else {
      if (files.has(path)) fail('duplicate decoded member');
      files.set(path, { bytes });
    }
  };
  names.forEach((name, index) => {
    const kind = listing[index][0],
      local = name.slice(8).replace(/\/$/, '');
    if (name === 'package/' && kind === 'd') return;
    if (
      !['d', '-'].includes(kind) ||
      !name.startsWith('package/') ||
      /[\\:\x00-\x1f\x7f]/.test(local) ||
      local.split('/').some((part) => !part || part === '..' || part === '.') ||
      aliases.has(local.toLowerCase())
    )
      fail('unsafe packed member');
    aliases.add(local.toLowerCase());
    if (kind === 'd') return;
    add(owner + '/' + local, run(['-xOf', filename, name]));
  });
  return files;
}
/** Every selected tarball is scanned between two checks of its retained qualification hash. */
export function scanPackedArchives(packed, policy, decoder) {
  validateContentPolicy(policy);
  if (!Array.isArray(packed) || !packed.length || new Set(packed.map((row) => row.name)).size !== packed.length)
    fail('invalid packed scan selection');
  const observations = [];
  for (const row of packed) {
    const owner = policy.packageNames.find((owner) => owner.name === row.name);
    if (!owner || (row.owner !== undefined && row.owner !== owner.root) || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
      fail('unreviewed packed scan owner or pin');
    if (sha(readFileSync(row.filename)) !== row.sha256) fail('qualified archive changed before content scan');
    const files = readPackedContent(row.filename, owner.root, decoder);
    scanContent(files, policy);
    if (sha(readFileSync(row.filename)) !== row.sha256) fail('qualified archive changed during content scan');
    observations.push({ name: row.name, sha256: row.sha256, files: files.size });
  }
  return { archives: observations.length, files: observations.reduce((sum, row) => sum + row.files, 0), observations };
}
