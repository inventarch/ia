import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHORITATIVE_MARKER,
  HOME_FOLDERS,
  appendSessionEvent,
  closureStore,
  currentPin,
  homeFolder,
  kitCache,
  pinRootFor,
  workspaceKits,
} from '../src/method/index.js';
import type { HomeFolderKind } from '../src/method/index.js';

/**
 * Home folders, first release: each IA home folder is read and written at one authoritative place, the plain folder
 * when it holds an `authoritative` marker (written by a later release's cutover), else the `*-v1` folder. This release
 * never creates the plain folder or the marker and moves nothing.
 */
let dir: string, home: string, root: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-home-folders-')));
  home = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const env = (): NodeJS.ProcessEnv => ({ IA_HOME: home });
const KINDS = Object.keys(HOME_FOLDERS) as HomeFolderKind[];
const mark = (kind: string): void => {
  mkdirSync(join(home, kind), { recursive: true });
  writeFileSync(join(home, kind, AUTHORITATIVE_MARKER), '');
};
const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const names = (): string[] => readdirSync(home).sort();
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const binding = JSON.stringify({ workspace: { root: 'ROOT' }, revision: 1, keys: { k: {} } });

/** The folder consumers, each driven through its public entry. */
function writeEverything(): void {
  const pin = pinRootFor({ env: env(), project: 'p', task: 't' })!;
  write(join(pin, 'binding.json'), binding.replace('ROOT', root.replace(/\\/g, '\\\\')));
  appendSessionEvent(home, 'session-1', { event: 'x' });
  kitCache(env());
  write(join(closureStore(env()), 'marker.txt'), 'x');
}

it('names the five homes and their legacy folders', () => {
  expect(HOME_FOLDERS).toEqual({
    work: 'work-v1',
    sessions: 'sessions-v1',
    'kit-roots': 'kit-roots-v1',
    'installed-kits': 'installed-kits-v1',
    'method-closures': 'method-closures-v1',
  });
});

describe('without a marker', () => {
  it('resolves every home to its -v1 folder, as before', () => {
    for (const kind of KINDS) expect(homeFolder(home, kind)).toBe(join(home, `${kind}-v1`));
  });
  it('reads and writes land in the -v1 folders and nowhere else', () => {
    writeEverything();
    expect(pinRootFor({ env: env(), project: 'p', task: 't' })).toBe(join(home, 'work-v1', 'p', 't'));
    expect(currentPin(home, root)).toMatchObject({ task: 'p/t' });
    expect(existsSync(join(home, 'sessions-v1', 'session-1.jsonl'))).toBe(true);
    expect(closureStore(env())).toBe(join(home, 'method-closures-v1'));
    expect(kitCache(env())).toBe(join(realpathSync(home), 'kit-roots-v1'));
    expect(names()).toEqual(['method-closures-v1', 'sessions-v1', 'work-v1']);
  });
});

describe('with a marker', () => {
  it('resolves each home with a marker to its plain folder', () => {
    for (const kind of KINDS) {
      mark(kind);
      expect(homeFolder(home, kind)).toBe(join(home, kind));
    }
  });
  it('reads and writes go to the plain folders and nothing is written to -v1', () => {
    for (const kind of KINDS) mark(kind);
    writeEverything();
    expect(pinRootFor({ env: env(), project: 'p', task: 't' })).toBe(join(home, 'work', 'p', 't'));
    expect(currentPin(home, root)).toMatchObject({ task: 'p/t' });
    expect(existsSync(join(home, 'sessions', 'session-1.jsonl'))).toBe(true);
    expect(closureStore(env())).toBe(join(home, 'method-closures'));
    expect(kitCache(env())).toBe(join(realpathSync(home), 'kit-roots'));
    expect(names().filter((name) => name.endsWith('-v1'))).toEqual([]);
  });
  it('does not read a pin left in the -v1 folder once the plain folder is authoritative', () => {
    write(join(home, 'work-v1', 'p', 't', 'binding.json'), binding.replace('ROOT', root.replace(/\\/g, '\\\\')));
    expect(currentPin(home, root)).toBeDefined();
    mark('work');
    expect(currentPin(home, root)).toBeUndefined();
  });
  it('lets a marker in one home leave the others at -v1', () => {
    mark('work');
    expect(homeFolder(home, 'work')).toBe(join(home, 'work'));
    for (const kind of KINDS.filter((k) => k !== 'work')) expect(homeFolder(home, kind)).toBe(join(home, `${kind}-v1`));
    mark('sessions');
    expect(homeFolder(home, 'kit-roots')).toBe(join(home, 'kit-roots-v1'));
    expect(homeFolder(home, 'sessions')).toBe(join(home, 'sessions'));
  });
  it('needs the marker file itself: an empty plain folder is not authoritative', () => {
    mkdirSync(join(home, 'work'));
    expect(homeFolder(home, 'work')).toBe(join(home, 'work-v1'));
  });
});

describe('installed kits', () => {
  const BASE = { id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64), manifest: 'c'.repeat(64) };
  function install(): string {
    const record = '#! ia 1.0\n\n@workspace kb\n';
    const manifest = JSON.stringify({
      id: 'inventarch/ia-kb-kit',
      version: '0.9.0',
      dependencies: [{ id: BASE.id, range: '^3.2.0' }],
      files: [{ path: '.ia/src/workspace.ia', bytes: record.length, sha256: sha256(record), role: 'source' }],
    });
    const archive = 'd'.repeat(64);
    write(join(root, '.ia', 'distributions', 'store', archive, 'distribution.json'), manifest);
    write(join(root, '.ia', 'distributions', 'store', archive, '.ia', 'src', 'workspace.ia'), record);
    write(
      join(root, '.ia', 'distributions.lock.json'),
      JSON.stringify({
        formatVersion: 1,
        engine: '^0.1.2',
        requests: [{ id: BASE.id, range: '^3.2.0' }],
        packages: [{ ...BASE, location: `sha256:${BASE.archive}`, dependencies: [] }],
        entries: [
          {
            kind: 'package',
            name: '@inventarch/public-kits',
            version: '1.0.0',
            integrity: `sha512-${'E'.repeat(86)}==`,
            kits: [
              {
                id: 'inventarch/ia-kb-kit',
                version: '0.9.0',
                archive,
                manifest: sha256(manifest),
                dependencies: [BASE.id],
              },
            ],
          },
        ],
      }),
    );
    return archive;
  }
  it('materializes under installed-kits-v1 without a marker and under installed-kits with one', () => {
    const archive = install();
    const bundled = join(dir, 'bundled');
    expect(workspaceKits({ bundled, home: null }, root, env()).kits[0]!.dir).toBe(
      join(realpathSync(home), 'installed-kits-v1', archive),
    );
    rmSync(join(home, 'installed-kits-v1'), { recursive: true });
    mark('installed-kits');
    expect(workspaceKits({ bundled, home: null }, root, env()).kits[0]!.dir).toBe(
      join(realpathSync(home), 'installed-kits', archive),
    );
    expect(names()).toEqual(['installed-kits']);
  });
});

describe('this release never creates the plain folder or the marker', () => {
  it('leaves every plain folder and marker absent after all the writes', () => {
    writeEverything();
    for (const kind of KINDS) {
      expect(existsSync(join(home, kind))).toBe(false);
      expect(existsSync(join(home, kind, AUTHORITATIVE_MARKER))).toBe(false);
    }
  });
});
