import { expect, expectTypeOf, it } from 'vitest';
import {
  asWorkspaceHost,
  BOOTSTRAP_HOSTS,
  bootstrapRow,
  COPILOT_FOLDER,
  HOSTS,
  hostRow,
  invocation,
  WORKSPACE_HOSTS,
} from '../src/hosts.js';
import type { WorkspaceHost } from '../src/hosts.js';
import { HOST_CONFIG } from '../src/host.js';

it('declares Claude, Gemini CLI and Google Antigravity supported, Codex partial with hooks, Copilot partial and Cursor planned', () => {
  expect(HOSTS.map((row) => [row.id, row.status, row.user, row.workspace, row.hooks])).toEqual([
    ['claude', 'supported', 'plugin', true, true],
    ['codex', 'partial', 'none', true, true],
    ['gemini', 'supported', 'plugin', true, true],
    ['antigravity', 'supported', 'plugin', true, true],
    ['copilot', 'partial', 'none', false, false],
    ['cursor', 'planned', 'none', false, false],
  ]);
  expect(BOOTSTRAP_HOSTS).toEqual(['claude', 'codex', 'gemini', 'antigravity', 'copilot']);
  expect(bootstrapRow('gemini')?.bootstrap).toEqual({
    instructions: ['GEMINI.md'],
    mcp: [{ file: '.gemini/settings.json', format: 'mcp-json' }],
  });
  expect(bootstrapRow('antigravity')?.bootstrap).toEqual({
    instructions: ['AGENTS.md'],
    mcp: [{ file: '.agents/mcp_config.json', format: 'mcp-json' }],
  });
  expect(bootstrapRow('copilot')?.bootstrap).toEqual({
    instructions: [`${COPILOT_FOLDER}/copilot-instructions.md`, 'AGENTS.md'],
    mcp: [
      { file: '.vscode/mcp.json', format: 'vscode-json' },
      { file: `${COPILOT_FOLDER}/mcp.json`, format: 'copilot-json' },
    ],
  });
  expect(bootstrapRow('cursor')).toBeUndefined();
  expect(WORKSPACE_HOSTS).toEqual(['claude', 'codex', 'gemini', 'antigravity']);
  expect(hostRow('cursor')?.label).toBe('Cursor');
  expect(hostRow('vim')).toBeUndefined();
});
it('refuses a host without a workspace set with a typed error', () => {
  expect(asWorkspaceHost('claude')).toBe('claude');
  expect(asWorkspaceHost('codex')).toBe('codex');
  expect(asWorkspaceHost('gemini')).toBe('gemini');
  expect(asWorkspaceHost('antigravity')).toBe('antigravity');
  expect(() => asWorkspaceHost('cursor')).toThrow(/Expected Claude, Codex, Gemini CLI or Google Antigravity/);
  expect(() => asWorkspaceHost('copilot')).toThrow(/Expected Claude, Codex, Gemini CLI or Google Antigravity/);
  expect(() => asWorkspaceHost(7)).toThrow(expect.objectContaining({ code: 'IA-DIST-HOST-UNSUPPORTED' }));
  expect(() => asWorkspaceHost('')).toThrow(/Expected Claude, Codex, Gemini CLI or Google Antigravity/);
  expect(() => asWorkspaceHost(undefined)).toThrow(/Expected Claude, Codex, Gemini CLI or Google Antigravity/);
  expectTypeOf<WorkspaceHost>().toEqualTypeOf<'claude' | 'codex' | 'gemini' | 'antigravity'>();
});
it('renders a host-native invocation only where the row declares one', () => {
  expect(invocation('claude', 'init', ['ia', 'init', '.'])).toBe('/ia:init');
  expect(invocation('claude', 'host', ['ia', 'host', 'claude'])).toBe('ia host claude');
  expect(invocation('codex', 'init', ['ia', 'init', '.'])).toBe('ia init .');
  expect(invocation('gemini', 'init', ['ia', 'init', '.'])).toBe('ia init .');
  expect(invocation('antigravity', 'init', ['ia', 'init', '.'])).toBe('ia init .');
  expect(invocation('cursor', 'doctor', ['ia', 'doctor'])).toBe('ia doctor');
  expect(invocation('vim', 'init', ['ia', 'init', '.'])).toBe('ia init .');
});
it('gives every workspace host exactly one MCP configuration file and format', () => {
  // Architecture review of crowncodes/ia#317: host behaviour derives from the table, so a new workspace row needs a HOST_CONFIG entry
  // (a type error without one) rather than inheriting Claude's JSON or Codex's TOML by a two-way ternary.
  expect(Object.keys(HOST_CONFIG).sort()).toEqual([...WORKSPACE_HOSTS].sort());
  expect(HOST_CONFIG).toEqual({
    claude: { file: '.mcp.json', format: 'json' },
    codex: { file: '.codex/config.toml', format: 'toml' },
    gemini: { file: '.gemini/settings.json', format: 'json' },
    antigravity: { file: '.agents/mcp_config.json', format: 'json' },
  });
});
