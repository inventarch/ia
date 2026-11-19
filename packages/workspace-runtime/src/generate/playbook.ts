import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { PHASES } from '@inventarch/language';
import type { Cell } from '@inventarch/language';
import { PACKET_MARKER } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import { authoredOf, code, inline, knownHost, perRecord, prose, safeName, section, textsAt } from './format.js';
import type { GeneratedSet } from './format.js';

/**
 * Generation of host skills from authored `@playbook` records. Each band-100 playbook in the scope renders one skill,
 * `.claude/skills/<playbook name>/SKILL.md` for claude and `.agents/skills/<playbook name>/SKILL.md` for codex, with the
 * same text for both: YAML frontmatter naming the playbook and describing it by its `meaning.says`, the packet's marker
 * on its own line, then one section per phase in the cycle order (orient, plan, act, learn) holding the playbook's
 * unconditional and conditional cells, the primary primitive's first. A phase with no cell is left out. A playbook
 * whose name is not a portable host name, that is named as the packet's own `ia-authoring` skill, or whose text is not
 * inert prose is not rendered, and is reported as an unsupported row naming it and the reason; the others still render.
 * A playbook below band 100, an installed or adopted base, renders nothing (public and adopted playbooks stay cells
 * that `ia position` delivers), and a workspace that authors public systems, as this repository does, renders their
 * playbooks. The bytes are a function of the playbook's record alone: no absolute path, time or scope token is written.
 *
 * Nothing here applies these files: `generateHostSet` hands them to the one projection writer.
 */

/**
 * The name of the one skill the position packet renders for each host (runtime's packet-host.ts PATHS), which the
 * projection writer owns: a playbook of that name would render over it.
 */
const RESERVED = 'ia-authoring';
const SKILLS: Readonly<Record<PacketHost, string>> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.gemini/skills',
  antigravity: '.agents/skills',
};

/**
 * The skills of the authored `@playbook` records the scope token `within` admits, by identity, and an unsupported row
 * for each one not rendered (see above). An unknown host is IA-PROJECTION-INPUT-INVALID; an unknown or stale token keeps
 * its database code.
 */
export function generatePlaybookSkills(reader: ReadHandle, within: string, host: PacketHost): GeneratedSet {
  knownHost(host);
  return perRecord('playbook', authoredOf(reader.records({ within }), 'playbook'), (playbook) => {
    // A record's name is lowercase, so no spelling of the reserved name escapes this, on a case-insensitive file system
    // either.
    if (playbook.name === RESERVED)
      inputFailure(
        `Playbook ${playbook.identity} would render over the packet's ${RESERVED} skill; rename the playbook`,
      );
    return {
      path: `${SKILLS[host]}/${safeName(playbook.name)}/SKILL.md`,
      text: skillFile(playbook),
      identity: playbook.identity,
      word: 'playbook' as const,
    };
  });
}

function skillFile(playbook: Node): string {
  // Both frontmatter values are JSON-quoted, so a name YAML reads as a keyword (`true`, `null`) stays a string.
  const out = [
    '---',
    `name: ${JSON.stringify(playbook.name)}`,
    `description: ${JSON.stringify(inline(textsAt(playbook, 'meaning.says')[0] ?? ''))}`,
    '---',
    '',
    PACKET_MARKER,
    '',
    `# ${playbook.name}`,
    '',
    `- playbook ${code(playbook.identity)}`,
  ];
  for (const phase of PHASES) {
    const cells = playbook.cells.filter((cell) => cell.phase === phase);
    // The primary primitive first, then each named primitive in authored order.
    if (cells.length > 0)
      out.push(
        ...section(phase, [...cells.filter((c) => c.primary), ...cells.filter((c) => !c.primary)].map(cellLine)),
      );
  }
  return `${out.join('\n')}\n`;
}

/** One cell: its primitive, marked when it is the phase's primary, its condition's terms as they read, and its text. */
const cellLine = (cell: Cell): string =>
  `- ${cell.primitive}${cell.primary ? ' (primary)' : ''}${
    cell.condition === undefined
      ? ''
      : ` (when ${cell.condition.map((term) => `${inline(term.axis)} is ${inline(term.value)}`).join(' and ')})`
  }: ${prose(cell.text)}`;
