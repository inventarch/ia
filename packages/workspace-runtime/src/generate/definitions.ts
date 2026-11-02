import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import type {
  HarnessDefinition,
  HostHookDeclaration,
  OperationDefinition,
  PacketDefinition,
  PacketHost,
} from '@inventarch/runtime';
import { frozen } from '../resource-format.js';
import { authoredOf, capabilityClosure, closureRefusal, knownHost, textsAt, valuesAt } from './format.js';
import type { GeneratedFile, UnsupportedRecord } from './format.js';
import { generateAgentProfiles } from './agent-profile.js';
import { generateCapabilitySkills } from './capability.js';
import { generateHookSet } from './hook.js';

/**
 * Everything a host generates from the workspace's authored records, computed once: the agent and skill files, the
 * hook declarations it registers, a row for each authored record it does not render or register, and the operation and
 * harness definitions, whose harness registration sets select only from these files and hooks. The projection writer
 * applies exactly this set, and its receipt lists each harness's registrations as that apply left them (a hook it
 * registered no group for is not listed).
 */
export interface HostSet {
  /** The generated agent files, then the skills, each group by identity. */
  readonly files: readonly GeneratedFile[];
  readonly hooks: readonly HostHookDeclaration[];
  /** The agent profiles, then the capabilities, then the hooks not rendered or registered, each with the reason. */
  readonly unsupported: readonly UnsupportedRecord[];
  readonly definitions: readonly PacketDefinition[];
}
/**
 * The host set for `host` through the scope token `within` (see `HostSet`): one skill per invocable `@capability`
 * (decision `generated-skill-unit`), never one per `@playbook`.
 */
export function generateHostSet(reader: ReadHandle, within: string, host: PacketHost): HostSet {
  knownHost(host);
  const agents = generateAgentProfiles(reader, within, host),
    skills = generateCapabilitySkills(reader, within, host),
    hooks = generateHookSet(reader, within, host);
  return frozen({
    files: [...agents.files, ...skills.files],
    hooks: hooks.hooks,
    unsupported: [...agents.unsupported, ...skills.unsupported, ...hooks.unsupported],
    definitions: definitionsOf(reader, within, [...agents.files, ...skills.files], hooks.hooks),
  });
}

/**
 * Definitions of authored `@operation` and `@harness` records, for the receipt's `definitions` section:
 * `generateHostSet`'s.
 */
export function generateDefinitions(reader: ReadHandle, within: string, host: PacketHost): readonly PacketDefinition[] {
  return generateHostSet(reader, within, host).definitions;
}

/**
 * An operation's `execution.handler`, `input` and `output` are catalog keys an installed implementation answers, copied
 * as authored: nothing here imports, resolves, serves or executes them. A harness lists the registration set its
 * profiles and bindings select among `files` and `hooks`: the agent files rendered for its profiles, the skills
 * rendered for their capabilities and every capability those include, and the registered hooks its
 * bindings target. A record that renders or registers nothing for the host (an unsupported one, or any agent or hook
 * for codex) selects nothing, so hook or agent support never fails the definitions. Only authored (band 100) records
 * are defined.
 */
function definitionsOf(
  reader: ReadHandle,
  within: string,
  files: readonly GeneratedFile[],
  hooks: readonly HostHookDeclaration[],
): readonly PacketDefinition[] {
  const records = reader.records({ within }),
    nodes = new Map(records.map((node) => [node.identity, node]));
  const targets = (node: Node, field: string): readonly string[] =>
    reader
      .directedView(node.identity, { within })
      .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.field === field)
      .map((row) => row.counterpart);
  const target = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodes.get(resolved.identity) : undefined;
  };
  const agents = files.filter((file) => file.word === 'agent-profile'),
    skills = files.filter((file) => file.word === 'capability');
  const first = (node: Node, field: string): string | undefined => textsAt(node, field)[0];
  const operation = (node: Node): PacketDefinition => {
    const handler = first(node, 'execution.handler'),
      input = first(node, 'execution.input'),
      output = first(node, 'execution.output');
    const definition: OperationDefinition = {
      name: node.name,
      description: first(node, 'meaning.says') ?? '',
      ...(handler === undefined ? {} : { handler }),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      effects: textsAt(node, 'execution.effects'),
    };
    return { identity: node.identity, word: 'operation', definition };
  };
  const harness = (node: Node): PacketDefinition => {
    const profiles = targets(node, 'composition.profiles'),
      bindings = targets(node, 'composition.bindings'),
      workspace = targets(node, 'composition.workspace')[0],
      hostProfile = first(node, 'execution.host-profile');
    const selected = new Set(profiles);
    for (const id of profiles) {
      const profile = nodes.get(id);
      if (profile === undefined) continue;
      // A closure the composition compiler refuses selects nothing.
      const roots = valuesAt(profile, 'composition.capabilities');
      if (closureRefusal(roots, target) !== undefined) continue;
      for (const capability of capabilityClosure(roots, target)) selected.add(capability.identity);
    }
    for (const id of bindings) {
      const binding = nodes.get(id);
      if (binding !== undefined) for (const bound of targets(binding, 'binding.target')) selected.add(bound);
    }
    const definition: HarnessDefinition = {
      name: node.name,
      description: first(node, 'meaning.says') ?? '',
      ...(workspace === undefined ? {} : { workspace }),
      ...(hostProfile === undefined ? {} : { hostProfile }),
      profiles,
      bindings,
      registrations: {
        agents: agents.filter((file) => selected.has(file.identity)).map(({ identity, path }) => ({ identity, path })),
        skills: skills.filter((file) => selected.has(file.identity)).map(({ identity, path }) => ({ identity, path })),
        hooks: hooks.filter((hook) => selected.has(hook.identity)),
      },
    };
    return { identity: node.identity, word: 'harness', definition };
  };
  return frozen([...authoredOf(records, 'operation').map(operation), ...authoredOf(records, 'harness').map(harness)]);
}
