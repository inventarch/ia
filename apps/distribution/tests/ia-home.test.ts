import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertIaHomeUsable, ensureIaHome, readHomeFile, resolveIaHome, writeHomeFile } from '../src/ia-home.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-home-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

it('resolves IA_HOME, then the IA_HOST_HOME alias, then ~/.ia', () => {
  // resolve(), not join(): on Windows a rooted '/a' resolves onto the current drive.
  expect(resolveIaHome({ IA_HOME: '/a', IA_HOST_HOME: '/b' }, '/u')).toEqual({
    home: resolve('/a'),
    source: 'IA_HOME',
  });
  expect(resolveIaHome({ IA_HOST_HOME: '/b' }, '/u')).toEqual({ home: resolve('/b'), source: 'IA_HOST_HOME' });
  expect(resolveIaHome({}, '/u')).toEqual({ home: join('/u', '.ia'), source: 'default' });
  expect(() => resolveIaHome({ IA_HOME: 'relative' }, '/u')).toThrow(/IA_HOME must be absolute/);
});
it('marks the home and refuses one that holds src/', () => {
  const home = join(temp(), '.ia');
  ensureIaHome(home);
  expect(JSON.parse(readFileSync(join(home, 'home.json'), 'utf8'))).toEqual({ schema: 'ia.home.v1' });
  mkdirSync(join(home, 'src'));
  expect(() => ensureIaHome(home)).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
});
it('assertIaHomeUsable refuses src/ without creating or writing anything', () => {
  const home = join(temp(), '.ia');
  expect(() => assertIaHomeUsable(home)).not.toThrow();
  expect(existsSync(home)).toBe(false);
  mkdirSync(join(home, 'src'), { recursive: true });
  expect(() => assertIaHomeUsable(home)).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(existsSync(join(home, 'home.json'))).toBe(false);
});
it('rewrites an existing marker that is empty or does not parse, and leaves a valid one alone', () => {
  const home = join(temp(), '.ia');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'home.json'), '');
  ensureIaHome(home);
  expect(JSON.parse(readFileSync(join(home, 'home.json'), 'utf8'))).toEqual({ schema: 'ia.home.v1' });
  writeFileSync(join(home, 'home.json'), 'not json');
  ensureIaHome(home);
  expect(JSON.parse(readFileSync(join(home, 'home.json'), 'utf8'))).toEqual({ schema: 'ia.home.v1' });
  writeFileSync(join(home, 'home.json'), JSON.stringify({ schema: 'ia.home.v1', extra: true }) + '\n');
  ensureIaHome(home);
  expect(JSON.parse(readFileSync(join(home, 'home.json'), 'utf8'))).toEqual({ schema: 'ia.home.v1', extra: true });
});
it('writes atomically and leaves no stage file', () => {
  const home = join(temp(), '.ia');
  writeHomeFile(home, 'state/x.json', '{"a":1}\n');
  writeHomeFile(home, 'state/x.json', '{"a":2}\n');
  expect(readHomeFile(home, 'state/x.json')).toBe('{"a":2}\n');
  expect(readdirSync(join(home, 'state'))).toEqual(['x.json']);
  expect(readHomeFile(home, 'state/missing.json')).toBeNull();
  expect(existsSync(join(home, 'home.json'))).toBe(true);
});
it('refuses an empty or escaping path before creating or marking the home', () => {
  const home = join(temp(), '.ia');
  expect(() => writeHomeFile(home, '', '{}')).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(existsSync(home)).toBe(false);
  expect(() => writeHomeFile(home, '../x', '{}')).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(existsSync(home)).toBe(false);
  expect(() => writeHomeFile(home, '../../outside.json', '{}')).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(existsSync(home)).toBe(false);
  expect(existsSync(resolve(home, '..', 'outside.json'))).toBe(false);
});
it.skipIf(process.platform === 'win32')('writes the file mode 0o600', () => {
  const home = join(temp(), '.ia');
  writeHomeFile(home, 'state/x.json', '{}\n');
  expect(statSync(join(home, 'state/x.json')).mode & 0o777).toBe(0o600);
});
