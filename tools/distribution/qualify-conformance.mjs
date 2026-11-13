import '../temp/physical-temp.mjs';
import { ensureQualification, installConsumer } from './consumer.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { parseOptions } from '../shared/args.mjs';
import { containedFile } from '../shared/paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Compliance C31 from the installed packages, inside the sandbox a consumer runs IA in: a worker under Node's permission
 * model that may read only the consumer's node_modules, with no write grant and a 128 MB heap. The host side, which is
 * not sandboxed, initializes the corpora and reads each one into an `InputSnapshot`; the worker receives the snapshot
 * on stdin and opens it with `EditorSnapshot` and `{conformance: 'verify'}`, so it never reads the workspace.
 *
 * By default the packages are the ordinary packed cohort (`packages:pack`); `--registry <version>` installs that
 * published version from the npm registry instead, which is how a release is checked after publication.
 */
const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env['npm_execpath'];
const PACKAGES = ['@inventarch/language', '@inventarch/graph', '@inventarch/compliance', '@inventarch/db'];
/** Only the host side uses the CLI: `ia init` writes the starter corpora. */
const CLI = '@inventarch/cli';
const OUT_OF_PROFILE = ['HOOK', 'RUNTIME', 'escalation', 'EXEC', 'PUBLICATION'];
const HEAP_MB = 128,
  PRODUCER_BUDGET_MS = 2000;
const REGISTRY = 'https://registry.npmjs.org/';

let options;
try {
  options = parseOptions(process.argv.slice(2), {
    values: ['manifest', 'registry'],
    exclusive: [['manifest', 'registry']],
  });
  const version = options.value('registry');
  if (version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`--registry takes an exact published version, not ${version}`);
} catch (error) {
  console.error(String(error));
  process.exit(2);
}
if (!pnpm) throw new Error('Run through pnpm conformance:qualify');
const registry = options.value('registry');
const selected = registry === undefined ? ensureQualification(root, pnpm, options.value('manifest')) : undefined;
const expected = new Map(
  [CLI, ...PACKAGES].map((name) => {
    if (registry !== undefined) return [name, registry];
    const row = selected?.packed.find((entry) => entry.name === name);
    assert(row, `${name} is missing from the packed cohort`);
    return [name, row.version];
  }),
);

const temporaryRoot = realpathSync(tmpdir()),
  temporary = mkdtempSync(join(temporaryRoot, 'ia-conformance-sandbox-')),
  identity = lstatSync(temporary),
  consumer = join(temporary, 'consumer with spaces'),
  home = join(temporary, 'home'),
  corpora = join(temporary, 'corpora');
// Every child prints JSON, so no color setting is passed on: Node 22.22.0 warns on stderr at every console.log when
// FORCE_COLOR, which CI sets, and NO_COLOR are both present.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FORCE_COLOR|NO_COLOR)$/i.test(key))),
  HOME: home,
  USERPROFILE: home,
  IA_HOME: join(home, 'ia'),
  IA_HOST_HOME: join(home, 'ia'),
  IA_CONFIG_HOME: join(home, 'config/ia'),
  IA_REGISTRY: '',
  IA_NO_UPDATE_CHECK: '1',
  APPDATA: join(home, 'AppData/Roaming'),
  LOCALAPPDATA: join(home, 'AppData/Local'),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_DATA_HOME: join(home, 'data'),
  NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
  NODE_AUTH_TOKEN: '',
  NPM_TOKEN: '',
  NODE_OPTIONS: '',
};
/** Runs Node on the host side, outside the sandbox. @param {readonly string[]} args @param {string} [input] */
const host = (args, input) =>
  execFileSync(process.execPath, args, {
    cwd: consumer,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });

/**
 * The worker side. It reads nothing but stdin and node_modules; the probe path, a file outside node_modules, only
 * confirms that the sandbox denies reading and writing it.
 */
const SANDBOX = `import { readFileSync, writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
const probe = process.argv[1];
const denied = (operation) => { try { operation(); return false; } catch (error) { return error?.code === 'ERR_ACCESS_DENIED'; } };
const sandbox = () => ({
  readDenied: denied(() => readFileSync(probe)),
  writeDenied: denied(() => writeFileSync(probe + '.written', '')),
  writeGranted: process.permission?.has('fs.write') ?? true,
});
const heap = () => { const statistics = getHeapStatistics(); return { used: statistics.used_heap_size, total: statistics.total_heap_size, limit: statistics.heap_size_limit, maxRss: process.resourceUsage().maxRSS * 1024 }; };`;
const PRODUCERS = `${SANDBOX}
const { verifyFixtures, verifyKernel } = await import('@inventarch/compliance');
let started = performance.now();
const kernel = verifyKernel(), kernelMs = performance.now() - started;
started = performance.now();
const fixtures = verifyFixtures(), fixturesMs = performance.now() - started;
console.log(JSON.stringify({ kernel: kernel.assessment.outcome, fixtures: fixtures.assessment.outcome, kernelMs, fixturesMs, heap: heap(), sandbox: sandbox() }));`;
const SNAPSHOT = `${SANDBOX}
const { EditorSnapshot } = await import('@inventarch/db/editor');
const input = JSON.parse(readFileSync(0, 'utf8'));
const started = performance.now();
const snapshot = new EditorSnapshot(input, [], { conformance: 'verify' });
const report = snapshot.report, ms = performance.now() - started;
const verdicts = report.verdicts
  .filter((verdict) => verdict.check === 'COMP-KERNEL' || verdict.check === 'COMP-FIXTURES')
  .map(({ check, outcome, basis }) => ({ check, outcome, basis: basis ?? null }))
  .sort((a, b) => a.check.localeCompare(b.check));
const conformance = report.conformance && {
  profile: report.conformance.profile,
  floorDigest: report.conformance.kernel?.floorDigest ?? null,
  outOfProfile: report.conformance.fixtures?.outOfProfile.map((suite) => suite.suite) ?? null,
};
snapshot.close();
console.log(JSON.stringify({ outcome: report.outcome, verdicts, conformance, ms, heap: heap(), sandbox: sandbox() }));`;
/** Runs `program` in the sandbox: read access to the consumer's node_modules only, no write grant, a 128 MB heap. */
const sandboxed = (program, probe, input = '') => {
  const run = spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${join(consumer, 'node_modules')}`,
      `--max-old-space-size=${HEAP_MB}`,
      '--input-type=module',
      '--eval',
      program,
      probe,
    ],
    { cwd: consumer, env, input, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, `Sandboxed worker failed:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.stderr, '', `Sandboxed worker wrote to stderr:\n${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(
    result.sandbox,
    { readDenied: true, writeDenied: true, writeGranted: false },
    'The worker was not confined to reading node_modules',
  );
  assert.ok(result.heap.limit < 2 * HEAP_MB * 1024 * 1024, `The worker's heap limit is ${result.heap.limit} bytes`);
  // The cap enforces the budget; the committed heap shows how far below it the worker stayed.
  assert.ok(result.heap.total < HEAP_MB * 1024 * 1024, `The worker committed ${result.heap.total} bytes of heap`);
  return result;
};

try {
  for (const path of [consumer, home, corpora]) mkdirSync(path);
  writeFileSync(join(home, '.npmrc'), `registry=${REGISTRY}\n`);
  if (selected !== undefined)
    // Packed system manifests depend on the whole cohort at the candidate version, which may be unpublished: every
    // member is overridden with its verified archive, and `names` selects the direct dependencies.
    installConsumer(consumer, selected.packed, pnpm, {
      name: 'conformance-sandbox-consumer',
      names: [...expected.keys()],
    });
  else {
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'conformance-registry-consumer',
          private: true,
          type: 'module',
          dependencies: Object.fromEntries(expected),
        },
        null,
        2,
      ) + '\n',
    );
    const install = packageManagerCommand(pnpm, ['install', '--ignore-scripts', '--lockfile=false']);
    execFileSync(install.command, install.args, {
      cwd: consumer,
      // Only the npm registry: no inherited npm or pnpm setting, such as a mirror, may choose where the packages come from.
      env: {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^p?npm_config_/i.test(key))),
        npm_config_registry: REGISTRY,
        pnpm_config_registry: REGISTRY,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  for (const [name, version] of expected) {
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installed.name, name);
    assert.equal(installed.version, version, `${name}: installed version differs`);
  }

  // The host side: three starters from the installed CLI, two of them given a local floor, one byte changed in one.
  writeFileSync(
    join(consumer, 'offline.mjs'),
    "globalThis.fetch=()=>{throw Error('Qualification network refused')};\n",
  );
  const cli = join(consumer, 'node_modules', CLI, 'dist/main.js');
  const workspaces = { starter: 'embedded', 'local floor': 'local', 'changed floor': 'local' };
  const offline = pathToFileURL(join(consumer, 'offline.mjs')).href;
  for (const name of Object.keys(workspaces))
    host(['--import', offline, cli, 'init', join(corpora, name), '--host', 'none', '--apply', '--yes', '--json']);
  writeFileSync(
    join(consumer, 'floor.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KERNEL_SOURCES } from '@inventarch/language';
const [root, change] = process.argv.slice(2), [changed] = KERNEL_SOURCES.filter((source) => source.text.includes('says "'));
for (const source of KERNEL_SOURCES) {
  const at = source.text.indexOf('says "') + 'says "'.length;
  const text = change === 'change' && source === changed ? source.text.slice(0, at) + (source.text[at] === 'x' ? 'y' : 'x') + source.text.slice(at + 1) : source.text;
  mkdirSync(dirname(join(root, source.path)), { recursive: true });
  writeFileSync(join(root, source.path), text);
}\n`,
  );
  host([join(consumer, 'floor.mjs'), join(corpora, 'local floor'), 'keep']);
  host([join(consumer, 'floor.mjs'), join(corpora, 'changed floor'), 'change']);
  writeFileSync(
    join(consumer, 'inputs.mjs'),
    "import { readInputs } from '@inventarch/db';\nprocess.stdout.write(JSON.stringify(readInputs(process.argv[2])));\n",
  );

  const probe = join(corpora, 'starter', '.ia/src/workspace.ia');
  // Three fresh processes, each cold. The first reads files the install has just written, which an antivirus scan or a
  // cold disk can slow by a second or more, and a shared runner's scheduling can slow any one process: the budget is
  // the producers' own, so it is judged on the faster of the other two.
  const runs = [0, 1, 2].map(() => sandboxed(PRODUCERS, probe));
  for (const run of runs)
    assert.deepEqual([run.kernel, run.fixtures], ['pass', 'pass'], 'The producers did not pass cold');
  const elapsed = (run) => run.kernelMs + run.fixturesMs,
    [first, ...cold] = runs,
    producers = cold.reduce((fastest, run) => (elapsed(run) < elapsed(fastest) ? run : fastest));
  const producerMs = elapsed(producers);
  assert.ok(producerMs < PRODUCER_BUDGET_MS, `Both producers took ${Math.round(producerMs)} ms cold`);

  /** @type {Record<string, any>} */
  const results = {};
  for (const [name, origin] of Object.entries(workspaces)) {
    const snapshot = host([join(consumer, 'inputs.mjs'), join(corpora, name)]);
    assert.equal(JSON.parse(snapshot).floorOrigin, origin, `${name}: the floor is not ${origin}`);
    results[name] = sandboxed(SNAPSHOT, probe, snapshot);
  }
  const verified = (kernel) => [
    { check: 'COMP-FIXTURES', outcome: 'pass', basis: 'verified' },
    { check: 'COMP-KERNEL', outcome: kernel, basis: 'verified' },
  ];
  for (const [name, kernel] of /** @type {const} */ ([
    ['starter', 'pass'],
    ['local floor', 'pass'],
    ['changed floor', 'fail'],
  ])) {
    const result = results[name];
    assert.deepEqual(result.verdicts, verified(kernel), `${name}: the verdicts differ`);
    assert.equal(result.outcome, kernel === 'pass' ? 'pass' : 'fail', `${name}: the report outcome differs`);
    assert.equal(result.conformance?.profile, 'package-v1', `${name}: the profile differs`);
    assert.deepEqual(result.conformance?.outOfProfile, OUT_OF_PROFILE, `${name}: the out-of-profile suites differ`);
    assert.match(result.conformance?.floorDigest ?? '', /^[0-9a-f]{64}$/, `${name}: no floor digest`);
  }
  // The local floor is the embedded floor's bytes, so it verifies to the same digest; one byte gives another.
  assert.equal(results['local floor'].conformance.floorDigest, results['starter'].conformance.floorDigest);
  assert.notEqual(results['changed floor'].conformance.floorDigest, results['starter'].conformance.floorDigest);

  const megabytes = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  console.log(
    JSON.stringify({
      format: 'ia.conformance-sandbox.v1',
      source: registry === undefined ? 'packed' : REGISTRY,
      packages: Object.fromEntries([...expected].filter(([name]) => name !== CLI)),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sandbox: { allowFsRead: 'node_modules', write: false, maxOldSpaceMb: HEAP_MB },
      producers: {
        firstRunMs: Math.round(elapsed(first)),
        coldRunsMs: cold.map((run) => Math.round(elapsed(run))),
        kernelMs: Math.round(producers.kernelMs),
        fixturesMs: Math.round(producers.fixturesMs),
        budgetMs: PRODUCER_BUDGET_MS,
        heapUsedMb: megabytes(producers.heap.used),
        heapCommittedMb: megabytes(producers.heap.total),
        heapLimitMb: megabytes(producers.heap.limit),
        maxRssMb: megabytes(producers.heap.maxRss),
      },
      corpora: Object.fromEntries(
        Object.entries(results).map(([name, result]) => [
          name,
          {
            outcome: result.outcome,
            kernel: result.verdicts.find((verdict) => verdict.check === 'COMP-KERNEL').outcome,
            fixtures: result.verdicts.find((verdict) => verdict.check === 'COMP-FIXTURES').outcome,
            snapshotMs: Math.round(result.ms),
            heapCommittedMb: megabytes(result.heap.total),
            maxRssMb: megabytes(result.heap.maxRss),
          },
        ]),
      ),
    }),
  );
} finally {
  // Remove only the directory this run created, and only while it is still that directory.
  assert.equal(dirname(temporary), temporaryRoot, 'Refusing cleanup outside the temporary root');
  assert(basename(temporary).startsWith('ia-conformance-sandbox-'));
  containedFile(temporary, 'cleanup-probe', { allowMissing: true });
  const current = lstatSync(temporary);
  assert(current.ino === identity.ino && current.dev === identity.dev, 'Qualification output changed before cleanup');
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
