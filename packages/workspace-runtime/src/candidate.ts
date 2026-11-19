import { validateCandidate } from '@inventarch/runtime';
import type { CandidateScope } from '@inventarch/runtime';
import { digest, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import type { OperationAdapter, OperationDefinition } from '@inventarch/agent-system';
import { verifyCapture } from './corpus.js';
import type { Capture } from './corpus.js';

export function candidateInputSchema(): Json {
  const string = { type: 'string' },
    list = (items: Json): Json => ({ type: 'array', items, maxItems: 100 });
  const object = (properties: Record<string, Json>): Json => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return object({
    version: { type: 'integer', enum: [1] },
    sourceSet: string,
    base: object({ revision: string, composition: list(object({ sourceSet: string, revision: string })) }),
    target: object({ system: string, discriminator: string }),
    files: list(object({ path: string, text: string, digest: string })),
    evidence: list(object({ path: string, digest: string, line: { type: 'integer' }, endLine: { type: 'integer' } })),
  });
}

import { written } from './plain-format.js';

/** The plain handler id once `WRITE_PLAIN_NAMES` is `true`. */
export const PLAIN_CANDIDATE_VALIDATE_HANDLER = 'candidate-validate';
/** The handler this validation shipped under before handler ids stopped carrying their version; still dispatched, and written while `WRITE_PLAIN_NAMES` is `false`. */
export const LEGACY_CANDIDATE_VALIDATE_HANDLER = 'ia.candidate.validate.v1';
export const CANDIDATE_VALIDATE_HANDLER = written(PLAIN_CANDIDATE_VALIDATE_HANDLER, LEGACY_CANDIDATE_VALIDATE_HANDLER);
/** Validation is a read. Publication and source application need separate installed bindings. */
export function candidateValidation(
  capture: Capture,
  scope: CandidateScope,
  implementationDigest: string,
): {
  definition: OperationDefinition;
  adapter: OperationAdapter;
  /** The same adapter under the plain handler and the original one, for manifests pinned before the rename. */
  adapters: Readonly<Record<string, OperationAdapter>>;
} {
  const frozen = verifyCapture(capture),
    boundary = JSON.parse(JSON.stringify(scope)) as CandidateScope;
  if (
    boundary.revision !== frozen.revision ||
    boundary.sourceSet !== frozen.id ||
    !/^[a-f0-9]{64}$/.test(implementationDigest)
  )
    throw new SessionError('IA-CORPUS-DENIED', 'Candidate boundary or installed implementation digest is unavailable');
  const string = { type: 'string' },
    list = (items: Json): Json => ({ type: 'array', items, maxItems: 100 });
  const object = (properties: Record<string, Json>): Json => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const handler = written(PLAIN_CANDIDATE_VALIDATE_HANDLER, LEGACY_CANDIDATE_VALIDATE_HANDLER);
  const definition: OperationDefinition = {
    id: 'candidate.validate',
    handler,
    digest: digest({
      implementation: handler,
      implementationDigest,
      capture: frozen.revision,
      boundary,
    }),
    purpose: 'candidate-validation',
    effects: ['read'],
    recovery: 'repeatable',
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
    input: candidateInputSchema(),
    output: object({
      allowed: { type: 'boolean' },
      candidateDigest: string,
      artifactDigest: string,
      diagnostics: list(object({ code: string, path: string, line: { type: 'integer' } })),
      citations: list(string),
    }),
  };
  const adapter: OperationAdapter = {
    id: definition.handler,
    execute: async (input, context) => {
      if (!context.grant.sources.includes(frozen.revision))
        throw new SessionError('IA-CORPUS-DENIED', 'Candidate sources exceed the current grant');
      const result = validateCandidate(
        {
          root: '',
          sources: frozen.sources,
          folders: frozen.folders,
          floorOrigin: frozen.floorOrigin,
          fingerprint: frozen.revision,
        },
        input,
        boundary,
      );
      // Closed engine schemas have no union/nullability operator; undisclosed locations use empty/zero.
      return {
        effect: 'none',
        output: {
          ...result,
          diagnostics: result.diagnostics.map((d) => ({ code: d.code, path: d.path ?? '', line: d.line ?? 0 })),
        } as unknown as Json,
      };
    },
  };
  return {
    definition,
    adapter,
    adapters: Object.freeze({
      [PLAIN_CANDIDATE_VALIDATE_HANDLER]: { ...adapter, id: PLAIN_CANDIDATE_VALIDATE_HANDLER },
      [LEGACY_CANDIDATE_VALIDATE_HANDLER]: { ...adapter, id: LEGACY_CANDIDATE_VALIDATE_HANDLER },
    }),
  };
}
