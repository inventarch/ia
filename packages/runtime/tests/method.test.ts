import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRIEFING_LIMIT,
  MethodError,
  REGISTRY_FORMAT,
  briefing,
  canonical,
  displayName,
  expandReleases,
  findKit,
  folderKits,
  homeKits,
  listKits,
  methodRefusal,
  readRegistry,
  readReleases,
  registerWorkspace,
  releaseRecords,
  scopeKey,
  selectBinding,
} from '../src/method/index.js';
import type { Bindings } from '../src/method/index.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-method-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const row = (version: string) => ({
  version,
  archive: version.replaceAll('.', '').padStart(64, 'a'),
  manifest: 'm'.repeat(64),
  sources: 's'.repeat(64),
  language: 'inventarch/language ^3.2.0',
  cli: '@inventarch/cli 3.4.1',
});
function kit(path: string, version: string, format: 1 | 2, folder: string = path): string {
  const at = join(dir, path);
  write(join(at, '.ia', 'release.json'), { id: `inventarch/${folder}-kit`, version });
  const records = [{ system: folder, word: 'capability', name: `${folder}-do` }];
  if (format === 1)
    write(join(at, 'releases.json'), { kit: `inventarch/${folder}-kit`, releases: [{ ...row(version), records }] });
  else {
    write(join(at, 'releases.json'), {
      format: 2,
      kit: `inventarch/${folder}-kit`,
      latest: version,
      releases: [{ ...row(version), file: `releases/${version}.json` }],
    });
    write(join(at, 'releases', `${version}.json`), {
      format: 2,
      kit: `inventarch/${folder}-kit`,
      version,
      archive: row(version).archive,
      records,
    });
  }
  return at;
}

describe('kit releases', () => {
  it('reads format 1 and format 2 to the same history, and checks a per-version file against its row', () => {
    const one = kit('one', '0.2.0', 1),
      two = kit('two', '0.2.0', 2);
    const expanded = expandReleases(two);
    expect(expanded.releases).toEqual([
      { ...row('0.2.0'), records: [{ system: 'two', word: 'capability', name: 'two-do' }] },
    ]);
    expect(expandReleases(one)).toEqual(readReleases(one));
    expect(releaseRecords(two, readReleases(two).releases[0]!)).toEqual(expanded.releases[0]!.records);
    write(join(two, 'releases', '0.2.0.json'), {
      format: 2,
      kit: 'inventarch/two-kit',
      version: '0.2.0',
      archive: 'x',
      records: [],
    });
    expect(() => releaseRecords(two, readReleases(two).releases[0]!)).toThrow(/does not belong/);
    write(join(two, 'releases.json'), { format: 3, kit: 'inventarch/two-kit', releases: [] });
    expect(() => readReleases(two)).toThrow(/formats 1 and 2/);
  });
  it('finds bundled kits first, then the newest home version of each other kit', () => {
    kit('one', '0.1.0', 1);
    const home = join(dir, 'home');
    mkdirSync(home);
    const older = kit(join('home', 'two', '0.1.0'), '0.1.0', 2, 'two'),
      newer = kit(join('home', 'two', '0.3.0'), '0.3.0', 2, 'two');
    expect(homeKits(home).map((k) => k.dir)).toEqual([newer, older]);
    const kits = listKits({ bundled: dir, home });
    expect(kits.map((k) => [k.folder, k.origin, k.version])).toEqual([
      ['one', 'bundled', '0.1.0'],
      ['two', 'home', '0.3.0'],
    ]);
    expect(findKit('two', kits).latest?.version).toBe('0.3.0');
    expect(() => findKit('three', folderKits(dir))).toThrow(MethodError);
  });
});

describe('binding selection', () => {
  const data = (bindings: Bindings['bindings'], extra: Partial<Bindings> = {}): Bindings => ({
    format: 1,
    path: '.ia/bindings.json',
    bindings,
    precedence: [],
    defaults: {},
    ...extra,
  });
  it('chooses exact, then wildcard, then default, then by precedence', () => {
    const a = { kit: 'a', capability: 'x' },
      b = { kit: 'b', capability: 'y' };
    expect(selectBinding(data({ 'work.task': [a], 'work.*': [b] }), 'work', 'task')).toEqual({
      ...a,
      key: 'work.task',
      via: 'exact',
    });
    expect(selectBinding(data({ 'work.*': [b] }), 'work', 'plan')).toEqual({ ...b, key: 'work.plan', via: 'wildcard' });
    expect(selectBinding(data({}, { defaults: { work: a } }), 'work', 'plan').via).toBe('default');
    expect(selectBinding(data({ 'work.*': [a, b] }, { precedence: ['b'] }), 'work', 'plan')).toMatchObject({
      kit: 'b',
      via: 'wildcard+precedence',
    });
    expect(() => selectBinding(data({ 'work.*': [a, b] }), 'work', 'plan')).toThrow(/precedence does not order/);
    expect(methodRefusal(catching(() => selectBinding(null, 'knowledge', 'find')))).toMatchObject({
      error: { code: 'IA-CORE-NO-METHOD', key: 'knowledge.find' },
    });
    expect(() => selectBinding(null, 'development', 'change')).toThrow(/now delivery/);
  });
  it('states the scope key an activity names, the entry default for others', () => {
    expect(scopeKey('knowledge', 'place')).toEqual({ shape: 'governance', phase: 'plan', mapped: true });
    expect(scopeKey('delivery', 'paint')).toEqual({ shape: 'execution', phase: 'act', mapped: false });
    expect(() => scopeKey('delivery', 'change', { phase: 'later' })).toThrow(MethodError);
  });
});
const catching = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('workspace registry', () => {
  const home = (): string => join(dir, '.ia');
  it('normalises both earlier formats and writes format 2', () => {
    const music = join(dir, 'Documents', 'ia', 'music');
    write(join(home(), 'workspace-locations.json'), {
      format: 'personal-workspace-locations-1',
      workspaces: { music: { root: music, entry: 'music.py' } },
    });
    expect(readRegistry(home()).workspaces).toEqual([expect.objectContaining({ id: 'music', root: music })]);
    write(join(home(), 'workspace-locations.json'), { format: 1, locations: { studio: { path: music } } });
    expect(readRegistry(home()).workspaces.map((w) => [w.id, w.root])).toEqual([['studio', music]]);
    registerWorkspace(home(), { id: 'people', root: join(dir, 'Documents', 'ia', 'people'), label: 'People' });
    const written = JSON.parse(readFileSync(join(home(), 'workspace-locations.json'), 'utf8'));
    expect(written.format).toBe(REGISTRY_FORMAT);
    expect(written.workspaces.map((w: { id: string }) => w.id)).toEqual(['studio', 'people']);
    expect(written.workspaces[1]).toMatchObject({ label: 'People', added: expect.any(String) });
  });
  it('refuses a workspace inside the IA home, an unknown format and a relative root', () => {
    expect(() => registerWorkspace(home(), { id: 'x', root: join(home(), 'x') })).toThrow(/inside the IA home/);
    expect(() => registerWorkspace(home(), { id: 'x', root: 'x' })).toThrow(/absolute/);
    write(join(home(), 'workspace-locations.json'), { format: 9 });
    expect(() => readRegistry(home())).toThrow(/unknown format/);
  });
});

describe('names and briefing', () => {
  it('displays a lane key as ia-<lane>:<activity>, and the lane wildcard as ia-<lane>', () => {
    expect(displayName('work.brainstorm')).toBe('ia-work:brainstorm');
    expect(displayName('knowledge.*')).toBe('ia-knowledge');
  });
  it('keeps the briefing within its limit', () => {
    const kits = Array.from({ length: 200 }, (_, i) => ({
      kit: `inventarch/k${i}-kit`,
      version: '1.0.0',
      source: 'home' as const,
    }));
    const text = briefing({ root: dir, workspace: null, kits, lanes: ['work', 'knowledge', 'delivery'] });
    expect(text.length).toBe(BRIEFING_LIMIT);
  });
  it('serializes canonically, keys sorted and undefined members dropped', () => {
    expect(canonical({ b: 1, a: [undefined, { d: undefined, c: 'x' }] })).toBe('{"a":[null,{"c":"x"}],"b":1}');
  });
});
