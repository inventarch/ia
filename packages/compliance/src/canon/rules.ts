import type { Graph, Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import type { SystemFolder } from '../systems.js';
import { assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';
import { fields, textField } from '../graph-checks.js';
import { SEVERITY_ORDER, canonSeverity, lawSeverity } from './laws.js';

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

/**
 * The kit systems that execute (dec-040 A): a kit system whose records include an `@execution-binding`. Their folders
 * `.ia/src/systems/<name>/` may hold scripts.
 */
export function executingKitSystems(nodes: readonly Node[]): readonly string[] {
  return kitSystems(nodes).filter((name) =>
    nodes.some(
      (node) =>
        node.discriminator === 'execution-binding' && posix(node.source.path).startsWith(`.ia/src/systems/${name}/`),
    ),
  );
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

/** The identities `node` cites. With the graph, only its resolved `cite` edges count; without one, its edges' own targets. */
function citedBy(node: Node, graph?: Graph): ReadonlySet<string> {
  const found = new Set<string>();
  if (graph !== undefined) {
    for (const edge of graph.edges)
      if (edge.predicate === 'cite' && edge.from === node.identity && edge.to !== null) found.add(edge.to);
  } else
    for (const edge of node.edges)
      if (edge.predicate === 'cite' && edge.direction === 'out' && edge.target !== null) found.add(edge.target);
  return found;
}

/** The text of each non-reference item of a list field. */
const listTexts = (node: Node, section: string, key: string): readonly string[] =>
  fields(node, section, key).flatMap((field) =>
    field.value.kind === 'list' ? field.value.items.flatMap((item) => ('text' in item ? [item.text] : [])) : [],
  );

const normalPath = (path: string): string => posix(path).replace(/^\.\//, '').replace(/\*+$/, '');
/** True when `path` lies within `parent`: equal, or under it when `parent` is a folder (a trailing `/`, or `/**`). */
function pathWithin(path: string, parent: string): boolean {
  const child = normalPath(path);
  const base = normalPath(parent);
  return base.endsWith('/') ? child.startsWith(base) || `${child}/` === base : child === base;
}

/** E5: a mandate citing a mandate allows no move and covers no path the cited mandate does not. */
export function canonMandateNarrowing(nodes: readonly Node[], graph?: Graph): readonly Finding[] {
  const found: Finding[] = [];
  const mandates = new Map(nodes.filter((n) => n.discriminator === 'mandate').map((n) => [n.identity, n]));
  for (const mandate of mandates.values())
    for (const id of [...citedBy(mandate, graph)].sort()) {
      const parent = mandates.get(id);
      if (parent === undefined) continue;
      const moves = new Set(listTexts(parent, 'authority', 'moves'));
      const covers = listTexts(parent, 'authority', 'covers');
      const report = (key: string, message: string): void => {
        const line = fields(mandate, 'authority', key)[0]?.span.line ?? mandate.source.line;
        found.push({
          code: 'IA-COMP-CANON-MANDATE-WIDEN',
          path: mandate.source.path,
          line,
          severity: 'error',
          message: `${mandate.source.path}:${line}: ${message}`,
        });
      };
      for (const move of listTexts(mandate, 'authority', 'moves'))
        if (!moves.has(move))
          report('moves', `Mandate ${mandate.name} allows ${move}, which ${parent.name}, which it cites, does not.`);
      for (const path of listTexts(mandate, 'authority', 'covers'))
        if (!covers.some((c) => pathWithin(path, c)))
          report(
            'covers',
            `Mandate ${mandate.name} covers ${path}, outside every path ${parent.name}, which it cites, covers.`,
          );
    }
  return found;
}

const CANON_LAWS = '.ia/src/systems/governance-system/records/canon/';
const underCanon = (node: Node): boolean => posix(node.source.path).startsWith(CANON_LAWS);

/** E4: a local law or convention on a canon law's subject word cites that law and is at least as strong. */
export function canonLocalTightening(nodes: readonly Node[], graph?: Graph): readonly Finding[] {
  const found: Finding[] = [];
  const canon = nodes.filter((node) => node.discriminator === 'law' && underCanon(node));
  for (const local of nodes) {
    if ((local.discriminator !== 'law' && local.discriminator !== 'convention') || underCanon(local)) continue;
    const word = textField(local, 'subject', 'subject-word');
    if (word === undefined) continue;
    const cited = citedBy(local, graph);
    for (const law of canon) {
      if (textField(law, 'subject', 'subject-word') !== word) continue;
      const report = (message: string): void => {
        found.push({
          code: 'IA-COMP-CANON-LOCAL-TIGHTEN',
          path: local.source.path,
          line: local.source.line,
          severity: 'error',
          message: `${local.source.path}:${local.source.line}: ${message}`,
        });
      };
      if (!cited.has(law.identity))
        report(`${local.name} governs the word ${word} but does not cite the canon law ${law.name}.`);
      else if (SEVERITY_ORDER[lawSeverity(local)] < SEVERITY_ORDER[lawSeverity(law)])
        report(
          `${local.name} is ${lawSeverity(local)}, weaker than the canon law ${law.name}, which is ${lawSeverity(law)}.`,
        );
    }
  }
  return found;
}

type Rule = (nodes: readonly Node[], folders: readonly SystemFolder[] | undefined, graph?: Graph) => readonly Finding[];
const RULES: readonly (readonly [string, Rule])[] = [
  ['CANON-WORK-PLACEMENT', canonWorkPlacement],
  ['CANON-KIT-WORDS', canonKitMethodWords],
  ['CANON-KIT-WORKSPACE', canonKitWorkspace],
  ['CANON-MANDATE-NARROW', (nodes, _folders, graph) => canonMandateNarrowing(nodes, graph)],
  ['CANON-LOCAL-TIGHTEN', (nodes, _folders, graph) => canonLocalTightening(nodes, graph)],
];

/**
 * One built-in canon check as an assessment: null while no law enforces a check that runs `id`, else its findings at the
 * severity the law sets. `find` runs only when the check is active, so a rule that reads files reads none while inactive.
 */
export function canonAssessment(
  nodes: readonly Node[],
  id: string,
  find: () => readonly Finding[],
  graph?: Graph,
): Assessment | null {
  const severity: Severity | null = canonSeverity(nodes, id, graph);
  return severity === null
    ? null
    : assess(
        id,
        'graph',
        find().map((finding) => ({ ...finding, severity })),
      );
}

/**
 * The built-in canon rules, each active only when a law enforces a check that runs it. The law sets the severity;
 * an inactive rule reports nothing. `folders` is read by the rules that look at system folders.
 */
export function canonAssessments(
  nodes: readonly Node[],
  folders: readonly SystemFolder[] | undefined,
  graph?: Graph,
): readonly Assessment[] {
  return RULES.flatMap(([id, rule]) => canonAssessment(nodes, id, () => rule(nodes, folders, graph), graph) ?? []);
}
