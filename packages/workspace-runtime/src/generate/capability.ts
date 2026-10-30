import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { PHASES } from '@inventarch/language';
import type { Cell } from '@inventarch/language';
import { PACKET_MARKER } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import { authoredOf, code, inline, knownHost, perRecord, prose, safeName, section, stated, textsAt } from './format.js';
import type { GeneratedFile, GeneratedSet, UnsupportedRecord } from './format.js';

/**
 * Generation of host skills from invocable `@capability` records (decision `generated-skill-unit`, C′): the capability is
 * the only invocable unit, so each band-100 capability that states `invocation.mode` renders one skill, by the rule
 * `ia project --product plugin` applies. `none` renders nothing; `delegated` is not rendered by this version and is an
 * unsupported row; `model` and `user` render `.claude/skills/<name>/SKILL.md` for claude and
 * `.agents/skills/<name>/SKILL.md` for codex, the same text for both: YAML frontmatter with the name, the description
 * (`meaning.says`), `disable-model-invocation: true` for `user` and the `argument-hint` when stated, the packet's
 * marker, then the capability's identity, its `invocation.use-when`, and, for each playbook its `composition.playbooks`
 * names, one section per phase in cycle order holding the playbook's cells, the primary primitive's first. A playbook is
 * never its own skill. A capability whose name is not a portable host name, is the packet's own `ia-authoring` skill,
 * or whose text is not inert prose is an unsupported row; the others still render. The bytes are a function of the
 * records alone.
 */
const RESERVED = 'ia-authoring';
const SKILLS: Readonly<Record<PacketHost, string>> = { claude: '.claude/skills', codex: '.agents/skills' };
const MODES = ['model', 'user', 'delegated', 'none'] as const;

/** The invocable capabilities' skills through the scope token `within`, by identity, and their unsupported rows. */
export function generateCapabilitySkills(reader: ReadHandle, within: string, host: PacketHost): GeneratedSet {
  knownHost(host);
  const records = reader.records({ within }),
    nodes = new Map(records.map((node) => [node.identity, node]));
  const playbooksOf = (capability: Node): readonly Node[] =>
    reader
      .directedView(capability.identity, { within })
      .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.field === 'composition.playbooks')
      .map((row) => nodes.get(row.counterpart))
      .filter((node): node is Node => node !== undefined && node.discriminator === 'playbook');
  const invocable = authoredOf(records, 'capability').filter((node) => stated(node, 'invocation.mode'));
  const delegated: UnsupportedRecord[] = [];
  const rendered = invocable.filter((node) => {
    const mode = textsAt(node, 'invocation.mode')[0] as (typeof MODES)[number] | undefined;
    if (mode === 'delegated')
      delegated.push({
        identity: node.identity,
        word: 'capability',
        reason: 'delegated skills are not rendered by this version of ia',
      });
    return mode === 'model' || mode === 'user';
  });
  const set = perRecord('capability', rendered, (capability): GeneratedFile => {
    if (capability.name === RESERVED)
      inputFailure(
        `Capability ${capability.identity} would render over the packet's ${RESERVED} skill; rename the capability`,
      );
    return {
      path: `${SKILLS[host]}/${safeName(capability.name)}/SKILL.md`,
      text: skillFile(capability, playbooksOf(capability)),
      identity: capability.identity,
      word: 'capability',
    };
  });
  return { files: set.files, unsupported: [...set.unsupported, ...delegated] };
}

function skillFile(capability: Node, playbooks: readonly Node[]): string {
  const first = (field: string): string | undefined => textsAt(capability, field)[0];
  const hint = first('invocation.argument-hint'),
    useWhen = first('invocation.use-when');
  const out = [
    '---',
    `name: ${JSON.stringify(capability.name)}`,
    `description: ${JSON.stringify(inline(first('meaning.says') ?? ''))}`,
    ...(first('invocation.mode') === 'user' ? ['disable-model-invocation: true'] : []),
    ...(hint === undefined ? [] : [`argument-hint: ${JSON.stringify(inline(hint))}`]),
    '---',
    '',
    PACKET_MARKER,
    '',
    `# ${capability.name}`,
    '',
    `- capability ${code(capability.identity)}`,
    ...(useWhen === undefined ? [] : [`- use when: ${prose(useWhen)}`]),
  ];
  for (const playbook of playbooks) {
    out.push(`- playbook ${code(playbook.identity)}`);
    for (const phase of PHASES) {
      const cells = playbook.cells.filter((cell) => cell.phase === phase);
      if (cells.length > 0)
        out.push(
          ...section(phase, [...cells.filter((c) => c.primary), ...cells.filter((c) => !c.primary)].map(cellLine)),
        );
    }
  }
  return `${out.join('\n')}\n`;
}

const cellLine = (cell: Cell): string =>
  `- ${cell.primitive}${cell.primary ? ' (primary)' : ''}${
    cell.condition === undefined
      ? ''
      : ` (when ${cell.condition.map((term) => `${inline(term.axis)} is ${inline(term.value)}`).join(' and ')})`
  }: ${prose(cell.text)}`;
