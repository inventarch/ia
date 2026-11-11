/**
 * What `languageFloor` reads of a workspace or kit, and how a gap it finds is said: shared by `ia update`/`ia install`
 * (distribute.ts), `ia floor` and `ia pack` (floor.ts), so the minimum and its reason are computed and worded one way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gap } from '@inventarch/db/distribution';

/**
 * The workspace's authored record trees as `languageFloor` reads them: every `.ia` file under `.ia/src`, by its
 * workspace-relative path. Only record trees count (a kit's other assets would say nothing true about its minimum), and
 * links are not followed.
 */
export function recordSources(root: string): { path: string; text: string }[] {
  const sources: { path: string; text: string }[] = [];
  const walk = (directory: string, at: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${at}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else if (entry.isFile() && entry.name.endsWith('.ia'))
        sources.push({ path, text: readFileSync(join(directory, entry.name), 'utf8') });
    }
  };
  const top = join(root, '.ia/src');
  if (existsSync(top)) walk(top, '.ia/src');
  return sources;
}

/** One gap, said as what the record does and what the base it fails on makes of that. */
export function gapText(gap: Gap): string {
  const owner = gap.record === '' ? '' : ` (@${gap.word} ${gap.record})`;
  const said: Readonly<Record<Gap['kind'], string>> = {
    word: `uses the word ${gap.key}, which ${gap.base} does not register`,
    section: `uses the section ${gap.key}, which ${gap.base} does not declare`,
    field: `uses the field ${gap.key}, which ${gap.base} does not declare`,
    value: `uses the value ${gap.key}, which ${gap.base} does not admit`,
    form: `uses the value ${gap.key}, which is not in the text form ${gap.base} requires`,
    type: `gives ${gap.key} a value ${gap.base} does not admit`,
    'required-section': `lacks the section ${gap.key}, which ${gap.base} requires`,
    'required-field': `lacks the field ${gap.key}, which ${gap.base} requires`,
    parse: `does not parse (${gap.key})`,
  };
  return `${gap.source}${owner} ${said[gap.kind]}`;
}
