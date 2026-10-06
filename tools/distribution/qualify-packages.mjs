import '../temp/physical-temp.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { packPublicPackages, COMPATIBILITY } from '../release/public-pack.mjs';
import { scanPackedPublicContent } from '../release/scan-packed.mjs';
import assert from 'node:assert/strict';
import { executableExports, systemVerificationProgram } from './installed-consumer.mjs';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
      installedCli: ['init', 'validate', 'host claude', 'host codex'],
      vsix: true,
    }),
  );
} finally {
  assert.equal(dirname(temporary), temporaryRoot, 'Refusing cleanup outside the temporary root');
  assert.ok(relative(temporaryRoot, temporary).startsWith('ia-release-packages-'));
  rmSync(temporary, { recursive: true, force: true });
}
