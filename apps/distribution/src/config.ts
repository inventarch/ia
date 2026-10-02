import { parse } from 'smol-toml';
import { stableSerialize } from '@ia/graph';
import { fail } from './files.js';

export function configBlock(id: string, content: string): string {
  return `\n# BEGIN IA PROJECTION ${id}\n${content}# END IA PROJECTION ${id}\n`;
}
/** Preserve every unmanaged byte. Parsing catches dotted/quoted/inline table aliases. */
export function reconcileConfig(
  current: string,
  id: string,
  previous: string | null,
  next: string | null,
  section: 'agents' | 'mcp_servers' = 'agents',
): string {
  const begin = `\n# BEGIN IA PROJECTION ${id}\n`,
    end = `# END IA PROJECTION ${id}\n`;
  let unmanaged = current,
    insertion = current.length;
  if (previous !== null) {
    const block = configBlock(id, previous),
      start = current.indexOf(block);
    if (
      start < 0 ||
      current.indexOf(begin) !== start ||
      current.indexOf(begin, start + begin.length) >= 0 ||
      current.indexOf(end) !== start + block.length - end.length
    )
      fail('LOCAL-MODIFICATION', 'Owned Codex registration block changed');
    unmanaged = current.slice(0, start) + current.slice(start + block.length);
    insertion = start;
  } else if (current.includes(begin) || current.includes(end))
    fail('LOCAL-MODIFICATION', 'Unowned Codex registration block already exists');
  try {
    const checkRoles = (whole: string, generated: string): void => {
      const expected = parse(generated)[section] as Record<string, unknown>,
        actual = parse(whole)[section] as Record<string, unknown> | undefined;
      for (const [name, role] of Object.entries(expected))
        if (stableSerialize(actual?.[name] ?? null) !== stableSerialize(role))
          throw new Error('Owned role has fields outside its block');
    };
    if (previous !== null) checkRoles(current, previous);
    parse(unmanaged);
    if (next === null) return unmanaged;
    const combined = unmanaged.slice(0, insertion) + configBlock(id, next) + unmanaged.slice(insertion);
    checkRoles(combined, next);
    return combined;
  } catch {
    return fail('LOCAL-MODIFICATION', 'Codex configuration is invalid or conflicts with a generated registration');
  }
}
