import type { CompiledRecord, CompiledValue } from '@inventarch/language';
import { cite, fieldOf, fieldsOf, fieldText, governanceClauses, says, text } from './record-text.js';

/**
 * The installed steward host table (tools/projections/SPEC.md, "Steward composition"). A steward's
 * `@agent-profile` must declare `execution.role` equal to the steward's agent name (compared with the agent record, so
 * the table holds no role value), these `outcomes` and `mandate-contract` ids, and a mandate whose
 * `execution.contract`, when present, equals `mandateContract`.
 * `tools` maps each admitted capability effect to the host tools it grants; any other effect is refused.
 */
export const STEWARD_HOST_TABLE = Object.freeze({
  outcomes: 'steward-outcomes-v1',
  mandateContract: 'steward-authoring-v1',
  tools: Object.freeze({
    read: Object.freeze(['Read', 'Glob', 'Grep']),
    'local-write': Object.freeze(['Write', 'Edit', 'Bash']),
  }) as Readonly<Record<string, readonly string[]>>,
});
/** Tool order in rendered frontmatter; also the full set a steward without a profile receives during the transition. */
export const LEGACY_STEWARD_TOOLS: readonly string[] = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
/**
 * Transition switch (docs/plans/framework-records-baseline/README.md §0.1; tools/projections/SPEC.md P10).
 * Every steward now has a profile, so a steward without one is refused by default. A caller that passes
 * `requireStewardProfiles: false` still renders such a steward from its agent record alone with LEGACY_STEWARD_TOOLS.
 */
export const REQUIRE_STEWARD_PROFILES = true;

export type StewardComposition =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'refused'; readonly message: string }
  | {
      readonly kind: 'profile';
      readonly sources: readonly CompiledRecord[];
      readonly playbooks: readonly CompiledRecord[];
      readonly tools: readonly string[];
      readonly text: string;
    };

class Refusal extends Error {}
const fail = (message: string): never => {
  throw new Refusal(message);
};
/** Resolve one typed reference to exactly one compiled record of the expected discriminator, or refuse. */
function resolve(
  records: readonly CompiledRecord[],
  value: CompiledValue | undefined,
  discriminator: string,
  where: string,
): CompiledRecord {
  if (value?.kind !== 'ref' || value.discriminator !== discriminator || value.fragment !== undefined)
    return fail(`${where}: expected one @${discriminator} reference`);
  const found = records.filter((r) => r.discriminator === discriminator && r.name === value.name);
  return found.length === 1
    ? found[0]!
    : fail(`${where}: @${discriminator} ${value.name} resolves to ${found.length} records`);
}
function refs(value: CompiledValue | undefined): readonly CompiledValue[] {
  return value === undefined ? [] : value.kind === 'list' ? value.items : [value];
}
const scalar = (record: CompiledRecord, section: string, key: string): string | undefined => {
  const field = fieldOf(record, section, key);
  return field === undefined ? undefined : text(field.value);
};
const entries = (list: readonly CompiledRecord[]): string =>
  list.map((r) => `- ${r.name}: ${says(r)} (${r.source.path}:${r.source.line})`).join('\n');

/**
 * Compose one steward from the `@agent-profile` whose `composition.agent` names it. Reads compiled records
 * generically by discriminator and field names; it does not import the composition system's code.
 */
export function composeSteward(
  records: readonly CompiledRecord[],
  agent: CompiledRecord,
  requireProfiles: boolean,
): StewardComposition {
  try {
    return compose(records, agent, requireProfiles);
  } catch (error) {
    if (error instanceof Refusal) return { kind: 'refused', message: error.message };
    throw error;
  }
}
function compose(
  records: readonly CompiledRecord[],
  agent: CompiledRecord,
  requireProfiles: boolean,
): StewardComposition {
  const profiles = records.filter((r) => {
    const target = fieldOf(r, 'composition', 'agent')?.value;
    return (
      r.discriminator === 'agent-profile' &&
      target?.kind === 'ref' &&
      target.discriminator === 'agent' &&
      target.name === agent.name &&
      target.fragment === undefined
    );
  });
  if (profiles.length === 0)
    return requireProfiles ? fail(`Steward ${agent.name} has no @agent-profile`) : { kind: 'legacy' };
  if (profiles.length > 1) fail(`Steward ${agent.name} has ${profiles.length} @agent-profile records; expected one`);
  const profile = profiles[0]!,
    where = `Steward profile ${profile.name}`;
  const role = scalar(profile, 'execution', 'role'),
    outcomes = scalar(profile, 'execution', 'outcomes'),
    contract = scalar(profile, 'execution', 'mandate-contract');
  if (role !== agent.name)
    fail(`${where}: execution.role ${role ?? '(missing)'} must equal the steward name ${agent.name}`);
  if (outcomes !== STEWARD_HOST_TABLE.outcomes)
    fail(
      `${where}: execution.outcomes ${outcomes ?? '(missing)'} is not the installed steward outcomes ${STEWARD_HOST_TABLE.outcomes}`,
    );
  if (contract !== STEWARD_HOST_TABLE.mandateContract)
    fail(
      `${where}: execution.mandate-contract ${contract ?? '(missing)'} is not the installed steward mandate contract ${STEWARD_HOST_TABLE.mandateContract}`,
    );
  if (refs(fieldOf(profile, 'composition', 'delegates')?.value).length > 0)
    fail(`${where}: composition.delegates is not supported for a steward`);

  const mandate = resolve(
    records,
    fieldOf(profile, 'composition', 'mandate')?.value,
    'mandate',
    `${where}: composition.mandate`,
  );
  const mandateContract = scalar(mandate, 'execution', 'contract');
  if (mandateContract !== undefined && mandateContract !== STEWARD_HOST_TABLE.mandateContract)
    fail(
      `Mandate ${mandate.name}: execution.contract ${mandateContract} does not match the steward mandate contract ${STEWARD_HOST_TABLE.mandateContract}`,
    );
  const bounds = governanceClauses(mandate, ['requires']);
  if (!bounds.ok) return fail(`Mandate ${mandate.name}: empty ${bounds.key} clause`);
  if (!bounds.text) fail(`Mandate ${mandate.name} states no governance.requires`);
  const limits = fieldsOf(mandate, 'execution')
    .filter((f) => f.key.startsWith('limit-'))
    .map((f) => `${f.key} ${text(f.value)}`);
  const voiceValue = fieldOf(profile, 'composition', 'voice')?.value;
  const voice =
    voiceValue === undefined ? undefined : resolve(records, voiceValue, 'voice', `${where}: composition.voice`);

  const capabilityRefs = refs(fieldOf(profile, 'composition', 'capabilities')?.value);
  if (capabilityRefs.length === 0) fail(`${where}: composition.capabilities is empty`);
  const effects = new Set<string>(),
    playbooks: CompiledRecord[] = [],
    sources: CompiledRecord[] = [profile, mandate, ...(voice ? [voice] : [])],
    capabilityText: string[] = [];
  for (const value of capabilityRefs) {
    const capability = resolve(records, value, 'capability', `${where}: composition.capabilities`);
    if (refs(fieldOf(capability, 'composition', 'includes')?.value).length > 0)
      fail(`Capability ${capability.name}: composition.includes is not expanded for a steward`);
    const listed = (key: string, discriminator: string): CompiledRecord[] =>
      refs(fieldOf(capability, 'composition', key)?.value).map((item) =>
        resolve(records, item, discriminator, `Capability ${capability.name}: composition.${key}`),
      );
    const operations = listed('operations', 'operation'),
      checks = listed('checks', 'check');
    playbooks.push(...listed('playbooks', 'playbook'));
    sources.push(capability);
    const declared = refs(fieldOf(capability, 'execution', 'effects')?.value).map(text);
    if (declared.length === 0) fail(`Capability ${capability.name}: execution.effects is empty`);
    for (const effect of declared) {
      if (!Object.hasOwn(STEWARD_HOST_TABLE.tools, effect))
        fail(`Capability ${capability.name}: effect ${effect} has no steward host tool mapping`);
      effects.add(effect);
    }
    capabilityText.push(
      [
        `### ${capability.name}`,
        `Source: ${cite(capability)}`,
        says(capability),
        ...(operations.length ? [`Operations:\n\n${entries(operations)}`] : []),
        ...(checks.length ? [`Checks:\n\n${entries(checks)}`] : []),
        `Effects: ${declared.join(', ')}`,
      ].join('\n\n'),
    );
  }
  const granted = new Set([...effects].flatMap((effect) => STEWARD_HOST_TABLE.tools[effect]!));
  const tools = LEGACY_STEWARD_TOOLS.filter((tool) => granted.has(tool));
  const voiceText =
    voice === undefined
      ? []
      : [
          `## Voice\n\nSource: ${cite(voice)}\n\n${says(voice)}\n\n${fieldsOf(voice, 'communication')
            .map((f) => `- ${f.key}: ${fieldText(f)}`)
            .join('\n')}`,
        ];
  const body = [
    `## Mandate\n\nSource: ${cite(mandate)}\n\n${says(mandate)}\n\n${bounds.text}${limits.length ? `\n\nLimits: ${limits.join('; ')}.` : ''}`,
    ...voiceText,
    `## Capabilities\n\nSource: ${cite(profile)}\n\n${capabilityText.join('\n\n')}`,
  ].join('\n\n');
  return { kind: 'profile', sources, playbooks, tools, text: body };
}
