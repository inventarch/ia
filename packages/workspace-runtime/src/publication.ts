import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspectPublication, preparePublication } from '@inventarch/runtime';
import type { CandidateEnvelope } from '@inventarch/runtime';
import { canonical, digest, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import { validateShape } from '@inventarch/agent-system';
import type { OperationAdapter, OperationContext, OperationDefinition } from '@inventarch/agent-system';
import { candidateInputSchema } from './candidate.js';

/** Explicit host installation only. The inspection catalog never gains a write implicitly. */
export function managedPublication(
  root: string,
  destination: string,
  implementationDigest: string,
  binding?: OperationDefinition,
): { definition: OperationDefinition; adapter: OperationAdapter } {
  if (!/^[a-f0-9]{64}$/.test(implementationDigest))
    throw new SessionError('IA-CORPUS-DENIED', 'Installed publication implementation is unavailable');
  const base = resolve(root),
    string = { type: 'string' },
    object = (properties: Record<string, Json>): Json => ({
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    });
  const definition: OperationDefinition = {
    id: 'draft.publish',
    handler: 'ia.draft.publish.v1',
    digest: digest({ implementation: 'ia.draft.publish.v1', implementationDigest, root: base, destination }),
    effects: ['local-write'],
    recovery: 'reconcile',
    timeoutMs: 15000,
    input: object({ candidate: candidateInputSchema(), destination: string }),
    output: object({
      candidateDigest: string,
      artifactDigest: string,
      destination: string,
      published: string,
      manifestDigest: string,
    }),
  };
  if (binding) {
    if (
      !binding.id ||
      !/^[a-f0-9]{64}$/.test(binding.digest) ||
      binding.handler !== definition.handler ||
      digest(binding.input) !== digest(definition.input) ||
      digest(binding.output) !== digest(definition.output) ||
      digest(binding.effects) !== digest(definition.effects) ||
      binding.recovery !== definition.recovery ||
      binding.timeoutMs !== definition.timeoutMs ||
      (binding.maxOutputBytes ?? 65536) !== 65536 ||
      binding.purpose !== undefined
    )
      throw new SessionError(
        'IA-CORPUS-DENIED',
        'Compiled publication binding is incompatible with the installed adapter',
      );
    definition.id = binding.id;
    definition.digest = binding.digest;
  }
  const content = (input: Json, context: OperationContext) => {
    const value = input as unknown as { candidate: CandidateEnvelope; destination: string },
      review = context.review;
    if (
      !validateShape(definition.input, input) ||
      value.destination !== destination ||
      !context.owner ||
      context.owner.sessionId !== context.sessionId ||
      !context.assertCurrent ||
      context.manifest.operations[definition.id]?.digest !== definition.digest ||
      !review ||
      review.reviewer !== context.principal ||
      review.operation !== definition.id ||
      review.bindingDigest !== definition.digest ||
      review.inputDigest !== digest(input) ||
      review.candidateDigest !== digest(value.candidate) ||
      review.artifactDigest !== digest(value.candidate.files) ||
      review.destination !== destination ||
      review.effect !== 'local-write' ||
      !context.grant.destinations?.includes(destination) ||
      !context.grant.sources.includes(value.candidate.base.revision)
    )
      throw new SessionError(
        'IA-CORPUS-DENIED',
        'Publication is outside the exact reviewed binding, source or destination',
      );
    for (const file of value.candidate.files)
      if (createHash('sha256').update(file.text).digest('hex') !== file.digest)
        throw new SessionError('IA-CORPUS-DENIED', 'Reviewed candidate bytes changed');
    const manifest = {
      version: 1,
      kind: 'ia.managed-draft.v1',
      sessionId: context.sessionId,
      runId: context.runId,
      invocationId: context.invocationId,
      attemptId: context.attemptId,
      principal: context.principal,
      operation: definition.id,
      bindingDigest: definition.digest,
      inputDigest: review.inputDigest,
      candidateDigest: review.candidateDigest,
      artifactDigest: review.artifactDigest,
      destination,
      review,
      files: value.candidate.files.map((file) => ({
        path: file.path,
        digest: file.digest,
        bytes: Buffer.byteLength(file.text),
      })),
    };
    return {
      files: value.candidate.files,
      metadata: canonical(manifest) + '\n',
      output: {
        candidateDigest: review.candidateDigest,
        artifactDigest: review.artifactDigest,
        destination,
        published: destination,
        manifestDigest: digest(manifest),
      },
    };
  };
  const current = async (context: OperationContext): Promise<void> => {
    context.signal.throwIfAborted();
    if (!context.assertCurrent)
      throw new SessionError('IA-CORPUS-DENIED', 'Publication ownership check is unavailable');
    await context.assertCurrent();
    context.signal.throwIfAborted();
  };
  return {
    definition,
    adapter: {
      id: definition.handler,
      execute: async (input, context) => {
        await current(context);
        const value = content(input, context),
          prepared = preparePublication(base, destination, value.files, value.metadata);
        try {
          await current(context);
          content(input, context);
          prepared.publish();
          return { effect: 'applied', output: value.output };
        } finally {
          prepared.close();
        }
      },
      reconcile: async (input, context) => {
        await current(context);
        const value = content(input, context);
        const status = await inspectPublication(base, destination, value.files, value.metadata, async () => {
          await current(context);
          content(input, context);
        });
        return { status, output: status === 'applied' ? value.output : null };
      },
    },
  };
}
