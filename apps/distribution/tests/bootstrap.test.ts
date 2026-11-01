import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { BLOCK_BEGIN, BLOCK_END, applyBootstrap, planBootstrap } from '../src/bootstrap.js';
import { COPILOT_FOLDER } from '../src/hosts.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-bootstrap-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const LAUNCH = { command: 'npx', args: ['-y', '@inventarch/mcp-door@3.5.0'] };

it('writes the Claude block and door entry beside what the files hold, and removes exactly them', () => {
  put('CLAUDE.md', '# Project\n\nOur notes.\n');
  put('.mcp.json', '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
  const plan = planBootstrap(root, 'claude', '3.5.0');
  expect(plan.files.map(({ path, action }) => [path, action])).toEqual([
    ['CLAUDE.md', 'update'],
    ['.mcp.json', 'update'],
  ]);
  applyBootstrap(plan);
  const claude = read('CLAUDE.md');
  expect(claude.startsWith('# Project\n\nOur notes.\n\n' + BLOCK_BEGIN)).toBe(true);
  expect(claude).toContain('`ia_session`');
  expect(claude).toContain('`ia:work`, `ia:knowledge` or `ia:delivery`');
  const mcp = JSON.parse(read('.mcp.json'));
  expect(mcp.mcpServers).toEqual({ other: { command: 'x' }, ia: LAUNCH });
  expect(read('.mcp.json')).not.toContain(root);
  expect(planBootstrap(root, 'claude', '3.5.0').files.every((file) => file.action === 'unchanged')).toBe(true);
  expect(JSON.parse(planBootstrap(root, 'claude', '3.6.0').files[1]!.after!).mcpServers.ia.args[1]).toBe(
    '@inventarch/mcp-door@3.6.0',
  );
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe('# Project\n\nOur notes.\n');
  expect(JSON.parse(read('.mcp.json')).mcpServers).toEqual({ other: { command: 'x' } });
});

it('writes the Codex block into AGENTS.md and a marked TOML server, and refuses a generated packet', () => {
  put('.codex/config.toml', 'model = "o3"\n');
  applyBootstrap(planBootstrap(root, 'codex', '3.5.0'));
  expect(read('AGENTS.md')).toBe(read('AGENTS.md').slice(read('AGENTS.md').indexOf(BLOCK_BEGIN)));
  const toml = parse(read('.codex/config.toml')) as { model: string; mcp_servers: Record<string, unknown> };
  expect(toml).toEqual({ model: 'o3', mcp_servers: { ia: LAUNCH } });
  applyBootstrap(planBootstrap(root, 'codex', '3.5.0', true));
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  expect(read('.codex/config.toml')).toBe('model = "o3"\n');
  put('AGENTS.md', `# IA position packet\n\nia-generated ${'a'.repeat(64)} ${'b'.repeat(64)} ia-codex\n`);
  expect(() => planBootstrap(root, 'codex', '3.5.0')).toThrow(/generated position packet/);
});

it('writes Copilot instructions, AGENTS.md, the VS Code server and the Copilot CLI server', () => {
  applyBootstrap(planBootstrap(root, 'copilot', '3.5.0'));
  expect(read(`${COPILOT_FOLDER}/copilot-instructions.md`)).toContain(BLOCK_END);
  expect(read('AGENTS.md')).toContain(BLOCK_BEGIN);
  expect(JSON.parse(read('.vscode/mcp.json'))).toEqual({ servers: { ia: { type: 'stdio', ...LAUNCH } } });
  expect(JSON.parse(read(`${COPILOT_FOLDER}/mcp.json`))).toEqual({
    mcpServers: { ia: { type: 'local', ...LAUNCH, tools: ['*'] } },
  });
});

it('refuses a foreign ia server, a repeated block and a version that is not exact', () => {
  put('.mcp.json', '{ "mcpServers": { "ia": { "command": "node", "args": ["x.js"] } } }');
  expect(() => planBootstrap(root, 'claude', '3.5.0')).toThrow(/not the IA door/);
  rmSync(join(root, '.mcp.json'));
  put('CLAUDE.md', `${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`);
  expect(() => planBootstrap(root, 'claude', '3.5.0')).toThrow(/repeated/);
  expect(() => planBootstrap(root, 'copilot', 'latest')).toThrow(/exact door version/);
});
