import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { json, sha256 } from '../src/files.js';
import { assertHomeOutsideWorkspace, legacyHostHome, materializeHostPayload, readHostPin } from '../src/host-home.js';
import { HOST_TREE_LIMITS, packTree, unpackTree } from '../src/ustar.js';

vi.mock('node:fs', { spy: true });
const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-host-home-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
function payload() {
  const content = 'payload\n',
    inventory = json({
      format: 'ia.host-cache.v2',
      version: '0.1.0',
      packages: [],
      files: [{ path: 'payload.txt', bytes: 8, sha256: sha256(content) }],
    });
  const launcher = '// launcher\n',
    release = json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) });
  const archive = packTree(
    new Map([
      ['payload.txt', Buffer.from(content)],
      ['inventory.json', Buffer.from(inventory)],
      ['scripts/ia.mjs', Buffer.from(launcher)],
      ['release.json', Buffer.from(release)],
    ]),
    HOST_TREE_LIMITS,
  );
  return { archive, pin: { release: sha256(release), archive: sha256(archive), files: 4, bytes: 0 } };
}
it('keeps the M5.3 per-OS directory only as the legacy location', () => {
  expect(legacyHostHome({ XDG_DATA_HOME: '/d' }, 'linux', '/home/u')).toBe(join('/d', 'ia'));
  expect(legacyHostHome({}, 'linux', '/home/u')).toBe(join('/home/u', '.local/share', 'ia'));
  expect(legacyHostHome({}, 'darwin', '/Users/u')).toBe(join('/Users/u', 'Library/Application Support', 'ia'));
  expect(legacyHostHome({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(join('C:\\L', 'ia'));
});
it('materializes once, reuses a verified copy and refuses a corrupt one, naming the directory, without overwriting', () => {
  const home = temp(),
    { archive, pin } = payload();
  const first = materializeHostPayload({ home, archive, pin });
  expect(first).toMatchObject({ reused: false, release: pin.release, directory: join(home, 'hosts', pin.release) });
  expect(materializeHostPayload({ home, archive, pin }).reused).toBe(true);
  writeFileSync(join(first.directory, 'payload.txt'), 'changed!');
  let caught: unknown;
  try {
    materializeHostPayload({ home, archive, pin });
  } catch (error) {
    caught = error;
  }
  expect((caught as Error).message).toMatch(/Host payload changed/);
  expect((caught as Error).message).toContain(first.directory);
  expect((caught as { code?: string }).code).toBe('IA-DIST-INTEGRITY-MISMATCH');
  expect(readFileSync(join(first.directory, 'payload.txt'), 'utf8')).toBe('changed!');
});
it('refuses an archive that does not match its pin before writing', () => {
  const home = temp(),
    { archive, pin } = payload();
  expect(() => materializeHostPayload({ home, archive, pin: { ...pin, archive: '0'.repeat(64) } })).toThrow(
    /differs from its pin/,
  );
  expect(() => materializeHostPayload({ home, archive, pin: { ...pin, release: '0'.repeat(64) } })).toThrow(
    /differs from its pin/,
  );
});
it('validates the pin shape before deriving a path or touching the filesystem', () => {
  const home = temp(),
    { archive, pin } = payload();
  expect(() => materializeHostPayload({ home, archive, pin: { ...pin, release: 'z'.repeat(64) } })).toThrow(
    /Invalid host payload pin/,
  );
  expect(() => materializeHostPayload({ home, archive, pin: { ...pin, archive: 'nothex' } })).toThrow(
    /Invalid host payload pin/,
  );
  expect(existsSync(join(home, 'hosts'))).toBe(false);
});
it('returns reused: true when another process wins the extraction race', () => {
  const home = temp(),
    { archive, pin } = payload();
  // Pre-mark the home so ensureIaHome's own atomic write doesn't consume the renameSync mock meant for the payload race.
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'home.json'), JSON.stringify({ schema: 'ia.home.v1' }) + '\n');
  const target = join(home, 'hosts', pin.release),
    tree = unpackTree(archive, HOST_TREE_LIMITS);
  vi.mocked(renameSync).mockImplementationOnce(() => {
    for (const [path, bytes] of tree) {
      const file = join(target, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  });
  const result = materializeHostPayload({ home, archive, pin });
  expect(result).toMatchObject({ reused: true, release: pin.release, directory: target });
});
it('refuses a home containing src/ and writes nothing into hosts/', () => {
  const home = temp(),
    { archive, pin } = payload();
  mkdirSync(join(home, 'src'), { recursive: true });
  let caught: unknown;
  try {
    materializeHostPayload({ home, archive, pin });
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe('IA-DIST-PATH-UNSAFE');
  expect(existsSync(join(home, 'hosts'))).toBe(false);
});
it('refuses a workspace inside the host home and a host home inside the workspace', () => {
  const base = temp(),
    home = join(base, 'home'),
    root = join(base, 'workspace');
  mkdirSync(root);
  expect(() => assertHomeOutsideWorkspace(home, root)).not.toThrow();
  for (const [h, r] of [
    [base, root],
    [join(root, 'data', 'ia'), root],
    [root, root],
  ] as const) {
    let caught: unknown;
    try {
      assertHomeOutsideWorkspace(h, r);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code, `${h} ${r}`).toBe('IA-DIST-PATH-UNSAFE');
  }
});
it('refuses a home and a workspace that nest under another spelling wherever the volume opens it as the same directory', () => {
  // APFS and NTFS fold case (#315): there `WORKSPACE` is the workspace and `HOME` the home, so each nests in the other;
  // on a volume that keeps them apart they are other, unrelated directories.
  const base = temp(),
    home = join(base, 'home'),
    root = join(base, 'workspace');
  mkdirSync(home);
  mkdirSync(root);
  for (const [h, r, spelled] of [
    [join(base, 'WORKSPACE', 'ia'), root, join(base, 'WORKSPACE')],
    [home, join(base, 'HOME', 'repo'), join(base, 'HOME')],
  ] as const) {
    let caught: unknown;
    try {
      assertHomeOutsideWorkspace(h, r);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code, `${h} ${r}`).toBe(
      existsSync(spelled) ? 'IA-DIST-PATH-UNSAFE' : undefined,
    );
  }
});
it('reads a well-formed host pin and refuses a missing pin or archive as unavailable', () => {
  const pkg = temp(),
    { archive, pin } = payload();
  const code = (run: () => unknown): string | undefined => {
    try {
      run();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };
  expect(code(() => readHostPin(pkg))).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  mkdirSync(join(pkg, 'assets/host'), { recursive: true });
  writeFileSync(join(pkg, 'assets/host.json'), JSON.stringify(pin));
  expect(code(() => readHostPin(pkg))).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  writeFileSync(join(pkg, 'assets/host', `${pin.archive}.tgz`), archive);
  const read = readHostPin(pkg);
  expect(read.pin).toEqual(pin);
  expect(read.archive().equals(archive)).toBe(true);
  writeFileSync(join(pkg, 'assets/host.json'), JSON.stringify({ ...pin, extra: 1 }));
  expect(code(() => readHostPin(pkg))).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
});
