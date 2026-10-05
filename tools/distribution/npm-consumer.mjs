import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { executableExports, systemVerificationProgram } from './installed-consumer.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease, REGISTRY } from './npm-release.mjs';

const { values } = parseArgs({
  options: { directory: { type: 'string', default: 'artifacts/npm' }, 'npm-cli': { type: 'string' } },
});
const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, values.directory);
const version = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')).version;
const release = verifyRelease(root, directory, version);
const temporaryRoot = realpathSync(tmpdir());
const temporary = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-npm12-consumer-')));
const consumer = resolve(temporary, 'consumer with spaces');
const home = resolve(temporary, 'home');
const workspace = resolve(temporary, 'demo');
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
  NPM_CONFIG_USERCONFIG: resolve(home, '.npmrc'),
  NODE_AUTH_TOKEN: '',
  NPM_TOKEN: '',
  NODE_OPTIONS: '',
};
const run = (executable, args) =>
  execFileSync(executable, args, {
    cwd: consumer,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
const npm = (args) =>
  values['npm-cli'] ? run(process.execPath, [resolve(root, values['npm-cli']), ...args]) : run('npm', args);
try {
  mkdirSync(consumer);
  mkdirSync(home);
  writeFileSync(resolve(home, '.npmrc'), `registry=${REGISTRY}\n`);
  assert.match(npm(['--version']).trim(), /^12\./, 'Consumer qualification requires npm 12');
  const dependencies = Object.fromEntries(
    release.packages.map((entry) => [entry.name, 'file:' + resolve(directory, entry.filename).replaceAll('\\', '/')]),
  );
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify({ name: 'ia-npm12-consumer', private: true, type: 'module', dependencies }),
  );
  // npm 12's install defaults remain in place: no script approvals, Git sources or remote tarball opt-ins.
  npm(['install', '--no-audit', '--no-fund', '--package-lock=false']);
  const imports = [];
  for (const entry of release.packages) {
    const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules', entry.name, 'package.json'), 'utf8'));
    assert.equal(installed.name, entry.name);
    assert.equal(installed.version, entry.version);
    imports.push(...executableExports(installed));
  }
  writeFileSync(
    resolve(consumer, 'imports.mjs'),
    `for (const name of ${JSON.stringify(imports)}) await import(name);\n`,
  );
  run(process.execPath, ['--conditions=development', 'imports.mjs']);
  writeFileSync(resolve(consumer, 'verify-systems.mjs'), systemVerificationProgram);
  const native = JSON.parse(
    run(process.execPath, ['verify-systems.mjs', resolve(directory, 'system-compatibility.json'), consumer]),
  );
  writeFileSync(
    resolve(consumer, 'offline.mjs'),
    "globalThis.fetch = () => { throw new Error('CLI smoke must not use the network'); };\n",
  );
  const invoke = (args) =>
    run(process.execPath, [
      '--import',
      './offline.mjs',
      resolve(consumer, 'node_modules/@inventarch/cli/dist/main.js'),
      ...args,
    ]);
  assert.equal(invoke(['--version']).trim(), version);
  invoke(['init', workspace, '--host', 'none', '--apply', '--yes', '--json']);
  invoke(['validate', '--root', workspace, '--json']);
  console.log(
    JSON.stringify({
      npm: npm(['--version']).trim(),
      node: process.version,
      packages: release.packages.length,
      imports: imports.length,
      native,
      installedCli: ['init', 'validate'],
      installSecurityOptIns: [],
    }),
  );
} finally {
  assert.equal(dirname(temporary), temporaryRoot, 'Refusing cleanup outside the temporary root');
  assert.ok(temporary.startsWith(resolve(temporaryRoot, 'ia-npm12-consumer-')));
  rmSync(temporary, { recursive: true, force: true });
}
