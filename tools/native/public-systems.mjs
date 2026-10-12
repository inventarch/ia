import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Reviewed language membership supplies names; executable packaging remains a separate manifest fact. */
export function publicSystemNames(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'examples/public-language/manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.systems) ||
    !manifest.systems.length ||
    manifest.systems.some((row) => !/^[a-z][a-z0-9-]*-system$/.test(row.name)) ||
    new Set(manifest.systems.map((row) => row.name)).size !== manifest.systems.length
  )
    throw new Error('Invalid public language system membership');
  return manifest.systems.map((row) => row.name);
}

/** Qualification of executable resource APIs needs compiled system packages, not native-only archives. */
export function compiledSystemFolders(root) {
  return publicSystemNames(root)
    .map((name) => '.ia/src/systems/' + name)
    .filter((folder) => {
      const manifest = JSON.parse(readFileSync(resolve(root, folder, 'package.json'), 'utf8'));
      return typeof manifest.scripts?.build === 'string';
    });
}
