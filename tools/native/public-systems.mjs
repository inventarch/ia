import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPublicManifest } from './public-manifest.mjs';

/** Reviewed language membership supplies names; executable packaging remains a separate manifest fact. */
export function publicSystemNames(root) {
  return readPublicManifest(root).systems.map((row) => row.name);
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
