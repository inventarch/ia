import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_REGISTRIES, registryChooser, registryFor, userConfigDir } from '../src/registry-config.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-registry-cfg-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const cfg = (map: Record<string, unknown>) => JSON.stringify({ format: 'ia.registries.v1', registries: map });
const refusal = (code: string, message: RegExp) => ({
  code: `IA-DIST-${code}`,
  message: expect.stringMatching(message),
});
/** A workspace with `.ia/` and an empty user config home, so no test ever reads the real user file. */
const setup = () => {
  const root = temp(),
    user = temp();
  mkdirSync(join(root, '.ia'));
  return { root, user, env: { IA_CONFIG_HOME: user } };
};
const workspaceFile = (root: string, text: string) => writeFileSync(join(root, '.ia/registries.json'), text);
const refused = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

it('applies flag > env > workspace > user > default, exact provider over *', () => {
  const root = temp(),
    user = temp();
  mkdirSync(join(root, '.ia'));
  const env = (extra: Record<string, string> = {}) => ({ IA_CONFIG_HOME: user, ...extra });
  expect(registryFor('inventarch/language', { root, env: env() })).toMatchObject({
    provider: 'inventarch',
    level: 'default',
    source: 'built-in default',
    base: { kind: 'https', url: 'https://api.inventarch.dev/registry/' },
  });
  writeFileSync(join(user, 'registries.json'), cfg({ '*': 'https://user.test/r' }));
  expect(registryFor('acme/x', { root, env: env() })).toMatchObject({
    level: 'user',
    source: join(user, 'registries.json'),
    base: { url: 'https://user.test/r/' },
  });
  expect(registryFor('inventarch/language', { root, env: env() })).toMatchObject({ level: 'user' });
  workspaceFile(root, cfg({ acme: 'mirror', '*': 'https://ws.test/r' }));
  expect(registryFor('acme/x', { root, env: env() })).toMatchObject({
    level: 'workspace',
    source: '.ia/registries.json',
    base: { kind: 'dir', path: join(root, 'mirror') },
  });
  expect(registryFor('inventarch/language', { root, env: env() })).toMatchObject({
    level: 'workspace',
    base: { url: 'https://ws.test/r/' },
  });
  expect(registryFor('acme/x', { root, env: env({ IA_REGISTRY: 'https://env.test' }) })).toMatchObject({
    level: 'env',
    source: 'IA_REGISTRY',
    base: { url: 'https://env.test/' },
  });
  expect(
    registryFor('acme/x', { root, env: env({ IA_REGISTRY: 'https://env.test' }), flag: 'https://flag.test' }),
  ).toMatchObject({ level: 'flag', source: '--registry', base: { url: 'https://flag.test/' } });
});

it('prefers an exact provider key over * within the user file', () => {
  const { root, user, env } = setup();
  writeFileSync(join(user, 'registries.json'), cfg({ acme: 'https://acme.test', '*': 'https://any.test' }));
  expect(registryFor('acme/x', { root, env })).toMatchObject({ level: 'user', base: { url: 'https://acme.test/' } });
  expect(registryFor('other/x', { root, env })).toMatchObject({ level: 'user', base: { url: 'https://any.test/' } });
});

it('resolves relative --registry and IA_REGISTRY directories against cwd, not the workspace', () => {
  const { root, env } = setup(),
    cwd = temp();
  expect(registryFor('acme/x', { root, env, cwd, flag: 'mirror' })).toMatchObject({
    level: 'flag',
    base: { kind: 'dir', path: join(cwd, 'mirror') },
  });
  expect(registryFor('acme/x', { root, env: { ...env, IA_REGISTRY: '../elsewhere' }, cwd })).toMatchObject({
    level: 'env',
    base: { kind: 'dir', path: join(cwd, '..', 'elsewhere') },
  });
});

it('refuses an unmapped provider, credentials and absolute workspace paths', () => {
  const { root, env } = setup();
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal(
      'REGISTRY-UNMAPPED',
      /^No registry is configured for provider acme \(needed for acme\/x\); map it in \.ia\/registries\.json or pass --registry$/,
    ),
  );
  workspaceFile(root, cfg({ acme: 'https://u:p@x.test' }));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('INPUT-INVALID', /^\.ia\/registries\.json acme: .*credential/),
  );
  workspaceFile(root, cfg({ acme: 'https://x.test/r?token=1' }));
  expect(() => registryFor('acme/x', { root, env })).toThrow(/credential/);
  workspaceFile(root, cfg({ acme: 'C:/abs' }));
  expect(() => registryFor('acme/x', { root, env })).toThrow(/relative/);
});

it('keeps workspace directories inside the workspace', () => {
  const { root, env } = setup();
  for (const value of [
    '../outside',
    '../../x',
    'sub/../../x',
    '..',
    '.',
    'sub/..',
    'C:dir',
    'c:/dir',
    '//server/share',
    '\\\\server\\share',
    '\\\\?\\C:\\x',
    join(root, 'mirror'),
  ]) {
    workspaceFile(root, cfg({ acme: value }));
    expect(
      refused(() => registryFor('acme/x', { root, env })),
      value,
    ).toMatchObject(
      refusal(
        'INPUT-INVALID',
        /^\.ia\/registries\.json acme: Workspace registry directories must be relative paths inside the workspace: /,
      ),
    );
  }
  workspaceFile(root, cfg({ acme: 'sub/../mirror' }));
  expect(registryFor('acme/x', { root, env })).toMatchObject({ base: { kind: 'dir', path: join(root, 'mirror') } });
});

it('requires absolute directories in the user file', () => {
  const { root, user, env } = setup(),
    mirror = temp();
  writeFileSync(join(user, 'registries.json'), cfg({ acme: 'mirror' }));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('INPUT-INVALID', /registries\.json acme: User registry directories must be absolute: mirror$/),
  );
  writeFileSync(join(user, 'registries.json'), cfg({ acme: mirror }));
  expect(registryFor('acme/x', { root, env })).toMatchObject({ level: 'user', base: { kind: 'dir', path: mirror } });
});

it('refuses malformed registries files, naming the file', () => {
  const { root, user, env } = setup();
  const bad = [
    JSON.stringify({ format: 'ia.registries.v1', registries: {}, extra: true }),
    JSON.stringify({ format: 'ia.registries.v2', registries: {} }),
    JSON.stringify({ format: 'ia.registries.v1', registries: ['https://x.test'] }),
    JSON.stringify({ format: 'ia.registries.v1', registries: null }),
    cfg({ acme: '' }),
    cfg({ acme: 7 }),
    cfg({ Acme: 'https://x.test' }),
    cfg({ 'acme/x': 'https://x.test' }),
    cfg({ 'a..b': 'https://x.test' }),
    '{"format":"ia.registries.v1","registries":{}',
    'not json',
  ];
  for (const text of bad) {
    workspaceFile(root, text);
    expect(
      refused(() => registryFor('acme/x', { root, env })),
      text,
    ).toMatchObject(refusal('INPUT-INVALID', /^Invalid \.ia\/registries\.json/));
  }
  workspaceFile(root, cfg({}));
  writeFileSync(join(user, 'registries.json'), cfg({ acme: 7 }));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('INPUT-INVALID', new RegExp(`^Invalid ${join(user, 'registries.json').replace(/[\\.]/g, '\\$&')}`)),
  );
});

it('accepts provider keys the distribution id grammar accepts and refuses invalid ids', () => {
  const { root, env } = setup();
  workspaceFile(root, cfg({ 'acme.io': 'https://dot.test', 'a-1': 'https://dash.test' }));
  expect(registryFor('acme.io/x', { root, env })).toMatchObject({
    provider: 'acme.io',
    base: { url: 'https://dot.test/' },
  });
  expect(registryFor('a-1/x', { root, env })).toMatchObject({ provider: 'a-1', base: { url: 'https://dash.test/' } });
  expect(refused(() => registryFor('Acme/x', { root, env }))).toMatchObject(refusal('INPUT-INVALID', /Acme\/x/));
});

it('resolves the per-OS user config directory', () => {
  expect(userConfigDir({}, 'linux', '/home/u')).toBe(join('/home/u', '.config', 'ia'));
  expect(userConfigDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u')).toBe(join('/x', 'ia'));
  // XDG Base Directory: a relative $XDG_CONFIG_HOME is invalid and ignored.
  expect(userConfigDir({ XDG_CONFIG_HOME: 'relative/x' }, 'linux', '/home/u')).toBe(join('/home/u', '.config', 'ia'));
  expect(userConfigDir({ APPDATA: 'C:\\A' }, 'win32', 'C:\\U')).toBe(join('C:\\A', 'ia'));
  expect(userConfigDir({}, 'win32', 'C:\\U')).toBe(join('C:\\U', 'AppData', 'Roaming', 'ia'));
  expect(userConfigDir({}, 'darwin', '/Users/u')).toBe(join('/Users/u', 'Library/Preferences', 'ia'));
  const home = temp();
  expect(userConfigDir({ IA_CONFIG_HOME: home, APPDATA: 'C:\\A' }, 'win32', 'C:\\U')).toBe(home);
  expect(refused(() => userConfigDir({ IA_CONFIG_HOME: 'relative' }, 'linux', '/home/u'))).toMatchObject(
    refusal('INPUT-INVALID', /IA_CONFIG_HOME must be absolute/),
  );
  expect(DEFAULT_REGISTRIES).toEqual({ inventarch: 'https://api.inventarch.dev/registry' });
});

/** A directory link: a junction on Windows (no admin needed), a symlink elsewhere. Returns false only when the OS refuses with EPERM. */
const linked = (target: string, link: string): boolean => {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

it('follows links on the user config path, which is operator-owned and outside the workspace', (context) => {
  const { root } = setup(),
    real = temp(),
    parent = temp(),
    link = join(parent, 'config');
  writeFileSync(join(real, 'registries.json'), cfg({ acme: 'https://linked.test' }));
  if (!linked(real, link)) return context.skip();
  expect(registryFor('acme/x', { root, env: { IA_CONFIG_HOME: link } })).toMatchObject({
    level: 'user',
    source: join(link, 'registries.json'),
    base: { url: 'https://linked.test/' },
  });
  // A missing file behind the link, or a link to nowhere, is an absent file.
  rmSync(join(real, 'registries.json'));
  expect(refused(() => registryFor('acme/x', { root, env: { IA_CONFIG_HOME: link } }))).toMatchObject({
    code: 'IA-DIST-REGISTRY-UNMAPPED',
  });
  expect(refused(() => registryFor('acme/x', { root, env: { IA_CONFIG_HOME: join(parent, 'absent') } }))).toMatchObject(
    { code: 'IA-DIST-REGISTRY-UNMAPPED' },
  );
});

it('refuses a user registries.json that is not a regular file or exceeds 64 KiB', () => {
  const { root, user, env } = setup();
  mkdirSync(join(user, 'registries.json'));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('INPUT-INVALID', /^Expected a regular file: .*registries\.json$/),
  );
  rmSync(join(user, 'registries.json'), { recursive: true });
  writeFileSync(
    join(user, 'registries.json'),
    cfg({ acme: 'https://x.test', '*': `https://x.test/${'a'.repeat(64 * 1024)}` }),
  );
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('LIMIT-EXCEEDED', /registries\.json/),
  );
  // A config home that is a plain file has no registries.json in it, on every OS.
  const file = temp();
  writeFileSync(join(file, 'plain'), 'x');
  expect(refused(() => registryFor('acme/x', { root, env: { IA_CONFIG_HOME: join(file, 'plain') } }))).toMatchObject({
    code: 'IA-DIST-REGISTRY-UNMAPPED',
  });
});

it('still refuses a linked .ia in the workspace', (context) => {
  const root = temp(),
    user = temp(),
    outside = temp();
  writeFileSync(join(outside, 'registries.json'), cfg({ acme: 'https://x.test' }));
  if (!linked(outside, join(root, '.ia'))) return context.skip();
  expect(refused(() => registryFor('acme/x', { root, env: { IA_CONFIG_HOME: user } }))).toMatchObject(
    refusal('PATH-UNSAFE', /Link\/junction is not allowed/),
  );
});

it('validates every entry of a registries file, not only the one looked up', () => {
  const { root, user, env } = setup();
  for (const [other, message] of [
    ['https://u:tok@x.test', /credential/],
    ['../x', /relative paths inside the workspace/],
    ['sub/../../x', /relative paths inside the workspace/],
  ] as const) {
    workspaceFile(root, cfg({ acme: 'https://ok.test', other }));
    const error = refused(() => registryFor('acme/x', { root, env }));
    expect(error, other).toMatchObject(
      refusal('INPUT-INVALID', new RegExp(`^\\.ia/registries\\.json other: .*${message.source}`)),
    );
    expect(error, other).toMatchObject({ path: '.ia/registries.json' });
  }
  workspaceFile(root, cfg({}));
  writeFileSync(join(user, 'registries.json'), cfg({ acme: 'https://ok.test', other: 'relative' }));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject(
    refusal('INPUT-INVALID', /registries\.json other: User registry directories must be absolute: relative$/),
  );
});

it('locates workspace-file refusals at .ia/registries.json', () => {
  const { root, env } = setup();
  workspaceFile(root, 'not json');
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject({
    code: 'IA-DIST-INPUT-INVALID',
    path: '.ia/registries.json',
  });
  workspaceFile(root, cfg({ acme: '../outside' }));
  expect(refused(() => registryFor('acme/x', { root, env }))).toMatchObject({
    code: 'IA-DIST-INPUT-INVALID',
    path: '.ia/registries.json',
  });
});

it('reads each registries file at most once per chooser, and only when a lower level is reached', () => {
  const { root, user, env } = setup();
  workspaceFile(root, 'not json');
  // Levels 1-2 answer without reading the workspace file.
  expect(registryChooser({ root, env, flag: 'https://flag.test' })('acme/x')).toMatchObject({ level: 'flag' });
  expect(registryChooser({ root, env: { ...env, IA_REGISTRY: 'https://env.test' } })('acme/x')).toMatchObject({
    level: 'env',
  });
  workspaceFile(root, cfg({ acme: 'https://ws-1.test' }));
  writeFileSync(join(user, 'registries.json'), 'not json');
  const choose = registryChooser({ root, env });
  // The workspace level answers, so the malformed user file is not read.
  expect(choose('acme/x')).toMatchObject({ level: 'workspace', base: { url: 'https://ws-1.test/' } });
  workspaceFile(root, cfg({ acme: 'https://ws-2.test', other: 'https://ws-2.test' }));
  writeFileSync(join(user, 'registries.json'), cfg({ other: 'https://user-1.test' }));
  expect(choose('acme/x')).toMatchObject({ base: { url: 'https://ws-1.test/' } });
  expect(choose('other/x')).toMatchObject({ level: 'user', base: { url: 'https://user-1.test/' } });
  writeFileSync(join(user, 'registries.json'), cfg({ other: 'https://user-2.test' }));
  expect(choose('other/x')).toMatchObject({ level: 'user', base: { url: 'https://user-1.test/' } });
});

it('returns deeply frozen choices', () => {
  const { root, env } = setup();
  workspaceFile(root, cfg({ acme: 'mirror' }));
  for (const choice of [
    registryFor('acme/x', { root, env }),
    registryFor('inventarch/x', { root, env }),
    registryFor('acme/x', { root, env, flag: 'https://f.test' }),
  ]) {
    expect(Object.isFrozen(choice)).toBe(true);
    expect(Object.isFrozen(choice.base)).toBe(true);
  }
});
