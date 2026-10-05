import { execFileSync } from 'node:child_process';

/** Fixed local inventory operation, bounded to ten seconds and 16 MiB; no caller command or arguments. */
export function gitFiles(directory: string): string[] {
  return [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: directory,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10000,
        windowsHide: true,
      })
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
}
/**
 * Top-level directories whose files belong to the repository root: documentation and the hidden tooling directories,
 * named by stem. Runtime only classifies these paths and never reads any of them, so it carries no path literal for
 * the CI-configuration directory: a source that names it is, by the cache-safety invariant in tools/testing, a CI
 * configuration reader, and only tools tasks may be one.
 */
const ROOT_OWNED = new Set([
  'docs',
  'ia-docs',
  'releases',
  ...['agents', 'claude', 'github'].map((stem) => `.${stem}`),
]);
/** Neutral repository layout ownership; no catalogue, task selection or policy decision. */
export function ownerOf(path: string): string | undefined {
  const parts = path.split('/');
  if (parts.length === 1 || ROOT_OWNED.has(parts[0]!)) return '.';
  if (['packages', 'apps', 'tools', 'examples', 'distributions'].includes(parts[0]!) && parts.length >= 3)
    return parts.slice(0, 2).join('/');
  if (path.startsWith('.ia/learning/')) return '.ia/learning';
  if (path.startsWith('.ia/src/floor/')) return '.ia/src/floor';
  if (path.startsWith('.ia/src/systems/') && parts.length >= 5) return parts.slice(0, 4).join('/');
  if (parts[0] === '.ia' && (parts.length === 2 || (parts.length === 3 && parts[1] === 'src'))) return '.';
  return undefined;
}
