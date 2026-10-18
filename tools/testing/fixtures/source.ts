import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Test-only candidate copy, including unstaged additions and deletions, without ignored build products. */
export function materializeSource(source: string, root: string): void {
  execFileSync('git', ['clone', '--no-local', '--quiet', source, root], { timeout: 120_000, windowsHide: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
      .split('\0')
      .filter(Boolean);
  const changed = new Set([
    ...git('diff', 'HEAD', '--no-renames', '--name-only', '-z'),
    ...git('ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  for (const file of changed) {
    const target = resolve(root, file);
    if (existsSync(resolve(source, file))) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(source, file), target);
    } else rmSync(target, { force: true });
  }
  // Inventory reads the index as well as the filesystem. Represent the overlaid candidate,
  // including removed/relocated paths, without changing the source checkout's index.
  execFileSync('git', ['add', '--all'], { cwd: root, timeout: 30_000, windowsHide: true });
}
