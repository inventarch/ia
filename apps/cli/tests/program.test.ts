/**
 * #436: the lookup by which a hand-run `ia` command finds the programs it starts (src/program.ts). Only qualified PATH
 * entries count, the rule the session hook applies to `ia` (host plugin distribution design §8.1, LKI-41). The Windows
 * rules run on every platform here, with Windows path semantics and an in-memory file system, so Linux CI checks them too.
 */
import { chmodSync, constants, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { LookupFs } from '../src/program.js';
import { findProgram, programEnv, qualifiedEntries, windowsShell, windowsShellArgs } from '../src/program.js';
import { cleanup, scratch } from './workspace-fixture.js';

afterAll(cleanup);

// An in-memory Windows file system holding `files` and the directories above them; it records every path it is asked about.
function windowsFiles(files: readonly string[], checked: string[] = []): LookupFs {
  const lower = files.map((file) => file.toLowerCase());
  return {
    statSync: (target) => {
      checked.push(target);
      const key = target.toLowerCase();
      if (lower.includes(key)) return { isFile: () => true, isDirectory: () => false };
      if (lower.some((file) => file.startsWith(`${key}\\`))) return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    },
    accessSync: () => {
      throw new Error('Windows has no execute permission to check');
    },
  };
}
const asWindows = (fs: LookupFs) => ({ platform: 'win32' as const, fs });

it('POSIX keeps only absolute PATH entries, as written, and falls back to /usr/bin and /bin only when PATH is unset', () => {
  // An empty entry, a relative one and one wrapped in quotes all name the working directory's descendants; a quote
  // inside a name is an ordinary character there.
  expect(qualifiedEntries({ PATH: 'bin::/usr/bin:./x:/opt/my"tools/bin:"/opt/q"' }, 'linux')).toEqual([
    '/usr/bin',
    '/opt/my"tools/bin',
  ]);
  expect(qualifiedEntries({}, 'darwin')).toEqual(['/usr/bin', '/bin']);
  expect(qualifiedEntries({ PATH: '' }, 'linux')).toEqual([]);
  // POSIX names are case-sensitive: a variable spelled Path is not the search path.
  expect(qualifiedEntries({ Path: '/opt/x' }, 'linux')).toEqual(['/usr/bin', '/bin']);
});

it('Windows keeps only entries that name a drive or a share, unquoted, whatever the variable is called', () => {
  const path = 'C:\\a;bin;;\\tools;C:rel;"D:\\b";\\\\server\\share\\bin;.\\x';
  expect(qualifiedEntries({ Path: path }, 'win32')).toEqual(['C:\\a', 'D:\\b', '\\\\server\\share\\bin']);
  expect(qualifiedEntries({ PATH: path }, 'win32')).toEqual(['C:\\a', 'D:\\b', '\\\\server\\share\\bin']);
  expect(qualifiedEntries({}, 'win32')).toEqual([]);
});

it('a started program gets only the qualified entries and, on Windows, no implicit current directory', () => {
  const posix = programEnv({ PATH: 'bin::/usr/bin', HOME: '/home/u', UNSET: undefined }, 'linux');
  expect(posix).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  // POSIX reads an empty PATH as the current directory, so no qualified entry becomes the system one.
  expect(programEnv({ PATH: 'bin::.' }, 'darwin')['PATH']).toBe('/usr/bin:/bin');
  // Windows drops every spelling of PATH and of the variable, so one environment block holds each name once.
  const windows = programEnv(
    { Path: 'C:\\a;bin', ComSpec: 'C:\\Windows\\system32\\cmd.exe', nodefaultcurrentdirectoryinexepath: '0' },
    'win32',
  );
  expect(windows).toEqual({
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATH: 'C:\\a',
    NoDefaultCurrentDirectoryInExePath: '1',
  });
});

it('the Windows lookup never checks an unqualified entry, and takes .com and .exe for a program, in PATH order', () => {
  const files = [
    'bin\\git.exe',
    'C:\\proj\\bin\\git.exe',
    '\\tools\\git.exe',
    'C:rel\\git.exe',
    'C:\\first\\git.cmd',
    'C:\\first\\git.js',
    'C:\\second\\git.com\\x',
    'C:\\third\\git.exe',
    'C:\\third\\git.com',
  ];
  const checked: string[] = [];
  const found = findProgram(
    'git',
    { PATH: ['bin', '\\tools', 'C:rel', 'C:\\first', 'C:\\second', 'C:\\third'].join(';') },
    'program',
    asWindows(windowsFiles(files, checked)),
  );
  // A .cmd needs cmd.exe and a .js Windows Script Host, so neither is a program; a directory named git.com is not one either.
  expect(found).toBe('C:\\third\\git.com');
  expect(checked[0]).toBe('C:\\first');
  expect(checked.some((target) => /^(bin|\\tools|C:rel)/i.test(target))).toBe(false);
});

it('the Windows lookup takes .bat and .cmd for a script, and passes over a path cmd.exe would expand', () => {
  const files = [
    'C:\\Users\\100%x\\npm\\claude.cmd',
    'C:\\Users\\100%x\\bin\\claude.exe',
    'C:\\npm\\claude.exe',
    'C:\\npm\\claude.cmd',
    'D:\\later\\claude.bat',
    'D:\\later\\claude.cmd',
  ];
  const fs = asWindows(windowsFiles(files));
  // A script ignores the .exe beside it; within one entry .bat comes before .cmd, as in cmd.exe's PATHEXT.
  expect(findProgram('claude', { PATH: 'C:\\Users\\100%x\\npm;C:\\npm;D:\\later' }, 'script', fs)).toBe(
    'C:\\npm\\claude.cmd',
  );
  expect(findProgram('claude', { PATH: 'D:\\later' }, 'script', fs)).toBe('D:\\later\\claude.bat');
  expect(findProgram('claude', { PATH: 'C:\\Users\\100%x\\npm' }, 'script', fs)).toBeNull();
  // A % is harmless where no shell reads the path, so a program there is found.
  expect(findProgram('claude', { PATH: 'C:\\Users\\100%x\\bin;C:\\npm' }, 'program', fs)).toBe(
    'C:\\Users\\100%x\\bin\\claude.exe',
  );
});

it('the Windows lookup checks a missing PATH directory once, not once per extension', () => {
  const checked: string[] = [];
  expect(
    findProgram(
      'git',
      { PATH: 'C:\\gone;D:\\also-gone;C:\\tools' },
      'program',
      asWindows(windowsFiles(['C:\\tools\\git.exe'], checked)),
    ),
  ).toBe('C:\\tools\\git.exe');
  expect(checked.filter((target) => /gone/i.test(target))).toEqual(['C:\\gone', 'D:\\also-gone']);
});

it('POSIX passes over a directory and a file without execute permission for the next entry, as the shell would', () => {
  // An in-memory POSIX file system: /a/git is a directory, /b/git is not executable, /c/git is.
  const fs: LookupFs = {
    statSync: (target) => {
      if (['/a', '/b', '/c', '/a/git'].includes(target)) return { isFile: () => false, isDirectory: () => true };
      if (['/b/git', '/c/git', 'bin/git'].includes(target)) return { isFile: () => true, isDirectory: () => false };
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    },
    accessSync: (target, mode) => {
      if (target !== '/c/git' || mode !== constants.X_OK)
        throw Object.assign(new Error(`EACCES: ${target}`), { code: 'EACCES' });
    },
  };
  const posix = { platform: 'linux' as const, fs };
  expect(findProgram('git', { PATH: 'bin:/a:/b:/c' }, 'program', posix)).toBe('/c/git');
  expect(findProgram('git', { PATH: 'bin:/a:/b' }, 'program', posix)).toBeNull();
  // POSIX has no script kind: everything it runs is a program.
  expect(findProgram('git', { PATH: '/c' }, 'script', posix)).toBeNull();
});

it('finds a program on the real file system and returns its absolute path', () => {
  const dir = scratch('lookup-real'),
    file = resolve(dir, process.platform === 'win32' ? 'git.exe' : 'git');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  expect(findProgram('git', { PATH: [scratch('lookup-empty'), dir].join(delimiter) })).toBe(file);
});

it('cmd.exe is named by a qualified path under SystemRoot, never by ComSpec, and given the line verbatim', () => {
  for (const env of [
    {},
    { SystemRoot: '' },
    { SystemRoot: 'rel' },
    { SystemRoot: '\\Windows' },
    { SystemRoot: 'C:Windows' },
    { ComSpec: 'D:\\tools\\cmd.exe' },
  ])
    expect(windowsShell(env), JSON.stringify(env)).toBe('C:\\Windows\\System32\\cmd.exe');
  expect(windowsShell({ SystemRoot: 'E:\\Win', ComSpec: 'C:\\Program Files\\nodejs\\node.exe' })).toBe(
    'E:\\Win\\System32\\cmd.exe',
  );
  expect(windowsShell({ systemroot: 'D:/Win' })).toBe('D:\\Win\\System32\\cmd.exe');
  // /d skips AutoRun, /v:off keeps a ! literal, /s strips only the outer quotes.
  expect(windowsShellArgs('C:\\a b & c!\\claude.cmd', ['plugin', 'list', '--json'])).toEqual([
    '/d',
    '/v:off',
    '/s',
    '/c',
    '""C:\\a b & c!\\claude.cmd" plugin list --json"',
  ]);
});
