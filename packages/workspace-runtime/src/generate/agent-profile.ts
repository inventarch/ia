import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import { governingMandates, PACKET_MARKER, RuntimeError } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import {
  antigravityProseCatalog,
  claudeProseCatalog,
  geminiProseCatalog,
  nativeValue,
  PROSE_EFFECT_TOOLS,
  yamlFlowTools,
} from '../projection-host.js';
import { frozen } from '../resource-format.js';
import {
  authoredOf,
  capabilityClosure,
  closureRefusal,
  code,
  fieldsOf,
  inline,
  knownHost,
  list,
  perRecord,
  prose,
  safeName,
  section,
  stated,
  textsAt,
  valuesAt,
} from './format.js';
import type { GeneratedSet } from './format.js';

/**
 * Generation of host agent files from authored `@agent-profile` records. Each band-100 profile in the scope renders one
 * claude agent file, `.claude/agents/<profile name>.md`: YAML frontmatter naming the profile, describing it and listing
 * the host tools its capabilities allow, the packet's marker on its own line, then the profile's mandate bounds, voice,
 * tools and delegates, read from the records the profile's own fields reference. The Tools section lists the profile's
 * capabilities and every one they include (`composition.includes`); the frontmatter's tools are the profile's own
 * capabilities' effects, which the composition compiler holds as the ceiling of what each includes.
 *
 * A profile is not rendered, and is reported as an unsupported row naming it and the reason, when its name is not a
 * portable host name, when its capabilities allow no host tool (claude reads an agent with no tool list as one given
 * every tool, so only a file left unwritten grants nothing), when the compiler would refuse its capability closure (an
 * inclusion cycle, or an included capability with effects its includer does not declare), or when its text, an authored
 * value's own or as rendered, is not inert prose. Codex renders none and reports each: a codex agent needs an entry in
 * `.codex/config.toml`, which holds the owned MCP block. A profile below band 100, an installed or adopted base,
 * renders nothing, and no system steward does, a steward being an `@agent`; a workspace that authors public systems, as
 * this repository does, renders their profiles. The bytes are a function of the scope's records alone: no absolute
 * path, time or scope token is written.
 *
 * The mandate bounds are the profile's own `composition.mandate`. A profile that names none falls back to the authored
 * mandates the runtime's mandate resolver (`governingMandates`) says bind its `composition.agent`: the agent a subagent
 * acts as for edits the guard selects, so the file states what the guard enforces; CLI commands independently choose a
 * workspace participant or steward. A participant-less mandate that states neither scope nor covers locates nowhere
 * and is left out. The fallback is resolved only for a rendered profile that needs it, and a mandate the resolver
 * cannot read makes it unavailable, which the file says, never failing the render. A profile's own mandate that names
 * another participant is rendered with a line saying the guard does not judge this agent by it.
 *
 * Nothing here applies these files: `generateHostSet` hands them to the one projection writer.
 */

/**
 * The claude host's tool names by tool id, the prose catalog's default selections. The generated files carry no profile
 * pin, so the implementation digest the catalog requires is a placeholder that no file names.
 */
const CATALOG_TOOLS: Readonly<Record<Exclude<PacketHost, 'codex'>, ReadonlyMap<string, string>>> = {
  claude: new Map(claudeProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name])),
  gemini: new Map(geminiProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name])),
  antigravity: new Map(antigravityProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name])),
};
const AGENT_DIRS: Readonly<Record<Exclude<PacketHost, 'codex'>, string>> = {
  claude: '.claude/agents',
  gemini: '.gemini/agents',
  antigravity: '.agents/agents',
};
/**
 * The host names of the tools `effects` cover through the prose profiles' table, in first-stated order, each
 * once. The same table is the ceiling `compileProjection` holds an agent's tools to.
 */
const hostTools = (host: Exclude<PacketHost, 'codex'>, effects: readonly string[]): readonly string[] => {
  const table = CATALOG_TOOLS[host];
  return [
    ...new Set(effects.flatMap((effect) => PROSE_EFFECT_TOOLS.get(effect) ?? []).map((id) => table.get(id) ?? id)),
  ];
};
const CODEX =
  'Codex agents are unsupported: a codex agent needs an entry in .codex/config.toml, which holds the owned MCP block';

/**
 * The agent files of the authored `@agent-profile` records the scope token `within` admits, by identity, and an
 * unsupported row for each one not rendered (see above); for codex, a row for each. An unknown host is
 * IA-PROJECTION-INPUT-INVALID, and for either host an unknown or stale token keeps its database code.
 */
export function generateAgentProfiles(reader: ReadHandle, within: string, host: PacketHost): GeneratedSet {
  knownHost(host);
  // The token is read before the codex answer, so codex refuses a token claude would refuse.
  const records = reader.records({ within }),
    profiles = authoredOf(records, 'agent-profile');
  if (host === 'codex')
    return frozen({
      files: [],
      unsupported: profiles.map((profile) => ({
        identity: profile.identity,
        word: 'agent-profile' as const,
        reason: CODEX,
      })),
    });
  const nodes = new Map(records.map((node) => [node.identity, node]));
  /** The admitted record a reference resolves to in the scope, or undefined. */
  const target = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodes.get(resolved.identity) : undefined;
  };
  /** A reference printed as the identity it resolves to, or as authored when none admitted answers it. */
  const named = (value: CompiledValue): string => code(target(value)?.identity ?? nativeValue(value));
  /** The fallback for a profile naming no mandate: the authored mandates that bind `agent`, or why there are none. */
  const fallback = (agent: Node | undefined): readonly string[] => {
    const intro = 'This profile names no mandate.';
    if (agent?.discriminator !== 'agent')
      return [`${intro} Fallback unavailable: its composition.agent is not an admitted @agent in this scope.`];
    try {
      // A mandate that names no participant and neither scope nor covers locates nowhere, so it governs no path the
      // agent edits: it is left out.
      const binding = governingMandates(reader, within, { actor: agent.identity }).filter(
        (mandate) =>
          mandate.binds !== false &&
          (mandate.participant !== undefined || mandate.scope.length > 0 || (mandate.covers ?? []).length > 0),
      );
      if (binding.length === 0)
        return [
          `${intro} Fallback: no authored mandate binds its agent ${code(agent.identity)}; wherever a mandate governs, the edit guard refuses it.`,
        ];
      return [
        `${intro} Fallback: the authored mandates that bind its agent ${code(agent.identity)}, each with where it governs; the edit guard judges the agent by these, and refuses it where a mandate that binds another participant governs and none of these grants the move.`,
        '',
        ...binding.flatMap((mandate) => mandateLines(nodes.get(mandate.identity)!, named)),
      ];
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      return [`${intro} Fallback unavailable: ${inline(error.message)}`];
    }
  };
  return perRecord('agent-profile', profiles, (profile) => {
    const path = `${AGENT_DIRS[host]}/${safeName(profile.name)}.md`,
      roots = valuesAt(profile, 'composition.capabilities'),
      capabilities = capabilityClosure(roots, target),
      refused = closureRefusal(roots, target);
    // A closure the composition compiler refuses is reported; otherwise each capability's own effects are the ceiling of
    // what it includes, so the profile's capabilities' own effects are its tools.
    if (refused !== undefined)
      inputFailure(`${profile.identity} renders no agent: ${refused}, which the composition compiler refuses`);
    const tools = hostTools(
      host,
      roots.flatMap((capability) => {
        const node = target(capability);
        return node?.discriminator === 'capability' ? textsAt(node, 'execution.effects') : [];
      }),
    );
    if (tools.length === 0)
      inputFailure(
        `${profile.identity} renders no agent: its capabilities allow no host tool, and claude gives an agent with no tool list every tool`,
      );
    return {
      path,
      text: agentFile(host, profile, tools, roots, capabilities, target, named, fallback),
      identity: profile.identity,
      word: 'agent-profile' as const,
    };
  });
}

function agentFile(
  host: Exclude<PacketHost, 'codex'>,
  profile: Node,
  tools: readonly string[],
  roots: readonly CompiledValue[],
  capabilities: readonly Node[],
  target: (value: CompiledValue) => Node | undefined,
  named: (value: CompiledValue) => string,
  fallback: (agent: Node | undefined) => readonly string[],
): string {
  const agent = valuesAt(profile, 'composition.agent')[0],
    agentNode = agent === undefined ? undefined : target(agent),
    says = textsAt(profile, 'meaning.says')[0];
  // The description is the agent's own only when the workspace authors that agent: an installed or adopted base's text
  // never decides when claude delegates to an authored profile.
  const description =
    (agentNode !== undefined && agentNode.band === 100 ? textsAt(agentNode, 'meaning.says')[0] : undefined) ??
    says ??
    '';
  // Every frontmatter value is JSON-quoted on Claude, so a name YAML reads as a keyword (`true`, `null`) stays a string;
  // Gemini and Antigravity emit YAML array `tools`, and Antigravity marks subagent frontmatter without model/color.
  const frontmatterRows =
    host === 'antigravity'
      ? [
          `name: ${JSON.stringify(profile.name)}`,
          `description: ${JSON.stringify(inline(description))}`,
          'subagent: true',
          'mainAgent: false',
          `tools: ${yamlFlowTools(tools)}`,
        ]
      : host === 'gemini'
        ? [
            `name: ${JSON.stringify(profile.name)}`,
            `description: ${JSON.stringify(inline(description))}`,
            `tools: ${yamlFlowTools(tools)}`,
          ]
        : [
            `name: ${JSON.stringify(profile.name)}`,
            `description: ${JSON.stringify(inline(description))}`,
            `tools: ${JSON.stringify(tools.join(', '))}`,
          ];
  const out = [
    '---',
    ...frontmatterRows,
    '---',
    '',
    PACKET_MARKER,
    '',
    `# ${profile.name}`,
    ...(says === undefined ? [] : ['', prose(says)]),
    '',
    `- profile ${code(profile.identity)}`,
    ...(agent === undefined
      ? []
      : [`- agent ${named(agent)}${agentNode === undefined ? ': not admitted in this scope' : ''}`]),
    '',
    "CLI commands choose an authored workspace participant or steward. Omitting --actor uses the workspace's default actor; it does not select this profile's agent.",
  ];

  // The mandate bounds: the authority and limits of the mandate the profile itself names, else the resolver's fallback.
  const mandate = valuesAt(profile, 'composition.mandate')[0],
    mandateNode = mandate === undefined ? undefined : target(mandate);
  out.push(
    ...section(
      'Mandate',
      mandate === undefined
        ? fallback(agentNode)
        : mandateNode === undefined
          ? [`- ${named(mandate)}: not admitted in this scope`]
          : [...mandateLines(mandateNode, named), ...otherParticipant(mandateNode, agentNode, target)],
    ),
  );

  const voice = valuesAt(profile, 'composition.voice')[0];
  if (voice !== undefined) {
    const voiceNode = target(voice);
    out.push(
      ...section('Voice', [
        `- ${named(voice)}${voiceNode === undefined ? ': not admitted in this scope' : ''}`,
        ...(voiceNode === undefined
          ? []
          : fieldsOf(voiceNode, 'communication').map((f) => `- ${f.key}: ${prose(nativeValue(f.value))}`)),
      ]),
    );
  }

  // The tools: each capability's operations, and the host tools its effects cover through the prose profiles' table,
  // for the profile's capabilities and every one they include. A reference no admitted capability answers is named.
  out.push(
    ...section('Tools', [
      ...roots.flatMap((capability) =>
        target(capability)?.discriminator === 'capability'
          ? []
          : [`- ${named(capability)}: not admitted in this scope`],
      ),
      ...capabilities.map((node) => {
        const effects = textsAt(node, 'execution.effects');
        return `- ${code(node.identity)}: operations ${list(valuesAt(node, 'composition.operations').map(named))}; effects ${list(effects.map(inline))}; host tools ${list(hostTools(host, effects))}`;
      }),
    ]),
  );

  const delegates = valuesAt(profile, 'composition.delegates');
  if (delegates.length > 0)
    out.push(
      ...section(
        'Delegates',
        delegates.map((delegate) => `- ${named(delegate)}`),
      ),
    );
  return `${out.join('\n')}\n`;
}

/**
 * A mandate as one list item, its identity, with each authority field and `execution.limit-*` it states, as authored,
 * nested beneath it, so several mandates read apart.
 */
function mandateLines(mandate: Node, named: (value: CompiledValue) => string): readonly string[] {
  const fields: string[] = [];
  const participant = valuesAt(mandate, 'authority.participant');
  if (participant.length > 0) fields.push(`participant ${list(participant.map(named))}`);
  if (stated(mandate, 'authority.moves')) fields.push(`moves ${list(textsAt(mandate, 'authority.moves').map(inline))}`);
  if (stated(mandate, 'authority.scope')) fields.push(`scope ${list(valuesAt(mandate, 'authority.scope').map(named))}`);
  if (stated(mandate, 'authority.words')) fields.push(`words ${list(textsAt(mandate, 'authority.words').map(inline))}`);
  if (stated(mandate, 'authority.excluded-words'))
    fields.push(`excluded words ${list(textsAt(mandate, 'authority.excluded-words').map(inline))}`);
  if (stated(mandate, 'authority.covers'))
    fields.push(`covers ${list(textsAt(mandate, 'authority.covers').map(code))}`);
  for (const field of fieldsOf(mandate, 'execution'))
    if (field.key.startsWith('limit-')) fields.push(`${field.key} ${prose(nativeValue(field.value))}`);
  return [`- ${code(mandate.identity)}`, ...fields.map((line) => `  - ${line}`)];
}

/**
 * The profile's own mandate names another participant than the profile's agent: its bounds are rendered as authored,
 * and a nested line says the edit guard does not judge this agent by it.
 */
function otherParticipant(
  mandate: Node,
  agent: Node | undefined,
  target: (value: CompiledValue) => Node | undefined,
): readonly string[] {
  const participant = valuesAt(mandate, 'authority.participant')[0],
    bound = participant === undefined ? undefined : target(participant);
  if (bound === undefined || agent === undefined || bound.identity === agent.identity) return [];
  return [
    `  - binds ${code(bound.identity)}, not this profile's agent ${code(agent.identity)}: the edit guard judges the agent by the mandates that bind it`,
  ];
}
