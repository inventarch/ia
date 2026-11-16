import type { ReadHandle } from '@inventarch/db';
import { isSelection, type Node } from '@inventarch/graph';
import { PHASES, type Cell, type CompiledValue } from '@inventarch/language';
import { emitFrontmatter, type FrontField } from '../host-plugin/frontmatter.js';
import { HostPluginError } from '../host-plugin/errors.js';
import { MANIFESTS, NAME } from '../host-plugin/inventory.js';
import { type PluginProduct, pluginManifest } from '../host-plugin/manifest.js';
import {
  antigravityProseCatalog,
  claudeProseCatalog,
  codexProseCatalog,
  geminiProseCatalog,
  PROSE_EFFECT_TOOLS,
} from '../projection-host.js';
import { capabilityClosure, fieldsOf, stated, textsAt, valuesAt } from './format.js';
import {
  HOOK_IDENTITY_LIMIT,
  HOOK_LIMIT,
  HOOK_SELECTION_LENGTH,
  HOOK_SELECTION_LIMIT,
  registrableHook,
  registrableSelection,
} from './hook.js';
import type { PluginAsset, PluginFile, PluginResource } from './plugin.js';

export type StandalonePluginHost = 'claude' | 'codex' | 'gemini' | 'antigravity';

export interface StandaloneBindingRow {
  readonly kit?: string | undefined;
  readonly capability: string;
  readonly profile?: string | undefined;
}

export interface StandalonePluginOptions {
  readonly host: StandalonePluginHost;
  readonly bindings?: Readonly<Record<string, StandaloneBindingRow | readonly StandaloneBindingRow[]>> | undefined;
  readonly precedence?: readonly string[] | undefined;
  readonly recommendedBindings?: Readonly<Record<string, StandaloneBindingRow>> | undefined;
  readonly fallbackName?: string | undefined;
  readonly fallbackVersion?: string | undefined;
  readonly fallbackDescription?: string | undefined;
  readonly fallbackAuthor?: string | undefined;
  readonly resources?: readonly PluginResource[] | undefined;
  readonly assets?: readonly PluginAsset[] | undefined;
}

interface StandaloneHookRule {
  readonly identity: string;
  readonly tools: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
}

interface RouterEntry {
  readonly activity: string;
  readonly capability: Node;
  readonly summary: string;
}

const PUBLIC_FLOOR_SYSTEMS = new Set([
  'agent-composition-system',
  'agent-system',
  'authoring-system',
  'compliance-system',
  'governance-system',
  'hook-authoring-system',
  'learning-system',
  'session-system',
  'template-system',
  'work-system',
  'workspace-system',
]);

const LANES = ['work', 'knowledge', 'delivery'] as const;
type Lane = (typeof LANES)[number];

const LANE_DESCRIPTIONS: Readonly<Record<Lane, string>> = {
  work: 'Work lane router for planning, milestones, tasks, decisions, and record governance workflows. Use when structuring, planning, or reviewing work and governance items.',
  knowledge:
    'Knowledge lane router for retrieving, explaining, placing, checking, and maintaining repository documentation and knowledge records. Use when answering questions or maintaining docs.',
  delivery:
    'Delivery lane router for designing, implementing, reviewing, and verifying engineering or architecture changes. Use when building, refactoring, diagnosing, or reviewing deliverables.',
};

const HOOK_TOOLS = new Map([
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['multiedit', 'MultiEdit'],
] as const);

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const utf8Bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
const plainField = (text: string): FrontField['value'] => ({ kind: 'string', text, style: 'plain' });

function cleanLine(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function shortSummary(text: string | undefined, max = 220): string {
  const flat = cleanLine(text);
  if (flat.length <= max) return flat;
  const sentence = flat.slice(0, max).match(/^.*?[.!?](?=\s|$)/)?.[0];
  return sentence && sentence.length >= 32 ? sentence : `${flat.slice(0, max - 3).trimEnd()}...`;
}

function toPortableSlug(raw: string | undefined, fallback = 'ia-plugin'): string {
  const cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return cleaned.length > 0 && NAME.test(cleaned) ? cleaned : fallback;
}

function toDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => (part === 'ia' || part === 'kb' ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ');
}

function isLanguageFloorNode(node: Node): boolean {
  if (node.band === 100) return false;
  const path = node.source.path.replaceAll('\\', '/');
  const systemMatch = /(?:^|\/)\.ia\/src\/systems\/([^/]+)\//.exec(path);
  if (systemMatch && PUBLIC_FLOOR_SYSTEMS.has(systemMatch[1]!)) return true;
  const releaseMatch = /(?:^|\/)\.ia\/src\/releases\/([^/]+)\.ia$/.exec(path);
  if (releaseMatch) {
    const stem = releaseMatch[1]!.replace(/-distribution$/, '');
    if (stem === 'language' || PUBLIC_FLOOR_SYSTEMS.has(stem)) return true;
  }
  return false;
}

function isWorkspaceOrKitNode(node: Node): boolean {
  return node.band >= 50 && !isLanguageFloorNode(node);
}

function portablePath(output: string): string {
  if (
    output === '' ||
    output.startsWith('/') ||
    output.includes('\\') ||
    /^[A-Za-z]:/.test(output) ||
    output.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new HostPluginError('IA-PLUGIN-PRODUCT', `${output} is not a portable plugin path`);
  return output;
}

function hostToolsForEffects(host: StandalonePluginHost, effects: readonly string[]): string[] {
  const digest = '0'.repeat(64);
  const catalog =
    host === 'gemini'
      ? geminiProseCatalog(digest)
      : host === 'antigravity'
        ? antigravityProseCatalog(digest)
        : host === 'codex'
          ? codexProseCatalog(digest)
          : claudeProseCatalog(digest);
  const byId = new Map(catalog.tools.map((tool) => [tool.id, tool.name]));
  return [
    ...new Set(
      effects
        .flatMap((effect) => PROSE_EFFECT_TOOLS.get(effect) ?? [])
        .map((id) => byId.get(id))
        .filter((name): name is string => name !== undefined),
    ),
  ];
}

function formatCompiledValue(value: CompiledValue): string {
  if (value.kind === 'ref') return `\`@${value.discriminator} ${value.name}\``;
  if (value.kind === 'list') return value.items.map(formatCompiledValue).filter(Boolean).join(', ');
  return 'text' in value ? cleanLine(value.text) : '';
}

function renderRecordSummaryBlock(node: Node): string[] {
  const says = cleanLine(textsAt(node, 'meaning.says')[0]);
  const answers = cleanLine(textsAt(node, 'meaning.answers')[0]);
  const lines: string[] = [`### \`${node.name}\` (\`@${node.discriminator}\`)`];
  if (says) lines.push('', says);
  if (answers) lines.push('', `- **Answers:** ${answers}`);
  for (const section of node.sections) {
    if (section.name === 'meaning') continue;
    for (const field of fieldsOf(node, section.name)) {
      const formatted = formatCompiledValue(field.value);
      if (formatted) lines.push(`- **${section.name}.${field.key}:** ${formatted}`);
    }
  }
  return lines;
}

function renderCellBullet(cell: Cell): string {
  const condition =
    cell.condition === undefined
      ? ''
      : ` *(when ${cell.condition.map((term) => `${cleanLine(term.axis)} = ${cleanLine(term.value)}`).join(' and ')})*`;
  return `- **${cell.primitive}${cell.primary ? ' (primary)' : ''}**${condition}: ${cleanLine(cell.text)}`;
}

function collectNeighborhood(
  reader: ReadHandle,
  within: string,
  seeds: readonly Node[],
  nodesByIdentity: ReadonlyMap<string, Node>,
): ReadonlySet<string> {
  const visited = new Set<string>(seeds.map((seed) => seed.identity));
  let frontier = seeds.map((seed) => seed.identity);
  for (let hop = 0; hop < 2 && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const row of reader.directedView(id, { within })) {
        if (!visited.has(row.counterpart) && nodesByIdentity.has(row.counterpart)) {
          visited.add(row.counterpart);
          next.push(row.counterpart);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

function renderCapabilityReference(
  reader: ReadHandle,
  within: string,
  host: StandalonePluginHost,
  capability: Node,
  allRecords: readonly Node[],
  nodesByIdentity: ReadonlyMap<string, Node>,
  inlineBody?: Buffer,
): Buffer {
  const resolveTarget = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodesByIdentity.get(resolved.identity) : undefined;
  };
  const closure = capabilityClosure(
    [{ kind: 'ref', discriminator: 'capability', name: capability.identity }],
    resolveTarget,
  );
  const caps = closure.length > 0 ? closure : [capability];
  const playbooks = [
    ...new Map(
      caps
        .flatMap((cap) => valuesAt(cap, 'composition.playbooks').map(resolveTarget))
        .filter((node): node is Node => node !== undefined && node.discriminator === 'playbook')
        .map((node) => [node.identity, node]),
    ).values(),
  ];
  const explicitChecks = caps
    .flatMap((cap) => valuesAt(cap, 'composition.checks').map(resolveTarget))
    .filter((node): node is Node => node !== undefined && node.discriminator === 'check');

  const neighborhood = collectNeighborhood(reader, within, [...caps, ...playbooks], nodesByIdentity);
  const connected = (word: string): Node[] =>
    allRecords
      .filter((node) => node.discriminator === word && neighborhood.has(node.identity))
      .sort((a, b) => (a.identity < b.identity ? -1 : 1));

  // Also match authoring-guides or templates naming the capability's subject word (e.g. `decision-method` -> `decision`).
  const subjectStem = capability.name.replace(/-method$/, '');
  const authoringGuides = [
    ...new Map(
      [
        ...connected('authoring-guide'),
        ...allRecords.filter(
          (node) =>
            node.discriminator === 'authoring-guide' &&
            (node.name === subjectStem || textsAt(node, 'authoring.target-word')[0] === subjectStem),
        ),
      ].map((node) => [node.identity, node]),
    ).values(),
  ].sort((a, b) => (a.identity < b.identity ? -1 : 1));

  const templates = [
    ...new Map(
      [
        ...connected('template'),
        ...allRecords.filter(
          (node) => node.discriminator === 'template' && isWorkspaceOrKitNode(node) && neighborhood.has(node.identity),
        ),
      ].map((node) => [node.identity, node]),
    ).values(),
  ].sort((a, b) => (a.identity < b.identity ? -1 : 1));

  const checks = [
    ...new Map([...explicitChecks, ...connected('check')].map((node) => [node.identity, node])).values(),
  ].sort((a, b) => (a.identity < b.identity ? -1 : 1));

  const governanceRules = allRecords
    .filter(
      (node) =>
        (node.discriminator === 'law' || node.discriminator === 'principle' || node.discriminator === 'convention') &&
        (neighborhood.has(node.identity) || isWorkspaceOrKitNode(node)),
    )
    .filter((node) => !isLanguageFloorNode(node) || neighborhood.has(node.identity))
    .sort((a, b) => (a.identity < b.identity ? -1 : 1));

  const effects = [...new Set(caps.flatMap((cap) => textsAt(cap, 'execution.effects')))];
  const hostTools = hostToolsForEffects(host, effects);
  const says = cleanLine(textsAt(capability, 'meaning.says')[0]);
  const answers = cleanLine(textsAt(capability, 'meaning.answers')[0]);
  const useWhen = cleanLine(textsAt(capability, 'invocation.use-when')[0]);
  const argHint = cleanLine(textsAt(capability, 'invocation.argument-hint')[0]);

  const lines: string[] = [
    `# ${capability.name}`,
    '',
    '> Self-contained compiled OPAL method reference. Execute the phases and rules below directly using your native host tools; no runtime CLI or MCP server is required.',
    '',
  ];
  if (says) lines.push(says, '');
  lines.push('## Overview', '');
  lines.push(`- **Capability:** \`${capability.identity}\``);
  if (answers) lines.push(`- **Answers:** ${answers}`);
  if (useWhen) lines.push(`- **Use when:** ${useWhen}`);
  if (argHint) lines.push(`- **Arguments:** \`${argHint}\``);
  lines.push(
    `- **Effects:** ${effects.length > 0 ? effects.map((e) => `\`${e}\``).join(', ') : 'none (read/inspection)'}`,
  );
  if (hostTools.length > 0) lines.push(`- **Host tools:** ${hostTools.map((t) => `\`${t}\``).join(', ')}`);

  if (inlineBody !== undefined) {
    const trimmed = inlineBody.toString('utf8').trim();
    if (trimmed.length > 0) lines.push('', '## Instructions', '', trimmed);
  }

  for (const phase of PHASES) {
    const phaseCells = playbooks.flatMap((pb) => {
      const matching = pb.cells.filter((cell) => cell.phase === phase);
      const ordered = [...matching.filter((c) => c.primary), ...matching.filter((c) => !c.primary)];
      return ordered.map((cell) => ({ playbook: pb.name, cell }));
    });
    if (phaseCells.length === 0) continue;
    const title = phase[0]!.toUpperCase() + phase.slice(1);
    lines.push('', `## ${title}`, '');
    for (const { playbook, cell } of phaseCells) {
      lines.push(`${renderCellBullet(cell)} *(\`${playbook}\`)*`);
    }
  }

  if (governanceRules.length > 0) {
    lines.push('', '## Governing Rules');
    for (const rule of governanceRules.slice(0, 24)) {
      lines.push('', ...renderRecordSummaryBlock(rule));
    }
  }

  if (checks.length > 0) {
    lines.push('', '## Verification Checks');
    for (const check of checks) {
      lines.push('', ...renderRecordSummaryBlock(check));
    }
  }

  if (authoringGuides.length > 0) {
    lines.push('', '## Authoring Guides');
    for (const guide of authoringGuides) {
      lines.push('', ...renderRecordSummaryBlock(guide));
    }
  }

  if (templates.length > 0) {
    lines.push('', '## Templates');
    for (const tpl of templates) {
      lines.push('', ...renderRecordSummaryBlock(tpl));
    }
  }

  lines.push('');
  return utf8Bytes(lines.join('\n'));
}

function renderRouterSkill(
  routerName: string,
  description: string,
  host: StandalonePluginHost,
  entries: readonly RouterEntry[],
): Buffer {
  const readTool = host === 'gemini' || host === 'antigravity' ? 'read_file' : 'Read';
  const fields: FrontField[] = [
    { key: 'name', value: plainField(routerName) },
    { key: 'description', value: plainField(shortSummary(description, 240)) },
  ];
  const tableRows = entries.map((entry) => {
    const refPath = `references/${toPortableSlug(entry.capability.name, 'capability')}.md`;
    const summary = shortSummary(entry.summary, 140).replaceAll('|', '\\|');
    return `| \`${entry.activity}\` | \`${entry.capability.name}\` | ${summary || 'Compiled method packet'} | \`${refPath}\` |`;
  });
  const body = [
    ...(host === 'codex' ? ['**Codex:** Read `CODEX.md` at the plugin root for Codex-specific conventions.', ''] : []),
    `# ${toDisplayName(routerName)} Router`,
    '',
    shortSummary(description, 300),
    '',
    '## Progressive Disclosure Workflow',
    '',
    `1. Match the user's request to the closest activity or capability in the routing table below.`,
    `2. Use \`${readTool}\` to read the matching \`references/<capability>.md\` file inside this skill folder.`,
    '3. Execute the compiled Orient, Plan, Act, and Learn steps and governing checks directly with your native tools.',
    '',
    '## Routing Table',
    '',
    '| Activity | Capability | When to Use | Reference |',
    '| --- | --- | --- | --- |',
    ...tableRows,
    '',
  ].join('\n');
  return Buffer.concat([utf8Bytes(emitFrontmatter(fields)), utf8Bytes(`\n${body}`)]);
}

function renderRulesMarkdown(title: string, rules: readonly Node[]): Buffer {
  const laws = rules.filter((r) => r.discriminator === 'law');
  const principles = rules.filter((r) => r.discriminator === 'principle');
  const conventions = rules.filter((r) => r.discriminator === 'convention');
  const lines: string[] = [
    `# ${title} Governance Rules`,
    '',
    'Compiled workspace laws, principles, and conventions enforced while working in this project.',
  ];
  const addGroup = (heading: string, items: readonly Node[]): void => {
    if (items.length === 0) return;
    lines.push('', `## ${heading}`);
    for (const item of items) lines.push('', ...renderRecordSummaryBlock(item));
  };
  addGroup('Laws', laws);
  addGroup('Principles', principles);
  addGroup('Conventions', conventions);
  lines.push('');
  return utf8Bytes(lines.join('\n'));
}

function standaloneHookOf(node: Node): StandaloneHookRule | null {
  if (node.discriminator !== 'hook' || !isWorkspaceOrKitNode(node)) return null;
  if (!registrableHook(node.identity) || node.identity.length > HOOK_IDENTITY_LIMIT) return null;
  const event = textsAt(node, 'hook.event')[0];
  const rawTools = textsAt(node, 'hook.tools');
  const paths = textsAt(node, 'hook.paths');
  const message = textsAt(node, 'hook.message')[0];
  if (event?.toLowerCase() !== 'pretooluse') return null;
  if (rawTools.length === 0 || rawTools.some((t) => !HOOK_TOOLS.has(t.toLowerCase() as 'write'))) return null;
  if (
    paths.length === 0 ||
    paths.length > HOOK_SELECTION_LIMIT ||
    paths.some((p) => p.length > HOOK_SELECTION_LENGTH || !isSelection(p) || !registrableSelection(p))
  )
    return null;
  if (!message || message.trim() === '') return null;
  return {
    identity: node.identity,
    tools: [...new Set(rawTools.map((t) => HOOK_TOOLS.get(t.toLowerCase() as 'write')!))],
    paths,
    message: cleanLine(message),
  };
}

function renderStandaloneGuardScript(rules: readonly StandaloneHookRule[]): Buffer {
  const source = `#!/usr/bin/env node
// Standalone zero-dependency @hook path guard compiled by ia project --product plugin.
import { isAbsolute, relative, resolve, sep } from 'node:path';

const RULES = ${JSON.stringify(rules, null, 2)};
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (value) => (FOLD_CASE ? value.toLowerCase() : value);

function globToRegExp(pattern) {
  const normalized = fold(pattern.replace(/\\\\/g, '/'));
  if (normalized.endsWith('/')) {
    const prefix = normalized.slice(0, -1).replace(/[.+^$()|[\\]{}]/g, '\\\\$&');
    return new RegExp('^' + prefix + '(?:/.*)?$');
  }
  let expr = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        expr += '(?:.*/)?';
        i += 2;
      } else {
        expr += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      expr += '[^/]*';
    } else if (ch === '?') {
      expr += '[^/]';
    } else if ('+^$.()|[]{}'.includes(ch)) {
      expr += '\\\\' + ch;
    } else {
      expr += ch;
    }
  }
  expr += '$';
  return new RegExp(expr);
}

const COMPILED = RULES.map((rule) => ({
  ...rule,
  matchers: rule.paths.map(globToRegExp),
}));

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.toolCall && typeof event.toolCall === 'object' && !Array.isArray(event.toolCall)) {
    const name = event.toolCall.name;
    const tool = name === 'write_file' ? 'Write' : name === 'edit_file' ? 'Edit' : null;
    const args = event.toolCall.args && typeof event.toolCall.args === 'object' ? event.toolCall.args : {};
    const filePath = args.Path ?? args.AbsolutePath ?? args.TargetFile;
    const cwd =
      typeof event.cwd === 'string' && event.cwd
        ? event.cwd
        : Array.isArray(event.workspacePaths) && typeof event.workspacePaths[0] === 'string'
          ? event.workspacePaths[0]
          : process.cwd();
    if (!tool || typeof filePath !== 'string' || !filePath) return null;
    return { caller: 'antigravity', tool, filePath, cwd };
  }
  if (event.hook_event_name === 'BeforeTool') {
    const tool = event.tool_name === 'write_file' ? 'Write' : event.tool_name === 'replace' ? 'Edit' : null;
    const filePath = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input.file_path : undefined;
    const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
    if (!tool || typeof filePath !== 'string' || !filePath) return { caller: 'gemini', allowOnly: true };
    return { caller: 'gemini', tool, filePath, cwd };
  }
  if (event.hook_event_name === 'PreToolUse') {
    const tool = ['Write', 'Edit', 'MultiEdit'].includes(event.tool_name) ? event.tool_name : null;
    const filePath = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input.file_path : undefined;
    const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
    if (!tool || typeof filePath !== 'string' || !filePath) return null;
    return { caller: 'claude', tool, filePath, cwd };
  }
  return null;
}

function relativeWorkspacePath(cwd, filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const rel = relative(fold(resolve(cwd)), fold(abs));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null;
  return rel.replace(/\\\\/g, '/');
}

function respondDeny(caller, reason) {
  if (caller === 'gemini' || caller === 'antigravity') {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\\n');
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\\n',
  );
}

function respondAllow(caller) {
  if (caller === 'antigravity' || caller === 'gemini') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\\n');
  }
}

let raw = '';
for await (const chunk of process.stdin) {
  raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (raw.length > 1024 * 1024) break;
}

try {
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  const normalized = normalizeEvent(parsed);
  if (!normalized) {
    if (parsed && parsed.toolCall) respondAllow('antigravity');
  } else if (normalized.allowOnly) {
    respondAllow(normalized.caller);
  } else {
    const rel = relativeWorkspacePath(normalized.cwd, normalized.filePath);
    const hit =
      rel === null
        ? undefined
        : COMPILED.find(
            (rule) => rule.tools.includes(normalized.tool) && rule.matchers.some((re) => re.test(rel)),
          );
    if (hit) respondDeny(normalized.caller, \`\${hit.identity}: \${hit.message}\`);
    else respondAllow(normalized.caller);
  }
} catch {
  // Invalid hook payload: fail open only on malformed non-matching JSON unless caller is known.
}
`;
  return utf8Bytes(source);
}

function renderHookManifest(host: StandalonePluginHost): { readonly path: string; readonly bytes: Buffer } | null {
  if (host === 'claude') {
    return {
      path: 'hooks/hooks.json',
      bytes: jsonBytes({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [
                {
                  type: 'command',
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs"',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
    };
  }
  if (host === 'gemini') {
    return {
      path: 'hooks/hooks.json',
      bytes: jsonBytes({
        hooks: {
          BeforeTool: [
            {
              matcher: 'write_file|replace',
              hooks: [
                {
                  name: 'ia-guard',
                  type: 'command',
                  command: 'node "${extensionPath}/scripts/guard.mjs"',
                  timeout: 10000,
                },
              ],
            },
          ],
        },
      }),
    };
  }
  if (host === 'antigravity') {
    return {
      path: 'hooks.json',
      bytes: jsonBytes({
        'ia-guard': {
          PreToolUse: [
            {
              matcher: 'write_file|edit_file',
              hooks: [
                {
                  type: 'command',
                  command: 'node ./scripts/guard.mjs',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
    };
  }
  return null;
}

function renderAgentMarkdown(
  reader: ReadHandle,
  within: string,
  host: StandalonePluginHost,
  profile: Node,
  nodesByIdentity: ReadonlyMap<string, Node>,
  inlineBody?: Buffer,
): Buffer | null {
  if (host === 'codex') return null;
  const resolveTarget = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodesByIdentity.get(resolved.identity) : undefined;
  };
  const caps = capabilityClosure(valuesAt(profile, 'composition.capabilities'), resolveTarget);
  const effects = [...new Set(caps.flatMap((cap) => textsAt(cap, 'execution.effects')))];
  // Default to read tools when a profile inspects without mutating effects.
  const effectiveTools = hostToolsForEffects(host, effects.length > 0 ? effects : ['read']);
  if (effectiveTools.length === 0) return null;

  const one = (field: string): string | undefined => textsAt(profile, field)[0];
  const fields: FrontField[] =
    host === 'antigravity'
      ? [
          { key: 'name', value: plainField(toPortableSlug(profile.name, 'agent')) },
          {
            key: 'description',
            value: plainField(shortSummary(one('meaning.says') ?? `Use this agent for ${profile.name}.`, 240)),
          },
          { key: 'subagent', value: { kind: 'boolean', value: true } },
          { key: 'mainAgent', value: { kind: 'boolean', value: false } },
          { key: 'tools', value: { kind: 'list', items: effectiveTools } },
        ]
      : host === 'gemini'
        ? [
            { key: 'name', value: plainField(toPortableSlug(profile.name, 'agent')) },
            {
              key: 'description',
              value: plainField(shortSummary(one('meaning.says') ?? `Use this agent for ${profile.name}.`, 240)),
            },
            { key: 'tools', value: { kind: 'list', items: effectiveTools } },
            ...(one('execution.model-profile') === undefined
              ? []
              : [{ key: 'model', value: plainField(one('execution.model-profile')!) }]),
          ]
        : [
            { key: 'name', value: plainField(toPortableSlug(profile.name, 'agent')) },
            {
              key: 'description',
              value: plainField(shortSummary(one('meaning.says') ?? `Use this agent for ${profile.name}.`, 240)),
            },
            { key: 'tools', value: plainField(effectiveTools.join(', ')) },
            ...(one('execution.model-profile') === undefined
              ? []
              : [{ key: 'model', value: plainField(one('execution.model-profile')!) }]),
            ...(one('presentation.color') === undefined
              ? []
              : [{ key: 'color', value: plainField(one('presentation.color')!) }]),
            ...(one('execution.effort') === undefined
              ? []
              : [{ key: 'effort', value: plainField(one('execution.effort')!) }]),
          ];

  if (inlineBody !== undefined) {
    return Buffer.concat([utf8Bytes(emitFrontmatter(fields)), inlineBody]);
  }

  const voice = valuesAt(profile, 'composition.voice')
    .map(resolveTarget)
    .find((n) => n?.discriminator === 'voice');
  const mandate = valuesAt(profile, 'composition.mandate')
    .map(resolveTarget)
    .find((n) => n?.discriminator === 'mandate');
  const bodyLines: string[] = [
    '',
    `# ${profile.name}`,
    '',
    cleanLine(one('meaning.says')) || `Specialized agent profile for ${profile.name}.`,
  ];
  if (voice) {
    const tone = cleanLine(textsAt(voice, 'voice.tone')[0]);
    const style = cleanLine(textsAt(voice, 'voice.style')[0]);
    bodyLines.push('', '## Voice');
    if (tone) bodyLines.push(`- **Tone:** ${tone}`);
    if (style) bodyLines.push(`- **Style:** ${style}`);
  }
  if (mandate) {
    const moves = textsAt(mandate, 'authority.moves');
    const covers = textsAt(mandate, 'authority.covers');
    bodyLines.push('', '## Mandate');
    if (moves.length > 0) bodyLines.push(`- **Allowed moves:** ${moves.join(', ')}`);
    if (covers.length > 0) bodyLines.push(`- **Scope:** ${covers.map((c) => `\`${c}\``).join(', ')}`);
  }
  if (caps.length > 0) {
    bodyLines.push('', '## Capabilities');
    for (const cap of caps) {
      bodyLines.push(`- \`${cap.name}\`: ${shortSummary(textsAt(cap, 'meaning.says')[0], 180)}`);
    }
  }
  bodyLines.push('');
  return Buffer.concat([utf8Bytes(emitFrontmatter(fields)), utf8Bytes(bodyLines.join('\n'))]);
}

function selectBindingRow(
  value: StandaloneBindingRow | readonly StandaloneBindingRow[],
  precedence: readonly string[],
): StandaloneBindingRow | undefined {
  if (!Array.isArray(value)) return value as StandaloneBindingRow;
  if (value.length <= 1) return value[0];
  const ranked = value
    .map((row) => ({ row, rank: row.kit ? precedence.indexOf(row.kit) : -1 }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0]?.row ?? value[0];
}

/**
 * Compiles any seated workspace or kit workspace into a zero-IA-dependency standalone plugin for `options.host`
 * (`claude`, `codex`, `gemini`, or `antigravity`).
 */
export function compileStandalonePlugin(
  reader: ReadHandle,
  within: string,
  options: StandalonePluginOptions,
): readonly PluginFile[] {
  const { host } = options;
  const records = reader.records({ within });
  const nodesByIdentity = new Map(records.map((node) => [node.identity, node]));
  const resources = options.resources ?? [];
  const assets = options.assets ?? [];

  const authored = (word: string): Node[] =>
    records
      .filter((node) => node.discriminator === word && node.band === 100)
      .sort((a, b) => (a.identity < b.identity ? -1 : 1));
  const active = (word: string): Node[] =>
    records
      .filter((node) => node.discriminator === word && isWorkspaceOrKitNode(node))
      .sort((a, b) => (a.identity < b.identity ? -1 : 1));
  const one = (node: Node | undefined, field: string): string | undefined =>
    node === undefined ? undefined : textsAt(node, field)[0];

  const productDist = authored('distribution').find((node) => stated(node, 'product.name'));
  const anyDist = productDist ?? authored('distribution')[0];
  const workspaceNode = authored('workspace')[0];
  const systemNode = authored('system')[0];

  const rawName =
    one(productDist, 'product.name') ??
    workspaceNode?.name ??
    systemNode?.name ??
    anyDist?.name.replace(/-distribution$/, '') ??
    options.fallbackName ??
    'ia-plugin';
  const pluginName = toPortableSlug(rawName, 'ia-plugin');
  const displayName = one(productDist, 'product.display-name') ?? toDisplayName(pluginName);
  const version =
    one(productDist, 'product.version') ?? one(systemNode, 'head.version') ?? options.fallbackVersion ?? '0.1.0';
  const description = shortSummary(
    one(productDist, 'product.description') ??
      one(workspaceNode, 'meaning.says') ??
      one(anyDist, 'meaning.says') ??
      one(systemNode, 'head.describes') ??
      options.fallbackDescription ??
      `Standalone ${host} plugin compiled from ${pluginName}.`,
    240,
  );
  const author = one(productDist, 'product.author') ?? options.fallbackAuthor ?? 'InventArch';

  const product: PluginProduct = {
    name: pluginName,
    displayName,
    version,
    description,
    author,
    license: one(productDist, 'product.license') ?? 'Apache-2.0',
    keywords:
      productDist && stated(productDist, 'product.keywords') ? textsAt(productDist, 'product.keywords') : undefined,
    shortDescription: one(productDist, 'product.short-description'),
    category: one(productDist, 'product.category'),
  };

  const out: PluginFile[] = [];
  const add = (path: string, bytes: Buffer): void => {
    const clean = portablePath(path);
    if (out.some((file) => file.path === clean))
      throw new HostPluginError('IA-PLUGIN-PRODUCT', `Two sources render ${clean}`);
    out.push(Object.freeze({ path: clean, bytes }));
  };

  // 1. Host-native manifest.
  add(MANIFESTS[host], jsonBytes(pluginManifest(product, host)));

  // 2. Capabilities -> either <=4 inline-body skills (when lowered with inline bodies and no lane bindings)
  //    or bounded progressive-disclosure router skills (<=4 model-invocable skills total) + OPAL references/*.md.
  const allCapabilities = active('capability').filter((cap) => {
    const mode = one(cap, 'invocation.mode');
    return mode !== 'none' && mode !== 'delegated';
  });
  const capByName = new Map<string, Node>();
  for (const cap of allCapabilities) {
    const prev = capByName.get(cap.name);
    if (!prev || cap.band >= prev.band) capByName.set(cap.name, cap);
  }
  const uniqueCapabilities = [...capByName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const inlineBodyOf = (identity: string): Buffer | undefined =>
    resources.find((r) => r.owner === identity && r.role === 'body' && r.delivery === 'inline')?.bytes;

  const hasSeatBindings = options.bindings !== undefined && Object.keys(options.bindings).length > 0;
  const hasAdoptedKitCapabilities = allCapabilities.some((cap) => cap.band < 100);
  const allHaveInlineBodies =
    uniqueCapabilities.length > 0 && uniqueCapabilities.every((cap) => inlineBodyOf(cap.identity) !== undefined);

  const inferSeatedLane = (cap: Node): { readonly lane: Lane; readonly activity: string } | null => {
    const src = cap.source.path.replaceAll('\\', '/');
    const name = cap.name;
    if (name === 'method-vocabulary') return { lane: 'knowledge', activity: 'vocabulary' };
    if (src.includes('/ia-kb/') || name.startsWith('kb-')) {
      const activity = name === 'kb-knowledge' ? 'knowledge (default)' : name.replace(/^kb-/, '');
      return { lane: 'knowledge', activity };
    }
    if (src.includes('/ia-method/') || name === 'method-operate' || name.endsWith('-method')) {
      const activity = name === 'method-operate' ? 'work (default)' : name.replace(/-method$/, '');
      return { lane: 'work', activity };
    }
    if (
      src.includes('/ia-authoring') ||
      src.includes('/ia-engineering') ||
      src.includes('/ia-architecture') ||
      name.startsWith('authoring-') ||
      name.startsWith('engineering-') ||
      name.startsWith('architecture-') ||
      name.startsWith('delivery-')
    ) {
      const activity =
        name === 'authoring' || name === 'ia-authoring'
          ? 'delivery (default)'
          : name.replace(/^(?:ia-authoring-|authoring-|engineering-|architecture-|delivery-)/, '');
      return { lane: 'delivery', activity };
    }
    return null;
  };

  if (!hasSeatBindings && !hasAdoptedKitCapabilities && uniqueCapabilities.length <= 4 && allHaveInlineBodies) {
    for (const cap of uniqueCapabilities) {
      const mode = one(cap, 'invocation.mode');
      const fields: FrontField[] = [
        { key: 'name', value: plainField(toPortableSlug(cap.name, 'skill')) },
        { key: 'description', value: plainField(shortSummary(one(cap, 'meaning.says') ?? '', 240)) },
        ...(mode === 'user'
          ? [{ key: 'disable-model-invocation', value: { kind: 'boolean' as const, value: true } }]
          : []),
        ...(one(cap, 'invocation.argument-hint') === undefined
          ? []
          : [{ key: 'argument-hint', value: plainField(one(cap, 'invocation.argument-hint')!) }]),
      ];
      add(
        `skills/${toPortableSlug(cap.name, 'skill')}/SKILL.md`,
        Buffer.concat([utf8Bytes(emitFrontmatter(fields)), inlineBodyOf(cap.identity)!]),
      );
      for (const ref of resources.filter((r) => r.owner === cap.identity && r.delivery === 'installed-reference')) {
        add(ref.output, ref.bytes);
      }
    }
  } else if (uniqueCapabilities.length > 0) {
    const seatedMode = hasSeatBindings || (workspaceNode !== undefined && hasAdoptedKitCapabilities);
    if (seatedMode) {
      const precedence = options.precedence ?? [];
      const mergedKeys = new Map<string, StandaloneBindingRow>();
      for (const [key, row] of Object.entries(options.recommendedBindings ?? {})) {
        mergedKeys.set(key, row);
      }
      for (const [key, raw] of Object.entries(options.bindings ?? {})) {
        const chosen = selectBindingRow(raw, precedence);
        if (chosen !== undefined) mergedKeys.set(key, chosen);
      }

      const laneEntries: Record<Lane, RouterEntry[]> = { work: [], knowledge: [], delivery: [] };
      const assignedCaps = new Set<string>();

      for (const [key, row] of [...mergedKeys.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const dot = key.indexOf('.');
        if (dot <= 0) continue;
        const lane = key.slice(0, dot) as Lane;
        if (!LANES.includes(lane)) continue;
        const cap = capByName.get(row.capability);
        if (!cap) continue;
        const activity = key.slice(dot + 1) === '*' ? `${lane} (default)` : key.slice(dot + 1);
        laneEntries[lane].push({
          activity,
          capability: cap,
          summary: one(cap, 'invocation.use-when') ?? one(cap, 'meaning.says') ?? '',
        });
        assignedCaps.add(cap.name);
      }

      for (const cap of uniqueCapabilities) {
        if (assignedCaps.has(cap.name)) continue;
        const inferred = inferSeatedLane(cap);
        if (inferred === null) continue;
        laneEntries[inferred.lane].push({
          activity: inferred.activity,
          capability: cap,
          summary: one(cap, 'invocation.use-when') ?? one(cap, 'meaning.says') ?? '',
        });
        assignedCaps.add(cap.name);
      }

      for (const lane of LANES) {
        const entries = laneEntries[lane];
        if (entries.length === 0) continue;
        add(`skills/${lane}/SKILL.md`, renderRouterSkill(lane, LANE_DESCRIPTIONS[lane], host, entries));
        const seen = new Set<string>();
        for (const entry of entries) {
          if (seen.has(entry.capability.name)) continue;
          seen.add(entry.capability.name);
          const slug = toPortableSlug(entry.capability.name, 'capability');
          add(
            `skills/${lane}/references/${slug}.md`,
            renderCapabilityReference(
              reader,
              within,
              host,
              entry.capability,
              records,
              nodesByIdentity,
              inlineBodyOf(entry.capability.identity),
            ),
          );
        }
      }

      const unbound = uniqueCapabilities.filter((cap) => !assignedCaps.has(cap.name));
      if (unbound.length > 0) {
        const extraRouter = toPortableSlug(`${pluginName}-capabilities`, 'workspace-capabilities');
        const entries: RouterEntry[] = unbound.map((cap) => ({
          activity: cap.name,
          capability: cap,
          summary: one(cap, 'invocation.use-when') ?? one(cap, 'meaning.says') ?? '',
        }));
        add(
          `skills/${extraRouter}/SKILL.md`,
          renderRouterSkill(
            extraRouter,
            `Additional capabilities compiled from ${displayName}. Use when invoking specialized workspace or kit methods not covered by a primary lane.`,
            host,
            entries,
          ),
        );
        for (const cap of unbound) {
          const slug = toPortableSlug(cap.name, 'capability');
          add(
            `skills/${extraRouter}/references/${slug}.md`,
            renderCapabilityReference(reader, within, host, cap, records, nodesByIdentity, inlineBodyOf(cap.identity)),
          );
        }
      }
    } else {
      // Single-kit workspace without .ia/bindings.json: emit ONE <kit-name> router skill + references/*.md.
      const kitRouter = toPortableSlug(pluginName.replace(/-kit$/, ''), 'kit');
      const recommendedByCap = new Map<string, string>();
      for (const [key, row] of Object.entries(options.recommendedBindings ?? {})) {
        if (!recommendedByCap.has(row.capability)) recommendedByCap.set(row.capability, key);
      }
      const entries: RouterEntry[] = uniqueCapabilities.map((cap) => ({
        activity: recommendedByCap.get(cap.name) ?? cap.name,
        capability: cap,
        summary: one(cap, 'invocation.use-when') ?? one(cap, 'meaning.says') ?? '',
      }));
      add(
        `skills/${kitRouter}/SKILL.md`,
        renderRouterSkill(
          kitRouter,
          `${displayName} method router (${uniqueCapabilities.length} compiled capabilities). ${description}`,
          host,
          entries,
        ),
      );
      for (const cap of uniqueCapabilities) {
        const slug = toPortableSlug(cap.name, 'capability');
        add(
          `skills/${kitRouter}/references/${slug}.md`,
          renderCapabilityReference(reader, within, host, cap, records, nodesByIdentity, inlineBodyOf(cap.identity)),
        );
      }
    }
  }

  // 3. Governance context files when rules/laws/conventions/principles exist.
  const rules = [...active('law'), ...active('principle'), ...active('convention')];
  if (rules.length > 0) {
    if (host === 'gemini') add('GEMINI.md', renderRulesMarkdown(displayName, rules));
    else if (host === 'antigravity') add('rules/AGENTS.md', renderRulesMarkdown(displayName, rules));
  }

  // 4. Host-native agents from @agent-profile records.
  const profiles = authored('agent-profile').length > 0 ? authored('agent-profile') : active('agent-profile');
  for (const profile of profiles) {
    const mode = one(profile, 'invocation.mode');
    if (mode === 'none' || mode === 'delegated') continue;
    const rendered = renderAgentMarkdown(
      reader,
      within,
      host,
      profile,
      nodesByIdentity,
      inlineBodyOf(profile.identity),
    );
    if (rendered !== null) add(`agents/${toPortableSlug(profile.name, 'agent')}.md`, rendered);
  }

  // 5. Compiled standalone @hook guards + native host hook manifest.
  const hookRules = active('hook')
    .map(standaloneHookOf)
    .filter((rule): rule is StandaloneHookRule => rule !== null)
    .slice(0, HOOK_LIMIT);
  if (hookRules.length > 0) {
    const hookManifest = renderHookManifest(host);
    if (hookManifest !== null) {
      add('scripts/guard.mjs', renderStandaloneGuardScript(hookRules));
      add(hookManifest.path, hookManifest.bytes);
    }
  }

  // 6. Codex bridge doc & assets (skipping colliding paths).
  for (const asset of assets) {
    const clean = portablePath(asset.output);
    if (!out.some((file) => file.path === clean)) add(clean, asset.bytes);
  }
  if (host === 'codex' && !out.some((file) => file.path === 'CODEX.md')) {
    add(
      'CODEX.md',
      utf8Bytes(
        `# ${displayName}\n\nStandalone Codex plugin compiled from \`${pluginName}\`. Activate a router skill under \`skills/\` and read the matching \`references/<capability>.md\` file with \`Read\`.\n`,
      ),
    );
  }

  return Object.freeze(out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
