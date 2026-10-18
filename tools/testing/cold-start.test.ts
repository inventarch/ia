import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { runBounded } from './subprocess.js';

const source = resolve(import.meta.dirname, '../..');

it(
  'plans before build and produces every installed-view prerequisite in a source-only checkout',
  async () => {
    const parent = realpathSync(tmpdir()),
      root = mkdtempSync(resolve(parent, 'ia-tools-cold-'));
    const env: NodeJS.ProcessEnv = { ...process.env, NX_DAEMON: 'false' };
    for (const name of Object.keys(env)) if (name.startsWith('NX_') && name !== 'NX_DAEMON') delete env[name];
    let failed = false;
    const run = async (command: string, args: readonly string[], timeoutMs = 120_000) => {
      const result = await runBounded(command, args, { cwd: root, env, timeoutMs });
      expect(result.status, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.timedOut).toBe(false);
      return result.stdout;
    };
    try {
      execFileSync('git', ['clone', '--no-local', '--quiet', source, root], { timeout: 120_000, windowsHide: true });
      const changed = new Set(
        [
          ...execFileSync('git', ['diff', 'HEAD', '--no-renames', '--name-only', '-z'], {
            cwd: source,
            encoding: 'utf8',
            timeout: 30_000,
          }).split('\0'),
          ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
            cwd: source,
            encoding: 'utf8',
            timeout: 30_000,
          }).split('\0'),
        ].filter(Boolean),
      );
      for (const file of changed) {
        const target = resolve(root, file);
        if (existsSync(resolve(source, file))) {
          mkdirSync(dirname(target), { recursive: true });
          cpSync(resolve(source, file), target);
        } else rmSync(target, { force: true });
      }
      const launcher = process.env['npm_execpath'];
      if (!launcher) throw new Error('Run cold-start qualification through pinned pnpm');
      const install = packageManagerCommand(launcher, [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
      ]);
      await run(install.command, install.args);
      for (const path of [
        '.nx',
        'apps/cli/assets/host.json',
        'apps/cli/dist',
        'packages/runtime/dist',
        'packages/language/dist',
      ])
        expect(existsSync(resolve(root, path)), `Cold fixture unexpectedly has ${path}`).toBe(false);
      const node = ['--conditions=development', '--import', 'tsx'];
      const inventory = JSON.parse(await run(process.execPath, [...node, 'tools/testing/inventory.ts', '--json']));
      expect(inventory.findings).toEqual([]);
      for (const platform of ['windows', 'linux', 'macos'])
        await run(process.execPath, [...node, 'tools/testing/plan.ts', '--platform', platform, '--json']);
      expect(existsSync(resolve(root, 'apps/cli/dist'))).toBe(false);
      await run(
        process.execPath,
        [
          ...node,
          'tools/testing/orchestrate.ts',
          '--tasks',
          'tools:test-installed-views',
          '--evidence-out',
          'artifacts/tools-rewrite/cold-views',
          '--full',
          '--json',
        ],
        15 * 60_000,
      );
      expect(existsSync(resolve(root, 'apps/cli/assets/host.json'))).toBe(true);
      const evidence = JSON.parse(
        readFileSync(resolve(root, 'artifacts/tests/tools-test-installed-views/evidence.json'), 'utf8'),
      );
      expect(evidence.report.status).toBe('passed');
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (dirname(root) !== parent || !root.startsWith(resolve(parent, 'ia-tools-cold-')))
        throw new Error('Unsafe cold fixture cleanup');
      if (failed) console.error(`Retained cold-start failure fixture: ${root}`);
      else await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  20 * 60_000,
);
