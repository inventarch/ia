import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { COPILOT_FOLDER } from '@inventarch/distribution/hosts';
import { host, initialized, put } from './host-fixture.js';
import { quoteCommandRoot as quote, run, scratch } from './workspace-fixture.js';

it('plans, writes and removes the committed bootstrap for Copilot, with no machine-local path', async () => {
  const { root, env } = await initialized();
  const planned = await run(['host', 'copilot', '--commit', '--root', root, '--json'], { env });
  expect(planned.exitCode, planned.stdout).toBe(0);
  const plan = JSON.parse(planned.stdout) as { door: string };
  const version = plan.door.slice('@inventarch/mcp-door@'.length);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(plan).toEqual({
    version: 1,
    command: 'host',
    host: 'copilot',
    mode: 'commit',
    remove: false,
    door: `@inventarch/mcp-door@${version}`,
    files: [
      { path: `${COPILOT_FOLDER}/copilot-instructions.md`, kind: 'instructions', action: 'create' },
      { path: 'AGENTS.md', kind: 'instructions', action: 'create' },
      { path: '.vscode/mcp.json', kind: 'mcp', action: 'create' },
      { path: `${COPILOT_FOLDER}/mcp.json`, kind: 'mcp', action: 'create' },
    ],
    applied: false,
  });
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  const applied = await run(['host', 'copilot', '--commit', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  for (const path of [
    `${COPILOT_FOLDER}/copilot-instructions.md`,
    'AGENTS.md',
    '.vscode/mcp.json',
    `${COPILOT_FOLDER}/mcp.json`,
  ]) {
    const text = readFileSync(resolve(root, path), 'utf8');
    expect(text).not.toContain(root);
    expect(text).not.toContain(env.IA_HOST_HOME);
  }
  expect(JSON.parse(readFileSync(resolve(root, '.vscode/mcp.json'), 'utf8')).servers.ia.args).toEqual([
    '-y',
    `@inventarch/mcp-door@${version}`,
  ]);
  expect(readFileSync(resolve(root, 'AGENTS.md'), 'utf8')).toContain('`ia_session`');
  const removed = await run(['host', 'copilot', '--commit', '--remove', '--apply', '--yes', '--root', root, '--json'], {
    env,
  });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  expect(existsSync(resolve(root, `${COPILOT_FOLDER}/mcp.json`))).toBe(false);
});

it('sends Copilot without --commit to the committed bootstrap, and refuses --commit for Cursor', async () => {
  const { root, env } = await initialized();
  const plain = await run(['host', 'copilot', '--root', root, '--json'], { env });
  expect(plain.exitCode).toBe(3);
  expect(JSON.parse(plain.stdout)).toMatchObject({
    code: 'IA-DIST-HOST-UNSUPPORTED',
    message: 'GitHub Copilot takes only the committed bootstrap; nothing was written',
  });
  expect((await run(['host', 'cursor', '--commit', '--root', root, '--json'], { env })).exitCode).toBe(2);
  expect((await run(['host', 'claude', '--commit', '--user', '--json'], { env })).exitCode).toBe(2);
});

/** A workspace that admits and ships no package: the starter, with its release descriptor removed. */
async function withoutDescriptor() {
  const made = await initialized();
  rmSync(resolve(made.root, '.ia/release.json'));
  return made;
}

it('ia host claude --commit previews on a workspace with no descriptor', async () => {
  const { root, env } = await withoutDescriptor();
  const planned = await run(['host', 'claude', '--commit', '--root', root, '--json'], { env });
  expect(planned.exitCode, planned.stdout).toBe(0);
  const files = (JSON.parse(planned.stdout) as { files: { path: string }[] }).files.map((file) => file.path);
  expect(files).toContain('CLAUDE.md');
  expect(files).toContain('.mcp.json');
  expect(existsSync(resolve(root, 'CLAUDE.md'))).toBe(false);
});

it('ia host claude on a workspace with no descriptor plans the registration', async () => {
  const { root, env } = await withoutDescriptor();
  const planned = await host(root, env, 'claude');
  expect(planned.exitCode, planned.stdout).toBe(0);
  expect(JSON.parse(planned.stdout)).toMatchObject({ command: 'host', host: 'claude', apply: false });
});

it('refuses a directory with no .ia/src, naming ia init, through the committed and the registration paths', async () => {
  const { env } = await initialized();
  const bare = scratch('host-no-source');
  for (const argv of [
    ['host', 'claude', '--commit', '--root', bare, '--json'],
    ['host', 'claude', '--root', bare, '--json'],
  ]) {
    const refused = await run(argv, { env });
    expect(refused.exitCode, argv.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      code: 'IA-CLI-CONFLICT',
      message: expect.stringContaining('.ia/src is absent'),
      next: `Run "ia init ${quote(realpathSync(bare))}" first.`,
    });
  }
});

it('a workspace that does not admit names ia validate, through the committed and the registration paths', async () => {
  const { root, env } = await withoutDescriptor();
  put(root, '.ia/src/broken.ia', '@@@ this is not a record\n');
  for (const argv of [
    ['host', 'claude', '--commit', '--root', root, '--json'],
    ['host', 'claude', '--root', root, '--json'],
  ]) {
    const refused = await run(argv, { env });
    expect(refused.exitCode, argv.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      code: 'IA-CLI-CONFLICT',
      next: expect.stringContaining('ia validate'),
    });
    expect(JSON.parse(refused.stdout).message).not.toContain('initialized');
  }
  expect(existsSync(resolve(root, 'CLAUDE.md'))).toBe(false);
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
});

it('ia host claude --commit still refuses a generated CLAUDE.md', async () => {
  const { root, env } = await withoutDescriptor();
  const packet = `# packet\n\nia-generated ${'a'.repeat(64)} ${'b'.repeat(64)} ia-claude\n`;
  put(root, 'CLAUDE.md', packet);
  const refused = await run(['host', 'claude', '--commit', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: expect.stringContaining('LOCAL-MODIFICATION'),
    message: expect.stringContaining('generated position packet'),
  });
  expect(readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')).toBe(packet);
  expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
});
