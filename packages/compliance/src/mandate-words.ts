import { MOVES, isPlacementKind } from '@inventarch/language';
import type { CompiledField, CompiledValue, PlacementKind } from '@inventarch/language';
import { canonicalRoot, reaches, selects } from '@inventarch/graph';
import type { Graph, Node } from '@inventarch/graph';
import { finding } from './graph-checks.js';
import { assess } from './types.js';
import type { Assessment, Finding } from './types.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Administrative and bootstrap words authored directly by workspace owners (`profile.ts` `ADMINISTRATIVE_WORDS`). */
const ADMINISTRATIVE_WORDS: ReadonlySet<string> = new Set([
  'workspace',
  'agent',
  'mandate',
  'system',
  'schema',
  'agent-profile',
  'hook',
]);

interface DeclaredRoot {
  readonly root: string;
  readonly placement: PlacementKind;
  readonly workspace: string;
}

interface ParsedMandate {
  readonly node: Node;
  readonly identity: string;
  readonly hasParticipant: boolean;
  readonly allowsSynthesis: boolean;
  readonly scopeWorkspaces: readonly string[];
  readonly hasScopeValue: boolean;
  readonly covers: readonly string[];
  readonly hasCoversValue: boolean;
  readonly words: ReadonlySet<string> | undefined;
  readonly excludedWords: ReadonlySet<string>;
}

function sourceTree(path: string): string {
  const at = path.indexOf('/.ia/src/');
  return path.startsWith('.ia/src/') || at < 0 ? '' : path.slice(0, at);
}

function systemMemberRoot(path: string): string | undefined {
  const match =
    /^(\.ia\/(?:(?:(?:adopted|open)\/[a-z][a-z0-9-]*|distributions\/store)\/[a-f0-9]{64}\/\.ia\/)?src\/systems\/([^/]+))\//.exec(
      path,
    ) ?? /^((?!\.ia\/)(?:[^/]+\/)+\.ia\/src\/systems\/([^/]+))\//.exec(path);
  return match?.[1];
}

function declaredRoots(graph: Graph): readonly DeclaredRoot[] {
  const out: DeclaredRoot[] = [];
  for (const identity of graph.byDiscriminator.get('workspace') ?? []) {
    const node = graph.nodes.get(identity)!;
    for (const section of node.sections) {
      if (section.name !== 'composition') continue;
      for (const field of section.fields) {
        if (!('key' in field) || field.key !== 'sources' || field.value.kind !== 'list') continue;
        for (const item of field.value.items) {
          if (!('text' in item)) continue;
          const [, rawRoot, placement] = /^(.+) @([a-z]+)$/.exec(item.text) ?? [];
          if (rawRoot === undefined || placement === undefined || !isPlacementKind(placement)) continue;
          try {
            const root = [sourceTree(node.source.path), canonicalRoot(rawRoot)].filter(Boolean).join('/');
            out.push({ root, placement, workspace: node.identity });
          } catch {
            // Malformed or escaping root declarations are reported separately by `inertDeclarations`.
          }
        }
      }
    }
  }
  return out.sort((a, b) => b.root.length - a.root.length || compare(a.workspace, b.workspace));
}

function repositoryWorkspace(graph: Graph, declared: readonly DeclaredRoot[]): string | undefined {
  const own = (graph.byDiscriminator.get('workspace') ?? []).filter((identity) => {
    const node = graph.nodes.get(identity)!;
    return node.placement.kind !== 'runtime' && node.source.path.startsWith('.ia/src/');
  });
  const entry = own.filter((identity) => graph.nodes.get(identity)!.source.path === '.ia/src/workspace.ia');
  if (entry.length > 0) return entry.length === 1 ? entry[0] : undefined;
  const declaring = own.filter((identity) => declared.some((root) => root.workspace === identity));
  const candidates = declaring.length > 0 ? declaring : own;
  return candidates.length === 1 ? candidates[0] : undefined;
}

function states(node: Node, section: string, key: string): boolean {
  return node.sections
    .filter((candidate) => candidate.name === section)
    .flatMap((candidate) => candidate.fields)
    .some((child) => 'key' in child && child.key === key);
}

function statesValue(node: Node, section: string, key: string): boolean {
  return node.sections
    .filter((candidate) => candidate.name === section)
    .flatMap((candidate) => candidate.fields)
    .some(
      (child) =>
        'key' in child &&
        child.key === key &&
        !('value' in child && child.value.kind === 'list' && child.value.items.length === 0),
    );
}

function authorityFields(node: Node, key: string): readonly CompiledField[] | null {
  const matched = node.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .filter((child): child is CompiledField => 'key' in child && child.key === key);
  for (const field of matched)
    if (field.when !== undefined || field.fields !== undefined || field.value.kind === 'block') return null;
  return matched;
}

function authorityTexts(node: Node, key: string): readonly string[] | null {
  const matched = authorityFields(node, key);
  if (matched === null) return null;
  const values: CompiledValue[] = matched.flatMap((f) => (f.value.kind === 'list' ? f.value.items : [f.value]));
  const texts: string[] = [];
  for (const v of values) {
    if (v.kind !== 'scalar' && v.kind !== 'string' && v.kind !== 'prose') return null;
    texts.push(v.text);
  }
  return texts;
}

function parseAuthoredMandate(node: Node, graph: Graph): ParsedMandate | null {
  const participantFields = authorityFields(node, 'participant');
  if (participantFields === null) return null;
  const participantItems = participantFields.flatMap((f) => (f.value.kind === 'list' ? f.value.items : [f.value]));
  if (participantItems.length > 1) return null;
  for (const item of participantItems)
    if (item.kind !== 'ref' || item.discriminator !== 'agent' || item.fragment !== undefined) return null;

  const hasMoves = states(node, 'authority', 'moves');
  const moveTexts = authorityTexts(node, 'moves');
  if (moveTexts === null) return null;
  if (hasMoves && moveTexts.length === 0) return null;
  for (const m of moveTexts) if (!(MOVES as readonly string[]).includes(m)) return null;

  const scopeFields = authorityFields(node, 'scope');
  if (scopeFields === null) return null;
  for (const f of scopeFields)
    for (const item of f.value.kind === 'list' ? f.value.items : [f.value])
      if (item.kind !== 'ref' || item.discriminator !== 'workspace' || item.fragment !== undefined) return null;

  const coversTexts = authorityTexts(node, 'covers');
  const wordsTexts = authorityTexts(node, 'words');
  const excludedTexts = authorityTexts(node, 'excluded-words');
  if (coversTexts === null || wordsTexts === null || excludedTexts === null) return null;

  const refs = graph.referencesFrom.get(node.identity) ?? [];
  const scopeWorkspaces = refs
    .filter((ref) => ref.field === 'authority.scope' && graph.nodes.get(ref.to)?.discriminator === 'workspace')
    .map((ref) => ref.to);

  return {
    node,
    identity: node.identity,
    hasParticipant: participantItems.length === 1,
    allowsSynthesis: !hasMoves || moveTexts.includes('Synthesis'),
    scopeWorkspaces,
    hasScopeValue: statesValue(node, 'authority', 'scope'),
    covers: coversTexts,
    hasCoversValue: statesValue(node, 'authority', 'covers'),
    words: states(node, 'authority', 'words') ? new Set(wordsTexts) : undefined,
    excludedWords: new Set(excludedTexts),
  };
}

/**
 * COMP-MANDATE (`#286`): enforce `@mandate` word allow-lists (`authority.words`) and exclusions (`authority.excluded-words`)
 * across authored workspace records so hand edits and external writes obey the same word bounds as `ia author`.
 */
export function validateMandateWords(graph: Graph): Assessment {
  const mandateIds = graph.byDiscriminator.get('mandate') ?? [];
  if (mandateIds.length === 0) return assess('COMP-MANDATE', 'graph', []);

  const mandates: ParsedMandate[] = [];
  for (const id of mandateIds) {
    const node = graph.nodes.get(id)!;
    if (node.band !== 100 || node.placement.kind !== 'authored') continue;
    const parsed = parseAuthoredMandate(node, graph);
    if (parsed !== null) mandates.push(parsed);
  }
  if (mandates.length === 0 || !mandates.some((m) => m.words !== undefined || m.excludedWords.size > 0)) {
    return assess('COMP-MANDATE', 'graph', []);
  }
  mandates.sort((a, b) => compare(a.identity, b.identity));

  const declared = declaredRoots(graph);
  const declaredSet = new Set(declared.map((d) => d.root));
  const repoWs = repositoryWorkspace(graph, declared);

  const rootOf = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    if (node.placement.kind === 'runtime') continue;
    const path = node.source.path;
    const root =
      declared.find((d) => d.placement === node.placement.kind && reaches(d.root, path))?.root ??
      systemMemberRoot(path) ??
      (path.startsWith('.ia/src/floor/') ? '.ia/src/floor' : path.slice(0, Math.max(0, path.lastIndexOf('/'))));
    rootOf.set(node.identity, root);
  }

  const ownCache = new Map<string, ReadonlySet<string>>();
  const ownOf = (ws: string | undefined): ReadonlySet<string> => {
    const key = ws ?? '';
    let cached = ownCache.get(key);
    if (cached === undefined) {
      cached = new Set(declared.filter((d) => d.workspace === ws).map((d) => d.root));
      ownCache.set(key, cached);
    }
    return cached;
  };
  const holds = (own: ReadonlySet<string>, identity: string): boolean => {
    const node = graph.nodes.get(identity)!;
    if (node.band === 10 || node.band === 90) return true;
    const root = rootOf.get(identity)!;
    return own.size > 0 ? own.has(root) : !declaredSet.has(root);
  };

  const findings: Finding[] = [];
  for (const node of graph.nodes.values()) {
    if (node.band !== 100 || node.placement.kind !== 'authored') continue;
    const path = node.source.path.replaceAll('\\', '/');
    if (
      !path.startsWith('.ia/src/') ||
      path.startsWith('.ia/src/floor/') ||
      systemMemberRoot(path) !== undefined ||
      ADMINISTRATIVE_WORDS.has(node.discriminator)
    )
      continue;

    const longest = declared.find(
      (d) => reaches(d.root, path) && graph.nodes.get(d.workspace)?.placement.kind !== 'runtime',
    )?.root;
    const declarers =
      longest === undefined
        ? []
        : [
            ...new Set(
              declared
                .filter((d) => d.root === longest && graph.nodes.get(d.workspace)?.placement.kind !== 'runtime')
                .map((d) => d.workspace),
            ),
          ];

    const shared = declarers.length > 1 ? declarers : undefined;
    const targetWs = shared !== undefined ? undefined : (declarers[0] ?? repoWs);
    const governing = mandates.filter((m) => {
      const inClosure =
        shared !== undefined ? shared.some((d) => holds(ownOf(d), m.identity)) : holds(ownOf(targetWs), m.identity);
      if (!inClosure) return false;
      const stated = m.hasScopeValue || m.hasCoversValue;
      const claims = m.covers.some((sel) => selects(sel, path));
      if (shared !== undefined) return stated && (shared.every((d) => m.scopeWorkspaces.includes(d)) || claims);
      if (stated) return (targetWs !== undefined && m.scopeWorkspaces.includes(targetWs)) || claims;
      return m.hasParticipant;
    });
    if (governing.length === 0) continue;

    const word = node.discriminator;
    // Participant-less mandates bind every actor at the path/scope and act as word ceilings.
    const ceilingRefusal = governing.find(
      (m) => !m.hasParticipant && (m.excludedWords.has(word) || (m.words !== undefined && !m.words.has(word))),
    );
    if (ceilingRefusal !== undefined) {
      const why = ceilingRefusal.excludedWords.has(word)
        ? `${ceilingRefusal.identity} excludes @${word}`
        : ceilingRefusal.words!.size === 0
          ? `${ceilingRefusal.identity} allows no words`
          : `${ceilingRefusal.identity} allows only ${[...ceilingRefusal.words!].map((w) => `@${w}`).join(', ')}`;
      findings.push(finding('IA-COMP-MANDATE-WORD', node, `@${word} is disallowed at ${path} (${why})`));
      continue;
    }

    const synthesisMandates = governing.filter((m) => m.allowsSynthesis);
    if (synthesisMandates.length === 0) continue;
    const permitted = synthesisMandates.some(
      (m) => !m.excludedWords.has(word) && (m.words === undefined || m.words.has(word)),
    );
    if (!permitted) {
      const reasons = synthesisMandates.map((m) =>
        m.excludedWords.has(word)
          ? `${m.identity} excludes @${word}`
          : m.words!.size === 0
            ? `${m.identity} allows no words`
            : `${m.identity} allows only ${[...m.words!].map((w) => `@${w}`).join(', ')}`,
      );
      findings.push(
        finding(
          'IA-COMP-MANDATE-WORD',
          node,
          `@${word} is not permitted by any governing Synthesis mandate at ${path} (${reasons.join('; ')})`,
        ),
      );
    }
  }

  return assess('COMP-MANDATE', 'graph', findings);
}
