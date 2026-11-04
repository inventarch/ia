/**
 * This copy of `@inventarch/cli`: its package root, its version and its extension table. Both entries read them, the
 * `ia` bin (bin.ts) before any command module loads, so this module imports Node built-ins and types only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Extension } from './consumer.js';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const version = (): string => {
  try {
    return (
      (JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version?: string }).version ??
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
};
/** The public CLI has no additional command namespaces; dispatch derives extension help from this empty table. */
export const EXTENSIONS: readonly Extension[] = [];
