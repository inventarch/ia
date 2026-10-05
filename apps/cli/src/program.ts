/**
 * #436: how a hand-run `ia` command finds and starts another program (`git` for init and doctor, `claude` for
 * `ia host --user`). The user may run it from a directory the repository controls, so no step of the launch may search
 * that directory. `ia` looks the program up itself, on qualified PATH entries only, and runs what it found by absolute
 * path; the program gets only those entries in its PATH and, on Windows, `NoDefaultCurrentDirectoryInExePath=1`, so
 * its own lookups skip its working directory too. This is the rule the session hook applies to `ia` (host plugin
 * distribution design §8.1, amended 2026-09-30 for LKI-41).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;
/** The file system a lookup reads. Injected only by tests that run the Windows rules on another platform. */
export interface LookupFs {
  readonly statSync: (path: string) => { isFile(): boolean; isDirectory(): boolean };
  readonly accessSync: (path: string, mode: number) => void;
}
export interface ProgramSystem {
  readonly platform: NodeJS.Platform;
  readonly fs: LookupFs;
}
export const SYSTEM: ProgramSystem = { platform: process.platform, fs: { statSync, accessSync } };
/**
 * What a lookup accepts. `program`: what starts without a shell, an executable regular file on POSIX and, on Windows,
 * `name.com` or `name.exe`, the two names libuv tries for a bare name. `script`: on Windows only, `name.bat` or
 * `name.cmd`, in that order, which only cmd.exe runs; never PATHEXT's script types, which start through Windows Script Host.
 */
export type ProgramKind = 'program' | 'script';

const paths = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
/** An environment value by name, whatever its case on Windows, which reads environment names without regard to case. */
function variable(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  for (const [key, value] of Object.entries(env))
    if (key.toUpperCase() === name.toUpperCase() && value !== undefined) return value;
  return undefined;
}
/**
 * An entry that may be searched: absolute and, on Windows, naming a drive or a share. An empty or relative entry names
 * the working directory or below it, and a Windows entry rooted without a drive (`\tools`) depends on the current drive.
 */
export function qualifiedPath(path: string, platform: NodeJS.Platform): boolean {
  const p = paths(platform);
  return p.isAbsolute(path) && (platform !== 'win32' || p.parse(path).root.length > 1);
}
/**
 * The PATH entries a lookup searches, in order. Windows may quote an entry and allows no quote in a file name, so the
 * quotes go there; on POSIX every entry is taken as written. Without PATH, POSIX searches /usr/bin and /bin, where a
 * spawn by bare name looked, and Windows searches nothing.
 */
export function qualifiedEntries(env: Env, platform: NodeJS.Platform): readonly string[] {
  const value = variable(env, 'PATH', platform);
  if (value === undefined) return platform === 'win32' ? [] : ['/usr/bin', '/bin'];
  const entries = value.split(paths(platform).delimiter);
  return (platform === 'win32' ? entries.map((entry) => entry.replace(/"/g, '')) : entries).filter((entry) =>
    qualifiedPath(entry, platform),
  );
}
const EXTENSIONS: Readonly<Record<ProgramKind, readonly string[]>> = {
  program: ['.com', '.exe'],
  script: ['.bat', '.cmd'],
};
/**
 * The absolute path of `name` in the first qualified PATH entry that holds it, or null. An entry that is not a
 * directory costs one check. On POSIX the first executable regular file wins, as the shell's search would; there is no
 * `script` kind there. On Windows a script whose path holds `%` is passed over, because cmd.exe would expand it.
 */
export function findProgram(
  name: string,
  env: Env,
  kind: ProgramKind = 'program',
  system: ProgramSystem = SYSTEM,
): string | null {
  const { platform, fs } = system,
    windows = platform === 'win32';
  if (!windows && kind === 'script') return null;
  const names = windows ? EXTENSIONS[kind].map((extension) => name + extension) : [name];
  for (const dir of qualifiedEntries(env, platform)) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const candidate of names) {
      const file = paths(platform).join(dir, candidate);
      if (kind === 'script' && file.includes('%')) continue;
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!windows) fs.accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Absent or not executable: keep looking, as the shell would.
      }
    }
  }
  return null;
}
/**
 * The environment of a started program: `env` with PATH reduced to its qualified entries and, on Windows,
 * `NoDefaultCurrentDirectoryInExePath=1`, which cmd.exe and libuv honor, so the program's own lookups (npm's
 * `claude.cmd` starts `node` by name) cannot reach its working directory either. POSIX reads an empty PATH as the
 * working directory, so a PATH with no qualified entry becomes /usr/bin:/bin there. Every spelling of both names is
 * replaced, so the environment block holds each once.
 */
export function programEnv(env: Env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const replaced = platform === 'win32' ? ['PATH', 'NODEFAULTCURRENTDIRECTORYINEXEPATH'] : ['PATH'];
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !replaced.includes(platform === 'win32' ? key.toUpperCase() : key)) result[key] = value;
  const entries = qualifiedEntries(env, platform);
  result['PATH'] =
    entries.length > 0 || platform === 'win32' ? entries.join(paths(platform).delimiter) : '/usr/bin:/bin';
  if (platform === 'win32') result['NoDefaultCurrentDirectoryInExePath'] = '1';
  return result;
}
/**
 * The working directory of a started program whose result does not depend on it: the user's home, which the repository
 * does not control. A version manager's shim (asdf, mise, nodenv) on a qualified entry still reads version files
 * upward from there, so the home's choice applies, not the repository's.
 */
export const programHome = (): string => homedir();
/**
 * cmd.exe, which a Windows script needs, by a qualified path: `%SystemRoot%\System32\cmd.exe`, or the default
 * Windows directory's when SystemRoot is missing or not qualified. Never ComSpec: Node gives a shell cmd.exe's
 * switches only when its path matches cmd.exe with backslashes, so the caller passes them itself.
 */
export function windowsShell(env: Env): string {
  const root = variable(env, 'SystemRoot', 'win32');
  return win32.join(root !== undefined && qualifiedPath(root, 'win32') ? root : 'C:\\Windows', 'System32', 'cmd.exe');
}
/**
 * cmd.exe's arguments for a script found by absolute path, passed with `windowsVerbatimArguments`: /d skips AutoRun
 * commands, /v:off stops a delayed expansion the registry may turn on from reading a `!`, and /s /c runs the line
 * inside the outer quotes as written. Each argument must already be safe on a cmd.exe line.
 */
export function windowsShellArgs(file: string, args: readonly string[]): string[] {
  return ['/d', '/v:off', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`];
}
