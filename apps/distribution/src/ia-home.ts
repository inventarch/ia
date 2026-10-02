import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail, syncDirectory } from './files.js';

/** Host plugin distribution spec §3: the user-level IA home and which variable placed it. IA_HOST_HOME is a one-release alias. */
export type HomeSource = 'IA_HOME' | 'IA_HOST_HOME' | 'default';
export function resolveIaHome(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string,
): { readonly home: string; readonly source: HomeSource } {
  for (const name of ['IA_HOME', 'IA_HOST_HOME'] as const) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      if (!isAbsolute(value)) fail('INPUT-INVALID', `${name} must be absolute`);
      return { home: resolve(value), source: name };
    }
  }
  return { home: join(userHome, '.ia'), source: 'default' };
}
export const HOME_MARKER = 'home.json';
/** §3: the home names itself and never holds src/, so root discovery can never take it for a workspace. Read-only: never creates or writes anything, so a caller can refuse at plan time before any write is attempted. */
export function assertIaHomeUsable(home: string): void {
  if (existsSync(join(home, 'src')))
    fail(
      'PATH-UNSAFE',
      `The IA home ${home} contains src/; move that directory away, because the home must never look like a workspace`,
    );
}
/** Atomic (stage then rename) and tolerant of a concurrent creator: a marker that already parses is left alone; an empty or unparseable one is rewritten. */
function markHome(home: string): void {
  const target = join(home, HOME_MARKER);
  let existing: string | null = null;
  try {
    existing = readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null && existing.trim() !== '') {
    try {
      JSON.parse(existing);
      return;
    } catch {
      /* falls through: an unparseable marker is rewritten below */
    }
  }
  const stage = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(stage, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schema: 'ia.home.v1' }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, target);
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true });
  }
}
/** Refuses a home that already looks like a workspace, then creates it and marks it. */
export function ensureIaHome(home: string): void {
  assertIaHomeUsable(home);
  mkdirSync(home, { recursive: true });
  markHome(home);
}
/** One file under the home, replaced atomically: written beside its target with fsync, then renamed over it. Refuses a `path` that is empty or escapes the home, before the home is even created or marked. */
export function writeHomeFile(home: string, path: string, text: string): void {
  const target = join(home, path);
  const escaped = relative(home, target);
  if (escaped === '' || escaped === '..' || escaped.startsWith('..' + sep) || isAbsolute(escaped))
    fail('PATH-UNSAFE', `${path} escapes the IA home ${home}`);
  ensureIaHome(home);
  mkdirSync(dirname(target), { recursive: true });
  const stage = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(stage, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, target);
    syncDirectory(dirname(target));
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true });
  }
}
export function readHomeFile(home: string, path: string): string | null {
  try {
    return readFileSync(join(home, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
