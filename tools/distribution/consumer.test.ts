import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { checkout, inQualifiedCohort, archivesFixture, compatibilityFixture } from './release-fixtures.js';
import { publicPackages } from './npm-release.mjs';
import {
  qualificationManifest,
  readQualification,
  ensureQualification,
  consumerDependencies,
  installConsumer,
} from './consumer.mjs';

const childEnvironment = (launcher: string, temporary: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['npm_execpath', 'temp', 'tmp', 'tmpdir'].includes(key.toLowerCase()),
    ),
  ),
  npm_execpath: launcher,
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
});

it.each(['explicit', 'orchestration'])(
  'ordinary adapters consume one exact cohort via %s without packing',
  async (mode) => {
    const directory = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-adapter-cohort-test-'));
    const argv = process.argv;
    const archives = archivesFixture(directory);
    compatibilityFixture(directory);
    const manifest = resolve(directory, 'qualification.json');
    writeFileSync(manifest, JSON.stringify(qualificationManifest(checkout, directory, archives)));
    const selected = readQualification(checkout, manifest);
    const launcher = resolve(directory, 'list-only.cjs');
    writeFileSync(
      launcher,
      `if(process.argv[2]!=='list')throw Error('unexpected package-manager operation');console.log(${JSON.stringify(JSON.stringify(publicPackages(checkout).map((row) => ({ path: resolve(checkout, row.directory) }))))});\n`,
    );
    const forbiddenPack = vi.fn(() => {
      throw new Error('unexpected fresh pack');
    });
    const install = vi.fn((_directory: string, _packed: typeof selected.packed) => {
      throw new Error('observed adapter installation');
    });
    const select = vi.fn((root: string, _pnpm: string, requested?: string) => {
      expect(requested ?? process.env['IA_QUALIFICATION_MANIFEST']).toBe(manifest);
      return readQualification(root, requested ?? process.env['IA_QUALIFICATION_MANIFEST']!);
    });
    vi.stubEnv('npm_execpath', launcher);
    vi.stubEnv('IA_QUALIFICATION_MANIFEST', mode === 'orchestration' ? manifest : undefined);
    vi.doMock('./consumer.mjs', async (original) => ({
      ...(await original<typeof import('./consumer.mjs')>()),
      ensureQualification: select,
      installConsumer: install,
    }));
    vi.doMock('../release/public-pack.mjs', async (original) => ({
      ...(await original<typeof import('../release/public-pack.mjs')>()),
      packPublicPackages: forbiddenPack,
    }));
    // Payload scanning and DB reads have independent suites; this test stops at the real adapters' installation handoff.
    vi.doMock('../release/scan-packed.mjs', () => ({
      scanPackedPublicContent: (_root: string, packed: typeof selected.packed) => ({
        observations: packed.map(({ name, sha256 }) => ({ name, sha256 })),
      }),
    }));
    vi.doMock('../../packages/db/dist/index.js', () => ({
      readInputs: () => {
        throw new Error('unexpected post-install DB read');
      },
    }));
    const resourceNames = new Set(
      [
        'language',
        'graph',
        'compliance',
        'db',
        'runtime',
        'workspace-runtime',
        'session-system',
        'agent-system',
        'authoring-system',
        'template-system',
        'agent-composition-system',
      ].map((name) => '@inventarch/' + name),
    );
    try {
      for (const entry of [
        './qualify-packages.mjs',
        '../projections/qualify-resources.mjs',
        '../projections/qualify-projections.mjs',
      ]) {
        vi.resetModules();
        install.mockClear();
        select.mockClear();
        process.argv = [process.execPath, entry, ...(mode === 'explicit' ? ['--manifest', manifest] : [])];
        await expect(import(entry)).rejects.toThrow('observed adapter installation');
        expect(select).toHaveBeenCalledOnce();
        expect(install).toHaveBeenCalledOnce();
        const expected =
          entry === './qualify-packages.mjs'
            ? selected.packed
            : selected.packed.filter((row) => resourceNames.has(row.name));
        expect(install.mock.calls[0]![1]).toEqual(expected);
      }
      writeFileSync(selected.packed[0]!.filename, 'substituted before adapter entry');
      for (const entry of [
        './qualify-packages.mjs',
        '../projections/qualify-resources.mjs',
        '../projections/qualify-projections.mjs',
      ]) {
        vi.resetModules();
        install.mockClear();
        process.argv = [process.execPath, entry, ...(mode === 'explicit' ? ['--manifest', manifest] : [])];
        await expect(import(entry)).rejects.toThrow('Qualification archive digest changed');
        expect(install).not.toHaveBeenCalled();
      }
      expect(forbiddenPack).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
      for (const path of [
        './consumer.mjs',
        '../release/public-pack.mjs',
        '../release/scan-packed.mjs',
        '../../packages/db/dist/index.js',
      ])
        vi.doUnmock(path);
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120000,
);

it.each([
  { args: ['--artifacts', 'first', '--manifest', 'second'], exit: 2, diagnostic: 'Choose --artifacts or --manifest' },
  { args: ['--manifest', 'missing-qualification.json'], exit: 1, diagnostic: 'missing-qualification.json' },
])('KB qualification refuses $args without allocating a consumer', ({ args, exit, diagnostic }) => {
  const temporary = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-kb-refusal-test-'));
  try {
    const result = spawnSync(process.execPath, ['tools/distribution/qualify-kb.mjs', ...args], {
      cwd: checkout,
      env: childEnvironment(process.execPath, temporary),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.stderr).toContain(diagnostic);
    expect(readdirSync(temporary)).toEqual([]);
    expect(result.status).toBe(exit);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it('KB qualification removes its owned consumer after an installation failure', () => {
  inQualifiedCohort((directory, archives) => {
    const path = resolve(directory, 'qualification.json');
    writeFileSync(path, JSON.stringify(qualificationManifest(checkout, directory, archives)));
    const temporary = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-kb-failure-test-'));
    const launcher = resolve(temporary, 'failure.cjs');
    writeFileSync(launcher, "console.error('intentional-installation-failure');process.exit(17);\n");
    try {
      const result = spawnSync(process.execPath, ['tools/distribution/qualify-kb.mjs', '--manifest', path], {
        cwd: checkout,
        env: childEnvironment(launcher, temporary),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      });
      expect(result.stderr).toContain('intentional-installation-failure');
      expect(result.status).toBe(1);
      expect(readdirSync(temporary)).toEqual(['failure.cjs']);
      expect(readFileSync(path, 'utf8')).toContain('ia.package-qualification.v1');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

it('hands the same identified archives to multiple consumers without packing again', () => {
  inQualifiedCohort((directory, archives) => {
    const manifest = qualificationManifest(checkout, directory, archives);
    const path = resolve(directory, 'qualification.json');
    writeFileSync(path, JSON.stringify(manifest));
    const first = ensureQualification(checkout, 'not-a-launcher', path);
    const second = ensureQualification(checkout, 'not-a-launcher', path);
    expect(first.packed).toEqual(second.packed);
    expect(first.packed.map((row) => row.sha256)).toEqual(archives.map((row) => row.sha256));
    expect(consumerDependencies(first.packed, ['@inventarch/runtime'])['@inventarch/runtime']).toContain('file:');
    expect(() => consumerDependencies(first.packed, ['@inventarch/missing'])).toThrow('exactly one');
  });
});

it.each(['archive', 'mode', 'source', 'platform', 'identity', 'duplicate', 'path', 'compatibility'])(
  'refuses a substituted %s without repacking',
  (field) => {
    inQualifiedCohort((directory, archives) => {
      const manifest = qualificationManifest(checkout, directory, archives);
      if (field === 'archive') writeFileSync(resolve(directory, archives[0]!.filename), 'substituted');
      if (field === 'mode') Object.assign(manifest, { mode: 'release' });
      if (field === 'source') manifest.inputDigest = '0'.repeat(64);
      if (field === 'platform') manifest.platform = 'unsupported';
      if (field === 'identity') manifest.archives[0]!.name = '@inventarch/substituted';
      if (field === 'duplicate') manifest.archives.push(manifest.archives[0]!);
      if (field === 'path') manifest.archives[0]!.filename = '../escape.tgz';
      if (field === 'compatibility') manifest.compatibility.sha256 = '0'.repeat(64);
      const path = resolve(directory, 'qualification.json');
      writeFileSync(path, JSON.stringify(manifest));
      const before = readFileSync(path);
      expect(() => ensureQualification(checkout, 'not-a-launcher', path)).toThrow();
      expect(readFileSync(path)).toEqual(before);
    });
  },
);

it('does not accept a sealed release receipt as ordinary qualification', () => {
  inQualifiedCohort((directory) => {
    const path = resolve(directory, 'qualification.json');
    writeFileSync(path, JSON.stringify({ format: 'ia.npm-release.v1', mode: 'release' }));
    expect(() => readQualification(checkout, path)).toThrow(/qualification/i);
  });
});

it('refuses archives changed after receipt verification before creating installation files', () => {
  inQualifiedCohort((directory, archives) => {
    const path = resolve(directory, 'qualification.json');
    writeFileSync(path, JSON.stringify(qualificationManifest(checkout, directory, archives)));
    const selected = readQualification(checkout, path);
    writeFileSync(selected.packed[0]!.filename, 'substituted-after-verification');
    const destination = resolve(directory, 'never-created');
    expect(() => installConsumer(destination, selected.packed, process.execPath)).toThrow(
      'Consumer archive digest changed',
    );
    expect(readdirSync(directory)).not.toContain('never-created');
  });
});

it('hands verified consumer-owned snapshots to the installer when original paths change', () => {
  inQualifiedCohort((directory, archives) => {
    const path = resolve(directory, 'qualification.json');
    writeFileSync(path, JSON.stringify(qualificationManifest(checkout, directory, archives)));
    const selected = readQualification(checkout, path);
    const destination = resolve(directory, 'consumer with spaces');
    const launcher = resolve(directory, 'observe-install.cjs');
    writeFileSync(
      launcher,
      `const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
for(const path of ${JSON.stringify(selected.packed.map((row) => row.filename))})fs.writeFileSync(path,'replaced while installer runs');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const values=Object.entries(pkg.dependencies).map(([name,path])=>{const file=path.slice(5);assert(file.replaceAll('\\\\','/').startsWith(process.cwd().replaceAll('\\\\','/')+'/'));return [name,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]});
console.log(JSON.stringify(Object.fromEntries(values)));\n`,
    );
    const observed = JSON.parse(installConsumer(destination, selected.packed, launcher));
    expect(observed).toEqual(Object.fromEntries(selected.packed.map((row) => [row.name, row.sha256])));
  });
});
