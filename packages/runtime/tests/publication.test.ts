import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPublication, portableDraftPath, preparePublication } from '../src/publication.js';

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
