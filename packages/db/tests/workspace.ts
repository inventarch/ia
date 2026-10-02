import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, vi } from 'vitest';

// Native-tree copies, cache writes and repeated admission are integration work.
// Windows CI has measured individual fixtures above the five-second default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const temporary: string[] = [];
export const methodPath = '.ia/src/systems/governance-system/records/sample-procedure.ia';
export const methodId = 'governance-system/definition/procedure/sample-procedure';
export function workspace(native = true): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-db-handles-'));
  temporary.push(root);
  if (native)
    cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
  return root;
}
export function put(root: string, path: string, text: string | Uint8Array): void {
  const target = resolve(root, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, text);
}
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(path) || !path.startsWith('ia-db-handles-') || path.includes('..'))
      throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
