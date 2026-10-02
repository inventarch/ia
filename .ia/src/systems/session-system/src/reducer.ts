import { copy, digest, identifier, requireValue } from './codec.js';
import type { Attempt, Budget, Command, Event, Json, Limits, Mutation, Receipt, Run, Session } from './types.js';

const invariant = (condition: unknown, message: string): void =>
  requireValue(condition, 'IA-SESSION-TRANSITION-INVALID', message);
export const terminal = (run: Run): boolean => ['completed', 'failed', 'cancelled'].includes(run.status);
export function validateLimits(limits: Limits): void {
  const keys = ['steps', 'modelCalls', 'operations', 'tokens', 'children', 'depth', 'bytes', 'deadline'];
  invariant(Object.keys(limits).length === keys.length, 'Unknown or missing limit');
  for (const key of keys) {
    const value = limits[key as keyof Limits];
    invariant(Number.isSafeInteger(value) && value >= (key === 'deadline' ? 1 : 0), `Invalid limit ${key}`);
  }
}
function runOf(state: Session, id: string): Run {
  const run = state.runs[id];
  requireValue(run, 'IA-SESSION-TRANSITION-INVALID', 'Unknown run');
  return run;
}
export function unresolved(state: Session, runId?: string): Attempt[] {
  return Object.values(state.attempts).filter(
    (a) =>
      (runId === undefined || a.runId === runId) &&
      (a.status !== 'observed' || a.effect === 'unknown' || a.effect === 'partial'),
  );
}
/** The only renewable shape: settled human-wait leaves and their waiting ancestors. */
export function humanWaitRuns(state: Session): Run[] {
  if (
    unresolved(state).length ||
    state.controls.some((control) => !control.applied) ||
    Object.values(state.reactions).some((reaction) => reaction.required && reaction.status === 'queued')
  )
    return [];
  const live = Object.values(state.runs).filter((run) => !terminal(run));
  if (!live.length || Object.values(state.runs).some((run) => run.parentId && terminal(run) && !run.returned))
    return [];
  let humans = 0;
  for (const run of live) {
    if (
      run.status !== 'waiting' ||
      run.pendingAction !== null ||
      run.pauseRequested ||
      run.cancelRequested ||
      !run.wait?.objectIds.length
    )
      return [];
    const children = live.filter((child) => child.parentId === run.id);
    if (run.wait.reason === 'child') {
      if (
        !children.length ||
        children.length !== run.wait.objectIds.length ||
        children.some((child) => !run.wait!.objectIds.includes(child.id))
      )
        return [];
    } else if (run.wait.reason === 'input') {
      if (
        children.length ||
        !run.wait.objectIds.every(
          (id) => state.questions[id]?.runId === run.id && ['open', 'answered'].includes(state.questions[id]!.status),
        )
      )
        return [];
      humans++;
    } else if (run.wait.reason === 'review') {
      if (
        children.length ||
        !run.wait.objectIds.every(
          (id) =>
            state.proposals[id]?.runId === run.id &&
            !state.proposals[id]!.review &&
            ['offered', 'accepted', 'rejected'].includes(state.proposals[id]!.status),
        )
      )
        return [];
      humans++;
    } else return [];
  }
  return humans ? live.sort((a, b) => a.depth - b.depth) : [];
}
function newRun(
  id: string,
  profile: string,
  agent: string,
  task: Run['task'],
  parentId: string | null,
  depth: number,
): Run {
  identifier(id);
  invariant(
    typeof profile === 'string' && profile.length > 0 && typeof agent === 'string' && agent.length > 0,
    'Missing profile/agent',
  );
  return {
    id,
    parentId,
    profile,
    agent,
    task: copy(task),
    depth,
    status: 'created',
    wait: null,
    outcome: null,
    pendingAction: null,
    returned: false,
    cancelRequested: false,
    pauseRequested: false,
    transcript: [],
  };
}
function settle(state: Session, attempt: Attempt, usage: number | null): void {
  invariant(usage === null || (Number.isSafeInteger(usage) && usage >= 0), 'Invalid observed usage');
  state.budget.reservedTokens -= attempt.reservation;
  // Unknown billing is conservatively charged, not refunded on crash/cancel.
  state.budget.usedTokens += usage ?? attempt.reservation;
  attempt.usage = usage;
}
function receipt(
  state: Session,
  attempt: Attempt,
  at: string,
  sequence: number,
  reconciles: string | null = null,
): Receipt {
  return {
    version: 1,
    id: `${attempt.id}-${sequence}`,
    sessionId: state.id,
    runId: attempt.runId,
    actionId: attempt.invocationId,
    invocationId: attempt.invocationId,
    attemptId: attempt.id,
    sequence,
    target: attempt.target,
    bindingDigest: attempt.bindingDigest,
    inputDigest: attempt.inputDigest,
    authority: copy(attempt.authority),
    effect: attempt.effect,
    output: copy(attempt.output),
    error: attempt.error,
    usage: attempt.usage,
    at,
    reconciles,
    ...(attempt.cause ? { cause: copy(attempt.cause), actionId: attempt.cause.actionId } : {}),
    ...(attempt.review ? { review: copy(attempt.review) } : {}),
  };
}
function idle(state: Session, run: Run): void {
  invariant(!terminal(run), 'Terminal runs cannot change');
  invariant(unresolved(state, run.id).length === 0, 'Run has an unresolved attempt/effect');
}
function complete(state: Session, run: Run): void {
  idle(state, run);
  invariant(
    !Object.values(state.runs).some((r) => r.parentId === run.id && (!terminal(r) || !r.returned)),
    'A child has not returned',
  );
  invariant(
    !Object.values(state.questions).some((q) => q.runId === run.id && q.required && q.status === 'open'),
    'Required question is unanswered',
  );
  invariant(
    !Object.values(state.reactions).some((r) => r.runId === run.id && r.required && r.status === 'queued'),
    'Required reaction is pending',
  );
}

/** Pure reducer. All I/O and current-authority evaluation occur outside it. */
export function reduce(
  previous: Session | null,
  mutation: Mutation,
  actor: string,
  at: string,
  sequence: number,
): Session {
  return apply(previous ? copy(previous) : null, mutation, actor, at, sequence);
}
/** Internal fold over exclusively owned state; incoming mutation values are still copied. */
function apply(previous: Session | null, mutation: Mutation, actor: string, at: string, sequence: number): Session {
  invariant(
    typeof actor === 'string' && actor.length > 0 && Number.isFinite(Date.parse(at)),
    'Invalid event attribution/time',
  );
  if (mutation.type === 'session.create') {
    invariant(previous === null && sequence === 1, 'Session already exists');
    identifier(mutation.sessionId);
    validateLimits(mutation.limits);
    invariant(actor === mutation.principal, 'Creation principal mismatch');
    invariant(
      typeof mutation.workspace === 'string' &&
        mutation.workspace.length > 0 &&
        mutation.manifestDigest === digest(mutation.manifest),
      'Invalid workspace/manifest digest',
    );
    const budget: Budget = {
      usedTokens: 0,
      reservedTokens: 0,
      steps: 0,
      modelCalls: 0,
      operations: 0,
      children: 0,
      retainedBytes: 0,
    };
    return {
      version: 1,
      id: mutation.sessionId,
      principal: actor,
      workspace: mutation.workspace,
      manifestDigest: mutation.manifestDigest,
      manifest: copy(mutation.manifest),
      createdAt: at,
      rootId: mutation.rootId,
      sequence,
      hash: '',
      limits: copy(mutation.limits),
      budget,
      runs: {
        [mutation.rootId]: {
          ...newRun(mutation.rootId, mutation.profile, mutation.agent, mutation.task, null, 0),
          ...(mutation.contract ? { contract: copy(mutation.contract), limits: copy(mutation.limits) } : {}),
          ...(mutation.authority ? { authority: copy(mutation.authority) } : {}),
        },
      },
      attempts: {},
      questions: {},
      proposals: {},
      decisions: {},
      reactions: {},
      controls: [],
      receipts: [],
    };
  }
  requireValue(previous, 'IA-SESSION-NOT-FOUND', 'Session does not exist');
  const state = previous;
  requireValue(
    actor === state.principal ||
      (mutation.type === 'question.reply' && state.questions[mutation.questionId]?.respondent === actor) ||
      (mutation.type === 'proposal.review' && state.proposals[mutation.proposalId]?.review?.reviewer === actor),
    'IA-SESSION-AUTHORITY-DENIED',
    'Actor does not control this session',
  );
  invariant(sequence === state.sequence + 1, 'Nonconsecutive sequence');
  switch (mutation.type) {
    case 'run.ready': {
      const run = runOf(state, mutation.runId);
      idle(state, run);
      invariant(!run.cancelRequested && !run.pauseRequested, 'Run has a pending control');
      invariant(
        !Object.values(state.runs).some((r) => r.parentId === run.id && (!terminal(r) || !r.returned)),
        'Child work has not returned',
      );
      if (run.wait?.reason === 'input')
        invariant(
          run.wait.objectIds.every((id) => state.questions[id]?.status === 'answered'),
          'Question wait is unresolved',
        );
      if (run.wait?.reason === 'review')
        invariant(
          run.wait.objectIds.every((id) => ['accepted', 'rejected'].includes(state.proposals[id]?.status ?? '')),
          'Review wait is unresolved',
        );
      run.status = 'running';
      run.wait = null;
      break;
    }
    case 'attempt.prepare': {
      const value = mutation.attempt,
        run = runOf(state, value.runId);
      identifier(value.id);
      identifier(value.invocationId);
      invariant(run.status === 'running' && !run.cancelRequested && !run.pauseRequested, 'Run is not runnable');
      invariant(
        !state.attempts[value.id] && unresolved(state).length === 0,
        'Attempt exists or another effect is unresolved',
      );
      invariant(Date.parse(at) < state.limits.deadline, 'Session deadline exhausted');
      invariant(value.inputDigest === digest(value.input), 'Input digest mismatch');
      invariant(Number.isSafeInteger(value.reservation) && value.reservation >= 0, 'Invalid reservation');
      invariant(
        state.budget.usedTokens + state.budget.reservedTokens + value.reservation <= state.limits.tokens,
        'Token budget exhausted',
      );
      if (value.kind === 'model') {
        invariant(state.budget.modelCalls < state.limits.modelCalls, 'Model call budget exhausted');
        state.budget.modelCalls++;
      } else {
        invariant(state.budget.operations < state.limits.operations, 'Operation budget exhausted');
        state.budget.operations++;
      }
      const previousAttempts = Object.values(state.attempts).filter((a) => a.invocationId === value.invocationId);
      const prior = previousAttempts[0];
      invariant(
        !prior ||
          (prior.inputDigest === value.inputDigest &&
            prior.bindingDigest === value.bindingDigest &&
            prior.target === value.target &&
            prior.runId === value.runId),
        'Invocation retry changes its contract',
      );
      invariant(
        previousAttempts.every((a) => a.effect === 'none' && a.status === 'observed'),
        'An observed applied invocation cannot be repeated',
      );
      invariant(
        !prior ||
          (digest(prior.review ?? null) === digest(value.review ?? null) &&
            digest(prior.cause ?? null) === digest(value.cause ?? null)),
        'Invocation retry changes review or causation',
      );
      if (value.cause) {
        invariant(
          value.cause.modelAttemptId === null || state.attempts[value.cause.modelAttemptId]?.runId === run.id,
          'Unknown model cause',
        );
        invariant(
          value.cause.questions.every((id) => state.questions[id]?.runId === run.id) &&
            value.cause.proposals.every((id) => state.proposals[id]?.runId === run.id) &&
            value.cause.decisions.every((id) => state.decisions[id]?.runId === run.id) &&
            value.cause.receipts.every((id) => state.receipts.some((r) => r.id === id && r.runId === run.id)),
          'Unknown causal reference',
        );
      }
      state.budget.reservedTokens += value.reservation;
      state.attempts[value.id] = {
        ...copy(value),
        ...(value.cause ? { preparedSequence: sequence } : {}),
        status: 'prepared',
        effect: 'none',
        actionAccepted: false,
        output: null,
        error: null,
        usage: null,
        preparedAt: at,
        observedAt: null,
      };
      if (value.kind !== 'model') {
        run.pendingAction = null;
        delete run.retryOf;
      }
      break;
    }
    case 'attempt.dispatch': {
      const attempt = state.attempts[mutation.attemptId];
      invariant(attempt?.status === 'prepared', 'Attempt is not prepared');
      const a = attempt!;
      const run = runOf(state, a.runId);
      invariant(!run.cancelRequested && !run.pauseRequested && run.status === 'running', 'Dispatch is stopped');
      invariant(!state.controls.some((c) => !c.applied), 'Control must be applied before another dispatch');
      a.status = 'dispatched';
      a.effect = a.kind === 'model' ? 'none' : 'unknown';
      break;
    }
    case 'attempt.abandon': {
      const attempt = state.attempts[mutation.attemptId];
      invariant(attempt?.status === 'prepared', 'Only undispatched preparation may be abandoned');
      const a = attempt!;
      a.status = 'observed';
      a.error = 'not-dispatched';
      a.observedAt = at;
      settle(state, a, 0);
      state.receipts.push(receipt(state, a, at, sequence));
      break;
    }
    case 'attempt.observe': {
      const attempt = state.attempts[mutation.attemptId];
      invariant(attempt?.status === 'dispatched', 'Attempt is not dispatched or is already observed');
      const a = attempt!;
      invariant(['none', 'applied', 'partial', 'unknown'].includes(mutation.effect), 'Invalid effect');
      a.status = 'observed';
      a.output = copy(mutation.output);
      a.effect = mutation.effect;
      a.error = mutation.error;
      a.observedAt = at;
      settle(state, a, mutation.usage);
      state.receipts.push(receipt(state, a, at, sequence, mutation.reconciles ?? null));
      runOf(state, a.runId).transcript.push({
        kind: a.kind,
        target: a.target,
        output: a.output,
        error: a.error,
        receipt: state.receipts.at(-1)!.id,
      });
      break;
    }
    case 'attempt.reconcile.start': {
      const a = state.attempts[mutation.attemptId];
      invariant(
        a?.kind === 'operation' && (a.status === 'dispatched' || a.effect === 'unknown' || a.effect === 'partial'),
        'No operation needs reconciliation',
      );
      invariant(
        Number.isSafeInteger(mutation.maxAttempts) &&
          mutation.maxAttempts > 0 &&
          (a!.reconciliations ?? 0) < mutation.maxAttempts,
        'Reconciliation allowance exhausted',
      );
      invariant(
        state.budget.operations < state.limits.operations && Date.parse(at) < state.limits.deadline,
        'Reconciliation budget exhausted',
      );
      a!.reconciliations = (a!.reconciliations ?? 0) + 1;
      state.budget.operations++;
      break;
    }
    case 'attempt.reconcile': {
      const attempt = state.attempts[mutation.attemptId];
      invariant(
        attempt && (attempt.status === 'dispatched' || attempt.effect === 'unknown' || attempt.effect === 'partial'),
        'No unresolved attempt',
      );
      invariant(
        typeof mutation.evidence === 'string' &&
          mutation.evidence.length > 0 &&
          ['none', 'applied', 'partial', 'unknown'].includes(mutation.effect),
        'Reconciliation needs evidence',
      );
      const a = attempt!;
      if (a.status !== 'observed') settle(state, a, null);
      a.status = 'observed';
      a.effect = mutation.effect;
      a.output = copy(mutation.output);
      a.observedAt = at;
      if (mutation.error !== undefined) a.error = mutation.error;
      if (a.kind === 'model' && mutation.output === null) a.error = 'response-unavailable';
      state.receipts.push(receipt(state, a, at, sequence, a.id));
      runOf(state, a.runId).transcript.push({
        kind: 'reconciliation',
        attemptId: a.id,
        evidence: mutation.evidence,
        output: a.output,
        effect: a.effect,
        ...(mutation.error !== undefined ? { target: a.target, receipt: state.receipts.at(-1)!.id } : {}),
      });
      break;
    }
    case 'action.accept': {
      const run = runOf(state, mutation.runId);
      idle(state, run);
      invariant(run.status === 'running' && run.pendingAction === null, 'Action is already pending');
      const attempt = state.attempts[mutation.attemptId];
      invariant(
        attempt?.kind === 'model' &&
          attempt.status === 'observed' &&
          attempt.runId === run.id &&
          !attempt.actionAccepted &&
          attempt.error === null,
        'Model response is unavailable or already accepted',
      );
      invariant(state.budget.steps < state.limits.steps, 'Step limit exhausted');
      state.budget.steps++;
      attempt!.actionAccepted = true;
      if (mutation.cause) run.cause = copy(mutation.cause);
      run.pendingAction = copy(mutation.action);
      run.transcript.push({ kind: 'action', action: copy(mutation.action) });
      break;
    }
    case 'attempt.retry': {
      const a = state.attempts[mutation.attemptId];
      invariant(
        a?.kind === 'operation' && a.status === 'observed' && a.effect === 'none',
        'Retry requires a settled absent operation',
      );
      const run = runOf(state, a!.runId);
      idle(state, run);
      invariant(
        run.pendingAction === null &&
          run.wait?.objectIds.includes(a!.id) &&
          !run.cancelRequested &&
          !run.pauseRequested,
        'Retry is not pending',
      );
      const attempts = Object.values(state.attempts).filter((v) => v.invocationId === a!.invocationId);
      const last = attempts.sort((x, y) => (x.preparedSequence ?? 0) - (y.preparedSequence ?? 0)).at(-1);
      invariant(
        Number.isSafeInteger(mutation.maxAttempts) &&
          mutation.maxAttempts > 0 &&
          attempts.length < mutation.maxAttempts &&
          last?.id === a!.id,
        'Retry allowance exhausted',
      );
      run.retryOf = a!.id;
      run.pendingAction = copy(mutation.action);
      run.status = 'running';
      run.wait = null;
      break;
    }
    case 'model.repair': {
      const a = state.attempts[mutation.attemptId];
      invariant(a?.kind === 'model' && a.status === 'observed', 'Repair requires an observed model attempt');
      const run = runOf(state, a!.runId);
      idle(state, run);
      invariant(
        run.pendingAction === null &&
          ['invalid-model-action', 'model-error'].includes(run.wait?.reason ?? '') &&
          run.wait?.objectIds.includes(a!.id) &&
          !run.cancelRequested &&
          !run.pauseRequested,
        'No model repair is pending',
      );
      invariant(
        mutation.details === undefined || digest(mutation.details) === digest(run.wait!.details),
        'Repair diagnostic changed',
      );
      invariant(
        Number.isSafeInteger(mutation.allowance) && (run.repairs ?? 0) < mutation.allowance,
        'Repair allowance exhausted',
      );
      run.repairs = (run.repairs ?? 0) + 1;
      a!.actionAccepted = true;
      run.wait = null;
      run.status = 'running';
      run.transcript.push({
        kind: 'repair',
        attemptId: a!.id,
        instruction: 'The previous model response failed. Return one valid action under the same task contract.',
        ...(mutation.details !== undefined ? { details: copy(mutation.details) } : {}),
      });
      break;
    }
    case 'action.clear': {
      const run = runOf(state, mutation.runId);
      invariant(!terminal(run), 'Run is terminal');
      run.pendingAction = null;
      break;
    }
    case 'run.wait': {
      const run = runOf(state, mutation.runId);
      invariant(!terminal(run), 'Run is terminal');
      run.status = 'waiting';
      run.wait = copy(mutation.wait);
      break;
    }
    case 'outcome.accept': {
      const run = runOf(state, mutation.runId);
      idle(state, run);
      for (const q of mutation.questions ?? []) {
        identifier(q.id);
        invariant(
          !state.questions[q.id] &&
            q.runId === run.id &&
            q.status === 'open' &&
            q.revision === 1 &&
            q.prompt.length > 0 &&
            q.respondent.length > 0 &&
            q.digest ===
              digest({ prompt: q.prompt, respondent: q.respondent, choices: q.choices, revision: q.revision }),
          'Invalid question',
        );
        state.questions[q.id] = copy(q);
      }
      const p = mutation.proposal;
      if (p) {
        identifier(p.id);
        invariant(
          !state.proposals[p.id] && p.runId === run.id && p.status === 'offered' && p.digest === digest(p.candidate),
          'Invalid offered proposal',
        );
        if (p.review)
          invariant(
            p.review.candidateDigest === p.digest &&
              p.review.reviewer.length > 0 &&
              p.review.expiresAt > Date.parse(at),
            'Invalid review contract',
          );
        state.proposals[p.id] = copy(p);
      }
      run.outcome = copy(mutation.outcome);
      run.pendingAction = null;
      run.transcript.push({ kind: 'outcome', outcome: copy(mutation.outcome) });
      if (mutation.terminal) {
        complete(state, run);
        run.status = mutation.terminal;
        run.wait = null;
      } else if (mutation.wait) {
        run.status = 'waiting';
        run.wait = copy(mutation.wait);
      }
      break;
    }
    case 'question.reply': {
      const q = state.questions[mutation.questionId];
      invariant(
        q?.status === 'open' && q.revision === mutation.revision && q.digest === mutation.digest,
        'Question is stale',
      );
      invariant(
        q!.respondent === actor &&
          (!q!.choices.length || (typeof mutation.answer === 'string' && q!.choices.includes(mutation.answer))),
        'Wrong respondent or answer choice',
      );
      q!.answer = copy(mutation.answer);
      q!.status = 'answered';
      runOf(state, q!.runId).transcript.push({
        kind: 'answer',
        questionId: q!.id,
        actor,
        answer: copy(mutation.answer),
      });
      break;
    }
    case 'proposal.review': {
      const p = state.proposals[mutation.proposalId];
      invariant(
        p?.status === 'offered' && p.revision === mutation.revision && p.digest === mutation.digest,
        'Proposal is stale',
      );
      if (p!.review)
        invariant(
          p!.review.reviewer === actor && p!.review.expiresAt > Date.parse(at),
          'Wrong reviewer or expired review',
        );
      identifier(mutation.decisionId);
      invariant(!state.decisions[mutation.decisionId], 'Decision exists');
      p!.status = mutation.accept ? 'accepted' : 'rejected';
      p!.decisionId = mutation.decisionId;
      state.decisions[mutation.decisionId] = {
        id: mutation.decisionId,
        runId: p!.runId,
        subject: p!.id,
        revision: p!.revision,
        choice: p!.status,
        actor,
        rationale: mutation.rationale,
        evidence: [p!.digest],
        ...(p!.review ? { review: copy(p!.review), proposalDigest: p!.digest } : {}),
      };
      runOf(state, p!.runId).transcript.push({
        kind: 'review',
        proposalId: p!.id,
        decisionId: mutation.decisionId,
        choice: p!.status,
        actor,
      });
      break;
    }
    case 'decision.record': {
      const d = mutation.decision;
      identifier(d.id);
      invariant(!state.decisions[d.id] && d.actor === actor && d.choice.length > 0, 'Invalid attributed decision');
      runOf(state, d.runId);
      state.decisions[d.id] = copy(d);
      break;
    }
    case 'child.create': {
      const parent = runOf(state, mutation.parentId);
      idle(state, parent);
      invariant(parent.status === 'running' && !state.runs[mutation.childId], 'Parent unavailable or child exists');
      invariant(
        parent.depth < state.limits.depth && state.budget.children < state.limits.children,
        'Delegation limits exceeded',
      );
      for (
        let cursor: Run | undefined = parent;
        cursor;
        cursor = cursor.parentId ? state.runs[cursor.parentId] : undefined
      )
        invariant(cursor.agent !== mutation.agent, 'Ancestor agent cycle');
      state.runs[mutation.childId] = newRun(
        mutation.childId,
        mutation.profile,
        mutation.agent,
        mutation.task,
        parent.id,
        parent.depth + 1,
      );
      state.budget.children++;
      const child = state.runs[mutation.childId]!;
      if (mutation.contract) child.contract = copy(mutation.contract);
      if (mutation.authority) child.authority = copy(mutation.authority);
      if (mutation.limits) {
        validateLimits(mutation.limits);
        child.limits = copy(mutation.limits);
      }
      if (mutation.cause) child.cause = copy(mutation.cause);
      parent.pendingAction = null;
      parent.status = 'waiting';
      parent.wait = {
        id: mutation.childId,
        reason: 'child',
        objectIds: [mutation.childId],
        continuation: 'continue',
        details: null,
      };
      break;
    }
    case 'child.return': {
      const child = runOf(state, mutation.childId);
      invariant(child.parentId && terminal(child) && !child.returned, 'Child cannot return');
      const parent = runOf(state, child.parentId!);
      invariant(!terminal(parent), 'Parent is terminal');
      child.returned = true;
      parent.transcript.push({ kind: 'child', childId: child.id, status: child.status, outcome: child.outcome });
      parent.wait = null;
      parent.status = parent.cancelRequested ? 'cancelling' : parent.pauseRequested ? 'paused' : 'running';
      break;
    }
    case 'control.submit': {
      const c = mutation.control;
      identifier(c.id);
      invariant(c.actor === actor && !c.applied && !state.controls.some((v) => v.id === c.id), 'Invalid control');
      invariant(!terminal(runOf(state, c.runId)), 'Run is terminal');
      invariant(['pause', 'cancel', 'resume'].includes(c.kind), 'Unknown control');
      state.controls.push(copy(c));
      break;
    }
    case 'control.apply': {
      const c = state.controls.find((v) => v.id === mutation.controlId);
      invariant(c && !c.applied, 'Unknown/applied control');
      const root = runOf(state, c!.runId);
      const affected = (run: Run): boolean => {
        for (let r: Run | undefined = run; r; r = r.parentId ? state.runs[r.parentId] : undefined)
          if (r.id === root.id) return true;
        return false;
      };
      for (const run of Object.values(state.runs)
        .filter((r) => affected(r) && !terminal(r))
        .sort((a, b) => b.depth - a.depth)) {
        if (c!.kind === 'resume') {
          invariant(!run.cancelRequested, 'Cancellation cannot be resumed');
          run.pauseRequested = false;
          run.status = run.wait ? 'waiting' : 'running';
        } else {
          if (c!.kind === 'cancel') run.cancelRequested = true;
          else run.pauseRequested = true;
          for (const a of unresolved(state, run.id).filter((a) => a.status === 'prepared')) {
            a.status = 'observed';
            a.effect = 'none';
            a.error = 'cancelled-before-dispatch';
            a.observedAt = at;
            settle(state, a, 0);
            state.receipts.push(receipt(state, a, at, sequence));
          }
          const pending = unresolved(state, run.id),
            children = Object.values(state.runs).filter((child) => child.parentId === run.id && !terminal(child));
          if (pending.length || children.length) {
            run.status = 'waiting';
            run.wait = {
              id: c!.id,
              reason: pending.length ? 'unknown-effect' : 'child',
              objectIds: [...pending.map((a) => a.id), ...children.map((child) => child.id)],
              continuation: c!.kind,
              details: null,
            };
          } else {
            run.status = c!.kind === 'cancel' ? 'cancelled' : 'paused';
            if (run.wait?.reason === 'unknown-effect') run.wait = null;
            if (c!.kind === 'cancel') {
              run.pendingAction = null;
              run.wait = null;
            }
          }
        }
      }
      c!.applied = true;
      break;
    }
    case 'session.rebind': {
      invariant(
        unresolved(state).length === 0 && !Object.values(state.runs).every(terminal),
        'Cannot rebind unresolved/terminal work',
      );
      invariant(mutation.manifestDigest === digest(mutation.manifest), 'Manifest mismatch');
      state.manifestDigest = mutation.manifestDigest;
      state.manifest = copy(mutation.manifest);
      break;
    }
    case 'session.renew': {
      const runs = humanWaitRuns(state),
        now = Date.parse(at);
      invariant(
        runs.length > 0 &&
          mutation.expectedSequence === state.sequence &&
          mutation.previousDeadline === state.limits.deadline,
        'Renewal requires the exact settled human wait',
      );
      invariant(
        Number.isSafeInteger(mutation.deadline) && mutation.deadline > Math.max(state.limits.deadline, now),
        'Renewal deadline must advance',
      );
      invariant(
        Object.keys(mutation.runs).length === runs.length && runs.every((run) => Object.hasOwn(mutation.runs, run.id)),
        'Renewal must include every live run',
      );
      for (const run of runs) {
        const value = mutation.runs[run.id]!;
        invariant(
          run.limits &&
            value.previousDeadline === run.limits.deadline &&
            Number.isSafeInteger(value.deadline) &&
            value.deadline > Math.max(run.limits.deadline, now) &&
            value.deadline <= mutation.deadline,
          'Invalid run renewal deadline',
        );
        if (run.parentId)
          invariant(value.deadline <= mutation.runs[run.parentId]!.deadline, 'Renewal exceeds an ancestor deadline');
        const authority = run.authority;
        invariant(
          authority && typeof authority === 'object' && !Array.isArray(authority),
          'Legacy authority cannot be renewed',
        );
        const ceiling = (authority as Record<string, Json>)['limits'];
        invariant(
          ceiling && typeof ceiling === 'object' && !Array.isArray(ceiling),
          'Legacy authority limits cannot be renewed',
        );
        const limits = ceiling as unknown as Limits;
        validateLimits(limits);
        const expiresAt = (authority as Record<string, Json>)['expiresAt'];
        invariant(
          typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt),
          'Legacy authority expiry cannot be renewed',
        );
        run.limits!.deadline = value.deadline;
        limits.deadline = Math.max(limits.deadline, value.deadline);
        (authority as Record<string, Json>)['expiresAt'] = Math.max(expiresAt as number, value.deadline);
      }
      state.limits.deadline = mutation.deadline;
      break;
    }
    case 'budget.extend': {
      validateLimits(mutation.limits);
      for (const key of Object.keys(state.limits) as (keyof Limits)[])
        invariant(mutation.limits[key] >= state.limits[key], 'Budget cannot shrink below prior ceiling');
      state.limits = copy(mutation.limits);
      break;
    }
    case 'reaction.queue': {
      const r = mutation.reaction;
      identifier(r.id);
      invariant(!state.reactions[r.id] && r.status === 'queued', 'Reaction already exists');
      if (r.required) invariant(!terminal(runOf(state, r.runId)), 'Required reaction cannot attach after completion');
      state.reactions[r.id] = copy(r);
      break;
    }
    case 'reaction.settle': {
      const r = state.reactions[mutation.reactionId];
      invariant(r?.status === 'queued', 'Reaction already settled or absent');
      r!.status = 'settled';
      r!.result = copy(mutation.result);
      break;
    }
    default:
      invariant(false, 'Unknown mutation');
  }
  state.sequence = sequence;
  return state;
}

export function replay(events: readonly Event[], starting: Session | null = null): Session {
  let state = starting ? copy(starting) : null;
  for (const event of events) {
    const { hash, ...body } = event;
    requireValue(
      event.version === (event.mutation.type === 'session.renew' ? 2 : 1),
      'IA-SESSION-VERSION-UNSUPPORTED',
      'Unsupported event version or mutation/version combination',
    );
    requireValue(
      event.sequence === (state?.sequence ?? 0) + 1 && event.previous === (state?.hash ?? '') && digest(body) === hash,
      'IA-SESSION-STORE-CORRUPT',
      'Event chain/version/digest mismatch',
    );
    requireValue(
      !state || state.id === event.sessionId,
      'IA-SESSION-STORE-CORRUPT',
      'Event belongs to another session',
    );
    state = apply(state, event.mutation, event.actor, event.at, event.sequence);
    state.hash = hash;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    state.budget.retainedBytes += bytes;
    const m = event.mutation;
    const runId =
      'runId' in m
        ? m.runId
        : m.type === 'attempt.prepare'
          ? m.attempt.runId
          : 'attemptId' in m
            ? state.attempts[m.attemptId]?.runId
            : 'childId' in m
              ? m.childId
              : 'questionId' in m
                ? state.questions[m.questionId]?.runId
                : 'proposalId' in m
                  ? state.proposals[m.proposalId]?.runId
                  : state.rootId;
    for (let run = state.runs[runId ?? state.rootId]; run; run = run.parentId ? state.runs[run.parentId] : undefined)
      if (run.contract) run.retainedBytes = (run.retainedBytes ?? 0) + bytes;
  }
  requireValue(state, 'IA-SESSION-NOT-FOUND', 'Session has no creation event');
  return state;
}
export function eventFor(previous: Session | null, command: Command, at: string): Event {
  const body: Omit<Event, 'hash'> = {
    version: command.mutation.type === 'session.renew' ? 2 : 1,
    id: command.id,
    sequence: command.expected + 1,
    sessionId: command.sessionId,
    actor: command.actor,
    at,
    cause: command.cause ?? null,
    mutation: copy(command.mutation),
    previous: previous?.hash ?? '',
  };
  return { ...body, hash: digest(body) };
}
