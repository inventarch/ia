/**
 * `ia floor` and the minimum `ia pack` enforces: the lowest `inventarch/language` base a kit's `.ia/src` records need,
 * the feature that sets it, how the kit's declared range compares with it, and (`--verify`) the proof on every carried
 * base from it to the newest.
 *
 * The kits here are written by this file, except the `--verify` one: the published `ia-kb` fixture kit the door's
 * method goldens use (`apps/mcp-door/tests/fixtures/method/plugin.json.gz`), locked on the published 3.2.0 base and
 * declaring `^3.2.0`. An agent profile's `execution.effort` field first appeared in 3.1.0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, expect, it } from 'vitest';
import { provenFloor } from '../src/floor.js';
import { cleanup, cli, DESCRIPTOR, repository, run, scratch } from './workspace-fixture.js';

afterAll(() => cleanup());

const LANGUAGE = 'inventarch/language';
/** The bases this CLI carries, ascending (`assets/bases.json`, a build output). */
const CARRIED = (JSON.parse(readFileSync(resolve(cli, 'assets/bases.json'), 'utf8')) as { version: string }[]).map(
  (pin) => pin.version,
);
const NEWEST = CARRIED.at(-1)!;

const record = (execution: string): string =>
  [
    '#! ia 1.0',
    '',
    '@agent-profile note-profile',
    '  meaning',
    '    says "Bind the note writer to its capability."',
    '    answers "Which profile writes notes?"',
    '  composition',
    '    agent @agent note-writer',
    '    capabilities [@capability write-note]',
    '  execution',
    '    role writer',
    '    outcomes note-outcomes',
    '    mandate-contract note-contract',
    ...execution.split('\n').filter((line) => line !== ''),
    '',
  ].join('\n');
/** Uses nothing newer than the lowest base. */
const PLAIN = record('');
/** `execution.effort` first appeared in 3.1.0. */
const EFFORT = record('    effort high');
/** A field no base declares: invalid on the newest base too. */
const UNDECLARED = record('    bogus high');

interface Kit {
  /** The record, at `.ia/src/note.ia`. */
  readonly text: string;
  /** The language range `.ia/release.json` declares; no descriptor when absent. */
  readonly range?: string;
  /** The language range the lock requests; no lock when absent. */
  readonly requests?: string;
}
function kit(name: string, { text, range, requests }: Kit): string {
  const root = resolve(scratch('floor'), name);
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/note.ia'), text);
  if (range !== undefined) {
    writeFileSync(
      resolve(root, '.ia/release.json'),
      JSON.stringify({
        ...DESCRIPTOR,
        dependencies: [{ id: LANGUAGE, range, systems: ['agent-composition-system'] }],
      }) + '\n',
    );
    // The descriptor's one declared asset.
    writeFileSync(resolve(root, 'LICENSE'), 'Fixture only; no external publication.\n');
  }
  if (requests !== undefined)
    writeFileSync(
      resolve(root, '.ia/distributions.lock.json'),
      JSON.stringify({
        formatVersion: 1,
        engine: '^0.1.0',
        requests: [{ id: LANGUAGE, range: requests }],
        packages: [],
      }) + '\n',
    );
  return root;
}
async function floor(root: string, ...flags: string[]) {
  const result = await run(['floor', '--root', root, '--json', ...flags]);
  return {
    exitCode: result.exitCode,
    body: JSON.parse(result.stdout) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

it('reports the minimum and the field that sets it', async () => {
  const root = kit('effort', { text: EFFORT, range: '^3.1.0' });
  const { exitCode, body } = await floor(root);
  expect(exitCode).toBe(0);
  expect(body).toEqual({
    version: 1,
    floor: '3.1.0',
    newest: NEWEST,
    declared: '^3.1.0',
    status: 'ok',
    gaps: [
      {
        base: '3.0.0',
        source: '.ia/src/note.ia',
        record: 'note-profile',
        word: 'agent-profile',
        kind: 'field',
        key: 'agent-profile.execution.effort',
      },
    ],
  });
  // The human report names the minimum and the field, in the base below it, that sets it.
  const human = await run(['floor', '--root', root]);
  expect(human.exitCode).toBe(0);
  const flat = human.stdout.replace(/\s+/g, ' ');
  expect(flat).toContain('inventarch/language 3.1.0');
  expect(flat).toContain('uses the field agent-profile.execution.effort, which 3.0.0 does not declare');
});

it('range-too-high suggests ^<floor> and exits 0', async () => {
  const { exitCode, body } = await floor(kit('plain', { text: PLAIN, range: '^3.2.0' }));
  expect(exitCode).toBe(0);
  expect(body).toEqual({
    version: 1,
    floor: CARRIED[0],
    newest: NEWEST,
    declared: '^3.2.0',
    status: 'range-too-high',
    suggested: `^${CARRIED[0]}`,
    gaps: [],
  });
});

it('range-too-low exits 1', async () => {
  const { exitCode, body } = await floor(kit('low', { text: EFFORT, range: '^3.0.0' }));
  expect(exitCode).toBe(1);
  expect(body).toMatchObject({ floor: '3.1.0', declared: '^3.0.0', status: 'range-too-low', suggested: '^3.1.0' });
  // Without a release descriptor, the declared range is the one the lock requests.
  const requested = await floor(kit('requested', { text: EFFORT, requests: '^3.0.0' }));
  expect(requested.exitCode).toBe(1);
  expect(requested.body).toMatchObject({ floor: '3.1.0', declared: '^3.0.0', status: 'range-too-low' });
});

it('no-floor for a kit invalid on the newest base', async () => {
  const { exitCode, body } = await floor(kit('invalid', { text: UNDECLARED, range: '^3.2.0' }));
  expect(exitCode).toBe(1);
  expect(body).toMatchObject({ floor: null, newest: NEWEST, declared: '^3.2.0', status: 'no-floor' });
  expect(body['suggested']).toBeUndefined();
  expect(body['gaps']).toEqual([
    {
      base: NEWEST,
      source: '.ia/src/note.ia',
      record: 'note-profile',
      word: 'agent-profile',
      kind: 'field',
      key: 'agent-profile.execution.bogus',
    },
  ]);
});

/** The published `ia-kb` fixture kit, written to a folder of its own. */
function publishedKit(): string {
  const published = JSON.parse(
    gunzipSync(readFileSync(resolve(repository, 'apps/mcp-door/tests/fixtures/method/plugin.json.gz'))).toString(
      'utf8',
    ),
  ) as Record<string, string>;
  const root = resolve(scratch('floor-kit'), 'ia-kb');
  for (const [path, text] of Object.entries(published))
    if (path.startsWith('config/kits/ia-kb/')) {
      const target = resolve(root, path.slice('config/kits/ia-kb/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  return root;
}

it('--verify on the published ia-kb fixture kit passes on every base from its minimum', async () => {
  const root = publishedKit();
  const lock = readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8');
  const { exitCode, body } = await floor(root, '--verify');
  expect(exitCode, JSON.stringify(body)).toBe(0);
  const minimum = body['floor'] as string;
  expect(CARRIED).toContain(minimum);
  expect(body).toMatchObject({ declared: '^3.2.0', newest: NEWEST });
  // Every carried base from the minimum to the newest validated with no error.
  expect(body['verified']).toEqual(CARRIED.slice(CARRIED.indexOf(minimum)).map((base) => ({ base, errors: 0 })));
  // Each run used a scratch copy: the kit's own folder is never written.
  expect(readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8')).toBe(lock);
  expect(existsSync(resolve(root, '.ia/distributions'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
}, 300_000);

it('--verify raises the minimum past every base that reports errors and exits 1', async () => {
  // Two records of one identity validate with errors on every base, though every base's schema reads each of them: no
  // base is proven.
  const root = kit('unproven', { text: PLAIN, range: '^3.0.0' });
  writeFileSync(resolve(root, '.ia/src/again.ia'), PLAIN);
  const pins = JSON.parse(readFileSync(resolve(cli, 'assets/bases.json'), 'utf8')) as Record<string, string>[];
  const pin = pins.find((row) => row['version'] === '3.2.0')!;
  const row = {
    id: LANGUAGE,
    version: pin['version'],
    archive: pin['archive'],
    manifest: pin['manifest'],
    location: `sha256:${pin['archive']}`,
    dependencies: [],
  };
  writeFileSync(
    resolve(root, '.ia/distributions.lock.json'),
    JSON.stringify({
      formatVersion: 1,
      engine: '^0.1.0',
      requests: [{ id: LANGUAGE, range: '^3.2.0' }],
      packages: [row],
    }) + '\n',
  );
  const { exitCode, body } = await floor(root, '--verify');
  expect(exitCode, JSON.stringify(body)).toBe(1);
  expect(body).toMatchObject({ floor: null, status: 'no-floor', gaps: [] });
  const verified = body['verified'] as { base: string; errors: number }[];
  expect(verified.map((entry) => entry.base)).toEqual(CARRIED);
  expect(verified.every((entry) => entry.errors > 0)).toBe(true);
  const human = await run(['floor', '--root', root, '--verify']);
  expect(human.exitCode).toBe(1);
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(
    `The newest base reports errors, so no base is proven: the static minimum was ${CARRIED[0]}.`,
  );
  // Without a lock there is nothing to restore on each base.
  const unlocked = await run([
    'floor',
    '--root',
    kit('unlocked', { text: PLAIN, range: '^3.0.0' }),
    '--verify',
    '--json',
  ]);
  expect(unlocked.exitCode).toBe(3);
  expect(JSON.parse(unlocked.stdout)).toMatchObject({ ok: false, code: 'IA-CLI-CONFLICT' });
  // The raised minimum is the lowest base from which every later base has no error.
  const rows = (errors: number[]) => errors.map((count, at) => ({ base: CARRIED[at]!, errors: count }));
  expect(provenFloor(rows([2, 0, 1, 0, 0, 0]))).toBe(CARRIED[3]);
  expect(provenFloor(rows([1, 0, 0, 0, 0, 0]))).toBe(CARRIED[1]);
  expect(provenFloor(rows([0, 0, 0, 0, 0, 3]))).toBeNull();
}, 300_000);

it('pack refuses a declared range below the minimum', async () => {
  const root = kit('pack-low', { text: EFFORT, range: '^3.0.0' });
  const refused = await run(['pack', '--root', root, '--descriptor', '.ia/release.json']);
  expect(refused.exitCode).toBe(3);
  const flat = refused.stderr.replace(/\s+/g, ' ');
  expect(flat).toContain('IA-CLI-CONFLICT');
  expect(flat).toContain('^3.0.0');
  expect(flat).toContain('minimum 3.1.0');
  expect(flat).toContain('agent-profile.execution.effort');
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  // A kit already invalid on the newest base has no minimum, and pack refuses it too.
  const invalid = kit('pack-invalid', { text: UNDECLARED, range: '^3.2.0' });
  const none = await run(['pack', '--root', invalid, '--descriptor', '.ia/release.json', '--json']);
  expect(none.exitCode).toBe(3);
  expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, code: 'IA-CLI-CONFLICT' });
  expect(existsSync(resolve(invalid, '.ia/work'))).toBe(false);
});

it('pack adds the minimum to its JSON when the declared range is higher than needed', async () => {
  const root = publishedKit();
  const restored = await run(['restore', '--root', root, '--offline', '--apply', '--yes', '--json']);
  expect(restored.exitCode, restored.stdout + restored.stderr).toBe(0);
  const packed = await run(['pack', '--root', root, '--descriptor', '.ia/release.json', '--json']);
  expect(packed.exitCode, packed.stdout + packed.stderr).toBe(0);
  const body = JSON.parse(packed.stdout) as { status: string; floor?: string; path: string };
  expect(body).toMatchObject({ version: 1, status: 'packed', floor: CARRIED[0] });
  expect(readdirSync(resolve(root, '.ia/work/dist'))).toEqual([body.path]);
  // The human report names the lower range.
  const human = await run(['pack', '--root', root, '--descriptor', '.ia/release.json', '--force']);
  expect(human.exitCode).toBe(0);
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(`^${CARRIED[0]}`);
}, 120_000);
