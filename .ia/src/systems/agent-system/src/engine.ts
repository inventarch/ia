import { randomUUID } from 'node:crypto';
import { canonical, copy, digest, terminal, unresolved, humanWaitRuns, SessionError } from '@inventarch/session-system';
import type { Attempt, Json, Limits, Mutation, Owner, Question, Run, Session, Wait } from '@inventarch/session-system';
import { check, EngineError, parseAction, validateShape } from './action.js';
import { DEFAULT_MODEL_REQUEST_BYTES, MAX_MODEL_REQUEST_BYTES } from './types.js';
import type {
  EngineHost,
  Grant,
  Manifest,
  ModelAction,
  ModelRequest,
  ModelResponse,
  OperationContext,
  OperationDefinition,
  Profile,
  StartRequest,
} from './types.js';
import {
  admittedReview,
  boundedLimits,
  causes,
  evaluateCompletion,
  narrowGrant,
  offerReview,
  operationAllowed,
  taskContract,
} from './contracts.js';

const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const modelOutputTokens = 2048;
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // The losing adapter promise retains rejection handling, but no admission callback.
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
      stopped,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
const repairableActionCodes = new Set([
  'IA-ENGINE-ACTION-INVALID',
  'IA-ENGINE-INPUT-INVALID',
  'IA-ENGINE-DELEGATION-DENIED',
  'IA-ENGINE-TASK-INVALID',
  'IA-ENGINE-OUTCOME-DENIED',
  'IA-ENGINE-EVIDENCE-INVALID',
  'IA-ENGINE-COMPLETION-DENIED',
  'IA-ENGINE-CANDIDATE-UNVERIFIED',
]);
export function manifestDigest(manifest: Omit<Manifest, 'digest'> | Manifest): string {
  const { digest: _digest, ...body } = manifest as Manifest;
  return digest(body);
}
/** One shared scheduler; hosts provide single-attempt adapters and authenticated grants. */
export class Engine {
  readonly manifest: Manifest;
  constructor(
    manifest: Manifest,
    private readonly host: EngineHost,
  ) {
    check(
      manifest.version === 1 && manifest.digest === manifestDigest(manifest),
      'IA-ENGINE-MANIFEST-INVALID',
      'Manifest version/digest mismatch',
    );
    // Reactions need a qualified causal outbox consumer before they may be enabled.
    check(
      manifest.reactions.length === 0,
      'IA-ENGINE-BINDING-UNAVAILABLE',
      'Event reaction bindings are not installed in this execution profile',
    );
    for (const profile of Object.values(manifest.profiles))
      if (profile.contract) {
        check(
          profile.contract.completionEvaluator === 'ia.completion.v1' &&
            Number.isSafeInteger(profile.contract.repairAttempts) &&
            profile.contract.repairAttempts >= 0 &&
            Number.isSafeInteger(profile.contract.maxAttempts) &&
            profile.contract.maxAttempts > 0,
          'IA-ENGINE-BINDING-UNAVAILABLE',
          'Unsupported completion or recovery contract',
        );
        const requestBytes = profile.contract.requestBytes;
        check(
          requestBytes === undefined ||
            (Number.isSafeInteger(requestBytes) && requestBytes > 0 && requestBytes <= MAX_MODEL_REQUEST_BYTES),
          'IA-ENGINE-BINDING-UNAVAILABLE',
          'Unsupported installed model request ceiling',
        );
      }
    this.manifest = copy(manifest);
  }
  private now(): number {
    return this.host.now?.() ?? Date.now();
  }
  private attemptSignal(
    state: Session | null,
    run: Run | undefined,
    grant: Grant | undefined,
    timeoutMs: number,
    caller?: AbortSignal,
  ): AbortSignal {
    const remaining =
      Math.min(
        state?.limits.deadline ?? Infinity,
        run?.limits?.deadline ?? Infinity,
        grant?.limits.deadline ?? Infinity,
        grant?.expiresAt ?? Infinity,
      ) - this.now();
    const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(Math.min(timeoutMs, remaining))));
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }
  private checks(profile: Profile, phase: 'before-effect' | 'completion'): string[] {
    return profile.contract
      ? profile.contract.checks.filter((c) => c.phases.includes(phase)).map((c) => c.id)
      : profile.checks;
  }
  private dispatchBudget(state: Session, run: Run, grant: Grant): void {
    const used = state.budget,
      limits = grant.limits;
    check(
      this.now() < Math.min(state.limits.deadline, run.limits?.deadline ?? Infinity, limits.deadline) &&
        used.steps <= limits.steps &&
        used.modelCalls <= limits.modelCalls &&
        used.operations <= limits.operations &&
        used.children <= limits.children &&
        used.usedTokens + used.reservedTokens <= limits.tokens &&
        used.retainedBytes <= limits.bytes,
      'IA-ENGINE-LIMIT-EXCEEDED',
      'Current task budget no longer admits dispatch',
    );
  }
  private async grant(
    principal: string,
    state: Session | null,
    profile: Profile,
    run?: Run,
    signal?: AbortSignal,
  ): Promise<Grant> {
    check(
      state === null || (state.principal === principal && state.manifestDigest === digest(this.manifest)),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Principal or manifest changed',
    );
    const timed = this.attemptSignal(state, run, undefined, 60_000, signal);
    check(
      await bounded(() => this.host.verifyManifest(this.manifest), timed),
      'IA-ENGINE-SOURCE-CHANGED',
      'Pinned inputs or executable bindings are unavailable',
    );
    const grant = await bounded(() => this.host.authorize(principal, this.manifest, state), timed);
    check(
      grant.principal === principal &&
        grant.workspace === this.manifest.workspace &&
        grant.expiresAt > this.now() &&
        grant.profiles.includes(profile.id),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Current grant does not authorize this profile',
    );
    const effective = narrowGrant(grant, run?.authority as unknown as Grant | undefined);
    effective.operations = effective.operations.filter((id) => profile.operations.includes(id));
    if (profile.contract) effective.effects = effective.effects.filter((e) => profile.contract!.effects.includes(e));
    check(
      effective.profiles.includes(profile.id),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Profile exceeds the inherited authority',
    );
    return effective;
  }
  private effectContext(
    state: Session,
    run: Run,
    profile: Profile,
    operation: OperationDefinition,
    action: Extract<ModelAction, { type: 'invoke' }>,
    grant: Grant,
    owner: Owner,
    id: string,
    invocationId: string,
    review: OperationContext['review'],
    signal: AbortSignal,
    reconciling = false,
  ): OperationContext {
    // Keep a stable abort source in every signal derived for this attempt. A fresh grant
    // must stop an already-running adapter race, not merely replace its context property.
    const narrowed = new AbortController();
    const context: OperationContext = {
      sessionId: state.id,
      runId: run.id,
      invocationId,
      attemptId: id,
      principal: state.principal,
      agent: profile.agent,
      grant,
      manifest: this.manifest,
      owner,
      signal: AbortSignal.any([signal, narrowed.signal]),
      ...(review ? { review } : {}),
    };
    context.assertCurrent = async () => {
      context.signal.throwIfAborted();
      await this.host.store.validate(owner);
      const latest = await this.host.store.read(state.id),
        active = latest.runs[run.id]!,
        current = await this.grant(state.principal, latest, profile, active, context.signal);
      const attempt = latest.attempts[id];
      check(
        attempt &&
          attempt.inputDigest === digest(action.input) &&
          attempt.bindingDigest === operation.digest &&
          (reconciling
            ? attempt.status === 'dispatched' || attempt.effect === 'unknown' || attempt.effect === 'partial'
            : attempt.status === 'prepared' || attempt.status === 'dispatched'),
        'IA-ENGINE-BINDING-UNAVAILABLE',
        'Prepared effect contract is unavailable',
      );
      this.dispatchBudget(latest, active, current);
      operationAllowed(operation, profile, current);
      admittedReview(latest, active, operation, action, current, this.now(), id);
      context.grant = current;
      const ceiling = this.attemptSignal(latest, active, current, operation.timeoutMs, context.signal);
      if (ceiling.aborted) narrowed.abort(ceiling.reason);
      else ceiling.addEventListener('abort', () => narrowed.abort(ceiling.reason), { once: true });
      for (const checkId of this.checks(profile, 'before-effect')) {
        const result = await bounded(
          () =>
            this.host.evaluate(
              checkId,
              json({ phase: 'before-effect', action, contract: active.contract ?? null }),
              current,
            ),
          context.signal,
        );
        check(result.status === 'pass', 'IA-ENGINE-GOVERNANCE-DENIED', `Required evaluator ${checkId} did not pass`);
      }
      check(
        this.host.preflight &&
          (await bounded(() => this.host.preflight!(operation, action.input, context), context.signal)),
        'IA-ENGINE-DESTINATION-DENIED',
        'Current destination/binding preflight is unavailable or denied',
      );
      const controls = await this.host.store.read(state.id);
      check(
        reconciling ||
          (!controls.runs[run.id]!.cancelRequested &&
            !controls.runs[run.id]!.pauseRequested &&
            !controls.controls.some((c) => !c.applied)),
        'IA-ENGINE-AUTHORITY-DENIED',
        'A control stopped the pending effect',
      );
      context.signal.throwIfAborted();
      await this.host.store.validate(owner);
      context.signal.throwIfAborted();
      check(
        current.expiresAt > this.now(),
        'IA-ENGINE-AUTHORITY-DENIED',
        'Current effect grant expired before publication',
      );
      this.dispatchBudget(latest, active, current);
    };
    return context;
  }
  async start(request: StartRequest): Promise<Session> {
    const profile = this.manifest.profiles[request.profile];
    check(profile, 'IA-ENGINE-PROFILE-UNAVAILABLE', 'Profile is not installed');
    const grant = await this.grant(request.principal, null, profile);
    let prior: Session | null = null;
    try {
      prior = await this.host.store.read(request.sessionId);
    } catch (error) {
      if (!(error instanceof SessionError && error.code === 'IA-SESSION-NOT-FOUND')) throw error;
    }
    const limits = boundedLimits(
      { ...(prior?.limits ?? grant.limits), ...request.limits },
      profile.contract?.limits,
      this.now(),
    );
    for (const key of Object.keys(limits) as (keyof Limits)[])
      check(limits[key] <= grant.limits[key], 'IA-ENGINE-AUTHORITY-DENIED', 'Requested budget exceeds grant');
    const contract = taskContract(profile, request.task, request.artifact);
    await this.host.store.command({
      id: request.commandId,
      sessionId: request.sessionId,
      actor: request.principal,
      expected: 0,
      mutation: {
        type: 'session.create',
        sessionId: request.sessionId,
        principal: request.principal,
        workspace: this.manifest.workspace,
        manifest: json(this.manifest),
        manifestDigest: digest(this.manifest),
        rootId: 'root',
        profile: profile.id,
        agent: profile.agent,
        task: request.task,
        limits,
        ...(!prior || prior.runs[prior.rootId]?.contract
          ? { contract: json(contract), authority: prior?.runs[prior.rootId]?.authority ?? json(grant) }
          : {}),
      },
    });
    return this.host.store.read(request.sessionId);
  }
  async advance(
    sessionId: string,
    principal: string,
    options: { maxActions?: number; signal?: AbortSignal } = {},
  ): Promise<Session> {
    check(
      Number.isSafeInteger(options.maxActions ?? 32) &&
        (options.maxActions ?? 32) > 0 &&
        (options.maxActions ?? 32) <= 128,
      'IA-ENGINE-INPUT-INVALID',
      'Advance requires 1..128 scheduler actions',
    );
    const store = this.host.store,
      initial = await store.read(sessionId);
    check(initial.principal === principal, 'IA-ENGINE-AUTHORITY-DENIED', 'Session belongs to another principal');
    const owner = await store.acquire(sessionId);
    const save = async (mutation: Mutation, following?: Mutation[]): Promise<void> => {
      // Controls may arrive during an attempt. Retry the same internal mutation against its new head.
      for (let retry = 0; ; retry++) {
        const state = await store.read(sessionId);
        try {
          await store.command(
            {
              id: randomUUID(),
              sessionId,
              actor: principal,
              expected: state.sequence,
              mutation,
              ...(following ? { following } : {}),
            },
            owner,
          );
          return;
        } catch (error) {
          if (!(error instanceof SessionError && error.code === 'IA-SESSION-REVISION-CONFLICT' && retry < 4))
            throw error;
        }
      }
    };
    try {
      for (let count = 0; count < (options.maxActions ?? 32); count++) {
        let state = await store.read(sessionId);
        if (terminal(state.runs[state.rootId]!)) break;
        const control = state.controls.find((c) => !c.applied);
        if (control) {
          await save({ type: 'control.apply', controlId: control.id });
          continue;
        }
        const pending = unresolved(state)[0];
        if (pending) {
          if (!(await this.recover(state, pending, owner, save, options.signal))) break;
          continue;
        }
        const finishedChild = Object.values(state.runs).find(
          (r) => r.parentId !== null && terminal(r) && !r.returned && !terminal(state.runs[r.parentId]!),
        );
        if (finishedChild) {
          await save({ type: 'child.return', childId: finishedChild.id });
          continue;
        }
        const run = Object.values(state.runs)
          .filter((r) => !terminal(r))
          .sort((a, b) => b.depth - a.depth)[0]!;
        if (run.cancelRequested || run.pauseRequested) {
          if (run.status === 'paused') break;
          const id = randomUUID();
          await save(
            {
              type: 'control.submit',
              control: {
                id,
                actor: principal,
                runId: run.id,
                kind: run.cancelRequested ? 'cancel' : 'pause',
                applied: false,
              },
            },
            [{ type: 'control.apply', controlId: id }],
          );
          continue;
        }
        if (run.status === 'waiting') {
          const ready =
            run.wait?.reason === 'input'
              ? run.wait.objectIds.every((id) => state.questions[id]?.status === 'answered')
              : run.wait?.reason === 'review'
                ? run.wait.objectIds.every((id) => ['accepted', 'rejected'].includes(state.proposals[id]?.status ?? ''))
                : run.wait?.reason === 'external-model'
                  ? run.wait.objectIds.every((id) => state.attempts[id]?.status === 'observed')
                  : false;
          if (!ready) break;
          if (options.signal?.aborted) break;
          const profile = this.manifest.profiles[run.profile];
          check(profile, 'IA-ENGINE-PROFILE-UNAVAILABLE', 'Pinned profile unavailable');
          const grant = await this.grant(principal, state, profile, run, options.signal);
          this.dispatchBudget(state, run, grant);
          await save({ type: 'run.ready', runId: run.id });
          continue;
        }
        if (run.status === 'created') {
          await save({ type: 'run.ready', runId: run.id });
          continue;
        }
        if (options.signal?.aborted) break;
        const profile = this.manifest.profiles[run.profile];
        check(profile, 'IA-ENGINE-PROFILE-UNAVAILABLE', 'Pinned profile unavailable');
        const grant = await this.grant(principal, state, profile, run, options.signal);
        if (run.pendingAction !== null) {
          try {
            await this.act(state, run, profile, grant, parseAction(run.pendingAction), save, owner, options.signal);
          } catch (error) {
            if (!(error instanceof EngineError) || !repairableActionCodes.has(error.code) || run.retryOf) throw error;
            // Only reject an undispatched model action. Never reinterpret an adapter/host failure
            // after preparation as a repair, or erase an operation's effect/retry contract.
            const latest = await store.read(sessionId),
              current = latest.runs[run.id]!;
            const source = run.cause?.modelAttemptId
              ? state.attempts[run.cause.modelAttemptId]
              : Object.values(state.attempts)
                  .reverse()
                  .find(
                    (a) =>
                      a.runId === run.id &&
                      a.kind === 'model' &&
                      a.actionAccepted &&
                      a.output !== null &&
                      digest((a.output as { action: Json }).action) === digest(run.pendingAction),
                  );
            if (
              !source ||
              source.kind !== 'model' ||
              source.status !== 'observed' ||
              source.error !== null ||
              current.pendingAction === null ||
              digest(current.pendingAction) !== digest(run.pendingAction) ||
              unresolved(latest, run.id).length
            )
              throw error;
            await save(
              {
                type: 'run.wait',
                runId: run.id,
                wait: {
                  id: source.id,
                  reason: 'invalid-model-action',
                  objectIds: [source.id],
                  continuation: 'repair',
                  details: { code: error.code },
                },
              },
              [{ type: 'action.clear', runId: run.id }],
            );
            break;
          }
          continue;
        }
        const response = Object.values(state.attempts).find(
          (a) =>
            a.runId === run.id &&
            a.kind === 'model' &&
            a.status === 'observed' &&
            a.error === null &&
            !a.actionAccepted,
        );
        if (response) {
          try {
            const action = parseAction((response.output as { action: unknown }).action);
            this.limits(state, grant, 'action', 0, run);
            await save({
              type: 'action.accept',
              runId: run.id,
              attemptId: response.id,
              action: json(action),
              cause: causes(state, run, randomUUID(), response.id),
            });
          } catch (error) {
            if (!(error instanceof EngineError) || error.code !== 'IA-ENGINE-ACTION-INVALID') throw error;
            await save({
              type: 'run.wait',
              runId: run.id,
              wait: {
                id: response.id,
                reason: 'invalid-model-action',
                objectIds: [response.id],
                continuation: 'repair',
                details: { code: error.code },
              },
            });
            break;
          }
          continue;
        }
        await this.infer(state, run, profile, grant, save, owner, options.signal);
      }
      await store.checkpoint(sessionId, owner);
      return await store.read(sessionId);
    } finally {
      await store.release(owner);
    }
  }
  private limits(
    state: Session,
    grant: Grant,
    kind: 'model' | 'operation' | 'action',
    reservation: number,
    run: Run,
  ): void {
    const used = state.budget,
      allowed = grant.limits;
    const stepLimit = Math.min(state.limits.steps, allowed.steps);
    check(
      this.now() < Math.min(state.limits.deadline, allowed.deadline) &&
        (kind === 'operation' ? used.steps <= stepLimit : used.steps < stepLimit) &&
        used.usedTokens + used.reservedTokens + reservation <= Math.min(state.limits.tokens, allowed.tokens) &&
        (kind === 'model'
          ? used.modelCalls < Math.min(state.limits.modelCalls, allowed.modelCalls)
          : kind === 'operation'
            ? used.operations < Math.min(state.limits.operations, allowed.operations)
            : true),
      'IA-ENGINE-LIMIT-EXCEEDED',
      'Current budget/deadline exhausted',
    );
    for (let parent: Run | undefined = run; parent; parent = parent.parentId ? state.runs[parent.parentId] : undefined)
      if (parent.limits) {
        const ids = new Set<string>([parent.id]);
        for (const child of Object.values(state.runs).sort((a, b) => a.depth - b.depth))
          if (child.parentId && ids.has(child.parentId)) ids.add(child.id);
        const attempts = Object.values(state.attempts).filter((a) => ids.has(a.runId)),
          bounds = parent.limits;
        const steps = Object.values(state.runs)
          .filter((r) => ids.has(r.id))
          .reduce(
            (sum, r) => sum + r.transcript.filter((row) => (row as { kind?: string })?.kind === 'action').length,
            0,
          );
        check(
          this.now() < bounds.deadline &&
            (kind === 'action' ? steps < bounds.steps : steps <= bounds.steps) &&
            attempts.reduce(
              (sum, a) => sum + (a.status === 'observed' ? (a.usage ?? a.reservation) : a.reservation),
              0,
            ) +
              reservation <=
              bounds.tokens &&
            (kind === 'action' ||
              attempts.reduce(
                (sum, a) =>
                  sum +
                  (kind === 'model'
                    ? Number(a.kind === 'model')
                    : a.kind === 'model'
                      ? 0
                      : 1 + (a.reconciliations ?? 0)),
                0,
              ) < (kind === 'model' ? bounds.modelCalls : bounds.operations)),
          'IA-ENGINE-LIMIT-EXCEEDED',
          'Run/delegation budget exhausted',
        );
      }
  }
  private async infer(
    state: Session,
    run: Run,
    profile: Profile,
    grant: Grant,
    save: (m: Mutation, following?: Mutation[]) => Promise<void>,
    owner: Owner,
    signal?: AbortSignal,
  ): Promise<void> {
    check(grant.models.includes(profile.model), 'IA-ENGINE-AUTHORITY-DENIED', 'Model is not granted');
    const id = randomUUID(),
      contextSignal = this.attemptSignal(state, run, grant, 60_000, signal);
    const request: ModelRequest = {
      version: 1,
      sessionId: state.id,
      runId: run.id,
      attemptId: id,
      task: run.task,
      profile,
      history: run.transcript,
      context: null,
      operations: profile.operations
        .filter((op) => grant.operations.includes(op))
        .map((op) => this.manifest.operations[op]!),
      maxOutputTokens: modelOutputTokens,
    };
    const requestBytes = profile.contract?.requestBytes ?? DEFAULT_MODEL_REQUEST_BYTES;
    const available = requestBytes - Buffer.byteLength(canonical(request)) + 4;
    check(
      available > 0,
      'IA-ENGINE-CONTEXT-TOO-LARGE',
      'Retained history and request wrapper exceed the installed context limit',
    );
    request.context = await bounded(
      () => this.host.context(profile, run.task, grant, Object.freeze({ bytes: available })),
      contextSignal,
    );
    await this.host.store.validate(owner);
    contextSignal.throwIfAborted();
    const bytes = Buffer.byteLength(canonical(request));
    check(bytes <= requestBytes, 'IA-ENGINE-CONTEXT-TOO-LARGE', 'Model request exceeds the installed context limit');
    const reservation = bytes + request.maxOutputTokens; // Conservative UTF-8 byte bound includes wrapper/history.
    this.limits(state, grant, 'model', reservation, run);
    await save({
      type: 'attempt.prepare',
      attempt: {
        id,
        invocationId: randomUUID(),
        runId: run.id,
        kind: 'model',
        target: profile.model,
        bindingDigest: digest({ adapter: this.host.model.id, model: profile.model }),
        input: json(request),
        inputDigest: digest(request),
        authority: json(grant),
        recovery: 'manual',
        reservation,
        cause: causes(state, run, randomUUID(), null),
      },
    });
    const latest = await this.host.store.read(state.id),
      current = await this.grant(state.principal, latest, profile, run, contextSignal);
    this.dispatchBudget(latest, run, current);
    check(
      current.models.includes(profile.model) && digest(current.sources) === digest(grant.sources),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Model or disclosed source authority changed before dispatch',
    );
    await save({ type: 'attempt.dispatch', attemptId: id });
    await this.host.store.validate(owner);
    let output: Json = null,
      error: string | null = null,
      usage: number | null = null;
    try {
      const timed = this.attemptSignal(latest, run, current, 60_000, signal);
      const result = await bounded(() => this.host.model.generate(request, timed), timed);
      await this.host.store.validate(owner);
      timed.throwIfAborted();
      if ('deferred' in result) {
        await save({
          type: 'run.wait',
          runId: run.id,
          wait: { id, reason: 'external-model', objectIds: [id], continuation: 'submit-model-response', details: null },
        });
        return;
      }
      check(
        result.model === profile.model &&
          (result.usage === null || (Number.isSafeInteger(result.usage) && result.usage >= 0)),
        'IA-ENGINE-MODEL-INVALID',
        'Model or usage mismatch',
      );
      output = json(result);
      check(Buffer.byteLength(canonical(output)) <= 65_536, 'IA-ENGINE-MODEL-INVALID', 'Model response too large');
      usage = result.usage;
    } catch {
      error = 'model-attempt-failed';
    }
    await save({ type: 'attempt.observe', attemptId: id, output: error ? null : output, error, usage, effect: 'none' });
    if (error)
      await save({
        type: 'run.wait',
        runId: run.id,
        wait: { id, reason: 'model-error', objectIds: [id], continuation: 'retry-authorized', details: null },
      });
  }
  private async act(
    state: Session,
    run: Run,
    profile: Profile,
    grant: Grant,
    action: ModelAction,
    save: (m: Mutation, following?: Mutation[]) => Promise<void>,
    owner: Owner,
    signal?: AbortSignal,
  ): Promise<void> {
    this.dispatchBudget(state, run, grant);
    if (action.type === 'continue') {
      await save({ type: 'action.clear', runId: run.id });
      return;
    }
    if (action.type === 'delegate') {
      const child = this.manifest.profiles[action.profile];
      check(
        child &&
          profile.delegates.includes(child.id) &&
          child.operations.every((id) => profile.operations.includes(id)),
        'IA-ENGINE-DELEGATION-DENIED',
        'Delegate is unavailable or exceeds the parent operation boundary',
      );
      check(
        grant.profiles.includes(child.id),
        'IA-ENGINE-AUTHORITY-DENIED',
        'Current grant does not authorize this delegate',
      );
      check(
        state.budget.children < grant.limits.children && run.depth < grant.limits.depth,
        'IA-ENGINE-LIMIT-EXCEEDED',
        'Current delegation limits exhausted',
      );
      const edge = profile.contract?.delegation.find((d) => d.profile === child.id);
      check(!profile.contract || edge, 'IA-ENGINE-DELEGATION-DENIED', 'Missing compiled delegation contract');
      const childLimits = boundedLimits(
        boundedLimits(
          narrowGrant(grant, { ...grant, limits: run.limits ?? state.limits }).limits,
          child.contract?.limits,
          this.now(),
        ),
        edge?.limits,
        this.now(),
      );
      check(
        Object.values(state.runs).filter((r) => r.parentId === run.id).length <
          (run.limits?.children ?? state.limits.children) && run.depth < (run.limits?.depth ?? state.limits.depth),
        'IA-ENGINE-LIMIT-EXCEEDED',
        'Parent delegation ceiling exhausted',
      );
      const contract = taskContract(child, action.task);
      await save({
        type: 'child.create',
        parentId: run.id,
        childId: randomUUID(),
        profile: child.id,
        agent: child.agent,
        task: action.task,
        contract: json(contract),
        authority: json(grant),
        limits: childLimits,
      });
      return;
    }
    if (action.type === 'invoke') {
      const operation = this.manifest.operations[action.operation],
        adapter = operation ? this.host.operations[operation.handler] : undefined;
      check(
        operation && profile.operations.includes(operation.id),
        'IA-ENGINE-ACTION-INVALID',
        'Action names an operation outside its installed profile',
      );
      operationAllowed(operation, profile, grant);
      check(adapter, 'IA-ENGINE-BINDING-UNAVAILABLE', 'Operation adapter is not installed');
      check(
        validateShape(operation.input, action.input),
        'IA-ENGINE-INPUT-INVALID',
        'Operation input failed its installed contract',
      );
      this.limits(state, grant, 'operation', 0, run);
      const review = admittedReview(state, run, operation, action, grant, this.now());
      const retry = run.retryOf ? state.attempts[run.retryOf] : undefined;
      const id = randomUUID(),
        invocationId = retry?.invocationId ?? randomUUID(),
        timed = this.attemptSignal(state, run, grant, operation.timeoutMs, signal);
      const context = this.effectContext(
        state,
        run,
        profile,
        operation,
        action,
        grant,
        owner,
        id,
        invocationId,
        review,
        timed,
      );
      await save({
        type: 'attempt.prepare',
        attempt: {
          id,
          invocationId,
          runId: run.id,
          kind: 'operation',
          target: operation.id,
          bindingDigest: operation.digest,
          input: action.input,
          inputDigest: digest(action.input),
          authority: json(grant),
          recovery: operation.recovery,
          reservation: 0,
          cause: retry?.cause ?? run.cause ?? causes(state, run, randomUUID(), null),
          ...(review ? { review } : {}),
        },
      });
      const latest = await this.host.store.read(state.id),
        current = await this.grant(state.principal, latest, profile, run, timed);
      this.dispatchBudget(latest, run, current);
      operationAllowed(operation, profile, current);
      admittedReview(latest, run, operation, action, current, this.now(), id);
      context.grant = current;
      context.signal = this.attemptSignal(latest, run, current, operation.timeoutMs, context.signal);
      for (const id of this.checks(profile, 'before-effect')) {
        const result = await bounded(
          () =>
            this.host.evaluate(id, json({ phase: 'before-effect', action, contract: run.contract ?? null }), current),
          context.signal,
        );
        check(result.status === 'pass', 'IA-ENGINE-GOVERNANCE-DENIED', `Required evaluator ${id} did not pass`);
      }
      if (review)
        check(
          this.host.preflight &&
            (await bounded(() => this.host.preflight!(operation, action.input, context), context.signal)),
          'IA-ENGINE-DESTINATION-DENIED',
          'Current destination/binding preflight is unavailable or denied',
        );
      context.signal.throwIfAborted();
      await save({ type: 'attempt.dispatch', attemptId: id });
      await this.host.store.validate(owner);
      let output: Json = null,
        error: string | null = null,
        effect: Attempt['effect'] = operation.effects.every((v) => v === 'read') ? 'none' : 'unknown';
      try {
        const dispatchSignal = context.signal;
        const result = await bounded(() => adapter.execute(action.input, context), dispatchSignal);
        await this.host.store.validate(owner);
        dispatchSignal.throwIfAborted();
        context.signal.throwIfAborted();
        check(
          context.grant.expiresAt > this.now(),
          'IA-ENGINE-AUTHORITY-DENIED',
          'Current effect grant expired before result admission',
        );
        effect = result.effect;
        check(
          Buffer.byteLength(canonical(result.output)) <= (operation.maxOutputBytes ?? 65_536) &&
            validateShape(operation.output, result.output),
          'IA-ENGINE-OUTPUT-INVALID',
          'Operation output failed its installed contract',
        );
        output = result.output;
      } catch {
        error = 'operation-attempt-failed';
      }
      await save({ type: 'attempt.observe', attemptId: id, output, error, effect, usage: 0 });
      if (error && effect === 'none')
        await save({
          type: 'run.wait',
          runId: run.id,
          wait: {
            id,
            reason: 'operation-error',
            objectIds: [id],
            continuation: operation.effects.every((e) => e === 'read') ? 'retry' : 'unsupported-recovery',
            details: null,
          },
        });
      return;
    }
    check(profile.outcomes.includes(action.kind), 'IA-ENGINE-OUTCOME-DENIED', 'Outcome is unavailable in this profile');
    const observedEvidence = new Set(
      state.receipts.flatMap((receipt) => {
        if (receipt.runId !== run.id || !this.manifest.operations[receipt.target] || receipt.error !== null) return [];
        const output = receipt.output as { citations?: unknown } | null;
        return [
          receipt.id,
          ...(Array.isArray(output?.citations)
            ? output.citations.filter((v): v is string => typeof v === 'string')
            : []),
        ];
      }),
    );
    check(
      (action.evidence ?? []).every((ref) => observedEvidence.has(ref)),
      'IA-ENGINE-EVIDENCE-INVALID',
      'Outcome cites evidence not observed by this session',
    );
    const questions: Question[] = (action.questions ?? []).map((q) => {
      const contract = { prompt: q.prompt, respondent: state.principal, choices: q.choices, revision: 1 };
      return {
        ...contract,
        id: randomUUID(),
        runId: run.id,
        required: q.required,
        answer: null,
        status: 'open',
        digest: digest(contract),
        ...(run.cause ? { cause: run.cause } : {}),
      };
    });
    const review = offerReview(state, run, profile, grant, this.manifest, action, this.now());
    const proposal =
      action.proposal === undefined
        ? undefined
        : {
            id: randomUUID(),
            revision: 1,
            runId: run.id,
            candidate: action.proposal,
            digest: digest(action.proposal),
            status: 'offered' as const,
            decisionId: null,
            ...(review ? { review } : {}),
            ...(run.cause ? { cause: run.cause } : {}),
          };
    const end = action.continuation === 'finish' || action.continuation === 'fail';
    if (end && action.continuation === 'finish') {
      evaluateCompletion(state, run, profile, action);
      const timed = this.attemptSignal(state, run, grant, 60_000, signal);
      for (const id of this.checks(profile, 'completion')) {
        const result = await bounded(
          () => this.host.evaluate(id, json({ phase: 'completion', action, contract: run.contract ?? null }), grant),
          timed,
        );
        check(result.status === 'pass', 'IA-ENGINE-GOVERNANCE-DENIED', `Completion evaluator ${id} did not pass`);
      }
      timed.throwIfAborted();
    }
    let wait: Wait | undefined;
    if (action.continuation.startsWith('await-'))
      wait = {
        id: randomUUID(),
        reason:
          action.continuation === 'await-input'
            ? 'input'
            : action.continuation === 'await-review'
              ? 'review'
              : 'dependency',
        objectIds:
          action.continuation === 'await-input'
            ? questions.filter((q) => q.required).map((q) => q.id)
            : proposal
              ? [proposal.id]
              : [],
        continuation: 'continue',
        details: null,
      };
    const outcome = json({
      ...action,
      contractDigest: digest(run.contract ?? null),
      references: {
        questions: questions.map((q) => q.id),
        proposals: proposal ? [proposal.id] : [],
        decisions: run.cause?.decisions ?? [],
        receipts: action.artifacts ?? [],
      },
      ...(run.cause ? { cause: run.cause } : {}),
    });
    await save({
      type: 'outcome.accept',
      runId: run.id,
      outcome,
      terminal: end ? (action.continuation === 'fail' ? 'failed' : 'completed') : null,
      questions,
      ...(proposal ? { proposal } : {}),
      ...(wait ? { wait } : {}),
    });
  }
  private async recover(
    state: Session,
    attempt: Attempt,
    owner: Owner,
    save: (m: Mutation, following?: Mutation[]) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const run = state.runs[attempt.runId]!;
    if (
      attempt.kind === 'model' &&
      run.wait?.reason === 'external-model' &&
      !run.cancelRequested &&
      !run.pauseRequested
    )
      return false;
    if (attempt.status === 'prepared') {
      await save({ type: 'attempt.abandon', attemptId: attempt.id });
      if (attempt.kind === 'operation')
        await save({
          type: 'run.wait',
          runId: run.id,
          wait: {
            id: attempt.id,
            reason: 'operation-error',
            objectIds: [attempt.id],
            continuation: 'retry',
            details: null,
          },
        });
      return true;
    }
    if (attempt.kind === 'model') {
      await save({
        type: 'attempt.reconcile',
        attemptId: attempt.id,
        effect: 'none',
        output: null,
        evidence: 'Owner recovery: response unavailable; reserved model usage charged.',
      });
      return true;
    }
    const definition = this.manifest.operations[attempt.target];
    if (definition?.digest === attempt.bindingDigest && definition.effects.every((effect) => effect === 'read')) {
      await this.host.store.validate(owner);
      await save({
        type: 'attempt.reconcile',
        attemptId: attempt.id,
        effect: 'none',
        output: null,
        evidence: 'Installed immutable read contract has no application effect.',
      });
      await save({
        type: 'run.wait',
        runId: run.id,
        wait: {
          id: attempt.id,
          reason: 'operation-error',
          objectIds: [attempt.id],
          continuation: 'retry',
          details: null,
        },
      });
      return true;
    }
    const adapter = definition && this.host.operations[definition.handler],
      profile = this.manifest.profiles[run.profile];
    const wait = async (reason: string, details: Json = null): Promise<false> => {
      const next = { id: attempt.id, reason, objectIds: [attempt.id], continuation: 'reconcile', details };
      if (run.status !== 'waiting' || digest(run.wait) !== digest(next))
        await save({ type: 'run.wait', runId: run.id, wait: next });
      return false;
    };
    if (
      definition?.digest === attempt.bindingDigest &&
      definition.recovery === 'reconcile' &&
      adapter?.reconcile &&
      profile &&
      attempt.review
    ) {
      const allowance = profile.contract?.maxAttempts ?? 2;
      if ((attempt.reconciliations ?? 0) >= allowance) return wait('reconciliation-exhausted');
      let context: OperationContext;
      try {
        const preflightSignal = this.attemptSignal(state, run, undefined, definition.timeoutMs, signal);
        const grant = await this.grant(state.principal, state, profile, run, preflightSignal);
        this.limits(state, grant, 'operation', 0, run);
        const { proposalId, revision, digest: proposalDigest, decisionId } = attempt.review;
        const action: Extract<ModelAction, { type: 'invoke' }> = {
          type: 'invoke',
          operation: attempt.target,
          input: attempt.input,
          review: { proposalId, revision, digest: proposalDigest, decisionId },
        };
        context = this.effectContext(
          state,
          run,
          profile,
          definition,
          action,
          grant,
          owner,
          attempt.id,
          attempt.invocationId,
          attempt.review,
          this.attemptSignal(state, run, grant, definition.timeoutMs, preflightSignal),
          true,
        );
        await context.assertCurrent!();
      } catch (error) {
        return wait('reconciliation-unavailable', { code: error instanceof SessionError ? error.code : 'unavailable' });
      }
      await save({ type: 'attempt.reconcile.start', attemptId: attempt.id, maxAttempts: allowance });
      let effect: Attempt['effect'] = 'unknown',
        output: Json = null,
        error: string | null = 'reconciliation-unavailable';
      try {
        await this.host.store.validate(owner);
        const observed = await bounded(() => adapter.reconcile!(attempt.input, context), context.signal);
        await this.host.store.validate(owner);
        context.signal.throwIfAborted();
        check(
          context.grant.expiresAt > this.now(),
          'IA-ENGINE-AUTHORITY-DENIED',
          'Current effect grant expired before reconciliation admission',
        );
        check(
          ['absent', 'applied', 'partial', 'unknown'].includes(observed.status),
          'IA-ENGINE-OUTPUT-INVALID',
          'Invalid reconciliation status',
        );
        effect = observed.status === 'absent' ? 'none' : observed.status;
        if (effect === 'applied') {
          check(
            Buffer.byteLength(canonical(observed.output)) <= (definition.maxOutputBytes ?? 65536) &&
              validateShape(definition.output, observed.output),
            'IA-ENGINE-OUTPUT-INVALID',
            'Reconciled output failed its installed contract',
          );
          output = observed.output;
          error = null;
        } else error = effect === 'none' ? 'reconciled-absent' : `reconciliation-${effect}`;
      } catch {
        /* Retain an observed application even when its output cannot be validated. */
      }
      await save({
        type: 'attempt.reconcile',
        attemptId: attempt.id,
        effect,
        output,
        error,
        evidence: `Installed ${attempt.target} reconciliation: ${effect}`,
      });
      if (effect === 'partial' || effect === 'unknown') return wait('unknown-effect', { effect });
      if (run.cancelRequested || run.pauseRequested) return true;
      if (effect === 'none') {
        await save({
          type: 'run.wait',
          runId: run.id,
          wait: {
            id: attempt.id,
            reason: 'operation-error',
            objectIds: [attempt.id],
            continuation: 'retry',
            details: null,
          },
        });
        return false;
      }
      if (error) {
        await save({
          type: 'run.wait',
          runId: run.id,
          wait: {
            id: attempt.id,
            reason: 'operation-output-invalid',
            objectIds: [attempt.id],
            continuation: 'remediate',
            details: null,
          },
        });
        return false;
      }
      await save({ type: 'run.ready', runId: run.id });
      return true;
    }
    return wait('unknown-effect', { target: attempt.target, recovery: attempt.recovery });
  }
  private async renewalGrant(state: Session, principal: string, signal?: AbortSignal): Promise<Grant> {
    check(
      state.principal === principal && state.manifestDigest === digest(this.manifest),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Only the session creator can renew its pinned execution',
    );
    check(this.host.authorizeRenewal, 'IA-ENGINE-RENEWAL-UNAVAILABLE', 'The host does not grant renewal');
    const timed = this.attemptSignal(null, undefined, undefined, 60_000, signal);
    check(
      await bounded(() => this.host.verifyManifest(this.manifest), timed),
      'IA-ENGINE-SOURCE-CHANGED',
      'Pinned inputs or executable bindings are unavailable',
    );
    const grant = copy(await bounded(() => this.host.authorizeRenewal!(principal, this.manifest, state), timed));
    check(
      await bounded(
        () => this.host.verifyManifest(this.manifest),
        this.attemptSignal(null, undefined, grant, 60_000, timed),
      ),
      'IA-ENGINE-SOURCE-CHANGED',
      'Pinned bindings changed during renewal authorization',
    );
    check(
      grant.principal === principal &&
        grant.workspace === state.workspace &&
        grant.sources.includes(this.manifest.sourceDigest) &&
        grant.expiresAt > this.now() &&
        grant.limits.deadline > this.now(),
      'IA-ENGINE-AUTHORITY-DENIED',
      'Current authority does not permit renewal',
    );
    return grant;
  }
  private renewalPlan(state: Session, grant: Grant, requested?: number): Extract<Mutation, { type: 'session.renew' }> {
    const live = humanWaitRuns(state),
      now = this.now();
    check(
      live.length,
      'IA-ENGINE-RENEWAL-UNAVAILABLE',
      'Only settled human waits and their waiting ancestors can renew',
    );
    const root = state.runs[state.rootId]!,
      rootProfile = this.manifest.profiles[root.profile];
    check(rootProfile, 'IA-ENGINE-PROFILE-UNAVAILABLE', 'Retained root profile is unavailable');
    const maximum = boundedLimits(
      { ...grant.limits, deadline: Math.min(grant.expiresAt, grant.limits.deadline) },
      rootProfile.contract?.limits,
      now,
    ).deadline;
    const deadline = requested ?? maximum;
    check(
      Number.isSafeInteger(deadline) && deadline > Math.max(now, state.limits.deadline) && deadline <= maximum,
      'IA-ENGINE-RENEWAL-UNAVAILABLE',
      'Renewal deadline exceeds the current permitted window',
    );
    const mutation: Extract<Mutation, { type: 'session.renew' }> = {
      type: 'session.renew',
      expectedSequence: state.sequence,
      previousDeadline: state.limits.deadline,
      deadline,
      runs: {},
    };
    const projected = copy(state);
    projected.limits.deadline = deadline;
    for (const run of live) {
      const profile = this.manifest.profiles[run.profile],
        retained = run.authority as unknown as Grant | undefined;
      check(
        profile &&
          run.limits &&
          retained?.limits &&
          ['profiles', 'operations', 'effects', 'sources', 'models'].every((key) =>
            Array.isArray((retained as unknown as Record<string, unknown>)[key]),
          ),
        'IA-ENGINE-RENEWAL-UNAVAILABLE',
        'Legacy run authority cannot be renewed',
      );
      const parent = run.parentId ? state.runs[run.parentId]! : null,
        edge = parent
          ? this.manifest.profiles[parent.profile]?.contract?.delegation.find((entry) => entry.profile === run.profile)
          : undefined;
      const inherited = parent ? mutation.runs[parent.id]?.deadline : deadline;
      check(inherited !== undefined, 'IA-ENGINE-RENEWAL-UNAVAILABLE', 'Unsettled ancestor cannot be renewed');
      const next = boundedLimits(
        boundedLimits({ ...grant.limits, deadline: Math.min(deadline, inherited) }, profile.contract?.limits, now),
        edge?.limits,
        now,
      ).deadline;
      check(
        next > Math.max(now, run.limits.deadline) &&
          run.depth <= grant.limits.depth &&
          state.budget.children <= grant.limits.children,
        'IA-ENGINE-RENEWAL-UNAVAILABLE',
        'Renewal exceeds inherited task limits',
      );
      const ceiling = {
          ...retained,
          limits: { ...retained.limits, deadline: Math.max(retained.limits.deadline, next) },
        },
        effective = narrowGrant(grant, ceiling);
      check(
        effective.profiles.includes(run.profile) &&
          effective.models.includes(profile.model) &&
          effective.sources.includes(this.manifest.sourceDigest),
        'IA-ENGINE-AUTHORITY-DENIED',
        'Current authority no longer admits this task',
      );
      check(
        state.budget.retainedBytes < Math.min(state.limits.bytes, effective.limits.bytes) &&
          (run.retainedBytes ?? 0) < run.limits.bytes,
        'IA-ENGINE-LIMIT-EXCEEDED',
        'Retained byte budget is exhausted',
      );
      mutation.runs[run.id] = { previousDeadline: run.limits.deadline, deadline: next };
      projected.runs[run.id]!.limits!.deadline = next;
      // Every supported human continuation needs a new model turn. Exact request bytes are
      // unknown until context assembly; at least one request byte accompanies the output bound.
      this.limits(projected, effective, 'model', modelOutputTokens + 1, projected.runs[run.id]!);
    }
    return mutation;
  }
  /** Read-only current renewal offer. Its exact deadline is rechecked during admission. */
  async renewal(
    sessionId: string,
    principal: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ deadline: number }> {
    const signal = options.signal,
      state = await this.host.store.read(sessionId),
      grant = await this.renewalGrant(state, principal, signal);
    return { deadline: this.renewalPlan(state, grant).deadline };
  }
  /** Extends time only; never resets accounting, changes executable bindings or dispatches work. */
  async renew(
    sessionId: string,
    principal: string,
    input: { commandId: string; expectedSequence: number; deadline: number; signal?: AbortSignal },
  ): Promise<Session> {
    const request = { ...input },
      owner = await this.host.store.acquire(sessionId);
    try {
      const state = await this.host.store.read(sessionId),
        grant = await this.renewalGrant(state, principal, request.signal);
      const prior = (await this.host.store.journal(sessionId)).events.find(
        (event) => event.id === request.commandId,
      )?.mutation;
      if (prior) {
        check(
          prior.type === 'session.renew' &&
            prior.expectedSequence === request.expectedSequence &&
            prior.deadline === request.deadline,
          'IA-SESSION-COMMAND-CONFLICT',
          'Renewal command content changed',
        );
        return state;
      }
      check(
        state.sequence === request.expectedSequence,
        'IA-SESSION-REVISION-CONFLICT',
        'Renewal requires the current session sequence',
      );
      const mutation = this.renewalPlan(state, grant, request.deadline);
      request.signal?.throwIfAborted();
      await this.host.store.validate(owner);
      request.signal?.throwIfAborted();
      check(
        grant.expiresAt > this.now() &&
          Math.min(grant.limits.deadline, ...Object.values(mutation.runs).map((run) => run.deadline)) > this.now(),
        'IA-ENGINE-AUTHORITY-DENIED',
        'Renewal authority expired before admission',
      );
      await this.host.store.command(
        { id: request.commandId, sessionId, actor: principal, expected: request.expectedSequence, mutation },
        owner,
      );
      return this.host.store.read(sessionId);
    } finally {
      await this.host.store.release(owner);
    }
  }
  /** Bounded repair/read retry, or an exact reviewed write after proven absence. */
  async retry(sessionId: string, principal: string, attemptId: string, commandId: string): Promise<Session> {
    const owner = await this.host.store.acquire(sessionId);
    try {
      const state = await this.host.store.read(sessionId),
        attempt = state.attempts[attemptId];
      check(attempt && state.principal === principal, 'IA-ENGINE-AUTHORITY-DENIED', 'Attempt is unavailable');
      const run = state.runs[attempt.runId]!,
        profile = this.manifest.profiles[run.profile]!;
      const grant = await this.grant(principal, state, profile, run);
      let mutation: Mutation;
      if (attempt.kind === 'model') {
        const prior = (await this.host.store.journal(sessionId)).events.find((e) => e.id === commandId)?.mutation;
        const details = prior?.type === 'model.repair' ? prior.details : run.wait?.details;
        mutation = {
          type: 'model.repair',
          attemptId,
          allowance: profile.contract?.repairAttempts ?? 1,
          ...(details != null ? { details } : {}),
        };
      } else {
        const operation = this.manifest.operations[attempt.target];
        operationAllowed(operation, profile, grant);
        const read = operation.recovery === 'repeatable' && operation.effects.every((e) => e === 'read');
        const write =
          operation.recovery === 'reconcile' &&
          this.host.operations[operation.handler]?.reconcile &&
          attempt.review &&
          ['not-dispatched', 'reconciled-absent'].includes(attempt.error ?? '');
        check(
          operation.digest === attempt.bindingDigest && (read || write),
          'IA-ENGINE-RECOVERY-UNAVAILABLE',
          'Retry needs a repeatable read or qualified proof of write absence',
        );
        const review = attempt.review
          ? {
              proposalId: attempt.review.proposalId,
              revision: attempt.review.revision,
              digest: attempt.review.digest,
              decisionId: attempt.review.decisionId,
            }
          : undefined;
        const action: Extract<ModelAction, { type: 'invoke' }> = {
          type: 'invoke',
          operation: attempt.target,
          input: attempt.input,
          ...(review ? { review } : {}),
        };
        if (write) admittedReview(state, run, operation, action, grant, this.now());
        mutation = {
          type: 'attempt.retry',
          attemptId,
          action: json(action),
          maxAttempts: profile.contract?.maxAttempts ?? 2,
        };
      }
      await this.host.store.command(
        { id: commandId, sessionId, actor: principal, expected: state.sequence, mutation },
        owner,
      );
      return this.host.store.read(sessionId);
    } finally {
      await this.host.store.release(owner);
    }
  }
  async reply(
    sessionId: string,
    principal: string,
    questionId: string,
    revision: number,
    questionDigest: string,
    answer: Json,
    commandId: string,
  ): Promise<Session> {
    const state = await this.host.store.read(sessionId),
      question = state.questions[questionId];
    check(question && question.respondent === principal, 'IA-ENGINE-AUTHORITY-DENIED', 'Question is unavailable');
    const run = state.runs[question.runId]!;
    await this.grant(principal, state, this.manifest.profiles[run.profile]!, run);
    await this.host.store.command({
      id: commandId,
      sessionId,
      actor: principal,
      expected: state.sequence,
      mutation: { type: 'question.reply', questionId, revision, digest: questionDigest, answer },
    });
    return this.host.store.read(sessionId);
  }
  async review(
    sessionId: string,
    principal: string,
    proposalId: string,
    revision: number,
    proposalDigest: string,
    accept: boolean,
    rationale: string,
    commandId: string,
  ): Promise<Session> {
    const state = await this.host.store.read(sessionId),
      proposal = state.proposals[proposalId];
    check(
      proposal && (proposal.review?.reviewer ?? state.principal) === principal,
      'IA-ENGINE-AUTHORITY-DENIED',
      'Proposal is unavailable to this reviewer',
    );
    const run = state.runs[proposal.runId]!,
      grant = await this.grant(principal, state, this.manifest.profiles[run.profile]!, run);
    if (proposal.review) {
      const binding = proposal.review,
        operation = this.manifest.operations[binding.operation];
      operationAllowed(operation, this.manifest.profiles[run.profile]!, grant);
      check(
        operation.digest === binding.bindingDigest &&
          binding.expiresAt > this.now() &&
          grant.destinations?.some((d) => digest(d) === digest(binding.destination)),
        'IA-ENGINE-REVIEW-INVALID',
        'Review authority, binding or destination changed',
      );
    }
    await this.host.store.command({
      id: commandId,
      sessionId,
      actor: principal,
      expected: state.sequence,
      mutation: {
        type: 'proposal.review',
        proposalId,
        revision,
        digest: proposalDigest,
        accept,
        rationale,
        decisionId: `decision-${digest(commandId)}`,
      },
    });
    return this.host.store.read(sessionId);
  }
  /** IDE host supplies one structured response to the exact persisted request; no API/model credential is needed. */
  async submitModel(
    sessionId: string,
    principal: string,
    attemptId: string,
    response: ModelResponse,
    commandId: string,
  ): Promise<Session> {
    const state = await this.host.store.read(sessionId),
      attempt = state.attempts[attemptId];
    check(
      attempt && state.principal === principal && attempt.kind === 'model',
      'IA-ENGINE-AUTHORITY-DENIED',
      'Model request is unavailable',
    );
    const run = state.runs[attempt.runId]!,
      profile = this.manifest.profiles[run.profile]!;
    await this.grant(principal, state, profile, run);
    check(
      response.model === profile.model &&
        (response.usage === null || (Number.isSafeInteger(response.usage) && response.usage >= 0)),
      'IA-ENGINE-MODEL-INVALID',
      'Invalid model/usage',
    );
    parseAction(response.action);
    check(Buffer.byteLength(canonical(response)) <= 65_536, 'IA-ENGINE-MODEL-INVALID', 'Response too large');
    const owner = await this.host.store.acquire(sessionId);
    try {
      const journal = await this.host.store.journal(sessionId);
      check(
        journal.commands[commandId] ||
          (run.wait?.reason === 'external-model' &&
            run.wait.objectIds.includes(attemptId) &&
            attempt.status === 'dispatched'),
        'IA-ENGINE-MODEL-INVALID',
        'No external response is pending',
      );
      await this.host.store.command(
        {
          id: commandId,
          sessionId,
          actor: principal,
          expected: state.sequence,
          mutation: {
            type: 'attempt.observe',
            attemptId,
            output: json(response),
            effect: 'none',
            error: null,
            usage: response.usage,
          },
        },
        owner,
      );
      return this.host.store.read(sessionId);
    } finally {
      await this.host.store.release(owner);
    }
  }
}
