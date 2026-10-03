import { evaluateSteward } from '../steward.js';
import { ExecutionError } from './types.js';
import { open } from '@inventarch/db';
import type { Result, Context, Handler, Success } from './types.js';
import { field, id, portablePath, text } from './shared.js';

/** Trusted implementation catalog, never decoded from operation input. */
export type ExecutionCatalog = Readonly<
  Record<string, { owner: string; handler: string; effects: 'read-only' | 'draft-only'; run: Handler }>
>;
export function executeOwned(context: Context, name: string, input: unknown, catalog: ExecutionCatalog): Success {
  id(name);
  const candidates = context.records.filter((r) => r.discriminator === 'operation' && r.name === name);
  if (candidates.length !== 1)
    throw new ExecutionError('IA-EXEC-OPERATION-UNAVAILABLE', `No unique admitted @operation ${name}`);
  const operation = candidates[0]!,
    binding = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (
    !binding ||
    operation.identity !== `authoring-system/binding/operation/${name}` ||
    operation.source.path !== `.ia/src/systems/${binding.owner}/operations/${name}.ia` ||
    text(field(operation, 'execution', 'handler')) !== binding.handler ||
    text(field(operation, 'execution', 'effects')) !== binding.effects ||
    text(field(operation, 'execution', 'input')) !== 'json' ||
    text(field(operation, 'execution', 'output')) !== 'operation-result'
  )
    throw new ExecutionError(
      'IA-EXEC-BINDING-MISMATCH',
      `Native binding differs from the fixed implementation catalog: ${name}`,
    );
  const owner = evaluateSteward(context.records, binding.owner, { kind: 'operator' });
  if (!owner.allowed || !owner.steward) throw new ExecutionError('IA-EXEC-BINDING-MISMATCH', owner.message);
  const baseRevision = context.db.revision,
    product = binding.run(context, input),
    seen = new Set<string>();
  for (const artifact of product.artifacts) {
    const path = portablePath(artifact.path),
      key = path.toLowerCase();
    if (seen.has(key)) throw new ExecutionError('IA-EXEC-OUTPUT-UNSAFE', `Artifact paths collide: ${path}`);
    seen.add(key);
  }
  if (binding.effects === 'read-only' && product.artifacts.length)
    throw new ExecutionError('IA-EXEC-BINDING-MISMATCH', 'Read-only handler returned draft effects');
  if (context.db.refresh().revision !== baseRevision)
    throw new ExecutionError('IA-EXEC-SOURCE-CHANGED', 'Native inputs changed during execution');
  const candidateRevision = product.preview?.revision ?? product.candidateRevision;
  return {
    ok: true,
    operation: operation.identity,
    owner: binding.owner,
    steward: owner.steward.identity,
    baseRevision,
    ...(candidateRevision === undefined ? {} : { candidateRevision }),
    effects: binding.effects,
    artifacts: product.artifacts,
    evidence: product.evidence,
  };
}

export function executeCatalog(root: string, name: string, input: unknown, catalog: ExecutionCatalog): Result {
  try {
    const db = open(root, { cache: false });
    try {
      const errors = db.report.findings.filter((f) => f.severity === 'error');
      if (errors.length)
        throw new ExecutionError('IA-EXEC-VALIDATION-FAILED', 'Base corpus has admission errors', errors);
      return executeOwned({ db, records: db.records() }, name, input, catalog);
    } finally {
      db.close();
    }
  } catch (error) {
    return refusal(error);
  }
}
export function refusal(error: unknown): Result {
  return error instanceof ExecutionError
    ? { ok: false, code: error.code, message: error.message, diagnostics: error.diagnostics }
    : {
        ok: false,
        code: 'IA-EXEC-VALIDATION-FAILED',
        message: error instanceof Error ? error.message : String(error),
        diagnostics: [],
      };
}
