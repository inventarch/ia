import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { open } from '@inventarch/db';
import type { InputOptions } from '@inventarch/db';
import { Engine } from '@inventarch/agent-system';
import type { EngineHost, Grant, ModelAdapter, ModelResponse, Profile } from '@inventarch/agent-system';
import {
  compileHarness,
  executionManifest,
  installedReadCatalog,
  INSTALLED_READ,
} from '@inventarch/agent-composition-system';
import type { CompositionCatalog } from '@inventarch/agent-composition-system';
import { captureWorkspace } from '@inventarch/workspace-runtime';
import { canonical, copy, digest, SessionError, terminal } from '@inventarch/session-system';
import type { Json, Limits, Session } from '@inventarch/session-system';
import { sqliteStore } from '@inventarch/session-system/sqlite';
import { governingMandates, mandateAuthorityOf, profileRefusal, requireMandatesAdmitted } from '@inventarch/runtime';
import type { Mode, ProfileMandate, ScopeKey } from '@inventarch/runtime';
import { runnerCatalog } from './catalog.js';
import { RunnerContext } from './context.js';
import { requireRunner, RunnerError } from './errors.js';
import { bindOperations } from './operations.js';

export interface RunnerOptions {
  root: string;
  profile: string;
  harness?: string;
  entry?: string;
  /** Host-supplied capture inputs, never read from an authored executable locator. */
  inputs?: InputOptions;
  /** These contracts are trusted host configuration, not a native grant or a module loader. */
  catalog?: CompositionCatalog;
  model?: ModelAdapter;
  principal?: string;
  authorize?: EngineHost['authorize'];
  evaluate?: EngineHost['evaluate'];
  /** Called only after replayed durable state is available. */
  evidence?: (
    state: Session,
    events: Awaited<ReturnType<ReturnType<typeof sqliteStore>['journal']>>['events'],
    authoredRevision: string,
  ) => Promise<void>;
}
const boundedKeys = {
  steps: 'steps',
  modelCalls: 'model-calls',
  operations: 'operations',
  tokens: 'tokens',
  children: 'children',
  depth: 'depth',
  bytes: 'bytes',
} as const;
type NativeRecord = ReturnType<ReturnType<typeof open>['records']>[number];
function field(record: NativeRecord, section: string, key: string) {
  const found = record.sections
    .filter((row) => row.name === section)
    .flatMap((row) => row.fields)
    .filter((row) => 'key' in row && row.key === key);
  requireRunner(found.length <= 1, 'IA-RUNNER-FIELD', `Repeated ${section}.${key} is not supported by this host`);
  const row = found[0];
  if (!row || !('value' in row)) return undefined;
  requireRunner(!row.when && !row.fields, 'IA-RUNNER-FIELD', `Conditional ${section}.${key} is not executable`);
  return row.value;
}
const text = (value: ReturnType<typeof field>): string => (value && 'text' in value ? value.text : '');

/** Opens compiled execution on a pinned capture. Every resumed dispatch rechecks that capture and installed code. */
export function openRunner(options: RunnerOptions) {
  const root = resolve(options.root),
    inputs = options.inputs ?? {};
  const capture = captureWorkspace(root, 'runner', inputs);
  const reader = open(root, { ...inputs, cache: false }),
    within = reader.resolveScope().token;
  let context: RunnerContext | undefined;
  let bound: ReturnType<typeof bindOperations> | undefined;
  const store = sqliteStore(resolve(root, '.ia/work/runs'));
  try {
    requireMandatesAdmitted(reader, within);
    requireRunner(
      !reader.report.findings.some((item) => item.severity === 'error'),
      'IA-RUNNER-ADMISSION',
      'The workspace does not admit cleanly',
    );
    const records = reader.records({ within });
    const profiles = records.filter(
      (row) => row.discriminator === 'agent-profile' && [row.name, row.identity].includes(options.profile),
    );
    requireRunner(profiles.length === 1, 'IA-RUNNER-PROFILE', 'Select one admitted agent profile');
    const profileRecord = profiles[0]!;
    const resolveRef = (value: ReturnType<typeof field>): string | undefined => {
      if (value?.kind !== 'ref') return undefined;
      const got = reader.resolve(value, { within });
      return got.ok ? got.identity : undefined;
    };
    const entries = records.filter(
      (row) =>
        row.discriminator === 'execution-binding' &&
        text(field(row, 'binding', 'kind')) === 'entry' &&
        resolveRef(field(row, 'binding', 'target')) === profileRecord.identity &&
        (!options.entry || [row.name, row.identity].includes(options.entry)),
    );
    requireRunner(entries.length === 1, 'IA-RUNNER-ENTRY', 'Select one entry binding for the profile');
    const entry = entries[0]!;
    const harnesses = records.filter((row) => {
      if (row.discriminator !== 'harness' || (options.harness && ![row.name, row.identity].includes(options.harness)))
        return false;
      const bindings = field(row, 'composition', 'bindings');
      return bindings?.kind === 'list' && bindings.items.some((value) => resolveRef(value) === entry.identity);
    });
    requireRunner(harnesses.length === 1, 'IA-RUNNER-HARNESS', 'Select one harness containing the entry binding');
    const catalog = copy(options.catalog ?? runnerCatalog());
    const result = compileHarness(capture, { harness: harnesses[0]!.identity, entry: entry.identity, catalog });
    if (!result.ok) throw new RunnerError('IA-RUNNER-COMPOSITION', canonical(result.diagnostics));
    const compiled = result.manifest,
      manifest = executionManifest(compiled, catalog);
    const principal = options.principal ?? 'local-operator';
    const currentCapture = () => captureWorkspace(root, 'runner', inputs);
    const profileMandates = (profile: Profile, path?: string): ProfileMandate[] => {
      const found = governingMandates(reader, within, {
        actor: profile.agent,
        workspace: manifest.workspace,
        ...(path ? { path } : {}),
      });
      const selected = compiled.profiles[profile.id]?.mandate;
      const named = records.find((row) => row.identity === selected);
      if (!named || found.some((other) => other.identity === named.identity)) return [...found];
      const authority = mandateAuthorityOf(named);
      const participant = resolveRef(field(named, 'authority', 'participant'));
      return [
        ...found,
        {
          ...authority,
          ...(participant ? { participant } : {}),
          binds: !authority.participant || participant === profile.agent,
        },
      ];
    };
    const authorizeOperation = (operation: string, path?: string, profileId = compiled.entry.profile): void => {
      const profile = manifest.profiles[profileId]!;
      const operationRow = manifest.operations[operation];
      requireRunner(
        operationRow && profile.operations.includes(operation),
        'IA-RUNNER-OPERATION-DENIED',
        'Operation is outside the selected profile',
      );
      const mode: Mode = operationRow.effects.every((effect) => effect === 'read') ? 'read' : 'effect';
      const refusal = profileRefusal(profileMandates(profile, path), mode, ['operation']).refusal;
      if (refusal) throw new RunnerError(refusal.code, refusal.message, refusal.next);
    };
    bound = bindOperations({
      capture,
      compiled,
      catalog,
      manifest,
      principal,
      reader,
      currentCapture,
      authorize: authorizeOperation,
    });
    context = new RunnerContext(root, { ...inputs, cache: false });
    let phase: ScopeKey['phase'] = 'orient';
    const narrowedGrant = (profile: Profile, state: Session | null): Grant => {
      const selected = compiled.profiles[profile.id]!;
      const limits: Limits = {
        steps: 64,
        modelCalls: 16,
        operations: 16,
        tokens: 200000,
        children: 0,
        depth: 0,
        bytes: 8000000,
        deadline: state?.limits.deadline ?? Date.now() + Math.min(selected.limits.durationMs ?? 3600000, 3600000),
      };
      for (const [key, spelling] of Object.entries(boundedKeys) as [keyof typeof boundedKeys, string][]) {
        limits[key] = Math.min(limits[key], selected.limits[key] ?? limits[key]);
        for (const mandate of profileMandates(profile)) {
          if (mandate.binds === false) continue;
          const record = records.find((row) => row.identity === mandate.identity)!;
          const value = field(record, 'execution', `limit-${spelling}`);
          if (value && 'text' in value) limits[key] = Math.min(limits[key], Number(value.text));
        }
      }
      for (const mandate of profileMandates(profile)) {
        if (mandate.binds === false) continue;
        const value = field(
          records.find((row) => row.identity === mandate.identity)!,
          'execution',
          'limit-duration-ms',
        );
        if (value && 'text' in value)
          limits.deadline = Math.min(
            limits.deadline,
            (state ? Date.parse(state.createdAt) : Date.now()) + Number(value.text),
          );
      }
      return {
        id: `runner-${capture.revision}`,
        principal,
        workspace: manifest.workspace,
        profiles: [profile.id],
        operations: [...profile.operations],
        effects: ['read'],
        sources: [capture.revision],
        models: [profile.model],
        limits,
        expiresAt: limits.deadline,
      };
    };
    const authorize: EngineHost['authorize'] = async (who, current, state) => {
      requireRunner(
        who === principal && digest(current) === digest(manifest),
        'IA-RUNNER-AUTHORITY',
        'Principal or manifest changed',
      );
      const ceiling = narrowedGrant(manifest.profiles[compiled.entry.profile]!, state);
      if (!options.authorize) return ceiling;
      const grant = copy(await options.authorize(who, current, state));
      for (const key of Object.keys(ceiling.limits) as (keyof Limits)[])
        grant.limits[key] = Math.min(grant.limits[key], ceiling.limits[key]);
      grant.operations = grant.operations.filter((id) => ceiling.operations.includes(id));
      grant.effects = grant.effects.filter((effect) => ceiling.effects.includes(effect));
      grant.profiles = grant.profiles.filter((id) => ceiling.profiles.includes(id));
      grant.expiresAt = Math.min(grant.expiresAt, ceiling.expiresAt);
      return grant;
    };
    const verify = async () => {
      if (currentCapture().revision !== capture.revision) return false;
      const fresh = compileHarness(capture, { harness: compiled.id, entry: compiled.entry.binding, catalog });
      return (
        fresh.ok &&
        fresh.manifest.digest === compiled.digest &&
        (!manifest.operations[INSTALLED_READ.operation] ||
          canonical(installedReadCatalog().operations[INSTALLED_READ.implementation]) ===
            canonical(catalog.operations[INSTALLED_READ.implementation]))
      );
    };
    const model = options.model ?? { id: 'runner/external', generate: async () => ({ deferred: true as const }) };
    const constrainResponse = (response: ModelResponse, profileId: string): ModelResponse => {
      const action = response.action;
      if (
        action &&
        typeof action === 'object' &&
        'type' in action &&
        action.type === 'invoke' &&
        'operation' in action &&
        typeof action.operation === 'string'
      ) {
        const args = 'input' in action ? action.input : undefined;
        try {
          authorizeOperation(
            action.operation,
            args && typeof args === 'object' && 'path' in args && typeof args.path === 'string' ? args.path : undefined,
            profileId,
          );
        } catch (error) {
          if (!(error instanceof RunnerError)) throw error;
          return {
            ...response,
            action: {
              type: 'outcome',
              kind: 'refusal',
              message: `${error.code}: ${error.message}; next: ${error.next}`,
              continuation: 'finish',
            },
          };
        }
      }
      return response;
    };
    const engine = new Engine(manifest, {
      store,
      operations: bound.operations,
      authorize,
      verifyManifest: verify,
      evaluate:
        options.evaluate ??
        (async () => ({ status: 'unavailable', evidence: [], message: 'No evaluator is installed in this host' })),
      preflight: async (operation, args, operationContext) => {
        authorizeOperation(
          operation.id,
          args && typeof args === 'object' && !Array.isArray(args) && typeof args['path'] === 'string'
            ? args['path']
            : undefined,
        );
        return (
          operationContext.grant.effects.includes('read') && operation.effects.every((effect) => effect === 'read')
        );
      },
      model: {
        id: model.id,
        generate: async (request, signal) => {
          // Compiler teaching remains provenance. Current position/read disclosure supplies model teaching.
          const response = await model.generate(
            { ...request, profile: { ...request.profile, instructions: [], voice: '' } },
            signal,
          );
          return 'deferred' in response ? response : constrainResponse(response, request.profile.id);
        },
      },
      context: async (profile, _task, grant, budget) => {
        const ctx = catalog.contexts[compiled.profiles[profile.id]!.contexts[0]!]!.value;
        const shape: ScopeKey['shape'] =
          ctx.coordinate.category === 'capability'
            ? 'execution'
            : ctx.coordinate.category === 'rule'
              ? 'governance'
              : ctx.coordinate.category === 'evidence'
                ? 'learning'
                : 'context';
        return context!.position(
          {
            seat: manifest.workspace,
            shape,
            phase,
            depth: Math.min(2, grant.limits.depth),
            budget: Math.min(64, ctx.records, grant.limits.steps),
          },
          budget,
        );
      },
    });
    let active: string | undefined;
    const persist = async (state: Session) => {
      await options.evidence?.(state, (await store.journal(state.id)).events, reader.authoredRevision);
      return state;
    };
    const step = async () => {
      requireRunner(active, 'IA-RUNNER-NOT-OPEN', 'Open or resume a run first');
      const before = await store.read(active);
      const pending = before.runs[before.rootId]!.pendingAction;
      const lastAttempt = Object.values(before.attempts).at(-1);
      phase =
        before.budget.modelCalls === 0
          ? 'orient'
          : pending && typeof pending === 'object' && !Array.isArray(pending) && pending['type'] === 'invoke'
            ? 'act'
            : lastAttempt?.kind === 'operation' && lastAttempt.status === 'observed'
              ? 'learn'
              : 'plan';
      try {
        return await persist(await engine.advance(active, principal, { maxActions: 1 }));
      } catch (error) {
        if (!(error instanceof SessionError) || error.code !== 'IA-ENGINE-LIMIT-EXCEEDED') throw error;
        // Engine refuses before an over-budget dispatch. Persist that refusal without resetting its accounting.
        const owner = await store.acquire(active);
        try {
          const latest = await store.read(active);
          await store.command(
            {
              id: randomUUID(),
              sessionId: active,
              actor: principal,
              expected: latest.sequence,
              mutation: {
                type: 'run.wait',
                runId: latest.rootId,
                wait: {
                  id: randomUUID(),
                  reason: 'runner-limit-refusal',
                  objectIds: [],
                  continuation: 'stop',
                  details: {
                    code: error.code,
                    message: error.message,
                    next: `ia position --seat ${compiled.profiles[compiled.entry.profile]!.mandate ?? manifest.workspace} --shape governance`,
                  },
                },
              },
            },
            owner,
          );
        } finally {
          await store.release(owner);
        }
        return persist(await store.read(active));
      }
    };
    return {
      manifest,
      compiled,
      capture,
      store,
      async start(task: Json, id: string = randomUUID()) {
        const state = await engine.start({
          commandId: `open-${id}`,
          sessionId: id,
          principal,
          profile: compiled.entry.profile,
          task,
        });
        active = id;
        return persist(state);
      },
      async resume(id: string) {
        const state = await store.read(id);
        requireRunner(
          state.principal === principal && state.manifestDigest === digest(manifest),
          'IA-RUNNER-RESUME-DENIED',
          'Resume requires the pinned principal, profile, capture and installed contracts',
        );
        requireRunner(await verify(), 'IA-RUNNER-SOURCE-CHANGED', 'Pinned input or implementation changed');
        active = id;
        return persist(state);
      },
      step,
      async run(maxSteps = 64) {
        requireRunner(
          Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 128,
          'IA-RUNNER-LIMIT',
          'Run requires 1..128 scheduler steps',
        );
        requireRunner(active, 'IA-RUNNER-NOT-OPEN', 'Open or resume a run first');
        let state = await store.read(active);
        for (let n = 0; n < maxSteps && !terminal(state.runs[state.rootId]!); n++) {
          const before = state.sequence;
          state = await step();
          if (state.sequence === before || state.runs[state.rootId]!.status === 'waiting') break;
        }
        return state;
      },
      async submit(attempt: string, response: ModelResponse, commandId: string = randomUUID()) {
        requireRunner(active, 'IA-RUNNER-NOT-OPEN', 'Open or resume a run first');
        return persist(
          await engine.submitModel(
            active,
            principal,
            attempt,
            constrainResponse(response, compiled.entry.profile),
            commandId,
          ),
        );
      },
      async request(operation: 'records' | 'search' | 'traverse' | 'read', params: Record<string, unknown>) {
        requireRunner(active, 'IA-RUNNER-NOT-OPEN', 'Open or resume a run first');
        const state = await store.read(active);
        requireRunner(await verify(), 'IA-RUNNER-SOURCE-CHANGED', 'Pinned input or implementation changed');
        requireRunner(
          state.limits.deadline > Date.now() && !terminal(state.runs[state.rootId]!),
          'IA-RUNNER-LIMIT',
          'Run is terminal or expired',
        );
        const grant = await authorize(principal, manifest, state);
        requireRunner(
          grant.principal === principal &&
            grant.workspace === manifest.workspace &&
            grant.expiresAt > Date.now() &&
            grant.effects.includes('read') &&
            grant.sources.includes(capture.revision) &&
            grant.profiles.includes(compiled.entry.profile),
          'IA-RUNNER-AUTHORITY',
          'Current host authority does not permit navigation',
        );
        const refusal = profileRefusal(profileMandates(manifest.profiles[compiled.entry.profile]!), 'read').refusal;
        if (refusal) throw new RunnerError(refusal.code, refusal.message, refusal.next);
        return context!.request(operation, params);
      },
      async close() {
        bound!.close();
        context!.close();
        reader.close();
        await store.close();
      },
    };
  } catch (error) {
    bound?.close();
    context?.close();
    reader.close();
    void store.close();
    if (error instanceof SessionError) throw error;
    throw error;
  }
}
