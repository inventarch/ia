import {
  cpSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KERNEL_SOURCES, buildRegistry, compile, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import {
  caseFold,
  linked,
  pathKey,
  readInputs,
  readWorkspaceBytes,
  sameFile,
  systemMember,
  unaliased,
  within,
} from '../src/index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const temporary: string[] = [];
const workspace = () => {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-db-inputs-'));
  temporary.push(path);
  return path;
};
const put = (root: string, path: string, text: string | Uint8Array) => {
  const file = resolve(root, path);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
it('captures only explicit package sources with their physical paths and immutable selection', () => {
  const root = workspace(),
    packageRoot = 'packages/example';
  put(root, '.ia/src/systems/demo/system.ia', '#! ia 1.0\n');
  const path = `${packageRoot}/.ia/src/systems/demo/records/example.ia`;
  put(root, path, '#! ia 1.0\r\n# exact physical bytes\r\n');
  expect(readInputs(root).sources.some((source) => source.path === path)).toBe(false);
  const roots = [packageRoot],
    captured = readInputs(root, { authoredRoots: roots });
  roots.push('packages/other');
  expect(captured.authoredRoots).toEqual([packageRoot]);
  expect(captured.sources.find((source) => source.path === path)?.text).toContain('\r\n');
  expect(systemMember(path)).toEqual({ name: 'demo', root: `${packageRoot}/.ia/src/systems/demo` });
  expect(readInputs(root, { authoredRoots: [packageRoot] }).fingerprint).toBe(captured.fingerprint);
  put(root, path, '#! ia 1.0\n# changed\n');
  expect(readInputs(root, { authoredRoots: [packageRoot] }).fingerprint).not.toBe(captured.fingerprint);
});
it('refuses package roots that overlap, escape, carry independent authority or omit root context', () => {
  const root = workspace(),
    packageRoot = 'packages/example';
  put(root, '.ia/src/systems/demo/system.ia', '#! ia 1.0\n');
  put(root, `${packageRoot}/.ia/src/systems/demo/records/a.ia`, '#! ia 1.0\n');
  for (const authoredRoots of [
    ['../escape'],
    ['.ia'],
    [packageRoot, packageRoot],
    [packageRoot, `${packageRoot}/child`],
    [packageRoot.toUpperCase()],
  ])
    expect(() => readInputs(root, { authoredRoots })).toThrow();
  put(root, `${packageRoot}/.ia/workspace.json`, '{"version":1,"adopted":[]}');
  expect(() => readInputs(root, { authoredRoots: [packageRoot] })).toThrow(/independent root/);
  rmSync(resolve(root, `${packageRoot}/.ia/workspace.json`));
  put(root, `${packageRoot}/.ia/src/floor/override.ia`, '#! ia 1.0\n');
  expect(() => readInputs(root, { authoredRoots: [packageRoot] })).toThrow(/root-owned/);
  rmSync(resolve(root, `${packageRoot}/.ia/src/floor`), { recursive: true });
  rmSync(resolve(root, '.ia/src/systems/demo/system.ia'));
  expect(() => readInputs(root, { authoredRoots: [packageRoot] })).toThrow(/root-owned/);
});
it('refuses package source aliases, invalid UTF-8 and bounded file overflow', () => {
  const root = workspace(),
    packageRoot = 'packages/example',
    path = `${packageRoot}/.ia/src/systems/demo/records/a.ia`;
  put(root, '.ia/src/systems/demo/system.ia', '#! ia 1.0\n');
  put(root, path, new Uint8Array([0xff]));
  expect(() => readInputs(root, { authoredRoots: [packageRoot] })).toThrow();
  put(root, path, new Uint8Array(1048577));
  expect(() => readInputs(root, { authoredRoots: [packageRoot] })).toThrow(/limit/);
  put(root, path, '#! ia 1.0\n');
  symlinkSync(resolve(root, packageRoot), resolve(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => readInputs(root, { authoredRoots: ['alias'] })).toThrow(/Symlink|alias/);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openSync).mockReset();
  vi.mocked(readSync).mockReset();
  vi.mocked(closeSync).mockClear();
  for (const path of temporary.splice(0)) {
    const subpath = relative(resolve(tmpdir()), resolve(path));
    if (isAbsolute(subpath) || !subpath.startsWith('ia-db-inputs-') || subpath.includes('..'))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
});
it('loads a complete frozen floor in an empty workspace without inventing higher systems', () => {
  const snapshot = readInputs(workspace());
  expect(snapshot.floorOrigin).toBe('embedded');
  expect(snapshot.sources).toHaveLength(17);
  const sources = snapshot.sources.map((s) => ({ ...parse(s.text, s.path), location: s.location }));
  const built = buildRegistry(sources);
  expect(built.diagnostics).toEqual([]);
  expect([...built.registry.systems.keys()]).toEqual(['taxonomy']);
  expect(sources.flatMap((s) => compile(s.ast, built.registry, s.location, []).records)).toHaveLength(118);
  expect(() => (KERNEL_SOURCES as unknown[]).pop()).toThrow();
  expect(() => {
    (KERNEL_SOURCES[0] as { text: string }).text = 'changed';
  }).toThrow();
  expect(() => (snapshot.sources as unknown[]).pop()).toThrow();
});
it('uses the whole local floor without filling absent files from the embed', () => {
  const root = workspace();
  mkdirSync(resolve(root, '.ia/src/floor'), { recursive: true });
  expect(readInputs(root).sources).toEqual([]);
  expect(readInputs(root).floorOrigin).toBe('local');
  put(root, '.ia/src/floor/only.ia', '#! ia 1.0\n');
  expect(readInputs(root).sources.map((s) => s.path)).toEqual(['.ia/src/floor/only.ia']);
});
it('gives an explicit floor precedence and snapshots supplied locations/text', () => {
  const root = workspace();
  put(root, '.ia/src/floor/local.ia', '#! ia 1.0\n');
  put(root, '.ia/src/work.ia', '#! ia 1.0\n');
  const floor = [{ path: '.ia/src/floor/custom.ia', text: '#! ia 1.0\n# supplied\n' }];
  const placed: Location = {
    placement: { kind: 'adopted', band: 90, reach: 'team/./child' },
    provenance: 'methodology',
  };
  const snapshot = readInputs(root, { floor, locations: { '.ia/src/work.ia': placed } });
  expect(snapshot.floorOrigin).toBe('explicit');
  expect(snapshot.sources.some((s) => s.path.endsWith('local.ia'))).toBe(false);
  const authored = snapshot.sources.find((s) => s.path.endsWith('work.ia'))!;
  expect(authored.location.placement.reach).toBe('team/child');
  floor[0]!.text = 'changed';
  (placed.placement as { reach: string }).reach = 'changed';
  expect(snapshot.sources[0]!.text).toContain('supplied');
  expect(authored.location.placement.reach).toBe('team/child');
  expect(() => {
    (authored.location.placement as { reach: string }).reach = 'no';
  }).toThrow();
});
it('tracks exact bytes and empty folder inventory in a deterministic source fingerprint', () => {
  const root = workspace();
  put(root, '.ia/src/b.ia', '#! ia 1.0\r\n');
  put(root, '.ia/src/a.ia', '#! ia 1.0\n');
  const first = readInputs(root);
  expect(readInputs(root).fingerprint).toBe(first.fingerprint);
  expect(first.sources.find((s) => s.path.endsWith('b.ia'))!.text).toContain('\r\n');
  put(root, '.ia/src/b.ia', '\ufeff#! ia 1.0\n');
  const changed = readInputs(root);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
  expect(changed.sources.find((s) => s.path.endsWith('b.ia'))!.text.charCodeAt(0)).toBe(0xfeff);
  mkdirSync(resolve(root, '.ia/src/systems/empty'), { recursive: true });
  expect(readInputs(root).folders).toEqual(['empty']);
  expect(readInputs(root).fingerprint).not.toBe(changed.fingerprint);
});
it('refuses invalid UTF-8 and non-directory source roots by name', () => {
  const root = workspace();
  put(root, '.ia/src/bad.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => readInputs(root)).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  const other = workspace();
  put(other, '.ia/src', 'not a directory');
  expect(() => readInputs(other)).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  const malformed = workspace();
  put(malformed, '.ia/src/floor', 'not a directory');
  expect(() => readInputs(malformed)).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
});
it.each(['../outside.ia', '/outside.ia', 'C:/outside.ia', 'other.ia'])(
  'refuses escaping/non-source override %s',
  (path) => {
    expect(() =>
      readInputs(workspace(), {
        locations: { [path]: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' } },
      }),
    ).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  },
);
it('refuses source aliases, mismatched bands and invalid floor roots', () => {
  const root = workspace(),
    placement: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  expect(() => readInputs(root, { locations: { '.ia/src/x.ia': placement, '.ia/src/./x.ia': placement } })).toThrow(
    'Duplicate',
  );
  expect(() =>
    readInputs(root, {
      locations: { '.ia/src/x.ia': { ...placement, placement: { ...placement.placement, band: 10 } } },
    }),
  ).toThrow('placement/band');
  expect(() => readInputs(root, { floor: [{ path: '.ia/src/other.ia', text: '' }] })).toThrow('Floor source');
  expect(() =>
    readInputs(root, {
      floor: [
        { path: '.ia/src/floor/x.ia', text: '' },
        { path: '.ia/src/floor/./x.ia', text: '' },
      ],
    }),
  ).toThrow('Duplicate');
});
it('refuses source and root symlink traversal without reading the destination', () => {
  const root = workspace(),
    outside = workspace();
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  put(outside, 'secret.ia', '#! ia 1.0\n');
  symlinkSync(outside, resolve(root, '.ia/src/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => readInputs(root)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  const second = workspace();
  symlinkSync(outside, resolve(second, '.ia'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => readInputs(second)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  expect(readFileSync(resolve(outside, 'secret.ia'), 'utf8')).toBe('#! ia 1.0\n');
});
it('reads one workspace file exactly, refusing a link, a second name, a nonportable path, an escape and a file over its bound (D01a)', () => {
  const root = workspace(),
    outside = workspace();
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff]);
  put(root, 'docs/a.md', bytes);
  put(outside, 'secret.md', '# Secret\n');
  symlinkSync(outside, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  linkSync(resolve(root, 'docs/a.md'), resolve(root, 'docs/second.md'));
  put(root, 'docs/b.md', '# B\n');
  // Files a nonportable path names, which exist: a decomposed (NFD) name, and a colon, which on Windows names an
  // alternate data stream of docs/b.md and elsewhere a file of its own.
  put(root, 'docs/café.md', '# Decomposed\n');
  put(root, 'docs/b.md:hidden', '# Hidden\n');
  // The bytes as stored, the byte order mark and invalid UTF-8 included; a path is read as canonicalized.
  expect(Buffer.from(readWorkspaceBytes(root, 'docs/b.md', 4))).toEqual(Buffer.from('# B\n'));
  expect(Buffer.from(readWorkspaceBytes(root, './docs\\b.md', 4))).toEqual(Buffer.from('# B\n'));
  const thrown = (path: string): { readonly code?: string; readonly message?: string; readonly path?: string } => {
    try {
      readWorkspaceBytes(root, path, 1024);
    } catch (error) {
      return error as Error;
    }
    throw new Error(`${path} was read`);
  };
  // Every refusal's exact message, and its `path`: the canonical path, the only path the message names.
  const refused = (path: string, code: string, message: string, at: string): void => {
    const error = thrown(path);
    expect(error, path).toMatchObject({ code, message: `${code}: ${message}` });
    expect(error.path, path).toBe(at);
  };
  // A file a second name links to is aliased, as a hard-linked package source is (D01).
  refused('docs/a.md', 'IA-DB-PATH-UNSAFE', 'Expected an unaliased regular file: docs/a.md', 'docs/a.md');
  refused(
    'linked/secret.md',
    'IA-DB-PATH-UNSAFE',
    'Symlink/junction traversal is not admitted: linked/secret.md',
    'linked/secret.md',
  );
  refused('docs', 'IA-DB-PATH-UNSAFE', 'Expected an unaliased regular file: docs', 'docs');
  // An escape has no canonical path, so its refusal carries none and names the path only as given.
  expect(thrown('../escape.md')).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    message: expect.stringMatching(/^IA-DB-PATH-UNSAFE: Unsafe workspace path '\.\.\/escape\.md': /),
  });
  expect(thrown('../escape.md').path).toBeUndefined();
  refused('docs/absent.md', 'IA-DB-SOURCE-UNAVAILABLE', 'Missing file docs/absent.md', 'docs/absent.md');
  // A path through a file is missing on every platform, ENOTDIR on POSIX as ENOENT on Windows.
  refused('docs/b.md/x.md', 'IA-DB-SOURCE-UNAVAILABLE', 'Missing file docs/b.md/x.md', 'docs/b.md/x.md');
  // The distribution workspace file reader's portable path rule, which `ia read` reads through, refuses these too.
  for (const path of [
    'docs/café.md',
    'docs/b.md:hidden',
    'docs/a<b.md',
    'docs/a\u0000b.md',
    'docs/b.md.',
    'docs/b.md ',
    'docs/aux.md',
    'docs/COM1',
    `docs/${'a'.repeat(1021)}`,
  ])
    refused(path, 'IA-DB-PATH-UNSAFE', `Nonportable workspace path: ${path}`, path);
  expect(() => readWorkspaceBytes(root, 'docs/b.md', 3)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE', path: 'docs/b.md' }),
  );
  expect(() => readWorkspaceBytes(root, 'docs/b.md', 3)).toThrow('File exceeds 3 bytes: docs/b.md');
  expect(() => readWorkspaceBytes(root, 'docs/b.md', -1)).toThrow(TypeError);
  expect(() => readWorkspaceBytes(resolve(root, 'absent'), 'docs/b.md', 4)).toThrow(
    expect.objectContaining({ code: 'IA-DB-ROOT-INVALID' }),
  );
  rmSync(resolve(root, 'docs/second.md'));
  expect(Buffer.from(readWorkspaceBytes(root, 'docs/a.md', bytes.length))).toEqual(bytes);
  expect(readFileSync(resolve(outside, 'secret.md'), 'utf8')).toBe('# Secret\n');
});
it('reads the actual native source tree with local floor and every system directory', () => {
  const root = workspace();
  cpSync(resolve(import.meta.dirname, '../../..', '.ia/src'), resolve(root, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  const snapshot = readInputs(root);
  expect(snapshot.floorOrigin).toBe('local');
  expect(snapshot.folders).toHaveLength(11);
  for (const folder of [
    'agent-composition-system',
    'workspace-system',
    'authoring-system',
    'hook-authoring-system',
    'learning-system',
    'work-system',
  ])
    expect(snapshot.folders).toContain(folder);
  expect(
    snapshot.sources.every((s) => s.location.placement.band === (s.path.startsWith('.ia/src/floor/') ? 10 : 100)),
  ).toBe(true);
});
it('refuses nonexistent workspaces and ordinary files', () => {
  const root = workspace();
  put(root, 'file', 'x');
  for (const path of ['absent', 'file'])
    expect(() => readInputs(resolve(root, path))).toThrow(expect.objectContaining({ code: 'IA-DB-ROOT-INVALID' }));
});
it('excludes package artifacts without weakening authored alias refusal', () => {
  const root = workspace(),
    outside = workspace();
  put(root, '.ia/src/work.ia', '#! ia 1.0\n');
  put(root, '.ia/src/systems/example/dist/generated.ia', 'not source');
  put(outside, 'dependency.ia', 'not source');
  symlinkSync(
    outside,
    resolve(root, '.ia/src/systems/example/node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const captured = readInputs(root);
  expect(captured.sources.filter((s) => s.path.includes('systems/example'))).toEqual([]);
  symlinkSync(
    outside,
    resolve(root, '.ia/src/systems/example/records'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => readInputs(root)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
});
it('compares paths by what the volume opens, not by how they are spelled (#315)', () => {
  // APFS folds case and Unicode normalization, NTFS folds case: there the other spellings open the same directory.
  const root = workspace(),
    dir = resolve(root, 'Caf\u00e9 Dir'),
    file = resolve(dir, 'a.txt');
  put(root, 'Caf\u00e9 Dir/a.txt', 'x');
  const upper = resolve(root, 'CAF\u00c9 DIR'),
    decomposed = resolve(root, 'Cafe\u0301 Dir'),
    link = resolve(root, 'link');
  expect(sameFile(dir, dir)).toBe(true);
  expect(sameFile(resolve(root, 'missing'), dir)).toBe(false);
  for (const spelling of [upper, decomposed]) {
    expect(sameFile(spelling, dir)).toBe(existsSync(spelling));
    expect(within(dir, resolve(spelling, 'new', 'child.txt'))).toBe(existsSync(spelling));
    if (existsSync(spelling)) expect(unaliased(spelling, realpathSync.native(spelling))).toBe(true);
  }
  expect(within(root, resolve(upper, 'new'))).toBe(true);
  expect(within(dir, root)).toBe(false);
  // A parent that does not exist yet compares by the settled spellings, folded as the volume folds names.
  expect(within(resolve(root, 'missing'), resolve(root, 'missing', 'child'))).toBe(true);
  expect(within(resolve(root, 'missing'), resolve(root, 'other'))).toBe(false);
  // A link is still an alias, wherever it sits; a name that does not exist yet is not a link.
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(linked(resolve(link, 'a.txt'))).toBe(true);
  expect(linked(file)).toBe(false);
  expect(linked(resolve(root, 'missing', 'x'))).toBe(false);
  expect(unaliased(link, realpathSync.native(link))).toBe(false);
  expect(sameFile(link, dir)).toBe(true);
  // Windows opens a path spelled with forward slashes as the same file.
  expect(unaliased(file.replaceAll('\\', '/'), realpathSync.native(file))).toBe(true);
  // A junction whose name folds onto its sibling's only by the string fold (Kelvin `K`, which NTFS keeps apart from `k`)
  // is still a link. APFS opens the two names as one, so there the link cannot be made beside `k`.
  const kelvin = resolve(root, 'K');
  mkdirSync(resolve(root, 'k'));
  let made = true;
  try {
    symlinkSync(resolve(root, 'k'), kelvin, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    made = false;
  }
  expect(made || process.platform === 'darwin').toBe(true);
  if (made) {
    expect(linked(kelvin)).toBe(true);
    expect(unaliased(kelvin, realpathSync.native(kelvin))).toBe(false);
  }
  // Keys of paths that may not exist fold where volumes fold by default.
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  expect(pathKey('Docs/Caf\u00e9.md')).toBe(folds ? 'docs/caf\u00e9.md' : 'Docs/Caf\u00e9.md');
  expect(pathKey('cafe\u0301')).toBe(process.platform === 'darwin' ? 'caf\u00e9' : 'cafe\u0301');
});
it('folds names as APFS compares them, refuses a spelling the kernel walks through a link, and never throws for identity (#323)', () => {
  // APFS folds full Unicode case, so each pair is one name there; the darwin key agrees, and names it keeps apart stay apart.
  for (const [a, b] of [
    ['cla\u00df', 'CLASS'],
    ['\u017frc', 'src'],
    ['\ufb01le', 'FILE'],
    ['stra\u00dfe', 'STRASSE'],
    ['\u03c2', '\u03a3'],
    ['\u1e9e', 'ss'],
  ] as const) {
    expect(caseFold(a)).toBe(caseFold(b));
    expect(pathKey(a) === pathKey(b)).toBe(process.platform === 'darwin');
  }
  expect(caseFold('\u00b2')).not.toBe(caseFold('2'));
  expect(caseFold('\uff41')).not.toBe(caseFold('a'));
  // APFS keeps the dotless `\u0131` apart from `i` and `I`, so `kap\u0131.ia` and `kapi.ia` are two sources there.
  expect(caseFold('kap\u0131')).not.toBe(caseFold('kapi'));
  expect(caseFold('\u0131')).not.toBe(caseFold('I'));
  expect(caseFold('KAP\u0131')).toBe(caseFold('kap\u0131'));
  const root = workspace();
  put(root, 'class/inner/a.txt', 'x');
  if (existsSync(resolve(root, 'cla\u00df')))
    expect(sameFile(resolve(root, 'cla\u00df'), resolve(root, 'CLASS'))).toBe(true);
  // `hop/..` is collapsed by resolve() but walked through the link by a POSIX kernel, so it is not an unaliased spelling there;
  // win32 collapses it before the volume sees it, so there it names the directory it opens.
  symlinkSync(resolve(root, 'class/inner'), resolve(root, 'hop'), process.platform === 'win32' ? 'junction' : 'dir');
  const dotted = `${resolve(root, 'hop')}${sep}..`;
  if (process.platform !== 'win32')
    expect(realpathSync.native(dotted)).toBe(realpathSync.native(resolve(root, 'class')));
  expect(unaliased(dotted, realpathSync.native(dotted))).toBe(process.platform === 'win32');
  // A path that cannot be examined is the same only as another spelling of itself.
  if (process.platform !== 'win32') {
    const loop = resolve(root, 'loop');
    symlinkSync(loop, loop);
    expect(sameFile(loop, loop)).toBe(true);
    expect(sameFile(loop, resolve(root, 'class'))).toBe(false);
  }
});
it('reads a systems folder spelled in another case as the systems folder where the volume folds case (#315)', () => {
  const root = workspace();
  put(root, '.ia/src/Systems/demo-system/records/a.ia', '#! ia 1.0\n');
  const paths = readInputs(root)
    .sources.map((s) => s.path)
    .filter((path) => path.endsWith('/a.ia'));
  // Renamed only where the key folds and the volume opens `systems` as `Systems`: a case-sensitive APFS volume reads it as it is.
  const folds = pathKey('Systems') === 'systems' && existsSync(resolve(root, '.ia/src/systems'));
  expect(paths).toEqual([
    folds ? '.ia/src/systems/demo-system/records/a.ia' : '.ia/src/Systems/demo-system/records/a.ia',
  ]);
});

it.each(['replace', 'hardlink', 'parent'] as const)(
  'refuses a %s race after opening a workspace document before reading bytes',
  async (change) => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = workspace(),
      file = resolve(root, 'docs/body.md');
    put(root, 'docs/body.md', 'body');
    let opened: number | undefined;
    vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]) === file) {
        opened = fd;
        if (change === 'hardlink') linkSync(file, resolve(root, 'alias.md'));
        else if (change === 'replace') {
          renameSync(file, resolve(root, 'original.md'));
          put(root, 'docs/body.md', 'other');
        } else {
          // Windows permits renaming an open file but not its containing directory. Move the file aside first,
          // replace the now-empty parent, then restore the same inode: only the directory identity differs.
          renameSync(file, resolve(root, 'held.md'));
          renameSync(resolve(root, 'docs'), resolve(root, 'original-docs'));
          mkdirSync(resolve(root, 'docs'));
          renameSync(resolve(root, 'held.md'), file);
        }
      }
      return fd;
    });
    vi.mocked(readSync).mockClear();
    vi.mocked(closeSync).mockClear();
    expect(() => readWorkspaceBytes(root, 'docs/body.md', 16)).toThrow(
      expect.objectContaining({
        code: change === 'hardlink' ? 'IA-DB-PATH-UNSAFE' : 'IA-DB-SOURCE-CHANGED',
        path: 'docs/body.md',
      }),
    );
    expect(opened).toBeTypeOf('number');
    expect(readSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledWith(opened);
  },
);
it('bounds a growing workspace document and refuses bytes modified during reading', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const root = workspace(),
    file = resolve(root, 'docs/body.md');
  put(root, 'docs/body.md', 'body');
  let read = 0,
    calls = 0;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = actual.readSync(...args);
    read += count;
    if (++calls === 1) appendFileSync(file, 'x'.repeat(1_000_000));
    return count;
  });
  expect(() => readWorkspaceBytes(root, 'docs/body.md', 16)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SOURCE-CHANGED', path: 'docs/body.md' }),
  );
  expect(read).toBeLessThanOrEqual(5);
});
