/**
 * REQ-LCS-4: the launcher's public modes as data. Every description of how to invoke scripts/ia.mjs is rendered
 * from this list; tests/context-launcher.test.ts asserts the launcher accepts exactly these.
 */
export interface HostMode {
  readonly mode: string;
  readonly arguments: string;
  readonly meaning: string;
}
export const HOST_MODES: readonly HostMode[] = Object.freeze(
  [
    {
      mode: 'verify',
      arguments: '',
      meaning: 'Verify the whole cache against its pinned inventory and print its identity',
    },
    {
      mode: 'mcp',
      arguments: '--root <absolute workspace>',
      meaning: 'Serve the read-only workspace door over MCP stdio',
    },
    {
      mode: 'door',
      arguments: '<operation> --root <absolute workspace> [--params <JSON|->]',
      meaning: 'Run one read-only door operation and print its JSON response',
    },
    {
      mode: 'distribution',
      arguments: '<command> --root <absolute workspace> ...',
      meaning: 'Run the bundled ia-distribution mechanism CLI',
    },
    {
      mode: 'guard',
      arguments: '--root <absolute workspace> [--actors <absolute file>]',
      meaning: 'Evaluate one PreToolUse event on stdin against the steward guard',
    },
    { mode: 'claude-guard', arguments: '', meaning: 'The guard with the root taken from CLAUDE_PROJECT_DIR' },
    {
      mode: 'context',
      arguments: 'identity | --root <absolute workspace> --binding <absolute file> [--part <0-11>]',
      meaning: 'Lifecycle context hook; not the door operation of the same name',
    },
  ].map((row) => Object.freeze(row)),
);
/** How one mode is written in generated instructions; `<cache>` is literal because the path is per user. */
export const launcherInvocation = (row: HostMode): string =>
  `node <cache>/scripts/ia.mjs ${row.mode}${row.arguments ? ' ' + row.arguments : ''}`;
