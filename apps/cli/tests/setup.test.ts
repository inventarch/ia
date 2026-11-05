import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { packDistribution } from '@inventarch/distribution/pack';
import { HOST_TREE_LIMITS, packTree } from '@inventarch/distribution/ustar';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import { readWorkspaceLock } from '@inventarch/distribution/services';
import { readBindings, resolveMethod, selectBinding } from '@inventarch/runtime/method';
import { readBase } from '../src/bundled-base.js';
import { put, read } from './host-fixture.js';
import { cleanup, cli, repository, run, scratch } from './workspace-fixture.js';

afterAll(cleanup, 120_000);
let packageBytes: Buffer;
let packageManifest: object;
const base = readBase(cli);

/** Three small real IA releases exercise installation and resolution without a registry or a plugin. */
beforeAll(async () => {
  const files = new Map<string, Buffer>();
  const kits = [];
  for (const [name, lane] of [
    ['method', 'work'],
    ['kb', 'knowledge'],
    ['authoring', 'delivery'],
  ]) {
    const source = join(scratch('setup-kit'), `ia-${name}-kit`);
    const result = await run([
      'init',
      source,
      '--system',
      '--id',
      `inventarch/ia-${name}-kit`,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const system = `ia-${name}-kit`;
    const systemPath = `.ia/src/systems/${system}/system.ia`;
    put(
      source,
      systemPath,
      read(source, systemPath).replace(
        '  requires\n',
        '  requires\n    - agent-composition-system\n    - governance-system\n',
      ),
    );
    put(
      source,
      `.ia/src/systems/${system}/records/method.ia`,
      `#! ia 1.0

@capability ${name}-procedure
  meaning
    says "Exercise ${lane} setup."
    answers "Which procedure is available?"
  composition
    playbooks [@playbook ${name}-steps]
  execution
    effects [read]

@playbook ${name}-steps
  meaning
    says "Read the ${lane} request."
    answers "How does this fixture proceed?"
  cognition
    orient
      primary Attention
      Attention means "Read the ${lane} request."
    plan
      primary Inference
      Inference means "Plan the ${lane} response."
    act
      primary Decision
      Decision means "Produce the ${lane} response."
`,
    );
    put(
      source,
      'bindings.json',
      JSON.stringify({ format: 1, recommend: { [`${lane}.*`]: { capability: `${name}-procedure` } } }),
    );
    const descriptor = JSON.parse(read(source, '.ia/release.json'));
    descriptor.assets = [{ path: 'bindings.json', role: 'asset' }];
    put(source, '.ia/release.json', JSON.stringify(descriptor));
    const packed = packDistribution(source, JSON.stringify(descriptor));
    kits.push({
      id: descriptor.id,
      version: descriptor.version,
      archive: packed.archiveDigest,
      manifest: packed.manifestDigest,
    });
    files.set(`package/archives/${packed.archiveDigest}.ia.tgz`, packed.bytes);
  }
  packageManifest = { name: '@inventarch/public-kits', version: '1.0.2', ia: { format: 1, kits } };
  files.set('package/package.json', Buffer.from(JSON.stringify(packageManifest)));
  packageBytes = packTree(files, HOST_TREE_LIMITS);
}, 120_000);

function target() {
  const parent = scratch('setup'),
    root = join(parent, 'consumer'),
    cache = join(parent, 'npm-cache');
  mkdirSync(root);
  writeFileSync(join(parent, 'package.tgz'), packageBytes);
  const env = {
    IA_HOME: join(parent, 'home'),
    IA_NPM: join(repository, 'apps/cli/tests/fake-npm.mjs'),
    IA_NPM_LOG: join(parent, 'npm-calls.jsonl'),
    FAKE_NPM_VIEW: JSON.stringify({
      ...packageManifest,
      dist: { integrity: `sha512-${createHash('sha512').update(packageBytes).digest('base64')}` },
    }),
    FAKE_NPM_TARBALL: join(parent, 'package.tgz'),
    FAKE_NPM_CACHE: cache,
    npm_config_cache: cache,
  };
  return { root, env };
}

it('plain interactive init asks for the agent and cancels without workspace, network or home writes', async () => {
  for (const answers of [[], ['garbage', ''], ['codex', 'n']]) {
    const { root, env } = target(),
      prompts: string[] = [];
    const result = await run(['init', root], { env, interactive: true, answers, prompts });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompts.join('')).toContain('Which agent');
    expect(result.stdout).toContain('cancelled');
    expect(existsSync(join(root, '.ia'))).toBe(false);
    expect(existsSync(env.IA_NPM_LOG)).toBe(false);
    expect(existsSync(env.IA_HOME)).toBe(false);
  }
});

it('keeps noninteractive initialization and explicit host-none previews deterministic', async () => {
  const { root, env } = target(),
    prompts: string[] = [];
  const result = await run(['init', root, '--json'], { env });
  expect(JSON.parse(result.stdout).plan.host.selected).toBe('none');
  await run(['init', root, '--host', 'none'], { env, interactive: true, prompts });
  expect(prompts).toEqual([]);
  const setup = await run(['init', root, '--setup', '--host', 'codex', '--json'], { env });
  expect(JSON.parse(setup.stdout)).toMatchObject({ mode: 'setup', applied: false, plan: { host: 'codex' } });
  expect(existsSync(join(root, '.ia'))).toBe(false);
  expect(existsSync(env.IA_NPM_LOG)).toBe(false);
  expect((await run(['init', root, '--setup', '--json'], { env })).exitCode).toBe(2);
});

it.each(['codex', 'claude'])(
  'sets up %s with preserved instructions, installed defaults and resolvable methods',
  async (agent) => {
    const { root, env } = target(),
      prompts: string[] = [];
    const instructions = agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    put(root, instructions, '# Existing repository instructions\nKeep this text.\n');
    const result = await run(['init', root], { env, interactive: true, answers: [agent, 'yes'], prompts });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompts.filter((line) => line.endsWith('[y/N] '))).toEqual(['Set up this repository? [y/N] ']);
    expect(read(root, instructions)).toContain('# Existing repository instructions\nKeep this text.\n');
    expect(read(root, instructions)).toContain('ia_catalogue');
    expect(read(root, agent === 'codex' ? '.codex/config.toml' : '.mcp.json')).toContain('@inventarch/mcp-door@9.9.9');
    expect(readWorkspaceLock({ root }).entries?.[0]?.name).toBe('@inventarch/public-kits');
    for (const [entry, activity] of [
      ['work', 'task'],
      ['knowledge', 'explain'],
      ['delivery', 'change'],
    ]) {
      const packet = resolveMethod(
        { root, entry: entry!, activity: activity!, host: agent },
        {
          kits: { home: null },
          env,
          cwd: root,
          restore: (kitRoot) => {
            cacheArchive(kitRoot, base.bytes, base.pin.archive);
            applyInstallation(planInstallation(kitRoot, readWorkspaceLock({ root: kitRoot }), 'restore'));
          },
        },
      );
      expect(packet.instructions.length).toBeGreaterThan(0);
      expect(packet.binding).toMatchObject({ key: `${entry}.${activity}` });
    }
    expect(result.stdout).toContain('no separate plugin install');
  },
  120_000,
);

it('preserves existing method choices and can retry after npm fails', async () => {
  const { root, env } = target();
  const failed = await run(['init', root, '--setup', '--host', 'codex', '--apply', '--yes', '--json'], {
    env: { ...env, FAKE_NPM_VIEW: undefined },
  });
  expect(failed.exitCode).not.toBe(0);
  expect(JSON.parse(failed.stdout).message).toContain('Completed: workspace');
  expect(existsSync(join(root, '.ia/release.json'))).toBe(true);
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  const custom = {
    format: 1,
    bindings: { 'knowledge.explain': { kit: 'inventarch/ia-kb-kit', capability: 'kb-procedure' } },
    note: 'Keep me',
  };
  put(root, '.ia/bindings.json', JSON.stringify(custom));
  const retried = await run(['init', root, '--setup', '--host', 'codex', '--apply', '--yes', '--json'], { env });
  expect(retried.exitCode, retried.stdout).toBe(0);
  expect(JSON.parse(read(root, '.ia/bindings.json'))).toMatchObject(custom);
  expect(selectBinding(readBindings(root), 'knowledge', 'explain').via).toBe('exact');
  const lock = read(root, '.ia/distributions.lock.json'),
    bindings = read(root, '.ia/bindings.json');
  const again = await run(['init', root, '--setup', '--host', 'codex', '--apply', '--yes', '--json'], { env });
  expect(again.exitCode, again.stdout).toBe(0);
  expect(read(root, '.ia/distributions.lock.json')).toBe(lock);
  expect(read(root, '.ia/bindings.json')).toBe(bindings);
}, 120_000);

it('refuses conflicting MCP configuration before initializing or downloading', async () => {
  const { root, env } = target();
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { ia: { command: 'custom-server' } } }));
  const result = await run(['init', root, '--setup', '--host', 'claude', '--apply', '--yes', '--json'], { env });
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(join(root, '.ia'))).toBe(false);
  expect(existsSync(env.IA_NPM_LOG)).toBe(false);
});

it('adds agent setup to an admitted workspace that ships no package', async () => {
  const { root, env } = target();
  expect((await run(['init', root, '--host', 'none', '--apply', '--yes', '--json'], { env })).exitCode).toBe(0);
  unlinkSync(join(root, '.ia/release.json'));
  const sources = read(root, '.ia/src/workspace.ia');
  const preview = await run(['init', root, '--setup', '--host', 'codex', '--json'], { env });
  expect(preview.exitCode, preview.stdout).toBe(0);
  expect(existsSync(env.IA_NPM_LOG)).toBe(false);
  const setup = await run(['init', root, '--setup', '--host', 'codex', '--apply', '--yes', '--json'], { env });
  expect(setup.exitCode, setup.stdout).toBe(0);
  expect(existsSync(join(root, '.ia/release.json'))).toBe(false);
  expect(read(root, '.ia/src/workspace.ia')).toBe(sources);
  expect(read(root, 'AGENTS.md')).toContain('ia_catalogue');
}, 120_000);

it('offers CLI-only initialization without downloading methods or writing agent files', async () => {
  const { root, env } = target();
  const result = await run(['init', root], { env, interactive: true, answers: ['3', 'yes'] });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(existsSync(join(root, '.ia/src/workspace.ia'))).toBe(true);
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  expect(existsSync(env.IA_NPM_LOG)).toBe(false);
});
