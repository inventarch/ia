import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { iaHomeOf } from '../src/consumer.js';
import { HANDOFF_FROM, handoffTarget, NO_HANDOFF, rootFromArgv } from '../src/handoff.js';
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
  handoffTarget({ argv, cwd, env, packageRoot: running, iaHome, extensions: ['ext'] });

describe('rootFromArgv', () => {
  it('reads --root in both spellings', () => {
    const w = workspace('handoff-root');
    const elsewhere = scratch('handoff-root-cwd');
    expect(rootFromArgv(['validate', '--root', w], elsewhere, iaHome)).toBe(w);
    expect(rootFromArgv(['validate', `--root=${w}`], elsewhere, iaHome)).toBe(w);
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
  it('doctor --host never hands off', () => {
    const w = workspace('handoff-doctor-host');
    expect(target(['doctor', '--json', '--host', 'claude'], w)).toBeNull();
    expect(target(['doctor', '--host=claude'], w)).toBeNull();
  });
  it('does not hand off to itself through a junction', () => {
    const w = workspace('handoff-junction', { installed: false });
    const self = cliPackage(scratch('handoff-junction-self'));
    mkdirSync(resolve(w, 'node_modules/@inventarch'), { recursive: true });
    symlinkSync(self, resolve(w, 'node_modules/@inventarch/cli'), 'junction');
    expect(
      handoffTarget({ argv: ['validate'], cwd: w, env: {}, packageRoot: self, iaHome, extensions: [] }),
    ).toBeNull();
  });
  it('a malformed IA_HOME does not hand off', () => {
    // The running copy answers and refuses the variable as it already does; a hand-off would hide that refusal.
    const cwd = resolve(workspace('handoff-bad-home'), 'nested');
    mkdirSync(cwd);
    const env = { IA_HOME: 'relative/home' };
    const home = iaHomeOf(env);
    expect(home).toBeUndefined();
    const input = { argv: ['validate'], cwd, env, packageRoot: running, iaHome: home, extensions: [] };
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
});
