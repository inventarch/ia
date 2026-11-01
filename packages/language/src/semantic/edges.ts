import type { FieldNode, RecordNode } from '../ast.js';
import { listed, meter } from '../bounded.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic, LangCode } from '../diagnostics.js';
import { consentFor, largestLedger } from '../registry/consent.js';
import type { FrozenRegistry } from '../registry/types.js';
import { KINDS } from '../taxonomy.js';
import { conditionOf } from './conditions.js';
import { misplacedIn } from './placement.js';
import { resolveTarget, validatePool } from './resolve.js';
import type { Resolution, ResolutionCandidate } from './resolve.js';
import type { CompiledEdge, EdgeReference } from './types.js';
import { verbOf, VERB_PHRASES } from './vocabulary.js';
import type { Verb } from './vocabulary.js';

export interface EdgesResult {
  readonly edges: readonly CompiledEdge[];
  readonly diagnostics: readonly Diagnostic[];
  /** Known outbound binding lines already refused: dependent validation must not report them missing. */
  readonly refusedBindings: ReadonlySet<'govern' | 'implement'>;
}

/** How many words the longest verb phrase holds: a line's words past those cannot begin one. */
const VERB_WORDS = VERB_PHRASES.reduce((longest, phrase) => Math.max(longest, phrase.split(' ').length), 0);
export function verbPrefix(words: readonly string[]): { readonly verb: Verb; readonly length: number } | undefined {
  for (let length = Math.min(words.length, VERB_WORDS); length > 0; length--) {
    const verb = verbOf(words.slice(0, length).join(' '));
    if (verb) return { verb, length };
  }
  return undefined;
}

export function targetOf(field: FieldNode, verbLength: number): EdgeReference | undefined {
  if (field.value.kind === 'ref' && field.words.length === verbLength) {
    const { discriminator, name, fragment } = field.value;
    return { kind: 'ref', discriminator, name, ...(fragment === undefined ? {} : { fragment }) };
  }
  if (field.value.kind !== 'scalar' || field.words.length !== verbLength + 1) return undefined;
  const target = field.words[verbLength]!;
  const match =
    /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\/([^\s/#]+)\/([A-Za-z][A-Za-z0-9-]*)(?:#([A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*))?$/.exec(
      target,
    );
  if (!match || !(KINDS as readonly string[]).includes(match[2]!)) return undefined;
  const identity = `${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  return { kind: 'identity', identity, ...(match[5] === undefined ? {} : { fragment: match[5] }) };
}

/** The references a generated `ground` edge already states, each under the key `groundKey` reads a reference at. */
function groundKeys(generated: readonly CompiledEdge[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const edge of generated) {
    if (
      edge.predicate !== 'ground' ||
      edge.direction !== 'out' ||
      edge.condition !== undefined ||
      edge.fragment !== undefined
    )
      continue;
    if (edge.target !== null) keys.add(`identity ${edge.target}`);
    if (edge.reference.kind === 'ref')
      keys.add(`ref ${edge.reference.discriminator} ${edge.reference.name.toLowerCase()}`);
  }
  return keys;
}
function groundKey(reference: EdgeReference): string | undefined {
  if (reference.fragment !== undefined) return undefined;
  return reference.kind === 'identity'
    ? `identity ${reference.identity}`
    : `ref ${reference.discriminator} ${reference.name.toLowerCase()}`;
}

export function readEdges(
  record: RecordNode,
  source: ResolutionCandidate,
  registry: FrozenRegistry,
  pool: readonly ResolutionCandidate[] | ((reference: EdgeReference) => Resolution),
  generated: readonly CompiledEdge[] = [],
): EdgesResult {
  validatePool(registry, typeof pool === 'function' ? [source] : [source, ...pool]);
  const edges: CompiledEdge[] = [...generated];
  const groundStated = groundKeys(generated);
  const diagnostics: Diagnostic[] = [];
  const refusedBindings = new Set<'govern' | 'implement'>();
  const path = source.source.path;
  for (const section of record.sections) {
    if (section.name !== 'relationships') continue;
    for (const field of section.children) {
      if (field.kind === 'record') continue;
      // Every stage after this reads consent rows for it; a ledger of ordinary size costs nothing more.
      const work = meter();
      work?.edge();
      work?.scan(largestLedger(registry));
      const parsed = field.kind === 'field' ? verbPrefix(field.words) : undefined;
      const refuseDiagnostic = (diagnostic: Diagnostic): void => {
        diagnostics.push(diagnostic);
        if (
          parsed?.verb.direction === 'out' &&
          (parsed.verb.predicate === 'govern' || parsed.verb.predicate === 'implement')
        )
          refusedBindings.add(parsed.verb.predicate);
      };
      const refuse = (code: LangCode, message: string): void =>
        refuseDiagnostic(diag(code, path, field.span.line, message, { endLine: field.span.endLine }));
      if (field.kind !== 'field') {
        refuse('IA-LANG-EDGE-MALFORMED', 'Expected a verb and a sigil or qualified target.');
        continue;
      }
      if (field.words[0] === 'when') {
        refuse('IA-LANG-CONDITION-MISPLACED', 'A condition must belong to an edge.');
        continue;
      }
      if (!parsed) {
        refuse(
          'IA-LANG-VERB-UNKNOWN',
          `Unknown relationship verb ${field.words.join(' ')}; expected ${VERB_PHRASES.join(', ')}.`,
        );
        continue;
      }
      const reference = targetOf(field, parsed.length);
      if (!reference) {
        refuse(
          'IA-LANG-EDGE-MALFORMED',
          'Expected exactly one sigil or fully qualified system/kind/facet/name target, optionally with #fragment.',
        );
        continue;
      }
      const unsupported = field.children.filter(
        (c) => c.kind !== 'record' && !(c.kind === 'field' && c.words[0] === 'when'),
      );
      if (unsupported.length) {
        const misplaced = misplacedIn(unsupported, path)[0];
        if (misplaced) refuseDiagnostic(misplaced);
        else refuse('IA-LANG-EDGE-MALFORMED', 'A relationship admits only a direct child when.');
        continue;
      }
      const condition = conditionOf(field, path);
      if (!condition.ok) {
        refuseDiagnostic(condition.diagnostic);
        continue;
      }
      const { predicate, direction } = parsed.verb;
      const spelling = field.words.slice(0, parsed.length).join(' ');
      if (
        predicate === 'ground' &&
        direction === 'out' &&
        condition.condition === undefined &&
        groundStated.has(groundKey(reference) ?? '')
      )
        continue;
      const resolution = typeof pool === 'function' ? pool(reference) : resolveTarget(reference, registry, pool);
      if (resolution.kind === 'ambiguous') {
        refuse(
          'IA-LANG-EDGE-TARGET-AMBIGUOUS',
          `Target matches multiple occurrences: ${listed(resolution.candidates, (c) => `${c.identity} at ${c.source.path}:${c.source.line}`)}.`,
        );
        continue;
      }
      if (resolution.kind === 'resolved') {
        const from = direction === 'out' ? source : resolution.target;
        const to = direction === 'out' ? resolution.target : source;
        const refused = consentFor(
          registry,
          predicate,
          from.discriminator,
          to.discriminator,
          direction === 'out' ? reference.fragment : undefined,
        );
        if (refused) {
          refuse(
            'IA-LANG-EDGE-UNCONSENTED',
            `The ${refused} system ${refused === 'source' ? from.system : to.system} does not consent to ${predicate} ${from.discriminator} -> ${to.discriminator}.`,
          );
          continue;
        }
      } else
        diagnostics.push(
          diag(
            'IA-LANG-EDGE-TARGET-MISSING',
            path,
            field.span.line,
            'No admitted record matches this target; the authored reference is retained.',
            { severity: 'warning', endLine: field.span.endLine },
          ),
        );
      edges.push({
        predicate,
        direction,
        spelling,
        reference,
        target: resolution.kind === 'resolved' ? resolution.target.identity : null,
        ...(reference.fragment === undefined ? {} : { fragment: reference.fragment }),
        ...(condition.condition === undefined ? {} : { condition: condition.condition }),
        span: field.span,
      });
    }
  }
  return { edges, diagnostics, refusedBindings };
}
