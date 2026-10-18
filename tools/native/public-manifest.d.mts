// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/** @typedef {{version: 1, floor: string[], systems: {name:string, declaration:string, schemas:string[]}[], examples:{file:string, system:string}[]}} PublicManifest */
/** Validate the complete selection before any consumer follows a selected source path.
 * @param {string} root @param {(path:string)=>string} [read] @returns {PublicManifest}
 */
export function readPublicManifest(root: string, read?: (path: string) => string): PublicManifest;
export type PublicManifest = {
  version: 1;
  floor: string[];
  systems: {
    name: string;
    declaration: string;
    schemas: string[];
  }[];
  examples: {
    file: string;
    system: string;
  }[];
};
