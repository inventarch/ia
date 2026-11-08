import type { Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import type { SystemFolder } from '../systems.js';
import { assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';
import { fields } from '../graph-checks.js';
import { canonSeverity } from './laws.js';

const WORK_INSTANCES: ReadonlySet<string> = new Set(['plan', 'milestone', 'task', 'decision', 'spec']);

/** A14: work records inside a reusable system payload under `.ia/src/systems/`. The caller sets the severity. */
export function canonWorkPlacement(nodes: readonly Node[]): readonly Finding[] {
  return nodes
    .filter((node) => node.source.path.startsWith('.ia/src/systems/') && WORK_INSTANCES.has(node.discriminator))
    .map(
      (node): Finding => ({
        code: 'IA-COMP-CANON-WORK-PLACEMENT',
        path: node.source.path,
        line: node.source.line,
        severity: 'error',
        message: `${node.source.path}:${node.source.line}: Repository plans, milestones, tasks, decisions and specifications belong in workspace-authored records, outside reusable vocabulary system payloads.`,
      }),
    );
}

const posix = (path: string): string => path.split(String.fromCharCode(92)).join('/');
const PLUGIN_RECORDS = /^\.ia\/src\/systems\/([^/]+)\/records\/plugin\.ia$/;
const SYSTEM_RECORDS = /^\.ia\/src\/systems\/[^/]+\/records\/[^/]+$/;

/** Form (a): the one system whose `records/plugin.ia` authors a product `@distribution` (host-plugin-distribution section 12). */
function lowerKitSystems(nodes: readonly Node[]): readonly string[] {
  const found = new Set<string>();
  for (const node of nodes) {
    if (node.discriminator !== 'distribution' || !node.sections.some((s) => s.name === 'product')) continue;
    const match = PLUGIN_RECORDS.exec(posix(node.source.path));
    if (match !== null) found.add(match[1]!);
  }
  return found.size === 1 ? [...found] : [];
}

/** Form (b): the `@system`s listed by a `@distribution` authored under `.ia/src/systems/<n>/records/`. */
function nativeKitSystems(nodes: readonly Node[]): readonly string[] {
  const found = new Set<string>();
  for (const node of nodes) {
    if (node.discriminator !== 'distribution' || !SYSTEM_RECORDS.test(posix(node.source.path))) continue;
    for (const field of fields(node, 'distribution', 'records'))
      if (field.value.kind === 'list')
        for (const item of field.value.items)
          if (item.kind === 'ref' && item.discriminator === 'system') found.add(item.name);
  }
  return [...found].sort();
}

/** The kit's systems: the single section 12 system, else the systems a native release distribution lists. */
function kitSystems(nodes: readonly Node[]): readonly string[] {
  const lowered = lowerKitSystems(nodes);
  return lowered.length > 0 ? lowered : nativeKitSystems(nodes);
}

/**
 * True when the workspace is a kit: either exactly one system has `records/plugin.ia` authoring a product `@distribution`,
 * or a `@distribution` authored under `.ia/src/systems/<name>/records/` lists one or more `@system` records.
 */
export function isKitWorkspace(nodes: readonly Node[]): boolean {
  return kitSystems(nodes).length > 0;
}

const METHOD_WORDS: ReadonlySet<string> = new Set([
  'capability',
  'playbook',
  'convention',
  'principle',
  'law',
  'agent-profile',
]);

const systemNode = (nodes: readonly Node[], name: string): Node | undefined =>
  nodes.find((node) => node.discriminator === 'system' && node.name === name);
const sectionKeys = (node: Node, section: string): readonly string[] =>
  node.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : f.item.kind === 'scalar' ? f.item.text : '')));

/** C4: in a kit, each method system declares no discriminators and requires the owner of every word its records use. */
export function canonKitMethodWords(
  nodes: readonly Node[],
  folders: readonly SystemFolder[] | undefined,
): readonly Finding[] {
  const found: Finding[] = [];
  const report = (path: string, line: number, message: string): void => {
    found.push({
      code: 'IA-COMP-CANON-KIT-WORDS',
      path,
      line,
      severity: 'error',
      message: `${path}:${line}: ${message}`,
    });
  };
  const owners = new Map<string, string>();
  for (const node of nodes)
    if (node.discriminator === 'system')
      for (const word of sectionKeys(node, 'discriminators')) owners.set(word, node.name);
  for (const kit of kitSystems(nodes)) {
    const folder = folders?.find((f) => f.name === kit);
    const used = new Map<string, { path: string; line: number }>();
    const record = (word: string, path: string, line: number): void => {
      if (!used.has(word)) used.set(word, { path, line });
    };
    if (folder !== undefined) for (const r of folder.records) record(r.discriminator, r.source.path, r.source.line);
    else
      for (const node of nodes)
        if (posix(node.source.path).startsWith(`.ia/src/systems/${kit}/`))
          record(node.discriminator, node.source.path, node.source.line);
    if (![...used.keys()].some((word) => METHOD_WORDS.has(word))) continue;
    const method = systemNode(nodes, kit);
    if (method !== undefined) {
      const minted = sectionKeys(method, 'discriminators');
      if (minted.length > 0)
        report(
          method.source.path,
          method.source.line,
          `Kit system ${kit} declares ${minted.join(', ')}; a kit method system mints no words and requires the system that owns each word it uses.`,
        );
    }
    const required = new Set(method === undefined ? [] : sectionKeys(method, 'requires'));
    for (const [word, where] of [...used].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      const owner = owners.get(word);
      if (owner !== undefined && owner !== kit && !required.has(owner))
        report(where.path, where.line, `Kit system ${kit} uses ${word} but does not require ${owner}, which owns it.`);
    }
  }
  return found;
}

/** C5a: in a kit, the shipped `@workspace` has no `composition.steward` and no `composition.sources`. */
export function canonKitWorkspace(nodes: readonly Node[]): readonly Finding[] {
  if (!isKitWorkspace(nodes)) return [];
  const found: Finding[] = [];
  for (const node of nodes) {
    if (node.discriminator !== 'workspace') continue;
    for (const key of ['steward', 'sources'])
      for (const field of fields(node, 'composition', key))
        found.push({
          code: 'IA-COMP-CANON-KIT-WORKSPACE',
          path: node.source.path,
          line: field.span.line,
          severity: 'error',
          message: `${node.source.path}:${field.span.line}: A kit workspace declares no composition.${key}; the host workspace supplies it.`,
        });
  }
  return found;
}

type Rule = (nodes: readonly Node[], folders: readonly SystemFolder[] | undefined) => readonly Finding[];
const RULES: readonly (readonly [string, Rule])[] = [
  ['CANON-WORK-PLACEMENT', canonWorkPlacement],
  ['CANON-KIT-WORDS', canonKitMethodWords],
  ['CANON-KIT-WORKSPACE', canonKitWorkspace],
];

/**
 * The built-in canon rules, each active only when a law enforces a check that runs it. The law sets the severity;
 * an inactive rule reports nothing. `folders` is read by the rules that look at system folders.
 */
export function canonAssessments(
  nodes: readonly Node[],
  folders: readonly SystemFolder[] | undefined,
): readonly Assessment[] {
  const results: Assessment[] = [];
  for (const [id, rule] of RULES) {
    const severity: Severity | null = canonSeverity(nodes, id);
    if (severity === null) continue;
    results.push(
      assess(
        id,
        'graph',
        rule(nodes, folders).map((finding) => ({ ...finding, severity })),
      ),
    );
  }
  return results;
}
