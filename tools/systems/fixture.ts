import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
export function createSystemFixture(repository: string) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-public-systems-'));
  const close = () => {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  };
  try {
    cpSync(resolve(repository, '.ia/src'), resolve(root, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
    cpSync(resolve(repository, 'tools/systems/fixtures/native/.ia/src'), resolve(root, '.ia/src'), { recursive: true });
    return { root, close };
  } catch (error) {
    close();
    throw error;
  }
}
