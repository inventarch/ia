import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { runBounded } from '../testing/subprocess.js';

// The script runs as a release qualification runs it, against archives built here, with qualify-sdk-fixture.mjs
// preloaded to stub its release, receipt and language manifest readers, record what it hands to tar and race one archive.
// No network, registry or real install is involved: the pnpm launcher is a Node script that installs nothing.
const script = realpathSync(fileURLToPath(new URL('./qualify-sdk.mjs', import.meta.url)));
const preload = pathToFileURL(realpathSync(fileURLToPath(new URL('./qualify-sdk-fixture.mjs', import.meta.url)))).href;
const bound = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 60_000;
const settle = bound + 10_000;
const version = '9.9.9';
const names = ['language', 'graph', 'compliance', 'db', 'runtime', 'workspace-runtime'];
const archiveName = (name: string) => `inventarch-${name}-${version}.tgz`;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** A gzipped ustar archive of `package/package.json` and `package/index.js`, the layout of a packed npm package. */
function packed(manifest: object, index = 'export {};\n'): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of [
    ['package/package.json', JSON.stringify(manifest)],
    ['package/index.js', index],
  ] as const) {
    const body = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    // The checksum counts its own field as eight spaces.
    header.write('        ', 148);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
    );
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
interface Options {
  /** Fields replacing those of a package's packed manifest. */
  readonly manifests?: Readonly<Record<string, object>>;
  /** The db archive's name as a link to the archive moved elsewhere. */
  readonly link?: 'hard' | 'symbolic';
  /** A change to the db archive at the named moment of its reading, as qualify-sdk-fixture.mjs makes it. */
  readonly race?: { readonly at: 'open' | 'read' | 'tar'; readonly change: string };
}
interface Pin {
  readonly package: string;
  readonly archive: string;
  readonly sha256: string;
}
async function qualify(options: Options = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-qualify-sdk-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    const put = (path: string, content: string | Buffer) => {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), content);
    };
    // The candidate supplies the release version, the native sources and the programs the script copies and runs.
    put('candidate/releases/current.json', JSON.stringify({ version }));
    const tests = 'candidate/.ia/src/systems/agent-composition-system/tests';
    for (const program of [
      `${tests}/sdk-runtime/recipe.mjs`,
      `${tests}/installed-read-fixture.mjs`,
      `${tests}/spec-read-boundary-fixture.mjs`,
      'candidate/packages/workspace-runtime/tests/public-spec-fixture.mjs',
    ])
      put(program, 'console.log("{}");\n');
    for (const file of ['system.ia.fixture', 'records.ia.fixture', 'read.ia.fixture'])
      put(`${tests}/sdk-runtime/native/${file}`, '');
    // The pnpm launcher installs nothing: it prints the digest of each archive at the path the install names.
    put(
      'pnpm.mjs',
      [
        "import { createHash } from 'node:crypto';",
        "import { readFileSync } from 'node:fs';",
        "const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8'));",
        'const digest = (spec) => createHash("sha256").update(readFileSync(spec.slice("file:".length))).digest("hex");',
        'console.log(JSON.stringify(Object.fromEntries(Object.entries(dependencies).map(([name, spec]) => [name, digest(spec)]))));',
        '',
      ].join('\n'),
    );
    const bytes: Record<string, Buffer> = {};
    for (const name of names) {
      bytes[name] = packed({
        name: `@inventarch/${name}`,
        version,
        dependencies: name === 'runtime' ? { '@inventarch/db': version } : {},
        ...options.manifests?.[name],
      });
      put(`archives/${archiveName(name)}`, bytes[name]);
    }
    const db = resolve(root, 'archives', archiveName('db')),
      replacement = packed({ name: '@inventarch/db', version }, 'export const replaced = true;\n');
    put('replacement.tgz', replacement);
    if (options.link) {
      renameSync(db, resolve(root, 'elsewhere.tgz'));
      if (options.link === 'hard') linkSync(resolve(root, 'elsewhere.tgz'), db);
      else symlinkSync(resolve(root, 'elsewhere.tgz'), db, 'file');
    }
    const log = resolve(root, 'tar.jsonl');
    put(
      'fixture.json',
      JSON.stringify({
        log,
        packages: names.map((name) => ({ name: `@inventarch/${name}`, version, filename: archiveName(name) })),
        ...(options.race ? { race: { ...options.race, path: db, replacement: resolve(root, 'replacement.tgz') } } : {}),
      }),
    );
    const output = resolve(root, 'output');
    const run = await runBounded(
      process.execPath,
      [
        '--import',
        preload,
        script,
        resolve(root, 'candidate'),
        resolve(root, 'archives'),
        output,
        resolve(root, 'pnpm.mjs'),
        resolve(root, 'store'),
      ],
      { cwd: root, timeoutMs: bound, env: { ...process.env, IA_QUALIFY_FIXTURE: resolve(root, 'fixture.json') } },
    );
    expect(run.timedOut).toBe(false);
    const read = (path: string) => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined);
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      bytes,
      replacement,
      archives: resolve(root, 'archives'),
      /** Each buffer handed to tar, in order. */
      tar: existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { args: string[]; sha256: string; bytes: number })
        : [],
      pins: (read(resolve(output, 'qualification.json')) as { archives: Pin[] } | undefined)?.archives,
      dependencies: (read(resolve(output, 'package.json')) as { dependencies: Record<string, string> } | undefined)
        ?.dependencies,
      /** The digest of each archive at the path the install names, as the install read it. */
      installed: read(resolve(output, 'install.log')) as Record<string, string> | undefined,
      /** The digest of the bytes at the db archive's name after the run, while it is a regular file. */
      dbAfter: lstatSync(db, { throwIfNoEntry: false })?.isFile() ? sha256(readFileSync(db)) : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const tarArgs = ['-xzOf', '-', 'package/package.json'];
const handed = (bytes: Buffer) => ({ args: tarArgs, sha256: sha256(bytes), bytes: bytes.length });

it(
  'pins exactly the bytes it checked and handed tar, read once through the descriptor of each selected archive',
  async () => {
    const run = await qualify();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ archives: names.length, paidProviderCalls: 0, passed: true });
    // tar reads each archive's checked bytes on stdin, once, and those are the bytes each pin records.
    expect(run.tar).toEqual(names.map((name) => handed(run.bytes[name] as Buffer)));
    expect(run.pins).toEqual(
      names.map((name) => ({
        package: `@inventarch/${name}`,
        archive: archiveName(name),
        sha256: sha256(run.bytes[name] as Buffer),
      })),
    );
    // The install still names each archive by its path; see the SPEC's limitation.
    expect(run.dependencies).toEqual(
      Object.fromEntries(
        names.map((name) => [
          `@inventarch/${name}`,
          `file:${resolve(run.archives, archiveName(name)).replaceAll('\\', '/')}`,
        ]),
      ),
    );
    expect(run.installed).toEqual(
      Object.fromEntries(names.map((name) => [`@inventarch/${name}`, sha256(run.bytes[name] as Buffer)])),
    );
  },
  settle,
);

it(
  'keeps the pin on the checked bytes when the archive changes after its check, though the install reads the change',
  async () => {
    // A known limitation, kept explicit: the digest, tar input and pin are bound to one read, but the install reopens
    // the archive by its path, so the installed bytes are not bound to the checked buffer.
    const run = await qualify({ race: { at: 'tar', change: 'replace' } });
    expect(run.status).toBe(0);
    const checked = sha256(run.bytes['db'] as Buffer);
    expect(run.tar[names.indexOf('db')]).toEqual(handed(run.bytes['db'] as Buffer));
    expect(run.pins?.find((pin) => pin.package === '@inventarch/db')?.sha256).toBe(checked);
    expect(run.dbAfter).toBe(sha256(run.replacement));
    expect(run.installed?.['@inventarch/db']).toBe(sha256(run.replacement));
  },
  settle,
);

it(
  'admits a hard-linked archive as the regular file it is and pins its bytes',
  async () => {
    const run = await qualify({ link: 'hard' });
    expect(run.status).toBe(0);
    expect(run.tar).toEqual(names.map((name) => handed(run.bytes[name] as Buffer)));
    expect(run.pins?.find((pin) => pin.package === '@inventarch/db')?.sha256).toBe(sha256(run.bytes['db'] as Buffer));
  },
  settle,
);

it.each([
  ['grows while it is read', { at: 'read', change: 'grow' }, 'Selected archive changed while it was read'],
  ['shrinks while it is read', { at: 'read', change: 'shrink' }, 'Selected archive changed while it was read'],
  [
    'is rewritten at its size with an older modification time while it is read',
    { at: 'read', change: 'rewrite' },
    'Selected archive changed while it was read',
  ],
  [
    'is replaced by another archive between its selection and its open',
    { at: 'open', change: 'replace' },
    'Selected archive digest mismatch',
  ],
] as const)(
  'refuses an archive that %s before tar is handed its bytes',
  async (_, race, message) => {
    const run = await qualify({ race });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
    expect(run.tar).toEqual(names.slice(0, names.indexOf('db')).map((name) => handed(run.bytes[name] as Buffer)));
    expect(run.pins).toBeUndefined();
    expect(run.dependencies).toBeUndefined();
  },
  settle,
);

const refusesBeforeTar = async (options: Options, message: string) => {
  const run = await qualify(options);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(message);
  expect(run.tar).toEqual(names.slice(0, names.indexOf('db')).map((name) => handed(run.bytes[name] as Buffer)));
  expect(run.pins).toBeUndefined();
};
/** A denied Windows file-link fixture is an explicit skip; all other setup failures still fail the test. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};
/** Whether a file link can be made here, probed as the task runner probes it: with a disposable link in the temp root. */
function fileLinks(): boolean {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-qualify-sdk-link-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    writeFileSync(resolve(root, 'target'), '');
    return fileLink(resolve(root, 'target'), resolve(root, 'link'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
// Both link cases run wherever a file link can be made, Windows included, where the script finds a link by its name
// after the read. Only a Windows denial (EPERM) skips them: a conditional skip tasks.json declares.
it(
  'refuses a symbolic link at its selection before tar is handed its bytes',
  async (context) => {
    if (!fileLinks()) return context.skip('Windows denied file symlink creation (EPERM)');
    await refusesBeforeTar({ link: 'symbolic' }, 'isSymbolicLink()');
  },
  settle,
);
it(
  'refuses a symbolic link put in place after its selection before tar is handed its bytes',
  async (context) => {
    if (!fileLinks()) return context.skip('Windows denied file symlink creation (EPERM)');
    await refusesBeforeTar({ race: { at: 'open', change: 'link' } }, 'isSymbolicLink()');
  },
  settle,
);
// Windows has no FIFOs, and a rename over a name held open is not tried there: these two cases are declared Windows
// skips in tasks.json.
it.skipIf(process.platform === 'win32')(
  'refuses the same bytes under a new identity once it is open before tar is handed its bytes',
  () => refusesBeforeTar({ race: { at: 'read', change: 'identity' } }, 'Selected archive changed while it was read'),
  settle,
);
// A FIFO refuses without waiting for a writer: the run would otherwise reach its bound.
it.skipIf(process.platform === 'win32')(
  'refuses a FIFO put in place after its selection before tar is handed its bytes',
  () => refusesBeforeTar({ race: { at: 'open', change: 'fifo' } }, 'Selected archive is not a regular file'),
  settle,
);

it.each([
  ['a packed name other than its row', 'db', { db: { name: '@inventarch/other' } }, 'Selected archive name mismatch'],
  [
    'an SDK closure version other than the selected one',
    'runtime',
    { runtime: { dependencies: { '@inventarch/db': '1.0.0' } } },
    'SDK closure version mismatch',
  ],
  [
    'an unselected workspace package in its SDK closure',
    'runtime',
    { runtime: { dependencies: { '@inventarch/unselected': version } } },
    'SDK closure includes unselected workspace package',
  ],
] as const)(
  'refuses an archive whose checked bytes hold %s',
  async (_, refused, manifests, message) => {
    const run = await qualify({ manifests });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
    // The manifest refused is the one tar read from the archive's checked bytes.
    expect(run.tar).toEqual(
      names.slice(0, names.indexOf(refused) + 1).map((name) => handed(run.bytes[name] as Buffer)),
    );
    expect(run.pins).toBeUndefined();
  },
  settle,
);
