/**
 * `ia init --migrate`: milestone position-packet task init-migrate-flag's exit evidence.
 *
 * The 1.1.0 fixture (tests/fixtures/workspace-1.1.0) is the v1.1.0 starter of a workspace named `demo` — its local
 * `@system demo` and `@agent demo-steward`, its `@workspace demo` and `@distribution demo-distribution`, and the
 * descriptor naming that distribution — with one user-authored `@decision` in `records/notes.ia`. Each test installs
 * the bundled base as host-fixture.ts does, with an `ia init`, takes this release's starter, ignore file and capture
 * away and lays the fixture over it. The collision fixture adds an `.ia/src/notes.ia` of the user's own. A 1.x base,
 * which declares none of the fields the three starter records use, is the bundled one without them (`legacyBase`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import {
  decodeReleaseDescriptor,
  DISTRIBUTION_ENGINE_VERSION,
  INSTALL_PATHS,
  sha256,
} from '@inventarch/db/distribution';
import { buildArchive, verifyArchive } from '@inventarch/distribution/archive';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import { resolveReleases } from '@inventarch/distribution/resolve';
import { readInstalledState, resolveCatalog } from '@inventarch/distribution/services';
import { dispatch, Interrupted } from '../src/consumer.js';
import type { Result } from '../src/consumer.js';
import { GUARD_RETIRED } from '../src/host.js';
import { applyHostProjection, planFiles, renderProjectionFor } from '../src/host-projection.js';
import {
  applyMigration,
  collectMigration,
  locksBase,
  readBase,
  starterDistribution,
  starterRecords,
} from '../src/init.js';
import { quote } from '../src/render.js';
import {
  doctor,
  GUARD_STATE,
  guardGroups,
  host,
  initialized,
  LEGACY_FILES,
  legacyRegistration,
  put,
  read,
  RECEIPT,
  row,
  STEWARD,
} from './host-fixture.js';
import { baseCompanionArchive } from './registry-fixture.js';
import { cleanup, cli, commandsIn, makeHost, nextArgv, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

/**
 * A seam on apps/distribution's applyProjection, which writes and deletes every projection file, so a test can fail
 * the first file change of the migration's project effect at its `pending` stage. Every call passes through.
 */
const seams = vi.hoisted(() => ({ failAt: undefined as string | undefined }));
vi.mock('@inventarch/distribution/projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/distribution/projection')>();
  return {
    ...actual,
    applyProjection: (plan: Parameters<typeof actual.applyProjection>[0], checkpoint?: (name: string) => void) =>
      actual.applyProjection(plan, (name) => {
        if (name === seams.failAt) throw new Error('file write failed');
        checkpoint?.(name);
      }),
  };
});

const FIXTURE = resolve(cli, 'tests/fixtures/workspace-1.1.0');
const COLLISION = resolve(cli, 'tests/fixtures/workspace-1.1.0-collision');
const FOLDER = '.ia/src/systems/demo';
const NOTES = `${FOLDER}/records/notes.ia`;
const LEGACY = `${FOLDER}/records/workspace.ia`;
const LOCAL = `${FOLDER}/system.ia`;
/** The user-authored record: its identity follows its word's owning system, work-system, not its folder. */
const DECISION = 'work-system/definition/decision/api-response-format';
const DISTRIBUTION = 'workspace-system/definition/distribution/demo-distribution';
/** Position-and-projection §3's three records, as admission compiles a starter named `demo`. */
const AUTHORED = [
  'workspace-system/definition/workspace/demo',
  'agent-system/binding/agent/demo',
  'agent-system/policy/mandate/demo-mandate',
];
/** The 1.x starter files and the folders they leave empty, in the order a migration without `--system` deletes them. */
const REMOVED = [LEGACY, LOCAL, `${FOLDER}/records/`, `${FOLDER}/`, '.ia/src/systems/'];
const base = readBase(cli);
/** The bundled base as the plan reports it, installed or bundled. */
const BUNDLED = { version: base.pin.version, archive: base.pin.archive };

const json = (result: Result): any => JSON.parse(result.stdout);
/** Every directory and file under `root`, with each file's bytes, so "nothing written" is literal. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(resolve(root, relative)).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (lstatSync(resolve(root, path)).isDirectory()) {
        out[path + '/'] = 'directory';
        walk(path);
      } else
        out[path] = createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex');
    }
  };
  walk('');
  return out;
}
/**
 * `root`, an `ia init` workspace holding the bundled base, as a 1.1.0 `ia init demo --apply` left it: this release's
 * starter, ignore file, descriptor and capture taken away and the fixture laid over, then each overlay.
 */
function layOver(root: string, overlays: readonly string[]): void {
  const installed = JSON.parse(read(root, '.ia/release.json'));
  for (const path of ['.ia/src/workspace.ia', '.ia/.gitignore', '.ia/release.json', '.ia/work'])
    rmSync(resolve(root, path), { recursive: true });
  for (const overlay of [FIXTURE, ...overlays]) cpSync(overlay, root, { recursive: true });
  // The installed base is current, while the historical descriptor still names the 1.1.0 base.
  expect(installed.dependencies).toEqual(BUNDLED_DEPENDENCIES);
  expect(JSON.parse(read(root, '.ia/release.json')).dependencies).toEqual(LEGACY_DEPENDENCIES);
}
/** A 1.1.0 workspace over the bundled base installed as host-fixture.ts installs it. */
async function legacyWorkspace(...overlays: string[]): Promise<{ root: string; env: { IA_HOST_HOME: string } }> {
  const workspace = await initialized();
  layOver(workspace.root, overlays);
  return workspace;
}
/**
 * The fixture's host registered as a 1.1.0 `ia host claude --apply` left it: its MCP entry, then the steward guard
 * group and its state and a projection state owning the 1.x rules file, skill and steward agent file (host-fixture.ts
 * `legacyRegistration`), and no receipt, which 1.x never wrote.
 */
async function registered(root: string, env: { IA_HOST_HOME: string }): Promise<void> {
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  legacyRegistration(root, env);
  rmSync(resolve(root, RECEIPT));
}
const migrate = (root: string, extra: readonly string[] = [], env: Record<string, string> = {}) =>
  run(['init', root, '--migrate', '--json', ...extra], { env });
const apply = (root: string, extra: readonly string[] = [], env: Record<string, string> = {}) =>
  migrate(root, ['--apply', '--yes', ...extra], env);
/** The identities the compiled graph holds in `path`. */
async function identitiesIn(root: string, path: string): Promise<readonly string[]> {
  const inspected = await run(['inspect', '--root', root, '--path', path, '--json']);
  expect(inspected.exitCode, inspected.stdout).toBe(0);
  return json(inspected)
    .records.map((record: { identity: string }) => record.identity)
    .sort();
}
const fixture = (path: string): string => readFileSync(resolve(FIXTURE, path), 'utf8');
const LEGACY_DEPENDENCIES = JSON.parse(fixture('.ia/release.json')).dependencies;
const BUNDLED_DEPENDENCIES = [{ id: base.pin.id, range: `^${base.pin.version}`, systems: base.systems }];
/** The 1.1.0 descriptor without its distribution and depending on the bundled base, as the migration writes it. */
const undistributed = (): string =>
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries({ ...JSON.parse(fixture('.ia/release.json')), dependencies: BUNDLED_DEPENDENCIES }).filter(
        ([key]) => key !== 'distribution',
      ),
    ),
    null,
    2,
  )}\n`;
/** A file's SHA-256, as a receipt lists it. */
const digest = (root: string, path: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

/**
 * A 1.x base: the bundled archive under `id` at 1.0.0, without what the three starter records need — the
 * `@workspace`'s `composition.sources` and `composition.steward`, which its own `@workspace language-workspace` then
 * states no `sources` for, and the `@mandate`'s `authority` section — as v1.0.0's workspace and mandate schemas are.
 */
function legacyBase(id = base.pin.id): { readonly bytes: Buffer; readonly archive: string } {
  const verified = verifyArchive(base.bytes, base.pin.archive),
    files = new Map([...verified.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const drop = (path: string, line: RegExp): void => {
    const text = files.get(path)!.toString('utf8'),
      kept = text
        .split('\n')
        .filter((row) => !line.test(row))
        .join('\n');
    expect(kept, path).not.toBe(text);
    files.set(path, Buffer.from(kept));
  };
  drop('.ia/src/systems/workspace-system/schemas/workspace.schema.ia', /composition\.(sources|steward)/);
  drop('.ia/src/systems/agent-system/schemas/mandate.schema.ia', /authority/);
  drop('.ia/src/systems/workspace-system/records/language.ia', /^ {4}sources /);
  const manifest = {
    ...verified.manifest,
    id,
    version: '1.0.0',
    files: verified.manifest.files.map((pin) => ({
      ...pin,
      bytes: files.get(pin.path)!.length,
      sha256: sha256(files.get(pin.path)!),
    })),
  };
  const bytes = buildArchive(manifest, files);
  return { bytes, archive: sha256(bytes) };
}
/** Installs `archives` in place of the workspace's base, as `ia install` installs releases, requesting each at `^1.0.0`. */
async function installInstead(
  root: string,
  archives: readonly { readonly id: string; readonly bytes: Buffer; readonly archive: string }[],
): Promise<void> {
  for (const release of archives) cacheArchive(root, release.bytes, release.archive);
  const choices = await resolveCatalog({
    root,
    entries: archives.map((release) => ({
      path: `.ia/distributions/cache/${release.archive}.ia.tgz`,
      withdrawn: false,
    })),
    offline: true,
  });
  const requests = archives
    .map((release) => ({ id: release.id, range: '^1.0.0' }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  applyInstallation(
    planInstallation(root, resolveReleases(requests, choices, DISTRIBUTION_ENGINE_VERSION).lock, 'update'),
  );
}
/**
 * The fixture as a 1.0.0 `ia init demo --apply` left it: a 1.x base installed and the descriptor depending on it at
 * `^1.0.0` (1.0.0 and 1.1.x write the same starter).
 */
async function onLegacyBase(): Promise<{ root: string; legacy: { readonly archive: string } }> {
  const { root } = await legacyWorkspace(),
    legacy = legacyBase();
  await installInstead(root, [{ id: base.pin.id, ...legacy }]);
  const descriptor = JSON.parse(read(root, '.ia/release.json'));
  writeFileSync(
    resolve(root, '.ia/release.json'),
    `${JSON.stringify({ ...descriptor, dependencies: [{ ...descriptor.dependencies[0], range: '^1.0.0' }] }, null, 2)}\n`,
  );
  return { root, legacy };
}

it('migrates the 1.1.0 fixture into the three starter records, moving its user record with its identity unchanged', async () => {
  const { root } = await legacyWorkspace();
  expect(await identitiesIn(root, NOTES)).toEqual([DECISION]);
  const before = tree(root);
  // The plan lists every move, write and delete, and writes nothing.
  const planned = await migrate(root);
  expect(planned.exitCode, planned.stdout).toBe(0);
  expect(json(planned)).toMatchObject({ command: 'init', apply: false });
  expect(json(planned).plan).toEqual({
    migrate: '1.1.0',
    id: 'local/demo',
    name: 'demo',
    system: false,
    base: { id: base.pin.id, installed: BUNDLED, bundled: BUNDLED },
    conflicts: [],
    steps: ['move', 'author', 'remove', 'descriptor', 'admission', 'capture'],
    moves: [{ from: NOTES, to: '.ia/src/notes.ia', identities: [DECISION] }],
    writes: ['.ia/src/workspace.ia'],
    records: ['@workspace demo', '@agent demo', '@mandate demo-mandate'],
    systems: base.systems,
    removes: [
      { path: LEGACY, identities: [DISTRIBUTION, 'workspace-system/definition/workspace/demo'] },
      { path: LOCAL, identities: ['agent-system/binding/agent/demo-steward', 'floor/definition/system/demo'] },
      { path: `${FOLDER}/records/`, identities: [] },
      { path: `${FOLDER}/`, identities: [] },
      { path: '.ia/src/systems/', identities: [] },
    ],
    ignore: { path: '.ia/.gitignore', status: 'create' },
    descriptor: {
      path: '.ia/release.json',
      before: DISTRIBUTION,
      after: null,
      dependencies: { before: LEGACY_DEPENDENCIES, after: BUNDLED_DEPENDENCIES },
    },
    hosts: [],
  });
  const human = (await run(['init', root, '--migrate'])).stdout.replace(/\s+/g, ' ');
  expect(human).toContain('This is a preview. Nothing has been written.');
  expect(human).toContain(
    `Base package ${base.pin.id} ${base.pin.version} from the bundled archive, already installed`,
  );
  expect(human).toContain(`${NOTES} moves to .ia/src/notes.ia, holding ${DECISION}`);
  for (const folder of REMOVED.slice(2)) expect(human).toContain(`${folder} deleted once empty`);
  expect(human).toContain(`Apply with "ia init ${quote(root)} --migrate --apply --yes".`);
  expect(tree(root)).toEqual(before);

  const applied = await apply(root);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const capture = JSON.parse(read(root, '.ia/work/snapshot/current.json'));
  // The apply deletes exactly what the plan listed.
  expect(json(applied).applied).toEqual({
    status: 'migrated',
    id: 'local/demo',
    base: 'present',
    distribution: null,
    authored: AUTHORED,
    moved: [{ from: NOTES, to: '.ia/src/notes.ia', identities: [DECISION] }],
    removed: json(planned).plan.removes.map((removal: { path: string }) => removal.path),
    ignore: 'written',
    effects: { capture: { revision: capture.revision, records: capture.records.length }, project: [] },
  });
  expect(json(applied).applied.removed).toEqual(REMOVED);
  // notes.ia lands at .ia/src/notes.ia byte for byte, and its record keeps its identity.
  expect(read(root, '.ia/src/notes.ia')).toBe(fixture(NOTES));
  expect(await identitiesIn(root, '.ia/src/notes.ia')).toEqual([DECISION]);
  // The three records keep the 1.1.0 workspace's name and composition, adding its sources and steward: here they are
  // the bytes a default initialization of `demo` writes.
  expect(readdirSync(resolve(root, '.ia/src')).sort()).toEqual(['notes.ia', 'workspace.ia']);
  expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', base.systems));
  expect(read(root, '.ia/.gitignore')).toBe('work/\ndistributions/\n');
  // The descriptor is the 1.1.0 one without its distribution and with the bundled base dependency.
  expect(read(root, '.ia/release.json')).toBe(undistributed());
  // `ia validate` is clean with no local @system: none is admitted, and the starter's steward is gone with it.
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  expect(json(validated).status).toBe('admitted');
  expect(json(validated).findings.filter((finding: { severity: string }) => finding.severity === 'error')).toEqual([]);
  expect(json(validated).revision).toBe(capture.revision);
  const identities = capture.records.map((record: { identity: string }) => record.identity);
  expect(identities).toEqual(expect.arrayContaining([...AUTHORED, DECISION]));
  expect(identities).not.toContain('floor/definition/system/demo');
  expect(identities).not.toContain('agent-system/binding/agent/demo-steward');
  // The participant's mandate is the position body's, as on a fresh initialization.
  const position = json(await run(['position', '--root', root, '--json']));
  expect(position.body.mandates.map((row: { identity: string }) => row.identity)).toEqual([
    'agent-system/policy/mandate/demo-mandate',
  ]);
  // Migrated, the workspace is no longer 1.1.0-shaped: a second migration refuses and changes nothing.
  const migrated = tree(root),
    again = await apply(root);
  expect(again.exitCode).toBe(3);
  expect(json(again).next).toBe('Run "ia init --help" for the forms this verb takes.');
  expect(tree(root)).toEqual(migrated);
});

it('renders what a migration applied', async () => {
  const { root } = await legacyWorkspace();
  const result = await run(['init', root, '--migrate', '--apply', '--yes']);
  expect(result.exitCode, result.stderr).toBe(0);
  const text = result.stdout.replace(/\s+/g, ' ');
  expect(text).toContain(
    'Migrated local/demo from the 1.1.0 starter; release descriptor .ia/release.json, which names no distribution.',
  );
  expect(text).toContain(`${base.pin.id} ${base.pin.version} from the bundled archive was already installed.`);
  expect(text).toContain(
    `Authored 3 records: ${AUTHORED.join(' ')} Wrote .ia/.gitignore, ignoring work/ and distributions/.`,
  );
  expect(text).toContain(`${NOTES} moved to .ia/src/notes.ia It holds ${DECISION}.`);
  expect(text).toContain(`Deleted ${REMOVED.join(', ')}.`);
  expect(text).toContain('Project skipped: no host projection is registered.');
  expect(text).toContain(
    'Run "ia validate" to check the workspace, or "ia position" for the position body an agent starts from.',
  );
});

it('installs the bundled base in place of a 1.x one, which declares none of the fields the three records use', async () => {
  const { root, legacy } = await onLegacyBase();
  // The 1.x workspace admits on its 1.x base, and the bundled base is not what it has installed.
  expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
  expect(locksBase(readInstalledState({ root }).lock, base.pin)).toBe(false);
  const before = tree(root);
  const planned = await migrate(root);
  expect(planned.exitCode, planned.stdout).toBe(0);
  expect(json(planned).plan).toMatchObject({
    base: { id: base.pin.id, installed: { version: '1.0.0', archive: legacy.archive }, bundled: BUNDLED },
    conflicts: [],
    steps: ['install', 'move', 'author', 'remove', 'descriptor', 'admission', 'capture'],
    descriptor: {
      dependencies: { before: [{ ...LEGACY_DEPENDENCIES[0], range: '^1.0.0' }], after: BUNDLED_DEPENDENCIES },
    },
  });
  const human = (await run(['init', root, '--migrate'])).stdout.replace(/\s+/g, ' ');
  expect(human).toContain(`Install ${base.pin.id} ${base.pin.version} from the bundled archive`);
  expect(human).toContain(`in place of the installed 1.0.0`);
  expect(human).toContain(
    `.ia/release.json drops distribution ${DISTRIBUTION}, so ia pack refuses until one is authored; depends on ${base.pin.id} ^${base.pin.version}, the bundled base, in place of ${base.pin.id} ^1.0.0`,
  );
  expect(tree(root)).toEqual(before);

  const applied = await apply(root);
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(json(applied).applied).toMatchObject({ base: 'installed', authored: AUTHORED, removed: REMOVED });
  expect((await run(['init', root, '--migrate', '--apply', '--yes'])).stdout.replace(/\s+/g, ' ')).not.toContain(
    'Installed',
  );
  // The workspace now holds the bundled base, the records the CLI's own `ia init` writes and the descriptor
  // depending on that base, and admits.
  expect(locksBase(readInstalledState({ root }).lock, base.pin)).toBe(true);
  expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', base.systems));
  expect(read(root, '.ia/release.json')).toBe(undistributed());
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  expect(await identitiesIn(root, '.ia/src/notes.ia')).toEqual([DECISION]);
});

it("keeps the descriptor's other dependency rows, replacing only the base's, and with --system leaves rows it keeps byte for byte", async () => {
  const ACME = { id: 'acme/app', range: '^1.0.0', systems: ['acme-system'] };
  /** The descriptor with another dependency row before the base's, in `eol` line endings: the bytes written. */
  const beside = (root: string, eol = '\n', dependencies?: typeof BUNDLED_DEPENDENCIES): string => {
    const descriptor = JSON.parse(read(root, '.ia/release.json'));
    const text = `${JSON.stringify({ ...descriptor, dependencies: [ACME, ...(dependencies ?? descriptor.dependencies)] }, null, 2)}\n`;
    writeFileSync(resolve(root, '.ia/release.json'), text.replaceAll('\n', eol));
    return text.replaceAll('\n', eol);
  };
  /** `text` without its distribution, preserving the other dependency and replacing the base's row. */
  const dropped = (text: string): string =>
    `${JSON.stringify(
      Object.fromEntries(
        Object.entries({ ...JSON.parse(text), dependencies: [ACME, ...BUNDLED_DEPENDENCIES] }).filter(
          ([key]) => key !== 'distribution',
        ),
      ),
      null,
      2,
    )}\n`;
  // Even over the bundled base, the historical descriptor's base dependency is updated.
  const { root } = await legacyWorkspace(),
    written = beside(root);
  expect(json(await migrate(root)).plan.descriptor.dependencies).toEqual({
    before: [ACME, ...LEGACY_DEPENDENCIES],
    after: [ACME, ...BUNDLED_DEPENDENCIES],
  });
  expect((await run(['init', root, '--migrate'])).stdout.replace(/\s+/g, ' ')).toContain(
    `; depends on ${base.pin.id} ^${base.pin.version}, the bundled base, in place of ${base.pin.id} ^1.1.0`,
  );
  expect((await apply(root)).exitCode).toBe(0);
  expect(read(root, '.ia/release.json')).toBe(dropped(written));
  // On a 1.x base the base's row is replaced by the bundled one's and the other row kept; the plan names the change.
  const legacy = await onLegacyBase();
  beside(legacy.root);
  expect(json(await migrate(legacy.root)).plan.descriptor.dependencies).toEqual({
    before: [ACME, { ...LEGACY_DEPENDENCIES[0], range: '^1.0.0' }],
    after: [ACME, ...BUNDLED_DEPENDENCIES],
  });
  expect((await run(['init', legacy.root, '--migrate'])).stdout.replace(/\s+/g, ' ')).toContain(
    `; depends on ${base.pin.id} ^${base.pin.version}, the bundled base, in place of ${base.pin.id} ^1.0.0`,
  );
  const replaced = await apply(legacy.root);
  expect(replaced.exitCode, replaced.stdout).toBe(0);
  expect(JSON.parse(read(legacy.root, '.ia/release.json')).dependencies).toEqual([ACME, ...BUNDLED_DEPENDENCIES]);
  // With --system a descriptor whose rows the migration keeps is left as it is, CRLF line endings included, as a
  // Windows checkout may hold it.
  const crlf = await legacyWorkspace(),
    bytes = beside(crlf.root, '\r\n', BUNDLED_DEPENDENCIES);
  const kept = await apply(crlf.root, ['--system']);
  expect(kept.exitCode, kept.stdout).toBe(0);
  expect(read(crlf.root, '.ia/release.json')).toBe(bytes);
});

it('stops after the base install on a signal, naming the rerun, which finds the base installed and finishes', async () => {
  const { root } = await onLegacyBase();
  const controller = new AbortController(),
    invocation = `ia init ${quote(root)} --migrate`;
  const interrupted = applyMigration(collectMigration({ root, packageRoot: cli, invocation }), {
    packageRoot: cli,
    signal: controller.signal,
    checkpoint: (name) => {
      if (name === 'migrate:install') controller.abort();
    },
  });
  await expect(interrupted).rejects.toBeInstanceOf(Interrupted);
  await expect(interrupted).rejects.toMatchObject({
    next: `Run "${invocation} --apply --yes" again to finish migrating.`,
  });
  // Nothing but the base changed: the records are still the 1.1.0 starter's, so the plan finds the base installed.
  expect(existsSync(resolve(root, LOCAL))).toBe(true);
  expect(existsSync(resolve(root, '.ia/src/workspace.ia'))).toBe(false);
  expect(json(await migrate(root)).plan.steps[0]).toBe('move');
  const finished = await run([...nextArgv(`Run "${invocation} --apply --yes"`), '--json']);
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(json(finished).applied).toMatchObject({ base: 'present', authored: AUTHORED });
});

it('says the base install was all it made when the first record write fails, naming the rerun, which finishes', async () => {
  const { root } = await onLegacyBase();
  const invocation = `ia init ${quote(root)} --migrate`;
  // A file where the user record moves, appearing once the base is installed: the first record write refuses it.
  const appear = (name: string): void => {
    if (name === 'migrate:install') put(root, '.ia/src/notes.ia', '#! ia 1.0\n');
  };
  const failed = applyMigration(collectMigration({ root, packageRoot: cli, invocation }), {
    packageRoot: cli,
    checkpoint: appear,
  });
  const next = `The migration is recorded in .ia/migration.json; nothing was rolled back. Repair the reported filesystem problem, then run "${invocation} --apply --yes" again to finish migrating.`;
  await expect(failed).rejects.toMatchObject({ code: 'IA-CLI-CONFLICT', next });
  expect(locksBase(readInstalledState({ root }).lock, base.pin)).toBe(true);
  expect(read(root, NOTES)).toBe(fixture(NOTES));
  expect(existsSync(resolve(root, '.ia/src/workspace.ia'))).toBe(false);
  // With the file in the way gone, the one command named finishes the migration, the base already installed.
  rmSync(resolve(root, '.ia/src/notes.ia'));
  const finished = await run([...nextArgv(next), '--json']);
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(json(finished).applied).toMatchObject({ base: 'present', authored: AUTHORED });
});

it('refuses to replace a 1.x base in a lock that holds more than that base, before anything is written', async () => {
  const legacy = legacyBase();
  // Another package beside the base, as `ia install` adds one, and a base under another id.
  const beside = await legacyWorkspace(),
    companion = baseCompanionArchive({ id: 'acme/app', version: '1.0.0' }, legacy.bytes);
  await installInstead(beside.root, [
    { id: base.pin.id, ...legacy },
    { id: companion.id, bytes: companion.bytes, archive: companion.archive },
  ]);
  const other = await legacyWorkspace();
  await installInstead(other.root, [{ id: 'legacy/language', ...legacyBase('legacy/language') }]);
  for (const [root, locked] of [
    [beside.root, `acme/app 1.0.0, ${base.pin.id} 1.0.0`],
    [other.root, 'legacy/language 1.0.0'],
  ] as const) {
    expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
    const before = tree(root);
    for (const extra of [[], ['--apply', '--yes']]) {
      const refused = await migrate(root, extra);
      expect(refused.exitCode, refused.stdout).toBe(3);
      expect(json(refused)).toMatchObject({
        code: 'IA-CLI-CONFLICT',
        message: `The target is not a 1.1.0 starter workspace: ${INSTALL_PATHS.lock} locks ${locked}, where a 1.1.0 starter's locks only ${base.pin.id}, which the migration replaces with the archive this CLI bundles`,
        where: { path: INSTALL_PATHS.lock },
      });
      expect(commandsIn(json(refused).next)).toEqual(['ia init --help']);
    }
    expect(tree(root)).toEqual(before);
  }
});

it('retires the guard, deletes the steward agent file and writes a receipt ia doctor reads, with the host registered', async () => {
  const { root, env } = await legacyWorkspace();
  // As a 1.1.0 `ia host claude --apply` left it: the guard group and its state, and a projection state listing the
  // steward agent file beside the rules file and the skill, with no receipt.
  await registered(root, env);
  expect(guardGroups(root)).toBe(1);
  expect(row((await doctor(root, env)).checks, 'projection-claude')).toMatchObject({ status: 'unknown' });
  const planned = json(await migrate(root, [], env));
  expect(planned.plan.steps).toEqual(['move', 'author', 'remove', 'descriptor', 'admission', 'capture', 'project']);
  expect(planned.plan.hosts).toEqual([
    {
      host: 'claude',
      guard: 'retire',
      files: [
        { path: STEWARD, action: 'remove' },
        { path: '.claude/rules/ia-workspace.md', action: 'update' },
        { path: '.claude/skills/ia-authoring/SKILL.md', action: 'update' },
      ],
    },
  ]);
  expect((await run(['init', root, '--migrate'], { env })).stdout.replace(/\s+/g, ' ')).toContain(
    `Project claude first retires the steward guard registered in .claude/settings.local.json; ${STEWARD} remove;`,
  );
  expect(guardGroups(root)).toBe(1);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);

  const applied = await apply(root, [], env);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const receipt = JSON.parse(read(root, RECEIPT));
  expect(json(applied).applied.effects.project).toEqual([
    { host: 'claude', files: receipt.files, receipt: RECEIPT, guard: 'retired', removed: [STEWARD] },
  ]);
  // The guard is retired and the steward agent file deleted; the packet names the migrated participant.
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(receipt).toMatchObject({
    guard: 'retired',
    removed: [{ path: STEWARD, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    participants: ['agent-system/binding/agent/demo'],
    mandates: ['agent-system/policy/mandate/demo-mandate'],
  });
  for (const file of receipt.files) expect(existsSync(resolve(root, file.path)), file.path).toBe(true);
  // `ia doctor` reports a receipt-backed projection: no file missing or changed, the packet current, and the 1.x
  // file the apply removed listed, not checked.
  const report = await doctor(root, env);
  expect(report.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([
    expect.objectContaining({
      id: 'projection-claude',
      status: 'ok',
      detail: expect.stringMatching(/^No drift: the 2 files \.ia\/distributions\/hosts\/claude-receipt\.json lists /),
    }),
    expect.objectContaining({
      id: 'projection-claude-receipt',
      status: 'info',
      detail: `The last apply removed ${STEWARD}; listed, not checked`,
    }),
  ]);
  // The host keeps its MCP entry and projection, and no longer the guard.
  expect(row(report.checks, 'host-claude')).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining('registered (mcp, projection);'),
  });
  // The human report says what the project effect did.
  const other = await legacyWorkspace();
  await registered(other.root, other.env);
  const human = (await run(['init', other.root, '--migrate', '--apply', '--yes'], { env: other.env })).stdout.replace(
    /\s+/g,
    ' ',
  );
  expect(human).toContain('Projected the position packet for claude:');
  expect(human).toContain(`Deleted the 1.x projection files ${STEWARD}.`);
  expect(human).toContain(GUARD_RETIRED);
});

it("plans a projection this CLI wrote as the update the apply makes, since the migration changes every file's revision", async () => {
  const { root, env } = await legacyWorkspace();
  // Projected before migrating, by this release's `ia host`: each file is the packet of the 1.x records.
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  const files = ['.agents/skills/ia-authoring/SKILL.md', 'AGENTS.md'];
  const before = Object.fromEntries(files.map((path) => [path, digest(root, path)]));
  const planned = json(await migrate(root, [], env));
  expect(planned.plan.hosts).toEqual([
    { host: 'codex', guard: 'none', files: files.map((path) => ({ path, action: 'update' })) },
  ]);
  const applied = await apply(root, [], env);
  expect(applied.exitCode, applied.stdout).toBe(0);
  // Every file the plan said the apply updates is rewritten, to the bytes its receipt lists.
  const receipt = JSON.parse(read(root, '.ia/distributions/hosts/codex-receipt.json'));
  for (const path of files) {
    expect(digest(root, path), path).not.toBe(before[path]);
    expect(receipt.files).toContainEqual({ path, sha256: digest(root, path) });
  }
});

it('leaves the migration and its capture in place when a projection apply fails, naming the host apply that finishes it', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  seams.failAt = 'pending';
  let failed: Result;
  try {
    failed = await apply(root, [], env);
  } finally {
    seams.failAt = undefined;
  }
  expect(failed.exitCode, failed.stdout).toBe(3);
  expect(json(failed)).toMatchObject({
    message: 'file write failed',
    next: `The workspace is migrated and captured. Repair the reported filesystem problem, then run "ia init ${quote(root)} --migrate --apply --yes" to finish migrating.`,
  });
  // Every earlier result stays (design §3); the guard was retired before the first projection file changed (B11).
  expect(existsSync(resolve(root, '.ia/src/notes.ia'))).toBe(true);
  expect(existsSync(resolve(root, FOLDER))).toBe(false);
  expect(existsSync(resolve(root, '.ia/work/snapshot/current.json'))).toBe(true);
  expect(guardGroups(root)).toBe(0);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  // The one command named, run as written with the answer it asks for, finishes the projection.
  const finished = await run([...nextArgv(json(failed).next), '--json'], { env });
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(JSON.parse(read(root, RECEIPT)).removed).toEqual([{ path: STEWARD, sha256: expect.any(String) }]);
});

it('refuses a projection file without a marker at a target path before anything is written, naming the host plan', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  put(root, '.claude/rules/ia-workspace.md', '# My own rules\n');
  const before = tree(root);
  // The plan lists it, with the planner's code and message.
  const planned = await migrate(root, [], env);
  expect(planned.exitCode).toBe(0);
  const conflict = {
    path: '.claude/rules/ia-workspace.md',
    reason: 'Refusing unmanaged file at a managed path: .claude/rules/ia-workspace.md',
    host: 'claude',
    code: 'IA-DIST-LOCAL-MODIFICATION',
  };
  expect(json(planned).plan.conflicts).toEqual([conflict]);
  expect(json(planned).plan.hosts).toEqual([]);
  expect((await run(['init', root, '--migrate'], { env })).stdout.replace(/\s+/g, ' ')).toContain(
    'Project Not planned: each registered projection conflicts, as listed above',
  );
  const refused = await apply(root, [], env);
  expect(refused.exitCode).toBe(3);
  // The refusal points to the host plan, which names each file it refuses.
  expect(json(refused)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    message: conflict.reason,
    where: { path: conflict.path },
    next: `Run "ia host claude --root ${quote(root)}" for its projection plan, which names each file it refuses.`,
  });
  expect(tree(root)).toEqual(before);
  const named = json(await run([...nextArgv(json(refused).next), '--json'], { env }));
  expect(named.plan.elements.find((row: { id: string }) => row.id === 'projection').conflict).toMatchObject({
    code: conflict.code,
    path: conflict.path,
  });
});

it('refuses a pending host journal once, located at the journal and naming its recovery, before anything is written', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  put(root, '.ia/distributions/hosts/pending.json', '{}\n');
  const before = tree(root);
  for (const extra of [[], ['--apply', '--yes']]) {
    const refused = await migrate(root, extra, env);
    expect(refused.exitCode, refused.stdout).toBe(3);
    expect(json(refused)).toMatchObject({
      code: 'IA-DIST-RECOVERY-REQUIRED',
      where: { path: '.ia/distributions/hosts/pending.json' },
      next: `Run "ia recover host --root ${quote(root)}", then rerun.`,
    });
  }
  expect(tree(root)).toEqual(before);
});

it('refuses the collision fixture with nothing written, naming the plan that lists each collision', async () => {
  const { root } = await legacyWorkspace(COLLISION);
  const before = tree(root);
  const reason = `Exists where the migration moves ${NOTES}`;
  const planned = await migrate(root);
  expect(planned.exitCode).toBe(0);
  expect(json(planned).plan.conflicts).toEqual([{ path: '.ia/src/notes.ia', reason }]);
  const human = (await run(['init', root, '--migrate'])).stdout.replace(/\s+/g, ' ');
  expect(human).toContain(`.ia/src/notes.ia ${reason}`);
  expect(human).toContain(`Resolve the conflicts above, then run "ia init ${quote(root)} --migrate --apply --yes".`);
  const refused = await apply(root);
  expect(refused.exitCode).toBe(3);
  expect(json(refused)).toMatchObject({
    code: 'IA-CLI-CONFLICT',
    message: `${reason}: .ia/src/notes.ia`,
    next: `Run "ia init ${quote(root)} --migrate" to review the plan and its conflicts.`,
  });
  expect(tree(root)).toEqual(before);
  // A file where the starter records go is a collision too, and both are listed.
  writeFileSync(resolve(root, '.ia/src/workspace.ia'), '#! ia 1.0\n');
  const both = json(await apply(root));
  expect(both.message).toContain('2 conflicts block the migration');
  expect(json(await migrate(root)).plan.conflicts.map((row: { path: string }) => row.path)).toEqual([
    '.ia/src/workspace.ia',
    '.ia/src/notes.ia',
  ]);
});

it('refuses a record holding the word and name of a starter record it authors, which would tie, with nothing written', async () => {
  const { root } = await legacyWorkspace();
  // `@agent demo` and `@mandate demo-mandate` admit in 1.1.0 beside the starter, which authors neither.
  put(
    root,
    `${FOLDER}/records/team.ia`,
    '#! ia 1.0\n\n@agent demo\n  meaning\n    says "The team\'s agent."\n    answers "Who acts here?"\n  governance\n    applies []\n\n@mandate demo-mandate\n  meaning\n    says "What the team\'s agent may do."\n    answers "Which moves?"\n  governance\n    requires "Act only on request."\n',
  );
  expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
  const before = tree(root);
  const conflicts = [
    {
      path: `${FOLDER}/records/team.ia`,
      reason: 'Holds @agent demo, which the migration authors in .ia/src/workspace.ia',
    },
    {
      path: `${FOLDER}/records/team.ia`,
      reason: 'Holds @mandate demo-mandate, which the migration authors in .ia/src/workspace.ia',
    },
  ];
  const planned = await migrate(root);
  expect(planned.exitCode).toBe(0);
  expect(json(planned).plan.conflicts).toEqual(conflicts);
  expect(json(planned).plan.moves).toContainEqual({
    from: `${FOLDER}/records/team.ia`,
    to: '.ia/src/team.ia',
    identities: ['agent-system/binding/agent/demo', 'agent-system/policy/mandate/demo-mandate'],
  });
  const refused = await apply(root);
  expect(refused.exitCode).toBe(3);
  expect(json(refused)).toMatchObject({
    code: 'IA-CLI-CONFLICT',
    message: `2 conflicts block the migration: ${conflicts.map((row) => `${row.path} (${row.reason})`).join('; ')}`,
    next: `Run "ia init ${quote(root)} --migrate" to review the plan and its conflicts.`,
  });
  expect(tree(root)).toEqual(before);
  // With --system the local @system and its steward stay where they are, so only the new records conflict.
  expect(json(await migrate(root, ['--system'])).plan.conflicts).toEqual(conflicts);
});

it('--migrate --system keeps a packable system: the @system and its steward stay, composed, under a re-rooted distribution', async () => {
  const { root } = await legacyWorkspace();
  const applied = await apply(root, ['--system']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(json(applied).plan).toMatchObject({
    system: true,
    writes: ['.ia/src/workspace.ia', `${FOLDER}/records/distribution.ia`],
    systems: [...base.systems, 'demo'],
    removes: [{ path: LEGACY, identities: [DISTRIBUTION, 'workspace-system/definition/workspace/demo'] }],
    descriptor: {
      before: DISTRIBUTION,
      after: DISTRIBUTION,
      dependencies: { before: LEGACY_DEPENDENCIES, after: BUNDLED_DEPENDENCIES },
    },
  });
  expect(json(applied).applied).toMatchObject({
    distribution: DISTRIBUTION,
    authored: [...AUTHORED, 'floor/definition/system/demo', 'agent-system/binding/agent/demo-steward', DISTRIBUTION],
    moved: [{ from: NOTES, to: '.ia/src/notes.ia', identities: [DECISION] }],
    removed: [LEGACY],
  });
  // The system file is kept as it was; the distribution is the one `ia init --system` writes, rooted at the system;
  // the @workspace composes the system; the descriptor keeps its distribution and updates the base dependency.
  expect(read(root, LOCAL)).toBe(fixture(LOCAL));
  expect(read(root, `${FOLDER}/records/distribution.ia`)).toBe(starterDistribution('demo'));
  expect(readdirSync(resolve(root, `${FOLDER}/records`))).toEqual(['distribution.ia']);
  expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', [...base.systems, 'demo']));
  expect(read(root, '.ia/release.json')).toBe(
    `${JSON.stringify({ ...JSON.parse(fixture('.ia/release.json')), dependencies: BUNDLED_DEPENDENCIES }, null, 2)}\n`,
  );
  expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
  // `ia pack` builds: the archive holds the system folder alone and externalizes the base.
  const packed = await run(['pack', '--root', root, '--descriptor', '.ia/release.json', '--json']);
  expect(packed.exitCode, packed.stderr).toBe(0);
  expect(json(packed).manifest).toMatchObject({
    distribution: DISTRIBUTION,
    roots: ['floor/definition/system/demo'],
    systems: [{ name: 'demo', path: FOLDER }],
  });
  expect(json(packed).manifest.files.map((file: { path: string }) => file.path)).toEqual([
    `${FOLDER}/records/distribution.ia`,
    LOCAL,
  ]);
  // Composed, the local system gets its pointer line in the packet (position-and-projection §2 case 2).
  expect(renderProjectionFor(root, 'claude').files[0]!.text).toContain(
    '- `floor/definition/system/demo`: words none; band 100; steward `agent-system/binding/agent/demo-steward`; reach `ia position --seat floor/definition/system/demo`',
  );
});

it("keeps the 1.1.0 workspace's own composition and descriptor id, whatever its directory is called", async () => {
  // A 1.1.0 workspace in a directory not named after it, whose @workspace drops a public system and composes its own
  // local system, and whose descriptor id is not `local/<name>`.
  const edited = async (): Promise<string> => {
    const root = resolve(scratch('migrate'), 'renamed');
    expect((await run(['init', root, '--id', 'local/demo', '--apply', '--yes', '--json'])).exitCode).toBe(0);
    layOver(root, []);
    const systems = (names: readonly string[]): string =>
      `    systems [${names.map((name) => `@system ${name}`).join(', ')}]\n`;
    writeFileSync(
      resolve(root, LEGACY),
      fixture(LEGACY).replace(
        systems(base.systems),
        systems([...base.systems.filter((name) => name !== 'learning-system'), 'demo']),
      ),
    );
    expect(read(root, LEGACY)).not.toBe(fixture(LEGACY));
    const descriptor = JSON.parse(read(root, '.ia/release.json'));
    writeFileSync(
      resolve(root, '.ia/release.json'),
      `${JSON.stringify({ ...descriptor, id: 'local/other-id' }, null, 2)}\n`,
    );
    expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
    return root;
  };
  const kept = base.systems.filter((name) => name !== 'learning-system');
  // Without --system the local system leaves the composition with its folder; with it, it is composed once, last.
  for (const [extra, systems] of [
    [[], kept],
    [['--system'], [...kept, 'demo']],
  ] as const) {
    const root = await edited();
    const applied = await apply(root, extra);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(json(applied).plan).toMatchObject({ id: 'local/other-id', name: 'demo', systems });
    expect(json(applied).applied.id).toBe('local/other-id');
    expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', systems));
    expect(JSON.parse(read(root, '.ia/release.json')).id).toBe('local/other-id');
    expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
  }
});

it('refuses a workspace that is not 1.1.0-shaped before anything is written, naming ia init --help', async () => {
  const refuses = async (root: string, reason: string, path: string): Promise<void> => {
    const before = tree(root);
    for (const extra of [[], ['--apply', '--yes']]) {
      const refused = await migrate(root, extra);
      expect(refused.exitCode, reason).toBe(3);
      expect(json(refused), reason).toMatchObject({
        code: 'IA-CLI-CONFLICT',
        message: `The target is not a 1.1.0 starter workspace: ${reason}`,
        where: { path },
      });
      expect(commandsIn(json(refused).next), reason).toEqual(['ia init --help']);
    }
    expect(tree(root), reason).toEqual(before);
  };
  // A workspace this release initializes has no local system.
  const fresh = await initialized();
  await refuses(fresh.root, '.ia/src/systems/ is absent, so it has no local system', realpathSync(fresh.root));
  // Anything in the system folder but system.ia and records/*.ia, a nested folder included.
  const readme = await legacyWorkspace();
  put(readme.root, `${FOLDER}/README.md`, 'notes\n');
  await refuses(
    readme.root,
    `${FOLDER}/README.md is not part of one, whose system folder holds only system.ia and records/*.ia`,
    `${FOLDER}/README.md`,
  );
  const nested = await legacyWorkspace();
  mkdirSync(resolve(nested.root, `${FOLDER}/records/more`));
  await refuses(
    nested.root,
    `${FOLDER}/records/more is not part of one, whose system folder holds only system.ia and records/*.ia`,
    `${FOLDER}/records/more`,
  );
  const nonIa = await legacyWorkspace();
  put(nonIa.root, `${FOLDER}/records/notes.md`, 'notes\n');
  await refuses(
    nonIa.root,
    `${FOLDER}/records/notes.md is not part of one, whose system folder holds only system.ia and records/*.ia`,
    `${FOLDER}/records/notes.md`,
  );
  for (const missing of [LOCAL, `${FOLDER}/records`, LEGACY]) {
    const workspace = await legacyWorkspace();
    rmSync(resolve(workspace.root, missing), { recursive: true });
    await refuses(workspace.root, `${missing === LOCAL ? LOCAL : LEGACY} is absent`, FOLDER);
  }
  // A second system folder.
  const second = await legacyWorkspace();
  mkdirSync(resolve(second.root, '.ia/src/systems/other'));
  await refuses(
    second.root,
    '.ia/src/systems/ holds demo, other, where a 1.1.0 starter holds one folder, its local system',
    '.ia/src/systems',
  );
  // Any other record in system.ia or records/workspace.ia.
  const record = (word: string, name: string): string =>
    `\n@${word} ${name}\n  meaning\n    says "Another record."\n    answers "Which?"\n${word === 'agent' ? '  governance\n    applies []\n' : ''}`;
  const local = await legacyWorkspace();
  writeFileSync(resolve(local.root, LOCAL), fixture(LOCAL) + record('agent', 'helper'));
  await refuses(
    local.root,
    `${LOCAL} holds @agent demo-steward, @agent helper, @system demo, where a 1.1.0 starter's holds exactly @system demo and @agent demo-steward`,
    LOCAL,
  );
  const legacy = await legacyWorkspace();
  writeFileSync(
    resolve(legacy.root, LEGACY),
    fixture(LEGACY) + readFileSync(resolve(COLLISION, '.ia/src/notes.ia'), 'utf8').slice('#! ia 1.0\n'.length),
  );
  await refuses(
    legacy.root,
    `${LEGACY} holds @decision release-cadence, @distribution demo-distribution, @workspace demo, where a 1.1.0 starter's holds exactly @workspace demo and @distribution demo-distribution`,
    LEGACY,
  );
  // A local @system that registers words owns vocabulary, which stays in its folder.
  const words = await legacyWorkspace();
  writeFileSync(
    resolve(words.root, LOCAL),
    fixture(LOCAL)
      .replace(
        '    - workspace-system\n',
        '    - workspace-system\n  discriminators\n    note lowers to definition\n      category thing\n      facets [note]\n      schema @schema note\n',
      )
      .replace('    applies []', '    applies [note]'),
  );
  put(
    words.root,
    `${FOLDER}/records/note.schema.ia`,
    '#! ia 1.0\n\n@schema note\n  lowers to definition\n  sections\n    must have meaning\n    closed\n  fields\n    must have meaning.says as text\n',
  );
  expect((await run(['validate', '--root', words.root, '--json'])).exitCode).toBe(0);
  await refuses(words.root, "its local @system demo registers note, where a 1.1.0 starter's registers no word", LOCAL);
  // A descriptor that names no distribution, another one or none that decodes, and a target never initialized.
  const unnamed = await legacyWorkspace();
  writeFileSync(resolve(unnamed.root, '.ia/release.json'), undistributed());
  await refuses(
    unnamed.root,
    ".ia/release.json names no distribution, where a 1.1.0 starter's names its own",
    '.ia/release.json',
  );
  const another = await legacyWorkspace();
  const elsewhere = 'workspace-system/definition/distribution/other-distribution';
  writeFileSync(
    resolve(another.root, '.ia/release.json'),
    fixture('.ia/release.json').replace(DISTRIBUTION, elsewhere),
  );
  await refuses(
    another.root,
    `.ia/release.json names ${elsewhere}, where a 1.1.0 starter's names ${DISTRIBUTION}`,
    '.ia/release.json',
  );
  const undecoded = await legacyWorkspace();
  writeFileSync(resolve(undecoded.root, '.ia/release.json'), '{}\n');
  let decoding = '';
  try {
    decodeReleaseDescriptor({});
  } catch (error) {
    decoding = (error as Error).message;
  }
  expect(decoding).not.toBe('');
  await refuses(undecoded.root, `.ia/release.json is not a release descriptor (${decoding})`, '.ia/release.json');
  const empty = resolve(fresh.root, '..', 'empty');
  mkdirSync(empty);
  await refuses(empty, '.ia/release.json is absent, so no initialization completed here', realpathSync(empty));
});

it('refuses a 1.1.0 workspace that does not admit before anything is written, naming ia validate', async () => {
  const { root } = await legacyWorkspace();
  writeFileSync(resolve(root, NOTES), fixture(NOTES).replace('status made', 'status finished'));
  const before = tree(root);
  const refused = await apply(root);
  expect(refused.exitCode).toBe(3);
  expect(json(refused)).toMatchObject({
    code: 'IA-CLI-CONFLICT',
    message: 'The workspace does not admit; migrating it needs zero error findings',
    next: `Run "ia validate --root ${quote(root)}" and fix the reported errors.`,
  });
  expect(tree(root)).toEqual(before);
});

it('asks once on a terminal, and a declined question writes nothing', async () => {
  const { root } = await legacyWorkspace(),
    before = tree(root),
    prompts: string[] = [];
  const declined = await run(['init', root, '--migrate', '--apply'], { interactive: true, answers: ['n'], prompts });
  expect(declined.exitCode).toBe(0);
  expect(declined.stdout).toContain('Nothing was applied.');
  expect(declined.stdout.replace(/\s+/g, ' ')).toContain(
    `Apply with "ia init ${quote(root)} --migrate --apply --yes".`,
  );
  // The question shows the plan's own blocks.
  expect(prompts.join('')).toContain('Records');
  expect(prompts.at(-1)).toBe('Apply these changes? [y/N] ');
  expect(tree(root)).toEqual(before);
  const accepted = await run(['init', root, '--migrate', '--apply'], { interactive: true, answers: ['yes'] });
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain('Migrated local/demo from the 1.1.0 starter');
});

it('leaves the workspace byte-identical when the signal arrives before the first write', async () => {
  const { root } = await legacyWorkspace(),
    before = tree(root),
    controller = new AbortController();
  const terminal = makeHost({ interactive: true });
  const result = await dispatch(
    ['init', root, '--migrate', '--apply'],
    {
      ...terminal,
      signal: controller.signal,
      interaction: {
        ...terminal.interaction,
        read: async () => {
          controller.abort();
          return 'yes';
        },
      },
    },
    () => {
      throw new Error('Unexpected machine route');
    },
    [],
  );
  expect(result).toEqual({
    exitCode: 130,
    stdout: '',
    stderr: `Interrupted. Run "ia init ${quote(root)} --migrate --apply" again.\n`,
  });
  expect(tree(root)).toEqual(before);
});

it('stops at the capture boundary on a signal once migrated, naming ia capture, which finishes it', async () => {
  const { root } = await legacyWorkspace(),
    controller = new AbortController();
  const interrupted = applyMigration(collectMigration({ root, packageRoot: cli }), {
    packageRoot: cli,
    signal: controller.signal,
    checkpoint: (name) => {
      if (name === 'migrate:admission') controller.abort();
    },
  });
  await expect(interrupted).rejects.toBeInstanceOf(Interrupted);
  await expect(interrupted).rejects.toMatchObject({
    next: `The workspace is migrated. Run "ia init ${quote(root)} --migrate --apply --yes" to finish migrating.`,
  });
  expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', base.systems));
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  const captured = await run([...nextArgv(`Run "ia capture --root ${quote(root)}"`), '--json']);
  expect(captured.exitCode, captured.stdout).toBe(0);
  expect(existsSync(resolve(root, '.ia/work/snapshot/current.json'))).toBe(true);
});

it('leaves the migration in place when its capture fails, with the location and repair ia capture gives', async () => {
  const { root } = await legacyWorkspace();
  // A file where the snapshot directory goes: the capture's own path check refuses it before writing anything.
  writeFileSync(resolve(root, '.ia/work'), 'not a directory\n');
  const refused = await apply(root);
  expect(refused.exitCode, refused.stdout).toBe(3);
  const repair = `Replace or remove the path named above, so .ia/work/snapshot is a plain directory holding plain files, then run "ia init ${quote(root)} --migrate --apply --yes".`;
  expect(json(refused)).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    where: { path: '.ia/work' },
    next: `The workspace is migrated. ${repair}`,
  });
  expect(read(root, '.ia/src/workspace.ia')).toBe(starterRecords('demo', base.systems));
  expect(existsSync(resolve(root, '.ia/src/notes.ia'))).toBe(true);
  // Following the repair and the one command named finishes the migration.
  rmSync(resolve(root, '.ia/work'));
  expect((await run(nextArgv(json(refused).next))).exitCode).toBe(0);
  expect(existsSync(resolve(root, '.ia/work/snapshot/current.json'))).toBe(true);
});

it('says which writes and deletes a file step made when a later one fails, since nothing is rolled back', async () => {
  const { root } = await legacyWorkspace();
  const view = collectMigration({ root, packageRoot: cli, invocation: `ia init ${quote(root)} --migrate` });
  await expect(
    applyMigration(view, {
      packageRoot: cli,
      checkpoint: (name) => {
        if (name === 'migrate:author') throw new Error('disk full');
      },
    }),
  ).rejects.toMatchObject({
    message: 'disk full',
    next: expect.stringContaining(`ia init ${quote(root)} --migrate --apply --yes`),
  });
  expect(existsSync(resolve(root, LOCAL))).toBe(true);
  expect(existsSync(resolve(root, '.ia/src/workspace.ia'))).toBe(true);
});

it('says neither effect ran when the migrated workspace fails admission, naming ia validate', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  // A record that fails admission, written once the file steps are done: no preflight can see it.
  const broken = (name: string): void => {
    if (name === 'migrate:descriptor')
      put(root, '.ia/src/broken.ia', fixture(NOTES).replace('api-response-format', 'broken').replace('made', 'done'));
  };
  await expect(
    applyMigration(collectMigration({ root, packageRoot: cli }), { packageRoot: cli, checkpoint: broken }),
  ).rejects.toMatchObject({
    code: 'IA-CLI-FAILED',
    message: expect.stringMatching(/^The migrated workspace failed admission with \d+ error findings; first: IA-/),
    next: `The workspace is migrated but neither captured nor projected. Run "ia validate --root ${quote(root)}" for the findings.`,
  });
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  expect(guardGroups(root)).toBe(1);
});

it('takes --migrate with --system only, and documents it in the verb help', async () => {
  const { root } = await legacyWorkspace();
  for (const extra of [
    ['--id', 'local/other'],
    ['--host', 'claude'],
    ['--host', 'none'],
    ['--decline', 'today'],
  ]) {
    const refused = await migrate(root, extra);
    expect(refused.exitCode, extra.join(' ')).toBe(2);
    expect(json(refused).code, extra.join(' ')).toBe('IA-CLI-USAGE');
  }
  const help = await run(['init', '--help']);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('ia init [<directory>] --migrate [--system] [--apply] [--json] [--yes]');
  expect(help.stdout.replace(/\s+/g, ' ')).toContain(
    'Rewrite a 1.1.0 starter workspace into the three starter records',
  );
});

it('refuses every authored starter edit before plan or apply writes, including --system distribution customization', async () => {
  for (const edit of [
    (text: string) => text.replace('The demo workspace and the public systems it composes.', 'Our billing platform.'),
    (text: string) => text.replace('Which systems does this workspace compose?', 'Who owns billing?'),
    (text: string) => text.replace('@workspace demo', '# authored comment\n@workspace demo'),
    (text: string) =>
      text.replace('\n@distribution', '\n  relationships\n    cite @decision api-response-format\n\n@distribution'),
    (text: string) =>
      text.replace('records [@workspace demo]', 'records [@workspace demo, @decision api-response-format]'),
    (text: string) => text.replace('The release root of the demo workspace.', 'Our custom release.'),
  ]) {
    for (const system of [[], ['--system']]) {
      const { root } = await legacyWorkspace();
      put(root, LEGACY, edit(fixture(LEGACY)));
      const before = tree(root);
      const planned = json(await migrate(root, system));
      expect(planned.plan.conflicts).toContainEqual({
        path: LEGACY,
        reason: expect.stringContaining('Authored workspace or distribution text'),
      });
      expect((await apply(root, system)).exitCode).toBe(3);
      expect(tree(root)).toEqual(before);
    }
  }
});

it('resumes exact journal-owned states after every individual mutation and refuses edited destinations', async () => {
  const first = await legacyWorkspace();
  const checkpoints: string[] = [];
  await applyMigration(collectMigration({ root: first.root, packageRoot: cli }), {
    packageRoot: cli,
    checkpoint: (name) => {
      if (name.startsWith('migrate:mutation:')) checkpoints.push(name);
    },
  });
  expect(checkpoints.length).toBeGreaterThan(8);
  for (const cut of checkpoints) {
    const { root } = await legacyWorkspace();
    await expect(
      applyMigration(collectMigration({ root, packageRoot: cli }), {
        packageRoot: cli,
        checkpoint: (name) => {
          if (name === cut) throw new Error('process stopped before cursor write');
        },
      }),
    ).rejects.toThrow('process stopped');
    const before = tree(root);
    expect((await migrate(root)).exitCode).toBe(0);
    expect(tree(root)).toEqual(before);
    expect((await apply(root)).exitCode).toBe(0);
    expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
    expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
  }
  const { root } = await legacyWorkspace();
  await expect(
    applyMigration(collectMigration({ root, packageRoot: cli }), {
      packageRoot: cli,
      checkpoint: (name) => {
        if (name === 'migrate:move') throw new Error('stop');
      },
    }),
  ).rejects.toThrow();
  put(root, '.ia/src/notes.ia', '# changed destination\n');
  const changed = tree(root);
  expect((await apply(root)).exitCode).toBe(3);
  expect(tree(root)).toEqual(changed);
});

it.each([
  ['demo-steward', 'demo-distribution'],
  ['Demo-Steward', 'Demo-Distribution'],
  ['DEMO-STEWARD', 'DEMO-DISTRIBUTION'],
])('preflights kept references to deleted identities with spelling %s / %s', async (agent, distribution) => {
  const { root } = await legacyWorkspace();
  put(
    root,
    '.ia/src/profile.ia',
    `#! ia 1.0

@agent-profile custom-profile
  meaning
    says "A retained profile."
    answers "Who acts?"
  composition
    agent @agent ${agent}
    capabilities []
  execution
    role reader
    outcomes custom-outcomes
    mandate-contract custom-contract
  relationships
    cite @distribution ${distribution}
`,
  );
  const admitted = await run(['validate', '--root', root, '--json']);
  expect(admitted.exitCode, admitted.stdout).toBe(0);
  const before = tree(root);
  const result = await migrate(root);
  expect(result.exitCode, result.stdout).toBe(0);
  const planned = json(result);
  expect(planned.plan.conflicts).toEqual(
    expect.arrayContaining([
      { path: '.ia/src/profile.ia', reason: expect.stringContaining('agent-system/binding/agent/demo-steward') },
      { path: '.ia/src/profile.ia', reason: expect.stringContaining(DISTRIBUTION) },
    ]),
  );
  expect((await apply(root)).exitCode).toBe(3);
  expect(tree(root)).toEqual(before);
  expect((await apply(root, ['--system'])).exitCode).toBe(0);
  expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
});

it('keeps tracked generations committable and refuses existing ignore rules that hide new payload', async () => {
  const { root } = await onLegacyBase();
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  put(root, '.gitattributes', '.ia/** -text\n');
  git('add', '-A');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'legacy');
  const peer = resolve(scratch('migration-peer'), 'peer');
  execFileSync('git', ['clone', '-q', root, peer], { windowsHide: true });
  const baseline = await run(['position', '--root', peer, '--json']);
  expect(baseline.exitCode, baseline.stdout).toBe(0);
  for (const rule of ['schemas/', '*.schema.ia', 'inputs.json']) {
    put(root, '.gitignore', `${rule}\n`);
    const before = tree(root);
    const conflict = json(await migrate(root));
    expect(conflict.plan.conflicts).toContainEqual({
      path: '.ia/distributions',
      reason: expect.stringContaining('Git ignore rule'),
    });
    expect((await apply(root)).exitCode).toBe(3);
    expect(tree(root)).toEqual(before);
  }
  rmSync(resolve(root, '.gitignore'));
  put(root, '.gitattributes', '.ia/** -text\n*.schema.ia text eol=crlf\n');
  const converted = tree(root);
  expect(json(await migrate(root)).plan.conflicts).toContainEqual({
    path: '.gitattributes',
    reason: expect.stringContaining('Git may rewrite tracked immutable installation bytes'),
  });
  expect((await apply(root)).exitCode).toBe(3);
  expect(tree(root)).toEqual(converted);
  put(root, '.gitattributes', '.ia/** -text\n');
  for (const rule of ['distributions/', 'distributions/store/', 'distributions/generations/']) {
    put(root, '.ia/.gitignore', `work/\n${rule}\n`);
    const before = tree(root);
    const conflict = json(await migrate(root));
    expect(conflict.plan.conflicts).toContainEqual({
      path: '.ia/distributions',
      reason: expect.stringContaining('Git ignore rule'),
    });
    expect((await apply(root)).exitCode).toBe(3);
    expect(tree(root)).toEqual(before);
  }
  rmSync(resolve(root, '.ia/.gitignore'));
  expect((await apply(root)).exitCode).toBe(0);
  expect(read(root, '.ia/.gitignore')).toBe('work/\n');
  git('add', '-A');
  const clone = resolve(scratch('migration-clone'), 'clone');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'migrated');
  execFileSync('git', ['clone', '-q', root, clone], { windowsHide: true });
  execFileSync('git', ['-C', peer, 'pull', '--ff-only', '-q'], { windowsHide: true });
  const pulled = await run(['position', '--root', peer, '--json']);
  expect(pulled.exitCode, pulled.stdout).toBe(0);
  const positioned = await run(['position', '--root', clone, '--json']);
  expect(positioned.exitCode, positioned.stdout).toBe(0);
});

it('resumes files with spaces and Unicode and every effect boundary using the printed command', async () => {
  for (const cut of ['migrate:admission', 'migrate:capture', 'migrate:complete']) {
    const { root } = await legacyWorkspace();
    const extra = `${FOLDER}/records/notes espace-é.ia`;
    put(root, extra, fixture(NOTES).replace('api-response-format', 'second-decision'));
    let next = '';
    try {
      await applyMigration(collectMigration({ root, packageRoot: cli }), {
        packageRoot: cli,
        checkpoint: (name) => {
          if (name === cut) throw new Error('cut');
        },
      });
    } catch (error) {
      next = (error as { next: string }).next;
    }
    expect(next).toContain('--migrate --apply --yes');
    expect((await run([...nextArgv(next), '--json'])).exitCode).toBe(0);
    expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
    expect(existsSync(resolve(root, '.ia/src/notes espace-é.ia'))).toBe(true);
  }
});

it('recovers real process termination between each filesystem mutation and journal cursor publication', async () => {
  const reference = await legacyWorkspace();
  let count = 0;
  await applyMigration(collectMigration({ root: reference.root, packageRoot: cli }), {
    packageRoot: cli,
    checkpoint: (name) => {
      if (name.startsWith('migrate:mutation:')) count++;
    },
  });
  for (const cut of [
    ...Array.from({ length: count }, (_, index) => `migrate:mutation:${index}`),
    'migrate:capture',
    'migrate:complete',
  ]) {
    const { root } = await legacyWorkspace();
    const child = spawnSync(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', 'tests/init-migrate-kill.ts', root, cut],
      { cwd: cli, windowsHide: true, timeout: 60_000, encoding: 'utf8' },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).not.toBe(0);
    const reached = JSON.parse(child.stdout.trim());
    expect(reached.pid).toBe(child.pid);
    expect(reached.checkpoint === cut || reached.checkpoint.startsWith(`${cut}:`)).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(existsSync(resolve(root, '.ia/migration.json')), cut).toBe(true);
    const finished = await apply(root);
    expect(finished.exitCode, `${cut}: ${finished.stdout}`).toBe(0);
    expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
    expect((await run(['position', '--root', root, '--json'])).exitCode).toBe(0);
  }
}, 180_000);

it('keeps completed migration projection receipts through every projection and final journal boundary', async () => {
  for (const cut of [
    'migrate:project:claude:receipt',
    'migrate:project:claude',
    'migrate:project',
    'migrate:complete',
  ]) {
    const { root, env } = await legacyWorkspace();
    await registered(root, env);
    await expect(
      applyMigration(collectMigration({ root, packageRoot: cli }), {
        packageRoot: cli,
        checkpoint: (name) => {
          if (name === cut) throw new Error('cut after projection');
        },
      }),
    ).rejects.toThrow('cut after projection');
    const receipt = read(root, RECEIPT);
    expect(JSON.parse(receipt).guard).toBe('retired');
    const finished = await apply(root);
    expect(finished.exitCode, finished.stdout).toBe(0);
    expect(read(root, RECEIPT), cut).toBe(receipt);
    expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
  }
});

it('migrates an already absent owned steward without inventing deletion evidence', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  rmSync(resolve(root, STEWARD));
  const planned = collectMigration({ root, packageRoot: cli });
  expect(planned.conflicts).toEqual([]);
  expect(planned.hosts[0]!.files).toContainEqual(expect.objectContaining({ path: STEWARD, action: 'remove' }));
  const finished = await apply(root);
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'retired', removed: [] });
  expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
});

it('carries prior interrupted projection provenance into migration and its printed retry', async () => {
  const { root, env } = await legacyWorkspace();
  await registered(root, env);
  const expected = { path: STEWARD, sha256: sha256(Buffer.from(read(root, STEWARD))) };
  expect(() =>
    applyHostProjection(root, 'claude', renderProjectionFor(root, 'claude'), (stage) => {
      if (stage === 'complete') throw new Error('projection interrupted before receipt');
    }),
  ).toThrow('projection interrupted');
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
  let next = '';
  try {
    await applyMigration(collectMigration({ root, packageRoot: cli }), {
      packageRoot: cli,
      checkpoint: (stage) => {
        if (stage === 'migrate:complete') throw new Error('migration interrupted');
      },
    });
  } catch (error) {
    expect(error).toMatchObject({ message: 'migration interrupted' });
    next = (error as { next: string }).next;
  }
  expect(next).toContain('--migrate --apply --yes');
  const receipt = read(root, RECEIPT);
  expect(JSON.parse(receipt)).toMatchObject({ guard: 'retired', removed: [expected] });
  const finished = await run([...nextArgv(next), '--json']);
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(read(root, RECEIPT)).toBe(receipt);
  expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
});

it('refreshes completed migration host notes after capture repair while preserving evidence and refusing edits', async () => {
  for (const mode of ['clean', 'edit', 'interrupted-refresh']) {
    const edit = mode === 'edit';
    const { root, env } = await legacyWorkspace();
    await registered(root, env);
    expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
    const capturePath = resolve(root, '.ia/work/snapshot/current.json');
    rmSync(capturePath, { force: true });
    mkdirSync(capturePath, { recursive: true });
    const failed = await apply(root);
    expect(failed.exitCode, failed.stdout).toBe(3);
    const original = JSON.parse(read(root, RECEIPT));
    expect(original).toMatchObject({ guard: 'retired', removed: [{ path: STEWARD, sha256: expect.any(String) }] });
    rmdirSync(capturePath);
    const projectedPath = original.files[0].path;
    const originalText = read(root, projectedPath);
    if (edit) put(root, projectedPath, `${originalText}user edit\n`);
    const retry = () => run([...nextArgv(json(failed).next), '--json']);
    if (edit) {
      const refused = await retry();
      expect(refused.exitCode, refused.stdout).toBe(3);
      expect(read(root, projectedPath)).toBe(`${originalText}user edit\n`);
      expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(true);
      put(root, projectedPath, originalText);
    }
    if (mode === 'interrupted-refresh') {
      seams.failAt = 'complete';
      try {
        const interrupted = await retry();
        expect(interrupted.exitCode, interrupted.stdout).toBe(3);
        expect(json(interrupted).next).toContain('--migrate --apply --yes');
        expect(existsSync(resolve(root, RECEIPT))).toBe(false);
      } finally {
        seams.failAt = undefined;
      }
    }
    const finished = await retry();
    expect(finished.exitCode, finished.stdout).toBe(0);
    const receipt = JSON.parse(read(root, RECEIPT));
    expect(receipt.guard).toBe(original.guard);
    expect(receipt.removed).toEqual(original.removed);
    for (const selected of ['claude', 'codex'] as const) {
      const rendered = renderProjectionFor(root, selected);
      expect(
        planFiles(root, selected, rendered).actions.every(
          (action) => action.action === 'unchanged' || action.action === 'foreign',
        ),
      ).toBe(true);
      const current = JSON.parse(read(root, `.ia/distributions/hosts/${selected}-receipt.json`));
      expect(current.files).toEqual(rendered.receipt.files);
    }
    expect(existsSync(resolve(root, '.ia/migration.json'))).toBe(false);
  }
});
