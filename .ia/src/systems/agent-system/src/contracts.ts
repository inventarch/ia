import { copy, digest } from '@inventarch/session-system';
import type { CausalReferences, Json, Limits, ReviewContract, Run, Session } from '@inventarch/session-system';
import { check, validateShape } from './action.js';
import type {
  ArtifactRequirement,
  Grant,
  Manifest,
  ModelAction,
  OperationDefinition,
  Profile,
  ResourceLimits,
  TaskContract,
} from './types.js';

export function boundedLimits(base: Limits, bounds: ResourceLimits | undefined, now: number): Limits {
  const result = { ...base };
  for (const [key, value] of Object.entries(bounds ?? {})) {
    check(
      Number.isSafeInteger(value) && value >= (key === 'durationMs' ? 1 : 0),
      'IA-ENGINE-LIMIT-INVALID',
      'Invalid compiled limit',
    );
    if (key === 'durationMs') result.deadline = Math.min(result.deadline, now + value);
    else {
      check(Object.hasOwn(base, key) && key !== 'deadline', 'IA-ENGINE-LIMIT-INVALID', 'Unknown compiled limit');
      result[key as keyof Limits] = Math.min(result[key as keyof Limits], value);
    }
  }
  return result;
}
export function narrowGrant(current: Grant, ceiling?: Grant): Grant {
  const result = copy(current);
  if (!ceiling) return result;
  for (const key of ['profiles', 'operations', 'effects', 'sources', 'models'] as const) {
    // All five fields are sets; the separate assignments preserve their literal element types.
    const admitted = new Set<string>(ceiling[key]);
    (result[key] as string[]) = current[key].filter((value) => admitted.has(value));
  }
  for (const key of Object.keys(result.limits) as (keyof Limits)[])
    result.limits[key] = Math.min(result.limits[key], ceiling.limits[key]);
  if (ceiling.destinations)
    result.destinations = (current.destinations ?? []).filter((v) =>
      ceiling.destinations!.some((d) => digest(d) === digest(v)),
    );
  return result;
}
export function taskContract(profile: Profile, task: Json, artifact?: ArtifactRequirement): TaskContract {
  const inputs = profile.contract?.inputContracts ?? [];
  check(
    inputs.every((c) => validateShape(c.schema, task)),
    'IA-ENGINE-TASK-INVALID',
    'Task does not satisfy every installed mandate/input contract',
  );
  check(
    profile.completion !== 'artifact' || (artifact && profile.operations.includes(artifact.operation)),
    'IA-ENGINE-TASK-INVALID',
    'Artifact tasks require an exact operation and destination',
  );
  return {
    version: 1,
    objective: copy(task),
    inputs: copy(inputs),
    outcomes: [...profile.outcomes],
    completion: profile.completion,
    evaluator: 'ia.completion.v1',
    escalation: 'persist-required-wait',
    artifact: artifact ? copy(artifact) : null,
  };
}
export function causes(state: Session, run: Run, actionId: string, modelAttemptId: string | null): CausalReferences {
  return {
    actionId,
    modelAttemptId,
    questions: Object.values(state.questions)
      .filter((q) => q.runId === run.id && q.status === 'answered')
      .map((q) => q.id),
    proposals: Object.values(state.proposals)
      .filter((p) => p.runId === run.id)
      .map((p) => p.id),
    decisions: Object.values(state.decisions)
      .filter((d) => d.runId === run.id)
      .map((d) => d.id),
    receipts: state.receipts
      .filter((r) => r.runId === run.id)
      .slice(-32)
      .map((r) => r.id),
  };
}
export function operationAllowed(
  operation: OperationDefinition | undefined,
  profile: Profile,
  grant: Grant,
): asserts operation is OperationDefinition {
  check(
    operation &&
      profile.operations.includes(operation.id) &&
      grant.operations.includes(operation.id) &&
      operation.effects.every(
        (e) => grant.effects.includes(e) && (!profile.contract || profile.contract.effects.includes(e)),
      ),
    'IA-ENGINE-OPERATION-DENIED',
    'Operation/binding/effect exceeds the effective authority',
  );
}
function effectInput(input: Json): { candidate: Json; destination: Json } {
  check(
    input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.hasOwn(input, 'candidate') &&
      Object.hasOwn(input, 'destination'),
    'IA-ENGINE-REVIEW-INVALID',
    'Governed effects require exact candidate and destination inputs',
  );
  return { candidate: input['candidate']!, destination: input['destination']! };
}
export function offerReview(
  state: Session,
  run: Run,
  profile: Profile,
  grant: Grant,
  manifest: Manifest,
  action: Extract<ModelAction, { type: 'outcome' }>,
  now: number,
): ReviewContract | undefined {
  if (!action.review) return undefined;
  check(action.proposal !== undefined, 'IA-ENGINE-REVIEW-INVALID', 'Review requires a candidate');
  const request = action.review,
    operation = manifest.operations[request.operation];
  operationAllowed(operation, profile, grant);
  check(
    validateShape(operation.input, request.input),
    'IA-ENGINE-INPUT-INVALID',
    'Reviewed input failed its installed contract',
  );
  const input = effectInput(request.input),
    effect = operation.effects.filter((e) => e !== 'read');
  check(
    effect.length === 1 && digest(input.candidate) === digest(action.proposal),
    'IA-ENGINE-REVIEW-INVALID',
    'Review input must contain the offered candidate and one effect',
  );
  check(
    grant.destinations?.some((d) => digest(d) === digest(input.destination)),
    'IA-ENGINE-AUTHORITY-DENIED',
    'Destination is not granted',
  );
  const receipt = state.receipts.find(
    (r) => r.id === request.validationReceipt && r.runId === run.id && r.error === null && r.effect === 'none',
  );
  const validation = receipt?.output as
    | { allowed?: boolean; candidateDigest?: string; artifactDigest?: string }
    | undefined;
  check(
    receipt &&
      manifest.operations[receipt.target]?.purpose === 'candidate-validation' &&
      manifest.operations[receipt.target]?.effects.every((e) => e === 'read') &&
      validation?.allowed === true &&
      validation.candidateDigest === digest(action.proposal) &&
      typeof validation.artifactDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(validation.artifactDigest),
    'IA-ENGINE-CANDIDATE-UNVERIFIED',
    'An exact successful candidate-validation receipt is required',
  );
  const expiry = Math.min(state.limits.deadline, run.limits?.deadline ?? Infinity, grant.expiresAt);
  check(expiry > now, 'IA-ENGINE-REVIEW-INVALID', 'Review deadline expired');
  return {
    reviewer: state.principal,
    rule: 'operator-exact-candidate-v1',
    expiresAt: expiry,
    operation: operation.id,
    bindingDigest: operation.digest,
    inputDigest: digest(request.input),
    candidateDigest: digest(action.proposal),
    artifactDigest: validation.artifactDigest,
    destination: copy(input.destination),
    effect: effect[0]!,
    validationReceipt: receipt.id,
  };
}
export function admittedReview(
  state: Session,
  run: Run,
  operation: OperationDefinition,
  action: Extract<ModelAction, { type: 'invoke' }>,
  grant: Grant,
  now: number,
  preparing?: string,
) {
  if (operation.effects.every((e) => e === 'read')) {
    check(!action.review, 'IA-ENGINE-REVIEW-INVALID', 'Read operations do not consume effect approvals');
    return undefined;
  }
  const ref = action.review,
    proposal = ref && state.proposals[ref.proposalId],
    decision = ref && state.decisions[ref.decisionId],
    review = proposal?.review;
  check(
    ref &&
      proposal &&
      review &&
      decision &&
      proposal.runId === run.id &&
      proposal.status === 'accepted' &&
      proposal.decisionId === decision.id &&
      proposal.revision === ref.revision &&
      proposal.digest === ref.digest &&
      decision.proposalDigest === proposal.digest &&
      decision.subject === proposal.id &&
      decision.revision === proposal.revision &&
      decision.choice === 'accepted' &&
      decision.actor === review.reviewer &&
      digest(decision.review) === digest(review),
    'IA-ENGINE-REVIEW-INVALID',
    'Exact authenticated review is unavailable or stale',
  );
  const input = effectInput(action.input);
  check(
    review.expiresAt > now &&
      review.operation === operation.id &&
      review.bindingDigest === operation.digest &&
      review.inputDigest === digest(action.input) &&
      review.candidateDigest === digest(input.candidate) &&
      digest(review.destination) === digest(input.destination) &&
      operation.effects.filter((e) => e !== 'read').every((e) => e === review.effect),
    'IA-ENGINE-REVIEW-INVALID',
    'Candidate, input, binding, destination or effect changed after review',
  );
  check(
    grant.destinations?.some((d) => digest(d) === digest(review.destination)),
    'IA-ENGINE-AUTHORITY-DENIED',
    'Current grant no longer permits the destination',
  );
  check(
    !Object.values(state.attempts).some(
      (a) =>
        a.id !== preparing && a.review?.decisionId === decision.id && (a.effect !== 'none' || a.status !== 'observed'),
    ),
    'IA-ENGINE-REVIEW-CONSUMED',
    'Reviewed effect is already applied or unresolved',
  );
  return { ...copy(review), ...ref };
}
/** Installed evaluator: success requires the requested destination and the exact validated artifact. */
export function evaluateCompletion(
  state: Session,
  run: Run,
  profile: Profile,
  action: Extract<ModelAction, { type: 'outcome' }>,
): void {
  const contract = run.contract as unknown as TaskContract | undefined;
  if (profile.completion === 'proposal')
    check(action.proposal !== undefined, 'IA-ENGINE-COMPLETION-DENIED', 'Task requires an offered proposal');
  if (profile.completion !== 'artifact') return;
  check(
    contract?.artifact && action.kind === 'deliverable' && action.artifacts?.length,
    'IA-ENGINE-COMPLETION-DENIED',
    'Task requires its contracted artifact',
  );
  for (const id of action.artifacts) {
    const receipt = state.receipts.find(
      (r) => r.id === id && r.runId === run.id && r.effect === 'applied' && r.error === null,
    );
    const output = receipt?.output as
      | { candidateDigest?: string; artifactDigest?: string; destination?: Json }
      | undefined;
    check(
      receipt?.review &&
        receipt.target === contract.artifact.operation &&
        digest(receipt.review.destination) === digest(contract.artifact.destination) &&
        output?.candidateDigest === receipt.review.candidateDigest &&
        output.artifactDigest === receipt.review.artifactDigest &&
        digest(output.destination ?? null) === digest(contract.artifact.destination),
      'IA-ENGINE-COMPLETION-DENIED',
      'Receipt does not prove the exact requested artifact and destination',
    );
  }
}
