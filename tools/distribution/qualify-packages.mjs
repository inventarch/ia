import '../temp/physical-temp.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { packPublicPackages, COMPATIBILITY } from '../release/public-pack.mjs';
import { scanPackedPublicContent } from '../release/scan-packed.mjs';
import assert from 'node:assert/strict';
import { executableExports, systemVerificationProgram } from './installed-consumer.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPOSITORY_URL, REGISTRY, writeReleaseManifest } from './npm-release.mjs';

const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Build first, then run pnpm packages:qualify');
const { values } = parseArgs({ options: { 'pack-destination': { type: 'string' } } });
const destination = values['pack-destination'] ? resolve(root, values['pack-destination']) : undefined;
if (destination && existsSync(destination))
  assert.equal(readdirSync(destination).length, 0, 'Pack destination must be empty');
const temporaryRoot = realpathSync(tmpdir()),
  temporary = mkdtempSync(resolve(temporaryRoot, 'ia-release-packages-')),
  consumer = resolve(temporary, 'consumer with spaces'),
  cliConsumer = resolve(temporary, 'cli consumer with spaces'),
  archives = resolve(temporary, 'archives'),
  home = resolve(temporary, 'home'),
  workspace = resolve(temporary, 'workspace with spaces');
const run = (args, cwd = root, env = process.env, command = process.execPath) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
const packageManager = (args, cwd = root) => {
  const invocation = packageManagerCommand(pnpm, args);
  return run(invocation.args, cwd, process.env, invocation.command);
};
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
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
function qualifyInstalledViews(cli, cwd, env, workspace) {
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
  refusal(['next'], 1, 'IA-RUNTIME-NEXT-CYCLE', `ia next ${rooted}`, 'Remove one of the require rows');
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
const releasedVersion = json(resolve(root, 'apps/cli/package.json')).version,
  supportedNode = json(resolve(root, 'package.json')).engines.node;
try {
  for (const path of [consumer, cliConsumer, archives, home]) mkdirSync(path);
  const projects = JSON.parse(packageManager(['list', '-r', '--depth', '-1', '--json']))
    .map(({ path }) => ({ path, manifest: json(resolve(path, 'package.json')) }))
    .filter(({ manifest }) => !manifest.private);
  assert.ok(projects.length > 0, 'No public packages discovered');
  // Release preparation (a pack destination) requires the committed seal; ordinary qualification packs the selection
  // this checkout would seal, so a pull request need not rewrite the descriptor.
  const bundled = packPublicPackages(root, archives, pnpm, { sealed: Boolean(destination) });
  const packed = bundled.packed;
  const contentScan = scanPackedPublicContent(root, packed);
  assert.equal(packed.length, projects.length);
  const dependencies = Object.fromEntries(
    packed.map(({ name, filename }) => [name, 'file:' + filename.replaceAll('\\', '/')]),
  );
  // The release is not in a registry yet. Overrides resolve each already-validated package version to its tarball.
  // Prefer the contributor cache; a clean frozen install may have tarballs without registry metadata, so allow
  // metadata retrieval here. The installed CLI commands below run separately with all fetch calls refused.
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify({
      name: 'ia-release-consumer',
      private: true,
      type: 'module',
      dependencies,
    }),
  );
  writeFileSync(
    resolve(consumer, 'pnpm-workspace.yaml'),
    JSON.stringify({ packages: ['.'], overrides: dependencies }, null, 2),
  );
  packageManager(['install', '--prefer-offline', '--ignore-scripts', '--lockfile=false'], consumer);
  const verification = resolve(consumer, 'verify-installed.mjs');
  const verificationCode = systemVerificationProgram;
  writeFileSync(verification, verificationCode);
  run([verification, resolve(archives, COMPATIBILITY), consumer]);
  const imports = [];
  let targets = 0;
  for (const { manifest: source } of projects) {
    const installedRoot = resolve(consumer, 'node_modules', source.name),
      installed = json(resolve(installedRoot, 'package.json'));
    assert.equal(installed.name, source.name);
    assert.equal(installed.version, source.version, `${source.name}: release version differs`);
    assert.equal(installed.engines?.node, supportedNode, `${source.name}: runtime policy differs`);
    assert.equal(installed.publishConfig?.access, 'public', `${source.name}: public npm access is not declared`);
    assert.equal(installed.publishConfig?.registry, REGISTRY, `${source.name}: npm registry differs`);
    assert.equal(installed.repository?.url, REPOSITORY_URL, `${source.name}: provenance repository differs`);
    for (const script of ['preinstall', 'install', 'postinstall'])
      assert.ok(!installed.scripts?.[script], `${source.name}: consumers must not require lifecycle scripts`);
    assert.equal(installed.license, 'Apache-2.0');
    for (const notice of ['LICENSE', 'NOTICE'])
      assert.equal(readFileSync(resolve(installedRoot, notice), 'utf8'), readFileSync(resolve(root, notice), 'utf8'));
    for (const [name, version] of Object.entries(installed.dependencies ?? {})) {
      assert.ok(
        !/^(workspace:|catalog:|link:|file:|https?:|git[+:]|github:|gitlab:|bitbucket:)/.test(version),
        `${source.name}: unsupported dependency source ${name}`,
      );
      if (name.startsWith('@inventarch/')) {
        assert.ok(dependencies[name], `${source.name}: dependency ${name} is missing from the release`);
        assert.equal(
          version,
          projects.find((row) => row.manifest.name === name)?.manifest.version,
          `${source.name}: dependency ${name} has a different release version`,
        );
      }
    }
    const target = (path) => {
      const resolved = resolve(installedRoot, path),
        within = relative(installedRoot, resolved);
      assert.ok(!isAbsolute(within) && within !== '..' && !within.startsWith('..\\') && !within.startsWith('../'));
      assert.ok(existsSync(resolved), `${source.name}: packed target is missing: ${path}`);
      targets++;
    };
    const exported = (value) => {
      if (typeof value === 'string') target(value);
      else if (value && typeof value === 'object')
        for (const [condition, entry] of Object.entries(value)) {
          assert.notEqual(condition, 'development', `${source.name}: development condition leaks into release`);
          exported(entry);
        }
    };
    exported(installed.exports);
    for (const field of ['main', 'types']) if (installed[field]) target(installed[field]);
    for (const path of Object.values(installed.bin ?? {})) {
      target(path);
      assert.ok(readFileSync(resolve(installedRoot, path), 'utf8').startsWith('#!/usr/bin/env node'));
    }
    imports.push(...executableExports(installed));
  }
  writeFileSync(
    resolve(consumer, 'imports.mjs'),
    `for (const name of ${JSON.stringify(imports)}) await import(name);\nconsole.log('Imported ${imports.length} exports');\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    IA_HOME: resolve(home, 'ia'),
    IA_HOST_HOME: resolve(home, 'ia'),
    IA_CONFIG_HOME: resolve(home, 'config/ia'),
    IA_REGISTRY: '',
    IA_NO_UPDATE_CHECK: '1',
    APPDATA: resolve(home, 'AppData/Roaming'),
    LOCALAPPDATA: resolve(home, 'AppData/Local'),
    XDG_CONFIG_HOME: resolve(home, 'config'),
    XDG_CACHE_HOME: resolve(home, 'cache'),
    XDG_DATA_HOME: resolve(home, 'data'),
    CODEX_HOME: resolve(home, '.codex'),
    CLAUDE_CONFIG_DIR: resolve(home, '.claude'),
    NODE_OPTIONS: '',
    NO_COLOR: '1',
  };
  assert.equal(
    run(['--conditions=development', 'imports.mjs'], consumer, env).trim(),
    `Imported ${imports.length} exports`,
  );
  // A second installation exposes only the CLI as a direct dependency. Other public packages at the consumer's
  // top level must not accidentally satisfy an undeclared CLI dependency.
  writeFileSync(
    resolve(cliConsumer, 'package.json'),
    JSON.stringify({
      name: 'ia-cli-release-consumer',
      private: true,
      type: 'module',
      dependencies: { '@inventarch/cli': dependencies['@inventarch/cli'] },
    }),
  );
  writeFileSync(
    resolve(cliConsumer, 'pnpm-workspace.yaml'),
    JSON.stringify({ packages: ['.'], overrides: dependencies }, null, 2),
  );
  packageManager(['install', '--prefer-offline', '--ignore-scripts', '--lockfile=false'], cliConsumer);
  writeFileSync(
    resolve(cliConsumer, 'offline.mjs'),
    "globalThis.fetch = () => { throw new Error('Installed CLI qualification must not use the network'); };\n",
  );
  const cli = resolve(cliConsumer, 'node_modules/@inventarch/cli/dist/main.js'),
    invoke = (args) => run(['--import', './offline.mjs', cli, ...args], cliConsumer, env);
  assert.equal(invoke(['--version']).trim(), releasedVersion);
  assert.match(invoke(['--help']), /ia <command>/);
  const initialized = JSON.parse(invoke(['init', workspace, '--apply', '--yes', '--json']));
  assert.equal(initialized.applied.status, 'initialized');
  invoke(['validate', '--root', workspace, '--json']);
  for (const host of ['claude', 'codex']) invoke(['host', host, '--root', workspace, '--apply', '--yes', '--json']);
  invoke(['validate', '--root', workspace, '--json']);
  const installedViews = qualifyInstalledViews(cli, cliConsumer, env, workspace);
  assert.match(
    run([resolve(consumer, 'node_modules/@inventarch/distribution/dist/cli.js'), '--help'], consumer, env),
    /ia-distribution/,
  );
  const vsix = resolve(archives, `inventarch-ia-${releasedVersion}.vsix`);
  packageManager(['exec', 'vsce', 'package', '--no-dependencies', '--out', vsix], resolve(root, 'apps/vscode'));
  assert.ok(existsSync(vsix));
  if (destination) {
    mkdirSync(destination, { recursive: true });
    for (const entry of packed) copyFileSync(entry.filename, resolve(destination, basename(entry.filename)));
    copyFileSync(resolve(archives, COMPATIBILITY), resolve(destination, COMPATIBILITY));
    // Not an npm archive: the publisher reads only receipt-listed .tgz files. The GitHub release attaches it.
    copyFileSync(vsix, resolve(destination, basename(vsix)));
    writeReleaseManifest(root, destination, packed);
  }
  console.log(
    JSON.stringify({
      contentScan,
      packages: projects.length,
      exports: imports.length,
      targets,
      version: releasedVersion,
      node: process.version,
      platform: process.platform,
      installedCli: ['init', 'validate', 'host claude', 'host codex', ...installedViews],
      vsix: true,
    }),
  );
} finally {
  assert.equal(dirname(temporary), temporaryRoot, 'Refusing cleanup outside the temporary root');
  assert.ok(relative(temporaryRoot, temporary).startsWith('ia-release-packages-'));
  rmSync(temporary, { recursive: true, force: true });
}
