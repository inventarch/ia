import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { BLOCK_BEGIN, BLOCK_END, applyBootstrap, isDoorLaunch, planBootstrap } from '../src/bootstrap.js';
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

const KITS = { name: '@inventarch/public-kits', version: '1.2.0' };
const KITS_LAUNCH = {
  command: 'npx',
  args: [
    '-y',
    '-p',
    '@inventarch/mcp-door@3.5.0',
    '-p',
    '@inventarch/public-kits@1.2.0',
    'ia-mcp-door',
    '--kits-package',
    '@inventarch/public-kits',
  ],
};
it('starts the kits package beside the door in every host format, and moves between the two launches', () => {
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', false, KITS));
  expect(JSON.parse(read('.mcp.json')).mcpServers.ia).toEqual(KITS_LAUNCH);
  expect(read('.mcp.json')).not.toContain(root);
  expect(planBootstrap(root, 'claude', '3.5.0', false, KITS).files.every((file) => file.action === 'unchanged')).toBe(
    true,
  );
  // A door-only plan replaces the kits launch, which is still the IA door; removal takes either.
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  expect(JSON.parse(read('.mcp.json')).mcpServers.ia).toEqual(LAUNCH);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', false, KITS));
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  applyBootstrap(planBootstrap(root, 'codex', '3.5.0', false, KITS));
  expect((parse(read('.codex/config.toml')) as { mcp_servers: Record<string, unknown> }).mcp_servers['ia']).toEqual(
    KITS_LAUNCH,
  );
  applyBootstrap(planBootstrap(root, 'copilot', '3.5.0', false, KITS));
  expect(JSON.parse(read('.vscode/mcp.json'))).toEqual({ servers: { ia: { type: 'stdio', ...KITS_LAUNCH } } });
  expect(() => planBootstrap(root, 'claude', '3.5.0', false, { ...KITS, version: 'latest' })).toThrow(/exact version/);
});
it('recognises only the two door launches it writes', () => {
  expect(isDoorLaunch(LAUNCH)).toBe(true);
  expect(isDoorLaunch(KITS_LAUNCH)).toBe(true);
  const swapped = (at: number, value: string) => KITS_LAUNCH.args.map((arg, index) => (index === at ? value : arg));
  expect(isDoorLaunch({ ...KITS_LAUNCH, args: swapped(4, '@other/kits@1.0.0') })).toBe(false);
  expect(isDoorLaunch({ ...KITS_LAUNCH, args: swapped(5, 'node') })).toBe(false);
  expect(isDoorLaunch({ command: 'npx', args: ['-y', 'other@1.0.0'] })).toBe(false);
});
