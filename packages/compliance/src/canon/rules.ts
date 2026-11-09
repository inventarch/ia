import { selectionWithin } from '@inventarch/graph';
import type { Graph, Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import type { SystemFolder } from '../systems.js';
import { assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';
import { fields, textField } from '../graph-checks.js';
import { SEVERITY_ORDER, canonSeverity, lawSeverity } from './laws.js';

const WORK_INSTANCES: ReadonlySet<string> = new Set(['plan', 'milestone', 'task', 'decision', 'spec']);

const SYSTEM_FOLDER = /^\.ia\/src\/systems\/([^/]+)\//;

/** The `@system` of the folder `.ia/src/systems/<folder>/`: the one authored in it, else the one named `<folder>`. */
function folderSystems(nodes: readonly Node[], folder: string): readonly Node[] {
  const systems = nodes.filter((node) => node.discriminator === 'system');
  const inside = systems.filter((s) => posix(s.source.path).startsWith(`.ia/src/systems/${folder}/`));
  return inside.length > 0 ? inside : systems.filter((s) => s.name === folder);
}
const mintsWords = (systems: readonly Node[]): boolean =>
  systems.some((s) => sectionKeys(s, 'discriminators').length > 0);

/** The system folders `.ia/src/systems/<name>/` whose `@system` declares discriminators, so mints words. */
function vocabularyFolders(nodes: readonly Node[]): ReadonlySet<string> {
  const folders = new Set<string>();
  for (const node of nodes) {
    const match = SYSTEM_FOLDER.exec(posix(node.source.path));
    if (match !== null) folders.add(match[1]!);
  }
  return new Set([...folders].filter((folder) => mintsWords(folderSystems(nodes, folder))));
}

/**
 * A14: work records inside a vocabulary system's folder `.ia/src/systems/<name>/`, one whose `@system` declares
 * discriminators. A wordless method system's folder is not a vocabulary payload. The caller sets the severity.
 */
export function canonWorkPlacement(nodes: readonly Node[]): readonly Finding[] {
  const vocabulary = vocabularyFolders(nodes);
  return nodes
    .filter((node) => {
      if (!WORK_INSTANCES.has(node.discriminator)) return false;
      const match = SYSTEM_FOLDER.exec(posix(node.source.path));
      return match !== null && vocabulary.has(match[1]!);
    })
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
const SYSTEM_RECORDS = /^\.ia\/src\/systems\/([^/]+)\/records\/[^/]+$/;
/** The kit's seat workspace: the repository's own, which a kit never ships. */
const SEAT_WORKSPACE = '.ia/src/workspace.ia';

/** A kit: its systems, and the `@distribution` records that make it one. */
interface Kit {
  readonly systems: readonly string[];
  readonly distributions: readonly Node[];
}
const NO_KIT: Kit = { systems: [], distributions: [] };

/** The names of the `@<discriminator>` references a distribution's `distribution.records` lists. */
function listed(distribution: Node, discriminator: string): readonly string[] {
  const names: string[] = [];
  for (const field of fields(distribution, 'distribution', 'records'))
    if (field.value.kind === 'list')
      for (const item of field.value.items)
        if (item.kind === 'ref' && item.discriminator === discriminator) names.push(item.name);
  return names;
}

/** Form (a): the one system whose `records/plugin.ia` authors a product `@distribution` (host-plugin-distribution section 12). */
function loweredKit(nodes: readonly Node[]): Kit {
  const found = new Map<string, Node[]>();
  for (const node of nodes) {
    if (node.discriminator !== 'distribution' || !node.sections.some((s) => s.name === 'product')) continue;
    const match = PLUGIN_RECORDS.exec(posix(node.source.path));
    if (match !== null) found.set(match[1]!, [...(found.get(match[1]!) ?? []), node]);
  }
  if (found.size !== 1) return NO_KIT;
  const [system, distributions] = [...found][0]!;
  return { systems: [system], distributions };
}

/**
 * Form (b): a `@distribution` authored under `.ia/src/systems/<n>/records/` whose `distribution.records` lists `@system`
 * or `@workspace` records. Its kit systems are the `@system`s it lists. One listing only `@workspace`s (as ia-brand,
 * ia-design, ia-ui and ia-ux ship) makes `<n>`, the system folder holding it, the kit system, but only when that folder's
 * `@system` declares no discriminators: a vocabulary system's `@workspace`-only distribution (the foundation's
 * `workspace-system`) is not a kit. A folder with no `@system` is not one either. The detection is heuristic.
 */
const wordless = (nodes: readonly Node[], folder: string): boolean => {
  const systems = folderSystems(nodes, folder);
  return systems.length > 0 && !mintsWords(systems);
};
function nativeKit(nodes: readonly Node[]): Kit {
  const systems = new Set<string>();
  const distributions: Node[] = [];
  for (const node of nodes) {
    if (node.discriminator !== 'distribution') continue;
    const match = SYSTEM_RECORDS.exec(posix(node.source.path));
    if (match === null) continue;
    const named = listed(node, 'system');
    if (named.length > 0) for (const name of named) systems.add(name);
    else if (listed(node, 'workspace').length > 0 && wordless(nodes, match[1]!)) systems.add(match[1]!);
    else continue;
    distributions.push(node);
  }
  return { systems: [...systems].sort(), distributions };
}

/** The kit: the single section 12 system, else the systems native release distributions name. */
function kitOf(nodes: readonly Node[]): Kit {
  const lowered = loweredKit(nodes);
  return lowered.systems.length > 0 ? lowered : nativeKit(nodes);
}
const kitSystems = (nodes: readonly Node[]): readonly string[] => kitOf(nodes).systems;

/**
 * True when the workspace is a kit: either exactly one system has `records/plugin.ia` authoring a product `@distribution`,
 * or a `@distribution` authored under `.ia/src/systems/<name>/records/` lists one or more `@system` or `@workspace`
 * records.
 */
export function isKitWorkspace(nodes: readonly Node[]): boolean {
  return kitSystems(nodes).length > 0;
}

/**
 * The `@workspace` records a kit ships: those its kit distributions list in `distribution.records`, and those authored
 * under a kit system's folder `.ia/src/systems/<kit system>/`. Never the seat `.ia/src/workspace.ia`, which stays home.
 */
function shippedWorkspaces(nodes: readonly Node[]): readonly Node[] {
  const kit = kitOf(nodes);
  if (kit.systems.length === 0) return [];
  const names = new Set(kit.distributions.flatMap((d) => listed(d, 'workspace')));
  return nodes.filter((node) => {
    if (node.discriminator !== 'workspace') return false;
    const path = posix(node.source.path);
    if (path === SEAT_WORKSPACE) return false;
    return names.has(node.name) || kit.systems.some((system) => path.startsWith(`.ia/src/systems/${system}/`));
  });
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

/**
 * C5a: in a kit, each shipped `@workspace` (see `shippedWorkspaces`) has no `composition.steward` and no
 * `composition.sources`. The kit's own seat workspace is not shipped, so it is not checked.
 */
export function canonKitWorkspace(nodes: readonly Node[]): readonly Finding[] {
  const found: Finding[] = [];
  for (const node of shippedWorkspaces(nodes)) {
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

/**
 * E5: a mandate citing a mandate allows no move and covers no path the cited mandate does not. Each `covers` selection
 * must lie within one of the cited mandate's, read in the graph's path selection dialect (`selectionWithin`, G06c).
 */
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
        if (!covers.some((c) => selectionWithin(path, c)))
          report(
            'covers',
            `Mandate ${mandate.name} covers ${path}, outside every path ${parent.name}, which it cites, covers.`,
          );
    }
  return found;
}

/**
 * A canon record: one under `.ia/src/systems/<system>/records/canon/`, in the folder of the system owning its word, as
 * authored or as installed (the store prefix `.ia/distributions/store/<sha256 hex>/` before it).
 */
const CANON_LAWS = /^(?:\.ia\/distributions\/store\/[0-9a-f]{64}\/)?\.ia\/src\/systems\/[^/]+\/records\/canon\//;
const underCanon = (node: Node): boolean => CANON_LAWS.test(posix(node.source.path));

/**
 * E4, its verifiable half: a local law or convention that cites a canon law (a resolved `cites` edge to a law under a
 * `records/canon/` folder) governs that law's subject word and is at least as strong (informational < advisory <
 * blocking). The law also asks that a rule tightening a canon law cite it; subject-word equality is no evidence that a
 * rule tightens one, so an uncited rule is not judged here and that half is left to review.
 */
export function canonLocalTightening(nodes: readonly Node[], graph?: Graph): readonly Finding[] {
  const found: Finding[] = [];
  const canon = nodes.filter((node) => node.discriminator === 'law' && underCanon(node));
  for (const local of nodes) {
    if ((local.discriminator !== 'law' && local.discriminator !== 'convention') || underCanon(local)) continue;
    const cited = citedBy(local, graph),
      tightened = canon.filter((law) => cited.has(law.identity));
    if (tightened.length === 0) continue;
    const word = textField(local, 'subject', 'subject-word');
    const report = (message: string): void => {
      found.push({
        code: 'IA-COMP-CANON-LOCAL-TIGHTEN',
        path: local.source.path,
        line: local.source.line,
        severity: 'error',
        message: `${local.source.path}:${local.source.line}: ${message}`,
      });
    };
    for (const law of tightened) {
      // A canon law with no subject word sets no word to match: only its severity is judged.
      const lawWord = textField(law, 'subject', 'subject-word');
      if (lawWord !== undefined && word !== lawWord)
        report(
          `${local.name} cites the canon law ${law.name}, which governs the word ${lawWord}, but ${
            word === undefined ? 'governs no subject word' : `governs the word ${word}`
          }.`,
        );
      if (SEVERITY_ORDER[lawSeverity(local)] < SEVERITY_ORDER[lawSeverity(law)])
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
