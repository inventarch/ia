import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORE_TOKENS } from '../src/commands.js';
import { iaHomeOf } from '../src/discovery.js';
import {
  committed,
  EXITED,
  HANDOFF_FROM,
  handOff,
  handoffTarget,
  NO_HANDOFF,
  rememberCommitted,
  rootFromArgv,
  runnableCopy,
} from '../src/handoff.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const putJson = (path: string, value: unknown): void => put(path, JSON.stringify(value));
/** An installed copy of the CLI at `dir`: its manifest and an entry file. */
const cliPackage = (dir: string, version = '9.9.9'): string => {
  putJson(resolve(dir, 'package.json'), { name: '@inventarch/cli', version, bin: { ia: 'dist/main.js' } });
  put(resolve(dir, 'dist/main.js'), '');
  return dir;
};
/** A workspace with `.ia/src`, optionally a manifest pinning the CLI and optionally an installed copy. */
const workspace = (prefix: string, options: { dependency?: boolean; installed?: boolean } = {}): string => {
  const root = scratch(prefix);
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  putJson(
    resolve(root, 'package.json'),
    options.dependency === false ? {} : { devDependencies: { '@inventarch/cli': '9.9.9' } },
  );
  if (options.installed !== false) cliPackage(resolve(root, 'node_modules/@inventarch/cli'));
  return root;
};
// The running copy and the IA home live in scratch directories of their own, never inside a workspace.
const running = cliPackage(scratch('handoff-running'), '3.5.1');
const iaHome = resolve(scratch('handoff-home'), '.ia');
const target = (argv: readonly string[], cwd: string, env: Record<string, string | undefined> = {}) =>
  handoffTarget({ argv, cwd, env, packageRoot: running, iaHome, extensions: ['ext'], coreTokens: CORE_TOKENS });

describe('rootFromArgv', () => {
  it('reads --root in both spellings', () => {
    const w = workspace('handoff-root');
    const elsewhere = scratch('handoff-root-cwd');
    expect(rootFromArgv(['validate', '--root', w], elsewhere, iaHome)).toBe(realpathSync(w));
    expect(rootFromArgv(['validate', `--root=${w}`], elsewhere, iaHome)).toBe(realpathSync(w));
  });
  it('a --root reached through a link is the workspace at its real path', () => {
    const w = workspace('handoff-root-real');
    const link = resolve(scratch('handoff-root-link'), 'ws');
    symlinkSync(w, link, 'junction');
    expect(rootFromArgv(['validate', '--root', link], scratch('handoff-root-link-cwd'), iaHome)).toBe(realpathSync(w));
  });
  it('ignores --root after --', () => {
    const w = workspace('handoff-root-after');
    const cwd = workspace('handoff-root-after-cwd');
    expect(rootFromArgv(['validate', '--', '--root', w], cwd, iaHome)).toBe(cwd);
  });
  it('a --root that is not a workspace gives undefined', () => {
    const cwd = workspace('handoff-root-not-cwd');
    expect(rootFromArgv(['validate', '--root', scratch('handoff-root-not')], cwd, iaHome)).toBeUndefined();
  });
  it('a --root whose .ia is the IA home gives undefined', () => {
    const dir = scratch('handoff-root-home');
    mkdirSync(resolve(dir, '.ia/src'), { recursive: true });
    expect(
      rootFromArgv(['validate', '--root', dir], scratch('handoff-root-home-cwd'), resolve(dir, '.ia')),
    ).toBeUndefined();
    expect(rootFromArgv(['validate', '--root', dir], scratch('handoff-root-home-cwd'), iaHome)).toBe(realpathSync(dir));
  });
  it('falls back to discovery from cwd', () => {
    const w = workspace('handoff-root-discover');
    const nested = resolve(w, 'a/b');
    mkdirSync(nested, { recursive: true });
    expect(rootFromArgv(['validate'], nested, iaHome)).toBe(w);
  });
});

describe('handoffTarget', () => {
  it('no target when IA_HANDOFF_FROM is set', () => {
    expect(target(['validate'], workspace('handoff-from'), { [HANDOFF_FROM]: running })).toBeNull();
  });
  it('no target when IA_NO_HANDOFF=1', () => {
    expect(target(['validate'], workspace('handoff-off'), { [NO_HANDOFF]: '1' })).toBeNull();
  });
  it('no target outside any workspace', () => {
    expect(target(['validate'], scratch('handoff-outside'))).toBeNull();
  });
  it('no target without a CLI dependency', () => {
    expect(target(['validate'], workspace('handoff-no-dependency', { dependency: false }))).toBeNull();
  });
  it('bare ia never hands off', () => {
    expect(target([], workspace('handoff-bare'))).toBeNull();
  });
  it('--user never hands off', () => {
    expect(target(['host', 'claude', '--user'], workspace('handoff-user'))).toBeNull();
  });
  it('an extension token never hands off', () => {
    expect(target(['ext', 'run'], workspace('handoff-extension'))).toBeNull();
  });
  it('an extension token that is a core token still hands off, as dispatch routes it to the core command', () => {
    const w = workspace('handoff-extension-core');
    const input = { cwd: w, env: {}, packageRoot: running, iaHome, extensions: ['validate', 'ext'] };
    expect(handoffTarget({ ...input, argv: ['validate'], coreTokens: CORE_TOKENS })).not.toBeNull();
    expect(handoffTarget({ ...input, argv: ['ext'], coreTokens: CORE_TOKENS })).toBeNull();
  });
  it('doctor --host never hands off', () => {
    const w = workspace('handoff-doctor-host');
    expect(target(['doctor', '--json', '--host', 'claude'], w)).toBeNull();
    expect(target(['doctor', '--host=claude'], w)).toBeNull();
  });
  it('does not hand off to itself through a junction', () => {
    const w = workspace('handoff-junction', { installed: false });
    const self = cliPackage(scratch('handoff-junction-self'));
    mkdirSync(resolve(w, 'node_modules/@inventarch'), { recursive: true });
    const link = resolve(w, 'node_modules/@inventarch/cli');
    symlinkSync(self, link, 'junction');
    // The running copy is named in spellings other than the real path findLocalCli answers: through the junction, and
    // with the trailing separator main.ts's `new URL('../', import.meta.url)` gives. Only device and inode match.
    for (const packageRoot of [link, self + sep])
      expect(
        handoffTarget({
          argv: ['validate'],
          cwd: w,
          env: {},
          packageRoot,
          iaHome,
          extensions: [],
          coreTokens: CORE_TOKENS,
        }),
      ).toBeNull();
    expect(
      handoffTarget({
        argv: ['validate'],
        cwd: w,
        env: {},
        packageRoot: running,
        iaHome,
        extensions: [],
        coreTokens: CORE_TOKENS,
      }),
    ).not.toBeNull();
  });
  it('a malformed IA_HOME does not hand off', () => {
    // The running copy answers and refuses the variable as it already does; a hand-off would hide that refusal.
    const cwd = resolve(workspace('handoff-bad-home'), 'nested');
    mkdirSync(cwd);
    const env = { IA_HOME: 'relative/home' };
    const home = iaHomeOf(env);
    expect(home).toBeUndefined();
    const input = {
      argv: ['validate'],
      cwd,
      env,
      packageRoot: running,
      iaHome: home,
      extensions: [],
      coreTokens: CORE_TOKENS,
    };
    expect(() => handoffTarget(input)).not.toThrow();
    expect(handoffTarget(input)).toBeNull();
  });
  it('targets a different local copy', () => {
    const w = workspace('handoff-target');
    const found = target(['validate', '--json'], resolve(w));
    expect(found).toMatchObject({ version: '9.9.9' });
    expect(found?.entry).toBe(resolve(found?.packageRoot ?? '', 'dist/main.js'));
    // --root names the workspace from anywhere, and a `--user` after `--` is an argument, not the flag.
    expect(target(['validate', '--root', w, '--', '--user'], scratch('handoff-target-cwd'))).toMatchObject({
      version: '9.9.9',
    });
  });
  it('never targets a copy the repository commits', () => {
    const w = workspace('handoff-committed');
    const asked: string[] = [];
    const input = {
      argv: ['validate'],
      cwd: w,
      env: {},
      packageRoot: running,
      iaHome,
      extensions: [],
      coreTokens: CORE_TOKENS,
    };
    const isCommitted = (root: string) => {
      asked.push(root);
      return true;
    };
    expect(handoffTarget({ ...input, committed: isCommitted })).toBeNull();
    expect(asked).toEqual([realpathSync(resolve(w, 'node_modules/@inventarch/cli'))]);
    expect(handoffTarget({ ...input, committed: () => false })).toMatchObject({ version: '9.9.9' });
  });
});

describe('runnableCopy', () => {
  const copyOf = (w: string) => realpathSync(resolve(w, 'node_modules/@inventarch/cli'));
  it('an ordinary installed copy is the one to run', () => {
    const w = workspace('runnable-installed');
    expect(runnableCopy(w, { env: {}, running, committed: () => false })).toMatchObject({
      version: '9.9.9',
      packageRoot: copyOf(w),
    });
  });
  it('another copy is not run under the user’s IA_NO_HANDOFF=1', () => {
    const w = workspace('runnable-off');
    expect(runnableCopy(w, { env: { [NO_HANDOFF]: '1' }, running, committed: () => false })).toBeNull();
  });
  it('a copy the repository commits is not run', () => {
    const w = workspace('runnable-committed');
    const asked: string[] = [];
    const isCommitted = (root: string) => {
      asked.push(root);
      return true;
    };
    expect(runnableCopy(w, { env: {}, running, committed: isCommitted })).toBeNull();
    expect(asked).toEqual([copyOf(w)]);
  });
  it('the running copy itself is returned as found, and git is not asked about it', () => {
    const w = workspace('runnable-self');
    const asked: string[] = [];
    const isCommitted = (root: string) => {
      asked.push(root);
      return true;
    };
    for (const env of [{}, { [NO_HANDOFF]: '1' }])
      expect(runnableCopy(w, { env, running: copyOf(w), committed: isCommitted })).toMatchObject({ version: '9.9.9' });
    expect(asked).toEqual([]);
  });
  it('a copy hoisted to the workspaces root that lists the member is found, as hand-off finds it', () => {
    const repo = scratch('runnable-hoisted');
    putJson(resolve(repo, 'package.json'), { workspaces: ['packages/*'] });
    cliPackage(resolve(repo, 'node_modules/@inventarch/cli'));
    const member = resolve(repo, 'packages/app');
    mkdirSync(resolve(member, '.ia/src'), { recursive: true });
    putJson(resolve(member, 'package.json'), { devDependencies: { '@inventarch/cli': '9.9.9' } });
    expect(runnableCopy(member, { env: {}, running, committed: () => false })).toMatchObject({
      packageRoot: realpathSync(resolve(repo, 'node_modules/@inventarch/cli')),
    });
    expect(target(['validate'], member)?.packageRoot).toBe(realpathSync(resolve(repo, 'node_modules/@inventarch/cli')));
  });
});

describe('committed', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  it('is true once git tracks a file of the copy, and false outside a repository or for an untracked copy', () => {
    const w = workspace('handoff-git');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    expect(committed(copy)).toBe(false);
    expect(git(w, 'init', '-q').status).toBe(0);
    expect(committed(copy)).toBe(false);
    expect(git(w, 'add', '-f', 'node_modules/@inventarch/cli/package.json').status).toBe(0);
    expect(committed(copy)).toBe(true);
  });

  /** A tracked copy in a fresh repository. */
  const tracked = (prefix: string): string => {
    const w = workspace(prefix);
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    expect(git(w, 'init', '-q').status).toBe(0);
    expect(git(w, 'add', '-f', 'node_modules/@inventarch/cli/package.json').status).toBe(0);
    return copy;
  };
  /** Runs `body` with PATH set to `dir`, then puts PATH back. */
  const withPath = <T>(dir: string, body: () => T): T => {
    const before = process.env['PATH'];
    process.env['PATH'] = dir;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env['PATH'];
      else process.env['PATH'] = before;
    }
  };
  /** A directory whose `git` always exits non-zero (a copy of node on Windows, which rejects git's arguments). */
  const failingGit = (): string => {
    const dir = scratch('handoff-git-stub');
    if (process.platform === 'win32') copyFileSync(process.execPath, resolve(dir, 'git.exe'));
    else {
      put(resolve(dir, 'git'), '#!/bin/sh\nexit 128\n');
      chmodSync(resolve(dir, 'git'), 0o755);
    }
    return dir;
  };

  it('answers for the repository whatever GIT_* variables the caller set', () => {
    const copy = tracked('handoff-git-env');
    // An empty index in another file: git answers (exit 0, nothing listed) unless the variable is dropped.
    const index = resolve(scratch('handoff-git-index'), 'empty-index');
    const w = resolve(copy, '../../..');
    const emptied = spawnSync('git', ['read-tree', '--empty'], {
      cwd: w,
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    expect(emptied.status).toBe(0);
    const names = ['GIT_INDEX_FILE'] as const;
    const values = { GIT_INDEX_FILE: index };
    const before = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = values[name];
    try {
      expect(committed(copy)).toBe(true);
    } finally {
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
  });
  it('refuses a copy inside a work tree when git exits non-zero', () => {
    const copy = tracked('handoff-git-fails');
    expect(withPath(failingGit(), () => committed(copy))).toBe(true);
  });
  it('refuses a copy inside a work tree when git cannot be found', () => {
    const copy = tracked('handoff-git-missing');
    expect(withPath(scratch('handoff-git-empty'), () => committed(copy))).toBe(true);
  });
  it('does not refuse a copy outside any repository when git exits non-zero or cannot be found', () => {
    const w = workspace('handoff-git-norepo');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    expect(withPath(failingGit(), () => committed(copy))).toBe(false);
    expect(withPath(scratch('handoff-git-empty'), () => committed(copy))).toBe(false);
  });
});

describe('handOff', () => {
  const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  const counts = () => SIGNALS.map((signal) => process.listenerCount(signal));
  const child = (body: string) => {
    const dir = scratch('handoff-child');
    put(resolve(dir, 'main.js'), body);
    return { packageRoot: dir, version: '9.9.9', entry: resolve(dir, 'main.js') };
  };
  it("returns the child's exit code and leaves no signal listener behind", () => {
    const before = counts();
    const from = scratch('handoff-from');
    const target = child(`process.exitCode = process.env.${HANDOFF_FROM} === ${JSON.stringify(from)} ? 3 : 4;`);
    expect(handOff(target, [], { ...process.env }, from)).toBe(3);
    expect(counts()).toEqual(before);
  });
  // POSIX reports a child ended by a signal as a null status; Windows has no such ending to produce.
  it.skipIf(process.platform === 'win32')('returns 130 when the child ends on a signal', () => {
    const before = counts();
    expect(handOff(child("process.kill(process.pid, 'SIGTERM');"), [], { ...process.env }, 'x')).toBe(130);
    expect(counts()).toEqual(before);
  });
});

describe('rememberCommitted', () => {
  it('asks once per copy, however often it is asked', () => {
    const asked: string[] = [];
    const ask = rememberCommitted((packageRoot) => (asked.push(packageRoot), packageRoot === '/a'));
    expect([ask('/a'), ask('/a'), ask('/b'), ask('/b'), ask('/a')]).toEqual([true, true, false, false, true]);
    expect(asked).toEqual(['/a', '/b']);
  });
  it('is its own memo: another one asks again, so nothing outlives the console that made it', () => {
    let asked = 0;
    const probe = () => ((asked += 1), false);
    rememberCommitted(probe)('/a');
    rememberCommitted(probe)('/a');
    expect(asked).toBe(2);
  });
  it('does not keep a question git could not answer: it reads as the work tree does now and is asked again', () => {
    const answers: (boolean | null)[] = [null, true, false];
    const ask = rememberCommitted(() => answers.shift()!);
    expect(ask('/a')).toBe(false);
    expect(ask('/a')).toBe(true);
    expect(ask('/a')).toBe(true);
  });
  it('serves runnableCopy: the copy is refused or run from the remembered answer', () => {
    const w = workspace('remember-runnable');
    let asked = 0;
    const ask = rememberCommitted(() => ((asked += 1), false));
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(asked).toBe(1);
  });
  it('asks again when another copy is moved into the path, so a committed one moved in is refused', () => {
    const w = workspace('remember-replaced');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    let asked = 0;
    let tracked = false;
    const ask = rememberCommitted(() => ((asked += 1), tracked));
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    // The same copy again is not asked about; another one, which the repository commits, replaces it at that path.
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    renameSync(copy, resolve(scratch('remember-replaced-old'), 'cli'));
    renameSync(cliPackage(resolve(scratch('remember-replaced-new'), 'cli')), copy);
    tracked = true;
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toBeNull();
    expect(asked).toBe(2);
  });
  it('asks again once the repository starts tracking the copy, so a newly committed copy is refused', () => {
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    const w = workspace('remember-tracked');
    expect(git(w, 'init', '-q').status).toBe(0);
    let asked = 0;
    const ask = rememberCommitted((packageRoot) => ((asked += 1), committed(packageRoot)));
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(asked).toBe(1);
    expect(git(w, 'add', '-f', 'node_modules/@inventarch/cli/package.json').status).toBe(0);
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toBeNull();
    expect(asked).toBe(2);
  });
  it('asks again in a linked worktree once it starts tracking the copy, through its .git file', () => {
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    const main = scratch('remember-worktree-main');
    expect(git(main, 'init', '-q').status).toBe(0);
    expect(
      git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x').status,
    ).toBe(0);
    // Outside the main checkout, so only the worktree's `gitdir:` line leads to the index it uses.
    const w = resolve(scratch('remember-worktree'), 'linked');
    expect(git(main, 'worktree', 'add', '-q', w).status).toBe(0);
    mkdirSync(resolve(w, '.ia/src'), { recursive: true });
    putJson(resolve(w, 'package.json'), { devDependencies: { '@inventarch/cli': '9.9.9' } });
    cliPackage(resolve(w, 'node_modules/@inventarch/cli'));
    let asked = 0;
    const ask = rememberCommitted((packageRoot) => ((asked += 1), committed(packageRoot)), {});
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toMatchObject({ version: '9.9.9' });
    expect(asked).toBe(1);
    expect(git(w, 'add', '-f', 'node_modules/@inventarch/cli/package.json').status).toBe(0);
    expect(runnableCopy(w, { env: {}, running: '/elsewhere', committed: ask })).toBeNull();
    expect(asked).toBe(2);
  });
  it('keeps the exit of a copy with no repository above it: asked once, however often it is asked', () => {
    // A workspace outside every repository: git exits 128 for it every time, and nothing there can be tracked.
    const w = workspace('remember-no-repo');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    let asked = 0;
    const ask = rememberCommitted(() => ((asked += 1), EXITED), {});
    expect([ask(copy), ask(copy), ask(copy)]).toEqual([false, false, false]);
    expect(asked).toBe(1);
  });
  it('asks again after an exit inside a repository, since the repository is what failed', () => {
    const w = workspace('remember-exit-in-repo');
    expect(spawnSync('git', ['init', '-q'], { cwd: w }).status).toBe(0);
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    let asked = 0;
    const ask = rememberCommitted(() => ((asked += 1), EXITED), {});
    expect([ask(copy), ask(copy)]).toEqual([true, true]);
    expect(asked).toBe(2);
  });
  it('asks again after an exit when a .git that git rejects sits above the copy: the work tree refuses it', () => {
    const w = workspace('remember-exit-stub');
    put(resolve(w, '.git'), 'not a repository');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    let asked = 0;
    const ask = rememberCommitted(() => ((asked += 1), EXITED), {});
    expect([ask(copy), ask(copy)]).toEqual([true, true]);
    expect(asked).toBe(2);
  });
  it('asks again once a repository appears above a copy remembered as having none', () => {
    const w = workspace('remember-repo-appears');
    const copy = resolve(w, 'node_modules/@inventarch/cli');
    const ask = rememberCommitted(undefined, {});
    expect(ask(copy)).toBe(false);
    expect(ask(copy)).toBe(false);
    expect(spawnSync('git', ['init', '-q'], { cwd: w }).status).toBe(0);
    expect(spawnSync('git', ['add', '-f', 'node_modules/@inventarch/cli/package.json'], { cwd: w }).status).toBe(0);
    expect(ask(copy)).toBe(true);
  });
  // The git shims are POSIX shell scripts, which Windows does not run.
  it.skipIf(process.platform === 'win32')(
    'keeps only an answer git gave with exit 0: a failed, timed-out or missing git is asked again',
    () => {
      const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      expect(real).not.toBe('');
      // An untracked copy inside a repository: git's answer (not committed) differs from the work tree's (refused).
      const w = workspace('remember-shim');
      expect(spawnSync('git', ['init', '-q'], { cwd: w }).status).toBe(0);
      const copy = resolve(w, 'node_modules/@inventarch/cli');
      /** A git that logs each call and fails the first one as `first` says, then runs the real git. */
      const shim = (prefix: string, first: string): { dir: string; calls: () => number } => {
        const dir = scratch(prefix);
        const log = resolve(dir, 'calls.log');
        put(
          resolve(dir, 'git'),
          `#!/bin/sh\necho x >> '${log}'\nif [ ! -e '${log}.done' ]; then : > '${log}.done'; ${first}; fi\nexec '${real}' "$@"\n`,
        );
        chmodSync(resolve(dir, 'git'), 0o755);
        return {
          dir,
          calls: () => readFileSync(log, 'utf8').trim().split('\n').length,
        };
      };
      const withPath = <T>(dir: string, body: () => T): T => {
        const before = process.env['PATH'];
        process.env['PATH'] = dir;
        try {
          return body();
        } finally {
          if (before === undefined) delete process.env['PATH'];
          else process.env['PATH'] = before;
        }
      };
      for (const [prefix, first] of [
        ['remember-shim-128', 'exit 128'],
        ['remember-shim-timeout', 'exec /bin/sleep 5'],
      ] as const) {
        const git = shim(prefix, first);
        const ask = rememberCommitted(undefined, {});
        expect(withPath(git.dir, () => [ask(copy), ask(copy), ask(copy)])).toEqual([true, false, false]);
        expect(git.calls()).toBe(2);
      }
      // No git on the path at first: the work tree's answer, not kept; git found next time is asked.
      const git = shim('remember-shim-missing', 'true');
      const ask = rememberCommitted(undefined, {});
      expect(withPath(scratch('remember-shim-empty'), () => ask(copy))).toBe(true);
      expect(withPath(git.dir, () => [ask(copy), ask(copy)])).toEqual([false, false]);
      expect(git.calls()).toBe(1);
    },
  );
  it('does not remember while a GIT_ variable chooses the repository, since the disk then cannot say what changed', () => {
    let asked = 0;
    const ask = rememberCommitted(() => ((asked += 1), false), { GIT_DIR: '/somewhere/.git' });
    ask('/a');
    ask('/a');
    expect(asked).toBe(2);
  });
});
