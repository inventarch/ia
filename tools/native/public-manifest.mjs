import { resolve } from 'node:path';
import { readRegular } from '../shared/paths.mjs';

/** @typedef {{version: 1, floor: string[], systems: {name:string, declaration:string, schemas:string[]}[], examples:{file:string, system:string}[]}} PublicManifest */

/** Validate the complete selection before any consumer follows a selected source path.
 * @param {string} root @param {(path:string)=>string} [read] @returns {PublicManifest}
 */
export function readPublicManifest(root, read) {
  const source = read
    ? read(resolve(root, 'examples/public-language/manifest.json'))
    : new TextDecoder('utf-8', { fatal: true }).decode(
        readRegular(root, 'examples/public-language/manifest.json', 2 * 1024 * 1024),
      );
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('Public language manifest exceeds its byte ceiling');
  const value = JSON.parse(source);
  /** @param {unknown} value @param {readonly string[]} keys */
  const shape = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  /** @param {unknown} value @returns {value is string} */
  const path = (value) =>
    typeof value === 'string' &&
    /^[a-z0-9._/-]+\.ia$/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part));
  const seen = new Set();
  /** @param {string} file */
  const unique = (file) => {
    if (seen.has(file)) throw new Error('Duplicate public language input: ' + file);
    seen.add(file);
  };
  if (
    !shape(value, ['version', 'floor', 'systems', 'examples']) ||
    value.version !== 1 ||
    !Array.isArray(value.floor) ||
    !value.floor.length ||
    !Array.isArray(value.systems) ||
    !value.systems.length ||
    !Array.isArray(value.examples)
  )
    throw new Error('Invalid public language manifest membership');
  for (const file of value.floor) {
    if (!path(file) || !file.startsWith('.ia/src/floor/')) throw new Error('Invalid public language floor selection');
    unique(file);
  }
  const names = new Set();
  for (const system of value.systems) {
    if (
      !shape(system, ['name', 'declaration', 'schemas']) ||
      typeof system.name !== 'string' ||
      !/^[a-z][a-z0-9-]*-system$/.test(system.name) ||
      names.has(system.name) ||
      !path(system.declaration) ||
      system.declaration !== 'contracts/' + system.name + '.ia' ||
      !Array.isArray(system.schemas) ||
      !system.schemas.length
    )
      throw new Error('Invalid public language system membership');
    names.add(system.name);
    unique('examples/public-language/' + system.declaration);
    for (const file of system.schemas) {
      if (!path(file) || !file.startsWith('.ia/src/systems/' + system.name + '/schemas/'))
        throw new Error('Invalid public language schema owner');
      unique(file);
    }
  }
  for (const example of value.examples) {
    if (
      !shape(example, ['file', 'system']) ||
      !path(example.file) ||
      !example.file.startsWith('records/') ||
      !names.has(example.system)
    )
      throw new Error('Invalid public language example membership');
    unique('examples/public-language/' + example.file);
  }
  return /** @type {PublicManifest} */ (value);
}
