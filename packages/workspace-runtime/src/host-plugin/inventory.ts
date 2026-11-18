import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostPluginError } from './errors.js';
import { type Frontmatter, parseFrontmatter } from './frontmatter.js';

export type PluginHost = 'claude' | 'codex' | 'grok' | 'gemini' | 'antigravity';
export const MANIFESTS: Readonly<Record<PluginHost, string>> = Object.freeze({
  claude: '.claude-plugin/plugin.json',
  codex: '.codex-plugin/plugin.json',
  grok: '.grok-plugin/plugin.json',
  gemini: 'gemini-extension.json',
  antigravity: 'plugin.json',
});
export interface PluginEntry {
  readonly path: string;
  readonly bytes: Buffer;
}
export interface PluginSkill {
  readonly name: string;
  readonly file: PluginEntry;
  readonly frontmatter: Frontmatter;
  readonly owned: readonly PluginEntry[];
}
export interface PluginAgent {
  readonly name: string;
  readonly file: PluginEntry;
  readonly frontmatter: Frontmatter;
}
export interface PluginInventory {
  readonly manifests: Readonly<Partial<Record<PluginHost, Readonly<Record<string, unknown>>>>>;
  readonly skills: readonly PluginSkill[];
  readonly agents: readonly PluginAgent[];
  readonly other: readonly PluginEntry[];
  readonly unresolved: readonly string[];
}

export const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const LIMIT = { files: 1000, bytes: 16 * 1024 * 1024 } as const;
const HOSTS: readonly PluginHost[] = ['claude', 'codex', 'grok'];

/** Every regular file under `root`, by sorted POSIX path; links, `.git` and `node_modules` are refused. */
export function readEntries(root: string): PluginEntry[] {
  const entries: PluginEntry[] = [];
  let total = 0;
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink())
        throw new HostPluginError('IA-PLUGIN-INPUT', `${path} is a symbolic link; lowering reads real files only`);
      // In any letter case: a case-insensitive volume reads `.GIT` as `.git`.
      if (name.toLowerCase() === '.git' || name.toLowerCase() === 'node_modules')
        throw new HostPluginError('IA-PLUGIN-INPUT', `${path} is not plugin content`);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) throw new HostPluginError('IA-PLUGIN-INPUT', `${path} is not a regular file`);
      total += stat.size;
      if (entries.length >= LIMIT.files || total > LIMIT.bytes)
        throw new HostPluginError('IA-PLUGIN-INPUT', `The plugin exceeds ${LIMIT.files} files or ${LIMIT.bytes} bytes`);
      entries.push(Object.freeze({ path, bytes: readFileSync(join(root, path)) }));
    }
  };
  walk('');
  return entries;
}

function manifestOf(entry: PluginEntry): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(entry.bytes.toString('utf8'));
  } catch {
    throw new HostPluginError('IA-PLUGIN-INPUT', `${entry.path} is not JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HostPluginError('IA-PLUGIN-INPUT', `${entry.path} is not a JSON object`);
  return value as Record<string, unknown>;
}

export function inventoryOf(entries: readonly PluginEntry[]): PluginInventory {
  const manifests: Partial<Record<PluginHost, Record<string, unknown>>> = {};
  const skills = new Map<string, { file?: PluginEntry; owned: PluginEntry[] }>();
  const agents: PluginAgent[] = [];
  const other: PluginEntry[] = [];
  const unresolved: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const host = HOSTS.find((candidate) => MANIFESTS[candidate] === entry.path);
    if (host !== undefined) {
      manifests[host] = manifestOf(entry);
      continue;
    }
    const parts = entry.path.split('/');
    if (parts[0] === 'hooks' || entry.path === '.mcp.json' || entry.path === '.lsp.json') {
      unresolved.push(`${entry.path}: hooks and servers are not lowered by this version of ia`);
      continue;
    }
    if (parts[0] === 'commands') {
      unresolved.push(`${entry.path}: commands/ is not lowered; move it to skills/<name>/SKILL.md first`);
      continue;
    }
    if (parts[0] === 'skills' && parts.length >= 3) {
      const name = parts[1]!;
      if (!NAME.test(name)) {
        unresolved.push(`${entry.path}: skill folder ${name} is not a portable name`);
        continue;
      }
      const skill = skills.get(name) ?? { owned: [] };
      if (parts.length === 3 && parts[2] === 'SKILL.md') skill.file = entry;
      else skill.owned.push(entry);
      skills.set(name, skill);
      continue;
    }
    if (parts[0] === 'agents' && parts.length === 2 && entry.path.endsWith('.md')) {
      const name = parts[1]!.slice(0, -3);
      if (!NAME.test(name)) unresolved.push(`${entry.path}: agent name ${name} is not a portable name`);
      else agents.push(Object.freeze({ name, file: entry, frontmatter: parseFrontmatter(entry.bytes, entry.path) }));
      continue;
    }
    other.push(entry);
  }
  const skillList: PluginSkill[] = [];
  for (const [name, skill] of [...skills.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (skill.file === undefined) {
      unresolved.push(`skills/${name}: no SKILL.md`);
      continue;
    }
    skillList.push(
      Object.freeze({
        name,
        file: skill.file,
        frontmatter: parseFrontmatter(skill.file.bytes, skill.file.path),
        owned: Object.freeze(skill.owned),
      }),
    );
  }
  return Object.freeze({
    manifests: Object.freeze(manifests),
    skills: Object.freeze(skillList),
    agents: Object.freeze(agents),
    other: Object.freeze(other),
    unresolved: Object.freeze(unresolved),
  });
}

export const readPlugin = (root: string): PluginInventory => inventoryOf(readEntries(root));
