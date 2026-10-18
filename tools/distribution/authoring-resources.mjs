import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { teachingLinkClasses, teachingLinkFindings } from '../docs/teaching-links.mjs';
import { containedFile, readRegular } from '../shared/paths.mjs';

export const AUTHORING_MANIFEST = '.ia/authoring.resources.json';
export const AUTHORING_LIBRARY = '.ia/src/systems/authoring-system/library.json';
const decoder = new TextDecoder('utf-8', { fatal: true });

/** One computation for on-disk authoring and the public generator's pending outputs; both validate physical inputs.
 * @param {string} root @param {ReadonlyMap<string, string>} [pending]
 */
export function authoringResources(root, pending = new Map()) {
  /** @param {string} path @param {number} limit */
  const read = (path, limit) => {
    const target = containedFile(root, path, { allowMissing: pending.has(path) });
    // Existing bytes remain bounded and valid even when this pass replaces their generated content.
    const existing = existsSync(target) ? readRegular(root, path, limit) : undefined;
    if (existing) decoder.decode(existing);
    const planned = pending.get(path),
      bytes = planned === undefined ? (existing ?? readRegular(root, path, limit)) : Buffer.from(planned);
    if (bytes.length > limit) throw new Error('Unbounded authoring file: ' + path);
    decoder.decode(bytes);
    return bytes;
  };
  const selection = /** @type {Record<string, unknown>} */ (
    decodeDistributionJson(decoder.decode(read(AUTHORING_LIBRARY, 2 * 1024 * 1024)))
  );
  if (
    !selection ||
    selection['format'] !== 'ia.authoring-library.v1' ||
    Object.keys(selection).sort().join(',') !== 'associations,files,format,index' ||
    !Array.isArray(selection['files']) ||
    selection['files'].length > 256
  )
    throw new Error('Invalid explicit authoring library');
  const seen = new Set();
  /** @type {{path: string, text: string}[]} */
  const teaching = [];
  let total = 0;
  const files = selection['files']
    .map((input) => {
      if (input === null || typeof input !== 'object' || Object.keys(input).join(',') !== 'path')
        throw new Error('Invalid authoring file selection');
      const path = input.path;
      if (
        typeof path !== 'string' ||
        !path.startsWith('.ia/src/') ||
        !path.endsWith('.md') ||
        seen.has(path.toLowerCase())
      )
        throw new Error('Unsafe, duplicated or non-Markdown authoring selection');
      seen.add(path.toLowerCase());
      const bytes = read(path, 1024 * 1024);
      total += bytes.length;
      if (total > 16 * 1024 * 1024) throw new Error('Authoring files exceed their total byte ceiling');
      teaching.push({ path, text: decoder.decode(bytes) });
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'text/markdown',
        encoding: 'utf8',
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const nativePaths = new Set();
  /** @param {string} directory */
  function nativeFiles(directory) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (['node_modules', 'dist'].includes(entry.name)) continue;
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) nativeFiles(path);
      else if (entry.isFile() && path.endsWith('.ia')) {
        containedFile(root, path);
        nativePaths.add(path);
      }
    }
  }
  nativeFiles('.ia/src');
  for (const path of pending.keys())
    if (path.startsWith('.ia/src/') && path.endsWith('.ia')) {
      containedFile(root, path, { allowMissing: true });
      nativePaths.add(path);
    }
  const available = new Set([...nativePaths, ...files.map((file) => file.path)]);
  const findings = teachingLinkFindings(
    root,
    teaching,
    nativePaths,
    (path) => available.has(path) || [...available].some((file) => file.startsWith(path + '/')),
  );
  if (findings.length) throw new Error(findings.join('\n'));
  const output =
    JSON.stringify(
      {
        format: 'ia.authoring-resources.v1',
        files,
        associations: selection['associations'],
        index: selection['index'],
      },
      null,
      2,
    ) + '\n';
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('Authoring manifest exceeds its metadata ceiling');
  return { output, files: files.length, total, links: teachingLinkClasses(teaching) };
}
