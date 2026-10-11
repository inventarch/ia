/**
 * The installed-CLI scenario of `pnpm packages:qualify`: authored expectations against one CLI entry only, run through
 * `node --import ./offline.mjs <cli>` in `cwd`, which must hold an offline.mjs that refuses the network. The workspace
 * is one `ia init --apply` made and `ia host claude` and `ia host codex` applied to. qualify-packages.mjs runs it
 * against the packed and installed CLI; installed-views.test.ts runs it against this checkout's built CLI, so a gate
 * that runs locally holds the same expectations.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Include names, bytes and modification times: a read must neither add files nor rewrite existing ones.
const tree = (directory, directoryTimes = true) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = resolve(entry.parentPath, entry.name);
      return [
        relative(directory, path),
        entry.isFile() || directoryTimes ? statSync(path).mtimeMs : null,
        entry.isFile() ? sha256(readFileSync(path)) : null,
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b));

/** Authored expectations against the installed CLI only; no repository runtime or fixture supplies the oracle. */
export function qualifyInstalledViews(cli, cwd, env, workspace) {
  const invoke = (args, exit = 0, deprecation = false) => {
    const result = spawnSync(process.execPath, ['--import', './offline.mjs', cli, ...args, '--root', workspace], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, exit, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    if (deprecation) assert.match(result.stderr, /^Deprecated: ia compile[^\n]*ia capture[^\n]*\n$/);
    else assert.equal(result.stderr, '');
    return result.stdout;
  };
  const machine = (args, exit = 0, deprecation = false) => JSON.parse(invoke([...args, '--json'], exit, deprecation));
  const rooted = `--root ${JSON.stringify(workspace)}`;
  const refusal = (args, exit, code, command, repair, directoryTimes = true) => {
    const before = tree(workspace, directoryTimes),
      result = machine(args, exit);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.exit, exit);
    assert.ok(result.next.includes('ia '), 'Refusal must name a repair command');
    assert.ok(result.next.includes(`"${command}"`), `Refusal must name "${command}": ${result.next}`);
    assert.ok(result.next.includes(repair), `Refusal must explain ${repair}: ${result.next}`);
    assert.deepEqual(tree(workspace, directoryTimes), before, 'Refusal changed workspace files');
  };
  const plan = 'work-system/definition/plan/qualification',
    milestone = 'work-system/definition/milestone/qualification',
    prerequisite = 'work-system/definition/task/z-prepare',
    dependent = 'work-system/definition/task/a-deliver',
    source = resolve(workspace, '.ia/src/qualification.ia'),
    document = resolve(workspace, 'qualification.md'),
    body = '# Installed consumer\n\nOnly these authored document bytes are the plan body.\n',
    says = 'Prepare the installed consumer artifact.';
  // Reverse lexical order makes a mistaken identity-only task sort observable. Closed is deliberately not evidence.
  const authored = `#! ia 1.0

@plan qualification
  meaning
    says "This fallback must not replace the external document."
  work
    title "Installed consumer qualification"
    status open
    source "qualification.md"

@milestone qualification
  meaning
    says "Qualify the installed commands."
  work
    title "Qualification"
    status open
    plan @plan qualification
    exit "Both tasks have exit evidence."

@task a-deliver
  meaning
    says "Deliver the prepared artifact."
  work
    title "Deliver"
    status open
    milestone @milestone qualification
  relationships
    requires @task z-prepare

@task z-prepare
  meaning
    says "${says}"
  work
    title "Prepare"
    status closed
    milestone @milestone qualification
`;
  writeFileSync(source, authored);
  writeFileSync(document, body);
  machine(['validate']);
  const captured = machine(['capture']),
    current = resolve(workspace, '.ia/work/snapshot/current.json');
  const snapshotBytes = readFileSync(current),
    snapshot = JSON.parse(snapshotBytes);
  assert.equal(captured.format, 'ia-snapshot-1');
  assert.equal(snapshot.format, 'ia-snapshot-1');
  assert.equal(captured.digest, sha256(snapshotBytes));
  assert.equal(captured.admission.errors, 0);
  for (const identity of [plan, milestone, prerequisite, dependent])
    assert.ok(
      snapshot.records.some((record) => record.identity === identity),
      `Capture omitted ${identity}`,
    );
  const repeated = machine(['capture']);
  assert.equal(repeated.revision, captured.revision);
  assert.equal(repeated.digest, captured.digest);
  assert.equal(repeated.changed, 0);
  assert.equal(repeated.new, 0);
  assert.equal(repeated.removed, 0);
  assert.equal(repeated.unchanged, captured.records);
  assert.equal(repeated.rotated, false);
  assert.deepEqual(readFileSync(current), snapshotBytes);

  const beforeReads = tree(workspace);
  for (const [identity, expected] of [
    [plan, body],
    [prerequisite, says],
  ]) {
    const read = machine(['read', identity]);
    assert.equal(read.identity, identity);
    assert.equal(read.body, expected);
    assert.equal(read.digest, sha256(expected));
    assert.equal(read.certified, false);
  }
  const delivery = machine(['next']);
  assert.equal(delivery.ok, true);
  assert.equal(delivery.view.format, 'ia.delivery-view.v1');
  assert.equal(delivery.view.plan, plan);
  assert.equal(delivery.view.revision, captured.revision);
  assert.deepEqual(
    delivery.view.tasks.map(({ identity, verdict }) => [identity, verdict]),
    [
      [prerequisite, 'unblocked'],
      [dependent, 'blocked'],
    ],
  );
  assert.equal(delivery.view.tasks[0].status, 'status closed (self-declared)');
  assert.equal(delivery.view.tasks[1].prerequisites[0].target, prerequisite);
  assert.equal(delivery.view.tasks[1].prerequisites[0].satisfied, false);
  assert.equal(delivery.view.milestones[0].satisfied, false);
  assert.equal(delivery.view.next, `ia position --seat ${prerequisite} --shape sequence`);
  assert.deepEqual(machine(['next', '--seat', dependent]), delivery);
  assert.deepEqual(tree(workspace), beforeReads, 'Read/next wrote workspace files');

  // An uncaptured edit must be visible immediately; reading the retained capture would return closed and old bytes.
  const revisedSays = 'Prepare the revised installed consumer artifact.';
  writeFileSync(source, authored.replace(says, revisedSays).replace('status closed', 'status held'));
  const beforeLiveReads = tree(workspace),
    liveRead = machine(['read', prerequisite]),
    liveNext = machine(['next']);
  assert.equal(liveRead.body, revisedSays);
  assert.equal(liveRead.digest, sha256(revisedSays));
  assert.equal(liveRead.certified, false);
  assert.equal(liveNext.ok, true);
  assert.notEqual(liveNext.view.revision, captured.revision);
  assert.equal(liveNext.view.tasks[0].identity, prerequisite);
  assert.equal(liveNext.view.tasks[0].status, 'status held (self-declared)');
  assert.equal(liveNext.view.tasks[1].verdict, 'blocked');
  assert.deepEqual(readFileSync(current), snapshotBytes, 'Live reads replaced the retained capture');
  assert.deepEqual(tree(workspace), beforeLiveReads, 'Live read/next wrote workspace files');
  writeFileSync(source, authored);

  // A missing source must refuse, never silently fall back to the record's says text.
  unlinkSync(document);
  refusal(['read', plan], 3, 'IA-RUNTIME-READ-UNREACHABLE', `ia inspect ${plan} ${rooted}`, 'Restore qualification.md');
  writeFileSync(document, body);
  writeFileSync(source, `${authored}  relationships\n    requires @task a-deliver\n`);
  // The cycle's first task in the view's order is the one to seat at (apps/cli next, cycleSeat).
  refusal(
    ['next'],
    1,
    'IA-RUNTIME-NEXT-CYCLE',
    `ia position --seat ${dependent} --shape sequence ${rooted}`,
    'one of them must go',
  );
  writeFileSync(source, authored);
  const brokenSeed = resolve(workspace, '.ia/src/floor/qualification-invalid.ia'),
    hadFloor = existsSync(dirname(brokenSeed));
  mkdirSync(dirname(brokenSeed), { recursive: true });
  writeFileSync(brokenSeed, '#! ia 1.0\n@\n');
  refusal(['capture'], 3, 'IA-LANG-HEADER-MALFORMED', `ia validate ${rooted}`, 'repair the input');
  unlinkSync(brokenSeed);
  // An empty explicit floor shadows the bundled floor, so undo the directory only when this check created it.
  if (!hadFloor) rmdirSync(dirname(brokenSeed));
  machine(['validate']);
  assert.deepEqual(readFileSync(current), snapshotBytes, 'Refused capture replaced the retained snapshot');

  // The published 1.x CLI retains compile's artifact, stderr warning and overwrite refusal, not capture semantics.
  const beforeCompile = tree(workspace),
    stdout = invoke(['compile', '--stdout'], 0, true);
  const artifact = JSON.parse(stdout);
  assert.equal(artifact.artifact, 'ia.compiled.v1');
  assert.equal(artifact.formatVersion, 1);
  assert.ok(artifact.records.some((record) => record.identity === plan));
  assert.ok(artifact.records.every((record) => !Object.hasOwn(record, 'digest')));
  assert.deepEqual(tree(workspace), beforeCompile, 'Compile --stdout wrote workspace files');
  const compiled = machine(['compile'], 0, true),
    compiledPath = resolve(workspace, '.ia/work/compiled.json');
  assert.equal(compiled.artifact, compiledPath);
  assert.equal(readFileSync(compiledPath, 'utf8'), stdout);
  assert.equal(compiled.digest, sha256(stdout));
  const foreign = 'Locally edited compiled output must survive refusal.\n';
  writeFileSync(compiledPath, foreign);
  // Legacy createFile stages then removes a temporary file on EEXIST (distribution/src/files.ts), changing only
  // the directory mtime. Preserve its 1.x semantics while checking entry inventory and every file's bytes/mtime.
  refusal(['compile'], 3, 'IA-DIST-LOCAL-MODIFICATION', `ia compile --force ${rooted}`, 'overwrite it', false);
  assert.equal(readFileSync(compiledPath, 'utf8'), foreign);
  machine(['compile', '--force'], 0, true);
  assert.equal(readFileSync(compiledPath, 'utf8'), stdout);
  assert.deepEqual(readFileSync(current), snapshotBytes, 'Legacy compile changed capture output');
  return [
    'capture idempotence',
    'read bodies and digests',
    'next dependency order and declared status',
    'read/next observe uncaptured edits',
    'read/next no writes',
    'read/capture/next refusals',
    'compile 1.x compatibility',
  ];
}
