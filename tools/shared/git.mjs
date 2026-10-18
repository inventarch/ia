import { execFileSync } from 'node:child_process';

/**
 * A bounded Git invocation returning trimmed UTF-8 text. Pass paths after `--`
 * where the Git subcommand supports it. The caller owns policy and effects.
 * @param {string} root
 * @param {readonly string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {string}
 */
export function gitText(root, args, options = {}) {
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Git timeout must be a positive integer');
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
