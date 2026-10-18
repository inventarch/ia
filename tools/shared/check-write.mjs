import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { containedFile, readRegular } from './paths.mjs';

/** Validate the full output set before effects; unchanged outputs retain bytes and timestamps.
 * @param {string} root @param {ReadonlyMap<string, string>} outputs
 * @param {{write?: boolean, normalizeNewlines?: boolean}} [options]
 */
export function checkWrite(root, outputs, { write = false, normalizeNewlines = false } = {}) {
  const names = new Set(),
    changed = [];
  for (const [path, text] of outputs) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024)
      throw new Error('Invalid or unbounded generated text: ' + path);
    if (names.has(path.toLowerCase())) throw new Error('Duplicate output path: ' + path);
    names.add(path.toLowerCase());
    containedFile(root, path, { allowMissing: true });
    let previous;
    try {
      previous = readRegular(root, path, 32 * 1024 * 1024).toString('utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    if (normalizeNewlines) previous = previous?.replaceAll('\r\n', '\n');
    if (previous !== text) changed.push(path);
  }
  if (write)
    for (const path of changed) {
      const text = outputs.get(path);
      if (text === undefined) throw new Error('Output set changed during generation');
      const target = containedFile(root, path, { allowMissing: true });
      mkdirSync(dirname(target), { recursive: true });
      containedFile(root, path, { allowMissing: true });
      const temporary = path + '.' + randomUUID() + '.tmp',
        temp = containedFile(root, temporary, { allowMissing: true });
      let created = false;
      try {
        writeFileSync(temp, text, { flag: 'wx' });
        created = true;
        for (const output of outputs.keys()) containedFile(root, output, { allowMissing: true });
        renameSync(temp, target);
      } finally {
        if (created) rmSync(temp, { force: true });
      }
    }
  return { changed, written: write ? changed : [] };
}
