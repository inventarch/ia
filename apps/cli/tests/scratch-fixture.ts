import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const created: string[] = [];
/** A disposable directory under the system temp root; every one is removed by `cleanup()`. */
export function scratch(prefix: string): string {
  const path = mkdtempSync(resolve(tmpdir(), `ia-cli-${prefix}-`));
  created.push(path);
  return path;
}

export function cleanup(): void {
  for (const path of created.splice(0)) {
    if (dirname(path) !== resolve(tmpdir())) throw new Error(`Unsafe fixture cleanup: ${path}`);
    rmSync(path, { recursive: true, force: true });
  }
}
