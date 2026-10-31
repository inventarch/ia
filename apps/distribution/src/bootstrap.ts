import { parse } from 'smol-toml';
import { reconcileConfig } from './config.js';
import { bytes, fail, json, replace, utf8, workspace } from './files.js';
import { bootstrapRow } from './hosts.js';
import type { BootstrapFormat, BootstrapHost } from './hosts.js';
import { editJson } from './json-edit.js';

/**
 * The committed IA bootstrap (kit discovery decision `kit-discovery-committed-bootstrap`): what a fresh clone, a new
 * worktree or a cloud agent needs to reach IA, with no machine-local path in it. Per host row (hosts.ts `bootstrap`):
 * - each instruction file gains one marked block naming `ia_session` and the three lanes;
 * - each MCP configuration file gains one server, `ia`, that launches the published door with
 *   `npx -y @inventarch/mcp-door@<exact version>` from the project folder the host starts it in.
 * Every other byte of each file is kept. A server named `ia` that is not such a launch, a second block, or an
 * instruction file that is a generated position packet refuses with LOCAL-MODIFICATION.
 */
export const BOOTSTRAP_SERVER = 'ia';
export const DOOR_PACKAGE = '@inventarch/mcp-door';
export const BLOCK_BEGIN = '<!-- BEGIN IA BOOTSTRAP: written by ia host --commit; commit it, rerun to update -->';
export const BLOCK_END = '<!-- END IA BOOTSTRAP -->';
const TOML_ID = 'bootstrap';
const GENERATED = /^ia-generated [0-9a-f]{64} [0-9a-f]{64} ia-[a-z]+$/m;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export interface BootstrapFile {
  readonly path: string;
  readonly kind: 'instructions' | 'mcp';
  readonly action: 'create' | 'update' | 'remove' | 'unchanged';
  readonly after: string | null;
}
export interface BootstrapPlan {
  readonly root: string;
  readonly host: BootstrapHost;
  readonly version: string;
  readonly remove: boolean;
  readonly files: readonly BootstrapFile[];
}

/** The door launch every committed MCP entry carries: no path, the exact door version. */
export const doorLaunch = (version: string): { readonly command: 'npx'; readonly args: readonly string[] } => ({
  command: 'npx',
  args: ['-y', `${DOOR_PACKAGE}@${version}`],
});

/** The instruction block, the same text for every host. */
export function instructionBlock(): string {
  return [
    BLOCK_BEGIN,
    '## IA',
    '',
    `This repository is an IA workspace. Start each session by calling \`ia_session\` on the \`${BOOTSTRAP_SERVER}\` MCP server. For any task, use one lane: \`ia:work\`, \`ia:knowledge\` or \`ia:delivery\`. Call \`ia_catalogue {lane}\`, map the request to one item's \`key\`, then call \`ia_method {key}\` and follow the packet it returns. If context was lost, call \`ia_method\` again with the key and task the session briefing names.`,
    BLOCK_END,
    '',
  ].join('\n');
}

const entryOf = (format: BootstrapFormat, version: string): Record<string, unknown> => {
  const launch = doorLaunch(version);
  if (format === 'vscode-json') return { type: 'stdio', command: launch.command, args: launch.args };
  if (format === 'copilot-json') return { type: 'local', command: launch.command, args: launch.args, tools: ['*'] };
  return { command: launch.command, args: launch.args };
};
const containerOf = (format: BootstrapFormat): string => (format === 'vscode-json' ? 'servers' : 'mcpServers');
/** An `ia` server that launches some version of the published door: one this bootstrap wrote, at any version. */
function isDoorLaunch(value: unknown): boolean {
  const row = value as { command?: unknown; args?: unknown } | null;
  return (
    row !== null &&
    typeof row === 'object' &&
    row.command === 'npx' &&
    Array.isArray(row.args) &&
    row.args.length === 2 &&
    row.args[0] === '-y' &&
    typeof row.args[1] === 'string' &&
    row.args[1].startsWith(`${DOOR_PACKAGE}@`)
  );
}

function markdown(path: string, current: string | null, remove: boolean): string | null {
  const text = current ?? '';
  if (GENERATED.test(text))
    fail(
      'LOCAL-MODIFICATION',
      `${path} is a generated position packet; keep it machine-local, or remove that registration before committing a bootstrap here`,
    );
  const start = text.indexOf(BLOCK_BEGIN),
    endAt = text.indexOf(BLOCK_END);
  const block = instructionBlock();
  if (start < 0 && endAt < 0) {
    if (remove) return current;
    if (text === '') return block;
    return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}`;
  }
  if (start < 0 || endAt < start || text.indexOf(BLOCK_BEGIN, start + 1) >= 0)
    fail('LOCAL-MODIFICATION', `${path} holds an incomplete or repeated IA bootstrap block`);
  let after = text.slice(endAt + BLOCK_END.length);
  if (after.startsWith('\n')) after = after.slice(1);
  const before = text.slice(0, start);
  if (!remove) return before + block + after;
  const kept = (before.replace(/\n+$/, '\n') + after).replace(/^\n+/, '');
  return kept.trim() === '' ? null : kept;
}

function jsonFile(path: string, format: BootstrapFormat, current: string | null, version: string, remove: boolean) {
  const container = containerOf(format);
  let parsed: Record<string, unknown> = {};
  if (current !== null)
    try {
      parsed = JSON.parse(current) as Record<string, unknown>;
    } catch {
      fail('INPUT-INVALID', `${path} is not JSON`);
    }
  const servers = parsed[container];
  const existing =
    servers !== null && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)[BOOTSTRAP_SERVER]
      : undefined;
  if (existing !== undefined && !isDoorLaunch(existing))
    fail('LOCAL-MODIFICATION', `${path} already names an MCP server ${BOOTSTRAP_SERVER} that is not the IA door`);
  if (remove) {
    if (existing === undefined) return current;
    const next = editJson(current, [container, BOOTSTRAP_SERVER], undefined);
    return JSON.stringify(JSON.parse(next)) === '{}' ? null : next;
  }
  const entry = entryOf(format, version);
  if (existing !== undefined && json(existing) === json(entry)) return current;
  return editJson(current, [container, BOOTSTRAP_SERVER], entry);
}

function tomlFile(path: string, current: string | null, version: string, remove: boolean): string | null {
  const text = current ?? '';
  const begin = `\n# BEGIN IA PROJECTION ${TOML_ID}\n`,
    end = `# END IA PROJECTION ${TOML_ID}\n`;
  const start = text.indexOf(begin);
  const previous = start < 0 ? null : text.slice(start + begin.length, text.indexOf(end, start));
  if (start < 0) {
    let table: unknown;
    try {
      table = (parse(text)['mcp_servers'] as Record<string, unknown> | undefined)?.[BOOTSTRAP_SERVER];
    } catch {
      fail('INPUT-INVALID', `${path} is not TOML`);
    }
    if (table !== undefined)
      fail('LOCAL-MODIFICATION', `${path} already names an MCP server ${BOOTSTRAP_SERVER} outside the IA block`);
  }
  const launch = doorLaunch(version);
  const next = remove
    ? null
    : `[mcp_servers.${BOOTSTRAP_SERVER}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  if (remove && previous === null) return current;
  const combined = reconcileConfig(text, TOML_ID, previous, next, 'mcp_servers');
  return combined.trim() === '' ? null : combined;
}

/** The plan of the committed bootstrap for one host at root: each file's next text and what changes. */
export function planBootstrap(rootInput: string, host: BootstrapHost, version: string, remove = false): BootstrapPlan {
  const root = workspace(rootInput);
  if (!VERSION.test(version)) fail('INPUT-INVALID', `Expected an exact door version: ${version}`);
  const row = bootstrapRow(host) ?? fail('HOST-UNSUPPORTED', `${host} has no committed bootstrap`);
  const read = (path: string): string | null => {
    const content = bytes(root, path);
    return content === null ? null : utf8(content);
  };
  const action = (before: string | null, after: string | null): BootstrapFile['action'] =>
    before === after ? 'unchanged' : before === null ? 'create' : after === null ? 'remove' : 'update';
  const files: BootstrapFile[] = [];
  for (const path of row.bootstrap.instructions) {
    const before = read(path),
      after = markdown(path, before, remove);
    files.push({ path, kind: 'instructions', action: action(before, after), after });
  }
  for (const { file, format } of row.bootstrap.mcp) {
    const before = read(file);
    const after =
      format === 'toml' ? tomlFile(file, before, version, remove) : jsonFile(file, format, before, version, remove);
    files.push({ path: file, kind: 'mcp', action: action(before, after), after });
  }
  return { root, host, version, remove, files };
}

/** Writes a plan, refusing when any file changed since it was made. Committed files are written world-readable. */
export function applyBootstrap(plan: BootstrapPlan): readonly BootstrapFile[] {
  const fresh = planBootstrap(plan.root, plan.host, plan.version, plan.remove);
  if (json(fresh.files) !== json(plan.files)) fail('STALE-PLAN', 'Bootstrap files changed; create a fresh plan');
  for (const file of plan.files)
    if (file.action !== 'unchanged')
      replace(plan.root, file.path, file.after === null ? null : Buffer.from(file.after, 'utf8'), 0o644);
  return plan.files;
}
