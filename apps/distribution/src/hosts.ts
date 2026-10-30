import { fail } from './files.js';

/**
 * Host plugin distribution spec §4: one row per agent host. Adding a workspace host also needs its `HOST_CONFIG`
 * (host.ts) and `PROJECTION_PATHS` (projection.ts) entries, which the type checker demands, and the CLI sites §4 lists.
 * A row's `bootstrap` names the committable files `ia host <host> --commit` writes (bootstrap.ts): the instruction files
 * that carry the IA block and the MCP configuration files that launch the published door, each in its host's format.
 */
export type HostStatus = 'supported' | 'partial' | 'planned';
export type Intent = 'init' | 'doctor' | 'host' | 'host-user';
export type BootstrapFormat = 'mcp-json' | 'vscode-json' | 'copilot-json' | 'toml';
export interface HostBootstrap {
  readonly instructions: readonly string[];
  readonly mcp: readonly { readonly file: string; readonly format: BootstrapFormat }[];
}
export interface HostRow {
  readonly id: string;
  readonly label: string;
  readonly status: HostStatus;
  readonly user: 'plugin' | 'none';
  readonly workspace: boolean;
  readonly hooks: boolean;
  readonly invocations: Readonly<Partial<Record<Intent, string>>>;
  readonly bootstrap?: HostBootstrap;
}
const ROWS = [
  {
    id: 'claude',
    label: 'Claude Code',
    status: 'supported',
    user: 'plugin',
    workspace: true,
    hooks: true,
    invocations: { init: '/ia:init', doctor: '/ia:doctor' },
    bootstrap: { instructions: ['CLAUDE.md'], mcp: [{ file: '.mcp.json', format: 'mcp-json' }] },
  },
  {
    id: 'codex',
    label: 'Codex',
    status: 'partial',
    user: 'none',
    workspace: true,
    hooks: true,
    invocations: {},
    bootstrap: { instructions: ['AGENTS.md'], mcp: [{ file: '.codex/config.toml', format: 'toml' }] },
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    status: 'partial',
    user: 'none',
    workspace: false,
    hooks: false,
    invocations: {},
    bootstrap: {
      instructions: ['.github/copilot-instructions.md', 'AGENTS.md'],
      mcp: [
        { file: '.vscode/mcp.json', format: 'vscode-json' },
        { file: '.github/mcp.json', format: 'copilot-json' },
      ],
    },
  },
  { id: 'cursor', label: 'Cursor', status: 'planned', user: 'none', workspace: false, hooks: false, invocations: {} },
] as const satisfies readonly HostRow[];
/** The widened view: callers indexing `invocations[intent]` while iterating get `HostRow`, not one row's own narrow literal type. */
export const HOSTS: readonly HostRow[] = ROWS;
export type HostId = (typeof ROWS)[number]['id'];
type WorkspaceRow = Extract<(typeof ROWS)[number], { readonly workspace: true }>;
export type WorkspaceHost = WorkspaceRow['id'];
type BootstrapRow = Extract<(typeof ROWS)[number], { readonly bootstrap: HostBootstrap }>;
export type BootstrapHost = BootstrapRow['id'];
/** The one place that knows a workspace row from a non-workspace row; lookups narrow through this instead of casting. */
export const isWorkspace = (row: (typeof ROWS)[number]): row is WorkspaceRow => row.workspace;
export const WORKSPACE_HOSTS: readonly WorkspaceHost[] = ROWS.filter(isWorkspace).map((row) => row.id);
const hasBootstrap = (row: (typeof ROWS)[number]): row is BootstrapRow => 'bootstrap' in row;
export const BOOTSTRAP_HOSTS: readonly BootstrapHost[] = ROWS.filter(hasBootstrap).map((row) => row.id);
export const hostRow = (id: string): HostRow | undefined => HOSTS.find((row) => row.id === id);
/** As `hostRow`, but the result is a workspace row or nothing: later CLI code that only ever wants a `WorkspaceHost` needs no cast. */
export const workspaceRow = (id: string): WorkspaceRow | undefined => {
  const row = ROWS.find((candidate) => candidate.id === id);
  return row && isWorkspace(row) ? row : undefined;
};
/** The row of a host whose committed bootstrap `ia host --commit` writes, or nothing. */
export const bootstrapRow = (id: string): BootstrapRow | undefined => {
  const row = ROWS.find((candidate) => candidate.id === id);
  return row && hasBootstrap(row) ? row : undefined;
};
/**
 * The original refusal, message unchanged: a host whose row has no workspace set is not a workspace host. The CLI
 * above already refuses a planned host first, with its own host-naming message (spec §4); this mechanism layer
 * keeps the historical "Expected Claude or Codex" text for whatever reaches it directly.
 */
export function asWorkspaceHost(value: unknown): WorkspaceHost {
  const row = typeof value === 'string' ? ROWS.find((candidate) => candidate.id === value) : undefined;
  if (!row || !isWorkspace(row)) fail('HOST-UNSUPPORTED', 'Expected Claude or Codex');
  return row.id;
}
/** §7.3 `nextActions`: the host's own invocation where the row declares one, otherwise the plain command. */
export const invocation = (id: string, intent: Intent, argv: readonly string[]): string =>
  hostRow(id)?.invocations[intent] ?? argv.join(' ');
