import { expect, expectTypeOf, it } from 'vitest';
import { asWorkspaceHost, HOSTS, hostRow, invocation, WORKSPACE_HOSTS } from '../src/hosts.js';
import type { WorkspaceHost } from '../src/hosts.js';
import { HOST_CONFIG } from '../src/host.js';

it('declares Claude supported, Codex partial and Cursor planned', () => {
  expect(HOSTS.map((row) => [row.id, row.status, row.user, row.workspace, row.hooks])).toEqual([
    ['claude', 'supported', 'plugin', true, true],
    ['codex', 'partial', 'none', true, false],
    ['cursor', 'planned', 'none', false, false],
  ]);
  expect(WORKSPACE_HOSTS).toEqual(['claude', 'codex']);
  expect(hostRow('cursor')?.label).toBe('Cursor');
  expect(hostRow('vim')).toBeUndefined();
});
it('refuses a host without a workspace set with the historical message', () => {
  expect(asWorkspaceHost('claude')).toBe('claude');
  expect(asWorkspaceHost('codex')).toBe('codex');
  expect(() => asWorkspaceHost('cursor')).toThrow(/Expected Claude or Codex/);
  expect(() => asWorkspaceHost(7)).toThrow(expect.objectContaining({ code: 'IA-DIST-HOST-UNSUPPORTED' }));
  expect(() => asWorkspaceHost('')).toThrow(/Expected Claude or Codex/);
  expect(() => asWorkspaceHost(undefined)).toThrow(/Expected Claude or Codex/);
  expectTypeOf<WorkspaceHost>().toEqualTypeOf<'claude' | 'codex'>();
});
it('renders a host-native invocation only where the row declares one', () => {
  expect(invocation('claude', 'init', ['ia', 'init', '.'])).toBe('/ia:init');
  expect(invocation('claude', 'host', ['ia', 'host', 'claude'])).toBe('ia host claude');
  expect(invocation('codex', 'init', ['ia', 'init', '.'])).toBe('ia init .');
  expect(invocation('cursor', 'doctor', ['ia', 'doctor'])).toBe('ia doctor');
  expect(invocation('vim', 'init', ['ia', 'init', '.'])).toBe('ia init .');
});
it('gives every workspace host exactly one MCP configuration file and format', () => {
  // Architecture review of #317: host behaviour derives from the table, so a new workspace row needs a HOST_CONFIG entry
  // (a type error without one) rather than inheriting Claude's JSON or Codex's TOML by a two-way ternary.
  expect(Object.keys(HOST_CONFIG).sort()).toEqual([...WORKSPACE_HOSTS].sort());
  expect(HOST_CONFIG).toEqual({
    claude: { file: '.mcp.json', format: 'json' },
    codex: { file: '.codex/config.toml', format: 'toml' },
  });
});
