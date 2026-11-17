import type { ReadHandle } from '@inventarch/db';
import { isSelection, type Node } from '@inventarch/graph';
import { PHASES, type Cell, type CompiledField, type CompiledValue } from '@inventarch/language';
import {
  defaultActor,
  mandateAuthorityOf,
  requireMandatesAdmitted,
  rootWorkspace,
  RuntimeError,
} from '@inventarch/runtime';
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
    .replace(/-$/, '')
    .slice(0, 63)
    .replace(/-$/, '');
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
  const readTool = host === 'gemini' ? 'read_file' : host === 'antigravity' ? 'view_file' : 'Read';
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

interface CompiledWorkspaceGuardRow {
  readonly ownRoots: readonly string[];
  readonly actor: string | null;
  readonly reason: string | null;
  readonly refusal: { readonly message: string; readonly next: string } | null;
}

interface CompiledMandateGuardRow {
  readonly identity: string;
  readonly root: string;
  readonly invalid: string | null;
  readonly participant: string | null;
  readonly participantAgent: string | null;
  readonly hasParticipant: boolean;
  readonly hasScopeOrCovers: boolean;
  readonly scopedWorkspaces: readonly string[];
  readonly covers: readonly string[];
  readonly moves: readonly string[] | null;
}

interface CompiledMandateGuardModel {
  readonly admissionRefusal: string | null;
  readonly repositoryWorkspace: string | null;
  readonly rootWorkspace: string | null;
  readonly floorSystem: string | null;
  readonly declaredRoots: readonly { readonly root: string; readonly workspace: string }[];
  readonly declaredRootList: readonly string[];
  readonly systemsByFolder: Readonly<Record<string, string>>;
  readonly systemRoots: Readonly<Record<string, string>>;
  readonly workspaces: Readonly<Record<string, CompiledWorkspaceGuardRow>>;
  readonly subagents: Readonly<Record<string, { readonly profile: string; readonly agent: string | null }>>;
  readonly mandates: readonly CompiledMandateGuardRow[];
}

function compileMandateGuardModel(reader: ReadHandle, within: string): CompiledMandateGuardModel {
  try {
    requireMandatesAdmitted(reader, within);
  } catch (error) {
    return {
      admissionRefusal: error instanceof Error ? error.message : String(error),
      repositoryWorkspace: null,
      rootWorkspace: null,
      floorSystem: null,
      declaredRoots: [],
      declaredRootList: [],
      systemsByFolder: {},
      systemRoots: {},
      workspaces: {},
      subagents: {},
      mandates: [],
    };
  }
  const read = { within };
  const snapshot = reader.snapshot(read);
  const nodes = new Map(
    snapshot.records.filter((node) => node.placement.kind !== 'runtime').map((node) => [node.identity, node]),
  );
  const rootOf = new Map(snapshot.membership.map((row) => [row.identity, row.root]));
  const declaredRoots = reader.roots(read).map((row) => ({ root: row.root, workspace: row.workspace }));
  const declaredRootList = [...new Set(declaredRoots.map((row) => row.root))];
  const repoCandidate = reader.repositoryWorkspace(read);
  const repositoryWorkspace =
    repoCandidate !== undefined && nodes.get(repoCandidate)?.discriminator === 'workspace' ? repoCandidate : null;
  const rootWsCandidate = rootWorkspace(reader, read);
  const resolvedRootWorkspace =
    rootWsCandidate !== undefined && nodes.get(rootWsCandidate)?.discriminator === 'workspace' ? rootWsCandidate : null;
  const floorSystem =
    snapshot.records.find(
      (node) =>
        node.discriminator === 'system' &&
        node.source.path.slice(0, node.source.path.lastIndexOf('/')) === '.ia/src/floor',
    )?.identity ?? null;

  const systemsByFolder: Record<string, string> = {};
  const systemRoots: Record<string, string> = {};
  for (const node of nodes.values()) {
    if (node.discriminator !== 'system') continue;
    if (systemsByFolder[node.name] === undefined) systemsByFolder[node.name] = node.identity;
    systemRoots[node.identity] = rootOf.get(node.identity) ?? '';
  }

  const workspaces: Record<string, CompiledWorkspaceGuardRow> = {};
  for (const node of nodes.values()) {
    if (node.discriminator !== 'workspace') continue;
    const da = defaultActor(reader, within, node.identity);
    workspaces[node.identity] = {
      ownRoots: [...new Set(declaredRoots.filter((r) => r.workspace === node.identity).map((r) => r.root))],
      actor: da.actor ?? null,
      reason: da.reason ?? null,
      refusal: da.refusal !== undefined ? { message: da.refusal.message, next: da.refusal.next } : null,
    };
  }

  const targets = (identity: string, field: string, word: string): readonly string[] =>
    reader
      .directedView(identity, read)
      .filter(
        (row) =>
          row.kind === 'field-ref' &&
          row.direction === 'out' &&
          row.field === field &&
          nodes.get(row.counterpart)?.discriminator === word,
      )
      .map((row) => row.counterpart);

  const profilesByName = new Map<string, Node[]>();
  for (const node of nodes.values()) {
    if (node.discriminator !== 'agent-profile' || node.band !== 100) continue;
    const list = profilesByName.get(node.name) ?? [];
    list.push(node);
    profilesByName.set(node.name, list);
  }
  const subagents: Record<string, { readonly profile: string; readonly agent: string | null }> = {};
  for (const [name, list] of profilesByName.entries()) {
    if (list.length !== 1) continue;
    const profile = list[0]!;
    const agents = targets(profile.identity, 'composition.agent', 'agent');
    subagents[name] = { profile: profile.identity, agent: agents.length === 1 ? agents[0]! : null };
  }

  const statesKey = (node: Node, sectionName: string, key: string): boolean =>
    node.sections
      .filter((s) => s.name === sectionName)
      .flatMap((s) => s.fields)
      .some((c) => 'key' in c && c.key === key);
  const statesValue = (node: Node, sectionName: string, key: string): boolean =>
    node.sections
      .filter((s) => s.name === sectionName)
      .flatMap((s) => s.fields)
      .some(
        (c) => 'key' in c && c.key === key && !('value' in c && c.value.kind === 'list' && c.value.items.length === 0),
      );
  const coversOf = (node: Node): readonly string[] =>
    node.sections
      .filter((s) => s.name === 'authority')
      .flatMap((s) => s.fields)
      .filter((c): c is CompiledField => 'key' in c && c.key === 'covers')
      .flatMap((c) => (c.value.kind === 'list' ? c.value.items : [c.value]))
      .flatMap((v) => ('text' in v ? [v.text] : []));

  const mandates: CompiledMandateGuardRow[] = [...nodes.values()]
    .filter((node) => node.discriminator === 'mandate' && node.band === 100)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
    .map((node): CompiledMandateGuardRow => {
      const root = rootOf.get(node.identity) ?? '';
      const hasParticipant = statesKey(node, 'authority', 'participant');
      const hasScopeOrCovers = statesValue(node, 'authority', 'scope') || statesValue(node, 'authority', 'covers');
      const scopedWorkspaces = targets(node.identity, 'authority.scope', 'workspace');
      const participantAgent = targets(node.identity, 'authority.participant', 'agent')[0] ?? null;
      const rawCovers = coversOf(node);
      try {
        const authority = mandateAuthorityOf(node);
        return {
          identity: node.identity,
          root,
          invalid: null,
          participant:
            authority.participant === undefined ? null : (participantAgent ?? `@agent ${authority.participant}`),
          participantAgent,
          hasParticipant,
          hasScopeOrCovers,
          scopedWorkspaces,
          covers: authority.covers ? [...authority.covers] : [...rawCovers],
          moves: authority.moves ? [...authority.moves] : null,
        };
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        return {
          identity: node.identity,
          root,
          invalid: error.message,
          participant: participantAgent,
          participantAgent,
          hasParticipant,
          hasScopeOrCovers,
          scopedWorkspaces,
          covers: [...rawCovers],
          moves: null,
        };
      }
    });

  return {
    admissionRefusal: null,
    repositoryWorkspace,
    rootWorkspace: resolvedRootWorkspace,
    floorSystem,
    declaredRoots,
    declaredRootList,
    systemsByFolder,
    systemRoots,
    workspaces,
    subagents,
    mandates,
  };
}

const JS_UNSAFE_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function jsLiteral(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(/[<>\u2028\u2029]/g, (ch) => JS_UNSAFE_ESCAPES[ch] ?? ch);
}

function renderStandaloneGuardScript(
  host: StandalonePluginHost,
  rules: readonly StandaloneHookRule[],
  model: CompiledMandateGuardModel,
): Buffer {
  const source = `#!/usr/bin/env node
// Standalone zero-dependency @hook and @mandate path guard compiled by ia project --product plugin.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const HOST = ${jsLiteral(host)};
const RULES = ${jsLiteral(rules, 2)};
const MODEL = ${jsLiteral(model, 2)};
const DECLARED_ROOT_SET = new Set(MODEL.declaredRootList);
const AGENT_LIMIT = 512;
const ESCAPES = new RegExp('\\\\u001b(?:\\\\[[0-?]*[ -/]*[@-~]|\\\\][^\\\\u0007\\\\u001b]*(?:\\\\u0007|\\\\u001b\\\\\\\\)?|[@-_])', 'g');
const CONTROLS = new RegExp('[\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f\\\\u061c\\\\u200e\\\\u200f\\\\u2028\\\\u2029\\\\u202a-\\\\u202e\\\\u2066-\\\\u2069]', 'g');
const ALL_ONES = 2n ** 64n - 1n;

function printable(text) {
  return String(text).replace(ESCAPES, '').replace(CONTROLS, ' ').slice(0, 4096);
}

function caseFold(name) {
  return name
    .normalize('NFC')
    .split('\\u0131')
    .map((part) => part.toLowerCase().toUpperCase().toLowerCase().normalize('NFC'))
    .join('\\u0131');
}

function fold(value) {
  if (process.platform === 'win32') return value.toLowerCase();
  return process.platform === 'darwin' ? caseFold(value) : value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validFilePath(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\\0');
}

function streamed(filePath) {
  const rest = filePath.replace(/^[\\\\/]{2}[?.][\\\\/]/, '').replace(/^[A-Za-z]:/, '');
  return rest.includes(':');
}

function selectionSegments(selection) {
  const text = String(selection).replaceAll('\\\\', '/');
  if (text === '' || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return undefined;
  const segments = (text.endsWith('/') ? text + '**' : text).split('/');
  return segments.some((s) => s === '' || s === '.' || s === '..') ? undefined : segments;
}

function pathSegments(relPath) {
  const text = String(relPath).replaceAll('\\\\', '/');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return undefined;
  if (text === '') return [];
  const segments = text.split('/');
  return segments.some((s) => s === '' || s === '.' || s === '..') ? undefined : segments;
}

function wildcard(pattern, text, star, accepts) {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && !star(pattern[p]) && accepts(pattern[p], text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && star(pattern[p])) {
      starAt = p;
      p += 1;
      resume = t;
    } else if (starAt >= 0) {
      p = starAt + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && star(pattern[p])) p += 1;
  return p === pattern.length;
}

function segmentAccepts(pattern, segment) {
  return wildcard([...pattern], [...segment], (c) => c === '*', (c, d) => c === '?' || c === d);
}

function selects(selection, relPath) {
  const pattern = selectionSegments(fold(selection));
  const target = pathSegments(fold(relPath));
  return pattern !== undefined && target !== undefined && wildcard(pattern, target, (s) => s === '**', segmentAccepts);
}

function linked(absPath) {
  const absolute = resolve(absPath);
  const volume = parse(absolute).root;
  let current = volume;
  for (const part of absolute.slice(volume.length).split(/[\\\\/]/).filter(Boolean)) {
    current = join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code ?? '')) return false;
      throw error;
    }
    if (isLink) return true;
  }
  return false;
}

function unaliased(targetPath, realPath) {
  if (targetPath === realPath) return true;
  if (process.platform === 'win32') return resolve(targetPath).toLowerCase() === realPath.toLowerCase() && !linked(resolve(targetPath));
  return targetPath === resolve(targetPath) && !linked(targetPath);
}

function physical(targetPath) {
  try {
    lstatSync(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = dirname(targetPath);
    if (parent === targetPath) throw error;
    return resolve(physical(parent), relative(parent, targetPath));
  }
  return realpathSync.native(targetPath);
}

function sameFile(a, b) {
  try {
    const left = statSync(a, { bigint: true, throwIfNoEntry: false });
    const right = statSync(b, { bigint: true, throwIfNoEntry: false });
    if (!left || !right) return false;
    if (left.ino !== 0n && left.ino !== ALL_ONES && right.ino !== 0n && right.ino !== ALL_ONES) {
      return left.dev === right.dev && left.ino === right.ino;
    }
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return fold(resolve(a)) === fold(resolve(b));
  }
}

function local(rootPath, targetPath) {
  const rel = relative(fold(rootPath), fold(targetPath));
  return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ? undefined : rel.replaceAll('\\\\', '/');
}

function anchored(rootPath, targetPath) {
  for (let current = targetPath; ; ) {
    if (sameFile(current, rootPath)) return local(current, targetPath);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function installation(relPath) {
  return relPath === '.ia/distributions.lock.json' || relPath === '.ia/distributions' || relPath.startsWith('.ia/distributions/');
}

function callerOf(event) {
  if (!isPlainObject(event)) return HOST;
  if (event.hook_event_name === 'BeforeTool') return 'gemini';
  if (isPlainObject(event.toolCall)) return 'antigravity';
  if (event.hook_event_name === 'PreToolUse') return 'claude';
  return HOST;
}

function normalizeEvent(event) {
  if (!isPlainObject(event)) return null;
  if (isPlainObject(event.toolCall)) {
    const ev = event.hookEventName ?? event.hook_event_name;
    if (ev !== undefined && ev !== 'PreToolUse') return null;
    const call = event.toolCall;
    const name = call.name;
    const tool =
      name === 'write_to_file' || name === 'write_file'
        ? 'Write'
        : name === 'replace_file_content' || name === 'edit_file'
          ? 'Edit'
          : name === 'multi_replace_file_content'
            ? 'MultiEdit'
            : null;
    const args = call.args;
    if (!tool || !isPlainObject(args)) return null;
    if (name === 'multi_replace_file_content' && !Array.isArray(args.ReplacementChunks)) return null;
    const filePath = args.TargetFile ?? args.Path ?? args.AbsolutePath;
    if (!validFilePath(filePath)) return null;
    const workspacePaths = Array.isArray(event.workspacePaths)
      ? event.workspacePaths.filter((p) => typeof p === 'string' && p.trim().length > 0)
      : [];
    return {
      caller: 'antigravity',
      tool,
      filePath,
      cwd: typeof event.cwd === 'string' && event.cwd.trim() ? event.cwd : workspacePaths[0],
      workspacePaths,
      agentId: event.agent_id ?? event.agentId,
      agentType: event.agent_type ?? event.agentType,
    };
  }
  if (event.hook_event_name === 'BeforeTool') {
    const tool = event.tool_name === 'write_file' ? 'Write' : event.tool_name === 'replace' ? 'Edit' : null;
    if (!tool || !isPlainObject(event.tool_input) || !validFilePath(event.tool_input.file_path)) return null;
    return {
      caller: 'gemini',
      tool,
      filePath: event.tool_input.file_path,
      cwd: event.cwd,
      workspacePaths: [],
      agentId: event.agent_id,
      agentType: event.agent_type,
    };
  }
  if (
    event.hook_event_name === 'PreToolUse' &&
    ['Write', 'Edit', 'MultiEdit'].includes(String(event.tool_name)) &&
    isPlainObject(event.tool_input) &&
    validFilePath(event.tool_input.file_path) &&
    !(event.tool_name === 'MultiEdit' && !Array.isArray(event.tool_input.edits))
  ) {
    return {
      caller: 'claude',
      tool: event.tool_name,
      filePath: event.tool_input.file_path,
      cwd: event.cwd,
      workspacePaths: [],
      agentId: event.agent_id,
      agentType: event.agent_type,
    };
  }
  return null;
}

function findIaAncestor(startDir) {
  for (let current = resolve(startDir); ; ) {
    try {
      const st = lstatSync(join(current, '.ia', 'src'), { throwIfNoEntry: false });
      if (st && st.isDirectory() && !st.isSymbolicLink()) return current;
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveRootPath(normalized) {
  const rootArgIdx = process.argv.indexOf('--root');
  if (rootArgIdx >= 0 && typeof process.argv[rootArgIdx + 1] === 'string' && process.argv[rootArgIdx + 1]) {
    const explicit = process.argv[rootArgIdx + 1];
    if (!isAbsolute(explicit)) throw new Error('Binding requires an absolute fixed project root');
    const base = resolve(explicit);
    const real = realpathSync.native(base);
    if (!unaliased(base, real)) throw new Error('Project root is aliased');
    return { rawRoot: base, base: real };
  }
  if (normalized.caller === 'claude' && typeof process.env.CLAUDE_PROJECT_DIR === 'string' && process.env.CLAUDE_PROJECT_DIR.trim()) {
    const envRoot = resolve(process.env.CLAUDE_PROJECT_DIR);
    return { rawRoot: envRoot, base: realpathSync.native(envRoot) };
  }
  if (normalized.workspacePaths.length > 0) {
    const chosen = normalized.workspacePaths.find((ws) => isAbsolute(ws) && isAbsolute(normalized.filePath) && local(resolve(ws), resolve(normalized.filePath)) !== undefined) ?? normalized.workspacePaths[0];
    if (typeof chosen === 'string' && isAbsolute(chosen)) {
      const wsRoot = resolve(chosen);
      return { rawRoot: wsRoot, base: realpathSync.native(wsRoot) };
    }
  }
  if (typeof normalized.cwd === 'string' && isAbsolute(normalized.cwd)) {
    const cwdResolved = resolve(normalized.cwd);
    const iaRoot = findIaAncestor(cwdResolved) ?? cwdResolved;
    return { rawRoot: iaRoot, base: realpathSync.native(iaRoot) };
  }
  throw new Error('Binding requires an absolute workspace root or cwd');
}

function resolveEditTarget(normalized) {
  if (process.platform === 'win32' && streamed(normalized.filePath)) {
    throw new Error('A path naming an alternate data stream or a drive-relative path is refused');
  }
  const { rawRoot, base } = resolveRootPath(normalized);
  const rawPath = normalized.filePath;
  if (!isAbsolute(rawPath)) {
    if (typeof normalized.cwd !== 'string' || !isAbsolute(normalized.cwd) || local(base, physical(resolve(normalized.cwd))) === undefined) {
      throw new Error('Relative input requires cwd inside the fixed root');
    }
  }
  let target;
  if (isAbsolute(rawPath)) {
    const resolvedFile = resolve(rawPath);
    const relFromRawRoot = rawRoot !== base ? local(rawRoot, resolvedFile) : undefined;
    target = relFromRawRoot !== undefined && !linked(rawRoot) ? resolve(base, relFromRawRoot) : resolvedFile;
  } else {
    const effectiveCwd = process.platform === 'win32' ? resolve(normalized.cwd) : physical(resolve(normalized.cwd));
    const relCwd = rawRoot !== base ? local(rawRoot, effectiveCwd) : undefined;
    const baseCwd = relCwd !== undefined ? resolve(base, relCwd) : effectiveCwd;
    target = resolve(baseCwd, rawPath);
  }
  const actual = physical(target);
  const lexical = local(base, target);
  const physicalPath = local(base, actual);
  const spellings = [lexical, physicalPath];
  if (lexical === undefined && physicalPath === undefined) {
    spellings.push(anchored(base, target), anchored(base, actual));
  }
  return { base, target, actual, spellings };
}

function reaches(from, to) {
  return from === '' || from === to || to.startsWith(from + '/');
}

function systemFolderOf(withTrailingSlash) {
  const m = /^\\.ia\\/src\\/systems\\/([a-z][a-z0-9-]*)\\//.exec(withTrailingSlash);
  return m ? m[1] : undefined;
}

function resolveSeat(relPath) {
  const segs = pathSegments(relPath);
  if (segs === undefined) return { path: relPath, unknown: 'outside' };
  const canonical = segs.join('/');
  const folder = systemFolderOf(canonical + '/');
  const system =
    folder !== undefined
      ? MODEL.systemsByFolder[folder]
      : reaches('.ia/src/floor', canonical)
        ? (MODEL.floorSystem ?? undefined)
        : undefined;
  const longest = MODEL.declaredRoots.find((d) => reaches(d.root, canonical))?.root;
  const declarers =
    longest === undefined
      ? []
      : [...new Set(MODEL.declaredRoots.filter((d) => d.root === longest).map((d) => d.workspace))];
  const repoWs = canonical.split('/').includes('.ia') ? undefined : (MODEL.repositoryWorkspace ?? undefined);
  if (system !== undefined) return { path: canonical, seat: system, by: 'system' };
  if (declarers.length > 1) return { path: canonical, by: 'shared', declarers };
  if (declarers.length === 1) return { path: canonical, seat: declarers[0], by: 'root' };
  if (repoWs !== undefined) return { path: canonical, seat: repoWs, by: 'repository' };
  return { path: canonical, unknown: 'undeclared' };
}

function holds(ownRoots, recordRoot) {
  return ownRoots.length > 0 ? ownRoots.includes(recordRoot) : !DECLARED_ROOT_SET.has(recordRoot);
}

function workspaceOf(seatIdentity) {
  if (!seatIdentity) return MODEL.rootWorkspace ?? undefined;
  if (MODEL.workspaces[seatIdentity]) return seatIdentity;
  const recRoot = MODEL.systemRoots[seatIdentity];
  if (recRoot === undefined) return MODEL.rootWorkspace ?? undefined;
  const holder = MODEL.declaredRoots.find((d) => reaches(d.root, recRoot))?.workspace;
  return [MODEL.rootWorkspace ?? undefined, holder].find(
    (at) => at !== undefined && MODEL.workspaces[at] && holds(MODEL.workspaces[at].ownRoots, recRoot),
  );
}

function seatedWorkspace(relPath) {
  const res = resolveSeat(relPath);
  if (res.by !== 'shared') return workspaceOf(res.seat);
  const own = MODEL.repositoryWorkspace;
  return own !== null && res.declarers.includes(own) ? own : undefined;
}

function governingWorkspace(relPath) {
  return seatedWorkspace(relPath) ?? resolveSeat(relPath).declarers?.[0];
}

function governingMandatesFor(relPath, ws, actor) {
  const seat = resolveSeat(relPath);
  const shared = seat.by === 'shared' ? seat.declarers : undefined;
  const inside = (m) =>
    shared !== undefined
      ? shared.some((d) => MODEL.workspaces[d] && holds(MODEL.workspaces[d].ownRoots, m.root))
      : holds(ws !== undefined && MODEL.workspaces[ws] ? MODEL.workspaces[ws].ownRoots : [], m.root);
  const governs = (m) => {
    const scoped =
      shared !== undefined
        ? ws !== undefined && shared.every((d) => m.scopedWorkspaces.includes(d))
        : ws !== undefined && m.scopedWorkspaces.includes(ws);
    const claims = m.covers.some((sel) => selects(sel, seat.path ?? relPath));
    if (shared !== undefined) return m.hasScopeOrCovers && (scoped || claims);
    if (m.hasScopeOrCovers) return scoped || claims;
    return actor === undefined ? m.hasParticipant : m.participantAgent === actor;
  };
  const matched = MODEL.mandates.filter((m) => inside(m) && governs(m));
  for (const m of matched) {
    if (m.invalid !== null) {
      const err = new Error(m.invalid);
      err.mandateIdentity = m.identity;
      throw err;
    }
  }
  return matched.map((m) => ({
    ...m,
    ...(actor === undefined ? {} : { binds: m.participant === null || m.participantAgent === actor }),
  }));
}

function resolveActing(normalized, ws) {
  const { agentId, agentType } = normalized;
  if (agentId !== undefined) {
    if (typeof agentId !== 'string' || agentId === '' || agentId.length > AGENT_LIMIT) {
      return { refusal: 'the subagent event carries a malformed agent_id', subagent: true };
    }
    if (typeof agentType !== 'string' || agentType === '' || agentType.length > AGENT_LIMIT) {
      return { refusal: 'the subagent event names no agent_type', subagent: true };
    }
    const entry = Object.hasOwn(MODEL.subagents, agentType) ? MODEL.subagents[agentType] : undefined;
    if (!entry) {
      return { refusal: \`subagent \${agentType} matches no single authored @agent-profile of that name\`, subagent: true };
    }
    if (!entry.agent) {
      return { refusal: \`\${entry.profile} names no admitted composition.agent\`, subagent: true };
    }
    return { agent: entry.agent, as: \`subagent \${agentType} acts as \${entry.agent} (\${entry.profile})\` };
  }
  if (ws === undefined || !MODEL.workspaces[ws]) {
    return { as: 'the main session has no default actor: no @workspace holds this path' };
  }
  const wsInfo = MODEL.workspaces[ws];
  if (wsInfo.refusal) {
    return { refusal: wsInfo.refusal.message, next: wsInfo.refusal.next, subagent: false };
  }
  return wsInfo.actor === null
    ? { as: \`the main session has no default actor: \${wsInfo.reason}\` }
    : { agent: wsInfo.actor, as: \`the main session acts as \${wsInfo.actor}\` };
}

function governanceCmd(seat) {
  return \`ia position --seat \${seat} --shape governance\`;
}

function evaluateProfileAuthor(mandates) {
  if (mandates.length === 0) return {};
  const whom = (m) => (m.participant === null ? m.identity : \`\${m.identity} binds \${m.participant}\`);
  const judged = mandates.map((m) => ({
    authority: m,
    refusal: m.moves !== null && !m.moves.includes('Synthesis')
      ? { message: \`\${m.identity} allows \${m.moves.join(', ')}; author needs Synthesis\`, next: governanceCmd(m.identity) }
      : undefined,
  }));
  const binding = judged.filter(({ authority }) => authority.binds !== false);
  if (binding.length === 0) {
    return {
      refusal: {
        message: \`no mandate that governs here binds the acting @agent: \${mandates.map(whom).join('; ')}\`,
        next: governanceCmd(mandates[0].identity),
      },
    };
  }
  const named = binding.filter(({ authority }) => authority.participant !== null).map(({ authority }) => authority);
  const participants = new Set(named.map((a) => a.participant));
  if (participants.size > 1) {
    return {
      refusal: {
        message: \`the mandates that govern here bind \${participants.size} participants and name no acting @agent: \${named.map(whom).join('; ')}\`,
        next: governanceCmd(named[0].identity),
      },
    };
  }
  const unbound = named.filter((a) => a.binds === undefined);
  if (unbound.length > 0) {
    return {
      refusal: {
        message: \`a governing mandate names a participant but no acting @agent was established: \${unbound.map(whom).join('; ')}\`,
        next: governanceCmd(unbound[0].identity),
      },
    };
  }
  if (binding.every(({ refusal }) => refusal !== undefined)) {
    return {
      refusal: {
        message: \`\${binding.map(({ authority }) => \`\${authority.identity} allows \${authority.moves.join(', ')}\`).join('; ')}; author needs Synthesis\`,
        next: governanceCmd(binding[0].authority.identity),
      },
    };
  }
  return {};
}

function evaluateRule(rule, paths, normalized) {
  const formatDeny = (code, why, next) => ({
    allowed: false,
    code,
    message: \`\${rule.message} (\${rule.identity}: \${why}) Next: \${next}\`,
  });
  if (MODEL.admissionRefusal !== null) {
    return formatDeny('IA-HOOK-MANDATE-UNAVAILABLE', \`the mandates that govern this edit cannot be read: \${MODEL.admissionRefusal}\`, 'ia report');
  }
  try {
    const ws = seatedWorkspace(paths[0]);
    const locate = (actor) => {
      const found = new Map();
      for (const p of paths) {
        const gws = ws ?? governingWorkspace(p);
        for (const m of governingMandatesFor(p, gws, actor)) {
          if (!found.has(m.identity)) found.set(m.identity, m);
        }
      }
      return [...found.values()].sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
    };
    const actor = resolveActing(normalized, ws);
    const governing = locate(undefined);
    const seat = governing[0]?.identity ?? ws;
    const first = seat === undefined ? 'ia position --shape governance' : governanceCmd(seat);
    if (actor.refusal !== undefined && actor.subagent) {
      return formatDeny('IA-HOOK-IDENTITY-UNAVAILABLE', actor.refusal, first);
    }
    if (governing.length === 0) return { allowed: true };
    if (actor.refusal !== undefined) {
      return formatDeny('IA-HOOK-IDENTITY-UNAVAILABLE', actor.refusal, actor.next ?? first);
    }
    let verdict;
    if (actor.agent === undefined) {
      const named = governing.find((m) => m.participant !== null);
      if (named !== undefined) {
        return formatDeny('IA-HOOK-IDENTITY-UNAVAILABLE', \`\${actor.as}; \${named.identity} binds \${named.participant}\`, governanceCmd(named.identity));
      }
      verdict = evaluateProfileAuthor(governing);
    } else {
      verdict = evaluateProfileAuthor(locate(actor.agent));
    }
    if (verdict.refusal !== undefined) {
      return formatDeny('IA-HOOK-NOT-MANDATED', \`\${actor.as}; \${verdict.refusal.message}\`, verdict.refusal.next);
    }
    return { allowed: true };
  } catch (error) {
    const next = error?.mandateIdentity ? governanceCmd(error.mandateIdentity) : 'ia report';
    return formatDeny('IA-HOOK-MANDATE-UNAVAILABLE', \`the mandates that govern this edit cannot be read: \${error?.message ?? String(error)}\`, next);
  }
}

function respondDeny(caller, code, message) {
  const reason = printable(\`\${code}: \${message}\`);
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

const chunks = [];
let totalBytes = 0;
for await (const chunk of process.stdin) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  totalBytes += buf.byteLength;
  if (totalBytes > 1024 * 1024) {
    respondDeny(HOST, 'IA-HOOK-INPUT-INVALID', 'Input exceeds 1 MiB');
    process.exit(0);
  }
  chunks.push(buf);
}

let parsed;
try {
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    respondDeny(HOST, 'IA-HOOK-INPUT-INVALID', 'Expected a PreToolUse file edit event');
    process.exit(0);
  }
  parsed = JSON.parse(raw);
} catch {
  respondDeny(HOST, 'IA-HOOK-INPUT-INVALID', 'Invalid JSON input');
  process.exit(0);
}

const caller = callerOf(parsed);
const normalized = normalizeEvent(parsed);
if (!normalized) {
  respondDeny(caller, 'IA-HOOK-INPUT-INVALID', 'Expected a PreToolUse file edit event');
  process.exit(0);
}

let edit;
try {
  edit = resolveEditTarget(normalized);
} catch (error) {
  respondDeny(caller, 'IA-HOOK-PATH-UNSAFE', error?.message ?? String(error));
  process.exit(0);
}

if (edit.spellings.some((s) => s !== undefined && installation(s))) {
  respondDeny(caller, 'IA-HOOK-PROJECTION-MANAGED', 'Use the owning command for generated installation state');
  process.exit(0);
}

const paths = [...new Set([edit.spellings[1], edit.spellings[0], ...edit.spellings.slice(2)])].filter(
  (s) => s !== undefined,
);
if (paths.length === 0) {
  respondAllow(caller);
  process.exit(0);
}

try {
  const linkedStat = lstatSync(edit.actual, { throwIfNoEntry: false });
  if (linkedStat !== undefined && linkedStat.isFile() && linkedStat.nlink > 1) {
    respondDeny(caller, 'IA-HOOK-PATH-UNSAFE', 'A file with more than one link is refused: another of its names may be guarded');
    process.exit(0);
  }
} catch (error) {
  respondDeny(caller, 'IA-HOOK-PATH-UNSAFE', error?.message ?? String(error));
  process.exit(0);
}

for (const rule of RULES) {
  const selected =
    rule.tools.includes(normalized.tool) &&
    paths.some((p) => rule.paths.some((sel) => selects(sel, p)));
  if (!selected) continue;
  if (!unaliased(edit.target, edit.actual)) {
    respondDeny(caller, 'IA-HOOK-PATH-UNSAFE', 'Selected path has an aliased ancestor or target');
    process.exit(0);
  }
  const decision = evaluateRule(rule, paths, normalized);
  if (!decision.allowed) {
    respondDeny(caller, decision.code, decision.message);
    process.exit(0);
  }
}

respondAllow(caller);
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
              matcher: 'write_to_file|replace_file_content|multi_replace_file_content|write_file|edit_file',
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
      const guardModel = compileMandateGuardModel(reader, within);
      add('scripts/guard.mjs', renderStandaloneGuardScript(host, hookRules, guardModel));
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
