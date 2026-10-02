import type { ProjectionExport, ProjectionOutput } from './projection-format.js';
import type { ProjectionCatalog } from './projection-host.js';

export const CODEX_PROSE_PROFILE = 'ia.host.codex-prose.v1';
export const CODEX_PROSE_FEATURES = Object.freeze([
  'agents',
  'skills',
  'commands',
  'text-arguments',
  'prompt-literal-guidance',
  'resources',
  'conditional-guidance',
  'agent-role-skills',
]);
export interface SerializedExport {
  readonly path: string;
  readonly content: string;
  readonly role: ProjectionOutput['role'];
}

export function codexOutputPath(product: 'workspace' | 'plugin', entry: ProjectionExport): string {
  if (product === 'workspace' && entry.presentation.kind === 'agent') return `.codex/agents/${entry.outputName}.toml`;
  return `${product === 'workspace' ? '.agents/' : ''}skills/${entry.outputName}/SKILL.md`;
}

/** JSON basic-string escapes are TOML-compatible after escaping DEL. */
const toml = (value: string): string => JSON.stringify(value).replaceAll('\u007f', '\\u007f');

export function codexInvocation(
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
  product: 'workspace' | 'plugin',
): string {
  const p = entry.presentation;
  if (p.kind === 'agent') {
    const role =
      product === 'plugin'
        ? '\n## Role skill\n\nOn explicit invocation, apply the following native agent instructions as this role in the current conversation. This skill does not register or spawn a custom Codex agent.\n'
        : '';
    return (
      role +
      '\n## Tool intent\n\nRequested tool capabilities: ' +
      p.tools.map((t) => catalog.tools.find((v) => v.id === t)!.name).join(', ') +
      '. These names describe intent, not a Codex tool allowlist. Actual tools and permissions remain controlled by the host.\n'
    );
  }
  const args = p.arguments
    .map((a, index) => `- Input ${index + 1}: ${a.name} -> ${a.target} (${a.required ? 'required' : 'optional'} text).`)
    .join('\n');
  const patterns =
    p.kind === 'skill'
      ? [...p.patterns]
          .sort((a, b) => b.priority - a.priority)
          .map((pattern) => `- ${pattern.value}`)
          .join('\n')
      : '';
  return (
    (args
      ? "\n## Input guidance\n\nRead these text inputs from the user's explicit skill invocation message; ask for missing required values. These instructions do not perform positional macro substitution or machine validation.\n\n" +
        args +
        '\n'
      : '') + (patterns ? '\n## When to invoke\n\n' + patterns + '\n' : '')
  );
}

export function serializeCodexExport(
  product: 'workspace' | 'plugin',
  entry: ProjectionExport,
  catalog: ProjectionCatalog,
  body: string,
): readonly SerializedExport[] {
  const path = codexOutputPath(product, entry),
    p = entry.presentation;
  if (product === 'workspace' && p.kind === 'agent') {
    const model = catalog.models.find((m) => m.id === p.model)!.name;
    const content =
      `name = ${toml(entry.outputName)}\ndescription = ${toml(entry.description)}\n` +
      (model === 'inherit' ? '' : `model = ${toml(model)}\n`) +
      `developer_instructions = ${toml(body)}\n`;
    return [{ path, content, role: 'agent' }];
  }
  const content = `---\nname: ${entry.outputName}\ndescription: ${JSON.stringify(entry.description)}\n---\n` + body;
  const policy = `interface:\n  display_name: ${JSON.stringify(entry.outputName)}\n  short_description: ${JSON.stringify(entry.description)}\npolicy:\n  allow_implicit_invocation: ${p.kind === 'skill'}\n`;
  return [
    { path, content, role: p.kind },
    { path: path.replace(/SKILL\.md$/, 'agents/openai.yaml'), content: policy, role: 'host-metadata' },
  ];
}

/** Explicit registrations support hosts that load roles through config.toml. */
export function codexAgentRegistration(entries: readonly ProjectionExport[]): SerializedExport | undefined {
  const agents = entries.filter((e) => e.presentation.kind === 'agent');
  if (!agents.length) return undefined;
  return {
    path: '.codex/config.toml',
    role: 'host-metadata',
    content: agents
      .map(
        (e) =>
          `[agents.${toml(e.outputName)}]\ndescription = ${toml(e.description)}\nconfig_file = ${toml('agents/' + e.outputName + '.toml')}\n`,
      )
      .join('\n'),
  };
}
