import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { initialized } from './host-fixture.js';
import { run } from './workspace-fixture.js';

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
      { path: '.github/copilot-instructions.md', kind: 'instructions', action: 'create' },
      { path: 'AGENTS.md', kind: 'instructions', action: 'create' },
      { path: '.vscode/mcp.json', kind: 'mcp', action: 'create' },
      { path: '.github/mcp.json', kind: 'mcp', action: 'create' },
    ],
    applied: false,
  });
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  const applied = await run(['host', 'copilot', '--commit', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  for (const path of ['.github/copilot-instructions.md', 'AGENTS.md', '.vscode/mcp.json', '.github/mcp.json']) {
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
  expect(existsSync(resolve(root, '.github/mcp.json'))).toBe(false);
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
