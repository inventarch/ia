/**
 * Host plugin distribution spec §5: how this installation of `ia` is running, read from where its package sits.
 * Only the filesystem and local git are consulted; nothing here touches the network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { sameFile } from '@inventarch/db';
import { findProgram, programEnv, programHome } from './program.js';

export type Channel =
  | {
      readonly kind: 'checkout';
      readonly root: string;
      readonly commit: string | null;
      readonly dirty: boolean | null;
      readonly origin: string | null;
    }
  | { readonly kind: 'npm'; readonly name: string; readonly version: string }
  | { readonly kind: 'unknown'; readonly entry: string };
export type Git = (cwd: string, args: readonly string[]) => string | null;
export const runGit: Git = (cwd, args) => {
  // A hand-run doctor may start in a directory the repository controls, so git is found on qualified PATH entries
  // only and runs by absolute path from the home directory; `-C` names the checkout (src/program.ts).
  const git = findProgram('git', process.env);
  if (git === null) return null;
  // --no-optional-locks: doctor calls this on every session start, and it must never contend with a concurrent
  // git process for the index lock. 700ms each: three sequential calls (rev-parse, status, config) must leave
  // headroom inside the hook's 5s doctor budget for workspace validation.
  const result = spawnSync(git, ['--no-optional-locks', '-C', cwd, ...args], {
    cwd: programHome(),
    env: programEnv(process.env),
    encoding: 'utf8',
    timeout: 700,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
};
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** §5's table, top to bottom: under node_modules is npm; inside this repository's own work tree is a checkout. */
export function detectChannel(packageRoot: string, git: Git = runGit): Channel {
  const root = real(packageRoot);
  if (root.split(sep).includes('node_modules')) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      return { kind: 'npm', name: manifest.name ?? 'unknown', version: manifest.version ?? '0.0.0' };
    } catch {
      return { kind: 'unknown', entry: resolve(root, 'dist/main.js') };
    }
  }
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(resolve(current, '.git'))) {
      if (existsSync(resolve(current, 'pnpm-workspace.yaml')) && sameFile(resolve(current, 'apps/cli'), root)) {
        const status = git(current, ['status', '--porcelain', '--untracked-files=no']);
        return {
          kind: 'checkout',
          root: current,
          commit: git(current, ['rev-parse', 'HEAD']),
          dirty: status === null ? null : status !== '',
          origin: git(current, ['config', '--get', 'remote.origin.url']),
        };
      }
      break;
    }
    if (dirname(current) === current) break;
  }
  return { kind: 'unknown', entry: resolve(root, 'dist/main.js') };
}
/** §5's update instruction for the channel, as the hook and doctor print it. */
export function updateInstruction(channel: Channel): string {
  if (channel.kind === 'checkout')
    return `In ${channel.root}: git pull, pnpm build, then ia host claude --user --apply`;
  if (channel.kind === 'npm') return `npm i -g ${channel.name}@latest, then ia host claude --user --apply`;
  return 'Reinstall ia from its source, then run ia host claude --user --apply';
}
export function describeChannel(channel: Channel): string {
  if (channel.kind === 'checkout')
    return `checkout ${channel.root}${channel.commit ? ` at ${channel.commit.slice(0, 12)}` : ''}${channel.dirty === true ? ', uncommitted changes' : channel.dirty === null ? ', dirty state unknown' : ''}${channel.origin ? `, origin ${channel.origin}` : ''}`;
  if (channel.kind === 'npm') return `npm package ${channel.name} ${channel.version}`;
  return `unknown install; running from ${channel.entry}`;
}
