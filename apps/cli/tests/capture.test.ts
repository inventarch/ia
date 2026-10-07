/**
 * `ia capture` (position-and-projection §5, design rows 3 and 20) and its deprecated `ia compile` alias (decision
 * compile-verb-fate), end to end against copies of the committed loop fixture.
 *
 * The exit evidence of plan task ia-capture-verb: two captures with no edit between them report 0 changed, and an edit
 * reports exactly the edited record changed and rotates the prior capture into `previous.json`, as db D08 rotates its
 * retained pair.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { sha256 } from '@inventarch/distribution/services';
import { CURRENT, PREVIOUS, SNAPSHOT_DIRECTORY, SNAPSHOT_FORMAT } from '../src/capture.js';
import { DEFAULT_OUT, DEPRECATION } from '../src/compile.js';
import { quote } from '../src/render.js';
import { cleanup, commandsIn, nextArgv, run, scratch, workspace } from './workspace-fixture.js';

afterAll(cleanup);

/** A record nothing else in the fixture names, so an edit to it changes its digest and no other. */
const PRINCIPLE = '.ia/src/systems/governance-system/records/sample-principle.ia';
const ADDED = '.ia/src/systems/governance-system/records/added-principle.ia';

interface Envelope {
  readonly version: number;
  readonly snapshot: string;
  readonly format: string;
  readonly revision: string;
  readonly digest: string;
  readonly records: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly new: number;
  readonly removed: number;
  readonly prior: string | null;
  readonly ignored: string | null;
  readonly previous: { readonly path: string; readonly revision: string } | null;
  readonly rotated: boolean;
  readonly admission: {
    readonly status: string;
    readonly errors: number;
    readonly warnings: number;
    readonly notEvaluated: number;
  };
}
interface Finding {
  readonly path: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
  readonly severity: string;
}
interface SnapshotFile {
  readonly format: string;
  readonly language: string;
  readonly kernelDigest: string;
  readonly revision: string;
  readonly records: readonly { readonly identity: string; readonly digest: string }[];
  readonly membership: readonly {
    readonly identity: string;
    readonly root: string;
    readonly band: number;
    readonly digest: string;
  }[];
  readonly diagnostics: readonly Finding[];
  readonly counts: Readonly<Record<string, number>>;
}

/** `ia capture --json`: one value on stdout and nothing on stderr. */
async function capture(root: string, exitCode = 0): Promise<Envelope> {
  const result = await run(['capture', '--root', root, '--json']);
  expect(result.exitCode, result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.endsWith('\n')).toBe(true);
  expect(result.stdout.slice(0, -1)).not.toContain('\n');
  return JSON.parse(result.stdout) as Envelope;
}
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The order the SPEC states for `diagnostics`: by path, line, code and message. */
const ordered = (findings: readonly Finding[]): readonly Finding[] =>
  [...findings].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
  );
const bytesAt = (root: string, path: string): Buffer => readFileSync(resolve(root, path));
const snapshotAt = (root: string, path = CURRENT): SnapshotFile =>
  JSON.parse(bytesAt(root, path).toString('utf8')) as SnapshotFile;
const digests = (snapshot: SnapshotFile): ReadonlyMap<string, string> =>
  new Map(snapshot.membership.map((row) => [row.identity, row.digest]));
/** Every file below `directory` with its bytes, so a capture is shown to leave `.ia/src` exactly as it was. */
const tree = (directory: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((dirent) => dirent.isFile())
      .map((dirent) => {
        const path = join(dirent.parentPath, dirent.name);
        return [path, readFileSync(path, 'utf8')];
      }),
  );
const edit = (root: string): void => {
  const path = resolve(root, PRINCIPLE),
    text = readFileSync(path, 'utf8');
  const edited = text.replace('"Sample fixture statement 3."', '"Sample fixture statement 3, edited."');
  if (edited === text) throw new Error(`${PRINCIPLE} no longer contains the line this test edits`);
  writeFileSync(path, edited);
};

it('writes the first capture with per-record digests and membership, and compares it with nothing', async () => {
  const root = workspace(),
    sources = tree(resolve(root, '.ia/src'));
  const first = await capture(root);
  // The --json shape: the effect, then validation apart from it under `admission`.
  expect(Object.keys(first)).toEqual([
    'version',
    'snapshot',
    'format',
    'revision',
    'digest',
    'records',
    'changed',
    'unchanged',
    'new',
    'removed',
    'prior',
    'ignored',
    'previous',
    'rotated',
    'admission',
  ]);
  expect(first).toMatchObject({
    version: 1,
    snapshot: resolve(realpathSync(root), CURRENT),
    format: SNAPSHOT_FORMAT,
    changed: 0,
    unchanged: 0,
    removed: 0,
    prior: null,
    ignored: null,
    previous: null,
    rotated: false,
    admission: { status: 'admitted', errors: 0 },
  });
  expect(first.records).toBeGreaterThan(0);
  // With nothing to compare with, every record is new.
  expect(first.new).toBe(first.records);
  expect(first.revision).toMatch(/^[0-9a-f]{64}$/);

  const bytes = bytesAt(root, CURRENT);
  expect(sha256(bytes)).toBe(first.digest);
  const snapshot = snapshotAt(root);
  expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
  expect(snapshot.language).toBe('1.0');
  expect(snapshot.kernelDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(snapshot.revision).toBe(first.revision);
  expect(Object.keys(snapshot)).toEqual([...Object.keys(snapshot)].sort());
  expect(bytes.toString('utf8').endsWith('}\n')).toBe(true);
  // One membership row per admitted record, both sorted by identity, each carrying the record's own digest.
  const identities = snapshot.records.map((record) => record.identity);
  expect(identities).toEqual([...identities].sort());
  expect(snapshot.records).toHaveLength(first.records);
  expect(snapshot.membership.map((row) => row.identity)).toEqual(identities);
  for (const [index, record] of snapshot.records.entries()) {
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.membership[index]!.digest).toBe(record.digest);
  }
  expect(snapshot.membership.find((row) => row.identity.endsWith('/sample-principle'))).toMatchObject({
    root: '.ia/src/systems/governance-system',
    band: 100,
  });
  // The admission findings travel in the snapshot, never rolled into a pass.
  expect(snapshot.counts).toEqual({
    records: first.records,
    errors: 0,
    warnings: first.admission.warnings,
    notEvaluated: first.admission.notEvaluated,
  });
  expect(snapshot.counts['notEvaluated']).toBeGreaterThan(0);
  expect(snapshot.diagnostics.some((finding) => finding.code === 'IA-COMP-NOT-EVALUATED')).toBe(true);
  // Findings at more than one location, so their stated order is observable.
  expect(new Set(snapshot.diagnostics.map((finding) => `${finding.path}:${finding.line}`)).size).toBeGreaterThan(1);
  expect(snapshot.diagnostics).toEqual(ordered(snapshot.diagnostics));
  // Only the snapshot is written: no previous capture, no temporary file left, nothing else under .ia/work, no source.
  expect(readdirSync(resolve(root, '.ia/work'))).toEqual(['snapshot']);
  expect(readdirSync(resolve(root, SNAPSHOT_DIRECTORY))).toEqual(['current.json']);
  expect(tree(resolve(root, '.ia/src'))).toEqual(sources);
});

it('reports 0 changed for a second capture with no edit, and writes the same bytes', async () => {
  const root = workspace();
  const first = await capture(root),
    bytes = bytesAt(root, CURRENT),
    written = statSync(resolve(root, CURRENT)).mtimeMs;
  const second = await capture(root);
  expect(second).toMatchObject({
    revision: first.revision,
    digest: first.digest,
    records: first.records,
    changed: 0,
    unchanged: first.records,
    new: 0,
    removed: 0,
    prior: first.revision,
    previous: null,
    rotated: false,
  });
  expect(bytesAt(root, CURRENT)).toEqual(bytes);
  // As db D08 publishes its derived files, equal bytes are not rewritten.
  expect(statSync(resolve(root, CURRENT)).mtimeMs).toBe(written);
  expect(existsSync(resolve(root, PREVIOUS))).toBe(false);
});

it('reports exactly the edited record changed and rotates the prior capture into previous.json', async () => {
  const root = workspace();
  const first = await capture(root),
    before = bytesAt(root, CURRENT);
  edit(root);
  const edited = await capture(root);
  expect(edited.revision).not.toBe(first.revision);
  expect(edited).toMatchObject({
    records: first.records,
    changed: 1,
    unchanged: first.records - 1,
    new: 0,
    removed: 0,
    prior: first.revision,
    previous: { path: resolve(realpathSync(root), PREVIOUS), revision: first.revision },
    rotated: true,
  });
  // previous.json is the prior capture byte for byte, and only the edited record's digest differs from it.
  expect(bytesAt(root, PREVIOUS)).toEqual(before);
  const was = digests(snapshotAt(root, PREVIOUS)),
    now = digests(snapshotAt(root));
  const moved = [...now].filter(([identity, digest]) => was.get(identity) !== digest).map(([identity]) => identity);
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatch(/\/sample-principle$/);

  // A capture at an unchanged revision keeps previous.json as it is and reports nothing changed.
  const kept = bytesAt(root, PREVIOUS);
  const again = await capture(root);
  expect(again).toMatchObject({
    revision: edited.revision,
    changed: 0,
    unchanged: first.records,
    prior: edited.revision,
    previous: { revision: first.revision },
    rotated: false,
  });
  expect(bytesAt(root, PREVIOUS)).toEqual(kept);
  // The revision keys rotation, not the digests, as it keys db D08's: an edit that moves no record's digest still
  // rotates the prior capture into previous.json.
  const unmoved = bytesAt(root, CURRENT);
  writeFileSync(resolve(root, PRINCIPLE), `${readFileSync(resolve(root, PRINCIPLE), 'utf8')}\n# revision-only edit\n`);
  const commented = await capture(root);
  expect(commented.revision).not.toBe(edited.revision);
  expect(commented).toMatchObject({
    changed: 0,
    unchanged: first.records,
    new: 0,
    removed: 0,
    prior: edited.revision,
    previous: { revision: edited.revision },
    rotated: true,
  });
  expect(bytesAt(root, PREVIOUS)).toEqual(unmoved);
  // The next edit rotates again: previous.json becomes the capture before it, never an older one.
  writeFileSync(
    resolve(root, PRINCIPLE),
    readFileSync(resolve(root, PRINCIPLE), 'utf8').replace('3, edited."', '3, edited twice."'),
  );
  const twice = await capture(root);
  expect(twice).toMatchObject({ changed: 1, prior: commented.revision, previous: { revision: commented.revision } });
  expect(snapshotAt(root, PREVIOUS).revision).toBe(commented.revision);
});

it('counts a record added since the prior capture as new and a deleted one as removed', async () => {
  const root = workspace();
  const first = await capture(root);
  writeFileSync(
    resolve(root, ADDED),
    '#! ia 1.0\n\n@principle added-principle\n  meaning\n    says "Added."\n    answers "Added."\n  governance\n    severity advisory\n    requires "Added."\n',
  );
  const added = await capture(root);
  expect(added).toMatchObject({
    records: first.records + 1,
    changed: 0,
    unchanged: first.records,
    new: 1,
    removed: 0,
    rotated: true,
  });
  rmSync(resolve(root, ADDED));
  const removed = await capture(root);
  expect(removed).toMatchObject({
    records: first.records,
    changed: 0,
    unchanged: first.records,
    new: 0,
    removed: 1,
    previous: { revision: added.revision },
  });
});

it('writes the snapshot when admission has errors, exits 1 and reports the findings apart from the effect', async () => {
  const root = workspace({ foreign: true });
  const refused = await capture(root, 1);
  expect(refused.admission.status).toBe('refused');
  expect(refused.admission.errors).toBeGreaterThan(0);
  expect(refused.new).toBe(refused.records);
  const snapshot = snapshotAt(root);
  expect(snapshot.counts['errors']).toBe(refused.admission.errors);
  expect(snapshot.diagnostics.some((finding) => finding.severity === 'error')).toBe(true);
  expect(snapshot.diagnostics).toEqual(ordered(snapshot.diagnostics));
  const human = await run(['capture', '--root', root]);
  expect(human.exitCode).toBe(1);
  expect(human.stderr).toBe('');
  expect(flat(human.stdout)).toContain('Run "ia validate" for their locations');
});

it('replaces a current.json that is no capture and retains no previous capture beside it', async () => {
  const root = workspace();
  mkdirSync(resolve(root, SNAPSHOT_DIRECTORY), { recursive: true });
  for (const [text, reason] of [
    ['not json\n', 'is not JSON'],
    ['{"format":"ia.compiled.v1"}\n', `is not an ${SNAPSHOT_FORMAT} document`],
    [`{"format":"${SNAPSHOT_FORMAT}","revision":"r","membership":[]}\n`, 'has no revision or membership rows'],
    [
      `{"format":"${SNAPSHOT_FORMAT}","revision":"${'a'.repeat(64)}","membership":[{"identity":"x"}]}\n`,
      'has a malformed membership row',
    ],
  ] as const) {
    writeFileSync(resolve(root, CURRENT), text);
    writeFileSync(resolve(root, PREVIOUS), 'an earlier file\n');
    const replaced = await capture(root);
    expect(replaced).toMatchObject({ prior: null, ignored: reason, previous: null, rotated: false, removed: 0 });
    expect(replaced.new).toBe(replaced.records);
    expect(existsSync(resolve(root, PREVIOUS))).toBe(false);
    expect(snapshotAt(root).revision).toBe(replaced.revision);
  }
  writeFileSync(resolve(root, CURRENT), 'not json\n');
  const human = await run(['capture', '--root', root]);
  expect(flat(human.stdout)).toContain(
    'No prior capture to compare with (the existing current.json is not JSON), so every record is new.',
  );
  // At an unchanged revision a previous.json that is no capture at another revision is not kept either.
  edit(root);
  await capture(root);
  writeFileSync(resolve(root, PREVIOUS), bytesAt(root, CURRENT));
  const same = await capture(root);
  expect(same).toMatchObject({ changed: 0, previous: null, rotated: false });
  expect(existsSync(resolve(root, PREVIOUS))).toBe(false);
});

it('renders the effect apart from admission in human output', async () => {
  const root = workspace();
  const first = await run(['capture', '--root', root]);
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe('');
  for (const text of ['Capture', SNAPSHOT_FORMAT, 'No prior capture to compare with', CURRENT, 'Admission'])
    expect(first.stdout).toContain(text);
  expect(flat(first.stdout)).toContain('No earlier capture at another revision is retained.');
  const second = await run(['capture', '--root', root]);
  expect(second.stdout).toContain('0 changed');
  edit(root);
  const third = await run(['capture', '--root', root]);
  expect(third.stdout).toContain('1 changed');
  expect(third.stdout).toContain(PREVIOUS);
  expect(flat(third.stdout)).toContain('moved from current.json because the revision changed');
});

it('refuses a snapshot path it does not admit and names the capture to run once it is repaired', async () => {
  const root = workspace(),
    elsewhere = scratch('capture-elsewhere');
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(elsewhere, resolve(root, SNAPSHOT_DIRECTORY), 'junction');
  const refused = await run(['capture', '--root', root, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; next: string; where: { path: string } };
  expect(body.code).toBe('IA-DIST-PATH-UNSAFE');
  expect(body.where.path).toBe(SNAPSHOT_DIRECTORY);
  expect(commandsIn(body.next)).toEqual([`ia capture --root ${quote(root)}`]);
  // Nothing was written through the link.
  expect(readdirSync(elsewhere)).toEqual([]);
  rmSync(resolve(root, SNAPSHOT_DIRECTORY), { recursive: true, force: true });
  expect((await run(nextArgv(body.next))).exitCode).toBe(0);
});

it('lists ia capture in the help, and ia compile as its deprecated alias', async () => {
  expect((await run(['--help'])).stdout).toContain('capture');
  const help = await run(['capture', '--help']);
  expect(help.stdout).toContain('ia capture [--json]');
  const alias = await run(['compile', '--help']);
  expect(alias.stdout).toContain('Deprecated alias of ia capture; removed in 3.0');
  expect(alias.stdout).toContain('--force');
});

it('runs ia compile as ia capture, accepts --force, and prints one deprecation line on stderr', async () => {
  const root = workspace();
  const human = await run(['compile', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe(DEPRECATION);
  expect(DEPRECATION.split('\n')).toEqual([expect.stringContaining('ia compile'), '']);
  expect(DEPRECATION).toContain(CURRENT);
  expect(DEPRECATION).toContain(DEFAULT_OUT);
  expect(human.stdout).toContain('Capture');
  expect(human.stdout).toContain(SNAPSHOT_FORMAT);
  // The ia.compiled.v1 artifact is no longer written; the snapshot is.
  expect(existsSync(resolve(root, DEFAULT_OUT))).toBe(false);
  expect(snapshotAt(root).format).toBe(SNAPSHOT_FORMAT);
  // --json keeps stdout one value, the capture's own; the deprecation line stays on stderr. With no edit these runs
  // rewrite nothing, so the line says where the snapshot is rather than that this run wrote it.
  const written = statSync(resolve(root, CURRENT)).mtimeMs;
  for (const flags of [[], ['--force']]) {
    const machine = await run(['compile', '--root', root, ...flags, '--json']);
    expect(machine.exitCode).toBe(0);
    expect(machine.stderr).toBe(DEPRECATION);
    expect(statSync(resolve(root, CURRENT)).mtimeMs).toBe(written);
    expect(machine.stdout.slice(0, -1)).not.toContain('\n');
    const envelope = JSON.parse(machine.stdout) as Envelope;
    expect(envelope).toMatchObject({ format: SNAPSHOT_FORMAT, changed: 0, prior: envelope.revision });
    expect(envelope).toEqual(await capture(root));
  }
  // The exit class is the capture's too.
  const broken = workspace({ foreign: true });
  const refused = await run(['compile', '--root', broken, '--json']);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toBe(DEPRECATION);
  expect((JSON.parse(refused.stdout) as Envelope).admission.errors).toBeGreaterThan(0);
});

it('refuses ia compile --out and --stdout before reading anything, naming the ia capture to run instead', async () => {
  const root = workspace(),
    command = `ia capture --root ${quote(root)}`;
  for (const flags of [
    ['--stdout'],
    ['--stdout', '--force'],
    ['--out', 'x.json'],
    ['--out', DEFAULT_OUT, '--force'],
    // Together, the --stdout refusal answers first, so the next still names the capture rather than the alias's help.
    ['--out', 'x.json', '--stdout'],
  ]) {
    const label = flags.join(' '),
      retired = flags.includes('--stdout') ? '--stdout' : '--out';
    const machine = await run(['compile', '--root', root, ...flags, '--json']);
    expect(machine.exitCode, label).toBe(2);
    // A refusal is the one JSON value, and no deprecation line accompanies it.
    expect(machine.stderr, label).toBe('');
    const body = JSON.parse(machine.stdout) as { ok: boolean; code: string; message: string; next: string };
    expect(body, label).toMatchObject({ ok: false, code: 'IA-CLI-USAGE' });
    expect(body.message, label).toContain(`ia compile ${retired} is retired`);
    expect(commandsIn(body.next), label).toEqual([command]);
    const human = await run(['compile', '--root', root, ...flags]);
    expect(human.exitCode, label).toBe(2);
    expect(flat(human.stderr), label).toContain(`→ Run "${command}"`);
    expect(existsSync(resolve(root, '.ia/work')), label).toBe(false);
  }
  // The named command runs as printed and writes the snapshot.
  const named = JSON.parse((await run(['compile', '--root', root, '--stdout', '--json'])).stdout) as { next: string };
  expect((await run(nextArgv(named.next))).exitCode).toBe(0);
  expect(existsSync(resolve(root, CURRENT))).toBe(true);
});

it('prints only the refusal, with no deprecation line, when the capture ia compile runs refuses', async () => {
  const absent = resolve(scratch('compile-absent'), 'absent');
  const machine = await run(['compile', '--root', absent, '--json']);
  expect(machine.exitCode).toBe(3);
  expect(machine.stderr).toBe('');
  const body = JSON.parse(machine.stdout) as { code: string; next: string };
  expect(body.code).toBe('IA-DB-ROOT-INVALID');
  // The refusal is the capture's, so it names ia capture rather than the alias.
  expect(body.next).toContain('"ia capture --root <directory>"');
  const human = await run(['compile', '--root', absent]);
  expect(human.exitCode).toBe(3);
  expect(human.stderr).toContain('IA-DB-ROOT-INVALID');
  expect(human.stderr).not.toContain('Deprecated');
});
