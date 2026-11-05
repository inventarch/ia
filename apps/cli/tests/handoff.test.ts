import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORE_TOKENS } from '../src/commands.js';
import { iaHomeOf } from '../src/discovery.js';
import {
  committed,
  HANDOFF_FROM,
  handOff,
  handoffTarget,
  NO_HANDOFF,
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
