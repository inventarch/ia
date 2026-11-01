import type { Requirement } from '@inventarch/language';
import { conditionHolds, validateCoordinate } from '@inventarch/graph';
import type { Coordinate, Edge, Graph, Node } from '@inventarch/graph';
import { finding } from './graph-checks.js';
import { assess } from './types.js';
import type { Assessment, Finding } from './types.js';

export interface ClauseContext {
  readonly graph: Graph;
  readonly adopter: Node;
  readonly contract: Node;
  readonly requirement: Requirement;
  readonly coordinate?: Coordinate;
}
export interface ClauseResult {
  readonly outcome: Assessment['outcome'];
  readonly message: string;
}
export type ClauseEvaluator = (context: ClauseContext) => ClauseResult;
/**
 * C33: how many clause entries an adoption lists, and all of a report's adoptions together. Adopters times clauses is a
 * product of two lists a small corpus can make long: past these an adoption counts its clauses in one entry.
 */
export const ADOPTION_LISTED = Object.freeze({ adoption: 64, report: 16_384 });
export type AdoptionEvaluators = ReadonlyMap<string, ReadonlyMap<string, ClauseEvaluator>>;
export function validateAdoption(
  graph: Graph,
  evaluators: AdoptionEvaluators = new Map(),
  input?: Coordinate,
): readonly Assessment[] {
  const coordinate = input === undefined ? undefined : validateCoordinate(input),
    assessments: Assessment[] = [];
  let listable = ADOPTION_LISTED.report;
  for (const adopter of graph.nodes.values()) {
    const adoptions = graph.out.get(adopter.identity)?.get('require') ?? [];
    // Several assertions of one adoption cannot execute a clause twice.
    const byContract = new Map<string, Edge[]>();
    for (const edge of adoptions) {
      if (edge.to === null) {
        const registration = graph.registry.registrations.get('contract');
        const refersToContract =
          edge.reference.kind === 'ref'
            ? edge.reference.discriminator === 'contract'
            : registration !== undefined &&
              edge.reference.identity.startsWith(`${registration.system}/${registration.kind}/`) &&
              registration.facets.includes(edge.reference.identity.split('/')[2] ?? '');
        if (refersToContract)
          assessments.push(
            assess(
              'COMP-ADOPTION',
              `${adopter.identity}->${edge.reference.kind === 'ref' ? `@contract ${edge.reference.name}` : edge.reference.identity}`,
              [],
              true,
            ),
          );
        continue; // graph consent assessment retains the missing-target finding
      }
      if (graph.nodes.get(edge.to)?.discriminator !== 'contract') continue;
      const edges = byContract.get(edge.to);
      if (edges === undefined) byContract.set(edge.to, [edge]);
      else edges.push(edge);
    }
    for (const [identity, edges] of byContract) {
      const contract = graph.nodes.get(identity)!,
        findings: Finding[] = [];
      const active = edges.some(
        (edge) =>
          edge.condition === undefined ||
          (coordinate !== undefined &&
            conditionHolds(edge.condition, graph.nodes.get(edge.conditionSubject)!.dimensions, coordinate)),
      );
      if (!active) {
        if (coordinate === undefined)
          findings.push(
            finding(
              'IA-COMP-NOT-EVALUATED',
              adopter,
              `Conditional adoption of ${identity} needs an explicit coordinate`,
              edges[0]!.source.line,
              true,
            ),
          );
        else continue; // this coordinate does not adopt the contract
      } else {
        const evaluating = evaluators.get(identity),
          room = Math.min(ADOPTION_LISTED.adoption, listable);
        let more = 0,
          failed = false;
        const report = (entry: Finding): void => {
          if (findings.length < room) findings.push(entry);
          else {
            more++;
            failed ||= entry.severity === 'error';
          }
        };
        for (const [index, requirement] of contract.requirements.entries()) {
          // With no evaluator to run and no coordinate to read, a clause left can only add to the count.
          if (findings.length === room && evaluating === undefined && coordinate === undefined) {
            more += contract.requirements.length - index;
            break;
          }
          if (requirement.condition !== undefined && coordinate === undefined) {
            report(
              finding(
                'IA-COMP-NOT-EVALUATED',
                adopter,
                `${identity}#${requirement.id}: conditional clause needs an explicit coordinate`,
                edges[0]!.source.line,
                true,
              ),
            );
            continue;
          }
          if (coordinate !== undefined && !conditionHolds(requirement.condition, contract.dimensions, coordinate))
            continue;
          const evaluator = evaluating?.get(requirement.id);
          let result: ClauseResult;
          if (evaluator === undefined)
            result = { outcome: 'not-evaluated', message: 'No structural evaluator is supplied' };
          else
            try {
              result = evaluator({
                graph,
                adopter,
                contract,
                requirement,
                ...(coordinate === undefined ? {} : { coordinate }),
              });
              if (!['pass', 'fail', 'not-evaluated'].includes(result.outcome) || typeof result.message !== 'string')
                throw new Error('Invalid evaluator result');
            } catch (error) {
              result = {
                outcome: 'not-evaluated',
                message: `Evaluator unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          if (result.outcome !== 'pass')
            report(
              finding(
                result.outcome === 'fail' ? 'IA-COMP-ADOPTION-FAILED' : 'IA-COMP-NOT-EVALUATED',
                adopter,
                `${identity}#${requirement.id}: ${result.message}`,
                edges[0]!.source.line,
                result.outcome !== 'fail',
              ),
            );
        }
        if (more > 0)
          findings.push(
            finding(
              failed ? 'IA-COMP-ADOPTION-FAILED' : 'IA-COMP-NOT-EVALUATED',
              adopter,
              `${identity}: ${more} more clauses are not listed`,
              edges[0]!.source.line,
              !failed,
            ),
          );
        listable -= Math.min(listable, findings.length);
      }
      assessments.push(assess('COMP-ADOPTION', `${adopter.identity}->${identity}`, findings));
    }
  }
  return Object.freeze(assessments.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)));
}
