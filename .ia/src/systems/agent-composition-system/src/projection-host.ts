import { posix } from 'node:path';
import type { CompiledChild, CompiledRecord, CompiledValue } from '@inventarch/language';
import { frozen, hash, list, object } from './resource-format.js';
import type { ResourceFile, ResourceOccurrence } from './resource-format.js';
import { catalogId, fail, id, inputFailure, unique } from './projection-format.js';
import type { ProfilePin, ProjectionExport } from './projection-format.js';
import {
  CODEX_PROSE_FEATURES,
  CODEX_PROSE_PROFILE,
  codexInvocation,
  codexOutputPath,
  serializeCodexExport,
} from './projection-codex.js';
import type { SerializedExport } from './projection-codex.js';

export { CODEX_PROSE_FEATURES, codexAgentRegistration } from './projection-codex.js';

export interface ProjectionCatalog {
  readonly format: 'ia.projection-catalog.v1';
  readonly profile: ProfilePin;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly tools: readonly { readonly id: string; readonly name: string }[];
  readonly inputFields: readonly { readonly name: string; readonly type: 'text' }[];
}
export const CLAUDE_PROSE_FEATURES = Object.freeze([
  'agents',
  'skills',
  'commands',
  'text-arguments',
  'prompt-literal-guidance',
  'resources',
  'conditional-guidance',
]);
/** Host-owned name mappings. Their presence is metadata support, never an execution grant. */
export function claudeProseCatalog(
  implementationDigest: string,
  selections: Pick<ProjectionCatalog, 'models' | 'tools' | 'inputFields'> = {
    models: [{ id: 'inherit', name: 'inherit' }],
    tools: [
      { id: 'read', name: 'Read' },
      { id: 'glob', name: 'Glob' },
      { id: 'grep', name: 'Grep' },
    ],
    inputFields: [],
  },
): ProjectionCatalog {
  return proseCatalog('ia.host.claude-prose.v1', implementationDigest, selections);
}
function proseCatalog(
  profile: string,
  implementationDigest: string,
  selections: Pick<ProjectionCatalog, 'models' | 'tools' | 'inputFields'>,
): ProjectionCatalog {
  object(selections, ['models', 'tools', 'inputFields']);
  const names = (value: unknown) =>
    unique(
      list(value, 64).map((v) => {
        const r = object(v, ['id', 'name']);
        return { id: catalogId(r['id']), name: catalogId(r['name']) };
      }),
      (r) => r.id,
    );
  const inputFields = unique(
    list(selections.inputFields, 64).map((v) => {
      const r = object(v, ['name', 'type']);
      if (r['type'] !== 'text') inputFailure('This profile supports only text input fields');
      return { name: id(r['name']), type: 'text' as const };
    }),
    (r) => r.name,
  );
  return frozen({
    format: 'ia.projection-catalog.v1',
    profile: { id: profile, version: 1, implementationDigest: hash(implementationDigest) },
    models: names(selections.models),
    tools: names(selections.tools),
    inputFields,
  });
}
export function verifyCatalog(value: ProjectionCatalog): ProjectionCatalog {
  const row = object(value, ['format', 'profile', 'models', 'tools', 'inputFields']);
  const pin = object(row['profile'], ['id', 'version', 'implementationDigest']);
  if (
    row['format'] !== 'ia.projection-catalog.v1' ||
    !['ia.host.claude-prose.v1', CODEX_PROSE_PROFILE].includes(pin['id'] as string) ||
    pin['version'] !== 1
  )
    inputFailure('Unknown projection catalog');
  const create = pin['id'] === CODEX_PROSE_PROFILE ? codexProseCatalog : claudeProseCatalog;
  return create(hash(pin['implementationDigest']), {
    models: value.models,
    tools: value.tools,
    inputFields: value.inputFields,
  });
}
export function codexProseCatalog(
  implementationDigest: string,
  selections: Pick<ProjectionCatalog, 'models' | 'tools' | 'inputFields'> = {
    models: [{ id: 'inherit', name: 'inherit' }],
    tools: [
      { id: 'read', name: 'read' },
      { id: 'glob', name: 'glob' },
      { id: 'grep', name: 'grep' },
    ],
    inputFields: [],
  },
): ProjectionCatalog {
  return proseCatalog(CODEX_PROSE_PROFILE, implementationDigest, selections);
}
export const isCodex = (catalog: ProjectionCatalog): boolean => catalog.profile.id === CODEX_PROSE_PROFILE;
export function outputPath(
  product: 'workspace' | 'plugin',
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
): string {
  if (isCodex(catalog)) return codexOutputPath(product, entry);
  const prefix = product === 'workspace' ? '.claude/' : '';
  return (
    prefix +
    (entry.presentation.kind === 'agent'
      ? `agents/${entry.outputName}.md`
      : entry.presentation.kind === 'command'
        ? `commands/${entry.outputName}.md`
        : `skills/${entry.outputName}/SKILL.md`)
  );
}
export function checkFeatures(
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
  product: 'workspace' | 'plugin',
): void {
  const unavailable = (message: string): never => fail('IA-PROJECTION-FEATURE-UNAVAILABLE', message, entry.target);
  if (
    isCodex(catalog) &&
    (!entry.description.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.description))
  )
    inputFailure('Codex exports require a nonempty, printable description');
  if (entry.binding) unavailable('Executable binding projection is unavailable in the prose profile');
  const features: readonly string[] = isCodex(catalog)
    ? [
        ...CODEX_PROSE_FEATURES.filter((f) => f !== 'agent-role-skills' || product === 'plugin'),
        ...(product === 'workspace' ? ['native-agents'] : []),
      ]
    : CLAUDE_PROSE_FEATURES;
  for (const requirement of entry.requirements)
    if (requirement.minimumEvidence !== 'generated' || !features.includes(requirement.feature))
      unavailable('Required feature/evidence is unavailable in the prose profile');
  const p = entry.presentation;
  if (p.kind === 'agent') {
    if (
      isCodex(catalog) &&
      product === 'workspace' &&
      [
        'enabled',
        'max_threads',
        'max_concurrent_threads_per_session',
        'default_subagent_model',
        'default_subagent_reasoning_effort',
        'interrupt_message',
        'max_depth',
        'job_max_runtime_seconds',
      ].includes(entry.outputName)
    )
      inputFailure('Codex agent name conflicts with a reserved configuration key');
    if (!catalog.models.some((m) => m.id === p.model) || p.tools.some((t) => !catalog.tools.some((v) => v.id === t)))
      unavailable('Model or tool metadata is absent from the host catalog');
    if (!p.tools.length || p.delegates.length)
      unavailable('Empty tool sets and delegated-agent restrictions are not qualified by this profile');
    if (isCodex(catalog) && product === 'plugin' && catalog.models.find((m) => m.id === p.model)!.name !== 'inherit')
      unavailable('Codex plugin role skills inherit the host model; model overrides require a workspace agent');
  } else {
    if (
      p.arguments.some(
        (a) => a.type !== 'text' || !catalog.inputFields.some((f) => f.name === a.target && f.type === a.type),
      )
    )
      unavailable('Typed argument mapping is unavailable in the host catalog');
    if (p.kind === 'skill' && p.patterns.some((pattern) => pattern.kind !== 'prompt-literal'))
      unavailable('This profile supports prompt-literal guidance only');
  }
}
export function inert(text: string): void {
  if (/!\s*`/.test(text))
    fail('IA-PROJECTION-FEATURE-UNAVAILABLE', 'Executable dynamic context is unsupported in inert prose');
  for (const { line, literal } of markdownLines(text))
    if (!literal)
      for (const part of inlineParts(line)) {
        if (!part.code && /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*|\/?)>/.test(part.text))
          fail('IA-PROJECTION-FEATURE-UNAVAILABLE', 'Active HTML is unsupported in inert prose');
      }
}
export function nativeValue(value: CompiledValue): string {
  if ('text' in value) return value.text;
  if (value.kind === 'ref') return `@${value.discriminator} ${value.name}${value.fragment ? '#' + value.fragment : ''}`;
  return value.kind === 'list' ? value.items.map(nativeValue).join(', ') : '';
}
function childText(child: CompiledChild, depth = 0): string {
  if (depth > 64) inputFailure('Native field nesting exceeds projection depth');
  if ('item' in child) return '- ' + nativeValue(child.item);
  const conditions = [
    ...(child.when ? [child.when.join(' ')] : []),
    ...(child.fields ?? []).flatMap((c) => ('key' in c && c.key === 'when' ? [nativeValue(c.value)] : [])),
  ];
  const children = (child.fields ?? []).filter((c) => !('key' in c) || c.key !== 'when');
  return (
    `${child.key}${conditions.length ? ' (when ' + conditions.join(' and ') + ')' : ''}: ${nativeValue(child.value)}` +
    (children.length ? '\n' + children.map((c) => '  '.repeat(depth + 1) + childText(c, depth + 1)).join('\n') : '')
  );
}
export function renderRecord(record: CompiledRecord, owner: ResourceOccurrence): string {
  const citation = `${owner.source}@${owner.revision}:${owner.path}:${owner.line}`;
  const sections = record.sections
    .map((s) => {
      const body =
        s.name === 'cognition'
          ? record.cells
              .map(
                (c) =>
                  `${c.phase}/${c.primitive}${c.primary ? ' (primary)' : ''}${c.condition ? ' (when ' + c.condition.map((t) => `${t.axis} is ${t.value}`).join(' and ') + ')' : ''}: ${c.text}`,
              )
              .join('\n\n')
          : s.fields.map((child) => childText(child)).join('\n\n');
      return `### ${s.name}\n\n${body}`;
    })
    .join('\n\n');
  // Render admitted structured fields, retaining authored phase blocks and conditions.
  const output = `## @${record.discriminator} ${record.name}\n\nSource: ${citation}\n\n${sections}`;
  inert(output);
  return output;
}
export function resourceDestination(digest: string, file: ResourceFile): string {
  return `resources/${digest}/${file.key.source}/${file.key.revision}/${file.key.path}`;
}
const link = (from: string, target: string): string =>
  posix
    .relative(posix.dirname(from), target)
    .split('/')
    .map((s) => (s === '..' ? s : encodeURIComponent(s)))
    .join('/');
export function discoveryLink(from: string, target: string, label: string): string {
  return `[${label.replace(/[\[\]\\]/g, '\\$&')}](<${link(from, target)}>)`;
}

function inlineParts(line: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [],
    ticks = /`+/g;
  let cursor = 0,
    match: RegExpExecArray | null;
  while ((match = ticks.exec(line))) {
    const preceding = /\\+$/.exec(line.slice(0, match.index))?.[0].length ?? 0;
    if (preceding % 2) continue;
    const start = match.index,
      length = match[0].length;
    let closing: RegExpExecArray | null;
    do {
      closing = ticks.exec(line);
    } while (closing && closing[0].length !== length);
    if (!closing) fail('IA-RESOURCE-INVALID', 'Use balanced single-line code spans or fenced code blocks');
    parts.push(
      { text: line.slice(cursor, start), code: false },
      { text: line.slice(start, ticks.lastIndex), code: true },
    );
    cursor = ticks.lastIndex;
  }
  parts.push({ text: line.slice(cursor), code: false });
  return parts;
}

function markdownLines(content: string): { line: string; literal: boolean }[] {
  let fence: { character: string; length: number } | undefined;
  const rows = content.split(/(?<=\n)/).map((line) => {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line),
      marker = opening?.[1];
    if (marker) {
      if (fence) {
        if (marker[0] === fence.character && marker.length >= fence.length && !opening![2]!.trim()) fence = undefined;
        return { line, literal: true };
      }
      if (marker[0] !== '`' || !opening![2]!.includes('`')) {
        fence = { character: marker[0]!, length: marker.length };
        return { line, literal: true };
      }
    }
    return { line, literal: fence !== undefined };
  });
  if (fence) fail('IA-RESOURCE-INVALID', 'Fenced code examples must be closed');
  return rows;
}

/** Restricted Markdown linking: no lookup beyond the selected captured file set. */
export function resourceMarkdown(
  content: string,
  file: Pick<ResourceFile, 'key'>,
  output: string,
  destinations: ReadonlyMap<string, string>,
  rewrite: boolean,
): string {
  inert(content);
  return markdownLines(content)
    .map(({ line, literal }) => {
      if (literal) return line;
      const target = (raw: string, image: boolean): string => {
        if (image)
          fail('IA-PROJECTION-FEATURE-UNAVAILABLE', 'Image embedding is unsupported; use inert resource links');
        const ownDestination = destinations.get(`${file.key.source}@${file.key.revision}:${file.key.path}`);
        if (raw.startsWith('#')) return rewrite && ownDestination ? link(output, ownDestination) + raw : raw;
        if (/^(?:https?:|mailto:)/i.test(raw)) return raw;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(raw) || /[()<>\\]/.test(raw))
          fail('IA-RESOURCE-INVALID', 'Unsupported resource link target');
        let decoded: string;
        try {
          decoded = decodeURIComponent(raw);
        } catch {
          fail('IA-RESOURCE-INVALID', 'Malformed resource link encoding');
        }
        const [path, fragment] = decoded.split('#');
        const relative = posix.normalize(posix.join(posix.dirname(file.key.path), path!));
        const destination = destinations.get(`${file.key.source}@${file.key.revision}:${relative}`);
        if (!destination || relative.startsWith('../') || (image && relative.toLowerCase().endsWith('.svg')))
          fail('IA-RESOURCE-INVALID', 'Local resource link is outside the selected inert inventory');
        return rewrite ? link(output, destination) + (fragment ? '#' + encodeURIComponent(fragment) : '') : raw;
      };
      // Inline code is literal and is not interpreted as a Markdown link.
      return inlineParts(line)
        .map(({ text: part, code }) => {
          if (code) return part;
          if (/!\[[^\]\n]*\]/.test(part))
            fail('IA-PROJECTION-FEATURE-UNAVAILABLE', 'Image embedding is unsupported; use inert resource links');
          if (rewrite && (/^\s{0,3}\[[^\]\n]+\]:/.test(part) || /\[[^\]\n]*\]\[[^\]\n]*\]/.test(part)))
            fail(
              'IA-RESOURCE-INVALID',
              'Inline resource bodies require inline links instead of shared reference definitions',
            );
          let replaced = part.replace(
            /(!?\[[^\]\n]*\])\((?:<([^>\n]+)>|([^\s()]+))(\s+"[^"\n]*")?\)/g,
            (_match, label: string, angle: string | undefined, plain: string | undefined, title: string | undefined) =>
              `${label}(<${target(angle ?? plain!, label.startsWith('!'))}>${title ?? ''})`,
          );
          replaced = replaced.replace(
            /^(\s{0,3}\[[^\]\n]+\]:\s*)(?:<([^>\n]+)>|(\S+))/,
            (_match, prefix: string, angle: string | undefined, plain: string | undefined) =>
              `${prefix}<${target(angle ?? plain!, false)}>`,
          );
          // Nested link labels/parentheses are outside this serializer's Markdown subset.
          if (/\]\((?!<[^>\n]+>\))/.test(replaced.replace(/\]\(<[^>\n]+>(?:\s+"[^"\n]*")?\)/g, '')))
            fail('IA-RESOURCE-INVALID', 'Unsupported ambiguous Markdown link');
          return rewrite ? replaced : part;
        })
        .join('');
    })
    .join('');
}

export function frontmatter(entry: ProjectionExport, catalog: ProjectionCatalog): string {
  const p = entry.presentation,
    rows = [`name: ${entry.outputName}`, `description: ${JSON.stringify(entry.description)}`];
  if (p.kind === 'agent')
    rows.push(
      `model: ${catalog.models.find((m) => m.id === p.model)!.name}`,
      `tools: ${JSON.stringify(p.tools.map((t) => catalog.tools.find((v) => v.id === t)!.name).join(', '))}`,
    );
  else {
    if (p.kind === 'command') rows.push('disable-model-invocation: true');
    if (p.arguments.length)
      rows.push(`argument-hint: ${JSON.stringify(p.arguments.map((a) => '[' + a.name + ']').join(' '))}`);
  }
  return '---\n' + rows.join('\n') + '\n---\n';
}
export function invocation(
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
  product: 'workspace' | 'plugin',
): string {
  if (isCodex(catalog)) return codexInvocation(entry, catalog, product);
  const p = entry.presentation;
  if (p.kind === 'agent') return '';
  const args = p.arguments
    .map((a, index) => `- ${a.target} (${a.required ? 'required' : 'optional'} text): $ARGUMENTS[${index}]`)
    .join('\n');
  const patterns =
    p.kind === 'skill'
      ? [...p.patterns]
          .sort((a, b) => b.priority - a.priority)
          .map((p) => `- ${p.value}`)
          .join('\n')
      : '';
  const result =
    (args ? '\n## Input guidance\n\n' + args + '\n' : '') +
    (patterns ? '\n## When to invoke\n\n' + patterns + '\n' : '');
  inert(result);
  return result;
}

export function serializeExport(
  product: 'workspace' | 'plugin',
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
  body: string,
): readonly SerializedExport[] {
  if (isCodex(catalog)) return serializeCodexExport(product, entry, catalog, body);
  return [
    {
      path: outputPath(product, entry, catalog),
      content: frontmatter(entry, catalog) + body,
      role: entry.presentation.kind,
    },
  ];
}
export function pluginFile(catalog: ProjectionCatalog, name: string, version: string): SerializedExport {
  return {
    path: isCodex(catalog) ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json',
    role: 'plugin',
    content:
      JSON.stringify(
        {
          name,
          version,
          description: 'Generated native prose projections.',
          ...(isCodex(catalog) ? { skills: './skills/' } : {}),
        },
        null,
        2,
      ) + '\n',
  };
}
