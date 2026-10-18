import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { portablePath } from '@inventarch/workspace-runtime/resource-format';
import { commitId, fail, hash, LIMITS } from './format.js';
export function committedReader(repository: string, commit: string, timeout = 10000) {
  commitId(commit);
  if (typeof repository !== 'string' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
    fail('Invalid repository timeout or root');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  const git = (args: string[], maxBuffer = LIMITS.fileBytes + 1024): Buffer => {
    try {
      return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', repository, ...args], {
        maxBuffer,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch {
      return fail('Selected committed data unavailable or repository command timed out');
    }
  };
  const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const bare = git(['rev-parse', '--is-bare-repository']).toString('utf8').trim() === 'true';
  const declaredRoot = git(['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'])
    .toString('utf8')
    .trim();
  if (fold(realpathSync(repository)) !== fold(realpathSync(declaredRoot)))
    fail('Repository must be its Git working-tree or bare repository root');
  if (
    git(['rev-parse', '--verify', commit + '^{commit}'])
      .toString('utf8')
      .trim() !== commit
  )
    fail('Exact full commit required');
  const read = (path: string) => {
    portablePath(path);
    const rows = git(['ls-tree', '-z', commit, '--', path]).toString('utf8').split('\0').filter(Boolean);
    if (rows.length !== 1 || !rows[0]!.endsWith('\t' + path) || !rows[0]!.startsWith('100644 blob '))
      fail('Selected committed regular non-executable blob unavailable');
    const blob = /^100644 blob ([a-f0-9]{40,64})\t/.exec(rows[0]!)?.[1];
    if (!blob) return fail('Selected committed blob identity unavailable');
    const raw = git(['cat-file', 'blob', blob]);
    if (raw.length > LIMITS.fileBytes) fail('Selected file byte limit exceeded');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return fail('Selected blob is not UTF-8');
    }
    return { path, text, bytes: raw.length, sha256: hash(raw) };
  };
  const nativePaths = () => {
    const paths = git(['ls-tree', '-rz', '--name-only', commit, '--', '.ia/src'])
      .toString('utf8')
      .split('\0')
      .filter((path) => path.startsWith('.ia/src/') && path.endsWith('.ia') && !path.startsWith('.ia/src/floor/'));
    if (paths.length > 2000) fail('Native discovery file limit exceeded');
    return paths;
  };
  return { read, nativePaths };
}
