/**
 * Bare `ia` opens the console only on an interactive terminal (consumer CLI contract §1.2): argv empty, stdin and stdout
 * both TTYs, and `CI` unset or empty. Everywhere else it prints exactly today's help at exit 0. A piped child cannot be a
 * TTY, so the CI-on-a-TTY half is proven here through the injected entry with a fake `isatty`;
 * console-entry-installed.test.ts proves the piped half against the built binary.
 */
import { describe, expect, it } from 'vitest';
import type { Host } from '../src/consumer.js';
import { dispatch, renderHelp } from '../src/consumer.js';
import type { EntryDeps } from '../src/main.js';
import { enter, opensConsole, runCli } from '../src/main.js';
import { resolveCapabilities } from '../src/render.js';
import { EXTENSIONS, packageRoot } from '../src/self.js';

describe('opensConsole', () => {
  it('truth table', () => {
    const cases: readonly [readonly string[], boolean, boolean, Record<string, string | undefined>, boolean][] = [
      [[], true, true, {}, true],
      [[], true, true, { CI: '' }, true],
      [[], true, true, { CI: '1' }, false],
      [[], true, true, { CI: 'true' }, false],
      [[], false, true, {}, false],
      [[], true, false, {}, false],
      [[], false, false, {}, false],
      [['--help'], true, true, {}, false],
      [['doctor'], true, true, {}, false],
      [['--json'], true, true, {}, false],
    ];
    for (const [argv, stdin, stdout, env, expected] of cases)
      expect([argv, stdin, stdout, env, opensConsole(argv, stdin, stdout, env)]).toEqual([
        argv,
        stdin,
        stdout,
        env,
        expected,
      ]);
  });
});

describe('enter', () => {
  const fakeHost = (env: Record<string, string | undefined>): Host => {
    const terminal = { env, isTTY: true, columns: 100 };
    return {
      cwd: packageRoot,
      env,
      stdout: terminal,
      stderr: terminal,
      interaction: { interactive: true, write: () => {}, read: () => Promise.resolve(null) },
      version: '9.9.9',
      packageRoot,
    };
  };
  const deps = (env: Record<string, string | undefined>, onDispatch: () => Promise<void> = async () => {}) => {
    const calls: string[] = [];
    const entry: EntryDeps = {
      isatty: () => true,
      env,
      runConsole: async () => {
        calls.push('console');
        return 0;
      },
      dispatch: async () => {
        calls.push('dispatch');
        await onDispatch();
      },
    };
    return { calls, entry };
  };
  it("enter with a fake TTY and CI=1 dispatches, never starts the console, and the dispatched output is today's help", async () => {
    const env = { CI: '1' };
    const host = fakeHost(env);
    let result: Awaited<ReturnType<typeof dispatch>> | undefined;
    const { calls, entry } = deps(env, async () => {
      result = await dispatch([], host, runCli, EXTENSIONS);
    });
    expect(await enter([], entry)).toBe('dispatch');
    expect(calls).toEqual(['dispatch']);
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toBe(renderHelp(host, resolveCapabilities(host.stdout, {}), EXTENSIONS));
    expect(result?.stderr).toBe('');
  });
  it('enter with a fake TTY, no CI and empty argv starts the console; with a non-empty argv it dispatches', async () => {
    const opened = deps({});
    expect(await enter([], opened.entry)).toBe('console');
    expect(opened.calls).toEqual(['console']);
    const typed = deps({});
    expect(await enter(['doctor'], typed.entry)).toBe('dispatch');
    expect(typed.calls).toEqual(['dispatch']);
  });
  it('a file descriptor that is not a terminal dispatches', async () => {
    for (const fd of [0, 1]) {
      const { calls, entry } = deps({});
      expect(await enter([], { ...entry, isatty: (asked) => asked !== fd })).toBe('dispatch');
      expect(calls).toEqual(['dispatch']);
    }
  });
});
