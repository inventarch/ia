/**
 * `ia capture` (position-and-projection §5, design rows 3 and 20), end to end against copies of the committed loop
 * fixture, kept apart from the deprecated 1.x `ia compile` (decision release-bump; tests/workspace-verbs.test.ts).
 *
 * The exit evidence of plan task ia-capture-verb: two captures with no edit between them report 0 changed, and an edit
 * reports exactly the edited record changed and rotates the prior capture into `previous.json`, as db D08 rotates its
 * retained pair.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
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
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, expect, it, vi } from 'vitest';
import { readInputs } from '@inventarch/db';
import { sha256 } from '@inventarch/distribution/services';
// Through the root development dependency, as the db pins an adopted revision.
import { stableSerialize } from '@inventarch/graph';
import {
  CURRENT,
  PREVIOUS,
  previewCapture,
  renderCapture,
  SNAPSHOT_DIRECTORY,
  SNAPSHOT_FORMAT,
  SYNTAX_CODES,
  unparsedSeed,
  WRITE_REPAIRABLE,
  writeRepair,
} from '../src/capture.js';
import { COMMANDS } from '../src/commands.js';
import { DEFAULT_OUT, DEPRECATION } from '../src/compile.js';
import { quote } from '../src/render.js';
import { cleanup, commandsIn, nextArgv, repository, run, scratch, workspace } from './workspace-fixture.js';

afterAll(cleanup);

/** A seam on db D08b's planCapture, so a test can fail the reads a preview makes. Every call passes through. */
const seams = vi.hoisted(() => ({ plan: undefined as ((root: string) => void) | undefined }));
vi.mock('@inventarch/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/db')>();
  return {
    ...actual,
    planCapture: (root: string, text: string) => {
      seams.plan?.(root);
      return actual.planCapture(root, text);
    },
  };
});

/** A record nothing else in the fixture names, so an edit to it changes its digest and no other. */
const PRINCIPLE = '.ia/src/systems/governance-system/records/sample-principle.ia';
const ADDED = '.ia/src/systems/governance-system/records/added-principle.ia';
const ADDED_RECORD =
  '#! ia 1.0\n\n@principle added-principle\n  meaning\n    says "Added."\n    answers "Added."\n  governance\n    severity advisory\n    requires "Added."\n';

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

/** `ia capture --preview --json`: the capture's shape with `preview: true` and the identities its counts count. */
interface PreviewEnvelope extends Envelope {
  readonly preview: true;
  readonly identities: {
    readonly changed: readonly string[];
    readonly new: readonly string[];
    readonly removed: readonly string[];
  };
}
/** `ia capture --json`, with `flags` before `--root`: one value on stdout and nothing on stderr. */
async function capture(root: string, exitCode = 0, ...flags: readonly string[]): Promise<Envelope> {
  const result = await run(['capture', ...flags, '--root', root, '--json']);
  expect(result.exitCode, result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.endsWith('\n')).toBe(true);
  expect(result.stdout.slice(0, -1)).not.toContain('\n');
  return JSON.parse(result.stdout) as Envelope;
}
const preview = async (root: string, exitCode = 0): Promise<PreviewEnvelope> =>
  (await capture(root, exitCode, '--preview')) as PreviewEnvelope;
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
/** The snapshot directory's files with their bytes and mtimes, so a preview is shown to leave the pair as it was. */
const pairAt = (root: string): readonly (readonly [string, Buffer, number])[] =>
  readdirSync(resolve(root, SNAPSHOT_DIRECTORY))
    .sort()
    .map((name) => {
      const path = resolve(root, SNAPSHOT_DIRECTORY, name);
      return [name, readFileSync(path), statSync(path).mtimeMs] as const;
    });
/**
 * The identities a human preview lists under the heading `label`, up to the next blank line, or null when it prints no
 * such heading, as it prints none for an empty list.
 */
const listedUnder = (stdout: string, label: string): readonly string[] | null => {
  const lines = stdout.split('\n'),
    start = lines.indexOf(label);
  if (start < 0) return null;
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim().split(/\s+/).at(-1)!);
};
/**
 * A capture's human report, flattened, once shown to say nothing a preview says: its own header, no preview line, no
 * conditional wording and no identity heading, so a capture without --preview reports as it did before.
 */
const captureReport = (stdout: string): string => {
  expect(stdout.split('\n')[1]).toMatch(new RegExp(`^Capture\\s+${SNAPSHOT_FORMAT}\\s+revision `));
  expect(stdout).not.toMatch(/preview|nothing has been written|would /i);
  expect(['Changed', 'New', 'Removed'].map((label) => listedUnder(stdout, label))).toEqual([null, null, null]);
  return flat(stdout);
};
/** The footer of a capture whose admission has no errors. */
const IDENTICAL =
  'Identical sources on one language version capture identically, so a capture after no edit reports 0 changed.';
/** Human output with a command's `\` continuation joined back, so the command reads as one. */
const unwrapped = (text: string): string => text.replace(/ \\\n\s+/g, ' ');
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
  writeFileSync(resolve(root, ADDED), ADDED_RECORD);
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
  expect(captureReport(human.stdout)).toContain(
    'The snapshot records these findings. Run "ia validate" for their locations, fix them, then capture again.',
  );
  // The write succeeded, so the effect line stands, under the warning symbol its admission errors earn.
  const effect = human.stdout.split('\n').find((line) => line.includes('Captured '))!;
  expect(effect).toMatch(/(▲|\[warn\])\s+Captured \d+ records\./);
  const clean = await run(['capture', '--root', workspace()]);
  expect(clean.stdout.split('\n').find((line) => line.includes('Captured '))).toMatch(/(✔|\[ok\])\s+Captured/);
  expect(captureReport(clean.stdout)).toContain(IDENTICAL);
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
  expect(captureReport(human.stdout)).toContain(
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
  const report = captureReport(first.stdout);
  expect(report).toContain('No earlier capture at another revision is retained.');
  expect(report).toMatch(
    / \d+ checks had no evaluator, so the snapshot records a not-evaluated result rather than a pass\. /,
  );
  expect(report).toContain(IDENTICAL);
  const second = await run(['capture', '--root', root]);
  expect(captureReport(second.stdout)).toContain('0 changed');
  edit(root);
  const third = await run(['capture', '--root', root]);
  expect(third.stdout).toContain('1 changed');
  expect(third.stdout).toContain(PREVIOUS);
  expect(captureReport(third.stdout)).toContain('moved from current.json because the revision changed');
  // At an unchanged revision the previous capture is kept, and the report says so.
  const fourth = await run(['capture', '--root', root]);
  expect(captureReport(fourth.stdout)).toContain('kept because the revision did not change');
});

it('refuses a snapshot path it does not admit and names the capture to run once it is repaired', async () => {
  const root = workspace(),
    elsewhere = scratch('capture-elsewhere');
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(elsewhere, resolve(root, SNAPSHOT_DIRECTORY), 'junction');
  const refused = await run(['capture', '--root', root, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; next: string; where: { path: string } };
  // The db writes the pair (D08a), so its own code is carried through.
  expect(body.code).toBe('IA-DB-PATH-UNSAFE');
  expect(body.where.path).toBe(SNAPSHOT_DIRECTORY);
  expect(commandsIn(body.next)).toEqual([`ia capture --root ${quote(root)}`]);
  // Nothing was written through the link.
  expect(readdirSync(elsewhere)).toEqual([]);
  rmSync(resolve(root, SNAPSHOT_DIRECTORY), { recursive: true, force: true });
  // An entry at previous.json that is not a regular file refuses the same way, before anything is written.
  mkdirSync(resolve(root, PREVIOUS), { recursive: true });
  const directory = JSON.parse((await run(['capture', '--root', root, '--json'])).stdout) as typeof body & {
    message: string;
  };
  expect(directory).toMatchObject({ code: 'IA-DB-PATH-UNSAFE', where: { path: PREVIOUS } });
  expect(directory.message).toContain('previous.json is not a regular file');
  expect(existsSync(resolve(root, CURRENT))).toBe(false);
  rmSync(resolve(root, PREVIOUS), { recursive: true });
  expect((await run(nextArgv(body.next))).exitCode).toBe(0);
});

it('refuses a root whose own sources declare no @workspace, writing nothing, and names ia init', async () => {
  // Position-and-projection §5 and §11: no @workspace at this root.
  const empty = realpathSync(scratch('capture-empty'));
  const refused = await run(['capture', '--root', empty, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; next: string; where: { path: string } };
  expect(body).toMatchObject({ code: 'IA-DB-ROOT-INVALID', where: { path: empty } });
  expect(commandsIn(body.next)).toEqual([`ia init ${quote(empty)}`]);
  expect(existsSync(resolve(empty, '.ia'))).toBe(false);
  // A .ia/src that holds systems but no @workspace of its own is no workspace to capture either.
  const systems = workspace();
  rmSync(resolve(systems, '.ia/src/systems/workspace-system/records/foundation-workspace.ia'));
  const human = await run(['capture', '--root', systems]);
  expect(human.exitCode).toBe(3);
  expect(human.stderr).toContain('IA-DB-ROOT-INVALID');
  expect(flat(human.stderr)).toContain(`→ Run "ia init ${quote(realpathSync(systems))}"`);
  expect(existsSync(resolve(systems, '.ia/work'))).toBe(false);
  // The deprecated 1.x `ia compile` keeps its behaviour there: it compiles whatever admits.
  expect((await run(['compile', '--root', systems])).exitCode).toBe(0);
});

it('refuses a floor input that fails to parse, keeping both snapshot files, and names ia validate', async () => {
  // Position-and-projection §5 and §11: a floor/seed input fails to parse (previous snapshot kept).
  const root = workspace();
  await capture(root);
  edit(root);
  await capture(root);
  const current = bytesAt(root, CURRENT),
    previous = bytesAt(root, PREVIOUS),
    floor = '.ia/src/floor/artifact-set.ia',
    text = readFileSync(resolve(root, floor), 'utf8');
  writeFileSync(resolve(root, floor), `${text}\n@@@ not a record header\n`);
  const refused = await run(['capture', '--root', root, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; message: string; next: string; where: { path: string } };
  expect(body.code).toMatch(/^IA-LANG-/);
  expect(body.where.path).toBe(floor);
  expect(body.message).toContain('the previous snapshot is kept');
  expect(commandsIn(body.next)).toEqual([`ia validate --root ${quote(root)}`]);
  expect([bytesAt(root, CURRENT), bytesAt(root, PREVIOUS)]).toEqual([current, previous]);
  // `ia validate` names the same finding, and once the floor parses the capture compares with the kept pair.
  const validate = await run(nextArgv(body.next));
  expect(validate.stdout + validate.stderr).toContain(body.code);
  writeFileSync(resolve(root, floor), text);
  const repaired = await capture(root);
  expect(repaired).toMatchObject({ changed: 0, rotated: false, prior: snapshotAt(root).revision });
  expect(bytesAt(root, PREVIOUS)).toEqual(previous);
  // A source the workspace authors that fails to parse is a finding the snapshot records, never a refusal.
  writeFileSync(resolve(root, PRINCIPLE), `${readFileSync(resolve(root, PRINCIPLE), 'utf8')}\n@@@ not a record\n`);
  const recorded = await capture(root, 1);
  expect(recorded.admission.errors).toBeGreaterThan(0);
  expect(recorded.rotated).toBe(true);
});

/** A workspace at `<scratch>/workspace` whose own sources are the native conformance corpus, which declares a @workspace. */
function nativeWorkspace(name: string): string {
  const root = resolve(scratch(name), 'workspace');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  return root;
}
/** The sources of a small adopted system that registers the keyword `gadget`, as `vendor/<id>` holds them. */
const gadgetSystem = (id: string): Readonly<Record<string, string>> => ({
  [`.ia/src/systems/extra-${id}/system.ia`]: `#! ia 1.0\n\n@system extra-${id}\n  provider "inventarch.local"\n  version "0.1.0"\n  describes "Extra ${id}"\n  steward @agent extra-${id}-steward\n  requires\n    - agent-system\n  discriminators\n    gadget lowers to definition\n      category evidence\n      facets [gadget]\n      schema @schema gadget\n  edges\n    cite * using *\n`,
  [`.ia/src/systems/extra-${id}/steward.ia`]: `#! ia 1.0\n\n@agent extra-${id}-steward\n  meaning\n    says "Owner of extra ${id}."\n    answers "Who owns gadget here?"\n  governance\n    applies [gadget]\n`,
  [`.ia/src/systems/extra-${id}/schemas/gadget.schema.ia`]:
    '#! ia 1.0\n\n@schema gadget\n  lowers to definition\n  sections\n    must have meaning\n    closed\n  fields\n    must have meaning.says as text\n    must have meaning.answers as text\n',
});
/**
 * Mounts `vendor/<id>` for each id in `.ia/workspace.json`, writing the files given for it first, and pins each to its
 * `.ia/src` sources (its floor excluded) as the db pins an adopted revision.
 */
function adopt(root: string, mounts: Readonly<Record<string, Readonly<Record<string, string>>>>): void {
  const adopted = Object.entries(mounts).map(([id, files]) => {
    const path = `vendor/${id}`;
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(resolve(root, path, file)), { recursive: true });
      writeFileSync(resolve(root, path, file), text);
    }
    const pinned = readInputs(resolve(root, path), { adopted: [] })
      .sources.filter((source) => !source.path.startsWith('.ia/src/floor/'))
      .map(({ path: source, text }) => ({ path: source, text }));
    return { id, path, revision: createHash('sha256').update(stableSerialize(pinned)).digest('hex') };
  });
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  writeFileSync(resolve(root, '.ia/workspace.json'), JSON.stringify({ version: 1, adopted }));
}

it('captures seed inputs that parse but collide, and keeps the collision as findings, as validate reports them', async () => {
  // Position-and-projection §5: only a floor/seed input that fails to parse refuses; a keyword two adopted systems both
  // register is a registration finding over sources that parsed, written into the snapshot like any other.
  const root = nativeWorkspace('capture-collide');
  adopt(root, { a: gadgetSystem('a'), b: gadgetSystem('b') });
  const captured = await capture(root, 1);
  expect(captured.admission.errors).toBeGreaterThan(0);
  const conflicts = snapshotAt(root).diagnostics.filter((finding) => finding.code === 'IA-LANG-DISCRIMINATOR-CONFLICT');
  expect(conflicts.map((finding) => finding.path.split('/').slice(0, 3).join('/'))).toEqual([
    '.ia/adopted/a',
    '.ia/adopted/b',
  ]);
  expect(conflicts.every((finding) => finding.severity === 'error')).toBe(true);
  const validated = JSON.parse((await run(['validate', '--root', root, '--max-findings', '500', '--json'])).stdout) as {
    findings: readonly Finding[];
  };
  expect(validated.findings.filter((finding) => finding.code === 'IA-LANG-DISCRIMINATOR-CONFLICT')).toEqual(conflicts);
});

it('refuses an adopted input that fails to parse, keeping both snapshot files, and names ia validate', async () => {
  const root = nativeWorkspace('capture-adopted-parse'),
    files = gadgetSystem('a'),
    steward = '.ia/src/systems/extra-a/steward.ia',
    own = resolve(root, '.ia/src/systems/workspace-system/records/foundation-workspace.ia');
  adopt(root, { a: files });
  await capture(root);
  writeFileSync(own, `${readFileSync(own, 'utf8')}\n# revision-only edit\n`);
  await capture(root);
  const current = bytesAt(root, CURRENT),
    previous = bytesAt(root, PREVIOUS);
  adopt(root, { a: { ...files, [steward]: `${files[steward]}\n@@@ not a record header\n` } });
  const refused = await run(['capture', '--root', root, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; message: string; next: string; where: { path: string } };
  expect(SYNTAX_CODES.has(body.code)).toBe(true);
  expect(body.where.path).toMatch(new RegExp(`^\\.ia/adopted/a/[0-9a-f]{64}/${steward.replaceAll('.', '\\.')}$`));
  expect(body.message).toContain('is a floor or seed input that fails to parse');
  expect(commandsIn(body.next)).toEqual([`ia validate --root ${quote(root)}`]);
  expect([bytesAt(root, CURRENT), bytesAt(root, PREVIOUS)]).toEqual([current, previous]);
});

it('refuses only a syntax error in a floor, installed or adopted source, the parser codes language spells', () => {
  // The set is the parser's: every code the scanner and parser spell, and none any other admission stage spells.
  const spelled = (directory: string): ReadonlySet<string> =>
    new Set(
      readdirSync(resolve(repository, 'packages/language/src', directory))
        .filter((name) => name.endsWith('.ts'))
        .flatMap((name) => [
          ...readFileSync(resolve(repository, 'packages/language/src', directory, name), 'utf8').matchAll(
            /'(IA-LANG-[A-Z-]+)'/g,
          ),
        ])
        .map((match) => match[1]!),
    );
  expect(new Set([...spelled('scanner'), ...spelled('parser')])).toEqual(SYNTAX_CODES);
  for (const stage of ['registry', 'compile', 'semantic'])
    for (const code of spelled(stage)) expect(SYNTAX_CODES.has(code), `${stage}: ${code}`).toBe(false);
  type Code = Parameters<typeof unparsedSeed>[0][number]['code'];
  const finding = (path: string, code: Code, severity: 'error' | 'warning' = 'error') => ({
    code,
    severity,
    path,
    line: 3,
    message: 'm',
  });
  const installed = `.ia/distributions/store/${'d'.repeat(64)}/.ia/src/systems/x/records/a.ia`,
    adopted = `.ia/adopted/lib/${'e'.repeat(64)}/.ia/src/systems/x/records/a.ia`;
  for (const path of ['.ia/src/floor/predicate.ia', installed, adopted]) {
    expect(unparsedSeed([finding(path, 'IA-LANG-HEADER-MALFORMED')]), path).toMatchObject({ path });
    // A registration, resolution or compilation finding there is retained, and so is a warning.
    for (const code of [
      'IA-LANG-DISCRIMINATOR-CONFLICT',
      'IA-LANG-KEYWORD-RESERVED',
      'IA-LANG-SYSTEM-MISSING',
      'IA-LANG-EDGE-TARGET-MISSING',
      'IA-LANG-IDENTITY-COLLISION',
      'IA-LANG-EDGE-UNCONSENTED',
      'IA-COMP-FIELD-UNKNOWN',
    ] as const)
      expect(unparsedSeed([finding(path, code)]), `${path}: ${code}`).toBeUndefined();
    expect(unparsedSeed([finding(path, 'IA-LANG-HEADER-MALFORMED', 'warning')]), path).toBeUndefined();
  }
  // A source the workspace authors never refuses the capture, whatever its finding.
  expect(unparsedSeed([finding('.ia/src/systems/x/records/a.ia', 'IA-LANG-HEADER-MALFORMED')])).toBeUndefined();
});

it('refuses a root whose only @workspace is installed or adopted, since the root declares none of its own', async () => {
  // An adopted mount's @workspace is the mount's, not this root's.
  const adoptedOnly = resolve(scratch('capture-adopted-only'), 'workspace');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(adoptedOnly, 'vendor/foundation/.ia/src'), {
    recursive: true,
  });
  adopt(adoptedOnly, { foundation: {} });
  const adoptedBody = JSON.parse((await run(['capture', '--root', adoptedOnly, '--json'])).stdout) as {
    code: string;
    next: string;
  };
  expect(adoptedBody.code).toBe('IA-DB-ROOT-INVALID');
  expect(commandsIn(adoptedBody.next)).toEqual([`ia init ${quote(realpathSync(adoptedOnly))}`]);
  expect(existsSync(resolve(adoptedOnly, '.ia/work'))).toBe(false);
  // An installed package's @workspace (the bundled language base declares one) is the package's.
  const installed = resolve(scratch('capture-installed-only'), 'demo');
  const initialized = await run(['init', installed, '--apply', '--yes', '--json']);
  expect(initialized.exitCode, initialized.stdout).toBe(0);
  // `ia init` captures once it has initialized (position-and-projection §3), so the pair exists; the refusal keeps it.
  const kept = bytesAt(installed, CURRENT);
  expect(JSON.parse(kept.toString('utf8')).revision).toBe(
    JSON.parse(initialized.stdout).applied.effects.capture.revision,
  );
  rmSync(resolve(installed, '.ia/src/workspace.ia'));
  const installedRun = await run(['capture', '--root', installed, '--json']);
  expect(installedRun.exitCode).toBe(3);
  expect(JSON.parse(installedRun.stdout)).toMatchObject({ code: 'IA-DB-ROOT-INVALID' });
  expect(bytesAt(installed, CURRENT)).toEqual(kept);
  expect(existsSync(resolve(installed, PREVIOUS))).toBe(false);
});

it('captures a root whose own @workspace admission refused, and names ia validate for a root that has none', async () => {
  // A refused @workspace is still the root's own: the capture writes, and its exit class carries the finding.
  const refused = workspace(),
    record = resolve(refused, '.ia/src/systems/workspace-system/records/foundation-workspace.ia');
  writeFileSync(
    record,
    readFileSync(record, 'utf8').replace(
      '    answers "Which systems support foundation authoring?"\n',
      '    answers "Which systems support foundation authoring?"\n    bogus "x"\n',
    ),
  );
  const captured = await capture(refused, 1);
  expect(captured.admission.status).toBe('refused');
  expect(snapshotAt(refused).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'IA-COMP-FIELD-UNKNOWN',
        path: '.ia/src/systems/workspace-system/records/foundation-workspace.ia',
      }),
    ]),
  );
  // No @workspace at all, and its own sources have errors, which may be why none is read: the validation, not init.
  const none = workspace({ foreign: true });
  rmSync(resolve(none, '.ia/src/systems/workspace-system/records/foundation-workspace.ia'));
  const body = JSON.parse((await run(['capture', '--root', none, '--json'])).stdout) as { code: string; next: string };
  expect(body.code).toBe('IA-DB-ROOT-INVALID');
  expect(commandsIn(body.next)).toEqual([`ia validate --root ${quote(none)}`]);
  expect(existsSync(resolve(none, '.ia/work'))).toBe(false);
});

it('reports a sources entry or a path selection that declares nothing as a warning, in the snapshot and in validate', async () => {
  // The native conformance corpus, whose workspace schema declares composition.sources.
  const root = resolve(scratch('capture-native'), 'workspace'),
    record = '.ia/src/systems/workspace-system/records/foundation-workspace.ia',
    mandate = '.ia/src/systems/agent-system/records/sample-mandate.ia';
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  const text = readFileSync(resolve(root, record), 'utf8');
  // A typo in the placement silently declared no root, so every record kept its system seat with no word said.
  writeFileSync(
    resolve(root, record),
    text.replace('  relationships\n', '    sources [".ia/src @authorded"]\n  relationships\n'),
  );
  // A `./` segment makes the mandate's path selection select nothing.
  const covers = readFileSync(resolve(root, mandate), 'utf8');
  expect(covers).toContain('covers ["docs/**"]');
  writeFileSync(resolve(root, mandate), covers.replace('covers ["docs/**"]', 'covers ["./docs/**"]'));
  const captured = await capture(root);
  expect(captured.admission.errors).toBe(0);
  const inert = snapshotAt(root).diagnostics.filter((finding) => finding.code === 'IA-COMP-FIELD-VALUE');
  expect(inert).toEqual([
    expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', severity: 'warning', path: mandate }),
    expect.objectContaining({
      code: 'IA-COMP-FIELD-VALUE',
      severity: 'warning',
      path: record,
      line: 9,
      message:
        'composition.sources value ".ia/src @authorded" names @authorded, which is no placement, so it declares no root',
    }),
  ]);
  const validated = JSON.parse((await run(['validate', '--root', root, '--json'])).stdout) as {
    findings: readonly { path: string; code: string; severity: string }[];
  };
  expect(validated.findings.filter((finding) => finding.code === 'IA-COMP-FIELD-VALUE')).toEqual([
    expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', severity: 'warning', path: mandate }),
    expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', severity: 'warning', path: record }),
  ]);
});

it('names what to make writable when a snapshot write fails, and leaves the pair as it was', async () => {
  // A current.json the capture must replace that the system will not let it replace. On Windows it is read-only, a
  // rename onto it fails and the file is the repair; elsewhere the directory is read-only, so the staged file cannot be
  // created whatever current.json's own mode, and the directory is the repair.
  if (process.platform !== 'win32' && process.getuid?.() === 0) return;
  const windows = process.platform === 'win32';
  const root = workspace();
  await capture(root);
  writeFileSync(resolve(root, CURRENT), 'not a capture\n');
  const locked = windows ? resolve(root, CURRENT) : resolve(root, SNAPSHOT_DIRECTORY);
  chmodSync(locked, windows ? 0o444 : 0o555);
  try {
    const refused = await run(['capture', '--root', root, '--json']);
    expect(refused.exitCode).toBe(3);
    const body = JSON.parse(refused.stdout) as { code: string; next: string; where: { path: string } };
    expect(body).toMatchObject({ code: 'IA-CLI-FAILED', where: { path: windows ? CURRENT : SNAPSHOT_DIRECTORY } });
    expect(body.next).toContain(
      windows ? `Make ${CURRENT} writable` : `Make the directory ${SNAPSHOT_DIRECTORY} writable`,
    );
    expect(commandsIn(body.next)).toEqual([`ia capture --root ${quote(root)}`]);
    expect(bytesAt(root, CURRENT).toString('utf8')).toBe('not a capture\n');
    expect(readdirSync(resolve(root, SNAPSHOT_DIRECTORY))).toEqual(['current.json']);
  } finally {
    chmodSync(locked, windows ? 0o666 : 0o755);
  }
  expect((await capture(root)).ignored).toBe('is not JSON');
});

it('names the file or the directory a write failure needs repaired, by the failing call and the platform', () => {
  const root = resolve(scratch('capture-repair'));
  const failure = (path: string, syscall: string, code = 'EPERM') =>
    Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path: resolve(root, path) });
  const staged = `${CURRENT}.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tmp`;
  const file = (path: string) => ({ path, kind: 'file' }),
    directory = (path: string) => ({ path, kind: 'directory' });
  // Windows: a rename onto, or a removal of, a read-only or open file fails on the file, named without the staged suffix.
  expect(writeRepair(root, failure(staged, 'rename'), 'win32')).toEqual(file(CURRENT));
  expect(writeRepair(root, failure(CURRENT, 'rename', 'EBUSY'), 'win32')).toEqual(file(CURRENT));
  expect(writeRepair(root, failure(PREVIOUS, 'unlink'), 'win32')).toEqual(file(PREVIOUS));
  // POSIX: renaming and removing are the directory's to permit, whatever the file's mode.
  for (const platform of ['linux', 'darwin'] as const) {
    expect(writeRepair(root, failure(staged, 'rename', 'EACCES'), platform)).toEqual(directory(SNAPSHOT_DIRECTORY));
    expect(writeRepair(root, failure(PREVIOUS, 'unlink', 'EACCES'), platform)).toEqual(directory(SNAPSHOT_DIRECTORY));
  }
  // Everywhere: creating the staged file needs its directory, creating the snapshot directory needs the one above it,
  // and a file where a directory belongs is that directory's repair.
  expect(writeRepair(root, failure(staged, 'open', 'EACCES'), 'win32')).toEqual(directory(SNAPSHOT_DIRECTORY));
  expect(writeRepair(root, failure(SNAPSHOT_DIRECTORY, 'mkdir', 'EACCES'), 'win32')).toEqual(directory('.ia/work'));
  expect(writeRepair(root, failure(SNAPSHOT_DIRECTORY, 'mkdir', 'EEXIST'), 'win32')).toEqual(directory('.ia/work'));
  // A failure with no path, or one outside the root, names the snapshot directory.
  expect(writeRepair(root, new Error('EIO'), 'win32')).toEqual(directory(SNAPSHOT_DIRECTORY));
  expect(writeRepair(root, failure('../elsewhere.json', 'rename'), 'win32')).toEqual(directory(SNAPSHOT_DIRECTORY));
  // Only a permission, a busy or read-only entry, or an entry of the wrong kind is a path's to repair; a full disk, an
  // I/O error or too many open files takes the generic next instead.
  expect([...WRITE_REPAIRABLE].sort()).toEqual(['EACCES', 'EBUSY', 'EEXIST', 'ENOTDIR', 'EPERM', 'EROFS']);
  for (const code of ['ENOSPC', 'EIO', 'EMFILE', 'ENOENT']) expect(WRITE_REPAIRABLE.has(code), code).toBe(false);
});

it('refuses a file where the snapshot directory or .ia/work belongs, writing nothing, and names the path to replace', async () => {
  for (const path of [SNAPSHOT_DIRECTORY, '.ia/work']) {
    const root = workspace();
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), 'not a directory\n');
    const refused = await run(['capture', '--root', root, '--json']);
    expect(refused.exitCode, path).toBe(3);
    const body = JSON.parse(refused.stdout) as { code: string; message: string; next: string; where: { path: string } };
    // The db refuses it before anything is written (D08a), never an errno failure whose repair is a permission, and
    // locates it at the entry that is not a directory.
    expect(body, path).toMatchObject({
      code: 'IA-DB-PATH-UNSAFE',
      message: `${path} is not a directory`,
      where: { path },
    });
    expect(body.next, path).toContain('Replace or remove the path named above');
    expect(commandsIn(body.next), path).toEqual([`ia capture --root ${quote(root)}`]);
    expect(readFileSync(resolve(root, path), 'utf8'), path).toBe('not a directory\n');
    rmSync(resolve(root, path));
    expect((await run(nextArgv(body.next))).exitCode, path).toBe(0);
  }
});

it('previews exactly the edited record as changed and writes nothing: both snapshot files keep their bytes and mtimes', async () => {
  // Decision capture-preview-placement: the counts and the changed, new and removed identities, without writing.
  const root = workspace();
  await capture(root);
  // A revision-only edit, so the pair holds both files before the one edit the preview reports.
  writeFileSync(resolve(root, PRINCIPLE), `${readFileSync(resolve(root, PRINCIPLE), 'utf8')}\n# revision-only edit\n`);
  const captured = await capture(root);
  expect(captured).toMatchObject({ changed: 0, rotated: true });
  const principle = snapshotAt(root).membership.find((row) => row.identity.endsWith('/sample-principle'))!.identity;
  edit(root);
  const pair = pairAt(root);
  expect(pair.map(([name]) => name)).toEqual(['current.json', 'previous.json']);
  const previewed = await preview(root);
  expect(pairAt(root)).toEqual(pair);
  expect(readdirSync(resolve(root, '.ia/work'))).toEqual(['snapshot']);
  // The capture's --json shape with preview: true after version and the identities before admission.
  expect(Object.keys(previewed)).toEqual([
    'version',
    'preview',
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
    'identities',
    'admission',
  ]);
  expect(previewed.revision).not.toBe(captured.revision);
  expect(previewed).toMatchObject({
    version: 1,
    preview: true,
    snapshot: resolve(realpathSync(root), CURRENT),
    records: captured.records,
    changed: 1,
    unchanged: captured.records - 1,
    new: 0,
    removed: 0,
    prior: captured.revision,
    ignored: null,
    previous: { path: resolve(realpathSync(root), PREVIOUS), revision: captured.revision },
    rotated: true,
    identities: { changed: [principle], new: [], removed: [] },
    admission: { status: 'admitted', errors: 0 },
  });
  // The human preview says it wrote nothing, prints the capture's counts and names the identity.
  const human = await run(['capture', '--preview', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe('');
  for (const text of [
    'This is a preview. Nothing has been written.',
    `Would capture ${captured.records} records.`,
    `1 changed, ${captured.records - 1} unchanged, 0 new, 0 removed.`,
    'would move from current.json because the revision changed',
    'checks had no evaluator, so the snapshot would record a not-evaluated result rather than a pass.',
  ])
    expect(flat(human.stdout)).toContain(text);
  // Headed as the other previews are, and its effect line is information: nothing was written to mark.
  expect(human.stdout.split('\n')[1]).toMatch(new RegExp(`^Plan\\s+capture ${SNAPSHOT_FORMAT}\\s+revision `));
  expect(human.stdout.split('\n').find((line) => line.includes('Would capture '))).toMatch(
    /(•|\*)\s+Would capture \d+ records\./,
  );
  expect(human.stdout).not.toContain('Captured ');
  // Only the heading with an identity under it is printed.
  expect(['Changed', 'New', 'Removed'].map((label) => listedUnder(human.stdout, label))).toEqual([
    [principle],
    null,
    null,
  ]);
  expect(commandsIn(unwrapped(human.stdout))).toEqual([`ia capture --root ${quote(root)}`]);
  expect(pairAt(root)).toEqual(pair);
  // The capture then writes and reports what the preview described, in the capture's own keys.
  const { preview: _preview, identities: _identities, ...described } = previewed;
  expect(await capture(root)).toEqual(described);
  expect(sha256(bytesAt(root, CURRENT))).toBe(previewed.digest);
  expect(bytesAt(root, PREVIOUS)).toEqual(pair[0]![1]);
  // At an unchanged revision the preview would keep previous.json and names no identity.
  const unchanged = await run(['capture', '--preview', '--root', root]);
  expect(flat(unchanged.stdout)).toContain('would be kept because the revision did not change');
  expect(['Changed', 'New', 'Removed'].map((label) => listedUnder(unchanged.stdout, label))).toEqual([
    null,
    null,
    null,
  ]);
});

it('previews a workspace never captured: no prior, every record new, and no .ia/work directory', async () => {
  const root = workspace();
  const previewed = await preview(root);
  expect(previewed).toMatchObject({
    preview: true,
    changed: 0,
    unchanged: 0,
    removed: 0,
    prior: null,
    ignored: null,
    previous: null,
    rotated: false,
    identities: { changed: [], removed: [] },
  });
  expect(previewed.new).toBe(previewed.records);
  expect(previewed.identities.new).toHaveLength(previewed.records);
  expect(previewed.identities.new).toEqual([...previewed.identities.new].sort(compare));
  const human = await run(['capture', '--preview', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(flat(human.stdout)).toContain('No prior capture to compare with, so every record is new.');
  expect(flat(human.stdout)).toContain('No earlier capture at another revision would be retained.');
  // Every record is named, in full and in order, under the one heading that has any.
  expect(['Changed', 'New', 'Removed'].map((label) => listedUnder(human.stdout, label))).toEqual([
    null,
    previewed.identities.new,
    null,
  ]);
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  // The capture then writes the snapshot the preview described.
  const written = await capture(root);
  expect(written.digest).toBe(previewed.digest);
  expect(snapshotAt(root).membership.map((row) => row.identity)).toEqual(previewed.identities.new);
  // Admission errors exit 1, as the capture would, and the preview still writes nothing.
  const refused = workspace({ foreign: true });
  expect((await preview(refused, 1)).admission.status).toBe('refused');
  const findings = await run(['capture', '--preview', '--root', refused]);
  expect(findings.exitCode).toBe(1);
  expect(flat(findings.stdout)).toContain('The snapshot would record these findings. Run "ia validate"');
  expect(existsSync(resolve(refused, '.ia/work'))).toBe(false);
});

it('previews a record added since the prior capture as new and a deleted one as removed', async () => {
  const root = workspace();
  const first = await capture(root);
  writeFileSync(resolve(root, ADDED), ADDED_RECORD);
  const added = await preview(root);
  expect(added).toMatchObject({
    records: first.records + 1,
    changed: 0,
    unchanged: first.records,
    new: 1,
    removed: 0,
    identities: { changed: [], removed: [] },
  });
  expect(added.identities.new).toHaveLength(1);
  expect(added.identities.new[0]).toMatch(/\/added-principle$/);
  expect(listedUnder((await run(['capture', '--preview', '--root', root])).stdout, 'New')).toEqual(
    added.identities.new,
  );
  await capture(root);
  rmSync(resolve(root, ADDED));
  const pair = pairAt(root);
  const removed = await preview(root);
  expect(removed).toMatchObject({
    records: first.records,
    changed: 0,
    new: 0,
    removed: 1,
    identities: { changed: [], new: [], removed: added.identities.new },
  });
  expect(listedUnder((await run(['capture', '--preview', '--root', root])).stdout, 'Removed')).toEqual(
    added.identities.new,
  );
  expect(pairAt(root)).toEqual(pair);
});

it('refuses under --preview as a capture does, before anything is written, naming the same next command', async () => {
  // A root whose own sources declare no @workspace.
  const empty = realpathSync(scratch('capture-preview-empty'));
  const refused = await run(['capture', '--preview', '--root', empty, '--json']);
  expect(refused.exitCode).toBe(3);
  const body = JSON.parse(refused.stdout) as { code: string; message: string; next: string; where: { path: string } };
  expect(body).toMatchObject({ code: 'IA-DB-ROOT-INVALID', where: { path: empty } });
  expect(commandsIn(body.next)).toEqual([`ia init ${quote(empty)}`]);
  expect(existsSync(resolve(empty, '.ia'))).toBe(false);
  // A floor input that fails to parse; the pair is kept.
  const root = workspace();
  await capture(root);
  edit(root);
  await capture(root);
  const pair = pairAt(root),
    floor = '.ia/src/floor/artifact-set.ia',
    text = readFileSync(resolve(root, floor), 'utf8');
  writeFileSync(resolve(root, floor), `${text}\n@@@ not a record header\n`);
  const unparsed = await run(['capture', '--preview', '--root', root, '--json']);
  expect(unparsed.exitCode).toBe(3);
  const failed = JSON.parse(unparsed.stdout) as typeof body;
  expect(failed.code).toMatch(/^IA-LANG-/);
  expect(failed.where.path).toBe(floor);
  expect(failed.message).toContain('the previous snapshot is kept');
  expect(commandsIn(failed.next)).toEqual([`ia validate --root ${quote(root)}`]);
  expect(pairAt(root)).toEqual(pair);
  // The db's checks refuse a preview too, and the repair names the preview again.
  const unsafe = workspace();
  writeFileSync(resolve(unsafe, '.ia/work'), 'not a directory\n');
  const blocked = JSON.parse((await run(['capture', '--preview', '--root', unsafe, '--json'])).stdout) as typeof body;
  expect(blocked).toMatchObject({ code: 'IA-DB-PATH-UNSAFE', where: { path: '.ia/work' } });
  expect(commandsIn(blocked.next)).toEqual([`ia capture --preview --root ${quote(unsafe)}`]);
  rmSync(resolve(unsafe, '.ia/work'));
  expect((await run(nextArgv(blocked.next))).exitCode).toBe(0);
  expect(existsSync(resolve(unsafe, '.ia/work'))).toBe(false);
});

it('names no path to make writable when a preview cannot read the pair, since a preview writes nothing', async () => {
  const root = workspace();
  await capture(root);
  const pair = pairAt(root);
  // What reading current.json throws when the system will not let it be read.
  seams.plan = (at) => {
    const path = resolve(at, CURRENT);
    throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
      code: 'EACCES',
      syscall: 'open',
      path,
    });
  };
  try {
    const refused = await run(['capture', '--preview', '--root', root, '--json']);
    expect(refused.exitCode).toBe(3);
    const body = JSON.parse(refused.stdout) as { code: string; next: string; where: unknown };
    // The generic next for a system error, not the repair a capture's failed write names.
    expect(body).toMatchObject({ code: 'IA-CLI-FAILED', where: null });
    expect(body.next).not.toContain('writable');
    expect(commandsIn(body.next)).toEqual([`ia doctor --root ${quote(root)}`]);
  } finally {
    seams.plan = undefined;
  }
  expect(pairAt(root)).toEqual(pair);
  expect((await preview(root)).changed).toBe(0);
});

it('escapes the terminal controls a prior capture identity carries in the human preview, and keeps them in --json', async () => {
  // A removed identity is read from the current.json on disk, whose rows only their shape is checked against.
  const root = workspace();
  await capture(root);
  const crafted = 'evil\u001b[2J\u001b[31mFORGED\u0007',
    prior = snapshotAt(root);
  writeFileSync(
    resolve(root, CURRENT),
    `${JSON.stringify({
      ...prior,
      membership: [...prior.membership, { identity: crafted, root: '', band: 100, digest: 'a'.repeat(64) }],
    })}\n`,
  );
  const pair = pairAt(root);
  expect(await preview(root)).toMatchObject({ removed: 1, ignored: null, identities: { removed: [crafted] } });
  const human = await run(['capture', '--preview', '--root', root, '--ascii', '--no-color']);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(listedUnder(human.stdout, 'Removed')).toEqual(['evil\\u001b[2J\\u001b[31mFORGED\\u0007']);
  // Colour adds only the renderer's own SGR: stripped of it, the coloured report is the plain one.
  const view = previewCapture(root),
    colored = renderCapture(view, { color: true, ascii: true, width: 80 });
  expect(colored).not.toContain('\u001b[2J');
  expect(stripVTControlCharacters(colored)).toBe(renderCapture(view, { color: false, ascii: true, width: 80 }));
  expect(pairAt(root)).toEqual(pair);
});

it('lists ia capture in the help, and ia compile as the deprecated 1.x verb with its 1.x syntax', async () => {
  const global = (await run(['--help'])).stdout;
  expect(global).toContain('capture');
  // Every command row fits the 80 columns piped help is rendered at, so no wrapped fragment reads as a command name.
  const lines = global.split('\n');
  for (const command of COMMANDS)
    expect(
      lines.some((line) => line.trimStart().startsWith(`${command.name} `) && line.endsWith(command.summary)),
      command.name,
    ).toBe(true);
  const help = await run(['capture', '--help']);
  expect(help.stdout).toContain('ia capture [--preview] [--json]');
  expect(flat(help.stdout)).toContain('--preview Report what the capture would write; write nothing');
  // Decision release-bump: `ia compile` keeps its 1.x grammar; the alias of decision compile-verb-fate waits for 2.0.
  const compile = await run(['compile', '--help']);
  expect(compile.stdout).toContain('ia compile [--out <file> | --stdout] [--force] [--json]');
  expect(flat(compile.stdout)).toContain('deprecated: use capture');
});

it("keeps ia compile and ia capture apart: neither writes the other one's file", async () => {
  const root = workspace();
  const compiled = await run(['compile', '--root', root, '--json']);
  expect(compiled.exitCode).toBe(0);
  expect(compiled.stderr).toBe(DEPRECATION);
  expect(DEPRECATION).toContain(CURRENT);
  expect(existsSync(resolve(root, DEFAULT_OUT))).toBe(true);
  expect(existsSync(resolve(root, SNAPSHOT_DIRECTORY))).toBe(false);
  const artifact = bytesAt(root, DEFAULT_OUT);
  const captured = await capture(root);
  expect(captured.prior).toBeNull();
  expect(bytesAt(root, DEFAULT_OUT)).toEqual(artifact);
  expect(snapshotAt(root).format).toBe(SNAPSHOT_FORMAT);
  // A capture never makes a second compile succeed: the 1.x refusal for an existing artifact still answers.
  const again = await run(['compile', '--root', root, '--json']);
  expect(again.exitCode).toBe(3);
  expect(JSON.parse(again.stdout)).toMatchObject({ code: 'IA-DIST-LOCAL-MODIFICATION' });
  expect(again.stderr).toBe('');
});
