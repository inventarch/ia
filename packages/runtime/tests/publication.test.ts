import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPublication, portableDraftPath, preparePublication } from '../src/publication.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
  };
});
afterEach(() => {
  vi.mocked(lstatSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(readSync).mockReset();
});
/**
 * Makes opening `path` fail as an unreadable file's open does, while its name can still be examined: Windows has no
 * file mode that denies reading it.
 */
const unopenable = async (path: string): Promise<void> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    if (String(args[0]) === path)
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: 'EACCES',
        syscall: 'open',
        path,
      });
    return actual.openSync(...args);
  });
};
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-'));
  roots.push(root);
  return root;
};
const destination = '.ia/work/generated/draft',
  files = [{ path: 'nested/draft.ia', text: 'Exact draft\n' }],
  metadata = '{"invocation":"one"}\n';
const current = async () => {};
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !/^ia-publication-[\w-]+$/.test(path)) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  '../escape',
  '/absolute',
  'C:/root',
  'a\\b',
  'a//b',
  'NUL.txt',
  'COM¹',
  'trailing.',
  'trailing ',
  'result.json/a',
  'e\u0301',
  '\ud800',
])('refuses nonportable draft path %s', (path) => {
  expect(() => portableDraftPath(path)).toThrow(expect.objectContaining({ code: 'IA-PUBLICATION-PATH-UNSAFE' }));
});
it('refuses unqualified filesystem roots', () => {
  expect(() => preparePublication('\\\\unqualified\\share', destination, files, metadata)).toThrow(
    expect.objectContaining({ code: 'IA-PUBLICATION-UNAVAILABLE' }),
  );
});
describe.skipIf(process.platform !== 'win32')('qualified local NTFS publication', () => {
  it.each(['timeout', 'invalid-json', 'remote', 'non-ntfs'] as const)(
    'refuses %s volume qualification without creating output or caching failure',
    async (failure) => {
      vi.resetModules();
      const root = temp();
      const probe = vi.fn(() => {
        if (failure === 'timeout')
          throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return failure === 'invalid-json'
          ? '{'
          : JSON.stringify({
              DriveType: failure === 'remote' ? 4 : 3,
              FileSystem: failure === 'non-ntfs' ? 'FAT32' : 'NTFS',
            });
      });
      vi.doMock('node:child_process', () => ({ execFileSync: probe }));
      try {
        const { preparePublication: prepare } = await import('../src/publication.js');
        for (let attempt = 0; attempt < 2; attempt++)
          expect(() => prepare(root, destination, files, metadata)).toThrow(
            expect.objectContaining({ code: 'IA-PUBLICATION-UNAVAILABLE' }),
          );
        expect(probe).toHaveBeenCalledTimes(2);
        expect(probe).toHaveBeenCalledWith(
          'powershell.exe',
          expect.any(Array),
          expect.objectContaining({ timeout: 30_000, windowsHide: true }),
        );
        expect(existsSync(resolve(root, '.ia'))).toBe(false);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    },
  );
  // The first publication includes the bounded 30s cold external NTFS probe;
  // leave time for publication assertions and cleanup after qualification.
  it('publishes exact bytes and inventory only after an exclusive final directory claim', async () => {
    const root = temp(),
      prepared = preparePublication(root, destination, files, metadata);
    try {
      expect(existsSync(resolve(root, destination))).toBe(false);
      expect(prepared.publish()).toBe(destination);
      expect(readFileSync(resolve(root, destination, files[0]!.path), 'utf8')).toBe(files[0]!.text);
      expect(readFileSync(resolve(root, destination, 'result.json'), 'utf8')).toBe(metadata);
      expect(() => prepared.publish()).toThrow();
    } finally {
      prepared.close();
      prepared.close();
    }
    expect(readdirSync(resolve(root, '.ia/work/generated'))).toEqual(['draft']);
    expect(await inspectPublication(root, destination, files, metadata, current)).toBe('applied');
    expect(() => preparePublication(root, destination, files, metadata)).toThrow(
      expect.objectContaining({ code: 'IA-PUBLICATION-CONFLICT' }),
    );
  }, 60_000);
  it('distinguishes absence, partial bytes, different provenance and tampering', async () => {
    const root = temp(),
      inspect = () => inspectPublication(root, destination, files, metadata, current);
    expect(await inspect()).toBe('absent');
    mkdirSync(resolve(root, destination), { recursive: true });
    expect(await inspect()).toBe('partial');
    writeFileSync(resolve(root, destination, 'result.json'), '{}');
    expect(await inspect()).toBe('unknown');
    writeFileSync(resolve(root, destination, 'result.json'), metadata);
    expect(await inspect()).toBe('partial');
    mkdirSync(resolve(root, destination, 'nested'));
    writeFileSync(resolve(root, destination, files[0]!.path), files[0]!.text);
    expect(await inspect()).toBe('applied');
    writeFileSync(resolve(root, destination, files[0]!.path), 'changed');
    expect(await inspect()).toBe('partial');
    writeFileSync(resolve(root, destination, files[0]!.path), files[0]!.text);
    mkdirSync(resolve(root, destination, 'extra'));
    expect(await inspect()).toBe('partial');
  });
  it('reads the marker as a regular file within 2 MiB and each file at its exact size, of any link count', async () => {
    const root = temp(),
      marker = resolve(root, destination, 'result.json'),
      file = resolve(root, destination, files[0]!.path),
      inspect = (expected = metadata) => inspectPublication(root, destination, files, expected, current);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(file, files[0]!.text);
    // A directory in the marker's place is unknown.
    mkdirSync(marker);
    expect(await inspect()).toBe('unknown');
    rmSync(marker, { recursive: true });
    // A marker at the 2 MiB bound is read; one byte past it is unknown.
    const bound = 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(marker, bound);
    expect(await inspect(bound)).toBe('applied');
    writeFileSync(marker, `${bound}x`);
    expect(await inspect(bound)).toBe('unknown');
    // Publication links its files into place, so a second name aliases neither the marker nor a file.
    writeFileSync(marker, metadata);
    linkSync(marker, resolve(root, 'marker'));
    linkSync(file, resolve(root, 'draft'));
    expect(await inspect()).toBe('applied');
    // A file one byte longer, or of its size with other bytes, is partial.
    writeFileSync(file, `${files[0]!.text}x`);
    expect(await inspect()).toBe('partial');
    writeFileSync(file, files[0]!.text.toLowerCase());
    expect(await inspect()).toBe('partial');
    // A junction in the marker's place is refused, never followed.
    rmSync(marker);
    symlinkSync(temp(), marker, 'junction');
    await expect(inspect()).rejects.toMatchObject({
      code: 'IA-PUBLICATION-PATH-UNSAFE',
      message: 'Filesystem aliases are unsupported',
    });
  });
  it('does not take a marker or a file whose name passes to another file while it is read as the published one', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = temp(),
      marker = resolve(root, destination, 'result.json'),
      file = resolve(root, destination, files[0]!.path),
      inspect = () => inspectPublication(root, destination, files, metadata, current);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(file, files[0]!.text);
    writeFileSync(marker, metadata);
    expect(await inspect()).toBe('applied');
    // Once `path` is opened, its name passes to a copy of the same bytes; the opened file moves out of the destination.
    const replace = (path: string, aside: string): void => {
      vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
        const fd = actual.openSync(...args);
        if (String(args[0]) === path) {
          actual.renameSync(path, resolve(root, aside));
          actual.writeFileSync(path, actual.readFileSync(resolve(root, aside)));
        }
        return fd;
      });
    };
    replace(marker, 'marker');
    expect(await inspect()).toBe('unknown');
    replace(file, 'draft');
    expect(await inspect()).toBe('partial');
    vi.mocked(openSync).mockReset();
    expect(await inspect()).toBe('applied');
  });
  it('reads no byte of a marker past 2 MiB, and does not take one cut to the published bytes while read', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = temp(),
      marker = resolve(root, destination, 'result.json'),
      inspect = () => inspectPublication(root, destination, files, metadata, current);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(resolve(root, destination, files[0]!.path), files[0]!.text);
    writeFileSync(marker, 'x'.repeat(2 * 1024 * 1024 + 1));
    vi.mocked(readSync).mockClear();
    expect(await inspect()).toBe('unknown');
    expect(readSync).not.toHaveBeenCalled();
    // Before its first read, the marker is cut back to exactly the published bytes: it changed while read.
    writeFileSync(marker, `${metadata}trailing bytes`);
    let calls = 0;
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      if (++calls === 1) actual.truncateSync(marker, Buffer.byteLength(metadata));
      return actual.readSync(...args);
    });
    expect(await inspect()).toBe('unknown');
    vi.mocked(readSync).mockReset();
    expect(await inspect()).toBe('applied');
  });
  it('judges a marker or a file that cannot be opened by its name: unknown past 2 MiB or as a directory, partial at another size', async () => {
    const root = temp(),
      marker = resolve(root, destination, 'result.json'),
      file = resolve(root, destination, files[0]!.path),
      inspect = () => inspectPublication(root, destination, files, metadata, current);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(file, files[0]!.text);
    await unopenable(marker);
    writeFileSync(marker, 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(await inspect()).toBe('unknown');
    rmSync(marker);
    mkdirSync(marker);
    expect(await inspect()).toBe('unknown');
    rmSync(marker, { recursive: true });
    writeFileSync(marker, metadata);
    writeFileSync(file, `${files[0]!.text}x`);
    await unopenable(file);
    expect(await inspect()).toBe('partial');
  });
  it('throws the open error of a marker within 2 MiB, or of a file of its expected size, that cannot be opened', async () => {
    const root = temp(),
      marker = resolve(root, destination, 'result.json'),
      file = resolve(root, destination, files[0]!.path),
      inspect = () => inspectPublication(root, destination, files, metadata, current);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(file, files[0]!.text);
    writeFileSync(marker, metadata);
    await unopenable(marker);
    await expect(inspect()).rejects.toMatchObject({
      code: 'EACCES',
      message: `EACCES: permission denied, open '${marker}'`,
    });
    await unopenable(file);
    await expect(inspect()).rejects.toMatchObject({
      code: 'EACCES',
      message: `EACCES: permission denied, open '${file}'`,
    });
  });
  it('throws for a file that vanishes after it is listed, with the error of the lstat that finds it gone', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = temp(),
      file = resolve(root, destination, files[0]!.path);
    mkdirSync(resolve(root, destination, 'nested'), { recursive: true });
    writeFileSync(file, files[0]!.text);
    writeFileSync(resolve(root, destination, 'result.json'), metadata);
    let removed = false;
    vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
      const stat = actual.lstatSync(...args);
      // The walk's own check of the listed name (safe) still finds the file; after it, the file is gone.
      if (!removed && String(args[0]) === file) {
        removed = true;
        actual.rmSync(file);
      }
      return stat;
    });
    await expect(inspectPublication(root, destination, files, metadata, current)).rejects.toMatchObject({
      code: 'ENOENT',
      message: `ENOENT: no such file or directory, lstat '${file}'`,
    });
  });
  it('refuses a second destination owner, preexisting empty directories, and a late destination race', () => {
    const root = temp(),
      prepared = preparePublication(root, destination, files, metadata);
    try {
      expect(() => preparePublication(root, destination, files, metadata)).toThrow(
        expect.objectContaining({ code: 'IA-PUBLICATION-BUSY' }),
      );
      mkdirSync(resolve(root, destination));
      expect(() => prepared.publish()).toThrow(expect.objectContaining({ code: 'IA-PUBLICATION-CONFLICT' }));
      expect(readdirSync(resolve(root, destination))).toEqual([]);
    } finally {
      prepared.close();
    }
    expect(() => preparePublication(root, destination, files, metadata)).toThrow(
      expect.objectContaining({ code: 'IA-PUBLICATION-CONFLICT' }),
    );
  });
  it('checks current authority under the inspection lock and releases on refusal', async () => {
    const root = temp();
    await expect(
      inspectPublication(root, destination, files, metadata, async () => {
        throw new Error('revoked');
      }),
    ).rejects.toThrow('revoked');
    expect(await inspectPublication(root, destination, files, metadata, current)).toBe('absent');
  });
  it('refuses bounds, case and file/directory collisions before staging', () => {
    const root = temp();
    for (const entries of [
      [],
      Array(17).fill(files[0]),
      [{ path: 'a', text: 'x'.repeat(1024 * 1024 + 1) }],
      [{ path: 'a', text: '\ud800' }],
    ])
      expect(() => preparePublication(root, destination, entries, metadata)).toThrow(
        expect.objectContaining({ code: 'IA-PUBLICATION-INVALID' }),
      );
    for (const paths of [['a', 'A'], ['a/b', 'a'], ['result.json'], ['../escape']])
      expect(() =>
        preparePublication(
          root,
          destination,
          paths.map((path) => ({ path, text: '' })),
          metadata,
        ),
      ).toThrow(expect.objectContaining({ code: 'IA-PUBLICATION-PATH-UNSAFE' }));
    expect(existsSync(resolve(root, '.ia'))).toBe(false);
  });
  it('refuses junction ancestors without touching their destination', () => {
    const root = temp(),
      outside = temp();
    mkdirSync(resolve(root, '.ia'));
    symlinkSync(outside, resolve(root, '.ia/work'), 'junction');
    expect(() => preparePublication(root, destination, files, metadata)).toThrow(
      expect.objectContaining({ code: 'IA-PUBLICATION-PATH-UNSAFE' }),
    );
    expect(readdirSync(outside)).toEqual([]);
  });
  it('holds destination ownership across processes and releases it on actual process death', async () => {
    const root = temp(),
      module = new URL('../dist/publication.js', import.meta.url).href;
    const source = `import {preparePublication} from ${JSON.stringify(module)}; const held=preparePublication(process.argv[1], ${JSON.stringify(destination)}, ${JSON.stringify(files)}, ${JSON.stringify(metadata)}); process.send('owned'); setInterval(()=>{ if(!held.publish) process.exit(1); },1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      timeout: 45_000,
      killSignal: 'SIGKILL',
    });
    try {
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error('Child exited before ownership');
        }),
      ]);
      await expect(inspectPublication(root, destination, files, metadata, current)).rejects.toMatchObject({
        code: 'IA-PUBLICATION-BUSY',
      });
      expect(() => preparePublication(root, destination, files, metadata)).toThrow(
        expect.objectContaining({ code: 'IA-PUBLICATION-BUSY' }),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    expect(await inspectPublication(root, destination, files, metadata, current)).toBe('absent');
    const prepared = preparePublication(root, destination, files, metadata);
    try {
      prepared.publish();
    } finally {
      prepared.close();
    }
    expect(await inspectPublication(root, destination, files, metadata, current)).toBe('applied');
  }, 60_000);
});
