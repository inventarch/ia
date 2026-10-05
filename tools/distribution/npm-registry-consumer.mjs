import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { verifyRelease } from './npm-release.mjs';
const root = resolve(import.meta.dirname, '../..'),
  version = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')).version;
const release = verifyRelease(root, resolve(root, 'artifacts/npm'), version);
const parent = realpathSync(tmpdir()),
  temporary = mkdtempSync(resolve(parent, 'ia-registry-consumer-'));
try {
  const home = resolve(temporary, 'home');
  mkdirSync(home);
  writeFileSync(
    resolve(temporary, 'package.json'),
    JSON.stringify({
      name: 'ia-registry-signature-check',
      private: true,
      dependencies: Object.fromEntries(release.packages.map((entry) => [entry.name, entry.version])),
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_USERCONFIG: resolve(home, '.npmrc'),
    NODE_AUTH_TOKEN: '',
    NPM_TOKEN: '',
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    NODE_OPTIONS: '',
  };
  writeFileSync(resolve(home, '.npmrc'), 'registry=https://registry.npmjs.org\n');
  const run = (args) =>
    execFileSync('npm', args, { cwd: temporary, env, stdio: 'inherit', windowsHide: true, timeout: 300000 });
  run(['install', '--ignore-scripts', '--no-fund', '--no-audit']);
  for (const entry of release.packages) {
    const manifest = JSON.parse(readFileSync(resolve(temporary, 'node_modules', entry.name, 'package.json'), 'utf8'));
    assert.equal(manifest.name, entry.name);
    assert.equal(manifest.version, entry.version);
  }
  run(['audit', 'signatures']);
  console.log(
    JSON.stringify({
      version,
      packages: release.packages.length,
      registryConsumer: 'installed',
      signatureAndProvenanceVerification: 'npm audit signatures passed',
    }),
  );
} finally {
  assert.equal(dirname(temporary), parent);
  assert.ok(temporary.startsWith(resolve(parent, 'ia-registry-consumer-')));
  rmSync(temporary, { recursive: true, force: true });
}
